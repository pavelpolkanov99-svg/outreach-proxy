// ─────────────────────────────────────────────────────────────────────────────
// lib/tool-registry.js
//
// Maps Claude tool_use calls to actual HTTP endpoints on outreach-proxy.
//
// Each tool entry has:
//   - definition: JSON schema sent to Claude API as part of `tools` array
//   - isWrite: boolean — if true, approval_flow.js gates execution
//   - handler(input): async function — performs the HTTP call, returns
//     a plain JSON-serializable result that goes back to Claude as tool_result
//   - approvalSummary(input): string — human-readable description shown in
//     the [✅ Yes / ❌ No] prompt for write tools. Lets Anton/Pavel sanity-check
//     before destructive action runs.
//
// Calling this module's `getToolDefinitions()` returns the array suitable
// for Anthropic Messages API. `getHandler(name)` returns the executor.
//
// MVP scope: 22 hand-picked tools across Notion, Apollo, Parallel, Beeper,
// Calendar. HeyReach campaigns intentionally excluded (campaigns are Pavel's
// workflow, not Anton's).
//
// RESILIENCE: the Beeper proxy runs behind an ngrok tunnel on Pavel's Mac and
// is frequently unreachable (tunnel down → HTTP 404 / connection error). The
// Beeper read tools (beeper_get_conversation, beeper_digest) therefore fall
// back automatically to the Notion Messaging Hub DB, into which all messages
// are synced daily. The agent never sees the Beeper failure — it just gets the
// data, flagged with _source so it can tell the user where it came from.
//
// NOTE: This module is standalone. NOT yet imported by bot.js — activation
// happens later via CONVERSATIONAL_MODE_ENABLED.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const PROXY_URL = process.env.PROXY_URL
  || "https://outreach-proxy-production-eb03.up.railway.app";

const DEFAULT_TIMEOUT_MS = 30_000;

// Notion Messaging Hub DB — Beeper messages are synced here daily. Used as the
// fallback source when the live Beeper proxy (ngrok tunnel) is unreachable.
const MESSAGING_HUB_DB = "8617a441c4254b41be671a1e65946a03";

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function callProxy(method, path, options = {}) {
  const url = `${PROXY_URL}${path}`;
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  try {
    const r = await axios({
      method,
      url,
      params: options.params,
      data:   options.data,
      timeout,
    });
    return { ok: true, data: r.data };
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const msg    = body?.error || body?.message || err.message;
    return {
      ok: false,
      error: msg,
      status,
      _raw: typeof body === "object" ? body : null,
    };
  }
}

// Truncate large responses so we don't blow Claude's context with raw Notion JSON.
// Caller decides what fields to keep before passing to here, but as a safety net.
function truncateForClaude(obj, maxChars = 15000) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length <= maxChars) return obj;
  return {
    _truncated: true,
    _originalLength: s.length,
    preview: s.slice(0, maxChars - 100) + "\n... [truncated]",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Messaging Hub fallback — used when the live Beeper proxy is unreachable
// ─────────────────────────────────────────────────────────────────────────────
//
// Beeper runs behind an ngrok tunnel on Pavel's Mac. When the Mac is asleep or
// ngrok isn't running, every /beeper/* call returns 404. Rather than failing
// the whole tool call, the Beeper read handlers call into here: the Notion
// Messaging Hub DB (8617a441c4254b41be671a1e65946a03) holds a daily sync of
// all Beeper conversations and is always reachable.
//
// The Messaging Hub row shape (verified against the live DB):
//   "Chat Name"     (title)        — chat name, e.g. "Ruth GCA Pay"
//   "Last Message"  (rich_text)    — text of the most recent message
//   "Last Active"   (date)         — date of last activity
//   "Network"       (multi_select) — WhatsApp | Telegram | LinkedIn
//   "Raw Sender Name"(rich_text)   — who sent the last message
//   "Status"        (status)       — Active | Needs Triage | ...
//   "Category"      (multi_select) — Client | Sales Rep | ...
//   "Remote ID"     (rich_text)    — Beeper chat id (matrix-style)
//
// These helpers shape Hub rows into a Beeper-like response so the agent can
// treat the result uniformly. The _source / _fallback flags tell the agent
// (and through it, the user) that this came from the daily sync, not live.

function plainTextOf(richTextArr) {
  return (richTextArr || [])
    .map(rt => rt.plain_text || rt.text?.content || "")
    .join("");
}

// Map one Messaging Hub Notion page → a flat chat object.
function hubPageToChat(page) {
  const props = page.properties || {};
  return {
    name:          plainTextOf(props["Chat Name"]?.title),
    network:       (props["Network"]?.multi_select || []).map(o => o.name).join("/") || null,
    lastMsgText:   plainTextOf(props["Last Message"]?.rich_text) || null,
    lastMsgSender: plainTextOf(props["Raw Sender Name"]?.rich_text) || null,
    lastActive:    props["Last Active"]?.date?.start || null,
    status:        props["Status"]?.status?.name || null,
    category:      (props["Category"]?.multi_select || []).map(o => o.name),
    remoteId:      plainTextOf(props["Remote ID"]?.rich_text) || null,
    notionUrl:     page.url || null,
  };
}

// Normalize a Beeper conversation result so that "found nothing" is a
// SUCCESSFUL empty result, not an error.
//
// Why this exists: the agent's executeToolWithRetry treats ANY tool result
// object that has an `error` field as a tool FAILURE — it retries, then bails
// the whole turn with kind:"tool_failed". But "No chats found matching X" is
// a perfectly normal, expected outcome (the chat is named after a person, not
// the company). If it propagates as { error }, the agent never gets to read
// the result and never reaches the company→people fallback in its prompt.
//
// So: any result whose only signal is "no chats" (an `error` string that
// looks like a not-found message, OR an explicit chatsFound:0) is rewritten
// into { ok:true, chats:[], chatsFound:0, message:... }. A real failure
// (tunnel down + Hub also failed, auth error, timeout) keeps its `error`
// field and still bails as before.
function isNoChatsFoundResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  // Explicit empty result from a successful query.
  if (obj.chatsFound === 0) return true;
  // Error string that is really just "nothing matched".
  if (typeof obj.error === "string") {
    return /no chats? found|no conversations? found|not found|no match/i.test(obj.error);
  }
  return false;
}

