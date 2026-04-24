const express = require("express");
const axios   = require("axios");
const cron    = require("node-cron");
const {
  BEEPER_URL,
  BEEPER_TOKEN,
  beeperHeaders,
  beeperMcpHeaders,
  networkFromAccountID,
  parseMcpSse,
  beeperGetMessages,
} = require("../lib/beeper");
const {
  NOTION_TOKEN,
  MESSAGES_HUB_DB,
  COMPANIES_DB_ID,
  PEOPLE_DB_ID,
  notionHeaders,
  notionQuery,
  notionCreatePage,
  notionUpdatePage,
  findNotionCompany,
  findNotionPeopleByNames,
  findHubByRemoteId,
} = require("../lib/notion");

const router = express.Router();

const DISCOVERY_CARD_PATTERN = /notion\.so\/plex0\/Discovery-Card/i;
const CALENDLY_PATTERN       = /calendly\.com\/plex0\//i;

let lastSyncAt = null;

function extractCompanyName(chatName = "") {
  return chatName
    .replace(/RemiDe|Remide|Plexo|plexo/gi, "")
    .replace(/<>|<=>|x\s/gi, "|")
    .split("|")[0]
    .replace(/[<>]/g, "")
    .trim();
}

async function getChatParticipantNames(chatID) {
  try {
    const rpc = { jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name: "get_chat", arguments: { chatID, maxParticipantCount: 10 } } };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpc,
      { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" });
    const result = parseMcpSse(r.data);
    const text = result?.content?.[0]?.text || "";
    const names = [];
    for (const m of text.matchAll(/[-•*]\s+([A-Za-zА-Яа-я][^\n,@(]{2,30})/g)) {
      const n = m[1].trim();
      if (!/plexo|remide|anton|pavel/i.test(n)) names.push(n);
    }
    return names;
  } catch (_) { return []; }
}

async function checkLinksInChat(chatID) {
  const result = { discoveryCard: false, calendly: false };
  try {
    const rpc = { jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name: "list_messages", arguments: { chatID } } };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpc,
      { headers: beeperMcpHeaders(), timeout: 20000, responseType: "text" });
    const msgResult = parseMcpSse(r.data);
    const msgText = msgResult?.content?.[0]?.text || "";
    let items = [];
    try { items = JSON.parse(msgText)?.items || []; } catch (_) {}
    for (const msg of items) {
      const text = msg.text || "";
      if (!result.discoveryCard && DISCOVERY_CARD_PATTERN.test(text)) result.discoveryCard = true;
      if (!result.calendly      && CALENDLY_PATTERN.test(text))       result.calendly = true;
      if (result.discoveryCard && result.calendly) break;
    }
  } catch (_) {}
  return result;
}

