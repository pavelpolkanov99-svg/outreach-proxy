const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// ── CORS — allow requests from Claude artifacts and any browser ──────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Cache-Control");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Apollo search: POST /apollo/search ──────────────────────────────────────
// Body: { apolloKey, name, company }
app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });

  const [firstName, ...lastParts] = (name || "").trim().split(" ");
  const lastName = lastParts.join(" ");

  try {
    const r = await axios.post(
      "https://api.apollo.io/api/v1/mixed_people/search",
      { q_person_name: name,
        q_organization_name: company || undefined,
        page: 1,
        per_page: 5,
      },
      { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 15000 }
    );
    const people = (r.data?.people || []).map((p) => ({
      id: p.id,
      name: p.name,
      firstName: p.first_name,
      lastName: p.last_name,
      title: p.title,
      company: p.organization_name || p.organization?.name,
      location: [p.city, p.country].filter(Boolean).join(", "),
      linkedin: p.linkedin_url,
      email: p.email,
      website: p.organization?.website_url,
    }));

    res.json(people);
  } catch (err) {
    console.error("[/apollo/search]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.error || err.message,
    });
  }
});

// ── Apollo enrich by LinkedIn URL: POST /apollo/match ───────────────────────
// Body: { apolloKey, linkedinUrl, name, company }
app.post("/apollo/match", async (req, res) => {
  const { apolloKey, linkedinUrl, name, company } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "apolloKey required" });

  try {
    const r = await axios.post(
      "https://api.apollo.io/api/v1/people/match",
      { linkedin_url: linkedinUrl || undefined,
        name: name || undefined,
        organization_name: company || undefined,
      },
      { headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey }, timeout: 15000 }
    );
    const p = r.data?.person;
    if (!p) return res.json(null);

    res.json({
      id: p.id,
      name: p.name,
      firstName: p.first_name,
      lastName: p.last_name,
      title: p.title,
      company: p.organization_name || p.organization?.name,
      location: [p.city, p.country].filter(Boolean).join(", "),
      linkedin: p.linkedin_url,
      email: p.email,
    });
  } catch (err) {
    console.error("[/apollo/match]", err.response?.status, err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.error || err.message,
    });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
// POST /heyreach/proxy — generic HeyReach REST proxy
// Body: { hrKey, path, payload }
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

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.json({ service: "outreach-proxy", status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
