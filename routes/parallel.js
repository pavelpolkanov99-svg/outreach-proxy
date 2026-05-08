const express = require("express");
const axios   = require("axios");
const {
  PARALLEL_KEY,
  parallelHeaders,
  buildResearchQuery,
  parallelTaskSpec,
} = require("../lib/parallel");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// BD Scoring Framework v2.2 — formulas, Floor Rules, tier mapping
//
// v2.2 (May 8 2026, Anton's patches):
// - Removed bug: was dividing rawScore by 10, should be /17 (Client) or /14 (Partner)
// - Removed MH tier (was inflated). P1 ≥7.5 is the new top.
// - Apply UNKNOWN cap: UNKNOWN axes capped at 3
// - >3 UNKNOWN → "Manual Review" (no tier assigned)
// - Floor Rules as post-processor caps (G-1, G-2, G-3)
// - SE modifier band-locked (+0.5 max, cannot move P2→P1)
// - Apply correct Client vs Partner formula based on category
//
// v2.2.1 fixes (May 8 2026, after unit testing):
// - SE band-lock final guard: score 7.0 + SE no longer rounds up to 7.5
// - G-2 only applies to Client (Partner formula doesn't use axes 1,2)
// - Score < 3.0 → Skip (not P3 from phantom Floor Rule trigger)
//
// v2.2.2 schema fix (May 8 2026):
// - axes_meta is now a single 9-char string (was 9 separate fields)
//   to fit within Parallel's stability threshold (~18-19 props)
// - Position N in string = axis K where K = axes 1,2,3,4,5,6,7,8,10
// ─────────────────────────────────────────────────────────────────────────────

// Parse v2.2.2 axes_meta string "FFIFFFUFF" → map of axis index → label
function parseAxesMeta(metaStr) {
  const result = {};
  const axisOrder = [1, 2, 3, 4, 5, 6, 7, 8, 10]; // position 0..8 maps to these axes
  const labelMap = { F: "FACT", I: "INFERENCE", U: "UNKNOWN" };
  if (typeof metaStr !== "string") {
    // Fallback: treat all as INFERENCE (conservative)
    axisOrder.forEach(n => { result[n] = "INFERENCE"; });
    return result;
  }
  axisOrder.forEach((axisN, pos) => {
    const ch = metaStr[pos] || "I";
    result[axisN] = labelMap[ch.toUpperCase()] || "INFERENCE";
  });
  return result;
}

function buildCompactV22(c) {
  const a = (n) => Number(c[`axis${n}_score`]) || 0;
  // Parse compact axes_meta string into per-axis labels
  const metaMap = parseAxesMeta(c.axes_meta);
  const m = (n) => metaMap[n] || "INFERENCE";
  // capped axis: UNKNOWN → max 3
  const ac = (n) => m(n) === "UNKNOWN" ? Math.min(a(n), 3) : a(n);

  // Hard Kill — STOP early
  if (c.hk_triggered) {
    return {
      cat: c.category ?? null,
      role: c.network_role ?? null,
      hk: c.hk_criterion || true,
      score: 0,
      tier: "Hard Kill",
      axes: { 1: a(1), 2: a(2), 3: a(3), 4: a(4), 5: a(5), 6: a(6), 7: a(7), 8: a(8), 10: a(10) },
      axes_meta: { 1: m(1), 2: m(2), 3: m(3), 4: m(4), 5: m(5), 6: m(6), 7: m(7), 8: m(8), 10: m(10) },
      sources: c.top_sources ?? [],
      strat: null,
      ready: c.readiness ?? null,
      conf: c.confidence_level ?? null,
      unknown_count: 0,
      formula_used: "n/a (Hard Kill)",
      floor_rule_applied: null,
      se_applied: false,
    };
  }

  const isPartner = c.category === "Partner";
  let rawScore;
  let formula_used;
  if (isPartner) {
    rawScore = (ac(3) + ac(6) + ac(10)) * 3 + (ac(5) + ac(8)) * 2 + ac(4);
    rawScore = rawScore / 14;
    formula_used = "Partner /14";
  } else {
    rawScore = (ac(1) + ac(3) + ac(6)) * 3 + (ac(2) + ac(5) + ac(8)) * 2 + ac(4) + ac(7);
    rawScore = rawScore / 17;
    formula_used = "Client /17";
  }
  let score = Math.round(rawScore * 10) / 10;

  // Count UNKNOWN axes
  const allMeta = [m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8)];
  if (isPartner) allMeta.push(m(10));
  const unknownCount = allMeta.filter(v => v === "UNKNOWN").length;

  // Floor Rules (post-processor caps)
  let floorRule = null;
  if (ac(6) < 3) floorRule = "G-1 (License < 3)";
  if (!isPartner && ac(1) < 3 && ac(2) < 3) floorRule = "G-2 (XBorder<3 AND Ramp<3)";
  if (isPartner && ac(10) < 5) floorRule = "G-3 (PartnerFit < 5)";

  // Strategic Entrant — band-locked +0.5
  const seSignal = c.strategic_entrant_signal && c.strategic_entrant_signal !== "NOT APPLICABLE"
    ? c.strategic_entrant_signal : null;
  let seApplied = false;
  let scorePreSE = score;
  if (seSignal && a(7) >= 7) {
    const seScore = Math.min(score + 0.5, score < 7.5 ? 7.49 : 10);
    if (seScore !== score) {
      score = Math.round(seScore * 10) / 10;
      if (scorePreSE < 7.5 && score >= 7.5) score = 7.49;
      seApplied = true;
    }
  }

  // Tier mapping
  let tier;
  if (unknownCount > 3) {
    tier = "Manual Review";
  } else if (score < 3.0) {
    tier = "Skip";
  } else if (floorRule) {
    tier = "P3";
  } else if (score >= 7.5) {
    tier = "P1";
  } else if (score >= 5.0) {
    tier = "P2";
  } else {
    tier = "P3";
  }

  return {
    cat: c.category ?? null,
    role: c.network_role ?? null,
    hk: false,
    score,
    score_pre_se: seApplied ? scorePreSE : null,
    tier,
    axes: { 1: a(1), 2: a(2), 3: a(3), 4: a(4), 5: a(5), 6: a(6), 7: a(7), 8: a(8), 10: a(10) },
    axes_meta: { 1: m(1), 2: m(2), 3: m(3), 4: m(4), 5: m(5), 6: m(6), 7: m(7), 8: m(8), 10: m(10) },
    sources: c.top_sources ?? [],
    strat: seSignal,
    ready: c.readiness ?? null,
    conf: c.confidence_level ?? null,
    unknown_count: unknownCount,
    formula_used,
    floor_rule_applied: floorRule,
    se_applied: seApplied,
  };
}

