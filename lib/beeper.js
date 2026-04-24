const axios = require("axios");

const BEEPER_URL   = process.env.BEEPER_URL   || "http://localhost:23373";
const BEEPER_TOKEN = process.env.BEEPER_TOKEN;

// ── REST headers (v1 endpoints) ──────────────────────────────────────────────
function beeperHeaders() {
  return {
    "Authorization": `Bearer ${BEEPER_TOKEN}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };
}

// ── MCP headers — Beeper requires both application/json and text/event-stream ─
function beeperMcpHeaders() {
  return {
    "Authorization": `Bearer ${BEEPER_TOKEN}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json, text/event-stream",
  };
}

// ── Account id helpers ──────────────────────────────────────────────────────
function isWhatsApp(id) { return id && id.includes("whatsapp"); }
function isTelegram(id) { return id === "telegram"; }
function isLinkedIn(id) { return id === "linkedin"; }

function netLabel(id) {
  if (isWhatsApp(id)) return "WA";
  if (isTelegram(id)) return "TG";
  if (isLinkedIn(id)) return "LI";
  return id || "?";
}

function networkFromAccountID(accountID = "") {
  if (accountID === "telegram") return "Telegram";
  if (accountID.includes("linkedin")) return "LinkedIn";
  return "WhatsApp";
}

// ── Fuzzy match for chat↔company alignment ──────────────────────────────────
function fuzzyMatch(chatName, targetName) {
  if (!chatName || !targetName) return false;
  const a = chatName.toLowerCase().trim();
  const b = targetName.toLowerCase().trim();
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = b.split(/[\s,.|&<>x\-]+/).filter(w => w.length > 3);
  return words.some(w => a.includes(w));
}

// ── Formatter for chat history blobs ────────────────────────────────────────
function formatMessages(items = [], limit = 9999) {
  return items
    .slice(0, limit)
    .reverse()
    .map(m => {
      const time   = m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : "?";
      const sender = m.sender?.fullName || m.sender?.displayName || m.sender?.id || "?";
      const text   = m.content?.text || m.content?.body || "";
      return text ? `[${time}] ${sender}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

// ── Parse SSE response from Beeper MCP into JSON ────────────────────────────
function parseMcpSse(rawText) {
  const lines = rawText.split('\n').filter(l => l.startsWith('data: '));
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6));
      if (json.result) return json.result;
      if (json.error) throw new Error(json.error.message);
    } catch (_) {}
  }
  try { return JSON.parse(rawText); } catch (_) {}
  return null;
}

// ── Helper: fetch messages via Beeper MCP (since /v1/messages doesn't exist) ──
async function beeperGetMessages(chatID, limit = 9999) {
  const rpcBody = {
    jsonrpc: "2.0", id: Date.now(),
    method: "tools/call",
    params: { name: "list_messages", arguments: { chatID, limit } }
  };
  const r = await axios.post(
    `${BEEPER_URL}/v0/mcp`,
    rpcBody,
    { headers: beeperMcpHeaders(), timeout: 30000, responseType: "text" }
  );
  const result = parseMcpSse(r.data);
  if (!result) return [];
  const content = result.content || result;
  const textBlock = Array.isArray(content) ? content.find(c => c.type === "text") : null;
  const rawText = textBlock?.text || (typeof content === "string" ? content : null);
  if (!rawText) return [];
  try {
    const parsed = JSON.parse(rawText);
    return parsed.messages || parsed.items || (Array.isArray(parsed) ? parsed : []);
  } catch {
    return [{ senderName: "system", text: rawText, timestamp: Date.now() }];
  }
}

module.exports = {
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
};
