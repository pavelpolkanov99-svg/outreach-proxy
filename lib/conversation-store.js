// ─────────────────────────────────────────────────────────────────────────────
// lib/conversation-store.js
//
// Persistent conversation memory for the conversational layer of the FCC bot.
//
// Design decisions (recorded for future-self):
//   - SHARED conversation between Anton and Pavel (one history, both see all).
//     Any user can approve a write action initiated by the other.
//   - Persisted to /data/conversation-shared.json (Railway volume).
//     /tmp fallback if /data not mounted (token survives only until redeploy).
//   - Auto-summarize triggered at TURN_LIMIT_SOFT (default 50 turns).
//     Older turns get collapsed into a single "summary" turn.
//   - Hard cap TURN_LIMIT_HARD (default 100): forced /new with summary preserved.
//   - Cost tracking per UTC day. Soft warning at $15, no hard block.
//   - Each message is attributed with from = "anton" | "pavel" | "system".
//     Even though it's shared, attribution helps Claude understand who's asking.
//   - /new command resets history (preserving stored summary as starter context
//     so we don't lose all knowledge between sessions).
//
// IMPORTANT: This module is NOT wired into the bot yet. It exists standalone.
// Activation will happen later via CONVERSATIONAL_MODE_ENABLED env var.
//
// Concurrency: file writes are synchronous (small file ~50KB max). Race
// condition between Anton+Pavel writing simultaneously: last-write-wins.
// For a 2-user bot this is acceptable; if it ever becomes painful, add a
// simple file lock.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const STORE_PATH = process.env.CONVERSATION_STORE_PATH
  || (fs.existsSync("/data") ? "/data/conversation-shared.json"
                              : "/tmp/conversation-shared.json");

const TURN_LIMIT_SOFT = parseInt(process.env.CONV_TURN_LIMIT_SOFT, 10) || 50;
const TURN_LIMIT_HARD = parseInt(process.env.CONV_TURN_LIMIT_HARD, 10) || 100;
const BUDGET_DAILY_USD = parseFloat(process.env.CONV_BUDGET_DAILY_USD) || 15.0;

// In-memory cache (re-read file at most once per second). All mutations go to
// disk immediately; cache is just to avoid hot-path I/O.
let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// File I/O
// ─────────────────────────────────────────────────────────────────────────────

function emptyStore() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    summary: null,            // Rolling summary of pre-truncation turns
    turns: [],                // Active turns (see Turn shape below)
    costsByDate: {},          // { "2026-05-15": { usd: 1.23, msgs: 4 } }
    budgetWarningSentForDate: null, // last UTC date we warned about budget
  };
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyStore();
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Forward-compat: ensure all expected fields
    return { ...emptyStore(), ...parsed };
  } catch (err) {
    console.error("[conv-store] read failed, returning empty:", err.message);
    return emptyStore();
  }
}

function writeStore(store) {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
    cache = store;
    cacheLoadedAt = Date.now();
    return true;
  } catch (err) {
    console.error("[conv-store] write failed:", err.message);
    return false;
  }
}

