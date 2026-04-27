const express = require("express");
const axios   = require("axios");
const {
  PARALLEL_KEY,
  parallelHeaders,
  buildResearchQuery,
  parallelTaskSpec,
} = require("../lib/parallel");

const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Splitter model — used by /insights-bullets to break a synthesis sentence
// into a clean array of bullets. Override via env if you want to A/B test.
//   - claude-haiku-4-5-20251001  : fastest, cheapest
//   - claude-sonnet-4-5-20250929 : higher quality, slightly more $
const SPLITTER_MODEL = process.env.SPLITTER_MODEL || "claude-sonnet-4-5-20250929";

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

    const a = (n) => Number(c[`axis${n}_score`]) || 0;
    const rawScore = (a(1)+a(3)+a(6))*3 + (a(2)+a(5)+a(8))*2 + a(4) + a(7);
    const clientScore = c.hk_triggered ? 0 : Math.round(rawScore * 0.1 * 10) / 10;
    const tier = c.hk_triggered ? "Hard Kill"
               : clientScore >= 9.0 ? "MH"
               : clientScore >= 7.5 ? "P1"
               : clientScore >= 5.0 ? "P2"
               : "P3";

    const compact = {
      cat: c.category ?? null,
      role: c.network_role ?? null,
      hk: c.hk_triggered ? c.hk_criterion : false,
      score: clientScore,
      tier,
      axes: { 1: a(1), 2: a(2), 3: a(3), 4: a(4), 5: a(5), 6: a(6), 7: a(7), 8: a(8), 10: a(10) },
      sources: c.top_sources ?? [],
      strat: c.strategic_entrant_signal === "NOT APPLICABLE" ? null : c.strategic_entrant_signal,
      ready: c.readiness ?? null,
      conf: c.confidence_level ?? null,
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
// Helpers for /insights-bullets
// ─────────────────────────────────────────────────────────────────────────────

async function startInsightTask(company, domain) {
  // Mirror /insight/start prompt structure (proven 200 OK) — shorter form
  // keeps lite processor; long custom topics push it past 4 minutes.
  const query = [
    `Find 1-3 recent specific facts about "${company}"${domain ? ` (${domain})` : ""}`,
    `relevant for a personalized B2B outreach from a stablecoin payments company.`,
    `Focus on: stablecoin launches/integrations, on/off ramp expansion, new payment corridors, regulatory milestones, funding, partnerships.`,
    `Return one short sentence summarizing the 1-3 most relevant facts. Include dates where known.`,
  ].join(" ");

  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: query, processor: "lite" },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) throw new Error(`Parallel start: no task ID (response=${JSON.stringify(r.data)})`);
    return taskId;
  } catch (err) {
    const status = err.response?.status;
    const data   = err.response?.data;
    console.error(`[parallel/insights-bullets] startInsightTask failed: status=${status} data=${JSON.stringify(data)}`);
    const reason = data?.message || data?.error || err.message;
    const e = new Error(`Parallel start ${status || 500}: ${reason}`);
    e.parallelStatus = status;
    e.parallelData   = data;
    throw e;
  }
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

function extractInsightSentence(parallelResult) {
  // parallel insight returns { output: { content: { output: "sentence..." } } }
  const sentence = parallelResult?.output?.content?.output
                 || parallelResult?.content?.output
                 || null;
  return sentence;
}

function extractCitations(parallelResult) {
  const basis = parallelResult?.output?.basis || parallelResult?.basis || [];
  const cites = [];
  for (const b of basis) {
    if (b?.field !== "output") continue;
    for (const c of (b.citations || [])) {
      cites.push({
        title: c.title || null,
        url: c.url || null,
        excerpts: (c.excerpts || []).slice(0, 3),
      });
    }
  }
  return cites;
}

function extractReasoning(parallelResult) {
  const basis = parallelResult?.output?.basis || parallelResult?.basis || [];
  for (const b of basis) {
    if (b?.field === "output" && b.reasoning) return b.reasoning;
  }
  return null;
}

