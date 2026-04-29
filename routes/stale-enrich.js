const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  NOTION_COMPANIES_DB,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// /notion/stale-deals-enriched
//
// Wraps GET /notion/stale-deals and adds a `lastActivitySnippet` field to each
// deal — the most recent meaningful note from the Notes field on the company
// page. This is what's shown in the digest as "Нет активности 25д · <snippet>"
// so Anton sees what the last action actually WAS on the deal.
//
// Implementation:
//   1) Re-runs the stale-deals query (same filter as routes/notion.js
//      :stale-deals — duplicated here on purpose to avoid an internal HTTP
//      hop and to keep this module self-contained).
//   2) For each result, parses the Notes rich_text field and extracts the
//      most recent meaningful block. Uses the same "\n---\n" separator
//      convention that /notion/append-note writes with.
//
// Returns same shape as /stale-deals plus `lastActivitySnippet` per deal.
// ─────────────────────────────────────────────────────────────────────────────

const STALE_DEFAULT_DAYS = 14;
const STALE_DEFAULT_LIMIT = 5;

const STALE_ACTIVE_STAGES = [
  "Communication Started",
  "Call Scheduled",
  "initial discussions",
  "Keeping in the Loop",
  "Warm discussions",
  "Negotiations",
];

// Extract a useful one-line snippet from the Notes field. Drops sync-header
// boilerplate ("📱 LinkedIn DM: Foo", "🕐 Synced: ...") and takes the first
// real content line(s).
function extractNotesSnippet(notesRaw) {
  if (!notesRaw || !notesRaw.trim()) return null;

  // append-note convention: blocks separated by "\n---\n", most recent at END.
  const blocks = notesRaw.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
  const lastBlock = blocks[blocks.length - 1] || "";

  const meaningfulLines = lastBlock
    .split("\n")
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      // Drop sync metadata header lines
      if (/^[📱💼📞🕐📅]\s/.test(l)) return false;
      if (/^Synced:/i.test(l)) return false;
      if (/^\(no messages\)$/i.test(l)) return false;
      // Drop bracketed timestamps "[28.04.2025, 14:23] ←" style line prefixes
      // by keeping only what's after the bracket+arrow
      return true;
    });

  // Some notes have "[date] ← Sender: text" format from beeper-sync.
  // Strip the date+sender prefix to get just the message text.
  const cleaned = meaningfulLines.map(l => {
    const m = l.match(/^\[[^\]]+\]\s*[←→]?\s*[^:]+:\s*(.+)$/);
    return m ? m[1] : l;
  });

  const candidate = cleaned.slice(0, 2).join(" ").trim();
  if (candidate.length < 6) return null;

  return candidate.length > 140
    ? candidate.slice(0, 137) + "..."
    : candidate;
}

// Re-implementation of /stale-deals query but with Notes-snippet extraction.
router.get("/stale-deals-enriched", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const days  = Math.max(1, Math.min(365, parseInt(req.query.days,  10) || STALE_DEFAULT_DAYS));
  const limit = Math.max(1, Math.min(50,  parseInt(req.query.limit, 10) || STALE_DEFAULT_LIMIT));

  const cutoffMs  = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();

  try {
    const filter = {
      and: [
        {
          or: STALE_ACTIVE_STAGES.map(stage => ({
            property: "Stage",
            status:   { equals: stage },
          })),
        },
        {
          timestamp: "last_edited_time",
          last_edited_time: { before: cutoffISO },
        },
        {
          or: [
            { property: "Priority", select: { equals: "High" } },
            { property: "Priority", select: { equals: "Mid"  } },
          ],
        },
      ],
    };

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      {
        filter,
        sorts: [
          { timestamp: "last_edited_time", direction: "ascending" },
        ],
        page_size: limit,
      },
      { headers: notionHeaders(), timeout: 12_000 }
    );

    const deals = r.data.results.map(page => {
      const props = page.properties || {};

      const titleArr = props["Company name"]?.title || [];
      const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

      const tags = (props["Tags"]?.multi_select || []).map(t => t.name);

      const editedISO = page.last_edited_time;
      const editedTs  = Date.parse(editedISO);
      const daysStale = isNaN(editedTs)
        ? null
        : Math.floor((Date.now() - editedTs) / (24 * 60 * 60 * 1000));

      const notesRaw = (props["Notes"]?.rich_text || [])
        .map(rt => rt.plain_text || rt.text?.content || "").join("");
      const lastActivitySnippet = extractNotesSnippet(notesRaw);

      return {
        pageId: page.id,
        url: page.url,
        name,
        bdScore: props["BD Score"]?.number ?? null,
        stage: props["Stage"]?.status?.name || null,
        priority: props["Priority"]?.select?.name || null,
        pipeline: props["Pipeline"]?.select?.name || null,
        tags,
        lastContact: props["Last Contact"]?.date?.start || null,
        lastEditedTime: editedISO,
        daysStale,
        lastActivitySnippet,
      };
    });

    res.json({
      ok: true,
      cutoffDays: days,
      cutoffISO,
      total: deals.length,
      deals,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

module.exports = router;
