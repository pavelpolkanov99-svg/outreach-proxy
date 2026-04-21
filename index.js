const express = require("express");
const axios   = require("axios");
const cron    = require("node-cron");
const app     = express();

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Cache-Control");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Notion config ─────────────────────────────────────────────────────────────
const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const NOTION_VERSION      = "2022-06-28";
const NOTION_COMPANIES_DB = "f9b59c5b05fa4df18f9569479633fd74";
const NOTION_PEOPLE_DB    = "f36b2a0f0ab241cebbdbd1d0874a55be";

function notionHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// ── Apollo helpers ────────────────────────────────────────────────────────────
function filterPerson(p) {
  const org = p.organization || {};
  return {
    id: p.id,
    name: p.name,
    firstName: p.first_name,
    lastName: p.last_name,
    title: p.title,
    seniority: p.seniority,
    email: p.email,
    emailStatus: p.email_status,
    linkedin: p.linkedin_url,
    location: [p.city, p.country].filter(Boolean).join(", "),
    company: p.organization_name || org.name,
    companyWebsite: org.website_url,
    companyLinkedin: org.linkedin_url,
    companyDescription: (org.short_description || "").slice(0, 200),
    companyEmployees: org.estimated_num_employees,
    companyRevenue: org.annual_revenue_printed,
    companyIndustry: org.industry,
    companyFounded: org.founded_year,
    companyKeywords: (org.keywords || []).slice(0, 20),
    latestFunding: org.latest_funding_stage,
    latestFundingDate: org.latest_funding_round_date,
    totalFunding: org.total_funding_printed,
  };
}

