const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

const MESSAGES_HUB_DB     = "8617a441c4254b41be671a1e65946a03";
const NOTION_COMPANIES_DB = "f9b59c5b05fa4df18f9569479633fd74";

// Internal sender heuristics — same regex used in beeper/replies-waiting
const INTERNAL_SENDER_REGEX = /(anton ceo|antón|^антон$|^pavel|polkanov|@pavel-remide:beeper\.com|titov|anton t)/i;

function isInternalSenderText(s) {
  if (!s) return false;
  return INTERNAL_SENDER_REGEX.test(s);
}

// Try to figure out if the last message in a Hub row was sent by Anton/Pavel.
// The Hub stores `Raw Sender Name` for many rows but not all. Fall back to
// `Participants` parsing or returning false (= treat as inbound) which is safer
// for the digest (we'd rather show a slightly off chat than miss one).
function hubRowIsOutbound(props) {
  const rawSender = (props["Raw Sender Name"]?.rich_text || [])
    .map(rt => rt.plain_text || rt.text?.content || "").join("");
  if (rawSender) return isInternalSenderText(rawSender);
  return false;
}

// Resolve linked company name from Link: Companies relation. Returns the first
// linked Company's title, or null. Bounded fetch (timeout 4s) per row.
async function resolveLinkedCompany(relationArr) {
  if (!Array.isArray(relationArr) || relationArr.length === 0) return null;
  const id = relationArr[0]?.id;
  if (!id) return null;
  try {
    const r = await axios.get(`https://api.notion.com/v1/pages/${id}`, {
      headers: notionHeaders(),
      timeout: 4000,
    });
    const props = r.data.properties || {};
    const titleArr = props["Company name"]?.title || [];
    const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");
    const stage = props["Stage"]?.status?.name || null;
    const bdScore = props["BD Score"]?.number ?? null;
    const priority = props["Priority"]?.select?.name || null;
    return { name: name || null, stage, bdScore, priority };
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /messaging-hub/replies-waiting
//
// Reads from Notion Messaging Hub DB instead of Beeper. Used as the fallback
// when Beeper desktop is offline (e.g. Pavel's laptop closed).
//
// Filter: Status=Active, Last edited time within `days` (default 7).
// Strips internal-sender-only rows (where Anton sent last). Sorts by
// last_edited_time descending so freshest replies show first.
//
// Note: Hub data is only as fresh as the last successful Beeper sync. The
// caller (bot) should add a "data may be stale" disclaimer when serving
// from this fallback.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/replies-waiting", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const days  = Math.max(1, Math.min(30, parseInt(req.query.days,  10) || 7));
  const limit = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 15));
  const hoursIdle = Math.max(0.5, Math.min(168, parseFloat(req.query.hoursIdle) || 4));

  const cutoffISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const idleCutoffMs = Date.now() - hoursIdle * 60 * 60 * 1000;

  try {
    const filter = {
      and: [
        { property: "Status", status: { equals: "Active" } },
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: cutoffISO },
        },
      ],
    };

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${MESSAGES_HUB_DB}/query`,
      {
        filter,
        sorts: [
          { timestamp: "last_edited_time", direction: "descending" },
        ],
        page_size: Math.min(limit * 3, 60), // overfetch for filtering
      },
      { headers: notionHeaders(), timeout: 10_000 }
    );

    // First pass — extract & cheap-filter
    const candidates = r.data.results.map(page => {
      const props = page.properties || {};
      const titleArr = props["Chat Name"]?.title || [];
      const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

      const lastMsgArr = props["Last Message"]?.rich_text || [];
      const lastMsgText = lastMsgArr.map(rt => rt.plain_text || rt.text?.content || "").join("").slice(0, 300);

      const networkArr = props["Network"]?.multi_select || [];
      const networkFull = networkArr[0]?.name || null;

      const participantsArr = props["Participants"]?.rich_text || [];
      const participants = participantsArr.map(rt => rt.plain_text || rt.text?.content || "").join("");

      const linkedCompaniesRel = props["Link: Companies"]?.relation || [];

      const lastEditedTime = page.last_edited_time;
      const lastActiveDate = props["Last Active"]?.date?.start || null;

      // Use Last Active if present (more accurate), else last_edited_time
      const effectiveTime = lastActiveDate || lastEditedTime;

      return {
        pageId: page.id,
        name,
        networkFull,
        lastMsgText,
        lastMsgSender: participants, // best approximation in Hub
        participants,
        lastMsgTime: effectiveTime,
        outbound: hubRowIsOutbound(props),
        linkedCompaniesRel,
      };
    });

    // Filter: drop outbound, drop empty, drop too-recent (less than hoursIdle ago)
    const filtered = candidates.filter(c => {
      if (c.outbound) return false;
      if (!c.lastMsgText || !c.lastMsgText.trim()) return false;
      if (!c.lastMsgTime) return false;
      const ts = Date.parse(c.lastMsgTime);
      if (isNaN(ts)) return false;
      if (ts > idleCutoffMs) return false; // too recent — Anton doesn't owe a reply yet
      // Drop internal chat rooms by name pattern
      if (/(remide\s*\|.*advisor|plexo\s*\|.*advisor|beeper developer|remide team|plexo team)/i.test(c.name)) return false;
      return true;
    });

    // Sort: oldest unanswered first (longest wait at top)
    filtered.sort((a, b) => Date.parse(a.lastMsgTime) - Date.parse(b.lastMsgTime));

    const top = filtered.slice(0, limit);

    // Resolve linked companies in parallel (bounded)
    const enriched = await Promise.all(top.map(async c => {
      const company = await resolveLinkedCompany(c.linkedCompaniesRel);
      const idleMs = Date.now() - Date.parse(c.lastMsgTime);
      const hoursIdleVal = Math.round(idleMs / (60 * 60 * 1000) * 10) / 10;

      // Visual tier: primary if linked to CRM company, else secondary
      const visualTier = company ? "primary" : "secondary";

      return {
        pageId: c.pageId,
        name: c.name,
        networkFull: c.networkFull,
        lastMsgText: c.lastMsgText,
        lastMsgSender: c.lastMsgSender,
        lastMsgTime: c.lastMsgTime,
        hoursIdle: hoursIdleVal,
        notion: company,
        visualTier,
        type: "single", // Hub doesn't reliably track group/single — default single
      };
    }));

    res.json({
      ok: true,
      source: "messaging-hub",
      hoursIdle,
      cutoffISO,
      total: enriched.length,
      replies: enriched,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

module.exports = router;
