const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  notionHeaders,
} = require("../lib/notion");
const {
  BEEPER_URL,
  BEEPER_TOKEN,
  beeperHeaders,
  networkFromAccountID,
  beeperGetMessages,
} = require("../lib/beeper");

const router = express.Router();

const MESSAGES_HUB_DB = "8617a441c4254b41be671a1e65946a03";
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// Per-network identity and groupings (unchanged from /activity)
// ─────────────────────────────────────────────────────────────────────────────

const WA_ACCOUNT_PHONE = {
  "Htp4o51CAhE8_SXbpXCKofjvn1Y": "+420777225067",
  "ehMYU4KFPp6AAcwfsxn5Pt1jhV4": "+420774576161",
};

function groupKey(accountID, networkFull) {
  if (!accountID) return networkFull || "Unknown";
  if (networkFull === "WhatsApp") {
    for (const [token] of Object.entries(WA_ACCOUNT_PHONE)) {
      if (accountID.includes(token)) {
        return `WhatsApp:${WA_ACCOUNT_PHONE[token]}`;
      }
    }
  }
  return networkFull || "Unknown";
}

function groupKeyToHeader(key) {
  if (key.startsWith("WhatsApp:")) {
    const phone = key.split(":")[1];
    return `WhatsApp (${phone})`;
  }
  return key;
}

const SKIP_CHAT_NAME_REGEX = /(rocket tech school|frontforumfocus|world impact|africa stablecoin community|deals global investment|beeper developer|blockchain.*tech news|latam venture talks|дедушка)/i;
const INTERNAL_SENDER_REGEX = /(anton ceo|antón|^антон$|^pavel|polkanov|@pavel-remide:beeper\.com|titov|anton t)/i;

function isInternalSender(s) {
  if (!s) return false;
  return INTERNAL_SENDER_REGEX.test(s);
}

