const express = require("express");
const axios   = require("axios");
const { filterPerson, filterOrganization } = require("../lib/apollo");

const router = express.Router();

// Server-side fallback. Cron jobs and internal callers don't pass a key in
// the request body — they rely on this env var. External callers (MCP tool,
// older client code) keep working unchanged because they still pass apolloKey
// in the body, which takes precedence.
const APOLLO_KEY_ENV = process.env.APOLLO_KEY || null;

function resolveKey(req) {
  return req.body?.apolloKey || APOLLO_KEY_ENV;
}

// ── GET /apollo/health ────────────────────────────────────────────────────────
// Quick check that server-side APOLLO_KEY is configured and reachable.
// Does NOT consume Apollo credits — only verifies env presence.
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serverKeyConfigured: !!APOLLO_KEY_ENV,
  });
});

// ── POST /apollo/search ───────────────────────────────────────────────────────
router.post("/search", async (req, res) => {
  const apolloKey = resolveKey(req);
  const { name, company } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required (pass in body or set APOLLO_KEY env)" });
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

// ── POST /apollo/match ────────────────────────────────────────────────────────
router.post("/match", async (req, res) => {
  const apolloKey = resolveKey(req);
  const { id, firstName, lastName, organizationName, domain, linkedinUrl } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required (pass in body or set APOLLO_KEY env)" });
  try {
    const payload = id
      ? { id }
      : { first_name: firstName, last_name: lastName, organization_name: organizationName, domain, linkedin_url: linkedinUrl };
    const r = await axios.post(
      "https://api.apollo.io/api/v1/people/match",
      payload,
      { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 15000 }
    );
    const p = r.data?.person;
    if (!p) return res.json(null);
    res.json(filterPerson(p));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── POST /apollo/bulk-match ───────────────────────────────────────────────────
router.post("/bulk-match", async (req, res) => {
  const apolloKey = resolveKey(req);
  const { people } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required (pass in body or set APOLLO_KEY env)" });
  if (!Array.isArray(people) || people.length === 0) {
    return res.status(400).json({ error: "people[] required (1-50 items)" });
  }
  if (people.length > 50) {
    return res.status(400).json({ error: "max 50 people per call" });
  }

  const enrichOne = async (person) => {
    try {
      const payload = person.id
        ? { id: person.id }
        : {
            first_name: person.firstName,
            last_name: person.lastName,
            organization_name: person.organizationName,
            domain: person.domain,
            linkedin_url: person.linkedinUrl,
          };
      const r = await axios.post(
        "https://api.apollo.io/api/v1/people/match",
        payload,
        { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 20000 }
      );
      const p = r.data?.person;
      return p ? filterPerson(p) : null;
    } catch (err) {
      return null;
    }
  };

  const t0 = Date.now();
  const results = await Promise.all(people.map(enrichOne));
  const elapsedMs = Date.now() - t0;

  res.json({
    ok: true,
    total: people.length,
    succeeded: results.filter(Boolean).length,
    failed: results.filter((r) => r === null).length,
    elapsedMs,
    results,
  });
});

// ── POST /apollo/org-enrich ───────────────────────────────────────────────────
// Look up canonical company info by domain. Used by Loop to derive Company name
// from a calendar attendee's email (e.g. charlie@bankingcircle.com → "Banking Circle").
//
// Body: { apolloKey?, domain }
// Returns: filteredOrganization | null
router.post("/org-enrich", async (req, res) => {
  const apolloKey = resolveKey(req);
  const { domain } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required (pass in body or set APOLLO_KEY env)" });
  if (!domain)    return res.status(400).json({ error: "domain required" });

  const cleanDomain = String(domain)
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];

  try {
    const r = await axios.get(
      "https://api.apollo.io/api/v1/organizations/enrich",
      {
        params: { domain: cleanDomain },
        headers: { "X-Api-Key": apolloKey },
        timeout: 15000,
      }
    );
    const org = r.data?.organization;
    if (!org) return res.json(null);
    res.json(filterOrganization(org));
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.error || err.message,
    });
  }
});

module.exports = router;
