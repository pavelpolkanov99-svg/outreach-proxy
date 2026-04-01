const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const APOLLO_BASE = "https://api.apollo.io/v1";
const HEYREACH_BASE = "https://api.heyreach.io/api/public";

// Apollo: search people
app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  try {
    const r = await fetch(`${APOLLO_BASE}/people/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey },
      body: JSON.stringify({ q_person_name: name, q_organization_name: company, page: 1, per_page: 5 }),
    });
    const data = await r.json();
    res.json((data.people || []).map(p => ({
      id: p.id,
      name: p.name,
      title: p.title || "—",
      company: p.organization?.name || company,
      location: [p.city, p.country].filter(Boolean).join(", ") || "—",
      linkedin: p.linkedin_url || null,
      email: p.email || null,
      website: p.organization?.website_url || null,
      phone: p.phone_numbers?.[0]?.sanitized_number || null,
      hintUsed: false,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apollo: match by LinkedIn URL
app.post("/apollo/match", async (req, res) => {
  const { apolloKey, linkedinUrl, name, company } = req.body;
  try {
    const r = await fetch(`${APOLLO_BASE}/people/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey },
      body: JSON.stringify({ linkedin_url: linkedinUrl, reveal_personal_emails: true }),
    });
    const data = await r.json();
    const p = data.person;
    if (!p) return res.json(null);
    res.json({
      id: p.id || linkedinUrl,
      name: p.name || name,
      title: p.title || "—",
      company: p.organization?.name || company,
      location: [p.city, p.country].filter(Boolean).join(", ") || "—",
      linkedin: p.linkedin_url || linkedinUrl,
      email: p.email || null,
      website: p.organization?.website_url || null,
      phone: p.phone_numbers?.[0]?.sanitized_number || null,
      hintUsed: true,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HeyReach: check key
app.post("/heyreach/check", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await fetch(`${HEYREACH_BASE}/auth/CheckApiKey`, { headers: { "X-API-KEY": key } });
    res.json({ ok: r.ok });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// HeyReach: get senders
app.post("/heyreach/senders", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await fetch(`${HEYREACH_BASE}/linkedInAccount/GetAll`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ offset: 0, limit: 50 }),
    });
    const data = await r.json();
    res.json(data?.items || data?.linkedInAccounts || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HeyReach: create campaign
app.post("/heyreach/campaign/create", async (req, res) => {
  const { key, ...body } = req.body;
  try {
    const r = await fetch(`${HEYREACH_BASE}/campaign/Create`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HeyReach: add lead
app.post("/heyreach/campaign/addlead", async (req, res) => {
  const { key, ...body } = req.body;
  try {
    const r = await fetch(`${HEYREACH_BASE}/campaign/AddLeads`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HeyReach: get campaigns
app.post("/heyreach/campaigns", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await fetch(`${HEYREACH_BASE}/campaign/GetAll`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ offset: 0, limit: 20 }),
    });
    const data = await r.json();
    res.json(data?.items || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HeyReach: get leads
app.post("/heyreach/campaign/leads", async (req, res) => {
  const { key, campaignId } = req.body;
  try {
    const r = await fetch(`${HEYREACH_BASE}/campaign/GetLeads`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId, offset: 0, limit: 100 }),
    });
    const data = await r.json();
    res.json(data?.items || data?.leads || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
