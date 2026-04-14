const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Cache-Control");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Notion config ─────────────────────────────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";
const NOTION_COMPANIES_DB = "f9b59c5b05fa4df18f9569479633fd74";
const NOTION_PEOPLE_DB = "f36b2a0f0ab241cebbdbd1d0874a55be";

function notionHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// ── Apollo filter ─────────────────────────────────────────────────────────────
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

// ── Apollo search ─────────────────────────────────────────────────────────────
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

// ── Apollo enrich ─────────────────────────────────────────────────────────────
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

// ── HeyReach proxy ────────────────────────────────────────────────────────────
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

// ── Notion: POST /notion/upsert-lead ──────────────────────────────────────────
app.post("/notion/upsert-lead", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const {
    firstName, lastName, title, company,
    companyWebsite, companyLinkedin, companyDescription,
    linkedin, email, status = "Connection Sent"
  } = req.body;

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

    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const personProps = { "Name": { title: [{ text: { content: fullName } }] } };
    if (title) personProps["Role"] = { rich_text: [{ text: { content: title } }] };
    if (linkedin) personProps["LinkedIn"] = { url: linkedin };
    if (email) personProps["Email"] = { email: email };
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
    const pageId = page.id;
    let finalTags = tags.map(t => ({ name: t }));
    if (mode === "add") {
      const existing = (page.properties?.Tags?.multi_select || []).map(t => t.name);
      finalTags = [...new Set([...existing, ...tags])].map(t => ({ name: t }));
    }
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Tags": { multi_select: finalTags } } }, { headers: notionHeaders() });
    res.json({ ok: true, pageId, tags: finalTags.map(t => t.name) });
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
// Appends a timestamped note to the Notes field of a company or person page.
// Finds the page by name (exact match, then contains fallback for companies).
// Body: { name, note, db? }
//   name  — company name (db=companies) or person name (db=people)
//   note  — text to append
//   db    — "companies" (default) | "people"
//
// Behaviour:
//   1. Finds the page in the target DB
//   2. Reads the existing Notes rich_text value
//   3. Appends "\n---\n{note}" to the existing content (preserves history)
//   4. Writes the combined text back (Notion rich_text max 2000 chars — we truncate from the front if needed)
app.post("/notion/append-note", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, note, db = "companies" } = req.body;
  if (!name || !note) return res.status(400).json({ error: "name and note required" });

  const dbId = db === "companies" ? NOTION_COMPANIES_DB : NOTION_PEOPLE_DB;
  const titleField = db === "companies" ? "Company name" : "Name";

  try {
    // 1. Find page — exact match first, then contains fallback (companies only)
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
    if (search.data.results.length === 0) {
      return res.status(404).json({ error: `${name} not found in ${db} DB` });
    }

    const page = search.data.results[0];
    const pageId = page.id;
    const resolvedName = page.properties[titleField]?.title?.[0]?.text?.content || name;

    // 2. Read existing Notes value
    const existing = (page.properties?.Notes?.rich_text || [])
      .map(rt => rt.plain_text || rt.text?.content || "")
      .join("");

    // 3. Build combined text — separator between old and new
    const separator = existing ? "\n---\n" : "";
    let combined = existing + separator + note;

    // 4. Notion rich_text property max = 2000 chars — trim from the front if over
    if (combined.length > 2000) {
      combined = combined.slice(combined.length - 2000);
    }

    // 5. Write back
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
// Generic DB query — used by email sync (Sinker) and other internal tools.
// Body: { db_id, filter?, sorts?, page_size? }
app.post("/notion/query", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { db_id, filter, sorts, page_size = 20 } = req.body;
  if (!db_id) return res.status(400).json({ error: "db_id required" });
  try {
    const payload = { page_size };
    if (filter) payload.filter = filter;
    if (sorts) payload.sorts = sorts;
    const r = await axios.post(
      `https://api.notion.com/v1/databases/${db_id}/query`,
      payload,
      { headers: notionHeaders() }
    );
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
    `You are a B2B fintech analyst qualifying "${company}"${domain ? ` (${domain})` : ""} as a potential client or partner for RemiDe — a Stablecoin Clearing Network for licensed financial institutions.`,
    `RemiDe enables compliant cross-border stablecoin settlements (USDC/USDT/EURC) between licensed FIs.`,
    `Research this company and answer ONLY the following scoring questions. For each, provide a factual answer with source URL. If not found, say NOT FOUND.`,
    `AXIS 1 — Cross-Border Payments Core: Does this company process cross-border B2B payments as a core business? Any volume or corridor data?`,
    `AXIS 2 — On/Off Ramp: Do they convert between fiat and stablecoins/crypto? Any USDC/USDT/EURC ramp infrastructure?`,
    `AXIS 3 — Stablecoin Alignment: Any public stablecoin activity in last 12 months? Pilots, integrations, announcements, partnerships with Circle/Tether/Paxos?`,
    `AXIS 4 — Corridors: Which geographic corridors do they operate in?`,
    `AXIS 5 — Network Role: Are they likely an Originating FI, Destination FI, or Beneficiary FI?`,
    `AXIS 6 — Regulatory Licenses: What licenses do they hold? (EMI, PI, MSB, VASP, MiCA CASP, PSD2, banking license) Which jurisdictions?`,
    `AXIS 7 — B2B Scale: Do they serve businesses (not retail)? Any employee count, revenue, or transaction volume signals?`,
    `AXIS 8 — Competitive Proximity: Are they a potential competitor to RemiDe or clearly a client/partner?`,
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
        axis1_xborder_core: { type: "string" },
        axis2_ramp: { type: "string" },
        axis3_stablecoin_alignment: { type: "string" },
        axis4_corridors: { type: "string" },
        axis5_network_role: { type: "string" },
        axis6_licenses: { type: "string" },
        axis7_b2b_scale: { type: "string" },
        axis8_competitive: { type: "string" },
        hard_kill: { type: "string" },
        strategic_signal: { type: "string" },
        sources: { type: "array", items: { type: "string" } }
      }
    }
  }
};

