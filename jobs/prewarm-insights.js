// jobs/prewarm-insights.js
// ─────────────────────────────────────────────────────────────────────────────
// Loop's overnight CRM hygiene cron.
//
// Reads tomorrow's calendar (or today's, on the 08:00 catchup run) and for
// each external meeting either refreshes the Insight cache (Hit) or runs the
// full BD scoring + create-Company-Person pipeline (Miss).
//
// Designed to run server-side inside outreach-proxy. All HTTP calls go
// through localhost (PROXY_BASE) so the job stays decoupled from MCP tools.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const axios   = require("axios");
const cron    = require("node-cron");
const {
  resolveCompanyName,
  apolloOrgEnrich,
  apolloPersonEnrich,
  normalizeDomain,
} = require("../lib/loop-resolve");

const router = express.Router();

const PORT       = process.env.PORT || 3000;
const PROXY_BASE = process.env.PROXY_BASE || `http://127.0.0.1:${PORT}`;
const APOLLO_KEY = process.env.APOLLO_KEY;

// Personal email providers — never auto-CRM-sync these
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "ymail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "pm.me",
  "aol.com",
  "gmx.com", "gmx.net", "gmx.de",
  "mail.ru", "yandex.ru", "ya.ru",
]);

const INSIGHT_STALE_DAYS = 7;

let lastRunAt   = null;
let lastRunStats = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Map BD scoring tier → Notion Priority field
function tierToPriority(tier) {
  if (tier === "MH") return "High";
  if (tier === "P1") return "High";  // Both MH and P1 go to High in Notion
  if (tier === "P2") return "Mid";
  if (tier === "P3") return "Low";
  return null;  // Hard Kill — no priority
}

// Determine if Notion Insight needs a refresh
function needsInsightRefresh(notionCompany) {
  if (!notionCompany?.insight) return true;
  if (!notionCompany.insight.refreshedAt) return true;
  const ts = Date.parse(notionCompany.insight.refreshedAt);
  if (isNaN(ts)) return true;
  const ageMs = Date.now() - ts;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays >= INSIGHT_STALE_DAYS;
}

// Get tomorrow / today calendar events via /calendar/range
async function fetchCalendarForOffset(dayOffset) {
  const now = new Date();
  const targetDate = new Date(now);
  targetDate.setDate(now.getDate() + dayOffset);

  // Build [00:00 Prague, 24:00 Prague] of target day in UTC
  const yyyy = targetDate.getFullYear();
  const mm   = String(targetDate.getMonth() + 1).padStart(2, "0");
  const dd   = String(targetDate.getDate()).padStart(2, "0");
  // Use noon-anchored TZ math (DST-safe, mirroring routes/calendar.js)
  const noon = Date.UTC(yyyy, targetDate.getMonth(), targetDate.getDate(), 12, 0, 0);
  const noonInTz = new Date(noon).toLocaleString("en-US", { timeZone: "Europe/Prague" });
  const noonAsUtc = new Date(noonInTz + " UTC").getTime();
  const tzOffsetMs = noonAsUtc - noon;

  const startUtcMs = Date.UTC(yyyy, targetDate.getMonth(), targetDate.getDate(), 0, 0, 0) - tzOffsetMs;
  const endUtcMs   = startUtcMs + 24 * 60 * 60 * 1000;

  const timeMin = new Date(startUtcMs).toISOString();
  const timeMax = new Date(endUtcMs).toISOString();

  const r = await axios.get(`${PROXY_BASE}/calendar/range`, {
    params: { timeMin, timeMax, timeZone: "Europe/Prague" },
    timeout: 20000,
  });
  return { events: r.data?.events || [], date: `${yyyy}-${mm}-${dd}` };
}

// Pick the primary external attendee from a calendar event.
// Returns { email, name } or null if all attendees are internal.
function pickPrimaryAttendee(event) {
  const attendees = event.attendees || [];
  // attendees on /calendar/range payload are already filtered to externals by formatEvent
  // but we double-guard here in case raw events come in
  for (const a of attendees) {
    const email = (a.email || "").toLowerCase();
    if (!email) continue;
    const domain = email.split("@")[1];
    if (!domain) continue;
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) continue;
    return { email, name: a.name || null };
  }
  return null;
}