function getStore() {
  if (cache && (Date.now() - cacheLoadedAt) < CACHE_TTL_MS) return cache;
  cache = readStore();
  cacheLoadedAt = Date.now();
  return cache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn shape
// ─────────────────────────────────────────────────────────────────────────────
//
// Each "turn" represents one exchange. Stored shape is Anthropic API-friendly:
//
//   {
//     role: "user" | "assistant",     // Anthropic-compatible role
//     content: string | content_blocks[],  // text or tool_use/tool_result blocks
//     metadata: {
//       from: "anton" | "pavel" | "system",  // who initiated (for user) or null (assistant)
//       fromUserId: <telegram_id> | null,
//       timestamp: ISO string,
//       inputTokens: int | null,             // for cost tracking on assistant turns
//       outputTokens: int | null,
//       costUsd: float | null,
//       toolCalls: [{ name, input, output }] | null,
//     }
//   }

function makeUserTurn({ text, from, fromUserId }) {
  return {
    role: "user",
    content: text,
    metadata: {
      from,
      fromUserId: fromUserId || null,
      timestamp: new Date().toISOString(),
      inputTokens:  null,
      outputTokens: null,
      costUsd:      null,
      toolCalls:    null,
    },
  };
}

function makeAssistantTurn({ content, inputTokens, outputTokens, costUsd, toolCalls }) {
  return {
    role: "assistant",
    content,
    metadata: {
      from: null,
      fromUserId: null,
      timestamp: new Date().toISOString(),
      inputTokens:  inputTokens || null,
      outputTokens: outputTokens || null,
      costUsd:      costUsd || null,
      toolCalls:    toolCalls || null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — append, read, reset
// ─────────────────────────────────────────────────────────────────────────────

function appendUserTurn({ text, from, fromUserId }) {
  if (!text || typeof text !== "string") throw new Error("text required");
  if (!["anton", "pavel", "system"].includes(from)) {
    throw new Error(`from must be anton|pavel|system, got ${from}`);
  }
  const store = getStore();
  store.turns.push(makeUserTurn({ text, from, fromUserId }));
  writeStore(store);
  return store;
}

function appendAssistantTurn({ content, inputTokens, outputTokens, costUsd, toolCalls }) {
  const store = getStore();
  store.turns.push(makeAssistantTurn({ content, inputTokens, outputTokens, costUsd, toolCalls }));

  // Track daily cost
  if (costUsd && costUsd > 0) {
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (!store.costsByDate[todayUtc]) {
      store.costsByDate[todayUtc] = { usd: 0, msgs: 0 };
    }
    store.costsByDate[todayUtc].usd += costUsd;
    store.costsByDate[todayUtc].msgs += 1;
  }

  writeStore(store);
  return store;
}

// Returns the current view: { summary, turns[], totalTurns, costsToday }
function getView() {
  const store = getStore();
  const todayUtc = new Date().toISOString().slice(0, 10);
  return {
    summary: store.summary,
    turns: store.turns,
    totalTurns: store.turns.length,
    costsToday: store.costsByDate[todayUtc] || { usd: 0, msgs: 0 },
    budgetDailyUsd: BUDGET_DAILY_USD,
    turnLimitSoft: TURN_LIMIT_SOFT,
    turnLimitHard: TURN_LIMIT_HARD,
  };
}

// Returns Anthropic-format messages array — drop our metadata, keep role+content.
// Caller is responsible for combining summary (via getSummaryForSystem) with
// the main system prompt; summary is NOT included in messages array.
function getMessagesForApi() {
  const store = getStore();
  return store.turns.map(t => ({
    role: t.role,
    content: t.content,
  }));
}

// Returns the summary as a system-prompt-friendly string (or empty).
// Caller is responsible for combining this with the main system prompt.
function getSummaryForSystem() {
  const store = getStore();
  if (!store.summary) return "";
  return `\n\n--- Previous conversation summary ---\n${store.summary}\n--- End summary ---\n`;
}

// Reset conversation. Preserves summary by default (so we don't lose all
// context). Pass keepSummary=false for a hard reset.
function resetConversation({ keepSummary = true, reason = "manual" } = {}) {
  const store = getStore();
  const oldTurns = store.turns.length;
  const oldSummary = store.summary;
  store.turns = [];
  if (!keepSummary) store.summary = null;
  // Don't reset costsByDate — that survives across /new commands
  writeStore(store);
  console.log(`[conv-store] reset (reason=${reason}, oldTurns=${oldTurns}, keptSummary=${keepSummary && !!oldSummary})`);
  return { oldTurns, keptSummary: keepSummary && !!oldSummary };
}

// Replace the rolling summary (called after auto-summarize completes).
function setSummary(summary) {
  const store = getStore();
  store.summary = summary;
  writeStore(store);
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget tracking
// ─────────────────────────────────────────────────────────────────────────────

// Returns true if today's spend just crossed the budget threshold (was below,
// now above). Used by bot to send a one-time warning per day.
// Marks the date as warned so we don't spam.
function checkBudgetCrossing() {
  const store = getStore();
  const todayUtc = new Date().toISOString().slice(0, 10);
  const todayCost = store.costsByDate[todayUtc]?.usd || 0;

  if (todayCost < BUDGET_DAILY_USD) return null;
  if (store.budgetWarningSentForDate === todayUtc) return null;

  store.budgetWarningSentForDate = todayUtc;
  writeStore(store);
  return {
    costUsd:       todayCost,
    budgetDailyUsd: BUDGET_DAILY_USD,
    date:          todayUtc,
    msgs:          store.costsByDate[todayUtc]?.msgs || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Truncation status — caller (bot/agent) decides what to do when limits hit
// ─────────────────────────────────────────────────────────────────────────────

function getTruncationStatus() {
  const store = getStore();
  const n = store.turns.length;
  return {
    totalTurns:    n,
    softLimit:     TURN_LIMIT_SOFT,
    hardLimit:     TURN_LIMIT_HARD,
    shouldSummarize: n >= TURN_LIMIT_SOFT && n < TURN_LIMIT_HARD,
    mustReset:     n >= TURN_LIMIT_HARD,
    hasSummary:    !!store.summary,
  };
}

// After auto-summarize completes externally, this is how we apply the result:
//   1. Replace summary with new summary
//   2. Keep last KEEP_RECENT_TURNS turns (so Claude has recent context)
//   3. Drop everything in the middle
function applySummarization({ newSummary, keepRecentTurns = 10 }) {
  const store = getStore();
  const recent = store.turns.slice(-keepRecentTurns);
  store.summary = newSummary;
  store.turns = recent;
  writeStore(store);
  console.log(`[conv-store] summarized: kept ${recent.length} recent turns, dropped middle`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug / introspection
// ─────────────────────────────────────────────────────────────────────────────

function debugStatus() {
  const store = getStore();
  const todayUtc = new Date().toISOString().slice(0, 10);
  const last3 = store.turns.slice(-3).map(t => ({
    role: t.role,
    from: t.metadata?.from || null,
    timestamp: t.metadata?.timestamp || null,
    preview: typeof t.content === "string"
      ? t.content.slice(0, 80)
      : "[complex content]",
  }));
  return {
    storePath:     STORE_PATH,
    totalTurns:    store.turns.length,
    hasSummary:    !!store.summary,
    summaryLength: store.summary ? store.summary.length : 0,
    costsToday:    store.costsByDate[todayUtc] || { usd: 0, msgs: 0 },
    budgetDaily:   BUDGET_DAILY_USD,
    turnLimitSoft: TURN_LIMIT_SOFT,
    turnLimitHard: TURN_LIMIT_HARD,
    last3Turns:    last3,
  };
}

module.exports = {
  // Append
  appendUserTurn,
  appendAssistantTurn,
  // Read
  getView,
  getMessagesForApi,
  getSummaryForSystem,
  // Reset
  resetConversation,
  setSummary,
  applySummarization,
  // Budget
  checkBudgetCrossing,
  // Limits
  getTruncationStatus,
  // Debug
  debugStatus,
  // Constants (for caller awareness)
  BUDGET_DAILY_USD,
  TURN_LIMIT_SOFT,
  TURN_LIMIT_HARD,
};
