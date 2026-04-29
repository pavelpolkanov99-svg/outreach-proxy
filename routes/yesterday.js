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

// ─────────────────────────────────────────────────────────────────────────────
// Per-network identity: Anton's WA accounts have phone numbers we want to
// surface in the digest header (per Pavel's request). LinkedIn / Telegram
// have no per-account distinction so they're shown as-is.
//
// accountID prefixes:
//   "linkedin"          → LinkedIn
//   "telegram"          → Telegram
//   ".../...Htp4o5..."  → WA Plexo (+420777225067)
//   ".../...ehMYU4..."  → WA Anton (+420774576161)
// ─────────────────────────────────────────────────────────────────────────────

const WA_ACCOUNT_PHONE = {
  "Htp4o51CAhE8_SXbpXCKofjvn1Y": "+420777225067",
  "ehMYU4KFPp6AAcwfsxn5Pt1jhV4": "+420774576161",
};

function networkLabelWithPhone(accountID, networkFull) {
  if (!accountID) return networkFull || "Unknown";
  if (networkFull === "WhatsApp") {
    for (const [token, phone] of Object.entries(WA_ACCOUNT_PHONE)) {
      if (accountID.includes(token)) {
        return `WhatsApp (${phone})`;
      }
    }
    return "WhatsApp";
  }
  return networkFull || "Unknown";
}

// Group key for the digest sections. We want WA-1 and WA-2 in separate sections
// so the per-phone label can be shown.
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

// Parse "WhatsApp:+420..." back into a render-friendly section header.
function groupKeyToHeader(key) {
  if (key.startsWith("WhatsApp:")) {
    const phone = key.split(":")[1];
    return `WhatsApp (${phone})`;
  }
  return key;
}

// Drop these chat names entirely — they're community/spam noise that adds nothing
// to a "yesterday activity" review.
const SKIP_CHAT_NAME_REGEX = /(rocket tech school|frontforumfocus|world impact|africa stablecoin community|deals global investment|beeper developer|blockchain.*tech news|latam venture talks|дедушка)/i;

const INTERNAL_SENDER_REGEX = /(anton ceo|antón|^антон$|^pavel|polkanov|@pavel-remide:beeper\.com|titov|anton t)/i;