function normalizeConversationResult(obj, queryName) {
  // A genuine, non-empty result (or a real error) passes through untouched.
  if (!isNoChatsFoundResult(obj)) return obj;
  // "Nothing found" → successful empty result. No `error` field, so the
  // agent's turn does NOT bail and it can run the company→people fallback.
  return {
    ok: true,
    query: queryName,
    chatsFound: 0,
    chats: [],
    message: `No chats found matching "${queryName}". This is not an error — `
      + `Beeper chats are named after people, not companies. If this was a `
      + `company lookup, fall back to Notion: find the company, read its `
      + `linked People, and search Beeper by each person's name.`,
  };
}

// Fallback for beeper_get_conversation — find chats by fuzzy name in the Hub.
async function messagingHubConversationFallback(name, beeperError) {
  const r = await callProxy("POST", "/notion/query", {
    data: {
      db_id: MESSAGING_HUB_DB,
      filter: { property: "Chat Name", title: { contains: String(name || "").slice(0, 100) } },
      sorts: [{ property: "Last Active", direction: "descending" }],
      page_size: 10,
    },
    timeout: 20_000,
  });
  if (!r.ok) {
    // Both live Beeper AND the Hub failed — only now is it a real error.
    return {
      error: `Beeper unavailable (${beeperError}); Messaging Hub fallback also failed (${r.error})`,
    };
  }
  const chats = (r.data.results || []).map(hubPageToChat);
  return {
    _source: "messaging-hub-fallback",
    _note: "Live Beeper proxy was unreachable (ngrok tunnel down). This data is from the Notion Messaging Hub daily sync — it may be up to ~24h stale. Tell the user the source is the Messaging Hub, not live Beeper.",
    _beeperError: beeperError,
    query: name,
    chatsFound: chats.length,
    chats,
  };
}

