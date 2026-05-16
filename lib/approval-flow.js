// ─────────────────────────────────────────────────────────────────────────────
// lib/approval-flow.js
//
// Holds "pending approval" state for write tools in the conversational layer.
//
// When agent.js returns { kind: "approval", pending: {...} }, bot.js needs to
// show the user an inline keyboard ([✅ Да] / [❌ Нет]) and wait — possibly
// for minutes — until they tap a button. This module is the place that state
// lives between "show keyboard" and "button tapped".
//
// Flow:
//   1. agent.js → { kind: "approval", pending }
//   2. bot.js calls createApproval(pending) → gets approvalId
//   3. bot.js builds inline keyboard with buildCallbackData(approvalId, "yes"/"no")
//   4. user taps → Telegram sends callback_query with the callback_data
//   5. bot.js calls parseCallbackData(data) → { approvalId, decision }
//   6. bot.js calls resolveApproval(approvalId, approved) → { pending } | error
//   7. bot.js calls agent.continueAfterApproval({ pending, approved })
//
// Persistence: in-memory Map + mirror to /data/pending-approvals.json so a
// Railway redeploy mid-approval doesn't orphan the user's pending action.
// (/tmp fallback if /data unavailable.)
//
// TTL: approvals older than APPROVAL_TTL_MS are considered stale and rejected
// — protects against "user tapped a button 3 hours later in a different
// context".
//
// Stale-guard: invalidateForTurn(turnId) lets bot.js drop all approvals tied
// to a superseded turn (mirrors the turnId race-guard in agent.js).
//
// IMPORTANT: This module is NOT yet wired into bot.js. Activation happens
// later behind CONVERSATIONAL_MODE_ENABLED env var.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const STORE_PATH = process.env.APPROVAL_STORE_PATH
  || (fs.existsSync("/data") ? "/data/pending-approvals.json"
                              : "/tmp/pending-approvals.json");

// How long a pending approval stays valid. After this, tapping the button
// returns a "stale" error and the action is NOT executed.
const APPROVAL_TTL_MS = parseInt(process.env.APPROVAL_TTL_MS, 10) || 30 * 60 * 1000; // 30 min

// callback_data prefix. Telegram limits callback_data to 64 bytes total.
const CALLBACK_PREFIX = "appr";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store + disk mirror
// ─────────────────────────────────────────────────────────────────────────────
//
// Shape of a stored approval record:
//   {
//     approvalId:  string,
//     pending:     <the agent.js pending object>,
//     turnId:      string,           (copied from pending for fast stale-check)
//     createdAt:   ISO string,
//     createdMs:   number,           (epoch ms, for TTL math)
//     status:      "pending" | "resolved" | "stale",
//     resolvedAt:  ISO string | null,
//     approved:    boolean | null,
//   }

let store = null;  // Map<approvalId, record>

function nowMs() { return Date.now(); }

function newApprovalId() {
  // Short but collision-resistant. Kept short because it rides inside the
  // 64-byte callback_data alongside the prefix and decision suffix.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_PATH)) return new Map();
    const raw    = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const m = new Map();
    for (const rec of (parsed.records || [])) {
      if (rec && rec.approvalId) m.set(rec.approvalId, rec);
    }
    return m;
  } catch (err) {
    console.error("[approval] loadFromDisk failed, starting empty:", err.message);
    return new Map();
  }
}

function persistToDisk() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const records = Array.from(store.values());
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records }, null, 2),
      { mode: 0o600 }
    );
  } catch (err) {
    console.error("[approval] persistToDisk failed:", err.message);
  }
}

