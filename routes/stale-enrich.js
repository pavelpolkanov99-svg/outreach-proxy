const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  NOTION_COMPANIES_DB,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

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

// Patterns that indicate a Notes block is sync-system boilerplate, not real
// human-written deal activity. Anton called these out specifically as noise:
// "═══ ENRICHMENT REPORT", "Email evidence: ...".
//
// A block is "boilerplate" if EVERY meaningful line in it matches one of
// these patterns. If the block has even one real content line, we keep it.
const BOILERPLATE_LINE_PATTERNS = [
  /^═+/,                                 // separator lines
  /ENRICHMENT REPORT/i,
  /^📊\s*ENRICHMENT/i,
  /^Email evidence:/i,                   // sinker email-evidence prefix
  /^Stage set to /i,                     // sinker auto-stage messages
  /^\(no messages\)$/i,
];

function isBoilerplateLine(line) {
  const t = line.trim();
  if (!t) return false;
  return BOILERPLATE_LINE_PATTERNS.some(re => re.test(t));
}

function isBoilerplateBlock(block) {
  const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  // If every meaningful line matches a boilerplate pattern, block is noise.
  // Allow 1 non-matching short line (e.g. "Stage: Warm discussions").
  const nonBoiler = lines.filter(l => !isBoilerplateLine(l));
  if (nonBoiler.length === 0) return true;
  // If only non-boiler lines are very short metadata (< 12 chars), still noise
  if (nonBoiler.every(l => l.length < 12)) return true;
  return false;
}

// Extract a useful one-line snippet from the Notes field. Walks blocks from
// newest to oldest, skipping sync-system boilerplate, and returns the first
// real human-written content found.
function extractNotesSnippet(notesRaw) {
  if (!notesRaw || !notesRaw.trim()) return null;

  // append-note convention: blocks separated by "\n---\n", most recent at END.
  const blocks = notesRaw.split(/\n---\n/).map(b => b.trim()).filter(Boolean);

  // Walk from newest (end) to oldest, find first non-boilerplate block.
  let chosenBlock = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!isBoilerplateBlock(blocks[i])) {
      chosenBlock = blocks[i];
      break;
    }
  }
  // If everything looks like boilerplate, fall back to most recent block —
  // showing a degraded snippet beats showing nothing.
  if (!chosenBlock && blocks.length > 0) {
    chosenBlock = blocks[blocks.length - 1];
  }
  if (!chosenBlock) return null;

  const meaningfulLines = chosenBlock
    .split("\n")
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      // Drop sync metadata header lines
      if (/^[📱💼📞🕐📅]\s/.test(l)) return false;
      if (/^Synced:/i.test(l)) return false;
      if (/^\(no messages\)$/i.test(l)) return false;
      // Drop boilerplate lines individually too (in case mixed-content block)
      if (isBoilerplateLine(l)) return false;
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