// Fallback for beeper_digest — recent active chats from the Hub.
async function messagingHubDigestFallback(days, beeperError) {
  const lookbackDays = Math.max(1, Math.min(30, days || 7));
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const r = await callProxy("POST", "/notion/query", {
    data: {
      db_id: MESSAGING_HUB_DB,
      filter: { property: "Last Active", date: { on_or_after: cutoff } },
      sorts: [{ property: "Last Active", direction: "descending" }],
      page_size: 50,
    },
    timeout: 20_000,
  });
  if (!r.ok) {
    return {
      error: `Beeper unavailable (${beeperError}); Messaging Hub fallback also failed (${r.error})`,
    };
  }
  const chats = (r.data.results || []).map(hubPageToChat);
  return {
    _source: "messaging-hub-fallback",
    _note: "Live Beeper proxy was unreachable (ngrok tunnel down). This digest is from the Notion Messaging Hub daily sync — it may be up to ~24h stale. Tell the user the source is the Messaging Hub, not live Beeper.",
    _beeperError: beeperError,
    lookbackDays,
    cutoff,
    chatsFound: chats.length,
    chats,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────
// Each tool follows the Anthropic tool definition spec:
//   { name, description, input_schema: { type, properties, required } }

const TOOLS = [
  // ─── Notion ────────────────────────────────────────────────────────────────
  {
    isWrite: false,
    definition: {
      name: "notion_query",
      description: "Query a Notion database with filter and sorts. Use to find companies, people, tasks, or messaging hub entries. Pass db_id (Companies: f9b59c5b05fa4df18f9569479633fd74, People: f36b2a0f0ab241cebbdbd1d0874a55be, Messaging Hub: 8617a441c4254b41be671a1e65946a03, Tasks: 2fa2ac1063c8800b8a92d56de58a6358). Filter syntax follows Notion API. Returns up to 20 results.",
      input_schema: {
        type: "object",
        properties: {
          db_id:        { type: "string", description: "Notion database UUID" },
          filter:       { type: "object", description: "Notion filter object (optional)" },
          sorts:        { type: "array",  description: "Notion sorts array (optional)" },
          page_size:    { type: "integer", description: "Max results, 1-100 (default 20)" },
          start_cursor: { type: "string", description: "Pagination cursor (optional)" },
        },
        required: ["db_id"],
      },
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/query", { data: input, timeout: 20_000 });
      if (!r.ok) return { error: r.error };
      const results = (r.data.results || []).map(page => ({
        id: page.id,
        url: page.url,
        properties: simplifyNotionProperties(page.properties),
        last_edited_time: page.last_edited_time,
      }));
      return {
        results,
        has_more: r.data.has_more,
        next_cursor: r.data.next_cursor,
        total_returned: results.length,
      };
    },
  },

  {
    isWrite: false,
    definition: {
      name: "notion_get_schema",
      description: "Get the exact schema of a Notion database: every property's exact name and type, plus the valid option names for select/status/multi_select properties. ALWAYS call this BEFORE building a notion_query filter on a database whose property names you are not 100% certain of. Notion property names are case-sensitive and often non-obvious (e.g. the Companies title is 'Company name' not 'Name'; the Tasks DB company link is '🏢  CRM Companies' with an emoji and two spaces). Guessing a property name causes a 'Could not find property' error. db_id values: Companies f9b59c5b05fa4df18f9569479633fd74, People f36b2a0f0ab241cebbdbd1d0874a55be, Messaging Hub 8617a441c4254b41be671a1e65946a03, Tasks 2fa2ac1063c8800b8a92d56de58a6358.",
      input_schema: {
        type: "object",
        properties: {
          db_id: { type: "string", description: "Notion database UUID to inspect" },
        },
        required: ["db_id"],
      },
    },
    handler: async (input) => {
      if (!input.db_id) return { error: "db_id required" };
      const r = await callProxy("GET", "/notion/db-schema", {
        params: { db_id: input.db_id },
        timeout: 15_000,
      });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: false,
    definition: {
      name: "notion_insight_by_domain",
      description: "Look up a Notion CRM company by website domain. Returns the full company card with BD score, stage, tags, insights, last contact. Best for 'what do we know about acme.com'-style questions.",
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Domain like 'bitso.com' (no protocol, no www)" },
        },
        required: ["domain"],
      },
    },
    handler: async (input) => {
      const r = await callProxy("GET", "/notion/insight-by-domain", { params: input });
      if (!r.ok) return { error: r.error };
      return truncateForClaude(r.data);
    },
  },

  {
    isWrite: true,
    definition: {
      name: "notion_update_company",
      description: "Create or update a Notion CRM company. If a company with the given name exists, it's updated; otherwise created. Use for adding new prospects, updating BD scores, changing stages, tagging. Stage values: Backlog, Not Started, To Contact, Connection/cold email sent, intro, Communication Started, Call Scheduled, initial discussions, Keeping in the Loop, Warm discussions, Negotiations, Not relevant, Win, Lost, DELETE.",
      input_schema: {
        type: "object",
        properties: {
          name:        { type: "string", description: "Company name" },
          industry:    { type: "string" },
          priority:    { type: "string", description: "High | Mid | Low" },
          bd_score:    { type: "number", description: "0-10" },
          corridors:   { type: "array",  items: { type: "string" }, description: "Payment corridors" },
          description: { type: "string", description: "Short description of what they do" },
          website:     { type: "string" },
          location:    { type: "string" },
          source:      { type: "string" },
          pipeline:    { type: "string" },
          type:        { type: "array",  items: { type: "string" } },
          heat:        { type: "string" },
          status:      { type: "string", description: "Stage (see description)" },
          tags:        { type: "array",  items: { type: "string" }, description: "Tags — additive, won't overwrite" },
        },
        required: ["name"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`🏢 <b>Запись в Notion Companies</b>`];
      lines.push(`• Имя: <b>${input.name}</b>`);
      if (input.status)   lines.push(`• Stage: ${input.status}`);
      if (input.priority) lines.push(`• Priority: ${input.priority}`);
      if (input.bd_score !== undefined) lines.push(`• BD Score: ${input.bd_score}`);
      if (input.tags?.length) lines.push(`• Tags: ${input.tags.join(", ")}`);
      if (input.website)  lines.push(`• Website: ${input.website}`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/update-company-with-tags", { data: input });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "notion_upsert_person",
      description: "Create or update a contact in Notion People DB. Links to a Company if companyName is provided (company must already exist or be created first). Use for adding new contacts met at conferences, recording LinkedIn/email/title etc.",
      input_schema: {
        type: "object",
        properties: {
          name:        { type: "string" },
          firstName:   { type: "string" },
          lastName:    { type: "string" },
          title:       { type: "string", description: "Job title / role" },
          company:     { type: "string", description: "Company name to link" },
          linkedin:    { type: "string" },
          email:       { type: "string" },
          status:      { type: "string", description: "Default 'Not Started'" },
        },
        required: [],
      },
    },
    approvalSummary: (input) => {
      const fullName = input.name || [input.firstName, input.lastName].filter(Boolean).join(" ");
      const lines = [`👤 <b>Создать/обновить контакт</b>`];
      lines.push(`• Имя: <b>${fullName}</b>`);
      if (input.title)    lines.push(`• Title: ${input.title}`);
      if (input.company)  lines.push(`• Company: ${input.company}`);
      if (input.email)    lines.push(`• Email: ${input.email}`);
      if (input.linkedin) lines.push(`• LinkedIn: ${input.linkedin}`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/upsert-lead", { data: input });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "notion_append_note",
      description: "Append a note to an existing Notion Company or Person Notes field. Existing notes preserved with --- separator. Use for recording meeting outcomes, conversation summaries, observations.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Company or Person name" },
          note: { type: "string", description: "Note text to append" },
          db:   { type: "string", description: "'companies' or 'people' (default 'companies')" },
        },
        required: ["name", "note"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`📝 <b>Добавить note</b>`];
      lines.push(`• ${input.db === "people" ? "Person" : "Company"}: <b>${input.name}</b>`);
      const preview = input.note.length > 200 ? input.note.slice(0, 200) + "..." : input.note;
      lines.push(`• Note:\n   "${preview}"`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/append-note", { data: input });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "notion_update_tags",
      description: "Add tags to a Notion Company or Person. Additive (won't overwrite existing). Use for marking conference attendees, segmenting prospects, etc.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          db:   { type: "string", description: "'companies' or 'people' (default 'companies')" },
          mode: { type: "string", description: "'add' (default) or 'replace'" },
        },
        required: ["name", "tags"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`🏷 <b>Тэги</b> (${input.mode || "add"})`];
      lines.push(`• ${input.db === "people" ? "Person" : "Company"}: <b>${input.name}</b>`);
      lines.push(`• Tags: ${input.tags.join(", ")}`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/update-tags", { data: input });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: false,
    definition: {
      name: "notion_check_duplicates",
      description: "Bulk check which company names already exist in Notion CRM. Pass array of names, returns which were found (with stage/pageId) and which weren't. Use before bulk-adding from conferences.",
      input_schema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
        },
        required: ["names"],
      },
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/check-duplicates", { data: input });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: false,
    definition: {
      name: "notion_tasks_today",
      description: "Get open tasks due today or overdue from Notion Tasks Tracker DB. Filtered to Pavel + Anton only. Returns priority, due date, days overdue, linked company.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max tasks (default 10, max 50)" },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const r = await callProxy("GET", "/notion/tasks-today", { params: input });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "notion_create_task",
      description: "Create a new task in the Notion Tasks Tracker DB. Use when the user asks to add a task, set a to-do, or schedule a follow-up action (e.g. 'поставь задачу пинг GCA в WhatsApp'). The task appears in /today digests once created. Company and person links are resolved by name (best-effort) — if not found the task is still created without the link.",
      input_schema: {
        type: "object",
        properties: {
          taskName:    { type: "string", description: "Task name / title — required" },
          description: { type: "string", description: "Task details / context (optional)" },
          summary:     { type: "string", description: "Short one-line summary (optional)" },
          dueDate:     { type: "string", description: "Due date, format YYYY-MM-DD (optional)" },
          priority:    { type: "string", description: "High | Medium | Low (optional)" },
          status:      { type: "string", description: "Status (optional, default 'Not started')" },
          assignee:    { type: "string", description: "'anton' or 'pavel' (optional)" },
          channel:     { type: "array",  items: { type: "string" }, description: "Channel(s): Email, WhatsApp, LinkedIn, Telegram (optional)" },
          companyName: { type: "string", description: "CRM company name to link the task to (optional)" },
          personName:  { type: "string", description: "CRM person name to link the task to (optional)" },
        },
        required: ["taskName"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`✅ <b>Создать задачу в Tasks Tracker</b>`];
      lines.push(`• Задача: <b>${input.taskName}</b>`);
      if (input.dueDate)  lines.push(`• Due: ${input.dueDate}`);
      if (input.priority) lines.push(`• Priority: ${input.priority}`);
      if (input.assignee) lines.push(`• Assignee: ${input.assignee}`);
      const ch = Array.isArray(input.channel) ? input.channel.join(", ") : input.channel;
      if (ch) lines.push(`• Channel: ${ch}`);
      if (input.companyName) lines.push(`• Company: ${input.companyName}`);
      if (input.personName)  lines.push(`• Person: ${input.personName}`);
      if (input.description) {
        const preview = input.description.length > 160
          ? input.description.slice(0, 160) + "..."
          : input.description;
        lines.push(`• Описание: <i>${preview}</i>`);
      }
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/notion/create-task", { data: input, timeout: 20_000 });
      return r.ok ? r.data : { error: r.error };
    },
  },

  // ─── Apollo ────────────────────────────────────────────────────────────────
  // Note: proxy routes are /apollo/search and /apollo/match (NOT -person suffixed)
  {
    isWrite: false,
    definition: {
      name: "apollo_search_person",
      description: "Search Apollo.io for a person by name and company keywords. Returns matching profiles with LinkedIn, title, email (if available). Combines name + company into search keywords.",
      input_schema: {
        type: "object",
        properties: {
          name:    { type: "string", description: "Person's full name" },
          company: { type: "string", description: "Company name (optional, narrows search)" },
        },
        required: ["name"],
      },
    },
    handler: async (input) => {
      // Proxy /apollo/search expects { name, company } and builds q_keywords internally.
      const r = await callProxy("POST", "/apollo/search", { data: input });
      return r.ok ? truncateForClaude(r.data) : { error: r.error };
    },
  },

  {
    isWrite: false,
    definition: {
      name: "apollo_match_person",
      description: "Enrich one person via Apollo.io. Provide Apollo ID, OR (firstName + lastName + organizationName/domain), OR LinkedIn URL. Returns title, email, phone, LinkedIn, work history.",
      input_schema: {
        type: "object",
        properties: {
          id:               { type: "string", description: "Apollo person ID (if known)" },
          firstName:        { type: "string" },
          lastName:         { type: "string" },
          organizationName: { type: "string", description: "Company name" },
          domain:           { type: "string", description: "Company domain (e.g. 'bitso.com')" },
          linkedinUrl:      { type: "string", description: "LinkedIn profile URL" },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/apollo/match", { data: input });
      return r.ok ? truncateForClaude(r.data) : { error: r.error };
    },
  },

  // ─── Parallel.ai ────────────────────────────────────────────────────────────
  // Note: proxy routes are /parallel/research/start (slash) and
  // /parallel/result/:taskId (path param, not query)
  {
    isWrite: true,
    definition: {
      name: "parallel_research_start",
      description: "Start a Parallel.ai deep research task on a company for BD scoring. Costs ~$0.025 (Core processor). Returns a task ID. Poll with parallel_get_result. Use for new prospects we need to evaluate.",
      input_schema: {
        type: "object",
        properties: {
          company:   { type: "string" },
          domain:    { type: "string", description: "Company domain (recommended for accuracy, e.g. 'bitso.com')" },
          processor: { type: "string", description: "lite | base | core (default) | core2x | pro | ultra" },
        },
        required: ["company"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`🔬 <b>Parallel.ai research</b>`];
      lines.push(`• Company: <b>${input.company}</b>`);
      if (input.domain) lines.push(`• Domain: ${input.domain}`);
      lines.push(`• Processor: ${input.processor || "core"} (~$0.025)`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/parallel/research/start", { data: input, timeout: 20_000 });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: false,
    definition: {
      name: "parallel_get_result",
      description: "Poll a Parallel.ai task for its full result. Use after parallel_research_start. Returns status (queued | running | complete) and output (if complete).",
      input_schema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID returned by parallel_research_start" },
        },
        required: ["taskId"],
      },
    },
    handler: async (input) => {
      if (!input.taskId) return { error: "taskId required" };
      // Path param, not query string
      const r = await callProxy("GET", `/parallel/result/${encodeURIComponent(input.taskId)}`, {
        timeout: 15_000,
      });
      return r.ok ? truncateForClaude(r.data, 20_000) : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "parallel_score",
      description: "Run Parallel.ai BD scoring for a company using Plexo's BD framework v2.2. Returns axis-by-axis breakdown, BD score (0-10), tier (MH/P1/P2/P3), Hard Kill detection. Costs ~$0.025-0.10 depending on processor.",
      input_schema: {
        type: "object",
        properties: {
          company:     { type: "string" },
          domain:      { type: "string" },
          clientScore: { type: "number", description: "Optional priority hint — ≥7.5 auto-escalates to core2x" },
        },
        required: ["company"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`📊 <b>BD scoring</b>`];
      lines.push(`• Company: <b>${input.company}</b>`);
      if (input.domain) lines.push(`• Domain: ${input.domain}`);
      const proc = (input.clientScore !== undefined && input.clientScore >= 7.5) ? "core2x" : "core";
      lines.push(`• Processor: ${proc} (~$0.025-0.05)`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/parallel/score", { data: input, timeout: 20_000 });
      return r.ok ? r.data : { error: r.error };
    },
  },

  // ─── Beeper ─────────────────────────────────────────────────────────────────
  // Both Beeper read tools auto-fall-back to the Notion Messaging Hub when the
  // live Beeper proxy (ngrok tunnel) is unreachable — see the fallback helpers
  // near the top of this file.
  {
    isWrite: false,
    definition: {
      name: "beeper_digest",
      description: "Get all messaging activity (chats) from the last N days across LinkedIn/Telegram/WhatsApp. Each chat includes name, network, last message, sender, timestamp. Tries live Beeper first; if the Beeper tunnel is down it automatically falls back to the Notion Messaging Hub daily sync (the result is flagged with _source so you can tell the user). Use for 'what's been happening' overviews.",
      input_schema: {
        type: "object",
        properties: {
          days:  { type: "integer", description: "Look-back window (default 7, max 30)" },
          limit: { type: "integer", description: "Max chats (default 200, max 500)" },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const r = await callProxy("GET", "/beeper/digest", { params: input, timeout: 20_000 });
      if (r.ok) return truncateForClaude(r.data, 25_000);
      // Live Beeper unreachable — fall back to the Messaging Hub sync.
      console.warn(`[tool-registry] beeper_digest live call failed (${r.error}); falling back to Messaging Hub`);
      const fb = await messagingHubDigestFallback(input.days, r.error);
      return truncateForClaude(fb, 25_000);
    },
  },

  {
    isWrite: false,
    definition: {
      name: "beeper_get_conversation",
      description: "Find a messaging conversation by fuzzy name match across LinkedIn/Telegram/WhatsApp. Returns chat metadata + recent message info. Tries live Beeper first; if the Beeper tunnel is down it automatically falls back to the Notion Messaging Hub daily sync (the result is flagged with _source so you can tell the user the data may be up to ~24h stale). Only report 'no conversation found' if BOTH sources return nothing.",
      input_schema: {
        type: "object",
        properties: {
          name:  { type: "string", description: "Name to search (fuzzy)" },
          limit: { type: "integer", description: "Max messages per chat (default 9999)" },
        },
        required: ["name"],
      },
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/beeper/get-conversation", { data: input, timeout: 20_000 });
      if (r.ok) {
        // The live proxy can answer HTTP 200 with a body like
        // { ok:false, error:"No chats found matching X" } — a normal empty
        // result, NOT a failure. Normalize it so the agent doesn't bail and
        // can run the company→people fallback.
        const normalized = normalizeConversationResult(r.data, input.name);
        return truncateForClaude(normalized, 20_000);
      }
      // Live Beeper call failed at the HTTP level. If the error is just
      // "no chats found", that's an empty result, not a tunnel failure —
      // return it as a successful empty result, no Hub fallback needed.
      if (isNoChatsFoundResult(r)) {
        return truncateForClaude(normalizeConversationResult(r, input.name), 20_000);
      }
      // Genuine failure (tunnel down, timeout, auth) — fall back to the
      // Messaging Hub sync. The Hub result is itself normalized: a Hub query
      // that succeeds but finds nothing also becomes a clean empty result.
      console.warn(`[tool-registry] beeper_get_conversation live call failed (${r.error}); falling back to Messaging Hub`);
      const fb = await messagingHubConversationFallback(input.name, r.error);
      return truncateForClaude(normalizeConversationResult(fb, input.name), 20_000);
    },
  },

  {
    isWrite: true,
    definition: {
      name: "beeper_send_message",
      description: "Send a text message to a Beeper chat. CRITICAL: This sends a real message to a real person. Always double-check chat ID and message content before approving. Pass chatId from beeper_get_conversation or beeper_digest. NOTE: sending requires the live Beeper tunnel — it cannot be done via the Messaging Hub fallback.",
      input_schema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Beeper chat ID (from get-conversation or digest)" },
          text:   { type: "string", description: "Message text to send" },
        },
        required: ["chatId", "text"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`⚠️ <b>Отправить сообщение в Beeper</b>`];
      const chatId = input.chatId || "";
      lines.push(`• Chat ID: <code>${chatId.slice(0, 40)}${chatId.length > 40 ? "..." : ""}</code>`);
      lines.push(`• Текст:\n"${input.text}"`);
      return lines.join("\n");
    },
    handler: async (input) => {
      // Proxy route is POST /beeper/send with body { chatId, text }
      const r = await callProxy("POST", "/beeper/send", { data: input, timeout: 15_000 });
      if (r.ok) return r.data;
      // No Hub fallback for sending — be explicit so the agent tells the user.
      return {
        error: `Не удалось отправить — Beeper-туннель недоступен (${r.error}). Отправку нельзя сделать через Messaging Hub fallback: нужен живой Beeper. Подними ngrok-туннель и повтори.`,
      };
    },
  },

  // ─── Google Calendar ───────────────────────────────────────────────────────
  // NOTE: create/update/delete endpoints don't exist in proxy yet.
  // Next commit adds /calendar/create-event, /calendar/update-event,
  // /calendar/delete-event to routes/calendar.js. Until then, calling these
  // tools will return 404.
  {
    isWrite: false,
    definition: {
      name: "calendar_list_events",
      description: "List Anton's calendar events for today. Returns events with summary, time, attendees (external only), Google Meet link, and CRM enrichment if attendee email matches a Notion company.",
      input_schema: {
        type: "object",
        properties: {
          when:  { type: "string", description: "Currently only 'today' supported. Extended later." },
          includeInternal: { type: "boolean", description: "Include internal team meetings (default false)" },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const when = input.when || "today";
      if (when === "today") {
        const r = await callProxy("GET", "/calendar/today", {
          params: { includeInternal: input.includeInternal ? "1" : "0" },
          timeout: 20_000,
        });
        return r.ok ? r.data : { error: r.error };
      }
      return { error: `when='${when}' not yet supported, use 'today'` };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "calendar_create_event",
      description: "Create a new event on Anton's Google Calendar. Use for scheduling calls, meetings, blocks. ISO 8601 timestamps in Europe/Prague unless otherwise specified.",
      input_schema: {
        type: "object",
        properties: {
          summary:          { type: "string", description: "Event title" },
          startTime:        { type: "string", description: "ISO 8601 like '2026-05-16T14:00:00+02:00'" },
          endTime:          { type: "string", description: "ISO 8601" },
          description:      { type: "string", description: "Event details (optional)" },
          location:         { type: "string", description: "Location (optional)" },
          attendeeEmails:   { type: "array", items: { type: "string" } },
          addGoogleMeetUrl: { type: "boolean", description: "Auto-create Google Meet link" },
          calendarId:       { type: "string", description: "Default: anton@remide.xyz" },
        },
        required: ["summary", "startTime", "endTime"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`📅 <b>Создать встречу</b>`];
      lines.push(`• Title: <b>${input.summary}</b>`);
      lines.push(`• Когда: ${input.startTime} → ${input.endTime}`);
      if (input.attendeeEmails?.length) {
        lines.push(`• Участники: ${input.attendeeEmails.join(", ")}`);
      }
      if (input.addGoogleMeetUrl) lines.push(`• + Google Meet link`);
      if (input.location) lines.push(`• Location: ${input.location}`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/calendar/create-event", { data: input, timeout: 15_000 });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "calendar_update_event",
      description: "Update an existing event (move time, change title, add attendees). Pass eventId from calendar_list_events.",
      input_schema: {
        type: "object",
        properties: {
          eventId:    { type: "string" },
          summary:    { type: "string", description: "New title (optional)" },
          startTime:  { type: "string", description: "New start (ISO 8601, optional)" },
          endTime:    { type: "string", description: "New end (ISO 8601, optional)" },
          description: { type: "string" },
          location:   { type: "string" },
          addedAttendeeEmails:   { type: "array", items: { type: "string" } },
          removedAttendeeEmails: { type: "array", items: { type: "string" } },
          calendarId: { type: "string" },
        },
        required: ["eventId"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`✏️ <b>Изменить встречу</b>`];
      lines.push(`• Event: <code>${input.eventId.slice(0, 30)}</code>`);
      if (input.summary)   lines.push(`• Новый title: ${input.summary}`);
      if (input.startTime) lines.push(`• Новое начало: ${input.startTime}`);
      if (input.endTime)   lines.push(`• Новый конец: ${input.endTime}`);
      if (input.addedAttendeeEmails?.length)   lines.push(`• + ${input.addedAttendeeEmails.join(", ")}`);
      if (input.removedAttendeeEmails?.length) lines.push(`• − ${input.removedAttendeeEmails.join(", ")}`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/calendar/update-event", { data: input, timeout: 15_000 });
      return r.ok ? r.data : { error: r.error };
    },
  },

  {
    isWrite: true,
    definition: {
      name: "calendar_delete_event",
      description: "Delete a calendar event. IRREVERSIBLE. Use only when user explicitly says 'cancel' or 'delete' a specific event.",
      input_schema: {
        type: "object",
        properties: {
          eventId:    { type: "string" },
          calendarId: { type: "string" },
        },
        required: ["eventId"],
      },
    },
    approvalSummary: (input) => {
      const lines = [`🗑 <b>УДАЛИТЬ встречу (необратимо)</b>`];
      lines.push(`• Event: <code>${input.eventId.slice(0, 40)}</code>`);
      if (input.calendarId) lines.push(`• Calendar: ${input.calendarId}`);
      lines.push(`<i>⚠️ Удаление нельзя отменить. Если не уверен — отмени.</i>`);
      return lines.join("\n");
    },
    handler: async (input) => {
      const r = await callProxy("POST", "/calendar/delete-event", { data: input, timeout: 15_000 });
      return r.ok ? r.data : { error: r.error };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — Notion property simplification
// ─────────────────────────────────────────────────────────────────────────────
// Notion property objects are noisy. Flatten common types to plain values
// so Claude sees readable JSON, not 5 levels of nesting per property.

function simplifyNotionProperties(props) {
  if (!props || typeof props !== "object") return props;
  const out = {};
  for (const [key, val] of Object.entries(props)) {
    if (!val || !val.type) {
      out[key] = val;
      continue;
    }
    switch (val.type) {
      case "title":
        out[key] = (val.title || []).map(t => t.plain_text || t.text?.content || "").join("");
        break;
      case "rich_text":
        out[key] = (val.rich_text || []).map(t => t.plain_text || t.text?.content || "").join("");
        break;
      case "number":
        out[key] = val.number;
        break;
      case "select":
        out[key] = val.select?.name || null;
        break;
      case "status":
        out[key] = val.status?.name || null;
        break;
      case "multi_select":
        out[key] = (val.multi_select || []).map(o => o.name);
        break;
      case "date":
        out[key] = val.date?.start || null;
        break;
      case "checkbox":
        out[key] = val.checkbox;
        break;
      case "url":
        out[key] = val.url;
        break;
      case "email":
        out[key] = val.email;
        break;
      case "phone_number":
        out[key] = val.phone_number;
        break;
      case "people":
        out[key] = (val.people || []).map(p => p.name || p.id);
        break;
      case "relation":
        out[key] = (val.relation || []).map(r => r.id);
        break;
      default:
        out[key] = `[${val.type}]`;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function getToolDefinitions() {
  return TOOLS.map(t => t.definition);
}

function getToolSummary() {
  return {
    total:  TOOLS.length,
    write:  TOOLS.filter(t => t.isWrite).length,
    read:   TOOLS.filter(t => !t.isWrite).length,
    names:  TOOLS.map(t => t.definition.name),
  };
}

function getTool(name) {
  return TOOLS.find(t => t.definition.name === name) || null;
}

function isWriteTool(name) {
  const t = getTool(name);
  return t ? t.isWrite : false;
}

function getApprovalSummary(name, input) {
  const t = getTool(name);
  if (!t || !t.approvalSummary) return null;
  try {
    return t.approvalSummary(input);
  } catch (err) {
    return `(failed to render approval summary: ${err.message})`;
  }
}

async function executeTool(name, input) {
  const t = getTool(name);
  if (!t) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    const result = await t.handler(input);
    return result;
  } catch (err) {
    return { error: `Tool execution failed: ${err.message}` };
  }
}

module.exports = {
  getToolDefinitions,
  getToolSummary,
  getTool,
  isWriteTool,
  getApprovalSummary,
  executeTool,
  PROXY_URL,
};