// Wait for a Parallel research task and return the compact scoring payload.
async function runParallelScoring({ company, domain }) {
  // Kick off the task (lite processor — sufficient for cron-time scoring)
  const startRes = await axios.post(
    `${PROXY_BASE}/parallel/research/start`,
    { company, domain, processor: "lite" },
    { timeout: 20000 }
  );
  const taskId = startRes.data?.taskId;
  if (!taskId) throw new Error(`Parallel scoring: no taskId for ${company}`);

  // Poll for completion (max 4 minutes — Parallel research lite usually 1-3 min)
  const startedAt = Date.now();
  const TIMEOUT_MS = 240_000;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await axios.get(`${PROXY_BASE}/parallel/result/${taskId}/compact`, { timeout: 15000 });
    if (r.data?.done && r.data?.compact) return r.data.compact;
    if (r.data?.failed) throw new Error(`Parallel scoring failed for ${company}`);
  }
  throw new Error(`Parallel scoring timeout (>${TIMEOUT_MS}ms) for ${company}`);
}

// Run /parallel/insights-bullets for a company
async function runInsightsBullets(company, domain) {
  const r = await axios.post(
    `${PROXY_BASE}/parallel/insights-bullets`,
    { company, domain },
    { timeout: 120_000 }
  );
  return {
    bullets: r.data?.bullets || [],
    refreshedAt: r.data?.refreshedAt || new Date().toISOString(),
    parallelTaskId: r.data?.parallelTaskId,
  };
}

