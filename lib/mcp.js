// ══════════════════════════════════════════════════════════════════════════════
// lib/mcp.js — MCP tool definitions for Plexo Loop OS
//
// Total tools registered: 28
//   Parallel:  6  (research_start, get_result, get_compact, score, insight_start, research_wait)
//   Notion:    7  (query, update_company, update_tags, append_note, check_duplicates, upsert_person)
//   Apollo:    3  (search_person, match_person, bulk_match)
//   HeyReach:  4  (list_campaigns, create_full_campaign, get_sequence, proxy)
//   Beeper:    1  (get_conversation)
//   GitHub:    7  (get_file, create_or_update_file, create_branch,
//                  create_pull_request, list_pull_requests, get_pr_files,
//                  list_recent_commits)
// ══════════════════════════════════════════════════════════════════════════════

const axios = require("axios");
const { z } = require("zod");
const {
  ghGet, ghPost, ghPut,
  getFileSha, getBranchSha,
  GITHUB_OWNER, GITHUB_REPO,
} = require("./github");

const SELF_URL = process.env.PROXY_URL
  || `http://localhost:${process.env.PORT || 3000}`;

const DEFAULT_HEYREACH_KEY = process.env.HEYREACH_KEY
  || "GBkojH0WLisB1tYtBSBoNSGRQxNE7eFi6Td5eZIq5JY=";
const DEFAULT_APOLLO_KEY = process.env.APOLLO_KEY
  || "mtztHHOhq1AMUNUGPGQ-4A";

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function selfPost(path, body, timeout = 30000) {
  const r = await axios.post(`${SELF_URL}${path}`, body, {
    headers: { "Content-Type": "application/json" },
    timeout,
  });
  return r.data;
}

async function selfGet(path, timeout = 30000) {
  const r = await axios.get(`${SELF_URL}${path}`, { timeout });
  return r.data;
}

