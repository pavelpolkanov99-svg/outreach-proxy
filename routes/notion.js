const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  NOTION_COMPANIES_DB,
  NOTION_PEOPLE_DB,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

function parseIfString(v) {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

// Build Notion properties object from BD scoring fields.
function buildCompanyProps({
  industry, priority, bd_score, corridors, description,
  website, location, source, pipeline, type, heat, action,
  status, tags, communication_channel,
}, existingPage) {
  const props = {};
  if (industry)                  props["Industry"]              = { select: { name: industry } };
  if (priority)                  props["Priority"]              = { select: { name: priority } };
  if (bd_score !== undefined)    props["BD Score"]              = { number: parseFloat(bd_score) };
  if (corridors?.length)         props["Corridors"]             = { multi_select: corridors.map(c => ({ name: c })) };
  if (description)               props["Company description"]   = { rich_text: [{ text: { content: description.slice(0, 2000) } }] };
  if (website)                   props["Website"]               = { url: website };
  if (location)                  props["Location"]              = { rich_text: [{ text: { content: location } }] };
  if (source)                    props["Source"]                = { select: { name: source } };
  if (pipeline)                  props["Pipeline"]              = { select: { name: pipeline } };
  if (type)                      props["Type"]                  = { multi_select: (Array.isArray(type) ? type : [type]).map(t => ({ name: t })) };
  if (heat)                      props["Heat"]                  = { select: { name: heat } };
  if (action)                    props["Action"]                = { rich_text: [{ text: { content: action } }] };
  if (status)                    props["Stage"]                 = { status: { name: status } };
  if (communication_channel)     props["Communication channel"] = { select: { name: communication_channel } };

  // Tags: additive merge — never overwrite existing
  const parsedTags = parseIfString(tags);
  if (Array.isArray(parsedTags) && parsedTags.length) {
    const existing = existingPage
      ? (existingPage.properties?.Tags?.multi_select || []).map(t => t.name)
      : [];
    const merged = [...new Set([...existing, ...parsedTags])];
    props["Tags"] = { multi_select: merged.map(t => ({ name: t })) };
  }

  return props;
}

// ── GET /notion/db-schema ─────────────────────────────────────────────────────
router.get("/db-schema", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  try {
    const [companies, people] = await Promise.all([
      axios.get(`https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}`, { headers: notionHeaders() }),
      axios.get(`https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}`,    { headers: notionHeaders() }),
    ]);
    const extract = (db) => Object.entries(db.data.properties).map(([name, prop]) => ({ name, type: prop.type }));
    res.json({ companies: extract(companies), people: extract(people) });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /notion/upsert-lead ──────────────────────────────────────────────────
router.post("/upsert-lead", async (req, res) => {
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
      let searchCompany = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
        { filter: { property: "Company name", title: { equals: company } }, page_size: 1 },
        { headers: notionHeaders() }
      );
      if (searchCompany.data.results.length === 0) {
        searchCompany = await axios.post(
          `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
          { filter: { property: "Company name", title: { contains: company } }, page_size: 1 },
          { headers: notionHeaders() }
        );
      }
      if (searchCompany.data.results.length > 0) {
        companyPageId = searchCompany.data.results[0].id;
      } else {
        const companyProps = {
          "Company name": { title: [{ text: { content: company } }] },
          "Stage":        { status: { name: status } },
        };
        if (companyWebsite)     companyProps["Website"]             = { url: companyWebsite };
        if (companyLinkedin)    companyProps["Discovery Card"]      = { url: companyLinkedin };
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
    if (roleValue)     personProps["Role"]     = { rich_text: [{ text: { content: roleValue } }] };
    if (linkedin)      personProps["LinkedIn"] = { url: linkedin };
    if (email)         personProps["Email"]    = { email };
    if (companyPageId) personProps["Company"]  = { relation: [{ id: companyPageId }] };
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

// ── POST /notion/update-status ────────────────────────────────────────────────
router.post("/update-status", async (req, res) => {
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

// ── POST /notion/update-notes ─────────────────────────────────────────────────
router.post("/update-notes", async (req, res) => {
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

// ── POST /notion/update-tags ──────────────────────────────────────────────────
router.post("/update-tags", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, db = "companies", mode = "add" } = req.body;
  const tags = parseIfString(req.body.tags);
  if (!name || !tags?.length) return res.status(400).json({ error: "name and tags required" });
  const dbId = db === "companies" ? NOTION_COMPANIES_DB : NOTION_PEOPLE_DB;
  const titleField = db === "companies" ? "Company name" : "Name";
  try {
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      { filter: { property: titleField, title: { equals: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    const results = search.data.results.length > 0 ? search.data.results : (db === "companies" ? (await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      { filter: { property: titleField, title: { contains: name } }, page_size: 1 },
      { headers: notionHeaders() }
    )).data.results : []);
    if (results.length === 0) return res.status(404).json({ error: `${name} not found` });
    const page = results[0];
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

// ── POST /notion/search-company ───────────────────────────────────────────────
router.post("/search-company", async (req, res) => {
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
    res.json({ found: true, id: page.id, name: page.properties["Company name"]?.title?.[0]?.text?.content || name, stage: page.properties["Stage"]?.status?.name });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /notion/append-note ──────────────────────────────────────────────────
router.post("/append-note", async (req, res) => {
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
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Notes": { rich_text: [{ text: { content: combined } }] } } }, { headers: notionHeaders() });
    res.json({ ok: true, pageId, resolvedName, noteLength: note.length, totalLength: combined.length });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /notion/update-company ───────────────────────────────────────────────
router.post("/update-company", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, status } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { contains: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    const props = buildCompanyProps(req.body, search.data.results[0] || null);
    if (!search.data.results.length) {
      props["Company name"] = { title: [{ text: { content: name } }] };
      if (!props["Stage"]) props["Stage"] = { status: { name: status || "Backlog" } };
      const created = await axios.post("https://api.notion.com/v1/pages", { parent: { database_id: NOTION_COMPANIES_DB }, properties: props }, { headers: notionHeaders() });
      return res.json({ ok: true, action: "created", pageId: created.data.id, updated: Object.keys(props) });
    }
    if (!Object.keys(props).length) return res.status(400).json({ error: "No fields to update" });
    const pageId = search.data.results[0].id;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: props }, { headers: notionHeaders() });
    res.json({ ok: true, action: "updated", pageId, updated: Object.keys(props) });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── POST /notion/update-company-with-tags ─────────────────────────────────────
router.post("/update-company-with-tags", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { name, status } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { contains: name } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    const existingPage = search.data.results[0] || null;
    const props = buildCompanyProps(req.body, existingPage);
    if (!existingPage) {
      props["Company name"] = { title: [{ text: { content: name } }] };
      if (!props["Stage"]) props["Stage"] = { status: { name: status || "Backlog" } };
      const created = await axios.post("https://api.notion.com/v1/pages", { parent: { database_id: NOTION_COMPANIES_DB }, properties: props }, { headers: notionHeaders() });
      return res.json({ ok: true, action: "created", pageId: created.data.id, updated: Object.keys(props) });
    }
    if (!Object.keys(props).length) return res.status(400).json({ error: "No fields to update" });
    const pageId = existingPage.id;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: props }, { headers: notionHeaders() });
    res.json({ ok: true, action: "updated", pageId, updated: Object.keys(props) });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── POST /notion/query ────────────────────────────────────────────────────────
router.post("/query", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { db_id, page_size = 20 } = req.body;
  const filter       = parseIfString(req.body.filter);
  const sorts        = parseIfString(req.body.sorts);
  const start_cursor = parseIfString(req.body.start_cursor);
  if (!db_id) return res.status(400).json({ error: "db_id required" });
  try {
    const payload = { page_size };
    if (filter && typeof filter === "object")             payload.filter       = filter;
    if (Array.isArray(sorts) && sorts.length)             payload.sorts        = sorts;
    if (start_cursor && typeof start_cursor === "string") payload.start_cursor = start_cursor;
    const r = await axios.post(`https://api.notion.com/v1/databases/${db_id}/query`, payload, { headers: notionHeaders() });
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /notion/check-duplicates ─────────────────────────────────────────────
router.post("/check-duplicates", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  let { names } = req.body;
  names = parseIfString(names);
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: "names array required" });
  const found = [], notFound = [];
  await Promise.all(names.map(async (name) => {
    try {
      const r = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
        { filter: { property: "Company name", title: { contains: name } }, page_size: 1 },
        { headers: notionHeaders() }
      );
      if (r.data.results.length > 0) {
        const page = r.data.results[0];
        found.push({ queried: name, matched: page.properties["Company name"]?.title?.[0]?.text?.content || name, stage: page.properties["Stage"]?.status?.name || null, pageId: page.id });
      } else {
        notFound.push(name);
      }
    } catch { notFound.push(name); }
  }));
  res.json({ ok: true, total_queried: names.length, found_count: found.length, found, not_found: notFound });
});

// ─────────────────────────────────────────────────────────────────────────────
// Insight cache helpers — read/write Loop's Insight field on Companies pages
// ─────────────────────────────────────────────────────────────────────────────

function formatInsightText(refreshedAt, bullets) {
  const ts = new Date(refreshedAt || new Date()).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const head = `Refreshed: ${ts}`;
  const body = (bullets || []).filter(Boolean).map(b => `• ${b}`).join("\n");
  return body ? `${head}\n${body}` : head;
}

function parseInsightText(plainText) {
  if (!plainText || typeof plainText !== "string") return null;
  const lines = plainText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const headMatch = lines[0].match(/^Refreshed:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\s*UTC)?\s*$/i);
  let refreshedAt = null;
  let bulletStart = 0;
  if (headMatch) {
    refreshedAt = `${headMatch[1]}T${headMatch[2]}:00Z`;
    bulletStart = 1;
  }

  const bullets = [];
  for (let i = bulletStart; i < lines.length; i++) {
    const m = lines[i].match(/^[•\-*]\s*(.+)$/);
    if (m) bullets.push(m[1]);
    else if (lines[i].length > 0) bullets.push(lines[i]);
  }

  return { refreshedAt, bullets };
}

function extractCompanyDigest(page) {
  const props = page.properties || {};
  const titleArr = props["Company name"]?.title || [];
  const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

  const description = (props["Company description"]?.rich_text || [])
    .map(rt => rt.plain_text || rt.text?.content || "").join("");

  const insightText = (props["Insight"]?.rich_text || [])
    .map(rt => rt.plain_text || rt.text?.content || "").join("");
  const insight = parseInsightText(insightText);

  const tags = (props["Tags"]?.multi_select || []).map(t => t.name);

  return {
    pageId: page.id,
    url: page.url,
    name,
    website: props["Website"]?.url || null,
    description,
    bdScore: props["BD Score"]?.number ?? null,
    stage: props["Stage"]?.status?.name || null,
    priority: props["Priority"]?.select?.name || null,
    industry: props["Industry"]?.select?.name || null,
    location: (props["Location"]?.rich_text || []).map(rt => rt.plain_text || rt.text?.content || "").join("") || null,
    tags,
    lastContact: props["Last Contact"]?.date?.start || null,
    lastEditedTime: page.last_edited_time || null,
    pipeline: props["Pipeline"]?.select?.name || null,
    type: (props["Type"]?.multi_select || []).map(t => t.name),
    insight,
  };
}

function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).toLowerCase().trim();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  s = s.split("#")[0];
  s = s.split(":")[0];
  return s || null;
}

