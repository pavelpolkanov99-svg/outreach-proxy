/**
 * Discovery Card Digest
 * ---------------------
 * GET  /discovery/digest          — build & return digest payload
 * POST /discovery/snapshot/sync   — force snapshot refresh (no digest)
 */

"use strict";

const express = require("express");
const axios   = require("axios");
const { NOTION_TOKEN, notionHeaders } = require("../lib/notion");

const router = express.Router();

const DISCOVERY_CARDS_DB = "ec737e56-4972-4ef8-9819-1235c51582ce";
const STATE_DB_TITLE     = "Loop OS · Discovery Snapshots";
const PING_STALE_DAYS    = 7;
const PING_TOP_N         = 15;

// Statuses to exclude from ping list — not actionable
const SKIP_STATUSES = new Set([
  "Later", "later",
  "Not Relevant", "Not relevant", "not relevant",
  "Completed", "completed", "Done", "done",
  "Rejected", "rejected",
]);

function shouldSkipForPing(status) {
  if (!status) return false;
  return SKIP_STATUSES.has(status) || /later|not.?relevant|completed|done|rejected/i.test(status);
}

// ── Notion helpers ────────────────────────────────────────────────────────────

async function notionGet(url, params = {}) {
  const r = await axios.get(url, { headers: notionHeaders(), params, timeout: 15000 });
  return r.data;
}
async function notionPost(url, body) {
  const r = await axios.post(url, body, { headers: notionHeaders(), timeout: 15000 });
  return r.data;
}
async function notionPatch(url, body) {
  const r = await axios.patch(url, body, { headers: notionHeaders(), timeout: 15000 });
  return r.data;
}
function rt(text) {
  return { rich_text: [{ text: { content: String(text || "").slice(0, 2000) } }] };
}

// ── State DB management ───────────────────────────────────────────────────────

let _stateDbId = process.env.DISCOVERY_STATE_DB_ID || null;

async function getOrCreateStateDb(parentPageId) {
  if (_stateDbId) return _stateDbId;
  try {
    const r = await notionPost("https://api.notion.com/v1/search", {
      query: STATE_DB_TITLE,
      filter: { value: "database", property: "object" },
      page_size: 5,
    });
    const found = (r.results || []).find(d =>
      (d.title || []).map(t => t.plain_text || "").join("") === STATE_DB_TITLE
    );
    if (found) { _stateDbId = found.id; return _stateDbId; }
  } catch (e) { console.warn("[discovery] search state DB failed:", e.message); }

  if (!parentPageId) { console.warn("[discovery] No parentPageId — skipping snapshot writes"); return null; }

  const db = await notionPost("https://api.notion.com/v1/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: STATE_DB_TITLE } }],
    properties: {
      "Name":          { title: {} },
      "card_id":       { rich_text: {} },
      "company":       { rich_text: {} },
      "last_edited":   { rich_text: {} },
      "snapshot_at":   { rich_text: {} },
      "fill_score":    { number: {} },
      "sections_json": { rich_text: {} },
      "bd_score":      { number: {} },
    },
  });
  _stateDbId = db.id;
  console.log(`[discovery] State DB created: ${_stateDbId}`);
  return _stateDbId;
}

// ── Fetch all Discovery Cards ─────────────────────────────────────────────────

