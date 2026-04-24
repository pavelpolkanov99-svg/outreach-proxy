const express = require("express");
const app     = express();

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Cache-Control");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Environment detection (for /health payload) ──────────────────────────────
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const PARALLEL_KEY  = process.env.PARALLEL_KEY;
const BEEPER_TOKEN  = process.env.BEEPER_TOKEN;

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/apollo",   require("./routes/apollo"));
app.use("/heyreach", require("./routes/heyreach"));
app.use("/notion",   require("./routes/notion"));
app.use("/parallel", require("./routes/parallel"));
app.use("/beeper",   require("./routes/beeper"));
app.use("/webhook",  require("./routes/webhooks"));

// ── Beeper sync job (mounted under /beeper/*) ─────────────────────────────────
const beeperSync = require("./jobs/beeper-sync");
app.use("/beeper", beeperSync.router);
beeperSync.registerJobs();

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  ok: true,
  notion:   !!NOTION_TOKEN,
  parallel: !!PARALLEL_KEY,
  beeper:   !!BEEPER_TOKEN,
}));
app.get("/", (_, res) => res.json({ service: "outreach-proxy", version: "3.9", status: "ok" }));

// ── Listen ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