function ensureLoaded() {
  if (store === null) store = loadFromDisk();
  return store;
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL / cleanup
// ─────────────────────────────────────────────────────────────────────────────

function isExpired(record) {
  return (nowMs() - record.createdMs) > APPROVAL_TTL_MS;
}

// Remove resolved + expired records. Returns count removed. Safe to call
// often (e.g. on every createApproval).
function cleanup() {
  ensureLoaded();
  let removed = 0;
  for (const [id, rec] of store.entries()) {
    const expired  = isExpired(rec);
    const resolved = rec.status === "resolved";
    // Keep resolved records briefly for idempotency (double-tap protection),
    // but drop them once they're also past TTL.
    if ((resolved && expired) || (rec.status === "pending" && expired)) {
      store.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    persistToDisk();
    console.log(`[approval] cleanup removed ${removed} stale/resolved record(s)`);
  }
  return removed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

// Create a new pending approval. Returns { approvalId }.
function createApproval(pending) {
  ensureLoaded();
  cleanup();

  if (!pending || typeof pending !== "object") {
    throw new Error("createApproval: pending object required");
  }

  const approvalId = newApprovalId();
  const record = {
    approvalId,
    pending,
    turnId:     pending.turnId || null,
    createdAt:  new Date().toISOString(),
    createdMs:  nowMs(),
    status:     "pending",
    resolvedAt: null,
    approved:   null,
  };
  store.set(approvalId, record);
  persistToDisk();

  console.log(`[approval] created ${approvalId} for tool=${pending.toolName} turn=${pending.turnId}`);
  return { approvalId };
}

// Fetch a pending approval. Returns { ok, record } or { ok:false, reason }.
// reason ∈ "not_found" | "expired" | "already_resolved" | "stale"
function getApproval(approvalId) {
  ensureLoaded();
  const record = store.get(approvalId);
  if (!record) return { ok: false, reason: "not_found" };
  if (record.status === "resolved") {
    return { ok: false, reason: "already_resolved", record };
  }
  // Already marked stale (e.g. by invalidateForTurn / invalidateAll).
  // Must reject — this is the race-condition guard.
  if (record.status === "stale") {
    return { ok: false, reason: "stale", record };
  }
  if (isExpired(record)) {
    record.status = "stale";
    persistToDisk();
    return { ok: false, reason: "expired", record };
  }
  return { ok: true, record };
}

// Resolve an approval (user tapped a button). Marks it resolved so a
// double-tap can't execute the action twice.
// Returns:
//   { ok: true, pending, approved }                — proceed to agent
//   { ok: false, reason }                          — show error to user
//     reason ∈ "not_found" | "expired" | "already_resolved" | "stale"
function resolveApproval(approvalId, approved) {
  ensureLoaded();
  const got = getApproval(approvalId);
  if (!got.ok) {
    // Surface a friendly reason; include prior decision if double-tap.
    if (got.reason === "already_resolved" && got.record) {
      return {
        ok: false,
        reason: "already_resolved",
        priorApproved: got.record.approved,
      };
    }
    return { ok: false, reason: got.reason };
  }

  const record = got.record;
  record.status     = "resolved";
  record.resolvedAt = new Date().toISOString();
  record.approved   = !!approved;
  persistToDisk();

  console.log(`[approval] resolved ${approvalId} approved=${record.approved} tool=${record.pending.toolName}`);
  return { ok: true, pending: record.pending, approved: record.approved };
}

// ─────────────────────────────────────────────────────────────────────────────
// callback_data encoding/decoding
// ─────────────────────────────────────────────────────────────────────────────
//
// Telegram callback_data hard limit: 64 bytes. Our format:
//     appr:<approvalId>:<decision>
// approvalId is ~12 chars, decision is "y" or "n" → well under 64.

function buildCallbackData(approvalId, decision) {
  const d = decision === "yes" || decision === true || decision === "y" ? "y" : "n";
  const data = `${CALLBACK_PREFIX}:${approvalId}:${d}`;
  if (Buffer.byteLength(data, "utf8") > 64) {
    // Should never happen with our ID length, but guard anyway.
    throw new Error(`callback_data exceeds 64 bytes: ${data}`);
  }
  return data;
}

// Parse callback_data from a tapped button.
// Returns { approvalId, decision: "yes"|"no" } or null if not ours.
function parseCallbackData(data) {
  if (typeof data !== "string") return null;
  if (!data.startsWith(`${CALLBACK_PREFIX}:`)) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [, approvalId, d] = parts;
  if (!approvalId) return null;
  return {
    approvalId,
    decision: d === "y" ? "yes" : "no",
  };
}

// Build the inline keyboard markup (grammy-compatible) for an approval.
// bot.js can pass this straight into ctx.reply(..., { reply_markup }).
function buildInlineKeyboard(approvalId) {
  return {
    inline_keyboard: [[
      { text: "✅ Да",  callback_data: buildCallbackData(approvalId, "yes") },
      { text: "❌ Нет", callback_data: buildCallbackData(approvalId, "no")  },
    ]],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale-guard — invalidate approvals tied to a superseded turn
// ─────────────────────────────────────────────────────────────────────────────

// When a newer user turn supersedes an older one, any pending approval that
// belonged to the old turn should not be executable. bot.js calls this when
// it detects a new turn started while an approval was outstanding.
// Returns count invalidated.
function invalidateForTurn(turnId) {
  ensureLoaded();
  let count = 0;
  for (const rec of store.values()) {
    if (rec.status === "pending" && rec.turnId === turnId) {
      rec.status     = "stale";
      rec.resolvedAt = new Date().toISOString();
      count++;
    }
  }
  if (count > 0) {
    persistToDisk();
    console.log(`[approval] invalidated ${count} approval(s) for superseded turn ${turnId}`);
  }
  return count;
}

// Invalidate ALL currently-pending approvals (used by /new command — when the
// conversation resets, nothing pending should remain executable).
function invalidateAll(reason = "manual") {
  ensureLoaded();
  let count = 0;
  for (const rec of store.values()) {
    if (rec.status === "pending") {
      rec.status     = "stale";
      rec.resolvedAt = new Date().toISOString();
      count++;
    }
  }
  if (count > 0) {
    persistToDisk();
    console.log(`[approval] invalidated ALL ${count} pending approval(s), reason=${reason}`);
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug / introspection
// ─────────────────────────────────────────────────────────────────────────────

function debugStatus() {
  ensureLoaded();
  const records = Array.from(store.values());
  return {
    storePath:   STORE_PATH,
    ttlMinutes:  APPROVAL_TTL_MS / 60000,
    total:       records.length,
    pending:     records.filter(r => r.status === "pending").length,
    resolved:    records.filter(r => r.status === "resolved").length,
    stale:       records.filter(r => r.status === "stale").length,
    items: records.map(r => ({
      approvalId: r.approvalId,
      tool:       r.pending?.toolName,
      turnId:     r.turnId,
      status:     r.status,
      ageMin:     Math.round((nowMs() - r.createdMs) / 60000),
      approved:   r.approved,
    })),
  };
}

module.exports = {
  // Lifecycle
  createApproval,
  getApproval,
  resolveApproval,
  // Telegram callback_data
  buildCallbackData,
  parseCallbackData,
  buildInlineKeyboard,
  // Stale-guard
  invalidateForTurn,
  invalidateAll,
  // Maintenance
  cleanup,
  // Debug
  debugStatus,
  // Constants
  APPROVAL_TTL_MS,
  CALLBACK_PREFIX,
};
