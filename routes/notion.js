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

// ─────────────────────────────────────────────────────────────────────────────
// GET /notion/db-schema
// ─────────────────────────────────────────────────────────────────────────────
function extractSchemaProperties(db) {
  return Object.entries(db.properties || {}).map(([name, prop]) => {
    const entry = { name, type: prop.type };
    if (prop.type === "select" && prop.select?.options) {
      entry.options = prop.select.options.map(o => o.name);
    } else if (prop.type === "status" && prop.status?.options) {
      entry.options = prop.status.options.map(o => o.name);
    } else if (prop.type === "multi_select" && prop.multi_select?.options) {
      entry.options = prop.multi_select.options.map(o => o.name);
    }
    return entry;
  });
}

router.get("/db-schema", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const dbId = (req.query.db_id || "").trim();

  if (dbId) {
    try {
      const r = await axios.get(
        `https://api.notion.com/v1/databases/${dbId}`,
        { headers: notionHeaders(), timeout: 12_000 }
      );
      const title = (r.data.title || [])
        .map(t => t.plain_text || t.text?.content || "")
        .join("") || null;
      return res.json({
        ok: true,
        db_id: dbId,
        title,
        properties: extractSchemaProperties(r.data),
      });
    } catch (err) {
      return res.status(err.response?.status || 500).json({
        error: err.response?.data?.message || err.message,
      });
    }
  }

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
// Insight cache helpers
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
// Stale-deals
// ─────────────────────────────────────────────────────────────────────────────

const STALE_DEFAULT_DAYS = 14;
const STALE_DEFAULT_LIMIT = 5;

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

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();

  try {
    const filter = {
      and: [
        {
          or: STALE_ACTIVE_STAGES.map(stage => ({
            property: "Stage",
            status:   { equals: stage },
          })),
        },
        {
          timestamp: "last_edited_time",
          last_edited_time: { before: cutoffISO },
        },
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

// ─────────────────────────────────────────────────────────────────────────────
// Tasks today
// ─────────────────────────────────────────────────────────────────────────────

const NOTION_TASKS_DB = "2fa2ac1063c8800b8a92d56de58a6358";

const TASK_PRIORITY_RANK = { "High": 0, "Medium": 1, "Low": 2 };

const TASK_ASSIGNEE_IDS = (
  process.env.TASK_ASSIGNEE_IDS ||
  "2dfd872b-594c-815d-bf92-00022403aa3e,22dd872b-594c-8188-94c6-00025f066c59"
)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const TASK_ASSIGNEE_NAME_BY_ID = {
  "2dfd872b-594c-815d-bf92-00022403aa3e": "Pavel",
  "22dd872b-594c-8188-94c6-00025f066c59": "Anton",
};

const TASK_ASSIGNEE_ID_BY_NAME = {
  "pavel": "2dfd872b-594c-815d-bf92-00022403aa3e",
  "anton": "22dd872b-594c-8188-94c6-00025f066c59",
};

function buildAssigneeFilter() {
  if (!TASK_ASSIGNEE_IDS.length) return null;
  return {
    or: TASK_ASSIGNEE_IDS.map(uid => ({
      property: "Assignee",
      people:   { contains: uid },
    })),
  };
}

function toYmd(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function stripMarkdownLinks(s) {
  if (!s) return s;
  return String(s)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function deriveTaskShapeKey(taskName) {
  if (!taskName) return null;
  let s = String(taskName).toLowerCase();
  const delimiterRegex = /\s+[—–-]\s+|\s+\|\s+|:\s+|\s+\(/;
  const m = s.split(delimiterRegex);
  s = (m[0] || "").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  return s;
}

router.get("/tasks-today", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const limit  = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
  const noGroup = req.query.group === "0" || req.query.group === "false";

  const todayYmd = toYmd(new Date());

  try {
    const filterAnd = [
      { property: "Status",   status: { does_not_equal: "Done" } },
      { property: "Due date", date:   { on_or_before: todayYmd } },
    ];
    const assigneeFilter = buildAssigneeFilter();
    if (assigneeFilter) filterAnd.push(assigneeFilter);
    const filter = { and: filterAnd };

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_TASKS_DB}/query`,
      {
        filter,
        sorts: [
          { property: "Due date", direction: "ascending" },
        ],
        page_size: 100,
      },
      { headers: notionHeaders() }
    );

    const rawTasks = r.data.results.map(page => {
      const props = page.properties || {};

      const titleArr = props["Task name"]?.title || [];
      const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

      const descArr = props["Description"]?.rich_text || [];
      const descriptionRaw = descArr.map(rt => rt.plain_text || rt.text?.content || "").join("").trim();
      const descriptionClean = stripMarkdownLinks(descriptionRaw);
      const description = descriptionClean.length > 200
        ? descriptionClean.slice(0, 197) + "..."
        : descriptionClean;

      const status   = props["Status"]?.status?.name || null;
      const priority = props["Priority"]?.select?.name || null;

      const dueDate  = props["Due date"]?.date?.start || null;
      const companyRel = props["🏢  CRM Companies"]?.relation || [];
      const linkedCompanyId = companyRel[0]?.id || null;

      const assigneeArr = props["Assignee"]?.people || [];
      const assigneeIds = assigneeArr.map(p => p.id).filter(Boolean);
      const assigneeNames = assigneeIds
        .map(id => TASK_ASSIGNEE_NAME_BY_ID[id] || (assigneeArr.find(p => p.id === id)?.name || "Unknown"))
        .filter(Boolean);

      let daysOverdue = null;
      if (dueDate) {
        const dueMs = Date.parse(dueDate + "T00:00:00Z");
        const todayMs = Date.parse(todayYmd + "T00:00:00Z");
        if (!isNaN(dueMs)) {
          daysOverdue = Math.round((todayMs - dueMs) / (24 * 60 * 60 * 1000));
        }
      }

      return {
        id: page.id,
        url: page.url,
        name,
        description,
        status,
        priority,
        dueDate,
        daysOverdue,
        linkedCompanyId,
        assigneeIds,
        assigneeNames,
      };
    });

    const uniqueCompanyIds = [...new Set(rawTasks.map(t => t.linkedCompanyId).filter(Boolean))];
    const companyNameById = new Map();
    if (uniqueCompanyIds.length > 0) {
      await Promise.all(uniqueCompanyIds.map(async (id) => {
        try {
          const cr = await axios.get(
            `https://api.notion.com/v1/pages/${id}`,
            { headers: notionHeaders(), timeout: 6000 }
          );
          const props = cr.data.properties || {};
          const titleArr = props["Company name"]?.title || [];
          const cname = titleArr.map(t => t.plain_text || t.text?.content || "").join("");
          if (cname) companyNameById.set(id, cname);
        } catch (_) { }
      }));
    }

    const allTasks = rawTasks.map(t => ({
      id: t.id,
      url: t.url,
      name: t.name,
      description: t.description,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      daysOverdue: t.daysOverdue,
      companyName: t.linkedCompanyId ? (companyNameById.get(t.linkedCompanyId) || null) : null,
      assigneeIds: t.assigneeIds,
      assigneeNames: t.assigneeNames,
      shapeKey: deriveTaskShapeKey(t.name),
    }));

    let displayItems;
    if (noGroup) {
      displayItems = allTasks.map(t => ({ kind: "single", task: t }));
    } else {
      const groupBuckets = new Map();
      const ungrouped    = [];
      for (const t of allTasks) {
        if (!t.shapeKey) {
          ungrouped.push(t);
          continue;
        }
        const key = `${t.shapeKey}|${t.dueDate}|${t.priority}`;
        if (!groupBuckets.has(key)) groupBuckets.set(key, []);
        groupBuckets.get(key).push(t);
      }

      displayItems = [];
      for (const t of ungrouped) {
        displayItems.push({ kind: "single", task: t });
      }
      for (const [_key, members] of groupBuckets) {
        if (members.length >= 2) {
          const first = members[0];
          const titleCased = first.shapeKey.charAt(0).toUpperCase() + first.shapeKey.slice(1);
          displayItems.push({
            kind: "group",
            template: titleCased,
            count: members.length,
            companies: members.map(m => m.companyName || m.name).filter(Boolean),
            priority: first.priority,
            dueDate: first.dueDate,
            daysOverdue: first.daysOverdue,
            members: members.map(m => ({
              id: m.id, url: m.url, name: m.name, companyName: m.companyName,
            })),
          });
        } else {
          displayItems.push({ kind: "single", task: members[0] });
        }
      }
    }

    const itemRank = item => {
      const p = item.kind === "single" ? item.task.priority : item.priority;
      const d = item.kind === "single" ? item.task.dueDate  : item.dueDate;
      return [TASK_PRIORITY_RANK[p] ?? 99, d || "9999-12-31"];
    };
    displayItems.sort((a, b) => {
      const [pa, da] = itemRank(a);
      const [pb, db] = itemRank(b);
      if (pa !== pb) return pa - pb;
      return da.localeCompare(db);
    });

    const tasksFlat = allTasks
      .slice()
      .sort((a, b) => {
        const pa = TASK_PRIORITY_RANK[a.priority] ?? 99;
        const pb = TASK_PRIORITY_RANK[b.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        return (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31");
      });

    res.json({
      ok: true,
      asOf: todayYmd,
      total: allTasks.length,
      tasks: tasksFlat.slice(0, limit),
      items: displayItems.slice(0, limit),
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tasks-completed
// ─────────────────────────────────────────────────────────────────────────────

router.get("/tasks-completed", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const days  = Math.max(1, Math.min(30, parseInt(req.query.days,  10) || 3));
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));

  const cutoffISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const filterAnd = [
      { property: "Status", status: { equals: "Done" } },
      {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: cutoffISO },
      },
    ];
    const assigneeFilter = buildAssigneeFilter();
    if (assigneeFilter) filterAnd.push(assigneeFilter);
    const filter = { and: filterAnd };

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_TASKS_DB}/query`,
      {
        filter,
        sorts: [
          { timestamp: "last_edited_time", direction: "descending" },
        ],
        page_size: Math.min(limit * 2, 100),
      },
      { headers: notionHeaders() }
    );

    const rawTasks = r.data.results.map(page => {
      const props = page.properties || {};
      const titleArr = props["Task name"]?.title || [];
      const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

      const priority = props["Priority"]?.select?.name || null;
      const dueDate  = props["Due date"]?.date?.start || null;
      const completedAt = page.last_edited_time || null;

      const companyRel = props["🏢  CRM Companies"]?.relation || [];
      const linkedCompanyId = companyRel[0]?.id || null;

      return {
        id: page.id,
        url: page.url,
        name,
        priority,
        dueDate,
        completedAt,
        linkedCompanyId,
      };
    });

    const uniqueCompanyIds = [...new Set(rawTasks.map(t => t.linkedCompanyId).filter(Boolean))];
    const companyNameById = new Map();
    if (uniqueCompanyIds.length > 0) {
      await Promise.all(uniqueCompanyIds.map(async (id) => {
        try {
          const cr = await axios.get(
            `https://api.notion.com/v1/pages/${id}`,
            { headers: notionHeaders(), timeout: 6000 }
          );
          const props = cr.data.properties || {};
          const titleArr = props["Company name"]?.title || [];
          const cname = titleArr.map(t => t.plain_text || t.text?.content || "").join("");
          if (cname) companyNameById.set(id, cname);
        } catch (_) { }
      }));
    }

    const tasks = rawTasks.map(t => ({
      id: t.id,
      url: t.url,
      name: t.name,
      priority: t.priority,
      dueDate: t.dueDate,
      completedAt: t.completedAt,
      companyName: t.linkedCompanyId ? (companyNameById.get(t.linkedCompanyId) || null) : null,
    })).slice(0, limit);

    res.json({
      ok: true,
      cutoffDays: days,
      cutoffISO,
      total: tasks.length,
      tasks,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /notion/create-task
// ─────────────────────────────────────────────────────────────────────────────

router.post("/create-task", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const {
    taskName, description, summary,
    dueDate, priority, status,
    assignee, channel, taskType,
    companyName, personName,
  } = req.body || {};

  if (!taskName || typeof taskName !== "string" || !taskName.trim()) {
    return res.status(400).json({ error: "taskName required" });
  }

  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate).trim())) {
    return res.status(400).json({ error: `dueDate must be YYYY-MM-DD, got "${dueDate}"` });
  }

  try {
    let companyPageId   = null;
    let companyResolved = false;
    if (companyName && String(companyName).trim()) {
      try {
        const cq = await axios.post(
          `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
          { filter: { property: "Company name", title: { contains: String(companyName).trim().slice(0, 100) } }, page_size: 1 },
          { headers: notionHeaders() }
        );
        if (cq.data.results.length > 0) {
          companyPageId   = cq.data.results[0].id;
          companyResolved = true;
        }
      } catch (_) { }
    }

    let personPageId   = null;
    let personResolved = false;
    if (personName && String(personName).trim()) {
      try {
        const pq = await axios.post(
          `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
          { filter: { property: "Name", title: { contains: String(personName).trim().slice(0, 100) } }, page_size: 1 },
          { headers: notionHeaders() }
        );
        if (pq.data.results.length > 0) {
          personPageId   = pq.data.results[0].id;
          personResolved = true;
        }
      } catch (_) { }
    }

    let assigneeId       = null;
    let assigneeResolved = false;
    if (assignee && typeof assignee === "string") {
      assigneeId = TASK_ASSIGNEE_ID_BY_NAME[assignee.trim().toLowerCase()] || null;
      assigneeResolved = !!assigneeId;
    }

    const props = {
      "Task name": { title: [{ text: { content: taskName.trim().slice(0, 2000) } }] },
    };

    if (description && String(description).trim()) {
      props["Description"] = { rich_text: [{ text: { content: String(description).trim().slice(0, 2000) } }] };
    }
    if (summary && String(summary).trim()) {
      props["Summary"] = { rich_text: [{ text: { content: String(summary).trim().slice(0, 2000) } }] };
    }
    if (dueDate && String(dueDate).trim()) {
      props["Due date"] = { date: { start: String(dueDate).trim() } };
    }
    if (priority && String(priority).trim()) {
      props["Priority"] = { select: { name: String(priority).trim() } };
    }
    props["Status"] = { status: { name: (status && String(status).trim()) || "Not started" } };

    if (assigneeId) {
      props["Assignee"] = { people: [{ id: assigneeId }] };
    }

    const channelArr = parseIfString(channel);
    const channelList = Array.isArray(channelArr)
      ? channelArr
      : (channelArr ? [channelArr] : []);
    if (channelList.length) {
      props["Channel"] = { multi_select: channelList.map(c => ({ name: String(c) })) };
    }

    const taskTypeArr = parseIfString(taskType);
    const taskTypeList = Array.isArray(taskTypeArr)
      ? taskTypeArr
      : (taskTypeArr ? [taskTypeArr] : []);
    if (taskTypeList.length) {
      props["Task type"] = { multi_select: taskTypeList.map(t => ({ name: String(t) })) };
    }

    if (companyPageId) {
      props["🏢  CRM Companies"] = { relation: [{ id: companyPageId }] };
    }
    if (personPageId) {
      props["👤  CRM People"] = { relation: [{ id: personPageId }] };
    }

    const created = await axios.post(
      "https://api.notion.com/v1/pages",
      { parent: { database_id: NOTION_TASKS_DB }, properties: props },
      { headers: notionHeaders() }
    );

    console.log(`[notion/create-task] OK pageId=${created.data.id} name="${taskName.trim().slice(0, 60)}" assignee=${assignee || "-"} due=${dueDate || "-"}`);

    res.json({
      ok: true,
      pageId: created.data.id,
      url: created.data.url,
      taskName: taskName.trim(),
      dueDate: dueDate || null,
      priority: priority || null,
      status: (status && String(status).trim()) || "Not started",
      assignee: assignee || null,
      assigneeResolved,
      companyResolved,
      personResolved,
      warnings: [
        (companyName && !companyResolved) ? `Company "${companyName}" not found — task created without company link` : null,
        (personName  && !personResolved)  ? `Person "${personName}" not found — task created without person link`   : null,
        (assignee    && !assigneeResolved) ? `Assignee "${assignee}" not recognized (use "anton" or "pavel") — task created unassigned` : null,
      ].filter(Boolean),
    });
  } catch (err) {
    const detail = err.response?.data;
    console.error("[notion/create-task] error:", JSON.stringify(detail || err.message));
    res.status(err.response?.status || 500).json({
      error: detail?.message || err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /notion/page-blocks/:pageId
// Returns all blocks of a Notion page, recursively fetching children.
// Query params:
//   depth  — max recursion depth (default 3, max 5)
//   raw    — if "1", return raw Notion block objects; otherwise compact form
// ─────────────────────────────────────────────────────────────────────────────

async function fetchBlocksRecursive(blockId, depth, maxDepth, headers) {
  const blocks = [];
  let cursor;
  do {
    const params = { page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    const r = await axios.get(
      `https://api.notion.com/v1/blocks/${blockId}/children`,
      { headers, params, timeout: 15000 }
    );
    for (const block of r.data.results) {
      const compact = compactBlock(block);
      if (block.has_children && depth < maxDepth) {
        compact.children = await fetchBlocksRecursive(block.id, depth + 1, maxDepth, headers);
      }
      blocks.push(compact);
    }
    cursor = r.data.has_more ? r.data.next_cursor : null;
  } while (cursor);
  return blocks;
}

function extractRichText(rtArr) {
  if (!Array.isArray(rtArr)) return "";
  return rtArr.map(t => t.plain_text || t.text?.content || "").join("").trim();
}

function compactBlock(block) {
  const type = block.type;
  const data = block[type] || {};
  const text = extractRichText(data.rich_text || data.text || []);
  const compact = { id: block.id, type, text };

  // Capture checkbox state
  if (type === "to_do") compact.checked = data.checked || false;

  // Capture heading level
  if (type.startsWith("heading_")) {
    compact.level = parseInt(type.replace("heading_", ""), 10);
  }

  // Table row cells
  if (type === "table_row") {
    compact.cells = (data.cells || []).map(cell => extractRichText(cell));
  }

  compact.has_children = block.has_children || false;
  return compact;
}

router.get("/page-blocks/:pageId", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { pageId } = req.params;
  if (!pageId) return res.status(400).json({ error: "pageId required" });

  const maxDepth = Math.min(5, Math.max(1, parseInt(req.query.depth, 10) || 3));

  try {
    const blocks = await fetchBlocksRecursive(pageId, 0, maxDepth, notionHeaders());
    res.json({ ok: true, pageId, total: blocks.length, blocks });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /notion/discovery-card-fill/:pageId
//
// Reads a Discovery Card page and scores each section by how many
// fields are filled vs empty (___).
//
// Returns:
//   { ok, pageId, companyName, totalScore, maxScore, fillPct,
//     sections: [ { name, filled, total, fillPct, fields: [...] } ] }
// ─────────────────────────────────────────────────────────────────────────────

// Discovery Card sections and their expected field labels.
// Matches the actual card structure seen in screenshots.
const DC_SECTIONS = [
  {
    name: "1. Partner Profile",
    fields: [
      "Company legal name",
      "Country of incorporation",
      "Website",
      "Founded",
      "Revenue / Size",
      "Contact person",
      "Title / Role",
      "Email",
      "Phone",
      "Telegram / WhatsApp",
      "Licenses held",
      "Primary role",
    ],
  },
  {
    name: "2. Business Profile",
    fields: [
      "Business description",
      "Business model",
      "Target markets / geography",
      "Corridors",
      "Monthly volume (USD)",
      "Current settlement method",
    ],
  },
  {
    name: "3. Client Mix & Volume Breakdown",
    fields: [
      "SME / Business Payments",
      "Fintech / PSP Clients",
      "OTC / Treasury Conversions",
    ],
  },
  {
    name: "4. Stablecoins & Chains",
    fields: [
      "Stablecoins used",
      "Chains used",
    ],
  },
  {
    name: "5. Volumes & Sizing",
    fields: [
      "Monthly on-chain volume",
      "Number of transactions",
      "Average transaction size",
      "Peak volume corridors",
    ],
  },
  {
    name: "6. Pain Points & Needs",
    fields: [
      "Current pain points",
      "What do you need from Plexo",
    ],
  },
  {
    name: "7. Tech & Integration",
    fields: [
      "Current tech stack",
      "Integration preference",
      "API / SDK requirement",
    ],
  },
];

// Check if a block's text looks "empty" (just ___, dashes, or blank)
function isEmptyValue(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  // Common placeholder patterns: ___, —, -, N/A
  if (/^[_\-—–]+$/.test(t)) return true;
  if (/^n\/?a$/i.test(t)) return true;
  return false;
}

// Given flat+nested block list, extract all text content as a single string
function flattenBlockText(blocks) {
  const lines = [];
  function walk(blist) {
    for (const b of blist) {
      if (b.text) lines.push(b.text);
      if (b.cells) lines.push(...b.cells);
      if (b.children) walk(b.children);
    }
  }
  walk(blocks);
  return lines.join("\n");
}

// Score a section: look for each expected field label in the block content.
// A field is "filled" if its label appears AND is followed by non-empty text
// on the same line or in subsequent blocks.
function scoreSection(sectionFields, allText, blocks) {
  const results = [];
  const lowerText = allText.toLowerCase();

  for (const field of sectionFields) {
    const fieldLower = field.toLowerCase();
    const idx = lowerText.indexOf(fieldLower);
    if (idx === -1) {
      // Field heading not found at all — treat as empty
      results.push({ field, filled: false, reason: "label not found" });
      continue;
    }

    // Extract text after the field label (up to ~200 chars or next newline block)
    const after = allText.slice(idx + field.length, idx + field.length + 300);

    // Check for checkboxes: if the field is a checkbox group, check if any box is checked
    if (["Primary role", "Business model", "Stablecoins used", "Chains used", "Integration preference"].includes(field)) {
      // Look for checked checkboxes (✓, ✅, [x], or "checked: true" in our compact format)
      const hasChecked = blocks.some(b => b.type === "to_do" && b.checked);
      if (hasChecked) {
        results.push({ field, filled: true, reason: "checkbox checked" });
        continue;
      }
      // Also check raw text for check marks
      const checkRegion = allText.slice(Math.max(0, idx - 50), idx + 500);
      if (/✓|✅|\[x\]|☑/i.test(checkRegion)) {
        results.push({ field, filled: true, reason: "checkbox checked (text)" });
        continue;
      }
    }

    // Strip colon, whitespace from start of "after"
    const afterClean = after.replace(/^[\s:]+/, "").trim();

    if (isEmptyValue(afterClean) || afterClean.length < 2) {
      results.push({ field, filled: false, reason: "empty placeholder" });
    } else {
      results.push({ field, filled: true, reason: "has content" });
    }
  }

  const filled = results.filter(r => r.filled).length;
  return {
    filled,
    total: results.length,
    fillPct: results.length > 0 ? Math.round((filled / results.length) * 100) : 0,
    fields: results,
  };
}

router.get("/discovery-card-fill/:pageId", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { pageId } = req.params;
  if (!pageId) return res.status(400).json({ error: "pageId required" });

  try {
    // 1. Get page properties (for title/company name)
    const pageResp = await axios.get(
      `https://api.notion.com/v1/pages/${pageId}`,
      { headers: notionHeaders(), timeout: 10000 }
    );
    const props = pageResp.data.properties || {};
    const docTitle = extractRichText(props["Document"]?.title || []);
    const companyName = docTitle.replace(/^Discovery Card\s*\|\s*/i, "").trim();

    // 2. Fetch all blocks recursively (depth 4 to get table cells)
    const blocks = await fetchBlocksRecursive(pageId, 0, 4, notionHeaders());
    const allText = flattenBlockText(blocks);

    // 3. Score each section
    let totalFilled = 0;
    let totalFields = 0;
    const sections = DC_SECTIONS.map(sec => {
      const score = scoreSection(sec.fields, allText, blocks);
      totalFilled += score.filled;
      totalFields += score.total;
      return {
        name: sec.name,
        filled: score.filled,
        total: score.total,
        fillPct: score.fillPct,
        fields: score.fields,
      };
    });

    const overallFillPct = totalFields > 0 ? Math.round((totalFilled / totalFields) * 100) : 0;

    console.log(`[discovery-card-fill] ${companyName}: ${totalFilled}/${totalFields} fields = ${overallFillPct}%`);

    res.json({
      ok: true,
      pageId,
      companyName,
      totalFilled,
      totalFields,
      fillPct: overallFillPct,
      sections,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
