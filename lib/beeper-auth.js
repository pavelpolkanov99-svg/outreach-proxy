// ─────────────────────────────────────────────────────────────────────────────
// Beeper OAuth 2.0 PKCE token manager.
//
// Beeper Desktop API requires PKCE (RFC 7636) — public client, no
// client_secret. Access tokens expire (~30 days based on Beeper UI). No
// refresh_token grant is supported by Beeper as of May 2026, so re-authorize
// once per ~month.
//
// Storage strategy:
//   - Persistent file at $BEEPER_TOKEN_FILE (default /data/beeper-token.json
//     on Railway, or /tmp/beeper-token.json locally).
//   - In-memory cache to avoid disk I/O on every request.
//   - PKCE verifier stored alongside during authorize flow.
//
// Auth lifecycle:
//   1. GET /beeper/oauth/start → generates verifier, persists, redirects to
//      Beeper authorize endpoint
//   2. Beeper redirects back to /beeper/oauth/callback?code=...
//   3. Callback exchanges code for access_token, persists, done
//   4. All subsequent beeperHeaders() reads token from cache/disk
// ─────────────────────────────────────────────────────────────────────────────

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const axios  = require("axios");

const BEEPER_URL         = process.env.BEEPER_URL || "http://localhost:23373";
const BEEPER_CLIENT_ID   = process.env.BEEPER_CLIENT_ID;            // from /oauth/register
const BEEPER_REDIRECT    = process.env.BEEPER_REDIRECT_URI || null; // must match registration
const TOKEN_FILE         = process.env.BEEPER_TOKEN_FILE
  || (fs.existsSync("/data") ? "/data/beeper-token.json"
                              : "/tmp/beeper-token.json");

// Legacy fallback: if BEEPER_TOKEN env exists, use it. Lets old setups keep
// working until OAuth flow is completed. Once token file exists, OAuth wins.
const LEGACY_TOKEN = process.env.BEEPER_TOKEN || null;

// In-memory cache to avoid re-reading the file on every API call.
let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000; // re-read file at most once per minute

function readTokenFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[beeper-auth] readTokenFile failed:", err.message);
    return null;
  }
}

function writeTokenFile(data) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    cache = data;
    cacheLoadedAt = Date.now();
    return true;
  } catch (err) {
    console.error("[beeper-auth] writeTokenFile failed:", err.message);
    return false;
  }
}

function getCachedToken() {
  if (cache && (Date.now() - cacheLoadedAt) < CACHE_TTL_MS) return cache;
  cache = readTokenFile();
  cacheLoadedAt = Date.now();
  return cache;
}

// Public: get the current bearer token, or null if not authorized.
// Order of preference: OAuth file (newer) → legacy BEEPER_TOKEN env.
function getAccessToken() {
  const data = getCachedToken();
  if (data?.access_token) {
    if (data.expires_at && Date.now() > data.expires_at) {
      console.warn("[beeper-auth] token expired at", new Date(data.expires_at).toISOString());
      return { token: data.access_token, expired: true, expires_at: data.expires_at };
    }
    return { token: data.access_token, expired: false, expires_at: data.expires_at };
  }
  if (LEGACY_TOKEN) {
    return { token: LEGACY_TOKEN, expired: false, expires_at: null, legacy: true };
  }
  return { token: null, expired: false };
}

function authStatus() {
  const data = getCachedToken();
  if (data?.access_token) {
    const expires = data.expires_at ? new Date(data.expires_at) : null;
    const expiresInMs = expires ? expires.getTime() - Date.now() : null;
    return {
      mode: "oauth",
      hasToken: true,
      expiresAt: expires?.toISOString() || null,
      expiresInDays: expiresInMs ? Math.round(expiresInMs / 86400_000) : null,
      expired: expires ? Date.now() > expires.getTime() : false,
      clientId: BEEPER_CLIENT_ID || null,
      tokenFile: TOKEN_FILE,
    };
  }
  if (LEGACY_TOKEN) {
    return {
      mode: "legacy-env",
      hasToken: true,
      expiresAt: null,
      expired: false,
      clientId: null,
      tokenFile: TOKEN_FILE,
      note: "Using BEEPER_TOKEN env. Run /beeper/oauth/start to migrate to OAuth.",
    };
  }
  return {
    mode: "none",
    hasToken: false,
    clientId: BEEPER_CLIENT_ID || null,
    tokenFile: TOKEN_FILE,
    note: "No token. Run /beeper/oauth/start to authorize.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PKCE helpers (RFC 7636)
// ─────────────────────────────────────────────────────────────────────────────

function base64urlEncode(buf) {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkcePair() {
  const verifier = base64urlEncode(crypto.randomBytes(32));
  const challenge = base64urlEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth flow primitives — used by routes/beeper-oauth.js
// ─────────────────────────────────────────────────────────────────────────────

function buildAuthorizeUrl({ challenge, state, redirectUri, scope = "read write" }) {
  if (!BEEPER_CLIENT_ID) throw new Error("BEEPER_CLIENT_ID env not set");
  const params = new URLSearchParams({
    response_type:         "code",
    client_id:             BEEPER_CLIENT_ID,
    redirect_uri:          redirectUri,
    scope,
    state,
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });
  return `${BEEPER_URL}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken({ code, verifier, redirectUri }) {
  if (!BEEPER_CLIENT_ID) throw new Error("BEEPER_CLIENT_ID env not set");
  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    client_id:     BEEPER_CLIENT_ID,
    code_verifier: verifier,
    redirect_uri:  redirectUri,
  });
  const r = await axios.post(
    `${BEEPER_URL}/oauth/token`,
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":       "application/json",
      },
      timeout: 15000,
    }
  );
  return r.data;
}

// Persists the token from a successful exchange.
function persistToken(tokenResponse) {
  const expiresIn = tokenResponse.expires_in;
  const expiresAt = expiresIn
    ? Date.now() + (expiresIn * 1000)
    : null;
  const record = {
    access_token: tokenResponse.access_token,
    token_type:   tokenResponse.token_type || "Bearer",
    scope:        tokenResponse.scope || null,
    expires_in:   expiresIn || null,
    expires_at:   expiresAt,
    obtained_at:  Date.now(),
    client_id:    BEEPER_CLIENT_ID,
  };
  return writeTokenFile(record);
}

module.exports = {
  BEEPER_URL,
  BEEPER_CLIENT_ID,
  BEEPER_REDIRECT,
  getAccessToken,
  authStatus,
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  persistToken,
  // Internals exposed for verifier persistence in callback flow
  _readTokenFile:  readTokenFile,
  _writeTokenFile: writeTokenFile,
};
