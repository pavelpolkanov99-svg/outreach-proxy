// ══════════════════════════════════════════════════════════════════════════════
// lib/github.js — GitHub REST API wrapper for our MCP tools.
//
// Hardcoded to single repo (pavelpolkanov99-svg/outreach-proxy) so MCP tools
// don't have to keep passing owner/repo. This is a single-tenant integration.
//
// Auth: GITHUB_PAT env var (Fine-grained PAT with Contents+PR R/W on this repo).
// ══════════════════════════════════════════════════════════════════════════════

const axios = require("axios");

const GITHUB_API   = "https://api.github.com";
const GITHUB_PAT   = process.env.GITHUB_PAT;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "pavelpolkanov99-svg";
const GITHUB_REPO  = process.env.GITHUB_REPO  || "outreach-proxy";

function githubHeaders() {
  return {
    "Authorization": `Bearer ${GITHUB_PAT}`,
    "Accept":        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type":  "application/json",
  };
}

// Build full URL for a repo-scoped path.
//   repoUrl("/contents/index.js")
//     → https://api.github.com/repos/<owner>/<repo>/contents/index.js
function repoUrl(suffix) {
  return `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}${suffix}`;
}

async function ghGet(path) {
  const r = await axios.get(repoUrl(path), { headers: githubHeaders(), timeout: 15000 });
  return r.data;
}

async function ghPost(path, body) {
  const r = await axios.post(repoUrl(path), body, { headers: githubHeaders(), timeout: 30000 });
  return r.data;
}

async function ghPut(path, body) {
  const r = await axios.put(repoUrl(path), body, { headers: githubHeaders(), timeout: 30000 });
  return r.data;
}

async function ghPatch(path, body) {
  const r = await axios.patch(repoUrl(path), body, { headers: githubHeaders(), timeout: 30000 });
  return r.data;
}

// ── Helpers used by tools ─────────────────────────────────────────────────────

// Get the SHA of a file (needed for updates — GitHub's contents API requires
// the prior SHA when updating an existing file). Returns null if file doesn't
// exist (so caller can treat it as "create new").
async function getFileSha(path, ref = null) {
  try {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const data = await ghGet(`/contents/${encodeURIComponent(path)}${query}`);
    return data.sha;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// Get the SHA of a branch's HEAD commit.
async function getBranchSha(branch) {
  const data = await ghGet(`/git/ref/heads/${encodeURIComponent(branch)}`);
  return data.object.sha;
}

module.exports = {
  GITHUB_API,
  GITHUB_PAT,
  GITHUB_OWNER,
  GITHUB_REPO,
  githubHeaders,
  repoUrl,
  ghGet,
  ghPost,
  ghPut,
  ghPatch,
  getFileSha,
  getBranchSha,
};