// ── POST /parallel/research/start ─────────────────────────────────────────────
router.post("/research/start", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain, processor = "lite" } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });
  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: buildResearchQuery(company, domain), processor, task_spec: parallelTaskSpec },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID", raw: r.data });
    res.json({ ok: true, taskId, company, processor, status: r.data?.status });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /parallel/result/:taskId ──────────────────────────────────────────────
router.get("/result/:taskId", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { taskId } = req.params;
  try {
    const statusRes = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}`, { headers: parallelHeaders(), timeout: 15000 });
    const status = statusRes.data?.status;
    const done   = status === "completed" || status === "succeeded";
    const failed = status === "failed"    || status === "error";
    let output = null;
    if (done) {
      try {
        const resultRes = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}/result`, { headers: parallelHeaders(), timeout: 15000 });
        output = resultRes.data;
      } catch { output = statusRes.data; }
    }
    res.json({ ok: true, taskId, status, done, failed, output });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /parallel/result/:taskId/compact ──────────────────────────────────────
router.get("/result/:taskId/compact", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { taskId } = req.params;
  try {
    const statusRes = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}`, { headers: parallelHeaders(), timeout: 15000 });
    const status = statusRes.data?.status;
    const done   = status === "completed" || status === "succeeded";
    const failed = status === "failed"    || status === "error";
    if (!done) return res.json({ ok: true, taskId, status, done, failed, compact: null });

    let raw = null;
    try {
      const resultRes = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}/result`, { headers: parallelHeaders(), timeout: 15000 });
      raw = resultRes.data;
    } catch { raw = statusRes.data; }

    const c = raw?.output?.content || raw?.content;
    if (!c) return res.json({ ok: true, taskId, status, done, failed, compact: null, error: "No content in output" });

    // v2.2.2 scoring
    const compact = buildCompactV22(c);

    res.json({ ok: true, taskId, status, done, failed, compact });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /parallel/insight/start ──────────────────────────────────────────────
router.post("/insight/start", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, person, topic } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });
  const query = [
    `Find 1-2 recent specific facts about "${company}"`,
    person ? `or their employee "${person}"` : "",
    `relevant for a personalized B2B outreach from a stablecoin payments company.`,
    topic ? `Focus on: ${topic}.` : `Focus on: recent product launches, funding, expansion, payments strategy, stablecoin activity.`,
    `Return one short sentence (max 20 words) usable as a conversation opener. Be specific, not generic.`,
  ].filter(Boolean).join(" ");
  try {
    const r = await axios.post("https://api.parallel.ai/v1/tasks/runs", { input: query, processor: "lite" }, { headers: parallelHeaders(), timeout: 15000 });
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID" });
    res.json({ ok: true, taskId, company, status: r.data?.status });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /parallel/score ──────────────────────────────────────────────────────
router.post("/score", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain, clientScore } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });
  const processor = (clientScore !== undefined && clientScore >= 7.5) ? "base" : "lite";
  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: buildResearchQuery(company, domain), processor, task_spec: parallelTaskSpec },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID", raw: r.data });
    res.json({ ok: true, taskId, company, processor, status: r.data?.status });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /parallel/upgrade ────────────────────────────────────────────────────
router.post("/upgrade", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });
  const upgradeSpec = {
    output_schema: {
      type: "json",
      json_schema: {
        type: "object",
        properties: {
          ...parallelTaskSpec.output_schema.json_schema.properties,
          outreach_insight: { type: "string" },
        }
      }
    }
  };
  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: buildResearchQuery(company, domain), processor: "base", task_spec: upgradeSpec },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID" });
    res.json({ ok: true, taskId, company, processor: "base", status: r.data?.status });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /insights-bullets — single Parallel call with structured output
