const express = require("express");
const app     = express();

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Cache-Control, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Environment detection (for /health payload) ──────────────────────────────
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const PARALLEL_KEY  = process.env.PARALLEL_KEY;
const BEEPER_TOKEN  = process.env.BEEPER_TOKEN;
const BEEPER_CID    = process.env.BEEPER_CLIENT_ID;
const GITHUB_PAT    = process.env.GITHUB_PAT;
const GOOGLE_OAUTH  = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN_PAVEL);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/apollo",         require("./routes/apollo"));
app.use("/heyreach",       require("./routes/heyreach"));
app.use("/notion",         require("./routes/notion"));
app.use("/notion",         require("./routes/stale-enrich")); // ← /notion/stale-deals-enriched
app.use("/parallel",       require("./routes/parallel"));
app.use("/beeper/oauth",   require("./routes/beeper-oauth")); // ← v3.21 OAuth PKCE flow
app.use("/beeper",         require("./routes/beeper"));
app.use("/calendar",       require("./routes/calendar"));
app.use("/webhook",        require("./routes/webhooks"));
app.use("/mcp",            require("./routes/mcp"));
app.use("/messaging-hub",  require("./routes/messaging-hub"));
app.use("/yesterday",      require("./routes/yesterday"));
app.use("/today",          require("./routes/today-lean")); // ← v4.20 /today/lean
app.use("/apify",          require("./routes/apify"));      // ← LinkedIn post scraping
app.use("/comments",       require("./routes/comments"));   // ← Comment generation

// ── Beeper sync job (mounted under /beeper/*) ─────────────────────────────────
const beeperSync = require("./jobs/beeper-sync");
app.use("/beeper", beeperSync.router);
beeperSync.registerJobs();

// ── Prewarm-insights job (mounted under /jobs/*) ──────────────────────────────
const prewarmInsights = require("./jobs/prewarm-insights");
app.use("/jobs", prewarmInsights.router);
prewarmInsights.registerJobs();

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => {
  const beeperAuth = require("./lib/beeper-auth");
  const beeperStatus = beeperAuth.authStatus();
  res.json({
    ok: true,
    notion:   !!NOTION_TOKEN,
    parallel: !!PARALLEL_KEY,
    beeper:   beeperStatus.hasToken,
    beeperMode: beeperStatus.mode,
    beeperExpiresInDays: beeperStatus.expiresInDays ?? null,
    github:   !!GITHUB_PAT,
    calendar: GOOGLE_OAUTH,
    apollo:   !!process.env.APOLLO_KEY,
    apify:    !!process.env.APIFY_TOKEN,
    comments: !!process.env.ANTHROPIC_API_KEY,
    mcp:      true,
    version:  "3.23.0",
  });
});
app.get("/", (_, res) => res.json({ service: "outreach-proxy", version: "3.23.0", status: "ok" }));

// ── Listen ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
