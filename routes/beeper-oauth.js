// ─────────────────────────────────────────────────────────────────────────────
// Beeper OAuth 2.0 PKCE endpoints.
//
//   GET /beeper/oauth/start
//     - Generates PKCE verifier+challenge, generates state, persists pending
//       authorization, redirects user to Beeper authorize endpoint.
//
//   GET /beeper/oauth/callback?code=...&state=...
//     - Beeper redirects here after user approves. Exchanges code for token
//       using stored PKCE verifier, persists token, shows success page.
//
//   GET /beeper/oauth/status
//     - Diagnostic: shows current auth mode, token expiry, etc. Safe to expose
//       (no actual token returned).
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const router  = express.Router();

const {
  BEEPER_CLIENT_ID,
  BEEPER_REDIRECT,
  authStatus,
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  persistToken,
} = require("../lib/beeper-auth");

// Where we stash pending verifiers (keyed by state). Stored on the same
// persistent volume as the token. Cleared after exchange or 10 min expiry.
const PENDING_DIR = fs.existsSync("/data")
  ? "/data/beeper-oauth-pending"
  : "/tmp/beeper-oauth-pending";

function ensurePendingDir() {
  if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
  }
}

function savePendingState(state, verifier, redirectUri) {
  ensurePendingDir();
  const record = { verifier, redirectUri, created_at: Date.now() };
  fs.writeFileSync(
    path.join(PENDING_DIR, `${state}.json`),
    JSON.stringify(record),
    { mode: 0o600 }
  );
}

function loadPendingState(state) {
  try {
    const file = path.join(PENDING_DIR, `${state}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    // Expire after 10 min
    if (Date.now() - data.created_at > 10 * 60 * 1000) {
      fs.unlinkSync(file);
      return null;
    }
    return data;
  } catch (err) {
    return null;
  }
}

function clearPendingState(state) {
  try {
    const file = path.join(PENDING_DIR, `${state}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) { /* swallow */ }
}

// Resolve the redirect URI for this request. Prefer explicit env, fallback to
// constructing from request host (handy when first deploying).
function resolveRedirectUri(req) {
  if (BEEPER_REDIRECT) return BEEPER_REDIRECT;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}/beeper/oauth/callback`;
}

// ── GET /beeper/oauth/start ──────────────────────────────────────────────────
router.get("/start", (req, res) => {
  if (!BEEPER_CLIENT_ID) {
    return res.status(500).send(
      "BEEPER_CLIENT_ID env not set. Register a client via Beeper /oauth/register first."
    );
  }
  try {
    const { verifier, challenge } = generatePkcePair();
    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = resolveRedirectUri(req);

    savePendingState(state, verifier, redirectUri);

    const authorizeUrl = buildAuthorizeUrl({
      challenge,
      state,
      redirectUri,
      scope: "read write",
    });

    console.log(`[beeper-oauth] start → state=${state.slice(0, 8)}... redirect=${redirectUri}`);
    res.redirect(302, authorizeUrl);
  } catch (err) {
    console.error("[beeper-oauth] start failed:", err.message);
    res.status(500).send(`OAuth start failed: ${err.message}`);
  }
});

// ── GET /beeper/oauth/callback ───────────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.warn(`[beeper-oauth] callback error: ${error} — ${error_description}`);
    return res.status(400).send(htmlPage(
      "❌ Authorization rejected",
      `<p><b>${escHtml(error)}</b>: ${escHtml(error_description || "")}</p>
       <p><a href="/beeper/oauth/start">Try again</a></p>`
    ));
  }

  if (!code || !state) {
    return res.status(400).send(htmlPage(
      "❌ Missing parameters",
      "<p>Callback was hit without code or state. Start OAuth flow at <code>/beeper/oauth/start</code>.</p>"
    ));
  }

  const pending = loadPendingState(state);
  if (!pending) {
    return res.status(400).send(htmlPage(
      "❌ State expired or invalid",
      `<p>The state parameter does not match a pending authorization. This usually means:</p>
       <ul>
         <li>More than 10 minutes passed between start and callback</li>
         <li>The proxy was redeployed/restarted mid-flow</li>
         <li>You clicked the link twice and the first invocation completed</li>
       </ul>
       <p><a href="/beeper/oauth/start">Start over</a></p>`
    ));
  }

  try {
    const tokenResp = await exchangeCodeForToken({
      code,
      verifier:    pending.verifier,
      redirectUri: pending.redirectUri,
    });

    if (!tokenResp.access_token) {
      console.error("[beeper-oauth] no access_token in response:", tokenResp);
      return res.status(500).send(htmlPage(
        "❌ No token returned",
        `<pre>${escHtml(JSON.stringify(tokenResp, null, 2))}</pre>`
      ));
    }

    const ok = persistToken(tokenResp);
    clearPendingState(state);

    if (!ok) {
      return res.status(500).send(htmlPage(
        "❌ Token received but failed to persist",
        "<p>Check Railway logs. Most likely the persistent volume is misconfigured.</p>"
      ));
    }

    const expiresInDays = tokenResp.expires_in
      ? Math.round(tokenResp.expires_in / 86400)
      : "unknown";

    console.log(`[beeper-oauth] ✅ token persisted, expires in ${expiresInDays} days`);

    res.send(htmlPage(
      "✅ Beeper authorized successfully",
      `<p>Token saved. Expires in <b>${escHtml(String(expiresInDays))}</b> days.</p>
       <p>You can close this tab. The FCC bot now has live access to Beeper.</p>
       <p><small><code>GET /beeper/oauth/status</code> to verify.</small></p>`
    ));
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data, null, 2)
      : err.message;
    console.error("[beeper-oauth] exchange failed:", detail);
    res.status(500).send(htmlPage(
      "❌ Token exchange failed",
      `<pre>${escHtml(detail)}</pre>
       <p><a href="/beeper/oauth/start">Try again</a></p>`
    ));
  }
});

// ── GET /beeper/oauth/status ─────────────────────────────────────────────────
router.get("/status", (req, res) => {
  res.json(authStatus());
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.5; }
  h1 { font-size: 22px; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  a { color: #0066cc; }
</style>
</head><body>
<h1>${escHtml(title)}</h1>
${body}
</body></html>`;
}

module.exports = router;
