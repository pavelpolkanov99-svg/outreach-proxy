const express = require("express");
const axios   = require("axios");
const { filterPerson } = require("../lib/apollo");

const router = express.Router();

// ── POST /apollo/search ───────────────────────────────────────────────────────
router.post("/search", async (req, res) => {
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

// ── POST /apollo/match ────────────────────────────────────────────────────────
// Accepts: id (Apollo person id) OR firstName+lastName+organizationName/domain
// OR linkedinUrl. Returns compact filtered profile.
router.post("/match", async (req, res) => {
  const { apolloKey, id, firstName, lastName, organizationName, domain, linkedinUrl } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });
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
// Enrich up to 50 people in parallel via Promise.all. Each item in `people`
// can have any combination of: id, firstName+lastName+organizationName,
// domain, linkedinUrl. Returns compact filtered profiles in same order.
// Failed lookups return null at the corresponding index instead of throwing.
//
// Input shape: { apolloKey, people: [{id}, {firstName, lastName, organizationName}, ...] }
// Output shape: { ok, total, succeeded, failed, results: [filteredPerson|null, ...] }
router.post("/bulk-match", async (req, res) => {
  const { apolloKey, people } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });
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

module.exports = router;