// ── Parallel endpoints ────────────────────────────────────────────────────────
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
    const done = status === "completed" || status === "succeeded";
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
          outreach_insight: { type: "string" }
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
const BEEPER_URL = process.env.BEEPER_URL || "http://localhost:23373";
const BEEPER_TOKEN = process.env.BEEPER_TOKEN;

function beeperHeaders() {
  return {
    "Authorization": `Bearer ${BEEPER_TOKEN}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

function fuzzyMatch(chatName, targetName) {
  if (!chatName || !targetName) return false;
  const chat = chatName.toLowerCase().trim();
  const target = targetName.toLowerCase().trim();
  if (chat === target) return true;
  if (chat.includes(target) || target.includes(chat)) return true;
  const words = target.split(/[\s,.|&-]+/).filter(w => w.length > 3);
  return words.some(w => chat.includes(w));
}

function formatMessages(items, limit = 10) {
  return (items || [])
    .slice(0, limit)
    .reverse()
    .map(m => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleDateString("en-GB") : "?";
      const sender = m.sender?.fullName || m.sender?.displayName || "?";
      const text = m.content?.text || m.content?.body || "";
      return text ? `[${time}] ${sender}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

app.get("/beeper/health", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/info`, { headers: beeperHeaders(), timeout: 5000 });
    res.json({ ok: true, beeper: r.data?.app, mcp: r.data?.server?.mcp_enabled, url: BEEPER_URL });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, hint: "Is Beeper Desktop running? Is BEEPER_URL correct?" });
  }
});

app.get("/beeper/chats", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { network, limit = 50 } = req.query;
  try {
    const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=${limit}`, { headers: beeperHeaders(), timeout: 10000 });
    let items = r.data?.items || [];
    if (network) items = items.filter(c => c.accountID && c.accountID.includes(network));
    res.json({
      total: items.length,
      chats: items.map(c => ({
        id: c.id,
        name: c.title,
        type: c.type,
        network: c.accountID,
        participants: c.participants?.items?.length || 0,
      }))
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get("/beeper/messages", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { chatId, limit = 20 } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  try {
    const r = await axios.get(
      `${BEEPER_URL}/v1/messages?chatID=${encodeURIComponent(chatId)}&limit=${limit}`,
      { headers: beeperHeaders(), timeout: 10000 }
    );
    const msgs = (r.data?.items || []).map(m => ({
      id: m.id,
      sender: m.sender?.fullName || m.sender?.displayName || m.sender?.id,
      text: m.content?.text || m.content?.body || "",
      time: m.timestamp,
    }));
    res.json({ messages: msgs });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.post("/beeper/send", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { chatId, text } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: "chatId and text required" });
  try {
    const r = await axios.post(
      `${BEEPER_URL}/v1/messages`,
      { chatID: chatId, content: { text } },
      { headers: beeperHeaders(), timeout: 10000 }
    );
    res.json({ ok: true, messageId: r.data?.id });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.post("/beeper/search", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  try {
    const r = await axios.get(
      `${BEEPER_URL}/v1/messages/search?q=${encodeURIComponent(query)}&limit=20`,
      { headers: beeperHeaders(), timeout: 10000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.post("/beeper/sync-chats", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { networks = ["whatsapp", "telegram"], msgLimit = 10 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=100`, { headers: beeperHeaders(), timeout: 10000 });
    const groups = (chatsRes.data?.items || []).filter(c =>
      networks.some(n => c.accountID && c.accountID.includes(n)) && c.type === "group"
    );
    console.log(`[beeper/sync-chats] Found ${groups.length} groups (${networks.join(", ")})`);
    const notionRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { page_size: 100 },
      { headers: notionHeaders() }
    );
    const companies = notionRes.data.results.map(p => ({
      id: p.id,
      name: p.properties["Company name"]?.title?.[0]?.text?.content || "",
      stage: p.properties["Stage"]?.status?.name,
    })).filter(c => c.name);
    const results = [];
    for (const group of groups) {
      const chatName = group.title || "";
      const networkLabel = networks.find(n => group.accountID?.includes(n))?.toUpperCase() || "MSG";
      const match = companies.find(c => fuzzyMatch(chatName, c.name));
      if (!match) { results.push({ chat: chatName, network: networkLabel, status: "no_match" }); continue; }
      let msgText = "";
      try {
        const msgsRes = await axios.get(
          `${BEEPER_URL}/v1/messages?chatID=${encodeURIComponent(group.id)}&limit=${msgLimit}`,
          { headers: beeperHeaders(), timeout: 10000 }
        );
        msgText = formatMessages(msgsRes.data?.items, msgLimit);
      } catch (e) {
        console.error(`[beeper/sync-chats] Messages fetch failed for ${chatName}:`, e.message);
      }
      const noteContent = `📱 ${networkLabel} Group: ${chatName}\n🕐 Synced: ${new Date().toLocaleDateString("en-GB")}\n\n${msgText}`;
      try {
        await axios.patch(
          `https://api.notion.com/v1/pages/${match.id}`,
          { properties: { "Notes": { rich_text: [{ text: { content: noteContent.slice(0, 2000) } }] } } },
          { headers: notionHeaders() }
        );
        results.push({ chat: chatName, network: networkLabel, company: match.name, status: "synced" });
        console.log(`[beeper/sync-chats] ✅ [${networkLabel}] ${chatName} → ${match.name}`);
      } catch (e) {
        results.push({ chat: chatName, network: networkLabel, company: match.name, status: "notion_error", error: e.message });
      }
    }
    const synced = results.filter(r => r.status === "synced").length;
    const noMatch = results.filter(r => r.status === "no_match").length;
    res.json({ ok: true, synced, noMatch, total: groups.length, results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.post("/beeper/sync-linkedin", async (req, res) => {
  if (!BEEPER_TOKEN) return res.status(500).json({ error: "BEEPER_TOKEN not set" });
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { msgLimit = 10 } = req.body;
  try {
    const chatsRes = await axios.get(`${BEEPER_URL}/v1/chats?limit=100`, { headers: beeperHeaders(), timeout: 10000 });
    const liChats = (chatsRes.data?.items || []).filter(c => c.accountID === "linkedin" && c.type === "single");
    console.log(`[beeper/sync-linkedin] Found ${liChats.length} LinkedIn DMs`);
    const notionRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      { page_size: 100 },
      { headers: notionHeaders() }
    );
    const people = notionRes.data.results.map(p => ({
      id: p.id,
      name: p.properties["Name"]?.title?.[0]?.text?.content || "",
    })).filter(p => p.name);
    const results = [];
    for (const chat of liChats) {
      const chatName = chat.title || "";
      const match = people.find(p => fuzzyMatch(chatName, p.name));
      if (!match) { results.push({ chat: chatName, status: "no_match" }); continue; }
      let msgText = "";
      try {
        const msgsRes = await axios.get(
          `${BEEPER_URL}/v1/messages?chatID=${encodeURIComponent(chat.id)}&limit=${msgLimit}`,
          { headers: beeperHeaders(), timeout: 10000 }
        );
        msgText = formatMessages(msgsRes.data?.items, msgLimit);
      } catch (e) {
        console.error(`[beeper/sync-linkedin] Messages fetch failed for ${chatName}:`, e.message);
      }
      const noteContent = `💼 LinkedIn DM: ${chatName}\n🕐 Synced: ${new Date().toLocaleDateString("en-GB")}\n\n${msgText}`;
      try {
        await axios.patch(
          `https://api.notion.com/v1/pages/${match.id}`,
          { properties: { "Notes": { rich_text: [{ text: { content: noteContent.slice(0, 2000) } }] } } },
          { headers: notionHeaders() }
        );
        results.push({ chat: chatName, person: match.name, status: "synced" });
        console.log(`[beeper/sync-linkedin] ✅ ${chatName} → ${match.name}`);
      } catch (e) {
        results.push({ chat: chatName, person: match.name, status: "notion_error", error: e.message });
      }
    }
    const synced = results.filter(r => r.status === "synced").length;
    const noMatch = results.filter(r => r.status === "no_match").length;
    res.json({ ok: true, synced, noMatch, total: liChats.length, results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  ok: true,
  notion: !!NOTION_TOKEN,
  parallel: !!PARALLEL_KEY,
  beeper: !!BEEPER_TOKEN,
}));
app.get("/", (_, res) => res.json({ service: "outreach-proxy", version: "2.1", status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
