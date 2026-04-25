// ══════════════════════════════════════════════════════════════════════════════
// lib/mcp.js — MCP tool definitions for Plexo Loop OS
//
// Total tools registered: 29
//   Parallel:  6
//   Notion:    7  (query, update_company, update_tags, append_note,
//                  check_duplicates, upsert_person, [update_company w/ comm_channel])
//   Apollo:    3
//   HeyReach:  4
//   Beeper:    2  (get_conversation, digest)
//   GitHub:    7
// ══════════════════════════════════════════════════════════════════════════════

const axios = require("axios");
const { z } = require("zod");
const {
  ghGet, ghPost, ghPut,
  getFileSha, getBranchSha,
  GITHUB_OWNER, GITHUB_REPO,
} = require("./github");

const SELF_URL = process.env.PROXY_URL || `http://localhost:${process.env.PORT || 3000}`;
const DEFAULT_HEYREACH_KEY = process.env.HEYREACH_KEY || "GBkojH0WLisB1tYtBSBoNSGRQxNE7eFi6Td5eZIq5JY=";
const DEFAULT_APOLLO_KEY   = process.env.APOLLO_KEY   || "mtztHHOhq1AMUNUGPGQ-4A";

async function selfPost(path, body, timeout = 30000) {
  const r = await axios.post(`${SELF_URL}${path}`, body, { headers: { "Content-Type": "application/json" }, timeout });
  return r.data;
}
async function selfGet(path, timeout = 30000) {
  const r = await axios.get(`${SELF_URL}${path}`, { timeout });
  return r.data;
}
function asText(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function asError(err) {
  const msg = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function registerMcpTools(server) {

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  PARALLEL.AI                                                             ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool("parallel_research_start",
    "Start a Parallel.ai deep research task on a company for Plexo BD scoring. Returns taskId; poll with parallel_get_compact for batches.",
    { company: z.string(), domain: z.string().optional(), processor: z.enum(["lite","base"]).optional() },
    async ({ company, domain, processor }) => {
      try { return asText(await selfPost("/parallel/research/start", { company, domain, processor })); } catch(e) { return asError(e); }
    }
  );

  server.tool("parallel_get_result",
    "Poll a Parallel task for FULL output. Use only for 1-2 companies. Use parallel_get_compact for batches.",
    { taskId: z.string() },
    async ({ taskId }) => {
      try { return asText(await selfGet(`/parallel/result/${taskId}`)); } catch(e) { return asError(e); }
    }
  );

  server.tool("parallel_get_compact",
    "Poll a Parallel task for COMPACT output (~400 bytes). Returns {cat, role, hk, score, tier, axes, sources, strat, ready, conf}. Use for batches of 10-30 companies.",
    { taskId: z.string() },
    async ({ taskId }) => {
      try { return asText(await selfGet(`/parallel/result/${taskId}/compact`)); } catch(e) { return asError(e); }
    }
  );

  server.tool("parallel_score",
    "Run Parallel scoring with auto-selected processor. clientScore>=7.5 → base, else lite.",
    { company: z.string(), domain: z.string().optional(), clientScore: z.number().optional() },
    async ({ company, domain, clientScore }) => {
      try { return asText(await selfPost("/parallel/score", { company, domain, clientScore })); } catch(e) { return asError(e); }
    }
  );

  server.tool("parallel_insight_start",
    "Start a Parallel task to find 1-2 recent facts about a company/person for personalized outreach.",
    { company: z.string(), person: z.string().optional(), topic: z.string().optional() },
    async ({ company, person, topic }) => {
      try { return asText(await selfPost("/parallel/insight/start", { company, person, topic })); } catch(e) { return asError(e); }
    }
  );

  server.tool("parallel_research_wait",
    "Start Parallel research and BLOCK until complete. Use for single companies only. Default timeout: 180s.",
    { company: z.string(), domain: z.string().optional(), processor: z.enum(["lite","base"]).optional(), maxWaitMs: z.number().optional() },
    async ({ company, domain, processor, maxWaitMs = 180000 }) => {
      try {
        const start = await selfPost("/parallel/research/start", { company, domain, processor });
        if (!start.taskId) return asError(new Error("No taskId"));
        const t0 = Date.now();
        while (Date.now() - t0 < maxWaitMs) {
          await new Promise(r => setTimeout(r, 5000));
          const result = await selfGet(`/parallel/result/${start.taskId}`);
          if (result.done || result.failed) return asText({ ...result, elapsedMs: Date.now() - t0 });
        }
        return asText({ taskId: start.taskId, status: "TIMEOUT", elapsedMs: Date.now() - t0 });
      } catch(e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  NOTION                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool("notion_query",
    "Query a Notion database. Common DBs: Companies=f9b59c5b05fa4df18f9569479633fd74, People=f36b2a0f0ab241cebbdbd1d0874a55be",
    { db_id: z.string(), filter: z.any().optional(), sorts: z.any().optional(), start_cursor: z.string().optional(), page_size: z.number().optional() },
    async ({ db_id, filter, sorts, start_cursor, page_size }) => {
      try { return asText(await selfPost("/notion/query", { db_id, filter, sorts, start_cursor, page_size })); } catch(e) { return asError(e); }
    }
  );

  server.tool("notion_update_company",
    "UPSERT a Notion Companies CRM entry — creates if not found, updates if exists. Always set pipeline and type from BD scoring. communication_channel: 'LinkedIn'|'WhatsApp'|'Email'|'Telegram'.",
    {
      name: z.string().describe("Company name. Created if not found."),
      industry: z.string().optional(),
      priority: z.enum(["High","Mid","Low"]).optional(),
      bd_score: z.number().optional(),
      corridors: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional().describe("Additive — e.g. ['Outreach']"),
      description: z.string().optional(),
      website: z.string().optional(),
      location: z.string().optional(),
      source: z.string().optional().describe("No commas. e.g. 'BD Scoring Apr2026'"),
      pipeline: z.string().optional().describe("'Partnership'|'Sales'|'Fundraising'|'Unsure'"),
      type: z.union([z.string(), z.array(z.string())]).optional().describe("'Partner'|'Client'|'Investor'|'Vendor'"),
      heat: z.string().optional(),
      action: z.string().optional(),
      status: z.string().optional().describe("Stage — only set on new entries"),
      communication_channel: z.string().optional().describe("'LinkedIn'|'WhatsApp'|'Email'|'Telegram'"),
    },
    async (params) => {
      try { return asText(await selfPost("/notion/update-company-with-tags", params)); } catch(e) { return asError(e); }
    }
  );

  server.tool("notion_upsert_person",
    "Create or update a person in the Notion People DB and link them to a Company as a relation. Creates the linked record that appears in the Company's People field.",
    {
      name: z.string().describe("Full name, e.g. 'Anmol Dhuper'"),
      title: z.string().optional().describe("Job title"),
      company: z.string().describe("Company name — used to find and link the Company page"),
      linkedin: z.string().optional().describe("LinkedIn URL"),
      email: z.string().optional().describe("Work email"),
    },
    async ({ name, title, company, linkedin, email }) => {
      try { return asText(await selfPost("/notion/upsert-lead", { name, title, company, linkedin, email })); } catch(e) { return asError(e); }
    }
  );

  server.tool("notion_update_tags",
    "Add or replace Tags on a Notion Companies or People entry. mode='add' (default) appends without overwriting.",
    {
      name: z.string(),
      tags: z.array(z.string()).min(1),
      mode: z.enum(["add","replace"]).optional(),
      db: z.enum(["companies","people"]).optional(),
    },
    async ({ name, tags, mode, db }) => {
      try { return asText(await selfPost("/notion/update-tags", { name, tags, mode, db })); } catch(e) { return asError(e); }
    }
  );

  server.tool("notion_append_note",
    "Append a note to a Notion Companies or People entry.",
    { name: z.string(), note: z.string(), db: z.enum(["companies","people"]).optional() },
    async ({ name, note, db }) => {
      try { return asText(await selfPost("/notion/append-note", { name, note, db })); } catch(e) { return asError(e); }
    }
  );

  server.tool("notion_check_duplicates",
    "Bulk CRM dedup check — returns which company names already exist in Notion and their Stage.",
    { names: z.array(z.string()).min(1).max(100) },
    async ({ names }) => {
      try { return asText(await selfPost("/notion/check-duplicates", { names })); } catch(e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  APOLLO                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool("apollo_search_person",
    "Search Apollo for a person by name + company.",
    { name: z.string(), company: z.string().optional() },
    async ({ name, company }) => {
      try { return asText(await selfPost("/apollo/search", { apolloKey: DEFAULT_APOLLO_KEY, name, company })); } catch(e) { return asError(e); }
    }
  );

  server.tool("apollo_match_person",
    "Apollo enrichment by Apollo ID OR name+company OR LinkedIn URL. Returns compact profile (~1KB).",
    { id: z.string().optional(), firstName: z.string().optional(), lastName: z.string().optional(), organizationName: z.string().optional(), domain: z.string().optional(), linkedinUrl: z.string().optional() },
    async (params) => {
      try { return asText(await selfPost("/apollo/match", { apolloKey: DEFAULT_APOLLO_KEY, ...params })); } catch(e) { return asError(e); }
    }
  );

  server.tool("apollo_bulk_match",
    "Enrich up to 50 people in parallel. Returns compact profiles.",
    { people: z.array(z.object({ id: z.string().optional(), firstName: z.string().optional(), lastName: z.string().optional(), organizationName: z.string().optional(), domain: z.string().optional(), linkedinUrl: z.string().optional() })).min(1).max(50) },
    async (params) => {
      try {
        let people = params.people;
        if (typeof people === "string") { try { people = JSON.parse(people); } catch {} }
        return asText(await selfPost("/apollo/bulk-match", { apolloKey: DEFAULT_APOLLO_KEY, people }, 60000));
      } catch(e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  HEYREACH                                                                ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool("heyreach_list_campaigns",
    "List HeyReach campaigns.",
    { offset: z.number().optional(), limit: z.number().optional() },
    async ({ offset, limit }) => {
      try { return asText(await selfPost("/heyreach/campaigns/list", { hrKey: DEFAULT_HEYREACH_KEY, offset, limit })); } catch(e) { return asError(e); }
    }
  );

  server.tool("heyreach_create_full_campaign",
    "Create a complete HeyReach campaign: list + campaign + sequence + schedule. Presets: connect_note, connect_fu, connect_note_fu.",
    { campaignName: z.string(), listName: z.string().optional(), preset: z.enum(["connect_note","connect_fu","connect_note_fu"]).optional(), customMessages: z.any().optional(), linkedInAccountIds: z.array(z.number()).optional(), startImmediately: z.boolean().optional() },
    async (params) => {
      try {
        let cm = params.customMessages;
        if (typeof cm === "string") { try { cm = JSON.parse(cm); } catch {} }
        return asText(await selfPost("/heyreach/campaign/create-full", { hrKey: DEFAULT_HEYREACH_KEY, ...params, customMessages: cm }, 60000));
      } catch(e) { return asError(e); }
    }
  );

  server.tool("heyreach_get_sequence",
    "Fetch the sequence of a HeyReach campaign by ID.",
    { campaignId: z.union([z.string(), z.number()]) },
    async ({ campaignId }) => {
      try { return asText(await selfGet(`/heyreach/campaign/get-sequence?hrKey=${encodeURIComponent(DEFAULT_HEYREACH_KEY)}&campaignId=${campaignId}`)); } catch(e) { return asError(e); }
    }
  );

  server.tool("heyreach_proxy",
    "Generic HeyReach API proxy — call any /api/public/* endpoint.",
    { path: z.string(), payload: z.any().optional() },
    async ({ path, payload }) => {
      try {
        let pl = payload;
        if (typeof pl === "string") { try { pl = JSON.parse(pl); } catch {} }
        return asText(await selfPost("/heyreach/proxy", { hrKey: DEFAULT_HEYREACH_KEY, path, payload: pl }));
      } catch(e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  BEEPER                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool("beeper_get_conversation",
    "Find Beeper chat(s) by name fuzzy match. Searches WA, TG, LinkedIn.",
    { name: z.string(), limit: z.number().optional() },
    async ({ name, limit }) => {
      try { return asText(await selfPost("/beeper/get-conversation", { name, limit })); } catch(e) { return asError(e); }
    }
  );

  server.tool("beeper_digest",
    "Get all Beeper chats active in the last N days with correct network label (LinkedIn/Telegram/WhatsApp) via /v1/chats REST — accountID-based detection. Used by /comms skill. Returns per chat: id, name, type, network, networkFull, accountID, lastMsgText, lastMsgSender, lastMsgTime, isSender.",
    { days: z.number().optional(), limit: z.number().optional() },
    async ({ days = 7, limit = 200 }) => {
      try { return asText(await selfGet(`/beeper/digest?days=${days}&limit=${limit}`, 60000)); } catch(e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  GITHUB                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool("github_get_file",
    `Read file from ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    { path: z.string(), ref: z.string().optional() },
    async ({ path, ref }) => {
      try {
        const data = await ghGet(`/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
        const content = data.encoding === "base64" && data.content ? Buffer.from(data.content, "base64").toString("utf-8") : null;
        return asText({ path: data.path, sha: data.sha, size: data.size, content, html_url: data.html_url });
      } catch(e) { return asError(e); }
    }
  );

  server.tool("github_create_or_update_file",
    `Create or update a file in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    { path: z.string(), content: z.string(), message: z.string(), branch: z.string().optional() },
    async ({ path, content, message, branch = "main" }) => {
      try {
        const priorSha = await getFileSha(path, branch);
        const body = { message, content: Buffer.from(content, "utf-8").toString("base64"), branch };
        if (priorSha) body.sha = priorSha;
        const data = await ghPut(`/contents/${encodeURIComponent(path)}`, body);
        return asText({ action: priorSha ? "updated" : "created", path: data.content?.path, sha: data.content?.sha, commit_sha: data.commit?.sha, commit_url: data.commit?.html_url, file_url: data.content?.html_url });
      } catch(e) { return asError(e); }
    }
  );

  server.tool("github_create_branch",
    `Create a branch in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    { branch: z.string(), from: z.string().optional() },
    async ({ branch, from = "main" }) => {
      try {
        const sha = await getBranchSha(from);
        const data = await ghPost(`/git/refs`, { ref: `refs/heads/${branch}`, sha });
        return asText({ branch, from, sha: data.object?.sha, ref: data.ref });
      } catch(e) { return asError(e); }
    }
  );

  server.tool("github_create_pull_request",
    `Open a PR in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    { title: z.string(), head: z.string(), base: z.string().optional(), body: z.string().optional(), draft: z.boolean().optional() },
    async ({ title, head, base = "main", body, draft }) => {
      try {
        const data = await ghPost(`/pulls`, { title, head, base, body, draft: !!draft });
        return asText({ number: data.number, state: data.state, html_url: data.html_url, head: data.head?.ref, base: data.base?.ref });
      } catch(e) { return asError(e); }
    }
  );

  server.tool("github_list_pull_requests",
    `List PRs in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    { state: z.enum(["open","closed","all"]).optional(), limit: z.number().optional() },
    async ({ state = "open", limit = 10 }) => {
      try {
        const data = await ghGet(`/pulls?state=${state}&per_page=${limit}`);
        return asText(data.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, head: pr.head?.ref, html_url: pr.html_url, created_at: pr.created_at })));
      } catch(e) { return asError(e); }
    }
  );

  server.tool("github_get_pr_files",
    `List files changed in a PR with diffs.`,
    { number: z.number() },
    async ({ number }) => {
      try {
        const data = await ghGet(`/pulls/${number}/files`);
        return asText(data.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.slice(0, 3000) })));
      } catch(e) { return asError(e); }
    }
  );

  server.tool("github_list_recent_commits",
    `List recent commits in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    { branch: z.string().optional(), limit: z.number().optional() },
    async ({ branch = "main", limit = 10 }) => {
      try {
        const data = await ghGet(`/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`);
        return asText(data.map(c => ({ sha: c.sha, message: c.commit?.message, author: c.commit?.author?.name, date: c.commit?.author?.date, html_url: c.html_url })));
      } catch(e) { return asError(e); }
    }
  );

  return server;
}

module.exports = { registerMcpTools };
