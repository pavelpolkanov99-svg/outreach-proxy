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
    const people = (r.data?.people || []).map((p) => ({
      id: p.id, name: p.name, firstName: p.first_name, lastName: p.last_name,
      title: p.title, company: p.organization_name || p.organization?.name,
      companyWebsite: p.organization?.website_url,
      companyLinkedin: p.organization?.linkedin_url,
      companyDescription: (p.organization?.short_description || "").slice(0, 150),
      location: [p.city, p.country].filter(Boolean).join(", "),
      linkedin: p.linkedin_url, email: p.email,
    }));
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
    res.json({
      id: p.id, name: p.name, firstName: p.first_name, lastName: p.last_name,
      title: p.title, company: p.organization_name || p.organization?.name,
      companyWebsite: p.organization?.website_url,
      companyLinkedin: p.organization?.linkedin_url,
      companyDescription: (p.organization?.short_description || "").slice(0, 150),
      location: [p.city, p.country].filter(Boolean).join(", "),
      linkedin: p.linkedin_url, email: p.email,
    });
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

// ── Parallel: POST /parallel/research ────────────────────────────────────────
// Deep research on a company for BD scoring context
// Body: { company, domain?, processor? }
// processor: "lite" | "base" | "core" | "ultra" (default: "base")
// Returns: funding signals, job postings, stablecoin mentions, news, ICP signals
app.post("/parallel/research", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, domain, processor = "base" } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });

  const query = [
    `Research the company "${company}"${domain ? ` (${domain})` : ""} for B2B fintech partnership qualification.`,
    `Find and summarize:`,
    `1. Recent funding rounds or M&A activity (last 12 months)`,
    `2. Active job postings related to: payments, cross-border transfers, stablecoins, treasury, compliance`,
    `3. Any public statements, press releases, or news about stablecoin adoption, crypto payments, or USDC/USDT usage`,
    `4. Their core business model — do they move money cross-border for businesses?`,
    `5. Regulatory licenses mentioned (EMI, PI, MSB, VASP, MiCA, PSD2)`,
    `6. Geographic corridors they operate in`,
    `Return structured JSON with keys: funding, hiring_signals, stablecoin_signals, business_model, licenses, corridors, sources`,
  ].join(" ");

  try {
    // Create task
    const createRes = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: query, processor },
      { headers: parallelHeaders(), timeout: 10000 }
    );

    const taskId = createRes.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID returned", raw: createRes.data });

    // Poll for result (max 60 seconds)
    let result = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await axios.get(
        `https://api.parallel.ai/v1/tasks/runs/${taskId}`,
        { headers: parallelHeaders(), timeout: 10000 }
      );
      const status = pollRes.data?.status;
      if (status === "completed" || status === "succeeded") {
        result = pollRes.data;
        break;
      }
      if (status === "failed" || status === "error") {
        return res.status(500).json({ error: "Parallel task failed", raw: pollRes.data });
      }
    }

    if (!result) return res.status(504).json({ error: "Parallel task timed out (60s)" });

    res.json({
      ok: true,
      company,
      taskId,
      processor,
      output: result.output || result.result || result,
    });
  } catch (err) {
    console.error("[/parallel/research]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Parallel: POST /parallel/enrich-insight ──────────────────────────────────
// Quick search for outreach personalization insight
// Body: { company, person?, topic? }
// Returns: recent news/signal suitable for personalized outreach note
app.post("/parallel/enrich-insight", async (req, res) => {
  if (!PARALLEL_KEY) return res.status(500).json({ error: "PARALLEL_KEY not set" });
  const { company, person, topic } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });

  const query = [
    `Find 1-2 recent and specific facts about "${company}"`,
    person ? `or their employee "${person}"` : "",
    `that would be relevant for a personalized B2B outreach message from a stablecoin payments company.`,
    topic ? `Focus on: ${topic}.` : `Focus on: recent product launches, funding, expansion, payments strategy, stablecoin activity.`,
    `Return a single short sentence (max 20 words) that could be used as a conversation opener. Be specific, not generic.`,
  ].filter(Boolean).join(" ");

  try {
    const createRes = await axios.post(
      "https://api.parallel.ai/v1/tasks/runs",
      { input: query, processor: "lite" },
      { headers: parallelHeaders(), timeout: 10000 }
    );

    const taskId = createRes.data?.id;
    if (!taskId) return res.status(500).json({ error: "No task ID returned" });

    // Poll max 30 seconds for quick insight
    let result = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await axios.get(
        `https://api.parallel.ai/v1/tasks/runs/${taskId}`,
        { headers: parallelHeaders(), timeout: 10000 }
      );
      const status = pollRes.data?.status;
      if (status === "completed" || status === "succeeded") {
        result = pollRes.data;
        break;
      }
      if (status === "failed" || status === "error") {
        return res.status(500).json({ error: "Parallel task failed" });
      }
    }

    if (!result) return res.status(504).json({ error: "Timeout" });

    res.json({
      ok: true,
      company,
      insight: result.output || result.result || result,
    });
  } catch (err) {
    console.error("[/parallel/enrich-insight]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, notion: !!NOTION_TOKEN, parallel: !!PARALLEL_KEY }));
app.get("/", (_, res) => res.json({ service: "outreach-proxy", status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
