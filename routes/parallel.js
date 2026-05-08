const express = require("express");
const axios   = require("axios");
const {
  PARALLEL_KEY,
  parallelHeaders,
  buildResearchQuery,
  parallelTaskSpec,
} = require("../lib/parallel");

const router = express.Router();

// ── Scoring helpers (BD Scoring Framework v2.2) ──────────────────────────────
//
// v2.2 changes vs v2.1 (May 8 2026 — Anton's discipline patch):
// - UNKNOWN axes capped at 3 in formula
// - Client formula: (a1*3 + a3*3 + a6*3 + a2*2 + a5*2 + a8*2 + a4 + a7) / 17
// - Partner formula: (a3*3 + a6*3 + a10*3 + a5*2 + a8*2 + a4) / 14
// - Floor Rules applied as post-processor caps (G-1, G-2, G-3)
// - Tier bands strict: P1 ≥ 7.5, P2 5.0-7.49, P3 3.0-4.99, Skip <3.0
// - MH tier removed — P1 is new top, rare by design
// - >3 UNKNOWN axes → "Manual Review" (no tier assigned)
// - Hard Kill remains mandatory STOP — no overrides

function getCappedAxis(c, n) {
  const score = Number(c[`axis${n}_score`]) || 0;
  const meta = c[`axis${n}_meta`];
  if (meta === "UNKNOWN") {
    return Math.min(score, 3);
  }
  return score;
}

function countUnknownAxes(c, isPartner) {
  // For Client: check axes 1-8. For Partner: check axes 3-8 + 10.
  const axesToCheck = isPartner ? [3, 4, 5, 6, 8, 10] : [1, 2, 3, 4, 5, 6, 7, 8];
  return axesToCheck.filter(n => c[`axis${n}_meta`] === "UNKNOWN").length;
}

function calculateScore(c) {
  if (c.hk_triggered) return { score: 0, isPartner: false, raw: 0, formula: "HK" };

  const isPartner = c.category === "Partner";

  if (isPartner) {
    // Partner: (axis3*3 + axis6*3 + axis10*3 + axis5*2 + axis8*2 + axis4) / 14
    const a3  = getCappedAxis(c, 3);
    const a4  = getCappedAxis(c, 4);
    const a5  = getCappedAxis(c, 5);
    const a6  = getCappedAxis(c, 6);
    const a8  = getCappedAxis(c, 8);
    const a10 = getCappedAxis(c, 10);
    const raw = (a3 + a6 + a10) * 3 + (a5 + a8) * 2 + a4;
    const score = Math.round((raw / 14) * 10) / 10;
    return { score, isPartner: true, raw, formula: "Partner" };
  }

  // Client: (axis1*3 + axis3*3 + axis6*3 + axis2*2 + axis5*2 + axis8*2 + axis4 + axis7) / 17
  const a1 = getCappedAxis(c, 1);
  const a2 = getCappedAxis(c, 2);
  const a3 = getCappedAxis(c, 3);
  const a4 = getCappedAxis(c, 4);
  const a5 = getCappedAxis(c, 5);
  const a6 = getCappedAxis(c, 6);
  const a7 = getCappedAxis(c, 7);
  const a8 = getCappedAxis(c, 8);
  const raw = (a1 + a3 + a6) * 3 + (a2 + a5 + a8) * 2 + a4 + a7;
  const score = Math.round((raw / 17) * 10) / 10;
  return { score, isPartner: false, raw, formula: "Client" };
}

function applyFloorRules(c, isPartner) {
  const a1  = getCappedAxis(c, 1);
  const a2  = getCappedAxis(c, 2);
  const a6  = getCappedAxis(c, 6);
  const a10 = getCappedAxis(c, 10);

  // G-1: License < 3 → max P3
  if (a6 < 3) return { capped: true, reason: "G-1: License axis < 3" };

  // G-2: XBorder < 3 AND Ramp < 3 → max P3 (Client only)
  if (!isPartner && a1 < 3 && a2 < 3) {
    return { capped: true, reason: "G-2: Both XBorder and Ramp < 3" };
  }

  // G-3: Partner with InfraFit < 5 → max P3
  if (isPartner && a10 < 5) return { capped: true, reason: "G-3: Partner InfraFit < 5" };

  return { capped: false, reason: null };
}

function determineTier(c, score, isPartner) {
  if (c.hk_triggered) return { tier: "Hard Kill", reason: c.hk_criterion };

  // Check UNKNOWN count first — >3 means insufficient data
  const unknownCount = countUnknownAxes(c, isPartner);
  if (unknownCount > 3) {
    return { tier: "Manual Review", reason: `${unknownCount} UNKNOWN axes — insufficient verifiable data` };
  }

  // Apply Floor Rules
  const floor = applyFloorRules(c, isPartner);
  if (floor.capped) {
    return { tier: "P3", reason: floor.reason };
  }

  // Strict tier banding (no MH in v2.2, no rounding)
  if (score >= 7.5) return { tier: "P1",   reason: null };
  if (score >= 5.0) return { tier: "P2",   reason: null };
  if (score >= 3.0) return { tier: "P3",   reason: null };
  return { tier: "Skip", reason: "Score below P3 threshold" };
}

function buildAxesMeta(c) {
  return {
    1:  c.axis1_meta  || "INFERENCE",
    2:  c.axis2_meta  || "INFERENCE",
    3:  c.axis3_meta  || "INFERENCE",
    4:  c.axis4_meta  || "INFERENCE",
    5:  c.axis5_meta  || "INFERENCE",
    6:  c.axis6_meta  || "INFERENCE",
    7:  c.axis7_meta  || "INFERENCE",
    8:  c.axis8_meta  || "INFERENCE",
    10: c.axis10_meta || "UNKNOWN",
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

    // v2.2 scoring pipeline
    const { score, isPartner, formula } = calculateScore(c);
    const { tier, reason: tierReason } = determineTier(c, score, isPartner);
    const axesMeta = buildAxesMeta(c);
    const unknownCount = countUnknownAxes(c, isPartner);

    const a = (n) => Number(c[`axis${n}_score`]) || 0;

    const compact = {
      cat: c.category ?? null,
      role: c.network_role ?? null,
      hk: c.hk_triggered ? c.hk_criterion : false,
      score,
      tier,
      tier_reason: tierReason,
      axes: { 1: a(1), 2: a(2), 3: a(3), 4: a(4), 5: a(5), 6: a(6), 7: a(7), 8: a(8), 10: a(10) },
      axes_meta: axesMeta,
      axes_evidence: c.axes_evidence ?? null,
      unknown_count: unknownCount,
      formula,
      sources: c.top_sources ?? [],
      strat: c.strategic_entrant_signal === "NOT APPLICABLE" ? null : c.strategic_entrant_signal,
      ready: c.readiness ?? null,
      conf: c.confidence_level ?? null,
      scoring_version: "v2.2",
    };

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
// v2.2: processor escalation threshold is now P1 (≥7.5), not legacy MH (≥9.0)
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
// /insights-bullets — single Parallel call with structured output (no LLM split)
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

// ── POST /parallel/insights-bullets ──────────────────────────────────────────
// Body: { company: string, domain?: string, timeoutMs?: number }
// timeoutMs — how long to poll Parallel for completion. Default 90000.
router.post("/insights-bullets", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ ok: false, error: "PARALLEL_KEY not set" });

  const { company, domain, timeoutMs } = req.body || {};
  if (!company) return res.status(400).json({ ok: false, error: "company required" });

  // Clamp caller-supplied timeout into a sane range (10s-300s)
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
