const express = require("express");
const axios   = require("axios");
const {
  BEEPER_URL,
  BEEPER_TOKEN,
  beeperHeaders,
  beeperMcpHeaders,
  isWhatsApp,
  isTelegram,
  isLinkedIn,
  netLabel,
  networkFromAccountID,
  fuzzyMatch,
  formatMessages,
  parseMcpSse,
  beeperGetMessages,
} = require("../lib/beeper");
const {
  NOTION_TOKEN,
  NOTION_COMPANIES_DB,
  NOTION_PEOPLE_DB,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

// ── GET /beeper/health ────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/info`, { headers: beeperHeaders(), timeout: 5000 });
    res.json({ ok: true, beeper: r.data?.app, mcp: r.data?.server?.mcp_enabled, url: BEEPER_URL });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ── GET /beeper/chats ─────────────────────────────────────────────────────────
router.get("/chats", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { network = "all", type = "all", limit = 500 } = req.query;
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=${limit}`, { headers: beeperHeaders(), timeout: 15000 });
    let items = r.data?.items || [];

    if (network === "wa")      items = items.filter(c => isWhatsApp(c.accountID));
    else if (network === "tg") items = items.filter(c => isTelegram(c.accountID));
    else if (network === "li") items = items.filter(c => isLinkedIn(c.accountID));

    if (type === "group")       items = items.filter(c => c.type === "group");
    else if (type === "single") items = items.filter(c => c.type === "single");

    res.json({
      total: items.length,
      chats: items.map(c => ({
        id: c.id,
        name: c.title || c.name || "",
        type: c.type,
        network: netLabel(c.accountID),
        accountID: c.accountID,
        lastMessageAt: c.lastMessageAt || c.lastActivityAt || null,
      }))
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── GET /beeper/recent ────────────────────────────────────────────────────────
router.get("/recent", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { limit = 10, network = "all" } = req.query;
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    let items = r.data?.items || [];

    if (network === "wa")      items = items.filter(c => isWhatsApp(c.accountID));
    else if (network === "tg") items = items.filter(c => isTelegram(c.accountID));
    else if (network === "li") items = items.filter(c => isLinkedIn(c.accountID));

    items = items
      .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0))
      .slice(0, parseInt(limit));

    const result = await Promise.all(items.map(async c => {
      let lastMsg = "";
      try {
        const msgs = await beeperGetMessages(c.id, 1);
        const m = msgs[0];
        if (m) {
          const sender = m.sender?.fullName || m.sender?.displayName || m.senderName || "?";
          const text   = m.content?.text || m.content?.body || m.text || m.body || "";
          const time   = m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : "";
          lastMsg = `[${time}] ${sender}: ${text}`;
        }
      } catch (_) {}
      return {
        id: c.id,
        name: c.title || c.name || "",
        type: c.type,
        network: netLabel(c.accountID),
        lastMessage: lastMsg,
      };
    }));

    res.json({ total: result.length, chats: result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: fetch digest of recent chats with last-message metadata.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchDigest({ days = 7, limit = 200 } = {}) {
  const since = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
  const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=${limit}`, { headers: beeperHeaders(), timeout: 15000 });
  const items = r.data?.items || [];

  const filtered = items.filter(c => {
    const ts = c.lastMessageAt || c.lastActivityAt || c.updatedAt;
    return ts ? new Date(ts) > since : true;
  });

  const chats = await Promise.all(filtered.map(async c => {
    let lastMsgText = "", lastMsgSender = "", lastMsgTime = null, isSender = false;
    let fetchError = null;
    try {
      const msgs = await beeperGetMessages(c.id, 3);
      const m = msgs[0];
      if (m) {
        const sender = m.sender?.fullName || m.sender?.displayName || m.senderName || "?";
        const text   = m.content?.text || m.content?.body || m.text || m.body || "";
        lastMsgText   = text.slice(0, 300);
        lastMsgSender = sender;
        lastMsgTime   = m.timestamp || null;
        isSender      = !!(m.isSender);
      }
    } catch (err) {
      fetchError = err.message;
    }

    return {
      id:           c.id,
      name:         c.title || c.name || "",
      type:         c.type,
      network:      netLabel(c.accountID),
      networkFull:  networkFromAccountID(c.accountID),
      accountID:    c.accountID,
      lastMsgText,
      lastMsgSender,
      lastMsgTime,
      isSender,
      lastActivity: c.lastMessageAt || c.lastActivityAt || null,
      fetchError,
    };
  }));

  return { since: since.toISOString(), chats };
}