// ── Apollo: POST /apollo/search ───────────────────────────────────────────────
app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });
  try {
    const r = await axios.post(
      "https://api.apollo.io/api/v1/mixed_people/api_search",
      { q_keywords: name + (company ? " " + company : ""), page: 1, per_page: 5 },
      { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 15000 }
    );
    res.json((r.data?.people || []).map(filterPerson));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── Apollo: POST /apollo/match ────────────────────────────────────────────────
app.post("/apollo/match", async (req, res) => {
  const { apolloKey, firstName, lastName, organizationName, domain, linkedinUrl } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });
  try {
    const r = await axios.post(
      "https://api.apollo.io/api/v1/people/match",
      { first_name: firstName, last_name: lastName, organization_name: organizationName, domain, linkedin_url: linkedinUrl },
      { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 15000 }
    );
    const p = r.data?.person;
    if (!p) return res.json(null);
    res.json(filterPerson(p));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── HeyReach proxy: POST /heyreach/proxy ──────────────────────────────────────
app.post("/heyreach/proxy", async (req, res) => {
  const { hrKey, path, payload } = req.body;
  if (!hrKey || !path) return res.status(400).json({ error: "hrKey and path required" });
  try {
    const r = await axios.post(
      `https://api.heyreach.io/api/public${path}`,
      payload || {},
      { headers: { "X-API-KEY": hrKey, "Content-Type": "application/json" }, timeout: 20000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── Notion: GET /notion/db-schema ─────────────────────────────────────────────
app.get("/notion/db-schema", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  try {
    const [companies, people] = await Promise.all([
      axios.get(`https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}`, { headers: notionHeaders() }),
      axios.get(`https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}`, { headers: notionHeaders() }),
    ]);
    const extract = (db) => Object.entries(db.data.properties).map(([name, prop]) => ({ name, type: prop.type }));
    res.json({ companies: extract(companies), people: extract(people) });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/upsert-lead ─────────────────────────────────────────
app.post("/notion/upsert-lead", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const {
    firstName, lastName, title, company,
    companyWebsite, companyLinkedin, companyDescription,
    linkedin, email, status = "Not Started"
  } = req.body;
  const nameOverride = req.body.name;
  const roleOverride = req.body.role;
  try {
    let companyPageId = null;
    if (company) {
      const searchCompany = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
        { filter: { property: "Company name", title: { equals: company } }, page_size: 1 },
        { headers: notionHeaders() }
      );
      if (searchCompany.data.results.length > 0) {
        companyPageId = searchCompany.data.results[0].id;
      } else {
        const companyProps = {
          "Company name": { title: [{ text: { content: company } }] },
          "Stage": { status: { name: status } },
        };
        if (companyWebsite) companyProps["Website"] = { url: companyWebsite };
        if (companyLinkedin) companyProps["Discovery Card"] = { url: companyLinkedin };
        if (companyDescription) companyProps["Company description"] = { rich_text: [{ text: { content: companyDescription } }] };
        const newCompany = await axios.post(
          "https://api.notion.com/v1/pages",
          { parent: { database_id: NOTION_COMPANIES_DB }, properties: companyProps },
          { headers: notionHeaders() }
        );
        companyPageId = newCompany.data.id;
      }
    }
    const fullName = nameOverride || [firstName, lastName].filter(Boolean).join(" ");
    const personProps = { "Name": { title: [{ text: { content: fullName } }] } };
    const roleValue = title || roleOverride;
    if (roleValue) personProps["Role"] = { rich_text: [{ text: { content: roleValue } }] };
    if (linkedin) personProps["LinkedIn"] = { url: linkedin };
    if (email) personProps["Email"] = { email };
    if (companyPageId) personProps["Company"] = { relation: [{ id: companyPageId }] };
    const searchPerson = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      { filter: { property: "Name", title: { equals: fullName } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    let personPageId = null;
    if (searchPerson.data.results.length > 0) {
      personPageId = searchPerson.data.results[0].id;
      await axios.patch(`https://api.notion.com/v1/pages/${personPageId}`, { properties: personProps }, { headers: notionHeaders() });
    } else {
      const newPerson = await axios.post(
        "https://api.notion.com/v1/pages",
        { parent: { database_id: NOTION_PEOPLE_DB }, properties: personProps },
        { headers: notionHeaders() }
      );
      personPageId = newPerson.data.id;
    }
    res.json({ ok: true, companyPageId, personPageId });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/update-status ───────────────────────────────────────
app.post("/notion/update-status", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { company, status } = req.body;
  if (!company || !status) return res.status(400).json({ error: "company and status required" });
  try {
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { equals: company } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0) return res.status(404).json({ error: "Company not found in CRM" });
    const pageId = search.data.results[0].id;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Stage": { status: { name: status } } } }, { headers: notionHeaders() });
    res.json({ ok: true, pageId });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/update-notes ────────────────────────────────────────
app.post("/notion/update-notes", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, db = "people", notes } = req.body;
  if (!name || !notes) return res.status(400).json({ error: "name and notes required" });
  const dbId = db === "companies" ? NOTION_COMPANIES_DB : NOTION_PEOPLE_DB;
  const titleField = db === "companies" ? "Company name" : "Name";
  try {
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      { filter: { property: titleField, title: { equals: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0) return res.status(404).json({ error: `${name} not found in CRM ${db}` });
    const pageId = search.data.results[0].id;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Notes": { rich_text: [{ text: { content: notes } }] } } }, { headers: notionHeaders() });
    res.json({ ok: true, pageId });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/update-tags ─────────────────────────────────────────
app.post("/notion/update-tags", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, db = "companies", tags, mode = "add" } = req.body;
  if (!name || !tags?.length) return res.status(400).json({ error: "name and tags required" });
  const dbId = db === "companies" ? NOTION_COMPANIES_DB : NOTION_PEOPLE_DB;
  const titleField = db === "companies" ? "Company name" : "Name";
  try {
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      { filter: { property: titleField, title: { equals: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0) return res.status(404).json({ error: `${name} not found` });
    const page = search.data.results[0];
    let finalTags = tags.map(t => ({ name: t }));
    if (mode === "add") {
      const existing = (page.properties?.Tags?.multi_select || []).map(t => t.name);
      finalTags = [...new Set([...existing, ...tags])].map(t => ({ name: t }));
    }
    await axios.patch(`https://api.notion.com/v1/pages/${page.id}`, { properties: { "Tags": { multi_select: finalTags } } }, { headers: notionHeaders() });
    res.json({ ok: true, pageId: page.id, tags: finalTags.map(t => t.name) });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/search-company ──────────────────────────────────────
app.post("/notion/search-company", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    let search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { equals: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0) {
      search = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
        { filter: { property: "Company name", title: { contains: name.split(" ")[0] } }, page_size: 5 },
        { headers: notionHeaders() }
      );
    }
    if (search.data.results.length === 0) return res.json({ found: false });
    const page = search.data.results[0];
    res.json({
      found: true,
      id: page.id,
      name: page.properties["Company name"]?.title?.[0]?.text?.content || name,
      stage: page.properties["Stage"]?.status?.name,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/append-note ─────────────────────────────────────────
app.post("/notion/append-note", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, note, db = "companies" } = req.body;
  if (!name || !note) return res.status(400).json({ error: "name and note required" });
  const dbId = db === "companies" ? NOTION_COMPANIES_DB : NOTION_PEOPLE_DB;
  const titleField = db === "companies" ? "Company name" : "Name";
  try {
    let search = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      { filter: { property: titleField, title: { equals: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0 && db === "companies") {
      search = await axios.post(
        `https://api.notion.com/v1/databases/${dbId}/query`,
        { filter: { property: titleField, title: { contains: name.split(" ")[0] } }, page_size: 1 },
        { headers: notionHeaders() }
      );
    }
    if (search.data.results.length === 0) return res.status(404).json({ error: `${name} not found in ${db} DB` });
    const page = search.data.results[0];
    const pageId = page.id;
    const resolvedName = page.properties[titleField]?.title?.[0]?.text?.content || name;
    const existing = (page.properties?.Notes?.rich_text || []).map(rt => rt.plain_text || rt.text?.content || "").join("");
    const separator = existing ? "\n---\n" : "";
    let combined = existing + separator + note;
    if (combined.length > 2000) combined = combined.slice(combined.length - 2000);
    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Notes": { rich_text: [{ text: { content: combined } }] } } },
      { headers: notionHeaders() }
    );
    res.json({ ok: true, pageId, resolvedName, noteLength: note.length, totalLength: combined.length });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/query ────────────────────────────────────────────────
app.post("/notion/query", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { db_id, filter, sorts, page_size = 20 } = req.body;
  if (!db_id) return res.status(400).json({ error: "db_id required" });
  try {
    const payload = { page_size };
    if (filter) payload.filter = filter;
    if (sorts) payload.sorts = sorts;
    const r = await axios.post(`https://api.notion.com/v1/databases/${db_id}/query`, payload, { headers: notionHeaders() });
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Parallel config ───────────────────────────────────────────────────────────
const PARALLEL_KEY = process.env.PARALLEL_KEY;

function parallelHeaders() {
  return { "Authorization": `Bearer ${PARALLEL_KEY}`, "Content-Type": "application/json" };
}

function buildResearchQuery(company, domain) {
  return [
    `You are a B2B fintech analyst qualifying "${company}"${domain ? ` (${domain})` : ""} as a potential client or partner for Plexo — a Stablecoin Clearing Network for licensed financial institutions.`,
    `Plexo enables compliant cross-border stablecoin settlements (USDC/USDT/EURC) between licensed FIs.`,
    `Research this company and answer ONLY the following scoring questions. For each, provide a factual answer with source URL. If not found, say NOT FOUND.`,
    `AXIS 1 — Cross-Border Payments Core: Does this company process cross-border B2B payments as a core business? Any volume or corridor data?`,
    `AXIS 2 — On/Off Ramp: Do they convert between fiat and stablecoins/crypto? Any USDC/USDT/EURC ramp infrastructure?`,
    `AXIS 3 — Stablecoin Alignment: Any public stablecoin activity in last 12 months? Pilots, integrations, announcements, partnerships with Circle/Tether/Paxos?`,
    `AXIS 4 — Corridors: Which geographic corridors do they operate in?`,
    `AXIS 5 — Network Role: Are they likely an Originating FI, Destination FI, or Beneficiary FI?`,
    `AXIS 6 — Regulatory Licenses: What licenses do they hold? (EMI, PI, MSB, VASP, MiCA CASP, PSD2, banking license) Which jurisdictions?`,
    `AXIS 7 — B2B Scale: Do they serve businesses (not retail)? Any employee count, revenue, or transaction volume signals?`,
    `AXIS 8 — Competitive Proximity: Are they a potential competitor to Plexo or clearly a client/partner?`,
    `HARD KILL CHECK: Is this company ONLY doing: RWA tokenization, DeFi without KYC, custody/trading only, consulting, payroll, retail on-ramp widget, or compliance SaaS? If yes, say HARD KILL and why.`,
    `STRATEGIC SIGNAL: Any recent signal (last 12 months) suggesting urgency — new funding, hiring payments/crypto roles, regulatory approval, expansion announcement?`,
  ].join(" ");
}

const parallelTaskSpec = {
  output_schema: {
    type: "json",
    json_schema: {
      type: "object",
      properties: {
        axis1_xborder_core:         { type: "string" },
        axis2_ramp:                 { type: "string" },
        axis3_stablecoin_alignment: { type: "string" },
        axis4_corridors:            { type: "string" },
        axis5_network_role:         { type: "string" },
        axis6_licenses:             { type: "string" },
        axis7_b2b_scale:            { type: "string" },
        axis8_competitive:          { type: "string" },
        hard_kill:                  { type: "string" },
        strategic_signal:           { type: "string" },
        sources:                    { type: "array", items: { type: "string" } },
      }
    }
  }
};

app.post("/parallel/research/start", async (req, res) => {
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

app.get("/parallel/result/:taskId", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { taskId } = req.params;
  try {
    const statusRes = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}`, { headers: parallelHeaders(), timeout: 15000 });
    const status = statusRes.data?.status;
    const done   = status === "completed" || status === "succeeded";
    const failed = status === "failed" || status === "error";
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

app.post("/parallel/insight/start", async (req, res) => {
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

app.post("/parallel/score", async (req, res) => {
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

app.post("/parallel/upgrade", async (req, res) => {
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

// ── HeyReach Webhooks → Notion ────────────────────────────────────────────────
app.post("/webhook/heyreach", async (req, res) => {
  res.json({ ok: true });
  const { eventType, lead, campaignId } = req.body || {};
  if (!eventType || !lead) return;
  const company = lead.companyName;
  if (!company) return;
  console.log(`[webhook] ${eventType} — ${lead.firstName} ${lead.lastName} @ ${company}`);
  try {
    const newStatus = (eventType === "CONNECTION_REQUEST_ACCEPTED" || eventType === "MESSAGE_REPLY_RECEIVED")
      ? "Initial Discussion" : null;
    if (!newStatus || !NOTION_TOKEN) return;
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { equals: company } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0) return;
    const pageId = search.data.results[0].id;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Stage": { status: { name: newStatus } } } }, { headers: notionHeaders() });
    const note = eventType === "CONNECTION_REQUEST_ACCEPTED"
      ? `✅ Connection accepted by ${lead.firstName} ${lead.lastName} (Campaign ID: ${campaignId})`
      : `💬 Reply received from ${lead.firstName} ${lead.lastName} (Campaign ID: ${campaignId})`;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Notes": { rich_text: [{ text: { content: note } }] } } }, { headers: notionHeaders() });
    console.log(`[webhook] Notion updated: ${company} → ${newStatus}`);
  } catch (err) {
    console.error("[webhook] Notion update failed:", err.response?.data?.message || err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BEEPER INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════
const BEEPER_URL   = process.env.BEEPER_URL   || "http://localhost:23373";
const BEEPER_TOKEN = process.env.BEEPER_TOKEN;

function beeperHeaders() {
  return {
    "Authorization": `Bearer ${BEEPER_TOKEN}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

// Checks if accountID belongs to WhatsApp (handles "whatsapp" and "local-whatsapp_ba_...")
function isWhatsApp(id) { return id && id.includes("whatsapp"); }
function isTelegram(id) { return id === "telegram"; }
function isLinkedIn(id) { return id === "linkedin"; }

function netLabel(id) {
  if (isWhatsApp(id)) return "WA";
  if (isTelegram(id)) return "TG";
  if (isLinkedIn(id)) return "LI";
  return id || "?";
}

function fuzzyMatch(chatName, targetName) {
  if (!chatName || !targetName) return false;
  const a = chatName.toLowerCase().trim();
  const b = targetName.toLowerCase().trim();
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = b.split(/[\s,.|&<>x\-]+/).filter(w => w.length > 3);
  return words.some(w => a.includes(w));
}

function formatMessages(items = [], limit = 9999) {
  return items
    .slice(0, limit)
    .reverse()
    .map(m => {
      const time   = m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : "?";
      const sender = m.sender?.fullName || m.sender?.displayName || m.sender?.id || "?";
      const text   = m.content?.text || m.content?.body || "";
      return text ? `[${time}] ${sender}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

// MCP headers — Beeper requires both application/json and text/event-stream
function beeperMcpHeaders() {
  return {
    "Authorization": `Bearer ${BEEPER_TOKEN}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
}

// Parse SSE response from Beeper MCP into JSON
function parseMcpSse(rawText) {
  // SSE format: lines starting with "data: "
  const lines = rawText.split('\n').filter(l => l.startsWith('data: '));
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6));
      if (json.result) return json.result;
      if (json.error) throw new Error(json.error.message);
    } catch (_) {}
  }
  // Try parsing as plain JSON if not SSE
  try { return JSON.parse(rawText); } catch (_) {}
  return null;
}

// Helper: fetch messages via Beeper MCP (since /v1/messages doesn't exist)
async function beeperGetMessages(chatID, limit = 9999) {
  const rpcBody = {
    jsonrpc: "2.0", id: Date.now(),
    method: "tools/call",
    params: { name: "list_messages", arguments: { chatID, limit } }
  };
  const r = await axios.post(
    `${BEEPER_URL}/v0/mcp`,
    rpcBody,
    { headers: beeperMcpHeaders(), timeout: 30000, responseType: "text" }
  );
  const result = parseMcpSse(r.data);
  if (!result) return [];
  // result.content is array of {type, text} blocks
  const content = result.content || result;
  const textBlock = Array.isArray(content) ? content.find(c => c.type === "text") : null;
  const rawText = textBlock?.text || (typeof content === "string" ? content : null);
  if (!rawText) return [];
  try {
    const parsed = JSON.parse(rawText);
    return parsed.messages || parsed.items || (Array.isArray(parsed) ? parsed : []);
  } catch {
    // Return raw text as single message
    return [{ senderName: "system", text: rawText, timestamp: Date.now() }];
  }
}
app.get("/beeper/health", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/info`, { headers: beeperHeaders(), timeout: 5000 });
    res.json({ ok: true, beeper: r.data?.app, mcp: r.data?.server?.mcp_enabled, url: BEEPER_URL });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ── GET /beeper/chats — список всех чатов, все сети, без лимитов ──────────────
// Query params: network (wa|tg|li|all), type (group|single|all), limit (default 500)
app.get("/beeper/chats", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { network = "all", type = "all", limit = 500 } = req.query;
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=${limit}`, { headers: beeperHeaders(), timeout: 15000 });
    let items = r.data?.items || [];

    // Filter by network
    if (network === "wa")   items = items.filter(c => isWhatsApp(c.accountID));
    else if (network === "tg") items = items.filter(c => isTelegram(c.accountID));
    else if (network === "li") items = items.filter(c => isLinkedIn(c.accountID));

    // Filter by type
    if (type === "group")  items = items.filter(c => c.type === "group");
    else if (type === "single") items = items.filter(c => c.type === "single");

    res.json({
      total: items.length,
      chats: items.map(c => ({
        id: c.id,
        name: c.title || c.name || "",
        type: c.type,
        network: netLabel(c.accountID),
        accountID: c.accountID,
        lastMessageAt: c.lastMessageAt || c.lastActivityAt || null,
      }))
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── GET /beeper/recent — последние N активных чатов ───────────────────────────
// Query params: limit (default 10), network (wa|tg|li|all)
app.get("/beeper/recent", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { limit = 10, network = "all" } = req.query;
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    let items = r.data?.items || [];

    if (network === "wa")   items = items.filter(c => isWhatsApp(c.accountID));
    else if (network === "tg") items = items.filter(c => isTelegram(c.accountID));
    else if (network === "li") items = items.filter(c => isLinkedIn(c.accountID));

    // Sort by last activity and take top N
    items = items
      .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0))
      .slice(0, parseInt(limit));

    // For each — fetch last message via MCP
    const result = await Promise.all(items.map(async c => {
      let lastMsg = "";
      try {
        const msgs = await beeperGetMessages(c.id, 1);
        const m = msgs[0];
        if (m) {
          const sender = m.sender?.fullName || m.sender?.displayName || m.senderName || "?";
          const text   = m.content?.text || m.content?.body || m.text || m.body || "";
          const time   = m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : "";
          lastMsg = `[${time}] ${sender}: ${text}`;
        }
      } catch (_) {}
      return {
        id: c.id,
        name: c.title || c.name || "",
        type: c.type,
        network: netLabel(c.accountID),
        lastMessage: lastMsg,
      };
    }));

    res.json({ total: result.length, chats: result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── GET /beeper/messages — все сообщения из конкретного чата (via MCP) ────────
// Query params: chatId (required), limit (default 9999 = all)
app.get("/beeper/messages", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { chatId, limit = 9999 } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  try {
    const items = await beeperGetMessages(chatId, parseInt(limit));
    const messages = items.map(m => ({
      id: m.id,
      sender: m.sender?.fullName || m.sender?.displayName || m.sender?.id || m.senderName || "?",
      text: m.content?.text || m.content?.body || m.text || m.body || "",
      time: m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : (m.time || "?"),
    })).filter(m => m.text);
    res.json({ chatId, total: messages.length, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /beeper/find-chat — найти чат по имени/компании ─────────────────────
// Body: { name: "OpenPayd" }  → ищет fuzzy match по всем сетям
app.post("/beeper/find-chat", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const items = r.data?.items || [];
    const matches = items.filter(c => fuzzyMatch(c.title || c.name || "", name));
    res.json({
      query: name,
      found: matches.length,
      chats: matches.map(c => ({
        id: c.id,
        name: c.title || c.name || "",
        type: c.type,
        network: netLabel(c.accountID),
        accountID: c.accountID,
      }))
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/get-conversation — найти чат + вернуть ВСЕ сообщения ─────────
// Body: { name: "OpenPayd", limit: 9999 }
// Это главный endpoint для "покажи переписку с X"
app.post("/beeper/get-conversation", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { name, limit = 9999 } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    // 1. Find chats
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const items = r.data?.items || [];
    const matches = items.filter(c => fuzzyMatch(c.title || c.name || "", name));
    if (matches.length === 0) return res.json({ ok: false, error: `No chats found matching "${name}"` });

    // 2. Fetch messages for each match
    const results = await Promise.all(matches.map(async c => {
      // Fetch messages via MCP
      const msgs = await beeperGetMessages(c.id, limit);
      const formatted = msgs
        .map(m => ({
          sender: m.sender?.fullName || m.sender?.displayName || m.sender?.id || m.senderName || "?",
          text: m.content?.text || m.content?.body || m.text || m.body || "",
          time: m.timestamp ? new Date(m.timestamp).toLocaleString("ru-RU") : (m.time || "?"),
        }))
        .filter(m => m.text)
        .reverse();
      return {
        chatName: c.title || c.name || "",
        network: netLabel(c.accountID),
        type: c.type,
        messageCount: msgs.length,
        messages: msgs,
      };
    }));

    res.json({ ok: true, query: name, chats: results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/send ─────────────────────────────────────────────────────────
app.post("/beeper/send", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { chatId, text } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: "chatId and text required" });
  try {
    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: "send_message", arguments: { chatID: chatId, text } }
    };
    const r = await axios.post(
      `${BEEPER_URL}/v0/mcp`,
      rpcBody,
      { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" }
    );
    res.json({ ok: true, result: r.data?.result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/search — поиск по всей истории ───────────────────────────────
app.post("/beeper/search", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  try {
    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: "search_messages", arguments: { query, limit: 50 } }
    };
    const r = await axios.post(
      `${BEEPER_URL}/v0/mcp`,
      rpcBody,
      { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" }
    );
    res.json({ ok: true, result: r.data?.result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/warm-cache ───────────────────────────────────────────────────
app.post("/beeper/warm-cache", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { depth = 200 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const chats = chatsRes.data?.items || [];
    console.log(`[warm-cache] Warming ${chats.length} chats, depth=${depth}`);
    let warmed = 0, failed = 0;
    for (const c of chats) {
      try {
        await beeperGetMessages(c.id, depth);
        warmed++;
      } catch (_) { failed++; }
    }
    res.json({ ok: true, total: chats.length, warmed, failed });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/sync-chats → Notion Companies ────────────────────────────────
app.post("/beeper/sync-chats", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { msgLimit = 10 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const allChats = chatsRes.data?.items || [];
    const relevant = allChats.filter(c => isWhatsApp(c.accountID) || isTelegram(c.accountID));
    console.log(`[sync-chats] ${relevant.length} WA+TG chats out of ${allChats.length} total`);

    const notionRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { page_size: 200 }, { headers: notionHeaders() }
    );
    const companies = notionRes.data.results.map(p => ({
      id: p.id,
      name: p.properties["Company name"]?.title?.[0]?.text?.content || "",
    })).filter(c => c.name);

    const seen = new Set();
    const results = [];

    for (const chat of relevant) {
      const chatName = chat.title || chat.name || "";
      const label    = netLabel(chat.accountID);
      const match    = companies.find(c => fuzzyMatch(chatName, c.name));
      if (!match) { results.push({ chat: chatName, network: label, status: "no_match" }); continue; }
      if (seen.has(match.id)) { results.push({ chat: chatName, network: label, company: match.name, status: "duplicate" }); continue; }
      seen.add(match.id);

      let msgText = "";
      try {
        const msgs = await beeperGetMessages(chat.id, msgLimit);
        msgText = formatMessages(msgs, msgLimit);
      } catch (e) { console.error(`[sync-chats] msg fetch failed for ${chatName}:`, e.message); }

      const note = `📱 ${label} ${chat.type === "group" ? "Group" : "DM"}: ${chatName}\n🕐 Synced: ${new Date().toLocaleDateString("ru-RU")}\n\n${msgText || "(no messages)"}`;
      try {
        await axios.patch(
          `https://api.notion.com/v1/pages/${match.id}`,
          { properties: { "Notes": { rich_text: [{ text: { content: note.slice(0, 2000) } }] } } },
          { headers: notionHeaders() }
        );
        results.push({ chat: chatName, network: label, company: match.name, status: "synced" });
        console.log(`[sync-chats] ✅ [${label}] "${chatName}" → ${match.name}`);
      } catch (e) {
        results.push({ chat: chatName, network: label, company: match.name, status: "notion_error", error: e.message });
      }
    }

    res.json({
      ok: true,
      synced:    results.filter(r => r.status === "synced").length,
      noMatch:   results.filter(r => r.status === "no_match").length,
      duplicate: results.filter(r => r.status === "duplicate").length,
      total:     relevant.length,
      results,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── POST /beeper/sync-linkedin → Notion People ────────────────────────────────
app.post("/beeper/sync-linkedin", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { msgLimit = 10 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
    const liChats = (chatsRes.data?.items || []).filter(c => isLinkedIn(c.accountID));
    console.log(`[sync-linkedin] ${liChats.length} LinkedIn chats`);

    const notionRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      { page_size: 200 }, { headers: notionHeaders() }
    );
    const people = notionRes.data.results.map(p => ({
      id: p.id,
      name: p.properties["Name"]?.title?.[0]?.text?.content || "",
    })).filter(p => p.name);

    const results = [];
    for (const chat of liChats) {
      const chatName = chat.title || chat.name || "";
      const match = people.find(p => fuzzyMatch(chatName, p.name));
      if (!match) { results.push({ chat: chatName, status: "no_match" }); continue; }
      let msgText = "";
      try {
        const msgs = await beeperGetMessages(chat.id, msgLimit);
        msgText = formatMessages(msgs, msgLimit);
      } catch (e) {}
      const note = `💼 LinkedIn DM: ${chatName}\n🕐 Synced: ${new Date().toLocaleDateString("ru-RU")}\n\n${msgText || "(no messages)"}`;
      try {
        await axios.patch(
          `https://api.notion.com/v1/pages/${match.id}`,
          { properties: { "Notes": { rich_text: [{ text: { content: note.slice(0, 2000) } }] } } },
          { headers: notionHeaders() }
        );
        results.push({ chat: chatName, person: match.name, status: "synced" });
        console.log(`[sync-linkedin] ✅ "${chatName}" → ${match.name}`);
      } catch (e) {
        results.push({ chat: chatName, person: match.name, status: "notion_error", error: e.message });
      }
    }
    res.json({ ok: true, synced: results.filter(r => r.status === "synced").length, noMatch: results.filter(r => r.status === "no_match").length, total: liChats.length, results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Beeper: POST /beeper/mcp-call — relay JSON-RPC to Beeper MCP ──────────────
app.post("/beeper/mcp-call", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { tool, params = {} } = req.body;
  if (!tool) return res.status(400).json({ error: "tool required" });
  try {
    const rpcBody = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: params } };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 30000, responseType: "text" });
    const result = parseMcpSse(r.data);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── Beeper: GET /beeper/mcp-tools — список доступных MCP tools ────────────────
app.get("/beeper/mcp-tools", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  try {
    const rpcBody = { jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" });
    const result = parseMcpSse(r.data);
    res.json({ ok: true, tools: result?.tools || result });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, detail: err.response?.data });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BEEPER CONVENIENCE ENDPOINTS — для чтения прямо из Claude без curl
// ══════════════════════════════════════════════════════════════════════════════

// GET /beeper/inbox?network=tg&limit=10
// Последние N активных чатов с последним сообщением каждого
app.get("/beeper/inbox", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { network = "all", limit = 10 } = req.query;
  try {
    const accountIDs = network === "tg" ? ["telegram"]
      : network === "wa" ? null   // both WA accounts
      : network === "li" ? ["linkedin"]
      : undefined;

    const rpcBody = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: {
        name: "search_chats",
        arguments: {
          ...(accountIDs ? { accountIDs } : {}),
          limit: parseInt(limit),
          inbox: "primary",
        }
      }
    };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpcBody, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
    const result = parseMcpSse(r.data);
    const text = result?.content?.[0]?.text || "";

    // Parse chat IDs from MCP text response
    const chatMatches = [...text.matchAll(/chatID: ([^\s\)]+)/g)];
    const chatIDs = chatMatches.map(m => m[1]);

    // Fetch last message for each
    const chats = await Promise.all(chatIDs.map(async chatID => {
      const chatName = text.match(new RegExp(`## ([^\\n]+) \\(chatID: ${chatID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))?.[1] || chatID;
      let lastMsg = "";
      try {
        const msgRpc = {
          jsonrpc: "2.0", id: Date.now(),
          method: "tools/call",
          params: { name: "list_messages", arguments: { chatID } }
        };
        const mr = await axios.post(`${BEEPER_URL}/v0/mcp`, msgRpc, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
        const msgResult = parseMcpSse(mr.data);
        const msgText = msgResult?.content?.[0]?.text || "";
        // Parse first item from JSON in text
        try {
          const parsed = JSON.parse(msgText);
          const first = parsed.items?.[0];
          if (first) {
            const t = new Date(first.timestamp).toLocaleString("ru-RU");
            const dir = first.isSender ? "→" : "←";
            lastMsg = `[${t}] ${dir} ${first.senderName}: ${first.text || "[медиа]"}`;
          }
        } catch (_) {
          lastMsg = msgText.slice(0, 100);
        }
      } catch (_) {}
      return { chatID, chatName, lastMsg };
    }));

    res.json({ ok: true, network, count: chats.length, chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /beeper/chat?name=OpenPayd&limit=50
// Вся переписка с конкретным контактом/компанией по имени
app.get("/beeper/chat", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { name, limit = 50 } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    // 1. Find chat by name
    const searchRpc = {
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: "search", arguments: { query: name } }
    };
    const sr = await axios.post(`${BEEPER_URL}/v0/mcp`, searchRpc, { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
    const searchResult = parseMcpSse(sr.data);
    const searchText = searchResult?.content?.[0]?.text || "";

    // Extract chatIDs from search results
    const chatMatches = [...searchText.matchAll(/chatID: ([^\s\)]+)/g)];
    if (chatMatches.length === 0) return res.json({ ok: false, error: `Чат "${name}" не найден` });

    // 2. Get messages for each found chat
    const results = await Promise.all(chatMatches.slice(0, 3).map(async m => {
      const chatID = m[1];
      const chatName = searchText.match(new RegExp(`## ([^\\n]+) \\(chatID: ${chatID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))?.[1] || chatID;

      const msgRpc = {
        jsonrpc: "2.0", id: Date.now(),
        method: "tools/call",
        params: { name: "list_messages", arguments: { chatID } }
      };
      const mr = await axios.post(`${BEEPER_URL}/v0/mcp`, msgRpc, { headers: beeperMcpHeaders(), timeout: 30000, responseType: "text" });
      const msgResult = parseMcpSse(mr.data);
      const msgText = msgResult?.content?.[0]?.text || "";

      let messages = [];
      try {
        const parsed = JSON.parse(msgText);
        messages = (parsed.items || []).slice(0, parseInt(limit)).map(m => ({
          time: new Date(m.timestamp).toLocaleString("ru-RU"),
          sender: m.senderName,
          text: m.text || "[медиа]",
          isSender: m.isSender,
          isUnread: m.isUnread,
        }));
      } catch (_) {}

      return { chatID, chatName, messageCount: messages.length, messages };
    }));

    res.json({ ok: true, query: name, chats: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── node-cron: auto warm-cache weekdays 09:00 EET ─────────────────────────────
if (BEEPER_TOKEN) {
  cron.schedule("0 9 * * 1-5", async () => {
    console.log("[cron] warm-cache start");
    try {
      const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=500`, { headers: beeperHeaders(), timeout: 15000 });
      const chats = r.data?.items || [];
      let warmed = 0;
      for (const c of chats) {
        try {
          await beeperGetMessages(c.id, 200);
          warmed++;
        } catch (_) {}
      }
      console.log(`[cron] warm-cache done: ${warmed}/${chats.length}`);
    } catch (e) { console.error("[cron] warm-cache failed:", e.message); }
  }, { timezone: "Europe/Tallinn" });
  console.log("[cron] warm-cache registered (weekdays 09:00 EET)");
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  ok: true,
  notion:   !!NOTION_TOKEN,
  parallel: !!PARALLEL_KEY,
  beeper:   !!BEEPER_TOKEN,
}));
app.get("/", (_, res) => res.json({ service: "outreach-proxy", version: "3.5", status: "ok" }));


// ══════════════════════════════════════════════════════════════════════════════
// BEEPER → NOTION SYNC ENGINE
// ══════════════════════════════════════════════════════════════════════════════

const MESSAGES_HUB_DB = "8617a441c4254b41be671a1e65946a03";
const COMPANIES_DB_ID  = "f9b59c5b05fa4df18f9569479633fd74";
const PEOPLE_DB_ID     = "f36b2a0f0ab241cebbdbd1d0874a55be";
const DISCOVERY_CARD_PATTERN = /notion\.so\/plex0\/Discovery-Card/i;
const CALENDLY_PATTERN = /calendly\.com\/plex0\//i;

let lastSyncAt = null;

function networkFromAccountID(accountID = "") {
  if (accountID === "telegram") return "Telegram";
  if (accountID.includes("linkedin")) return "LinkedIn";
  return "WhatsApp";
}

function extractCompanyName(chatName = "") {
  return chatName
    .replace(/RemiDe|Remide|Plexo|plexo/gi, "")
    .replace(/<>|<=>|x\s/gi, "|")
    .split("|")[0]
    .replace(/[<>]/g, "")
    .trim();
}

// Notion API helpers using axios (no SDK)
async function notionQuery(dbId, filter, pageSize = 1) {
  const r = await axios.post(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    { filter, page_size: pageSize },
    { headers: notionHeaders(), timeout: 10000 }
  );
  return r.data.results || [];
}

async function notionCreatePage(dbId, properties) {
  const r = await axios.post(
    "https://api.notion.com/v1/pages",
    { parent: { database_id: dbId }, properties },
    { headers: notionHeaders(), timeout: 10000 }
  );
  return r.data;
}

async function notionUpdatePage(pageId, properties) {
  const r = await axios.patch(
    `https://api.notion.com/v1/pages/${pageId}`,
    { properties },
    { headers: notionHeaders(), timeout: 10000 }
  );
  return r.data;
}

async function findNotionCompany(name) {
  if (!name || name.length < 2) return null;
  try {
    const results = await notionQuery(COMPANIES_DB_ID, {
      property: "Company name",
      title: { contains: name.slice(0, 30) }
    });
    return results[0]?.id || null;
  } catch (_) { return null; }
}

async function findNotionPeopleByNames(names = []) {
  const ids = [];
  for (const name of names.slice(0, 5)) {
    const clean = name.replace(/@.*/, "").trim();
    if (!clean || clean.length < 2) continue;
    try {
      const results = await notionQuery(PEOPLE_DB_ID, {
        property: "Name",
        title: { contains: clean.slice(0, 30) }
      });
      if (results[0]?.id) ids.push(results[0].id);
    } catch (_) {}
  }
  return ids;
}

async function findHubByRemoteId(remoteId) {
  try {
    const results = await notionQuery(MESSAGES_HUB_DB, {
      property: "Remote ID",
      rich_text: { equals: remoteId }
    });
    return results[0]?.id || null;
  } catch (_) { return null; }
}

async function getChatParticipantNames(chatID) {
  try {
    const rpc = { jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name: "get_chat", arguments: { chatID, maxParticipantCount: 10 } } };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpc,
      { headers: beeperMcpHeaders(), timeout: 10000, responseType: "text" });
    const result = parseMcpSse(r.data);
    const text = result?.content?.[0]?.text || "";
    const names = [];
    for (const m of text.matchAll(/[-•*]\s+([A-Za-zА-Яа-я][^\n,@(]{2,30})/g)) {
      const n = m[1].trim();
      if (!/plexo|remide|anton|pavel/i.test(n)) names.push(n);
    }
    return names;
  } catch (_) { return []; }
}

async function checkLinksInChat(chatID) {
  const result = { discoveryCard: false, calendly: false };
  try {
    const rpc = { jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name: "list_messages", arguments: { chatID } } };
    const r = await axios.post(`${BEEPER_URL}/v0/mcp`, rpc,
      { headers: beeperMcpHeaders(), timeout: 20000, responseType: "text" });
    const msgResult = parseMcpSse(r.data);
    const msgText = msgResult?.content?.[0]?.text || "";
    let items = [];
    try { items = JSON.parse(msgText)?.items || []; } catch (_) {}
    for (const msg of items) {
      const text = msg.text || "";
      if (!result.discoveryCard && DISCOVERY_CARD_PATTERN.test(text)) result.discoveryCard = true;
      if (!result.calendly && CALENDLY_PATTERN.test(text)) result.calendly = true;
      if (result.discoveryCard && result.calendly) break;
    }
  } catch (_) {}
  return result;
}

async function upsertChatToHub(chatInfo) {
  const { chatName, chatID, accountID, lastMsg, lastActiveDate } = chatInfo;
  const net = networkFromAccountID(accountID);
  const companyName = extractCompanyName(chatName);
  const companyId = await findNotionCompany(companyName);
  const participantNames = await getChatParticipantNames(chatID);
  const personIds = await findNotionPeopleByNames(participantNames);
  const links = await checkLinksInChat(chatID);

  let lastMsgText = "", rawSender = "", lastDate = lastActiveDate || null;
  if (lastMsg) {
    const timeM = lastMsg.match(/\[(\d{2})\.(\d{2})\.(\d{4})/);
    if (timeM) lastDate = `${timeM[3]}-${timeM[2]}-${timeM[1]}`;
    const senderM = lastMsg.match(/[→←]\s+([^:]+):/);
    rawSender = senderM?.[1]?.trim() || "";
    lastMsgText = lastMsg.replace(/^\[.*?\]\s*[→←]\s*[^:]+:\s*/, "").trim().slice(0, 500);
  }

  const props = {
    "Chat Name":  { title:        [{ text: { content: chatName || "Unknown" } }] },
    "Remote ID":  { rich_text:    [{ text: { content: chatID } }] },
    "Network":    { multi_select: [{ name: net }] },
    "Status":     { status:       { name: "Active" } },
  };
  if (lastMsgText) props["Last Message"]    = { rich_text: [{ text: { content: lastMsgText } }] };
  if (rawSender)   props["Raw Sender Name"] = { rich_text: [{ text: { content: rawSender } }] };
  if (lastDate)    props["Last Active"]     = { date: { start: lastDate } };
  if (companyId)   props["Link: Companies"] = { relation: [{ id: companyId }] };
  if (personIds.length) props["Link: People"] = { relation: personIds.map(id => ({ id })) };
  if (participantNames.length)
    props["Participants"] = { rich_text: [{ text: { content: participantNames.join(", ").slice(0, 500) } }] };
  if (links.discoveryCard) props["DiscoveryCard"] = { checkbox: true };
  if (links.calendly)      props["Calendly"] = { checkbox: true };

  const existingId = await findHubByRemoteId(chatID);
  if (existingId) {
    await notionUpdatePage(existingId, props);
    return { action: "updated", chatName };
  } else {
    await notionCreatePage(MESSAGES_HUB_DB, props);
    return { action: "created", chatName };
  }
}

async function runBeeperSync(opts = {}) {
  const { since, limit = 100 } = opts;
  if (!BEEPER_TOKEN) throw new Error("BEEPER_TOKEN not set");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=${limit}`,
    { headers: beeperHeaders(), timeout: 15000 });
  const allChats = chatsRes.data?.items || [];
  const sinceDate = since ? new Date(since) : null;
  const filtered = allChats.filter(c => {
    if (!sinceDate) return true;
    const ts = c.lastActivityAt || c.lastActivity || c.updatedAt;
    if (!ts) return true;
    return new Date(ts) > sinceDate;
  });

  console.log(`[sync] ${allChats.length} total chats, ${filtered.length} to sync`);

  for (const c of filtered) {
    try {
      // Получаем последнее сообщение
      const rpc = { jsonrpc: "2.0", id: Date.now(), method: "tools/call",
        params: { name: "list_messages", arguments: { chatID: c.id } } };
      const mr = await axios.post(`${BEEPER_URL}/v0/mcp`, rpc,
        { headers: beeperMcpHeaders(), timeout: 15000, responseType: "text" });
      const msgResult = parseMcpSse(mr.data);
      const msgText = msgResult?.content?.[0]?.text || "";
      let lastMsg = "", lastActiveDate = null;
      try {
        const parsed = JSON.parse(msgText);
        const first = parsed.items?.[0];
        if (first) {
          const t = new Date(first.timestamp);
          lastActiveDate = t.toISOString().split("T")[0];
          lastMsg = `[${t.toLocaleString("ru-RU")}] ${first.isSender ? "→" : "←"} ${first.senderName}: ${first.text || "[медиа]"}`;
        }
      } catch (_) {}

      const r = await upsertChatToHub({
        chatName: c.title || c.name || "Unknown",
        chatID: c.id, accountID: c.accountID,
        lastMsg, lastActiveDate,
      });
      if (r.action === "created") results.created++;
      else results.updated++;
      console.log(`[sync] ${r.action}: ${r.chatName}`);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      const errMsg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      console.error(`[sync] ERROR ${c.title || c.id}: ${errMsg}`);
      results.errors.push(`${c.title || c.id}: ${errMsg}`);
      results.skipped++;
    }
  }

  lastSyncAt = new Date().toISOString();
  return results;
}

// ── POST /beeper/sync-to-notion ───────────────────────────────────────────────
app.post("/beeper/sync-to-notion", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { since, limit = 100 } = req.body || {};
  console.log(`[sync] Manual sync triggered since=${since || "all"}`);
  try {
    const results = await runBeeperSync({ since, limit });
    res.json({ ok: true, ...results, lastSyncAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /beeper/sync-status ───────────────────────────────────────────────────
app.get("/beeper/sync-status", (_, res) =>
  res.json({ ok: true, lastSyncAt, nextSync: "hourly cron" })
);

// ── node-cron: Beeper→Notion sync every hour ──────────────────────────────────
if (BEEPER_TOKEN && NOTION_TOKEN) {
  cron.schedule("0 * * * *", async () => {
    console.log("[cron] Beeper→Notion sync start");
    try {
      const since = lastSyncAt || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const results = await runBeeperSync({ since, limit: 100 });
      console.log(`[cron] sync done: +${results.created} created, ~${results.updated} updated, ${results.skipped} skipped`);
    } catch (e) { console.error("[cron] sync failed:", e.message); }
  });
  console.log("[cron] Beeper→Notion sync registered (every hour)");

  // Catch-up sync при старте — последние 7 дней
  setTimeout(async () => {
    console.log("[startup] Running catch-up sync (last 7 days)...");
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const results = await runBeeperSync({ since, limit: 100 });
      console.log(`[startup] catch-up done: +${results.created} created, ~${results.updated} updated`);
    } catch (e) { console.error("[startup] catch-up failed:", e.message); }
  }, 90000); // 90s delay — proxy starts first
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
