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
      // First try exact match, then contains
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
// UPSERT: updates existing OR creates new. Does NOT handle tags separately.
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
// UPSERT + Tags additive merge. Preferred for BD scoring writeback.
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

module.exports = router;
