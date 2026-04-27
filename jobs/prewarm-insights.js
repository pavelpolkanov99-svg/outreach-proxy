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

// Insights polling — caller-side. Allow up to 3 minutes for Parallel to
// produce bullets. Some companies (Monerium, slow research targets) need
// longer than the 90s default of /parallel/insights-bullets.
const INSIGHTS_POLL_TIMEOUT_MS = 180_000;
const INSIGHTS_AXIOS_TIMEOUT_MS = 200_000;

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

function tierToPriority(tier) {
  if (tier === "MH") return "High";
  if (tier === "P1") return "High";
  if (tier === "P2") return "Mid";
  if (tier === "P3") return "Low";
  return null;
}

function needsInsightRefresh(notionCompany) {
  if (!notionCompany?.insight) return true;
  if (!notionCompany.insight.refreshedAt) return true;
  const ts = Date.parse(notionCompany.insight.refreshedAt);
  if (isNaN(ts)) return true;
  const ageMs = Date.now() - ts;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays >= INSIGHT_STALE_DAYS;
}

async function fetchCalendarForOffset(dayOffset) {
  const now = new Date();
  const targetDate = new Date(now);
  targetDate.setDate(now.getDate() + dayOffset);

  const yyyy = targetDate.getFullYear();
  const mm   = String(targetDate.getMonth() + 1).padStart(2, "0");
  const dd   = String(targetDate.getDate()).padStart(2, "0");
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

function pickPrimaryAttendee(event) {
  const attendees = event.attendees || [];
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
  const startRes = await axios.post(
    `${PROXY_BASE}/parallel/research/start`,
    { company, domain, processor: "lite" },
    { timeout: 20000 }
  );
  const taskId = startRes.data?.taskId;
  if (!taskId) throw new Error(`Parallel scoring: no taskId for ${company}`);

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

// Run /parallel/insights-bullets for a company with extended polling timeout.
async function runInsightsBullets(company, domain) {
  const r = await axios.post(
    `${PROXY_BASE}/parallel/insights-bullets`,
    { company, domain, timeoutMs: INSIGHTS_POLL_TIMEOUT_MS },
    { timeout: INSIGHTS_AXIOS_TIMEOUT_MS }
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
    const resolved = await resolveCompanyName({
      meetingTitle: summary,
      attendeeEmail: attendee.email,
    });

    let companyName  = resolved.canonicalName;
    let apolloOrg    = resolved.apolloOrg;

    if (!apolloOrg && APOLLO_KEY) {
      apolloOrg = await apolloOrgEnrich(domain);
      if (!companyName && apolloOrg?.name) companyName = apolloOrg.name;
    }

    if (!companyName) {
      const stem = domain.split(".")[0];
      companyName = stem.charAt(0).toUpperCase() + stem.slice(1);
    }

    let apolloPerson = null;
    if (APOLLO_KEY) {
      apolloPerson = await apolloPersonEnrich({ email: attendee.email });
    }

    const scoring = await runParallelScoring({ company: companyName, domain });

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
      status:      "initial discussions",
    };

    const priority = tierToPriority(scoring.tier);
    if (priority) companyProps.priority = priority;

    Object.keys(companyProps).forEach(k => {
      if (companyProps[k] === null || companyProps[k] === undefined) delete companyProps[k];
    });

    await axios.post(
      `${PROXY_BASE}/notion/update-company-with-tags`,
      companyProps,
      { timeout: 20000 }
    );

    let personName = attendee.name;
    if (!personName && apolloPerson?.name) personName = apolloPerson.name;
    if (!personName) {
      const local = attendee.email.split("@")[0];
      const parts = local.split(/[._-]/).filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1));
      personName = parts.join(" ") || local;
    }

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

  const candidates = events.filter(ev => !ev.isInternal);
  console.log(`[prewarm] ${candidates.length} candidates after dropping internal-only`);

  const results = await processWithLimit(candidates, 3, ev => processOneEvent(ev, { dryRun }));

  const stats = {
    total: candidates.length,
    skipped:        results.filter(r => r.action === "skip").length,
    refreshed:      results.filter(r => r.action === "refresh-insight").length,
    created:        results.filter(r => r.action === "create-company").length,
    wouldRefresh:   results.filter(r => r.action === "would-refresh-insight").length,
    wouldCreate:    results.filter(r => r.action === "would-create-company").length,
    errors:         results.filter(r => r.action === "error").length,
  };

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
  cron.schedule("0 23 * * *", async () => {
    console.log("[cron] prewarm-insights (tomorrow) start");
    try {
      await runPrewarmInsights({ dayOffset: 1, dryRun: false });
    } catch (err) {
      console.error(`[cron] prewarm-insights tomorrow failed: ${err.message}`);
    }
  }, { timezone: "Europe/Prague" });
  console.log("[cron] prewarm-insights registered (23:00 Europe/Prague — tomorrow)");

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