async function fetchAllDiscoveryCards() {
  const cards = [];
  let cursor;
  do {
    const body = {
      filter: { property: "Document Type", select: { equals: "Discovery Card" } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const r = await notionPost(`https://api.notion.com/v1/databases/${DISCOVERY_CARDS_DB}/query`, body);
    for (const page of r.results) {
      const props = page.properties || {};
      const docTitle = (props["Document"]?.title || []).map(t => t.plain_text || t.text?.content || "").join("");
      const company = docTitle.replace(/^Discovery Card\s*\|\s*/i, "").trim();
      if (!company || /dummy|template|example/i.test(company)) continue;
      const crmRelation = (props["CRM Company"]?.relation || [])[0]?.id || null;
      const status = props["Status"]?.status?.name || null;
      cards.push({ id: page.id, company, last_edited_time: page.last_edited_time, status, crmCompanyId: crmRelation });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return cards;
}

// ── Snapshot read/write ───────────────────────────────────────────────────────

async function readSnapshot(stateDbId, cardId) {
  if (!stateDbId) return null;
  try {
    const r = await notionPost(`https://api.notion.com/v1/databases/${stateDbId}/query`, {
      filter: { property: "card_id", rich_text: { equals: cardId } },
      page_size: 1,
    });
    const page = r.results?.[0];
    if (!page) return null;
    const props = page.properties || {};
    const get = (key) => (props[key]?.rich_text || []).map(t => t.plain_text || "").join("");
    return {
      snapshotPageId: page.id,
      card_id:        get("card_id"),
      company:        get("company"),
      last_edited:    get("last_edited"),
      snapshot_at:    get("snapshot_at"),
      fill_score:     props["fill_score"]?.number ?? null,
      sections_json:  get("sections_json"),
      bd_score:       props["bd_score"]?.number ?? null,
    };
  } catch (e) { console.warn(`[discovery] readSnapshot(${cardId}) failed:`, e.message); return null; }
}

async function writeSnapshot(stateDbId, { snapshotPageId, cardId, company, last_edited, fill_score, sections_json, bd_score }) {
  if (!stateDbId) return;
  const now = new Date().toISOString();
  const props = {
    "Name":          { title: [{ text: { content: `snap_${cardId.replace(/-/g, "").slice(0, 12)}` } }] },
    "card_id":       rt(cardId),
    "company":       rt(company),
    "last_edited":   rt(last_edited || ""),
    "snapshot_at":   rt(now),
    "fill_score":    { number: fill_score ?? 0 },
    "sections_json": rt(sections_json || "[]"),
    "bd_score":      { number: bd_score ?? 0 },
  };
  try {
    if (snapshotPageId) {
      await notionPatch(`https://api.notion.com/v1/pages/${snapshotPageId}`, { properties: props });
    } else {
      await notionPost("https://api.notion.com/v1/pages", { parent: { database_id: stateDbId }, properties: props });
    }
  } catch (e) { console.warn(`[discovery] writeSnapshot(${cardId}) failed:`, e.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchFillScore(cardId) {
  const PROXY_BASE = process.env.PROXY_URL || `http://localhost:${process.env.PORT || 3000}`;
  try {
    const r = await axios.get(`${PROXY_BASE}/notion/discovery-card-fill/${cardId}`, { timeout: 30000 });
    return r.data;
  } catch (e) { console.warn(`[discovery] fetchFillScore(${cardId}) failed:`, e.message); return null; }
}

async function fetchBdScore(crmCompanyId) {
  if (!crmCompanyId) return null;
  try {
    const r = await notionGet(`https://api.notion.com/v1/pages/${crmCompanyId}`);
    return r.properties?.["BD Score"]?.number ?? null;
  } catch { return null; }
}

function parseSectionsJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sectionsDelta(oldSections, newSections) {
  if (!newSections) return [];
  const result = [];
  for (const sec of newSections) {
    if (sec.filled === 0) continue;
    const old = oldSections ? oldSections.find(s => s.name === sec.name) : null;
    const oldFilled = old?.filled ?? 0;
    if (sec.filled > oldFilled) {
      result.push({
        name:      sec.name,
        oldFilled,
        newFilled: sec.filled,
        newTotal:  sec.total,
        fillPct:   sec.total > 0 ? Math.round(sec.filled / sec.total * 100) : 0,
      });
    }
  }
  return result;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const ms = Date.now() - Date.parse(isoDate);
  if (isNaN(ms)) return null;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function tierLabel(bdScore) {
  if (bdScore == null) return null;
  if (bdScore >= 7.5) return `P1 · ${bdScore}`;
  if (bdScore >= 5.0) return `P2 · ${bdScore}`;
  return `P3 · ${bdScore}`;
}

// ── Main digest builder ───────────────────────────────────────────────────────

async function buildDigest(stateDbId) {
  const cards = await fetchAllDiscoveryCards();
  const now = new Date().toISOString();

  const changed  = [];
  const pingList = [];

  await Promise.all(cards.map(async (card) => {
    const snapshot = await readSnapshot(stateDbId, card.id);

    let fillData = null;
    let newSectionsJson = snapshot?.sections_json || null;
    let bdScore = snapshot?.bd_score ?? null;

    if (bdScore == null && card.crmCompanyId) {
      bdScore = await fetchBdScore(card.crmCompanyId);
    }

    const lastEditedChanged = !snapshot || snapshot.last_edited !== card.last_edited_time;
    if (lastEditedChanged) {
      fillData = await fetchFillScore(card.id);
      if (fillData?.ok) {
        newSectionsJson = JSON.stringify(fillData.sections.map(s => ({ name: s.name, filled: s.filled, total: s.total })));
      }
    }

    if (lastEditedChanged && fillData?.ok) {
      const oldSecs = parseSectionsJson(snapshot?.sections_json);
      const delta = sectionsDelta(oldSecs, fillData.sections);
      if (delta.length > 0) {
        changed.push({ company: card.company, delta, fillPct: fillData.fillPct, bdScore, status: card.status });
      }
    }

    // Ping list: stale > PING_STALE_DAYS, skip Later / Not Relevant / Completed
    const staleDays = daysSince(card.last_edited_time);
    if (!shouldSkipForPing(card.status) && staleDays != null && staleDays > PING_STALE_DAYS) {
      pingList.push({ company: card.company, staleDays, status: card.status, bdScore });
    }

    await writeSnapshot(stateDbId, {
      snapshotPageId: snapshot?.snapshotPageId || null,
      cardId:         card.id,
      company:        card.company,
      last_edited:    card.last_edited_time,
      fill_score:     fillData?.totalFilled ?? snapshot?.fill_score ?? 0,
      sections_json:  newSectionsJson,
      bd_score:       bdScore,
    });
  }));

  changed.sort((a, b) => (b.bdScore ?? 0) - (a.bdScore ?? 0));
  pingList.sort((a, b) => {
    if ((b.bdScore ?? 0) !== (a.bdScore ?? 0)) return (b.bdScore ?? 0) - (a.bdScore ?? 0);
    return (b.staleDays ?? 0) - (a.staleDays ?? 0);
  });

  return {
    ok: true,
    asOf: now,
    totalCards: cards.length,
    changed,
    pingList: pingList.slice(0, PING_TOP_N),
    pingTotal: pingList.length,
  };
}

// ── Format Telegram message ───────────────────────────────────────────────────

function formatDigestTelegram({ asOf, totalCards, changed, pingList, pingTotal }) {
  const dateStr = new Date(asOf).toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", timeZone: "Europe/Prague",
  });

  const lines = [`📋 <b>Discovery Cards · ${dateStr}</b>`, ""];

  lines.push("━━━ 🟢 АКТИВНОСТЬ ━━━");
  if (changed.length === 0) {
    lines.push("<i>Изменений нет</i>");
  } else {
    for (const c of changed) {
      const tier = tierLabel(c.bdScore);
      const tierStr = tier ? ` [${tier}]` : "";
      const totalPct = c.fillPct != null ? ` · ${c.fillPct}% заполнено` : "";
      lines.push(`\n<b>${c.company}</b>${tierStr}${totalPct}`);
      for (const sec of c.delta) {
        const secName = sec.name.replace(/^\d+[a-z]?\.\s*/i, "");
        const deltaStr = sec.oldFilled > 0 ? ` (+${sec.newFilled - sec.oldFilled})` : "";
        lines.push(`  ✓ ${secName} — ${sec.newFilled}/${sec.newTotal} полей${deltaStr}`);
      }
    }
  }

  lines.push("");
  lines.push("━━━ 🔴 НУЖНО ПИНГАНУТЬ ━━━");
  lines.push(`<i>Не было активности >${PING_STALE_DAYS} дней · топ-${PING_TOP_N} по score</i>`);
  lines.push("");

  if (pingList.length === 0) {
    lines.push("<i>Все карточки активны</i>");
  } else {
    pingList.forEach((c, i) => {
      const tier = tierLabel(c.bdScore);
      const tierStr = tier ? ` [${tier}]` : "";
      lines.push(`${i + 1}. <b>${c.company}</b>${tierStr} — ${c.staleDays}д тишины`);
    });
    const extra = pingTotal - PING_TOP_N;
    if (extra > 0) {
      lines.push(`\n<i>+ ещё ${extra} карточек в ожидании · всего: ${totalCards}</i>`);
    } else {
      lines.push(`\n<i>Всего карточек: ${totalCards}</i>`);
    }
  }

  return lines.join("\n");
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/digest", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const parentPageId = process.env.DISCOVERY_STATE_PARENT_PAGE_ID || null;
  try {
    const stateDbId = await getOrCreateStateDb(parentPageId);
    const digest    = await buildDigest(stateDbId);
    const telegram  = formatDigestTelegram(digest);
    res.json({ ...digest, telegram });
  } catch (err) {
    console.error("[discovery/digest] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/snapshot/sync", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const parentPageId = process.env.DISCOVERY_STATE_PARENT_PAGE_ID || null;
  try {
    const stateDbId = await getOrCreateStateDb(parentPageId);
    const cards     = await fetchAllDiscoveryCards();
    let updated = 0;
    for (const card of cards) {
      const snapshot = await readSnapshot(stateDbId, card.id);
      const bdScore  = snapshot?.bd_score ?? await fetchBdScore(card.crmCompanyId);
      const fillData = await fetchFillScore(card.id);
      if (fillData?.ok) {
        const sections_json = JSON.stringify(fillData.sections.map(s => ({ name: s.name, filled: s.filled, total: s.total })));
        await writeSnapshot(stateDbId, {
          snapshotPageId: snapshot?.snapshotPageId || null,
          cardId:         card.id,
          company:        card.company,
          last_edited:    card.last_edited_time,
          fill_score:     fillData.totalFilled,
          sections_json,
          bd_score:       bdScore,
        });
        updated++;
      }
    }
    res.json({ ok: true, total: cards.length, updated });
  } catch (err) {
    console.error("[discovery/snapshot/sync] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
