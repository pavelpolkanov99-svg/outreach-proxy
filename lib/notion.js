const axios = require("axios");

const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const NOTION_VERSION      = "2022-06-28";
const NOTION_COMPANIES_DB = "f9b59c5b05fa4df18f9569479633fd74";
const NOTION_PEOPLE_DB    = "f36b2a0f0ab241cebbdbd1d0874a55be";
const MESSAGES_HUB_DB     = "8617a441c4254b41be671a1e65946a03";

// Aliases used by routes/jobs (keep legacy names from v3.9)
const COMPANIES_DB_ID = NOTION_COMPANIES_DB;
const PEOPLE_DB_ID    = NOTION_PEOPLE_DB;

function notionHeaders() {
  return {
    "Authorization":  `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type":   "application/json",
  };
}

// ── Low-level helpers (used by Beeper sync engine and others) ────────────────
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

module.exports = {
  NOTION_TOKEN,
  NOTION_VERSION,
  NOTION_COMPANIES_DB,
  NOTION_PEOPLE_DB,
  MESSAGES_HUB_DB,
  COMPANIES_DB_ID,
  PEOPLE_DB_ID,
  notionHeaders,
  notionQuery,
  notionCreatePage,
  notionUpdatePage,
  findNotionCompany,
  findNotionPeopleByNames,
  findHubByRemoteId,
};
