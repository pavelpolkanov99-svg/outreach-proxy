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
// CRM Companies: "Company name" (title), "Stage" (status), "Website" (url),
//   "Discovery Card" (url), "Company description" (rich_text), "Notes" (rich_text), "People" (relation)
// CRM People: "Name" (title), "Role" (rich_text), "LinkedIn" (url),
//   "Email" (email), "Company" (relation), "Notes" (rich_text)
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

// ── Apollo filter — keep only scoring-relevant fields ────────────────────────
// Strips out technology_names, current_technologies, employment_history details
// etc. to reduce token count by ~80%
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

// ── Apollo search: POST /apollo/search ───────────────────────────────────────
app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });
  try {
    const r = await axios.post(
      "https://api.apollo.io/api/v1/mixed_people/api_search",
      { q_keywords: name + (company ? " " + company : ""), page: 1, per_page: 5 },
      { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 15000 }
    );
    const people = (r.data?.people || []).map(filterPerson);
    res.json(people);
  } catch (err) {
    console.error("[/apollo/search]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── Apollo enrich: POST /apollo/match ────────────────────────────────────────
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
    console.error("[/apollo/match]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── HeyReach proxy: POST /heyreach/proxy ─────────────────────────────────────
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
    console.error("[/heyreach/proxy]", path, err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── Notion: GET /notion/db-schema ────────────────────────────────────────────
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
    console.error("[/notion/db-schema]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/upsert-lead ─────────────────────────────────────────
// Body: { firstName, lastName, title, company, companyWebsite, companyLinkedin,
//         companyDescription, linkedin, email, status }
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
    const personProps = {
      "Name": { title: [{ text: { content: fullName } }] },
    };
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
      await axios.patch(
        `https://api.notion.com/v1/pages/${personPageId}`,
        { properties: personProps },
        { headers: notionHeaders() }
      );
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
    console.error("[/notion/upsert-lead]", err.response?.status, JSON.stringify(err.response?.data));
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/update-status ───────────────────────────────────────
// Body: { company, status }  — valid: "Connection Sent", "Initial Discussion"
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
    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Stage": { status: { name: status } } } },
      { headers: notionHeaders() }
    );
    res.json({ ok: true, pageId });
  } catch (err) {
    console.error("[/notion/update-status]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Notion: POST /notion/update-notes ────────────────────────────────────────
// Updates Notes field on a person or company record by name
// Body: { name, db ("people" | "companies"), notes }
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
    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Notes": { rich_text: [{ text: { content: notes } }] } } },
      { headers: notionHeaders() }
    );
    res.json({ ok: true, pageId });
  } catch (err) {
    console.error("[/notion/update-notes]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});


// ── Notion: POST /notion/update-tags ─────────────────────────────────────────
// Adds or replaces tags on a company or person record
// Body: { name, db ("people" | "companies"), tags: ["tag1", "tag2"], mode ("add" | "replace") }
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
    if (search.data.results.length === 0) return res.status(404).json({ error: `${name} not found in CRM ${db}` });

    const page = search.data.results[0];
    const pageId = page.id;

    let finalTags = tags.map(t => ({ name: t }));

    // If mode is "add", merge with existing tags
    if (mode === "add") {
      const existing = (page.properties?.Tags?.multi_select || []).map(t => t.name);
      const merged = [...new Set([...existing, ...tags])];
      finalTags = merged.map(t => ({ name: t }));
    }

    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Tags": { multi_select: finalTags } } },
      { headers: notionHeaders() }
    );
    res.json({ ok: true, pageId, tags: finalTags.map(t => t.name) });
  } catch (err) {
    console.error("[/notion/update-tags]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Parallel config ───────────────────────────────────────────────────────────
const PARALLEL_KEY = process.env.PARALLEL_KEY;

function parallelHeaders() {
  return {
    "Authorization": `Bearer ${PARALLEL_KEY}`,
    "Content-Type": "application/json",
  };
}

// ── Parallel helpers ─────────────────────────────────────────────────────────
function buildResearchQuery(company, domain) {
  return [
    `You are a B2B fintech analyst qualifying "${company}"${domain ? ` (${domain})` : ""} as a potential client or partner for RemiDe — a Stablecoin Clearing Network for licensed financial institutions.`,
    `RemiDe enables compliant cross-border stablecoin settlements (USDC/USDT/EURC) between licensed FIs.`,
    `Research this company and answer ONLY the following scoring questions. For each, provide a factual answer with source URL. If not found, say NOT FOUND.`,

    `AXIS 1 — Cross-Border Payments Core: Does this company process cross-border B2B payments as a core business? Any volume or corridor data?`,

    `AXIS 2 — On/Off Ramp: Do they convert between fiat and stablecoins/crypto? Any USDC/USDT/EURC ramp infrastructure?`,

    `AXIS 3 — Stablecoin Alignment: Any public stablecoin activity in last 12 months? Pilots, integrations, announcements, partnerships with Circle/Tether/Paxos?`,

    `AXIS 4 — Corridors: Which geographic corridors do they operate in? (e.g. EU→APAC, US→LATAM, etc.)`,

    `AXIS 5 — Network Role: Are they likely an Originating FI (sends payments), Destination FI (receives), or Beneficiary FI (both)?`,

    `AXIS 6 — Regulatory Licenses: What licenses do they hold? (EMI, PI, MSB, VASP, MiCA CASP, PSD2, banking license, etc.) Which jurisdictions?`,

    `AXIS 7 — B2B Scale: Do they serve businesses (not retail)? Any employee count, revenue, or transaction volume signals?`,

    `AXIS 8 — Competitive Proximity: Are they a potential competitor to RemiDe (building their own stablecoin clearing)? Or clearly a client/partner?`,

    `HARD KILL CHECK: Is this company ONLY doing: RWA tokenization, DeFi without KYC, custody/trading only, consulting, payroll, retail on-ramp widget, or compliance SaaS? If yes, say HARD KILL and why.`,

    `STRATEGIC SIGNAL: Any recent signal (last 12 months) suggesting urgency — new funding, hiring payments/crypto roles, regulatory approval, expansion announcement?`,
  ].join(" ");
}

// ── Parallel: POST /parallel/research/start ──────────────────────────────────
// Starts async research task. Returns taskId immediately (no timeout issues).
// Body: { company, domain?, processor? }  processor default: "lite"
app.post("/parallel/research/start", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain, processor = "lite" } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });
  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      {
        input: buildResearchQuery(company, domain),
        processor,
        task_spec: {
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
        }
      },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID", raw: r.data });
    res.json({ ok: true, taskId, company, processor, status: r.data?.status });
  } catch (err) {
    console.error("[/parallel/research/start]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Parallel: GET /parallel/result/:taskId ───────────────────────────────────
// Poll result of any Parallel task. Call until done=true.
// When done=true, fetches outputs automatically.
app.get("/parallel/result/:taskId", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { taskId } = req.params;
  try {
    // Get status
    const statusRes = await axios.get(
      `https://api.parallel.ai/v1/tasks/runs/${taskId}`,
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const status = statusRes.data?.status;
    const done = status === "completed" || status === "succeeded";
    const failed = status === "failed" || status === "error";

    let output = null;
    if (done) {
      // Fetch result from /result endpoint
      try {
        const resultRes = await axios.get(
          `https://api.parallel.ai/v1/tasks/runs/${taskId}/result`,
          { headers: parallelHeaders(), timeout: 15000 }
        );
        output = resultRes.data;
      } catch {
        output = statusRes.data;
      }
    }

    res.json({ ok: true, taskId, status, done, failed, output });
  } catch (err) {
    console.error("[/parallel/result]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Parallel: POST /parallel/insight/start ───────────────────────────────────
// Quick outreach personalization insight. Async, returns taskId immediately.
// Body: { company, person?, topic? }
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
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: query, processor: "lite" },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID" });
    res.json({ ok: true, taskId, company, status: r.data?.status });
  } catch (err) {
    console.error("[/parallel/insight/start]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});


// ── HeyReach Webhooks → Notion ────────────────────────────────────────────────
// Receives CONNECTION_REQUEST_ACCEPTED and MESSAGE_REPLY_RECEIVED events
// and updates Stage in Notion CRM Companies accordingly
//
// HeyReach webhook payload shape (both events):
// {
//   eventType: "CONNECTION_REQUEST_ACCEPTED" | "MESSAGE_REPLY_RECEIVED",
//   campaignId: 123456,
//   lead: {
//     firstName, lastName, companyName, profileUrl, emailAddress, position
//   }
// }
app.post("/webhook/heyreach", async (req, res) => {
  // Always return 200 immediately so HeyReach doesn't retry
  res.json({ ok: true });

  const { eventType, lead, campaignId } = req.body || {};
  if (!eventType || !lead) return;

  const company = lead.companyName;
  if (!company) return;

  console.log(`[webhook] ${eventType} — ${lead.firstName} ${lead.lastName} @ ${company}`);

  try {
    let newStatus = null;

    if (eventType === "CONNECTION_REQUEST_ACCEPTED") {
      newStatus = "Initial Discussion";
    } else if (eventType === "MESSAGE_REPLY_RECEIVED") {
      newStatus = "Initial Discussion";
    }

    if (!newStatus || !NOTION_TOKEN) return;

    // Find company in CRM Companies and update Stage
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { equals: company } }, page_size: 1 },
      { headers: notionHeaders() }
    );

    if (search.data.results.length === 0) {
      console.log(`[webhook] Company not found in Notion: ${company}`);
      return;
    }

    const pageId = search.data.results[0].id;
    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Stage": { status: { name: newStatus } } } },
      { headers: notionHeaders() }
    );

    // Also update Notes with event info
    const note = eventType === "CONNECTION_REQUEST_ACCEPTED"
      ? `✅ Connection accepted by ${lead.firstName} ${lead.lastName} (Campaign ID: ${campaignId})`
      : `💬 Reply received from ${lead.firstName} ${lead.lastName} (Campaign ID: ${campaignId})`;

    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Notes": { rich_text: [{ text: { content: note } }] } } },
      { headers: notionHeaders() }
    );

    console.log(`[webhook] Notion updated: ${company} → ${newStatus}`);
  } catch (err) {
    console.error("[webhook] Notion update failed:", err.response?.data?.message || err.message);
  }
});


// ── Parallel: POST /parallel/score ───────────────────────────────────────────
// Two-tier scoring: runs lite for all, then base only for P1 (score >= 7.5)
// Body: { company, domain, clientScore? }
// clientScore: pre-calculated weighted score (optional). If provided and >= 7.5,
// skips lite and goes straight to base.
// Returns: { taskId, tier, company } immediately (async)
app.post("/parallel/score", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain, clientScore } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });

  // If score already provided and is P1 — go straight to base
  const processor = (clientScore !== undefined && clientScore >= 7.5) ? "base" : "lite";
  const tier = processor === "base" ? "P1-deep" : "P2-quick";

  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      {
        input: buildResearchQuery(company, domain),
        processor,
        task_spec: {
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
        }
      },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID", raw: r.data });
    res.json({ ok: true, taskId, company, processor, tier, status: r.data?.status });
  } catch (err) {
    console.error("[/parallel/score]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Parallel: POST /parallel/upgrade ─────────────────────────────────────────
// Upgrades a P1 lead from lite to base research after initial scoring confirms P1
// Body: { company, domain }
app.post("/parallel/upgrade", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });

  try {
    const r = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      {
        input: buildResearchQuery(company, domain),
        processor: "base",
        task_spec: {
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
                outreach_insight: { type: "string" },
                sources: { type: "array", items: { type: "string" } }
              }
            }
          }
        }
      },
      { headers: parallelHeaders(), timeout: 15000 }
    );
    const taskId = r.data?.run_id || r.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID" });
    res.json({ ok: true, taskId, company, processor: "base", tier: "P1-deep", status: r.data?.status });
  } catch (err) {
    console.error("[/parallel/upgrade]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, notion: !!NOTION_TOKEN, parallel: !!PARALLEL_KEY }));
app.get("/", (_, res) => res.json({ service: "outreach-proxy", status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