// "Important inbound" filter — drop low-signal incoming messages.
//
// What counts as low-signal:
//   - empty/whitespace
//   - "Incoming call. Use the WhatsApp app to answer."  (Beeper system message)
//   - very short ack-only ("ok", "thanks", "👍", emoji-only)
//   - link-only messages without context
function isLowSignalInbound(text) {
  if (!text || !text.trim()) return true;
  const t = text.trim();
  if (/^incoming call\./i.test(t)) return true;
  if (t.length < 10 && /^[\s\p{Emoji}\p{P}ok thanks thx]+$/iu.test(t)) return true;
  // emoji-only or punctuation-only
  if (/^[\s\p{Emoji}\p{P}]+$/u.test(t)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yesterday window (Europe/Prague)
// ─────────────────────────────────────────────────────────────────────────────

function getYesterdayWindow() {
  const TZ = "Europe/Prague";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  const label = `${y}-${m}-${d}`;

  const probe = new Date(`${label}T12:00:00Z`);
  const fmtCheck = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", hour12: false,
  });
  const hourInPrague = parseInt(fmtCheck.format(probe), 10);
  const offsetHours = hourInPrague - 12;

  const startISO = new Date(`${label}T00:00:00Z`).getTime() - offsetHours * 3600_000;
  const endISO = startISO + 24 * 3600_000;

  return {
    startISO: new Date(startISO).toISOString(),
    endISO:   new Date(endISO).toISOString(),
    label,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch from Beeper
// ─────────────────────────────────────────────────────────────────────────────

async function fetchYesterdayFromBeeper({ startISO, endISO }) {
  if (!BEEPER_TOKEN) throw new Error("BEEPER_TOKEN not set");

  const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=200`, {
    headers: beeperHeaders(),
    timeout: 12_000,
  });
  const items = r.data?.items || [];

  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  const recentChats = items.filter(c => {
    const ts = c.lastMessageAt || c.lastActivityAt || c.updatedAt;
    if (!ts) return false;
    const tsMs = Date.parse(ts);
    return !isNaN(tsMs) && tsMs >= startMs && tsMs < endMs;
  });

  const enriched = await Promise.all(recentChats.map(async c => {
    let messagesYesterday = [];
    try {
      const msgs = await beeperGetMessages(c.id, 8);
      messagesYesterday = msgs.filter(m => {
        const tsMs = Date.parse(m.timestamp || 0);
        return !isNaN(tsMs) && tsMs >= startMs && tsMs < endMs;
      }).map(m => ({
        sender: m.sender?.fullName || m.sender?.displayName || m.senderName || "?",
        text: (m.content?.text || m.content?.body || m.text || m.body || "").slice(0, 400),
        timestamp: m.timestamp,
        isSender: !!m.isSender,
      })).filter(m => m.text);
    } catch (_) { /* swallow */ }

    return {
      id: c.id,
      name: c.title || c.name || "",
      type: c.type,
      accountID: c.accountID,
      networkFull: networkFromAccountID(c.accountID),
      messagesYesterday,
    };
  }));

  return enriched.filter(c =>
    c.messagesYesterday.length > 0 &&
    !SKIP_CHAT_NAME_REGEX.test(c.name)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch from Messaging Hub
// ─────────────────────────────────────────────────────────────────────────────

async function fetchYesterdayFromHub({ startISO, endISO }) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN not set");

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const r = await axios.post(
    `https://api.notion.com/v1/databases/${MESSAGES_HUB_DB}/query`,
    {
      filter: {
        and: [
          { property: "Status", status: { equals: "Active" } },
          {
            timestamp: "last_edited_time",
            last_edited_time: { on_or_after: sevenDaysAgo },
          },
        ],
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 100,
    },
    { headers: notionHeaders(), timeout: 10_000 }
  );

  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);

  const allRows = r.data.results.map(page => {
    const props = page.properties || {};
    const titleArr = props["Chat Name"]?.title || [];
    const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

    const lastMsgArr = props["Last Message"]?.rich_text || [];
    const lastMsgText = lastMsgArr.map(rt => rt.plain_text || rt.text?.content || "").join("").slice(0, 400);

    const networkArr = props["Network"]?.multi_select || [];
    const networkFull = networkArr[0]?.name || null;

    const rawSender = (props["Raw Sender Name"]?.rich_text || [])
      .map(rt => rt.plain_text || rt.text?.content || "").join("");

    const accountID = null;

    const lastActiveDate = props["Last Active"]?.date?.start || null;
    const lastEditedTime = page.last_edited_time;
    const effectiveTime = lastActiveDate || lastEditedTime;

    return {
      name, networkFull, accountID,
      lastMsgText,
      lastMsgSender: rawSender,
      lastMsgTime: effectiveTime,
      lastEditedTime,
      outbound: rawSender ? isInternalSender(rawSender) : false,
    };
  });

  const freshestEdit = allRows.length > 0
    ? allRows.reduce((max, row) => {
        const ts = Date.parse(row.lastEditedTime || 0);
        return !isNaN(ts) && ts > max ? ts : max;
      }, 0)
    : 0;

  const yesterdayRows = allRows.filter(row => {
    if (!row.lastMsgText || !row.lastMsgText.trim()) return false;
    if (SKIP_CHAT_NAME_REGEX.test(row.name)) return false;
    const tsMs = Date.parse(row.lastMsgTime);
    if (isNaN(tsMs)) return false;
    return tsMs >= startMs && tsMs < endMs;
  });

  let stalestFallbackRows = [];
  if (yesterdayRows.length === 0) {
    stalestFallbackRows = allRows
      .filter(row => row.lastMsgText && row.lastMsgText.trim() && !SKIP_CHAT_NAME_REGEX.test(row.name))
      .slice(0, 30);
  }

  return {
    yesterdayRows,
    stalestFallbackRows,
    freshestEditISO: freshestEdit > 0 ? new Date(freshestEdit).toISOString() : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group chats by network
// ─────────────────────────────────────────────────────────────────────────────

function groupChatsForRender(chats) {
  const groups = new Map();

  for (const chat of chats) {
    const key = groupKey(chat.accountID, chat.networkFull);
    if (!groups.has(key)) {
      groups.set(key, { key, header: groupKeyToHeader(key), chats: [] });
    }
    groups.get(key).chats.push(chat);
  }

  const orderRank = (key) => {
    if (key === "LinkedIn") return 0;
    if (key === "Telegram") return 1;
    if (key.startsWith("WhatsApp:+420777225067")) return 2;
    if (key.startsWith("WhatsApp:+420774576161")) return 3;
    if (key.startsWith("WhatsApp")) return 4;
    return 99;
  };

  return Array.from(groups.values()).sort((a, b) =>
    orderRank(a.key) - orderRank(b.key)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Build "important activity" payload for a single network group.
// Includes outbound + non-low-signal inbound. Prepares structured input
// for the AI summarizer.
// ─────────────────────────────────────────────────────────────────────────────

function buildNetworkPayload(group) {
  const items = [];
  for (const chat of group.chats) {
    const msgs = chat.messagesYesterday || [];
    if (msgs.length === 0) continue;

    // Keep outbound + non-low-signal inbound
    const filtered = msgs.filter(m => m.isSender || !isLowSignalInbound(m.text));
    if (filtered.length === 0) continue;

    items.push({
      chatName: chat.name,
      type: chat.type || "single",
      messages: filtered.map(m => ({
        sender: m.sender,
        text: m.text,
        direction: m.isSender ? "out" : "in",
      })),
    });
  }
  return items;
}

// Compute per-chat "top hits" for the under-summary list (1-2 lines per chat).
// Picks chats by importance heuristic: prefer chats where Anton sent (outbound
// signals BD activity), then chats with longer inbound text.
function pickTopChats(group, n = 3) {
  const scored = group.chats.map(chat => {
    const msgs = chat.messagesYesterday || [];
    const hasOutbound = msgs.some(m => m.isSender);
    const totalLength = msgs.reduce((sum, m) => sum + (m.text?.length || 0), 0);
    const score = (hasOutbound ? 1000 : 0) + totalLength;
    return { chat, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map(s => {
    const chat = s.chat;
    const lastMsg = chat.messagesYesterday[chat.messagesYesterday.length - 1];
    const direction = lastMsg?.isSender ? "→" : "←";
    const snippet = (lastMsg?.text || "").slice(0, 120);
    return {
      name: chat.name,
      direction,
      lastSender: lastMsg?.sender || "?",
      snippet,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AI summarization via Anthropic Haiku
// ─────────────────────────────────────────────────────────────────────────────

async function summarizeNetwork(networkHeader, items) {
  if (!ANTHROPIC_KEY) {
    return {
      bullets: ["⚠️ ANTHROPIC_API_KEY не задан — AI-summary недоступен"],
      error: "no-api-key",
    };
  }
  if (items.length === 0) {
    return { bullets: [], skipped: true };
  }

  // Build a compact textual input for the model
  const lines = [];
  for (const item of items) {
    lines.push(`### ${item.chatName}${item.type === "group" ? " (group)" : ""}`);
    for (const msg of item.messages) {
      const arrow = msg.direction === "out" ? "→ Anton" : `← ${msg.sender}`;
      lines.push(`${arrow}: ${msg.text}`);
    }
    lines.push("");
  }
  const conversationText = lines.join("\n");

  const systemPrompt = `Ты ассистент BD-команды Plexo (B2B stablecoin clearing network для финтехов).
Anton — CEO. Pavel — Head of Partnerships.
Твоя задача — кратко суммировать что важного произошло за вчерашний день в одном мессенджере.

Формат вывода — 3-5 буллетов, каждый по 1 строке (до 100 символов).
Каждый буллет должен ОТВЕЧАТЬ на вопрос "что важного?", а не пересказывать кто-кому-что-сказал.

Хорошие примеры буллетов:
• Maximilian Bruckner (Zodia Custody) запросил intro call — Standard Chartered + Northern Trust в инвесторах
• Anton отправил pitch Nick Woodruff (Coinbase) и Ankit Mehta (OpenFX) — ждём реакции
• Don-West Macauley забронировал встречу через Calendly

Плохие примеры (не делай так):
• Pavel ответил Maximilian "thanks for getting back"  ← мелкий тех. факт
• В чате Anupam Pahuja было сообщение  ← что важно?
• Обсуждали интеграцию  ← размыто

Если в input ничего по-настоящему важного нет — верни 1 буллет "Активности не было / только тех.переписка".

Отвечай строго JSON: { "bullets": ["bullet 1", "bullet 2", ...] }
Не добавляй объяснений вокруг JSON.`;

  const userPrompt = `Network: ${networkHeader}

Активность за вчера:

${conversationText}

Дай 3-5 буллетов про что важного.`;

  try {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 25_000,
      }
    );

    const textBlock = (r.data?.content || []).find(b => b.type === "text");
    const raw = textBlock?.text || "";
    // Strip optional markdown code fences
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean);
    const bullets = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5) : [];
    return { bullets };
  } catch (err) {
    console.error(`[yesterday/summary] AI failed for ${networkHeader}:`, err.message);
    return {
      bullets: ["⚠️ AI summary недоступен — см. список чатов ниже"],
      error: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /yesterday/summary
//
// Pulls yesterday's activity (Beeper → Hub fallback), groups by network,
// for each group calls Haiku for a 3-5 bullet summary, and returns the
// combined response with top-3 chats per network for context.
//
// Response shape:
//   {
//     ok: true,
//     source: "beeper" | "hub-fresh" | "hub-stale",
//     yesterdayLabel, dataDate, freshestEditISO,
//     networks: [
//       {
//         header: "LinkedIn",
//         summary: { bullets: ["...", "..."] },
//         topChats: [{ name, direction, snippet, lastSender }],
//         totalChats: 8,
//       }, ...
//     ],
//   }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/summary", async (req, res) => {
  const window = getYesterdayWindow();

  let chats = null;
  let source = null;
  let dataDate = window.label;
  let freshestEditISO = null;

  // Try Beeper first
  try {
    chats = await fetchYesterdayFromBeeper(window);
    source = "beeper";
  } catch (beeperErr) {
    console.warn(`[yesterday/summary] beeper failed: ${beeperErr.message} — falling back to hub`);
  }

  // Hub fallback
  if (!chats) {
    try {
      const hub = await fetchYesterdayFromHub(window);
      freshestEditISO = hub.freshestEditISO;

      if (hub.yesterdayRows.length > 0) {
        source = "hub-fresh";
        chats = hub.yesterdayRows.map(row => ({
          name: row.name,
          accountID: row.accountID,
          networkFull: row.networkFull,
          messagesYesterday: [{
            sender: row.lastMsgSender || "?",
            text: row.lastMsgText,
            timestamp: row.lastMsgTime,
            isSender: row.outbound,
          }],
        }));
      } else if (hub.stalestFallbackRows.length > 0) {
        source = "hub-stale";
        if (freshestEditISO) {
          const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Prague",
            year: "numeric", month: "2-digit", day: "2-digit",
          });
          const parts = fmt.formatToParts(new Date(freshestEditISO));
          dataDate = `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
        }
        chats = hub.stalestFallbackRows.map(row => ({
          name: row.name,
          accountID: row.accountID,
          networkFull: row.networkFull,
          messagesYesterday: [{
            sender: row.lastMsgSender || "?",
            text: row.lastMsgText,
            timestamp: row.lastMsgTime,
            isSender: row.outbound,
          }],
        }));
      } else {
        return res.json({
          ok: true,
          source: "hub-empty",
          yesterdayLabel: window.label,
          dataDate: null,
          freshestEditISO,
          networks: [],
        });
      }
    } catch (hubErr) {
      return res.status(500).json({
        error: "both beeper and hub failed",
        hubError: hubErr.message,
      });
    }
  }

  // Group by network
  const groups = groupChatsForRender(chats);

  // For each group: build payload, call Haiku, pick top chats
  const networks = await Promise.all(groups.map(async group => {
    const payload = buildNetworkPayload(group);
    const topChats = pickTopChats(group, 3);
    const summary = await summarizeNetwork(group.header, payload);
    return {
      header: group.header,
      key: group.key,
      summary,
      topChats,
      totalChats: group.chats.length,
    };
  }));

  return res.json({
    ok: true,
    source,
    yesterdayLabel: window.label,
    dataDate,
    freshestEditISO,
    networks,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /yesterday/activity (raw — kept for direct inspection)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/activity", async (req, res) => {
  const window = getYesterdayWindow();

  try {
    const chats = await fetchYesterdayFromBeeper(window);
    const groups = groupChatsForRender(chats);
    return res.json({
      ok: true,
      source: "beeper",
      yesterdayLabel: window.label,
      dataDate: window.label,
      groups,
      totalChats: chats.length,
    });
  } catch (beeperErr) {
    console.warn(`[yesterday] beeper failed: ${beeperErr.message} — falling back to hub`);
  }

  try {
    const { yesterdayRows, stalestFallbackRows, freshestEditISO } = await fetchYesterdayFromHub(window);

    if (yesterdayRows.length > 0) {
      const groups = groupChatsForRender(yesterdayRows.map(row => ({
        name: row.name, accountID: row.accountID, networkFull: row.networkFull,
        messagesYesterday: [{
          sender: row.lastMsgSender || "?", text: row.lastMsgText,
          timestamp: row.lastMsgTime, isSender: row.outbound,
        }],
      })));
      return res.json({
        ok: true, source: "hub-fresh",
        yesterdayLabel: window.label, dataDate: window.label,
        freshestEditISO, groups, totalChats: yesterdayRows.length,
      });
    }

    if (stalestFallbackRows.length > 0) {
      let staleDateLabel = "unknown";
      if (freshestEditISO) {
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Prague",
          year: "numeric", month: "2-digit", day: "2-digit",
        });
        const parts = fmt.formatToParts(new Date(freshestEditISO));
        staleDateLabel = `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
      }
      const groups = groupChatsForRender(stalestFallbackRows.map(row => ({
        name: row.name, accountID: row.accountID, networkFull: row.networkFull,
        messagesYesterday: [{
          sender: row.lastMsgSender || "?", text: row.lastMsgText,
          timestamp: row.lastMsgTime, isSender: row.outbound,
        }],
      })));
      return res.json({
        ok: true, source: "hub-stale",
        yesterdayLabel: window.label, dataDate: staleDateLabel,
        freshestEditISO, groups, totalChats: stalestFallbackRows.length,
      });
    }

    return res.json({
      ok: true, source: "hub-empty",
      yesterdayLabel: window.label, dataDate: null,
      freshestEditISO, groups: [], totalChats: 0,
    });
  } catch (hubErr) {
    return res.status(500).json({
      error: "both beeper and hub failed",
      hubError: hubErr.message,
    });
  }
});

module.exports = router;
