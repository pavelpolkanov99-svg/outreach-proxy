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
  // Short topic — keeps lite processor (long custom topics push it to >4 min)
  const query = [
    `Find 1-3 recent specific facts about "${company}"${domain ? ` (${domain})` : ""}`,
    `relevant for a personalized B2B outreach from a stablecoin payments company.`,
    `PRIORITY: stablecoin launches/integrations, on/off ramp expansion, new payment corridors/geos, regulatory milestones (CASP/EMI/MiCA).`,
    `OTHER: funding, key C-level hires, partnerships with banks/PSPs/exchanges.`,
    `Return one sentence (max 30 words) summarizing the 1-3 most relevant facts. Include dates where known. Be specific, not generic.`,
  ].join(" ");

  const r = await axios.post(
    "https://api.parallel.ai/v1/tasks/runs",
    { input: query, processor: "lite" },
    { headers: parallelHeaders(), timeout: 15000 }
  );
  const taskId = r.data?.run_id || r.data?.id;
  if (!taskId) throw new Error("Parallel start: no task ID");
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

function extractInsightSentence(parallelResult) {
  // parallel_insight_start returns { output: { content: { output: "sentence..." } } }
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

async function splitWithHaiku({ company, sentence, reasoning, citations }) {
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

  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  const text = r.data?.content?.[0]?.text || "";
  // Strip code fences if Haiku adds them
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Best-effort: extract JSON object from anywhere in the response
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Haiku returned non-JSON: ${text.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }
  const bullets = Array.isArray(parsed?.bullets) ? parsed.bullets : [];
  // Hard cap each bullet to 110 chars (slight buffer over the rule), drop empties
  const cleanedBullets = bullets
    .map(b => String(b || "").trim())
    .filter(b => b.length > 0)
    .map(b => b.length > 110 ? b.slice(0, 107) + "..." : b)
    .slice(0, 3);

  return { bullets: cleanedBullets };
}

// ── POST /parallel/insights-bullets ──────────────────────────────────────────
// Full flow in one call: Parallel insight task → poll until done → Haiku split.
// Body: { company: string, domain?: string }
// Returns: {
//   ok: true,
//   bullets: string[],
//   refreshedAt: ISO string,
//   parallelTaskId: string,
//   raw: { sentence, citations[] }    // for debugging / Notion record
// }
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
        raw: { sentence: null, citations: cites },
      });
    }

    const { bullets } = await splitWithHaiku({ company, sentence, reasoning, citations: cites });

    res.json({
      ok: true,
      bullets,
      refreshedAt: new Date().toISOString(),
      parallelTaskId: taskId,
      raw: { sentence, citations: cites },
    });
  } catch (err) {
    console.error("[parallel/insights-bullets] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
