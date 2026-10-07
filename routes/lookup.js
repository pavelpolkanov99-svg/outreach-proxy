// ── /lookup — CRM lookup for the Telegram bot (v3.32.0) ───────────────────────
// POST /lookup/ask                 { text, hint?: "person"|"company" }
//   → { intent, telegram (HTML), phoneJobId?, scoreJobId?, ... }
//   intent "other" means: not a lookup, let the bot handle it as before.
// GET  /lookup/job/:id             → { job, telegram } — bot polls scoring / phone
// POST /lookup/apollo-phone/:id?k= ← Apollo phone-reveal webhook
const express = require("express");
const lookup  = require("../lib/crm-lookup");

const router = express.Router();

router.post("/ask", async (req, res) => {
  const { text, hint } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "text required" });
  try {
    const out = await lookup.ask({ text: String(text).slice(0, 1000), hint });
    console.log(`[lookup] ${out.intent}: ${JSON.stringify(out.request)} spent=${JSON.stringify(out.spent || [])}`);
    res.json(out);
  } catch (e) {
    console.error(`[lookup] ask failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.get("/job/:id", (req, res) => {
  const job = lookup.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({ job, telegram: job.status === "running" ? null : lookup.renderJob(job) });
});

router.post("/apollo-phone/:id", async (req, res) => {
  try {
    const r = await lookup.handlePhoneWebhook(req.params.id, String(req.query.k || ""), req.body);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false });
    console.log(`[lookup] phone webhook received for job ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[lookup] phone webhook failed: ${e.message}`);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