// ── GET /notion/insight-by-domain ────────────────────────────────────────────
router.get("/insight-by-domain", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const domain = normalizeDomain(req.query.domain);
  if (!domain) return res.status(400).json({ error: "domain query param required" });

  try {
    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      {
        filter: { property: "Website", url: { contains: domain } },
        page_size: 5,
      },
      { headers: notionHeaders() }
    );

    if (!r.data.results.length) return res.json({ found: false, domain });

    const skipStages = new Set(["Lost", "DELETE", "Not relevant"]);
    const active = r.data.results
      .map(extractCompanyDigest)
      .filter(c => !skipStages.has(c.stage));
    const company = active[0] || extractCompanyDigest(r.data.results[0]);

    res.json({ found: true, domain, company });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /notion/update-insight ──────────────────────────────────────────────
router.post("/update-insight", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { pageId: bodyPageId, name, refreshedAt } = req.body || {};
  const bullets = Array.isArray(req.body?.bullets) ? req.body.bullets : [];

  try {
    let pageId = bodyPageId;
    if (!pageId) {
      if (!name) return res.status(400).json({ error: "pageId or name required" });
      let s = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
        { filter: { property: "Company name", title: { equals: name } }, page_size: 1 },
        { headers: notionHeaders() }
      );
      if (!s.data.results.length) {
        s = await axios.post(
          `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
          { filter: { property: "Company name", title: { contains: name } }, page_size: 1 },
          { headers: notionHeaders() }
        );
      }
      if (!s.data.results.length) return res.status(404).json({ error: `${name} not found in CRM` });
      pageId = s.data.results[0].id;
    }

    const text = formatInsightText(refreshedAt || new Date().toISOString(), bullets);
    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { "Insight": { rich_text: [{ text: { content: text.slice(0, 2000) } }] } } },
      { headers: notionHeaders() }
    );

    res.json({ ok: true, pageId, bulletsWritten: bullets.length, length: text.length });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-deals — pipeline hygiene digest
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns deals that have gone quiet:
//  - Stage in active engagement bucket
//  - last_edited_time older than N days
//  - Priority in [High, Mid] (P3/no-priority too noisy)
//  - Sort: oldest stale first
//  - Limit (default 5)
// ─────────────────────────────────────────────────────────────────────────────

const STALE_DEFAULT_DAYS = 14;
const STALE_DEFAULT_LIMIT = 5;

// Stages that count as "actively engaged" — i.e. customer has interacted with us.
// Outbound stages (cold email sent, intro) are NOT here — those have their own
// follow-up logic and don't belong in stale-deals.
// Terminal stages (Win/Lost/Not relevant/DELETE) also excluded.
const STALE_ACTIVE_STAGES = [
  "Communication Started",
  "Call Scheduled",
  "initial discussions",
  "Keeping in the Loop",
  "Warm discussions",
  "Negotiations",
];

router.get("/stale-deals", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const days  = Math.max(1, Math.min(365, parseInt(req.query.days,  10) || STALE_DEFAULT_DAYS));
  const limit = Math.max(1, Math.min(50,  parseInt(req.query.limit, 10) || STALE_DEFAULT_LIMIT));

  // Cutoff = now - N days (ISO)
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();

  try {
    const filter = {
      and: [
        // Stage in [active engagement bucket]
        {
          or: STALE_ACTIVE_STAGES.map(stage => ({
            property: "Stage",
            status:   { equals: stage },
          })),
        },
        // last_edited_time before cutoff
        {
          timestamp: "last_edited_time",
          last_edited_time: { before: cutoffISO },
        },
        // Priority in [High, Mid]
        {
          or: [
            { property: "Priority", select: { equals: "High" } },
            { property: "Priority", select: { equals: "Mid"  } },
          ],
        },
      ],
    };

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      {
        filter,
        sorts: [
          { timestamp: "last_edited_time", direction: "ascending" },
        ],
        page_size: limit,
      },
      { headers: notionHeaders() }
    );

    const deals = r.data.results.map(page => {
      const digest = extractCompanyDigest(page);
      const editedTs = Date.parse(digest.lastEditedTime || page.last_edited_time);
      const daysStale = isNaN(editedTs)
        ? null
        : Math.floor((Date.now() - editedTs) / (24 * 60 * 60 * 1000));
      return { ...digest, daysStale };
    });

    res.json({
      ok: true,
      cutoffDays: days,
      cutoffISO,
      total: deals.length,
      deals,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

module.exports = router;
