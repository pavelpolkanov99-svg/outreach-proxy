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
    const r = await axios.post(
      `${BEEPER_URL}/v0/mcp`,
      rpcBody,
      { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" }
    );
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
    const r = await axios.post(
      `${BEEPER_URL}/v0/mcp`,
      rpcBody,
      { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" }
    );
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

// ══════════════════════════════════════════════════════════════════════════════
// Convenience endpoints for Claude (no curl needed)
// ══════════════════════════════════════════════════════════════════════════════

// GET /beeper/inbox ──────────────────────────────────────────────────────────
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

// GET /beeper/chat?name=X ─────────────────────────────────────────────────────
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