// Write Insight field via /notion/update-insight
async function writeInsightToNotion({ pageId, name, bullets, refreshedAt }) {
  await axios.post(
    `${PROXY_BASE}/notion/update-insight`,
    { pageId, name, bullets, refreshedAt },
    { timeout: 15000 }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-event processing
// ─────────────────────────────────────────────────────────────────────────────

// Returns one of:
//   { action: "skip", reason }
//   { action: "refresh-insight", company, bullets }
//   { action: "create-company", company, person, scoring, bullets }
//   { action: "error", error }
async function processOneEvent(event, { dryRun = false } = {}) {
  const summary = event.summary || "(no title)";

  // 1. Pick primary external attendee
  const attendee = pickPrimaryAttendee(event);
  if (!attendee) {
    return { action: "skip", reason: "no-external-attendee", summary };
  }

  const domain = normalizeDomain(attendee.email.split("@")[1]);
  if (!domain) {
    return { action: "skip", reason: "no-domain", summary };
  }

  // 2. Notion lookup by domain
  let notionLookup;
  try {
    const r = await axios.get(`${PROXY_BASE}/notion/insight-by-domain`, {
      params: { domain },
      timeout: 15000,
    });
    notionLookup = r.data;
  } catch (err) {
    return { action: "error", error: `Notion lookup failed for ${domain}: ${err.message}`, summary };
  }

  // 3a. HIT — refresh insights if stale, else skip
  if (notionLookup?.found) {
    const company = notionLookup.company;
    if (!needsInsightRefresh(company)) {
      return { action: "skip", reason: "insight-fresh", summary, company: company.name };
    }

    if (dryRun) {
      return { action: "would-refresh-insight", summary, company: company.name };
    }

    try {
      const insights = await runInsightsBullets(company.name, domain);
      await writeInsightToNotion({
        pageId: company.pageId,
        bullets: insights.bullets,
        refreshedAt: insights.refreshedAt,
      });
      return { action: "refresh-insight", summary, company: company.name, bullets: insights.bullets };
    } catch (err) {
      return { action: "error", error: `Insight refresh failed for ${company.name}: ${err.message}`, summary };
    }
  }

  // 3b. MISS — full pipeline
  if (dryRun) {
    return { action: "would-create-company", summary, domain };
  }

  try {
    // (a) Resolve canonical name (cascade: title → Apollo → fallback to domain)
    const resolved = await resolveCompanyName({
      meetingTitle: summary,
      attendeeEmail: attendee.email,
    });

    let companyName  = resolved.canonicalName;
    let apolloOrg    = resolved.apolloOrg;

    // If title parsing succeeded but we didn't run Apollo yet — run Apollo
    // separately so we still get firmographics for Notion writeback.
    if (!apolloOrg && APOLLO_KEY) {
      apolloOrg = await apolloOrgEnrich(domain);
      if (!companyName && apolloOrg?.name) companyName = apolloOrg.name;
    }

    // Last-resort fallback: capitalize the domain stem
    if (!companyName) {
      const stem = domain.split(".")[0];
      companyName = stem.charAt(0).toUpperCase() + stem.slice(1);
    }

    // (b) Apollo person enrichment by email (gives us LinkedIn + title)
    let apolloPerson = null;
    if (APOLLO_KEY) {
      apolloPerson = await apolloPersonEnrich({ email: attendee.email });
    }

    // (c) Full BD scoring via Parallel (1-3 min)
    const scoring = await runParallelScoring({ company: companyName, domain });

    // (d) Build Notion Company props
    const isHardKill = scoring.tier === "Hard Kill";
    const tags = [];
    if (scoring.tier && !isHardKill) tags.push(scoring.tier);
    if (isHardKill && scoring.hk) tags.push(`Hard Kill - ${scoring.hk}`);
    if (scoring.strat) tags.push("Strategic Entrant");

    const companyProps = {
      name:        companyName,
      website:     apolloOrg?.website || `https://${domain}`,
      bd_score:    isHardKill ? 0 : scoring.score,
      description: apolloOrg?.description || null,
      industry:    apolloOrg?.industry || null,
      location:    apolloOrg?.location || null,
      tags,
      pipeline:    scoring.cat === "Partner" ? "Partnership" :
                   scoring.cat === "Client"  ? "Sales" : "Unsure",
      type:        scoring.cat === "Partner" ? "Partner" :
                   scoring.cat === "Client"  ? "Client" : null,
      communication_channel: "Email",
      source:      "Loop OS Auto-CRM Apr2026",
      status:      "initial discussions",  // Stage — only set on new entries
    };

    // Set priority only for non-Hard-Kill
    const priority = tierToPriority(scoring.tier);
    if (priority) companyProps.priority = priority;

    // Drop empty values to keep payload clean
    Object.keys(companyProps).forEach(k => {
      if (companyProps[k] === null || companyProps[k] === undefined) delete companyProps[k];
    });

    // (e) Write Company to Notion
    await axios.post(
      `${PROXY_BASE}/notion/update-company-with-tags`,
      companyProps,
      { timeout: 20000 }
    );

    // (f) Upsert Person — link to the new company
    let personName = attendee.name;
    if (!personName && apolloPerson?.name) personName = apolloPerson.name;
    if (!personName) {
      // Last resort: derive from email local part
      const local = attendee.email.split("@")[0];
      const parts = local.split(/[._-]/).filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1));
      personName = parts.join(" ") || local;
    }

    const personProps = {
      name:    personName,
      company: companyName,
      email:   attendee.email,
    };
    if (apolloPerson?.linkedin) personProps.linkedin = apolloPerson.linkedin;
    if (apolloPerson?.title)    personProps.title    = apolloPerson.title;

    await axios.post(
      `${PROXY_BASE}/notion/upsert-lead`,
      {
        firstName: personName.split(" ")[0],
        lastName:  personName.split(" ").slice(1).join(" "),
        title:     apolloPerson?.title || null,
        company:   companyName,
        companyWebsite: companyProps.website,
        linkedin:  apolloPerson?.linkedin || null,
        email:     attendee.email,
        status:    "initial discussions",
      },
      { timeout: 20000 }
    );

    // (g) Fetch insights and write to Notion (after Company exists)
    let insights = { bullets: [], refreshedAt: new Date().toISOString() };
    try {
      insights = await runInsightsBullets(companyName, domain);
      await writeInsightToNotion({
        name: companyName,
        bullets: insights.bullets,
        refreshedAt: insights.refreshedAt,
      });
    } catch (err) {
      console.error(`[prewarm] insights write failed for ${companyName}: ${err.message}`);
      // non-fatal — Company is already in CRM
    }

    return {
      action: "create-company",
      summary,
      company: companyName,
      person: personName,
      scoring: { tier: scoring.tier, score: scoring.score, hk: scoring.hk, category: scoring.cat },
      bullets: insights.bullets,
    };
  } catch (err) {
    return { action: "error", error: `Miss pipeline failed: ${err.message}`, summary };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency-limited runner
// ─────────────────────────────────────────────────────────────────────────────

async function processWithLimit(events, limit, processor) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (idx < events.length) {
      const myIdx = idx++;
      const ev = events[myIdx];
      try {
        const r = await processor(ev);
        results[myIdx] = r;
      } catch (err) {
        results[myIdx] = { action: "error", error: err.message, summary: ev.summary };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level job runner
// ─────────────────────────────────────────────────────────────────────────────

async function runPrewarmInsights({ dayOffset = 1, dryRun = false } = {}) {
  console.log(`[prewarm] start dayOffset=${dayOffset} dryRun=${dryRun}`);

  const { events, date } = await fetchCalendarForOffset(dayOffset);
  console.log(`[prewarm] ${events.length} events on ${date}`);

  // Filter to events that have at least one external attendee
  const candidates = events.filter(ev => !ev.isInternal);
  console.log(`[prewarm] ${candidates.length} candidates after dropping internal-only`);

  const results = await processWithLimit(candidates, 3, ev => processOneEvent(ev, { dryRun }));

  // Aggregate stats
  const stats = {
    total: candidates.length,
    skipped:        results.filter(r => r.action === "skip").length,
    refreshed:      results.filter(r => r.action === "refresh-insight").length,
    created:        results.filter(r => r.action === "create-company").length,
    wouldRefresh:   results.filter(r => r.action === "would-refresh-insight").length,
    wouldCreate:    results.filter(r => r.action === "would-create-company").length,
    errors:         results.filter(r => r.action === "error").length,
  };

  // Log details
  for (const r of results) {
    const tag = r.action.padEnd(20);
    const detail = r.action === "error" ? `ERR: ${r.error}` :
                   r.action === "skip"  ? r.reason :
                   r.company || r.summary;
    console.log(`[prewarm] ${tag} ${r.summary || ""} — ${detail}`);
  }

  lastRunAt    = new Date().toISOString();
  lastRunStats = { date, dayOffset, dryRun, stats, results };

  console.log(`[prewarm] done: ${JSON.stringify(stats)}`);
  return lastRunStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP routes (test / status)
// ─────────────────────────────────────────────────────────────────────────────

// POST /jobs/prewarm-insights/run — manual trigger
// Body: { dayOffset?: 0|1, dryRun?: boolean }
router.post("/prewarm-insights/run", async (req, res) => {
  const { dayOffset = 1, dryRun = false } = req.body || {};
  if (![0, 1, 2, 3, 7].includes(dayOffset)) {
    return res.status(400).json({ ok: false, error: "dayOffset must be 0, 1, 2, 3, or 7" });
  }
  try {
    const result = await runPrewarmInsights({ dayOffset, dryRun });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[prewarm] manual run failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /jobs/prewarm-insights/status
router.get("/prewarm-insights/status", (_req, res) => {
  res.json({
    ok: true,
    lastRunAt,
    lastRunStats,
    schedule: { atTomorrow: "0 23 * * *", atToday: "0 8 * * *", timezone: "Europe/Prague" },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron registration — invoked once at startup from index.js
// ─────────────────────────────────────────────────────────────────────────────

function registerJobs() {
  // 23:00 Europe/Prague — process tomorrow
  cron.schedule("0 23 * * *", async () => {
    console.log("[cron] prewarm-insights (tomorrow) start");
    try {
      await runPrewarmInsights({ dayOffset: 1, dryRun: false });
    } catch (err) {
      console.error(`[cron] prewarm-insights tomorrow failed: ${err.message}`);
    }
  }, { timezone: "Europe/Prague" });
  console.log("[cron] prewarm-insights registered (23:00 Europe/Prague — tomorrow)");

  // 08:00 Europe/Prague — process today (catches overnight additions)
  cron.schedule("0 8 * * *", async () => {
    console.log("[cron] prewarm-insights (today) start");
    try {
      await runPrewarmInsights({ dayOffset: 0, dryRun: false });
    } catch (err) {
      console.error(`[cron] prewarm-insights today failed: ${err.message}`);
    }
  }, { timezone: "Europe/Prague" });
  console.log("[cron] prewarm-insights registered (08:00 Europe/Prague — today)");
}

module.exports = { router, registerJobs, runPrewarmInsights };