async function splitToBullets({ company, sentence, reasoning, citations }) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!sentence) return { bullets: [] };

  const citationsText = citations.slice(0, 5).map((c, i) => {
    const excerpts = (c.excerpts || []).join(" | ");
    return `[${i + 1}] ${c.title || c.url || ""}${excerpts ? ` — ${excerpts}` : ""}`;
  }).join("\n");

  const prompt = [
    `You are extracting factual BD-relevant bullets about "${company}".`,
    ``,
    `INPUT — synthesis sentence:`,
    sentence,
    ``,
    `INPUT — reasoning notes from research agent (use to find dates, sources):`,
    reasoning || "(none)",
    ``,
    `INPUT — supporting citations (use to find dates):`,
    citationsText || "(none)",
    ``,
    `TASK: Split into 1-3 self-contained bullets.`,
    ``,
    `Rules:`,
    `- Each bullet ≤100 chars`,
    `- Each bullet must be a single complete fact (no "is launching" without subject — prefer "Launching X")`,
    `- Add dates in format "(MMM YYYY)" or "(Q3 2025)" if found in reasoning/citations. Do not invent dates.`,
    `- If a fact appears more than once, include it only once`,
    `- No PR filler ("excited to announce", "leading provider", "world's first")`,
    `- No bullets without factual content`,
    `- If the synthesis sentence has no real facts, return empty array`,
    ``,
    `OUTPUT: Return ONLY valid JSON, no prose, no markdown:`,
    `{"bullets": ["fact 1 (date)", "fact 2 (date)"]}`,
  ].join("\n");

  try {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: SPLITTER_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const text = r.data?.content?.[0]?.text || "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`Splitter returned non-JSON: ${text.slice(0, 200)}`);
      parsed = JSON.parse(m[0]);
    }
    const bullets = Array.isArray(parsed?.bullets) ? parsed.bullets : [];
    const cleanedBullets = bullets
      .map(b => String(b || "").trim())
      .filter(b => b.length > 0)
      .map(b => b.length > 110 ? b.slice(0, 107) + "..." : b)
      .slice(0, 3);

    return { bullets: cleanedBullets, model: SPLITTER_MODEL };
  } catch (err) {
    const status = err.response?.status;
    const data   = err.response?.data;
    console.error(`[parallel/insights-bullets] split via ${SPLITTER_MODEL} failed: status=${status} data=${JSON.stringify(data)?.slice(0, 500)}`);
    const reason = data?.error?.message || data?.message || err.message;
    const e = new Error(`Splitter (${SPLITTER_MODEL}) ${status || 500}: ${reason}`);
    e.splitterStatus = status;
    e.splitterData   = data;
    throw e;
  }
}

// ── POST /parallel/insights-bullets ──────────────────────────────────────────
router.post("/insights-bullets", async (req, res) => {
  if (!PARALLEL_KEY)       return res.status(500).json({ ok: false, error: "PARALLEL_KEY not set" });
  if (!ANTHROPIC_API_KEY)  return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY not set" });

  const { company, domain } = req.body || {};
  if (!company) return res.status(400).json({ ok: false, error: "company required" });

  try {
    const taskId   = await startInsightTask(company, domain);
    const result   = await pollUntilDone(taskId, { intervalMs: 3000, timeoutMs: 90000 });
    const sentence = extractInsightSentence(result);
    const cites    = extractCitations(result);
    const reasoning = extractReasoning(result);

    if (!sentence) {
      return res.json({
        ok: true,
        bullets: [],
        refreshedAt: new Date().toISOString(),
        parallelTaskId: taskId,
        splitterModel: SPLITTER_MODEL,
        raw: { sentence: null, citations: cites },
      });
    }

    const { bullets, model } = await splitToBullets({ company, sentence, reasoning, citations: cites });

    res.json({
      ok: true,
      bullets,
      refreshedAt: new Date().toISOString(),
      parallelTaskId: taskId,
      splitterModel: model,
      raw: { sentence, citations: cites },
    });
  } catch (err) {
    console.error("[parallel/insights-bullets] error:", err.message);
    res.status(500).json({
      ok: false,
      error: err.message,
      parallelStatus:  err.parallelStatus  || null,
      parallelData:    err.parallelData    || null,
      splitterStatus:  err.splitterStatus  || null,
    });
  }
});

module.exports = router;