function isInternalSender(s) {
  if (!s) return false;
  return INTERNAL_SENDER_REGEX.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// "Yesterday window" — UTC day boundaries for "yesterday" in Europe/Prague (Anton's TZ).
// Returns {startISO, endISO, label} where label is "YYYY-MM-DD" in Prague-local.
//
// Implementation: take "now in Prague", subtract 1 day, get start/end of that day in Prague,
// convert to UTC ISO. Handles DST automatically because we use Intl.DateTimeFormat.
// ─────────────────────────────────────────────────────────────────────────────

function getYesterdayWindow() {
  const TZ = "Europe/Prague";
  const now = new Date();
  // Compute Prague-local "yesterday" date string
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  const label = `${y}-${m}-${d}`;

  // Prague offset for that date (DST aware): use a known noon in Prague,
  // figure out UTC offset, then compute day bounds.
  const noonPragueIso = `${label}T12:00:00`;
  // Build a Date from local-string-as-if-UTC, then compute offset to actual Prague.
  const probe = new Date(noonPragueIso + "Z"); // pretend it's UTC
  const fmtCheck = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  });
  const hourInPrague = parseInt(fmtCheck.format(probe), 10);
  // probe was 12:00 UTC; in Prague it shows hourInPrague. Offset = hourInPrague - 12.
  const offsetHours = hourInPrague - 12;

  // Start of Prague-local day = 00:00 Prague = (00 - offset) UTC
  const startUtcHour = -offsetHours;
  const startISO = new Date(`${label}T00:00:00Z`).getTime() - offsetHours * 3600_000;
  const endISO = startISO + 24 * 3600_000;

  return {
    startISO: new Date(startISO).toISOString(),
    endISO:   new Date(endISO).toISOString(),
    label,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch from Beeper (preferred source — fresh data)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchYesterdayFromBeeper({ startISO, endISO }) {
  if (!BEEPER_TOKEN) throw new Error("BEEPER_TOKEN not set");

  const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=200`, {
    headers: beeperHeaders(),
    timeout: 12_000,
  });
  const items = r.data?.items || [];

  // Filter to chats with activity in the yesterday window
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  const recentChats = items.filter(c => {
    const ts = c.lastMessageAt || c.lastActivityAt || c.updatedAt;
    if (!ts) return false;
    const tsMs = Date.parse(ts);
    return !isNaN(tsMs) && tsMs >= startMs && tsMs < endMs;
  });

  // For each chat, fetch a few last messages to get conversation context
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
    } catch (_) { /* swallow per-chat errors */ }

    return {
      id: c.id,
      name: c.title || c.name || "",
      type: c.type,
      accountID: c.accountID,
      networkFull: networkFromAccountID(c.accountID),
      messagesYesterday,
    };
  }));

  // Drop chats with no actual yesterday messages and skip-listed names
  return enriched.filter(c =>
    c.messagesYesterday.length > 0 &&
    !SKIP_CHAT_NAME_REGEX.test(c.name)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch from Messaging Hub (fallback). Returns chats whose Last Active OR
// last_edited_time falls within the yesterday window. Also returns the freshest
// last_edited_time across the whole DB so the caller knows how stale data is.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchYesterdayFromHub({ startISO, endISO }) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN not set");

  // Pull anything edited in the past 7 days — gives us both yesterday rows AND
  // metadata about how stale the whole DB is.
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

  // Extract candidate rows
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

    // Hub doesn't store accountID directly, but we can derive group from Network
    // multi_select. WA Plexo vs WA Anton can't be distinguished from Hub data
    // alone — we'll rely on Beeper for that distinction. In Hub fallback,
    // both WA accounts get merged into one "WhatsApp" group.
    const accountID = null; // Hub doesn't expose it

    const lastActiveDate = props["Last Active"]?.date?.start || null;
    const lastEditedTime = page.last_edited_time;
    const effectiveTime = lastActiveDate || lastEditedTime;

    return {
      name,
      networkFull,
      accountID,
      lastMsgText,
      lastMsgSender: rawSender,
      lastMsgTime: effectiveTime,
      lastEditedTime,
      outbound: rawSender ? isInternalSender(rawSender) : false,
    };
  });

  // Freshest sync timestamp across the whole DB — tells us how stale Hub is
  const freshestEdit = allRows.length > 0
    ? allRows.reduce((max, row) => {
        const ts = Date.parse(row.lastEditedTime || 0);
        return !isNaN(ts) && ts > max ? ts : max;
      }, 0)
    : 0;

  // Filter to yesterday-window rows with content, skip noise
  const yesterdayRows = allRows.filter(row => {
    if (!row.lastMsgText || !row.lastMsgText.trim()) return false;
    if (SKIP_CHAT_NAME_REGEX.test(row.name)) return false;
    const tsMs = Date.parse(row.lastMsgTime);
    if (isNaN(tsMs)) return false;
    return tsMs >= startMs && tsMs < endMs;
  });

  // If no rows in yesterday window, also return the *most recent* available rows
  // so the caller can show "data is from <date>, here's what we have"
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
// Group chats by network and produce the response shape used by the bot.
// ─────────────────────────────────────────────────────────────────────────────

function groupChatsForRender(chats, { isFromHub = false } = {}) {
  const groups = new Map();

  for (const chat of chats) {
    const key = groupKey(chat.accountID, chat.networkFull);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        header: groupKeyToHeader(key),
        chats: [],
      });
    }
    groups.get(key).chats.push(chat);
  }

  // Convert to array, sorted by canonical order: LinkedIn → Telegram → WA-1 → WA-2 → others
  const orderRank = (key) => {
    if (key === "LinkedIn") return 0;
    if (key === "Telegram") return 1;
    if (key.startsWith("WhatsApp:+420777225067")) return 2;
    if (key.startsWith("WhatsApp:+420774576161")) return 3;
    if (key.startsWith("WhatsApp")) return 4; // generic WA (Hub fallback merges them)
    return 99;
  };

  return Array.from(groups.values()).sort((a, b) =>
    orderRank(a.key) - orderRank(b.key)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /yesterday/activity
//
// Returns yesterday's messenger activity grouped by network.
// Tries Beeper first, falls back to Messaging Hub if Beeper fails.
//
// Response shape:
//   {
//     ok: true,
//     source: "beeper" | "hub-fresh" | "hub-stale",
//     yesterdayLabel: "2026-04-28",      // Prague-local date label
//     dataDate: "2026-04-28",            // when the data is actually FROM
//     freshestEditISO: "...",            // freshest Hub sync timestamp (only when source != beeper)
//     groups: [
//       {
//         key: "LinkedIn",
//         header: "LinkedIn",
//         chats: [{ name, lastMsgText, messagesYesterday: [...] }]
//       }, ...
//     ]
//   }
//
// Source meanings:
//   "beeper"      → fresh data direct from Beeper Desktop
//   "hub-fresh"   → Hub had rows for yesterday — fairly recent data (may be stale by hours)
//   "hub-stale"   → Hub had no rows for yesterday — returning latest available rows,
//                   `dataDate` will be the freshest sync date (NOT yesterday's date)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/activity", async (req, res) => {
  const window = getYesterdayWindow();

  // Try Beeper first
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

  // Fall back to Messaging Hub
  try {
    const { yesterdayRows, stalestFallbackRows, freshestEditISO } = await fetchYesterdayFromHub(window);

    // Decide source based on whether we have actual yesterday rows
    if (yesterdayRows.length > 0) {
      // We have rows for yesterday — Hub is fresh-enough
      const groups = groupChatsForRender(
        yesterdayRows.map(row => ({
          name: row.name,
          accountID: row.accountID,
          networkFull: row.networkFull,
          lastMsgText: row.lastMsgText,
          lastMsgSender: row.lastMsgSender,
          messagesYesterday: [{
            sender: row.lastMsgSender || "?",
            text: row.lastMsgText,
            timestamp: row.lastMsgTime,
            isSender: row.outbound,
          }],
        })),
        { isFromHub: true }
      );
      return res.json({
        ok: true,
        source: "hub-fresh",
        yesterdayLabel: window.label,
        dataDate: window.label,
        freshestEditISO,
        groups,
        totalChats: yesterdayRows.length,
      });
    }

    // No yesterday rows — return stalest fallback with date metadata
    if (stalestFallbackRows.length > 0) {
      // Compute date label from freshest edit
      let staleDateLabel = "unknown";
      if (freshestEditISO) {
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Prague",
          year: "numeric", month: "2-digit", day: "2-digit",
        });
        const parts = fmt.formatToParts(new Date(freshestEditISO));
        const y = parts.find(p => p.type === "year").value;
        const m = parts.find(p => p.type === "month").value;
        const d = parts.find(p => p.type === "day").value;
        staleDateLabel = `${y}-${m}-${d}`;
      }

      const groups = groupChatsForRender(
        stalestFallbackRows.map(row => ({
          name: row.name,
          accountID: row.accountID,
          networkFull: row.networkFull,
          lastMsgText: row.lastMsgText,
          lastMsgSender: row.lastMsgSender,
          messagesYesterday: [{
            sender: row.lastMsgSender || "?",
            text: row.lastMsgText,
            timestamp: row.lastMsgTime,
            isSender: row.outbound,
          }],
        })),
        { isFromHub: true }
      );
      return res.json({
        ok: true,
        source: "hub-stale",
        yesterdayLabel: window.label,
        dataDate: staleDateLabel,
        freshestEditISO,
        groups,
        totalChats: stalestFallbackRows.length,
      });
    }

    // No data at all
    return res.json({
      ok: true,
      source: "hub-empty",
      yesterdayLabel: window.label,
      dataDate: null,
      freshestEditISO,
      groups: [],
      totalChats: 0,
    });
  } catch (hubErr) {
    return res.status(500).json({
      error: "both beeper and hub failed",
      hubError: hubErr.message,
    });
  }
});

module.exports = router;