async function upsertChatToHub(chatInfo) {
  const { chatName, chatID, accountID, lastMsg, lastActiveDate } = chatInfo;
  const net                = networkFromAccountID(accountID);
  const companyName        = extractCompanyName(chatName);
  const companyId          = await findNotionCompany(companyName);
  const participantNames   = await getChatParticipantNames(chatID);
  const personIds          = await findNotionPeopleByNames(participantNames);
  const links              = await checkLinksInChat(chatID);

  let lastMsgText = "", rawSender = "", lastDate = lastActiveDate || null;
  if (lastMsg) {
    const timeM = lastMsg.match(/\[(\d{2})\.(\d{2})\.(\d{4})/);
    if (timeM) lastDate = `${timeM[3]}-${timeM[2]}-${timeM[1]}`;
    const senderM = lastMsg.match(/[→←]\s+([^:]+):/);
    rawSender = senderM?.[1]?.trim() || "";
    lastMsgText = lastMsg.replace(/^\[.*?\]\s*[→←]\s*[^:]+:\s*/, "").trim().slice(0, 500);
  }

  const props = {
    "Chat Name": { title:        [{ text: { content: chatName || "Unknown" } }] },
    "Remote ID": { rich_text:    [{ text: { content: chatID } }] },
    "Network":   { multi_select: [{ name: net }] },
    "Status":    { status:       { name: "Active" } },
  };
  if (lastMsgText)           props["Last Message"]    = { rich_text: [{ text: { content: lastMsgText } }] };
  if (rawSender)             props["Raw Sender Name"] = { rich_text: [{ text: { content: rawSender } }] };
  if (lastDate)              props["Last Active"]     = { date: { start: lastDate } };
  if (companyId)             props["Link: Companies"] = { relation: [{ id: companyId }] };
  if (personIds.length)      props["Link: People"]    = { relation: personIds.map(id => ({ id })) };
  if (participantNames.length)
    props["Participants"] = { rich_text: [{ text: { content: participantNames.join(", ").slice(0, 500) } }] };
  if (links.discoveryCard)   props["DiscoveryCard"] = { checkbox: true };
  if (links.calendly)        props["Calendly"]      = { checkbox: true };

  const existingId = await findHubByRemoteId(chatID);
  if (existingId) {
    await notionUpdatePage(existingId, props);
    return { action: "updated", chatName };
  } else {
    await notionCreatePage(MESSAGES_HUB_DB, props);
    return { action: "created", chatName };
  }
}

async function runBeeperSync(opts = {}) {
  const { since, limit = 100 } = opts;
  if (!BEEPER_TOKEN) throw new Error("BEEPER_TOKEN not set");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=${limit}`,
    { headers: beeperHeaders(), timeout: 15000 });
  const allChats = chatsRes.data?.items || [];
  const sinceDate = since ? new Date(since) : null;
  const filtered = allChats.filter(c => {
    if (!sinceDate) return true;
    const ts = c.lastActivityAt || c.lastActivity || c.updatedAt;
    if (!ts) return true;
    return new Date(ts) > sinceDate;
  });

  console.log(`[sync] ${allChats.length} total chats, ${filtered.length} to sync`);

  for (const c of filtered) {
    try {
      const rpc = { jsonrpc: "2.0", id: Date.now(), method: "tools/call",
        params: { name: "list_messages", arguments: { chatID: c.id } } };
      const mr = await axios.post(`${BEEPER_URL}/v0/mcp`, rpc,
        { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
      const msgResult = parseMcpSse(mr.data);
      const msgText = msgResult?.content?.[0]?.text || "";
      let lastMsg = "", lastActiveDate = null;
      try {
        const parsed = JSON.parse(msgText);
        const first = parsed.items?.[0];
        if (first) {
          const t = new Date(first.timestamp);
          lastActiveDate = t.toISOString().split("T")[0];
          lastMsg = `[${t.toLocaleString("ru-RU")}] ${first.isSender ? "→" : "←"} ${first.senderName}: ${first.text || "[медиа]"}`;
        }
      } catch (_) {}

      const r = await upsertChatToHub({
        chatName: c.title || c.name || "Unknown",
        chatID: c.id, accountID: c.accountID,
        lastMsg, lastActiveDate,
      });
      if (r.action === "created") results.created++;
      else                        results.updated++;
      console.log(`[sync] ${r.action}: ${r.chatName}`);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      const errMsg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      console.error(`[sync] ERROR ${c.title || c.id}: ${errMsg}`);
      results.errors.push(`${c.title || c.id}: ${errMsg}`);
      results.skipped++;
    }
  }

  lastSyncAt = new Date().toISOString();
  return results;
}

// ── POST /beeper/sync-to-notion ───────────────────────────────────────────────
router.post("/sync-to-notion", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { since, limit = 100 } = req.body || {};
  console.log(`[sync] Manual sync triggered since=${since || "all"}`);
  try {
    const results = await runBeeperSync({ since, limit });
    res.json({ ok: true, ...results, lastSyncAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /beeper/sync-status ───────────────────────────────────────────────────
router.get("/sync-status", (_, res) =>
  res.json({ ok: true, lastSyncAt, nextSync: "hourly cron" })
);

// ══════════════════════════════════════════════════════════════════════════════
// Cron registrations — invoked once at startup from index.js via registerJobs()
// ══════════════════════════════════════════════════════════════════════════════
function registerJobs() {
  // ── Weekdays 09:00 Europe/Tallinn — warm cache ──────────────────────────────
  if (BEEPER_TOKEN) {
    cron.schedule("0 9 * * 1-5", async () => {
      console.log("[cron] warm-cache start");
      try {
        const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
        const chats = r.data?.items || [];
        let warmed = 0;
        for (const c of chats) {
          try {
            await beeperGetMessages(c.id, 200);
            warmed++;
          } catch (_) {}
        }
        console.log(`[cron] warm-cache done: ${warmed}/${chats.length}`);
      } catch (e) { console.error("[cron] warm-cache failed:", e.message); }
    }, { timezone: "Europe/Tallinn" });
    console.log("[cron] warm-cache registered (weekdays 09:00 EET)");
  }

  // ── Hourly Beeper → Notion sync ─────────────────────────────────────────────
  if (BEEPER_TOKEN && NOTION_TOKEN) {
    cron.schedule("0 * * * *", async () => {
      console.log("[cron] Beeper→Notion sync start");
      try {
        const since = lastSyncAt || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const results = await runBeeperSync({ since, limit: 100 });
        console.log(`[cron] sync done: +${results.created} created, ~${results.updated} updated, ${results.skipped} skipped`);
      } catch (e) { console.error("[cron] sync failed:", e.message); }
    });
    console.log("[cron] Beeper→Notion sync registered (every hour)");

    // Catch-up sync on startup — last 7 days
    setTimeout(async () => {
      console.log("[startup] Running catch-up sync (last 7 days)...");
      try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const results = await runBeeperSync({ since, limit: 100 });
        console.log(`[startup] catch-up done: +${results.created} created, ~${results.updated} updated`);
      } catch (e) { console.error("[startup] catch-up failed:", e.message); }
    }, 90000);
  }
}

module.exports = { router, registerJobs, runBeeperSync };