function asText(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function asError(err) {
  const msg = err.response?.data
    ? JSON.stringify(err.response.data, null, 2)
    : err.message;
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    isError: true,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool registration
// ══════════════════════════════════════════════════════════════════════════════
function registerMcpTools(server) {

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  PARALLEL.AI                                                             ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool(
    "parallel_research_start",
    "Start a Parallel.ai deep research task on a company for Plexo BD scoring. Returns taskId; poll with parallel_get_result OR parallel_get_compact (compact preferred for batches). Use processor='base' for high-priority companies (clientScore>=7.5), 'lite' otherwise.",
    {
      company: z.string().describe("Company name, e.g. 'Rapyd'"),
      domain: z.string().optional().describe("Optional domain like 'rapyd.net' to disambiguate"),
      processor: z.enum(["lite", "base"]).optional().describe("'lite' (cheap, ~30s) or 'base' (deep, ~90s). Default: lite"),
    },
    async ({ company, domain, processor }) => {
      try {
        const data = await selfPost("/parallel/research/start", { company, domain, processor });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "parallel_get_result",
    "Poll a Parallel research task for FULL output (basis with citations + content). ~7KB per company. Use ONLY for deep dive on 1-2 companies. For batch processing of 10+ companies use parallel_get_compact instead.",
    { taskId: z.string().describe("Task ID from parallel_research_start") },
    async ({ taskId }) => {
      try {
        const data = await selfGet(`/parallel/result/${taskId}`);
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "parallel_get_compact",
    "Poll a Parallel research task for COMPACT output (~400 bytes per company). Returns {cat, role, hk, score (computed /17), tier (MH/P1/P2/P3), axes:{1..8,10:scores}, sources, strat, ready, conf}. ~15x smaller than parallel_get_result. Use for batch processing 10-30 companies. Tier rule: hk_triggered → 'Hard Kill'; else MH ≥9.0, P1 ≥7.5, P2 ≥5.0, P3 <5.0. Schema v3.13.",
    { taskId: z.string().describe("Task ID from parallel_research_start") },
    async ({ taskId }) => {
      try {
        const data = await selfGet(`/parallel/result/${taskId}/compact`);
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "parallel_score",
    "Run Parallel scoring with auto-selected processor based on the prior client score. Companies with clientScore>=7.5 get 'base' (deep), others 'lite'. Returns taskId; poll with parallel_get_compact for batches.",
    {
      company: z.string(),
      domain: z.string().optional(),
      clientScore: z.number().optional().describe("Prior internal client score 0-17"),
    },
    async ({ company, domain, clientScore }) => {
      try {
        const data = await selfPost("/parallel/score", { company, domain, clientScore });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "parallel_insight_start",
    "Start a Parallel task to find 1-2 recent specific facts about a company/person, returned as a 20-word opener for personalized outreach. Returns taskId; poll with parallel_get_result.",
    {
      company: z.string(),
      person: z.string().optional().describe("Optional contact name"),
      topic: z.string().optional().describe("Optional focus topic"),
    },
    async ({ company, person, topic }) => {
      try {
        const data = await selfPost("/parallel/insight/start", { company, person, topic });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "parallel_research_wait",
    "Start Parallel research and BLOCK until complete (or timeout). Returns FULL output directly — no polling needed. Use for single companies / deep dive. For batches of 10+ start tasks via parallel_research_start in parallel, then poll each via parallel_get_compact. Default timeout: 180s.",
    {
      company: z.string(),
      domain: z.string().optional(),
      processor: z.enum(["lite", "base"]).optional(),
      maxWaitMs: z.number().optional().describe("Max wait time in ms. Default 180000 (3 min)"),
    },
    async ({ company, domain, processor, maxWaitMs = 180000 }) => {
      try {
        const start = await selfPost("/parallel/research/start", { company, domain, processor });
        if (!start.taskId) return asError(new Error("No taskId returned"));
        const taskId = start.taskId;
        const t0 = Date.now();
        const pollInterval = 5000;
        while (Date.now() - t0 < maxWaitMs) {
          await new Promise(r => setTimeout(r, pollInterval));
          const result = await selfGet(`/parallel/result/${taskId}`);
          if (result.done || result.failed) {
            return asText({ ...result, elapsedMs: Date.now() - t0 });
          }
        }
        return asText({ taskId, status: "TIMEOUT", elapsedMs: Date.now() - t0,
          message: `Did not complete within ${maxWaitMs}ms. Use parallel_get_result with taskId to keep polling.` });
      } catch (e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  NOTION                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool(
    "notion_query",
    "Query a Notion database with optional filter and sorts. Returns raw Notion API results. Common DBs: Companies=f9b59c5b05fa4df18f9569479633fd74, People=f36b2a0f0ab241cebbdbd1d0874a55be, MessagesHub=8617a441c4254b41be671a1e65946a03",
    {
      db_id: z.string().describe("Notion database UUID"),
      filter: z.any().optional().describe("Notion filter object"),
      sorts: z.any().optional().describe("Notion sorts array"),
      start_cursor: z.string().optional().describe("Pagination cursor from previous response next_cursor"),
      page_size: z.number().optional().describe("Default 20"),
    },
    async ({ db_id, filter, sorts, start_cursor, page_size }) => {
      try {
        const data = await selfPost("/notion/query", { db_id, filter, sorts, start_cursor, page_size });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "notion_update_company",
    "UPSERT a Notion Companies CRM entry — creates new entry if not found, updates if exists. Covers all BD scoring fields: bd_score, priority, corridors, pipeline, type, stage, tags. Always set pipeline ('Partnership'/'Sales') and type ('Partner'/'Client') when writing from BD scoring.",
    {
      name: z.string().describe("Company name to find (uses 'contains' match). Created if not found."),
      industry: z.string().optional(),
      priority: z.enum(["High", "Mid", "Low"]).optional(),
      bd_score: z.number().optional().describe("BD score 0-17"),
      corridors: z.array(z.string()).optional().describe("e.g. ['CNY', 'AUD']"),
      tags: z.array(z.string()).optional().describe("Tags to ADD additively. e.g. ['Outreach']"),
      description: z.string().optional(),
      website: z.string().optional(),
      location: z.string().optional(),
      source: z.string().optional().describe("Notion select — no commas. Format: 'BD Scoring Apr2026'"),
      pipeline: z.string().optional().describe("'Partnership', 'Sales', 'Fundraising', 'Unsure'"),
      type: z.union([z.string(), z.array(z.string())]).optional().describe("'Partner', 'Client', 'Investor', 'Vendor'"),
      heat: z.string().optional(),
      action: z.string().optional(),
      status: z.string().optional().describe("Stage. Only set on new entries — never overwrite existing active pipeline stages"),
    },
    async (params) => {
      try {
        const data = await selfPost("/notion/update-company-with-tags", params);
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "notion_upsert_person",
    "Create or update a person in the Notion People DB and link them to a Company as a relation (People field). Use after finding contacts for a company. If person already exists (matched by name), updates their fields. Always call this for each contact found — it creates the linked record that appears in the Company's People field.",
    {
      name: z.string().describe("Full name of the person, e.g. 'Anmol Dhuper'"),
      title: z.string().optional().describe("Job title, e.g. 'Business Development Director'"),
      company: z.string().describe("Company name — used to find and link the Company page in CRM"),
      linkedin: z.string().optional().describe("LinkedIn URL, e.g. 'https://www.linkedin.com/in/anmol-dhuper-...'"),
      email: z.string().optional().describe("Work email address"),
    },
    async ({ name, title, company, linkedin, email }) => {
      try {
        const data = await selfPost("/notion/upsert-lead", { name, title, company, linkedin, email });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "notion_update_tags",
    "Add or replace Tags (multi-select) on a Notion Companies or People entry. Use mode='add' (default) to append without overwriting. For BD scoring writeback prefer notion_update_company with tags param — saves one call.",
    {
      name: z.string().describe("Company or person name"),
      tags: z.array(z.string()).min(1).describe("Tag values e.g. ['Outreach', 'Money2020']"),
      mode: z.enum(["add", "replace"]).optional().describe("Default: add"),
      db: z.enum(["companies", "people"]).optional().describe("Default: companies"),
    },
    async ({ name, tags, mode, db }) => {
      try {
        const data = await selfPost("/notion/update-tags", { name, tags, mode, db });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "notion_append_note",
    "Append a note to a Notion Companies or People entry. Truncates oldest content if combined Notes exceeds 2000 chars.",
    {
      name: z.string(),
      note: z.string(),
      db: z.enum(["companies", "people"]).optional().describe("Default: companies"),
    },
    async ({ name, note, db }) => {
      try {
        const data = await selfPost("/notion/append-note", { name, note, db });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "notion_check_duplicates",
    "Bulk CRM dedup check — given an array of company names, returns which ones already exist in the Notion Companies DB and their current Stage. Single call replaces N separate probes.",
    {
      names: z.array(z.string()).min(1).max(100).describe("Company names to check, e.g. ['Airwallex', 'Rapyd', 'BVNK']"),
    },
    async ({ names }) => {
      try {
        const data = await selfPost("/notion/check-duplicates", { names });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  APOLLO                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool(
    "apollo_search_person",
    "Search Apollo for a person by name + company. Returns up to 5 candidates with title, email, LinkedIn, company info (compact filtered format).",
    {
      name: z.string().describe("Full name"),
      company: z.string().optional(),
    },
    async ({ name, company }) => {
      try {
        const data = await selfPost("/apollo/search", { apolloKey: DEFAULT_APOLLO_KEY, name, company });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "apollo_match_person",
    "Apollo people enrichment by Apollo ID OR name+company OR LinkedIn URL. Returns COMPACT filtered profile (~1KB). Pass `id` for fastest lookup.",
    {
      id: z.string().optional().describe("Apollo person id. Most reliable."),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      organizationName: z.string().optional(),
      domain: z.string().optional(),
      linkedinUrl: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await selfPost("/apollo/match", { apolloKey: DEFAULT_APOLLO_KEY, ...params });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "apollo_bulk_match",
    "Enrich up to 50 Apollo people in PARALLEL. Returns compact profiles in same order as input. Failed lookups return null.",
    {
      people: z.array(z.object({
        id: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        organizationName: z.string().optional(),
        domain: z.string().optional(),
        linkedinUrl: z.string().optional(),
      })).min(1).max(50),
    },
    async (params) => {
      try {
        let people = params.people;
        if (typeof people === "string") { try { people = JSON.parse(people); } catch {} }
        const data = await selfPost("/apollo/bulk-match", { apolloKey: DEFAULT_APOLLO_KEY, people }, 60000);
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  HEYREACH                                                                ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool(
    "heyreach_list_campaigns",
    "List HeyReach campaigns with status, lead counts, account ids.",
    { offset: z.number().optional(), limit: z.number().optional() },
    async ({ offset, limit }) => {
      try {
        const data = await selfPost("/heyreach/campaigns/list", { hrKey: DEFAULT_HEYREACH_KEY, offset, limit });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "heyreach_create_full_campaign",
    "Create a complete HeyReach campaign in one call: list + campaign + sequence (preset OR custom) + schedule + optionally start. Presets: connect_note, connect_fu, connect_note_fu.",
    {
      campaignName: z.string(),
      listName: z.string().optional(),
      preset: z.enum(["connect_note", "connect_fu", "connect_note_fu"]).optional(),
      customMessages: z.any().optional(),
      linkedInAccountIds: z.array(z.number()).optional(),
      startImmediately: z.boolean().optional(),
    },
    async (params) => {
      try {
        let cm = params.customMessages;
        if (typeof cm === "string") { try { cm = JSON.parse(cm); } catch {} }
        const data = await selfPost("/heyreach/campaign/create-full", { hrKey: DEFAULT_HEYREACH_KEY, ...params, customMessages: cm }, 60000);
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "heyreach_get_sequence",
    "Fetch the sequence (message tree) of an existing HeyReach campaign by ID.",
    { campaignId: z.union([z.string(), z.number()]) },
    async ({ campaignId }) => {
      try {
        const data = await selfGet(`/heyreach/campaign/get-sequence?hrKey=${encodeURIComponent(DEFAULT_HEYREACH_KEY)}&campaignId=${campaignId}`);
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "heyreach_proxy",
    "Generic HeyReach API proxy — call any /api/public/* endpoint with a custom payload.",
    {
      path: z.string().describe("HeyReach path starting with '/' e.g. '/campaign/GetAll'"),
      payload: z.any().optional(),
    },
    async ({ path, payload }) => {
      try {
        let pl = payload;
        if (typeof pl === "string") { try { pl = JSON.parse(pl); } catch {} }
        const data = await selfPost("/heyreach/proxy", { hrKey: DEFAULT_HEYREACH_KEY, path, payload: pl });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  BEEPER                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool(
    "beeper_get_conversation",
    "Find Beeper chat(s) by name fuzzy match and return all messages. Searches WA, TG, LinkedIn.",
    {
      name: z.string().describe("Chat name or company name to fuzzy-match"),
      limit: z.number().optional().describe("Max messages per chat. Default 9999"),
    },
    async ({ name, limit }) => {
      try {
        const data = await selfPost("/beeper/get-conversation", { name, limit });
        return asText(data);
      } catch (e) { return asError(e); }
    }
  );

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  GITHUB                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  server.tool(
    "github_get_file",
    `Read file contents from the ${GITHUB_OWNER}/${GITHUB_REPO} repository.`,
    {
      path: z.string(),
      ref: z.string().optional().describe("Branch or commit SHA. Default: main"),
    },
    async ({ path, ref }) => {
      try {
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const data = await ghGet(`/contents/${encodeURIComponent(path)}${query}`);
        let decoded = null;
        if (data.encoding === "base64" && data.content) {
          decoded = Buffer.from(data.content, "base64").toString("utf-8");
        }
        return asText({ path: data.path, sha: data.sha, size: data.size, encoding: data.encoding, content: decoded, html_url: data.html_url });
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "github_create_or_update_file",
    `Create or update a single file in the ${GITHUB_OWNER}/${GITHUB_REPO} repository.`,
    {
      path: z.string(),
      content: z.string().describe("Full new file content as plain text"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Default: main"),
    },
    async ({ path, content, message, branch = "main" }) => {
      try {
        const priorSha = await getFileSha(path, branch);
        const body = { message, content: Buffer.from(content, "utf-8").toString("base64"), branch };
        if (priorSha) body.sha = priorSha;
        const data = await ghPut(`/contents/${encodeURIComponent(path)}`, body);
        return asText({ action: priorSha ? "updated" : "created", path: data.content?.path, sha: data.content?.sha, commit_sha: data.commit?.sha, commit_url: data.commit?.html_url, file_url: data.content?.html_url });
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "github_create_branch",
    `Create a new branch in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    {
      branch: z.string(),
      from: z.string().optional().describe("Default: main"),
    },
    async ({ branch, from = "main" }) => {
      try {
        const sourceSha = await getBranchSha(from);
        const data = await ghPost(`/git/refs`, { ref: `refs/heads/${branch}`, sha: sourceSha });
        return asText({ branch, from, sha: data.object?.sha, ref: data.ref });
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "github_create_pull_request",
    `Open a pull request in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    {
      title: z.string(),
      head: z.string(),
      base: z.string().optional().describe("Default: main"),
      body: z.string().optional(),
      draft: z.boolean().optional(),
    },
    async ({ title, head, base = "main", body, draft }) => {
      try {
        const data = await ghPost(`/pulls`, { title, head, base, body, draft: !!draft });
        return asText({ number: data.number, state: data.state, html_url: data.html_url, head: data.head?.ref, base: data.base?.ref });
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "github_list_pull_requests",
    `List pull requests in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    {
      state: z.enum(["open", "closed", "all"]).optional(),
      limit: z.number().optional().describe("Default: 10"),
    },
    async ({ state = "open", limit = 10 }) => {
      try {
        const data = await ghGet(`/pulls?state=${state}&per_page=${limit}`);
        return asText(data.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, head: pr.head?.ref, base: pr.base?.ref, html_url: pr.html_url, created_at: pr.created_at })));
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "github_get_pr_files",
    `List files changed in a pull request, with patches (diffs).`,
    { number: z.number() },
    async ({ number }) => {
      try {
        const data = await ghGet(`/pulls/${number}/files`);
        return asText(data.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.slice(0, 3000) })));
      } catch (e) { return asError(e); }
    }
  );

  server.tool(
    "github_list_recent_commits",
    `List recent commits in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
    {
      branch: z.string().optional().describe("Default: main"),
      limit: z.number().optional().describe("Default: 10"),
    },
    async ({ branch = "main", limit = 10 }) => {
      try {
        const data = await ghGet(`/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`);
        return asText(data.map(c => ({ sha: c.sha, message: c.commit?.message, author: c.commit?.author?.name, date: c.commit?.author?.date, html_url: c.html_url })));
      } catch (e) { return asError(e); }
    }
  );

  return server;
}

module.exports = { registerMcpTools };