// ─────────────────────────────────────────────────────────────────────────────

const insightsBulletsSpec = {
  output_schema: {
    type: "json",
    json_schema: {
      type: "object",
      properties: {
        bullets: {
          type: "array",
          description: "1-3 self-contained factual bullets, each ≤100 chars, with date in (MMM YYYY) format if known. No PR filler.",
          items: { type: "string" },
        },
      },
      required: ["bullets"],
    },
  },
};

function buildInsightsBulletsQuery(company, domain) {
  return [
    `You are doing fast BD research for Plexo, a stablecoin clearing network for licensed FIs.`,
    `Find 1-3 recent specific facts about "${company}"${domain ? ` (${domain})` : ""} from the LAST 90 DAYS.`,
    ``,
    `PRIORITY signals (Plexo BD context):`,
    `- Stablecoin: launches, integrations, issuance, treasury moves`,
    `- On/off ramp: new corridors, fiat rails, geo expansion`,
    `- Regulatory: CASP/EMI/PI/MiCA/VASP licenses or approvals`,
    ``,
    `OTHER useful signals:`,
    `- Funding rounds (size, lead investor)`,
    `- Key C-level / Head-of hires`,
    `- Partnerships with banks, PSPs, exchanges, wallets`,
    `- Measurable growth (volume, users, TVL)`,
    ``,
    `Output rules:`,
    `- Return 1-3 bullets in the "bullets" array`,
    `- Each bullet ≤100 chars, single complete fact`,
    `- Add date in "(MMM YYYY)" format when known — do NOT invent dates`,
    `- No PR filler ("excited to announce", "world's first", "leading provider")`,
    `- If nothing factual found in last 90 days, return empty array`,
  ].join("\n");
}

async function runInsightsBulletsTask(company, domain) {
  const r = await axios.post(
    "https://api.parallel.ai/v1/tasks/runs",
    {
      input: buildInsightsBulletsQuery(company, domain),
      processor: "lite",
      task_spec: insightsBulletsSpec,
    },
    { headers: parallelHeaders(), timeout: 15000 }
  );
  const taskId = r.data?.run_id || r.data?.id;
  if (!taskId) throw new Error(`Parallel start: no task ID (response=${JSON.stringify(r.data)})`);
  return taskId;
}

async function pollUntilDone(taskId, { intervalMs = 3000, timeoutMs = 90000 } = {}) {
  const startedAt = Date.now();
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      throw new Error(`Parallel poll timeout after ${timeoutMs}ms (taskId=${taskId})`);
    }
    const r = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}`, { headers: parallelHeaders(), timeout: 15000 });
    const status = r.data?.status;
    if (status === "completed" || status === "succeeded") {
      const resultRes = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}/result`, { headers: parallelHeaders(), timeout: 15000 });
      return resultRes.data;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Parallel task failed (taskId=${taskId}, status=${status})`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function extractBulletsAndCitations(parallelResult) {
  const c = parallelResult?.output?.content || parallelResult?.content || {};
  const rawBullets = Array.isArray(c.bullets) ? c.bullets : [];

  const bullets = rawBullets
    .map(b => String(b || "").trim())
    .filter(b => b.length > 0)
    .map(b => b.length > 110 ? b.slice(0, 107) + "..." : b)
    .slice(0, 3);

  const basis = parallelResult?.output?.basis || parallelResult?.basis || [];
  const cites = [];
  for (const b of basis) {
    for (const cite of (b.citations || [])) {
      cites.push({
        title:    cite.title || null,
        url:      cite.url   || null,
        excerpts: (cite.excerpts || []).slice(0, 2),
      });
    }
  }

  return { bullets, citations: cites };
}

router.post("/insights-bullets", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ ok: false, error: "PARALLEL_KEY not set" });

  const { company, domain, timeoutMs } = req.body || {};
  if (!company) return res.status(400).json({ ok: false, error: "company required" });

  const pollTimeoutMs = Math.max(
    10_000,
    Math.min(300_000, Number(timeoutMs) || 90_000)
  );

  try {
    const taskId = await runInsightsBulletsTask(company, domain);
    const result = await pollUntilDone(taskId, { intervalMs: 3000, timeoutMs: pollTimeoutMs });
    const { bullets, citations } = extractBulletsAndCitations(result);

    res.json({
      ok: true,
      bullets,
      refreshedAt: new Date().toISOString(),
      parallelTaskId: taskId,
      pollTimeoutMs,
      raw: { citations },
    });
  } catch (err) {
    const status = err.response?.status;
    const data   = err.response?.data;
    console.error(`[parallel/insights-bullets] error: ${err.message} (status=${status} data=${JSON.stringify(data)?.slice(0, 300)})`);
    res.status(500).json({
      ok: false,
      error:           err.message,
      parallelStatus:  status || null,
      parallelData:    data   || null,
    });
  }
});

module.exports = router;