// ── GET /beeper/digest ────────────────────────────────────────────────────────
router.get("/digest", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { days = 7, limit = 200 } = req.query;
  try {
    const { since, chats } = await fetchDigest({ days, limit });
    res.json({
      ok: true,
      days: parseInt(days),
      since,
      total: chats.length,
      chats,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /beeper/replies-waiting helpers
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_PARTICIPANT_LIMIT = 20;

function parseParticipantCountFromText(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  const withMatch = rawText.match(/with\s+([^.]+)\.?/i);
  if (!withMatch) return null;
  const listPart = withMatch[1].trim();

  const othersMatch = listPart.match(/&\s+(\d+)\s+others?/i);
  if (othersMatch) {
    const namedBeforeOthers = listPart
      .split(/&\s+\d+\s+others?/i)[0]
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    return namedBeforeOthers.length + parseInt(othersMatch[1], 10);
  }

  const names = listPart.split(",").map(s => s.trim()).filter(Boolean);
  return names.length || null;
}

async function getParticipantCount(chatID) {
  try {
    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_chat",
        arguments: { chatID, maxParticipantCount: GROUP_PARTICIPANT_LIMIT + 5 }
      }
    };
    const r = await axios.post(
      `${BEEPER_URL}/v0/mcp`,
      rpcBody,
      { headers: beeperMcpHeaders(), timeout: 8000, responseType: "text" }
    );
    const result = parseMcpSse(r.data);
    if (!result) return null;
    const content = result.content || result;
    const textBlock = Array.isArray(content) ? content.find(c => c.type === "text") : null;
    const rawText = textBlock?.text || (typeof content === "string" ? content : null);
    if (!rawText) return null;

    const fromText = parseParticipantCountFromText(rawText);
    if (fromText != null) return fromText;

    try {
      const parsed = JSON.parse(rawText);
      const participants = parsed.participants || parsed.members || [];
      return Array.isArray(participants) ? participants.length : null;
    } catch {
      return null;
    }
  } catch (err) {
    return null;
  }
}

const GENERIC_SEED_WORDS = new Set([
  "world", "global", "international", "africa", "latam", "asia", "europe",
  "the", "a", "an",
  "blockchain", "crypto", "fintech", "tech", "ai",
  "venture", "ventures", "capital", "startup", "startups",
  "community", "group", "forum", "initiatives", "network",
  "news", "feed", "channel",
  "intl", "i18n",
  "rocket", "school",
  "beeper", "telegram",
]);

async function lookupCompanyByName(name) {
  if (!NOTION_TOKEN || !name) return null;
  try {
    const cleanedName = String(name)
      .replace(/^Plexo\s*[<>x×|]+\s*/i, "")
      .replace(/^.*\|\s*/, "")
      .trim();
    const candidate = cleanedName.split(/\s+/)[0];
    if (!candidate || candidate.length < 4) return null;
    if (GENERIC_SEED_WORDS.has(candidate.toLowerCase())) return null;

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      {
        filter: { property: "Company name", title: { contains: candidate } },
        page_size: 3,
      },
      { headers: notionHeaders(), timeout: 8000 }
    );
    const page = r.data.results?.[0];
    if (!page) return null;
    return {
      pageId: page.id,
      url:    page.url,
      name:   page.properties["Company name"]?.title?.[0]?.text?.content || candidate,
      stage:  page.properties["Stage"]?.status?.name || null,
      priority: page.properties["Priority"]?.select?.name || null,
      bdScore: page.properties["BD Score"]?.number ?? null,
    };
  } catch (err) {
    return null;
  }
}

async function lookupPersonByName(name) {
  if (!NOTION_TOKEN || !name) return null;
  if (/anton|pavel|paul|polkanov|titov|@pavel-remide:beeper\.com/i.test(name)) return null;
  try {
    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      {
        filter: { property: "Name", title: { contains: name.split(/\s+/)[0] } },
        page_size: 3,
      },
      { headers: notionHeaders(), timeout: 8000 }
    );
    const page = r.data.results?.[0];
    if (!page) return null;
    const props = page.properties || {};
    return {
      pageId:   page.id,
      url:      page.url,
      name:     (props["Name"]?.title || []).map(t => t.plain_text || t.text?.content || "").join(""),
      title:    (props["Role"]?.rich_text || []).map(t => t.plain_text || t.text?.content || "").join("") || null,
      email:    props["Email"]?.email || null,
      linkedin: props["LinkedIn"]?.url || null,
    };
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal-sender detection.
//
// EXPANDED in v3.17: previously this only matched obvious sender names like
// "Anton" or "Pavel". But Beeper's LinkedIn bridge sometimes labels Anton's
// outbound messages with sender like "beeper.com" or "@anton-titov:beeper.com",
// which slipped through. Patrick Chu in /replies showed Anton's reply
// "Hi Patrick, Thanks! Will book within today" labelled as inbound — that's
// exactly this bug.
//
// Fix is two-pronged:
//   1) Match more sender patterns (anything starting "@anton" / "anton" /
//      "anton-titov" / "beeper.com" / matrix-style mxid for Anton)
//   2) Heuristic-fallback by message TEXT — if the message starts with a
//      common outbound greeting addressed to someone whose name is in the
//      chat name, it's almost certainly Anton sending. This catches the
//      Beeper-bridge metadata bug without needing to fix Beeper itself.
// ─────────────────────────────────────────────────────────────────────────────

const INTERNAL_SENDER_REGEX = /(anton ceo|antón|^антон$|^pavel|polkanov|@pavel-remide:beeper\.com|titov|^anton$|@anton|anton[-\s]*titov|^beeper\.com$|beeper\.com:|^paul$)/i;

function isInternalSender(senderName) {
  if (!senderName) return false;
  return INTERNAL_SENDER_REGEX.test(senderName);
}

// Given a chat name like "Patrick Chu" or "Patrick Chu | Agora", extract
// the first-name token to use for outbound-text heuristic. Bails out for
// generic / system chat names.
function chatFirstName(chatName) {
  if (!chatName) return null;
  // Take part before "|" or "—" if present
  const beforeSep = chatName.split(/\s*[|—–-]\s*/)[0].trim();
  // First token, alphabetic only
  const first = beforeSep.split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  if (GENERIC_SEED_WORDS.has(first.toLowerCase())) return null;
  if (/^(plexo|remide|chat|group)$/i.test(first)) return null;
  return first;
}

// Heuristic: does the message text look like Anton sending an outbound message,
// even if sender metadata didn't flag it as such?
//
// Returns true when:
//   - text starts with "Hi <First>", "Hey <First>", "Hello <First>", followed
//     by content typical of Anton's voice (Thanks/will/feel free/let me/etc),
//     where <First> is the first name of the chat counterpart.
//   - text contains a phrase strongly associated with Anton's outreach
//     (Calendly link, "feel free to grab a free slot", etc.)
function looksOutboundByText(text, chatName) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;

  // Phrase-based: links to Anton's Calendly, recognizable outbound CTAs
  if (/calendly\.com\/plex0/i.test(t)) return true;
  if (/feel free to (grab|pick) a (free )?slot/i.test(t)) return true;
  if (/will book within today/i.test(t)) return true;

  // Greeting-based: "Hi <First>" or "Hey <First>" or "Hello <First>" addressed
  // to the chat counterpart's first name.
  const counterpart = chatFirstName(chatName);
  if (counterpart) {
    const greetingRe = new RegExp(
      `^(hi|hey|hello|good\\s+(morning|afternoon|evening))\\s*[,!]?\\s*${counterpart}\\b`,
      "i"
    );
    if (greetingRe.test(t)) return true;
  }

  return false;
}

// Internal/team chat rooms — drop these from "ждут ответа" entirely.
// Expanded in v3.17 to cover community/spam channel NAMES too (not just senders).
function isInternalChatName(chatName) {
  if (!chatName) return false;
  // Internal Plexo/RemiDe rooms
  if (/(remide\s*\|.*advisor|plexo\s*\|.*advisor|beeper developer|remide team|plexo team)/i.test(chatName)) {
    return true;
  }
  // Community & spam channels (chat NAME pattern, not sender)
  if (/(rocket tech school|frontforumfocus|world impact|africa stablecoin community|deals global investment|blockchain.*tech news|latam venture talks|дедушка)/i.test(chatName)) {
    return true;
  }
  return false;
}

function isBroadcastSpam(chatName, senderName) {
  if (!senderName) return false;
  if (chatName && senderName.toLowerCase().trim() === chatName.toLowerCase().trim()) {
    return true;
  }
  if (/^(rocket tech school|frontforumfocus)$/i.test(senderName)) return true;
  return false;
}

router.get("/replies-waiting", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });

  const hoursIdle = Math.max(0.5, Math.min(168, parseFloat(req.query.hoursIdle) || 4));
  const limit     = Math.max(1,   Math.min(50,  parseInt(req.query.limit, 10) || 15));
  const days      = Math.max(1,   Math.min(30,  parseInt(req.query.days,  10) || 7));
  const debug     = req.query.debug === "1" || req.query.debug === "true";

  const minIdleMs  = hoursIdle * 60 * 60 * 1000;
  const maxLastMs  = Date.now() - minIdleMs;

  try {
    const { since, chats } = await fetchDigest({ days, limit: 200 });

    const decisions = chats.map(c => {
      const reasons = [];
      const sentByInternal = isInternalSender(c.lastMsgSender);
      const internalChat   = isInternalChatName(c.name);
      const broadcast      = isBroadcastSpam(c.name, c.lastMsgSender);
      // NEW: text-based outbound detection — catches Beeper-bridge metadata
      // bugs where sender label doesn't reflect that Anton actually sent.
      const outboundByText = looksOutboundByText(c.lastMsgText, c.name);

      if (c.fetchError)                            reasons.push("msg-fetch-failed");
      if (c.isSender)                              reasons.push("isSender-flag-true");
      if (sentByInternal)                          reasons.push("internal-sender-name");
      if (outboundByText)                          reasons.push("outbound-by-text");
      if (internalChat)                            reasons.push("internal-chat-room");
      if (broadcast)                               reasons.push("broadcast-spam");
      if (!c.lastMsgText || !c.lastMsgText.trim()) reasons.push("empty-text");
      if (!c.lastMsgTime)                          reasons.push("no-timestamp");
      if (c.lastMsgTime) {
        const tsMs = new Date(c.lastMsgTime).getTime();
        if (isNaN(tsMs))               reasons.push("bad-timestamp");
        else if (tsMs > maxLastMs)     reasons.push("too-recent");
      }

      return { chat: c, included: reasons.length === 0, reasons };
    });

    const survivors = decisions.filter(d => d.included);
    const groupSurvivors = survivors.filter(d => d.chat.type === "group");

    const groupSizes = await Promise.all(groupSurvivors.map(async d => ({
      chatId: d.chat.id,
      count:  await getParticipantCount(d.chat.id),
    })));
    const sizeByChat = new Map(groupSizes.map(g => [g.chatId, g.count]));

    for (const d of survivors) {
      if (d.chat.type !== "group") continue;
      const count = sizeByChat.get(d.chat.id);
      if (count != null && count > GROUP_PARTICIPANT_LIMIT) {
        d.included = false;
        d.reasons.push("large-group-chat");
        d.chat.participantCount = count;
      } else if (count != null) {
        d.chat.participantCount = count;
      }
    }

    const filtered = decisions
      .filter(d => d.included)
      .map(d => d.chat);

    filtered.sort((a, b) => new Date(a.lastMsgTime) - new Date(b.lastMsgTime));

    const top = filtered.slice(0, limit);

    const withCrm = await Promise.all(top.map(async c => {
      const [company, person] = await Promise.all([
        lookupCompanyByName(c.name),
        lookupPersonByName(c.lastMsgSender),
      ]);

      const idleMs = Date.now() - new Date(c.lastMsgTime).getTime();
      const hoursIdleVal = Math.round(idleMs / (60 * 60 * 1000) * 10) / 10;

      const visualTier = (company || c.type === "single") ? "primary" : "secondary";

      return {
        ...c,
        hoursIdle: hoursIdleVal,
        notion: company,
        person,
        visualTier,
      };
    }));

    const response = {
      ok: true,
      hoursIdle,
      since,
      total: withCrm.length,
      replies: withCrm,
    };

    if (debug) {
      response.debug = {
        totalChatsScanned: chats.length,
        groupSizesChecked: groupSizes.length,
        groupSizes: groupSizes.map(g => ({ chatId: g.chatId, count: g.count })),
        decisionsByReason: decisions
          .filter(d => !d.included)
          .reduce((acc, d) => {
            for (const r of d.reasons) acc[r] = (acc[r] || 0) + 1;
            return acc;
          }, {}),
        excludedSamples: decisions
          .filter(d => !d.included)
          .slice(0, 20)
          .map(d => ({
            name: d.chat.name,
            sender: d.chat.lastMsgSender,
            timeISO: d.chat.lastMsgTime,
            isSenderFlag: d.chat.isSender,
            participantCount: d.chat.participantCount ?? null,
            text: (d.chat.lastMsgText || "").slice(0, 80),
            reasons: d.reasons,
          })),
      };
    }

    res.json(response);
  } catch (err) {
    console.error("[beeper/replies-waiting] error:", err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── GET /beeper/messages ──────────────────────────────────────────────────────
router.get("/messages", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { chatId, limit = 9999 } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  try {
    const items = await beeperGetMessages(chatId, parseInt(limit));
    const messages = items.map(m => ({
      id: m.id,
      sender: m.sender?.fullName || m.sender?.displayName || m.sender?.id || m.senderName || "?",
      text:   m.content?.text || m.content?.body || m.text || m.body || "",
      time:   m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : (m.time || "?"),
    })).filter(m => m.text);
    res.json({ chatId, total: messages.length, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /beeper/find-chat ────────────────────────────────────────────────────
router.post("/find-chat", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const items = r.data?.items || [];
    const matches = items.filter(c => fuzzyMatch(c.title || c.name || "", name));
    res.json({
      query: name,
      found: matches.length,
      chats: matches.map(c => ({
        id: c.id,
        name: c.title || c.name || "",
        type: c.type,
        network: netLabel(c.accountID),
        accountID: c.accountID,
      }))
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/get-conversation ─────────────────────────────────────────────
router.post("/get-conversation", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { name, limit = 9999 } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const items = r.data?.items || [];
    const matches = items.filter(c => fuzzyMatch(c.title || c.name || "", name));
    if (matches.length === 0) return res.json({ ok: false, error: `No chats found matching "${name}"` });

    const results = await Promise.all(matches.map(async c => {
      const msgs = await beeperGetMessages(c.id, limit);
      return {
        chatName: c.title || c.name || "",
        network: netLabel(c.accountID),
        networkFull: networkFromAccountID(c.accountID),
        type: c.type,
        messageCount: msgs.length,
        messages: msgs,
      };
    }));

    res.json({ ok: true, query: name, chats: results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/send ─────────────────────────────────────────────────────────
router.post("/send", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { chatId, text } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: "chatId and text required" });
  try {
    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: "send_message", arguments: { chatID: chatId, text } }
    };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" });
    res.json({ ok: true, result: r.data?.result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/search ───────────────────────────────────────────────────────
router.post("/search", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  try {
    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: "search_messages", arguments: { query, limit: 50 } }
    };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
    res.json({ ok: true, result: r.data?.result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/warm-cache ───────────────────────────────────────────────────
router.post("/warm-cache", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { depth = 200 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const chats = chatsRes.data?.items || [];
    console.log(`[warm-cache] Warming ${chats.length} chats, depth=${depth}`);
    let warmed = 0, failed = 0;
    for (const c of chats) {
      try {
        await beeperGetMessages(c.id, depth);
        warmed++;
      } catch (_) { failed++; }
    }
    res.json({ ok: true, total: chats.length, warmed, failed });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/sync-chats → Notion Companies ────────────────────────────────
router.post("/sync-chats", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { msgLimit = 10 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const allChats = chatsRes.data?.items || [];
    const relevant = allChats.filter(c => isWhatsApp(c.accountID) || isTelegram(c.accountID));
    console.log(`[sync-chats] ${relevant.length} WA+TG chats out of ${allChats.length} total`);

    const notionRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { page_size: 200 }, { headers: notionHeaders() }
    );
    const companies = notionRes.data.results.map(p => ({
      id: p.id,
      name: p.properties["Company name"]?.title?.[0]?.text?.content || "",
    })).filter(c => c.name);

    const seen = new Set();
    const results = [];

    for (const chat of relevant) {
      const chatName = chat.title || chat.name || "";
      const label    = netLabel(chat.accountID);
      const match    = companies.find(c => fuzzyMatch(chatName, c.name));
      if (!match) { results.push({ chat: chatName, network: label, status: "no_match" }); continue; }
      if (seen.has(match.id)) { results.push({ chat: chatName, network: label, company: match.name, status: "duplicate" }); continue; }
      seen.add(match.id);

      let msgText = "";
      try {
        const msgs = await beeperGetMessages(chat.id, msgLimit);
        msgText = formatMessages(msgs, msgLimit);
      } catch (e) { console.error(`[sync-chats] msg fetch failed for ${chatName}:`, e.message); }

      const note = `📱 ${label} ${chat.type === "group" ? "Group" : "DM"}: ${chatName}\n🕐 Synced: ${new Date().toLocaleDateString("ru-RU")}\n\n${msgText || "(no messages)"}`;
      try {
        await axios.patch(
          `https://api.notion.com/v1/pages/${match.id}`,
          { properties: { "Notes": { rich_text: [{ text: { content: note.slice(0, 2000) } }] } } },
          { headers: notionHeaders() }
        );
        results.push({ chat: chatName, network: label, company: match.name, status: "synced" });
        console.log(`[sync-chats] ✅ [${label}] "${chatName}" → ${match.name}`);
      } catch (e) {
        results.push({ chat: chatName, network: label, company: match.name, status: "notion_error", error: e.message });
      }
    }

    res.json({
      ok: true,
      synced:    results.filter(r => r.status === "synced").length,
      noMatch:   results.filter(r => r.status === "no_match").length,
      duplicate: results.filter(r => r.status === "duplicate").length,
      total:     relevant.length,
      results,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/sync-linkedin → Notion People ────────────────────────────────
router.post("/sync-linkedin", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { msgLimit = 10 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const liChats = (chatsRes.data?.items || []).filter(c => isLinkedIn(c.accountID));
    console.log(`[sync-linkedin] ${liChats.length} LinkedIn chats`);

    const notionRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      { page_size: 200 }, { headers: notionHeaders() }
    );
    const people = notionRes.data.results.map(p => ({
      id: p.id,
      name: p.properties["Name"]?.title?.[0]?.text?.content || "",
    })).filter(p => p.name);

    const results = [];
    for (const chat of liChats) {
      const chatName = chat.title || chat.name || "";
      const match = people.find(p => fuzzyMatch(chatName, p.name));
      if (!match) { results.push({ chat: chatName, status: "no_match" }); continue; }
      let msgText = "";
      try {
        const msgs = await beeperGetMessages(chat.id, msgLimit);
        msgText = formatMessages(msgs, msgLimit);
      } catch (e) {}
      const note = `💼 LinkedIn DM: ${chatName}\n🕐 Synced: ${new Date().toLocaleDateString("ru-RU")}\n\n${msgText || "(no messages)"}`;
      try {
        await axios.patch(
          `https://api.notion.com/v1/pages/${match.id}`,
          { properties: { "Notes": { rich_text: [{ text: { content: note.slice(0, 2000) } }] } } },
          { headers: notionHeaders() }
        );
        results.push({ chat: chatName, person: match.name, status: "synced" });
        console.log(`[sync-linkedin] ✅ "${chatName}" → ${match.name}`);
      } catch (e) {
        results.push({ chat: chatName, person: match.name, status: "notion_error", error: e.message });
      }
    }
    res.json({ ok: true, synced: results.filter(r => r.status === "synced").length, noMatch: results.filter(r => r.status === "no_match").length, total: liChats.length, results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/mcp-call ─────────────────────────────────────────────────────
router.post("/mcp-call", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { tool, params = {} } = req.body;
  if (!tool) return res.status(400).json({ error: "tool required" });
  try {
    const rpcBody = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: params } };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 30000, responseType: "text" });
    const result = parseMcpSse(r.data);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── GET /beeper/mcp-tools ─────────────────────────────────────────────────────
router.get("/mcp-tools", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  try {
    const rpcBody = { jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" });
    const result = parseMcpSse(r.data);
    res.json({ ok: true, tools: result?.tools || result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── GET /beeper/inbox ─────────────────────────────────────────────────────────
router.get("/inbox", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { network = "all", limit = 10 } = req.query;
  try {
    const accountIDs = network === "tg" ? ["telegram"]
      : network === "wa" ? null
      : network === "li" ? ["linkedin"]
      : undefined;

    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: {
        name: "search_chats",
        arguments: {
          ...(accountIDs ? { accountIDs } : {}),
          limit: parseInt(limit),
          inbox: "primary",
        }
      }
    };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
    const result = parseMcpSse(r.data);
    const text = result?.content?.[0]?.text || "";

    const chatMatches = [...text.matchAll(/chatID: ([^\s\)]+)/g)];
    const chatIDs = chatMatches.map(m => m[1]);

    const chats = await Promise.all(chatIDs.map(async chatID => {
      const chatName = text.match(new RegExp(`## ([^\\n]+) \\(chatID: ${chatID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))?.[1] || chatID;
      let lastMsg = "";
      try {
        const msgRpc = {
          jsonrpc: "2.0", id: Date.now(),
          method: "tools/call",
          params: { name: "list_messages", arguments: { chatID } }
        };
        const mr = await axios.post(`${BEEPER_URL}/v0/mcp`, msgRpc, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
        const msgResult = parseMcpSse(mr.data);
        const msgText = msgResult?.content?.[0]?.text || "";
        try {
          const parsed = JSON.parse(msgText);
          const first = parsed.items?.[0];
          if (first) {
            const t = new Date(first.timestamp).toLocaleString("ru-RU");
            const dir = first.isSender ? "→" : "←";
            lastMsg = `[${t}] ${dir} ${first.senderName}: ${first.text || "[медиа]"}`;
          }
        } catch (_) {
          lastMsg = msgText.slice(0, 100);
        }
      } catch (_) {}
      return { chatID, chatName, lastMsg };
    }));

    res.json({ ok: true, network, count: chats.length, chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /beeper/chat?name=X ───────────────────────────────────────────────────
router.get("/chat", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { name, limit = 50 } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const searchRpc = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: "search", arguments: { query: name } }
    };
    const sr = await axios.post(`${BEEPER_URL}/v0/mcp`, searchRpc, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
    const searchResult = parseMcpSse(sr.data);
    const searchText = searchResult?.content?.[0]?.text || "";

    const chatMatches = [...searchText.matchAll(/chatID: ([^\s\)]+)/g)];
    if (chatMatches.length === 0) return res.json({ ok: false, error: `Чат "${name}" не найден` });

    const results = await Promise.all(chatMatches.slice(0, 3).map(async m => {
      const chatID = m[1];
      const chatName = searchText.match(new RegExp(`## ([^\\n]+) \\(chatID: ${chatID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))?.[1] || chatID;

      const msgRpc = {
        jsonrpc: "2.0", id: Date.now(),
        method: "tools/call",
        params: { name: "list_messages", arguments: { chatID } }
      };
      const mr = await axios.post(`${BEEPER_URL}/v0/mcp`, msgRpc, { headers: beeperMcpHeaders(), timeout: 30000, responseType: "text" });
      const msgResult = parseMcpSse(mr.data);
      const msgText = msgResult?.content?.[0]?.text || "";

      let messages = [];
      try {
        const parsed = JSON.parse(msgText);
        messages = (parsed.items || []).slice(0, parseInt(limit)).map(m => ({
          time:     new Date(m.timestamp).toLocaleString("ru-RU"),
          sender:   m.senderName,
          text:     m.text || "[медиа]",
          isSender: m.isSender,
          isUnread: m.isUnread,
        }));
      } catch (_) {}

      return { chatID, chatName, messageCount: messages.length, messages };
    }));

    res.json({ ok: true, query: name, chats: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
