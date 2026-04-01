const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(__dirname));

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data) }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, json: () => ({}) }); }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function apolloPost(endpoint, apolloKey, body) {
  const res = await httpRequest("https://api.apollo.io/v1" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function hrPost(endpoint, key, body) {
  const res = await httpRequest("https://api.heyreach.io/api/public" + endpoint, {
    method: body ? "POST" : "GET",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function hrGet(endpoint, key) {
  const res = await httpRequest("https://api.heyreach.io/api/public" + endpoint, {
    method: "GET",
    headers: { "X-API-KEY": key },
  });
  return { ok: res.ok, status: res.status };
}

function mapPerson(p, company) {
  return {
    id: p.id,
    name: p.name,
    title: p.title || "—",
    company: (p.organization && p.organization.name) ? p.organization.name : company,
    location: [p.city, p.country].filter(Boolean).join(", ") || "—",
    linkedin: p.linkedin_url || null,
    email: p.email || null,
    website: (p.organization && p.organization.website_url) ? p.organization.website_url : null,
    phone: (p.phone_numbers && p.phone_numbers[0]) ? p.phone_numbers[0].sanitized_number : null,
    hintUsed: false,
  };
}

// Apollo search - 3 level fallback
app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  try {
    // Level 1: name + company
    const data1 = await apolloPost("/people/search", apolloKey, {
      q_person_name: name, q_organization_name: company, page: 1, per_page: 5
    });
    let people = (data1 && data1.people) ? data1.people : [];

    // Level 2: company only, filter by name similarity
    if (people.length === 0) {
      const data2 = await apolloPost("/people/search", apolloKey, {
        q_organization_name: company, page: 1, per_page: 25
      });
      const all = (data2 && data2.people) ? data2.people : [];
      const nameLower = name.toLowerCase();
      const parts = nameLower.split(" ").filter(Boolean);
      const scored = all
        .map(p => ({ p, score: parts.filter(part => (p.name || "").toLowerCase().includes(part)).length }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
      people = scored.slice(0, 5).map(x => x.p);
    }

    // Level 3: name only
    if (people.length === 0) {
      const data3 = await apolloPost("/people/search", apolloKey, {
        q_person_name: name, page: 1, per_page: 5
      });
      people = (data3 && data3.people) ? data3.people : [];
    }

    res.json(people.map(p => mapPerson(p, company)));
  } catch (e) {
    console.error("Apollo search error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apollo match by LinkedIn
app.post("/apollo/match", async (req, res) => {
  const { apolloKey, linkedinUrl, name, company } = req.body;
  try {
    const data = await apolloPost("/people/match", apolloKey, {
      linkedin_url: linkedinUrl, reveal_personal_emails: true
    });
    const p = data && data.person;
    if (!p) return res.json(null);
    res.json({
      id: p.id || linkedinUrl,
      name: p.name || name,
      title: p.title || "—",
      company: (p.organization && p.organization.name) ? p.organization.name : company,
      location: [p.city, p.country].filter(Boolean).join(", ") || "—",
      linkedin: p.linkedin_url || linkedinUrl,
      email: p.email || null,
      website: (p.organization && p.organization.website_url) ? p.organization.website_url : null,
      phone: (p.phone_numbers && p.phone_numbers[0]) ? p.phone_numbers[0].sanitized_number : null,
      hintUsed: true,
    });
  } catch (e) {
    console.error("Apollo match error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/heyreach/check", async (req, res) => {
  const { key } = req.body;
  try { const r = await hrGet("/auth/CheckApiKey", key); res.json({ ok: r.ok }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/heyreach/senders", async (req, res) => {
  const { key } = req.body;
  try {
    const data = await hrPost("/linkedInAccount/GetAll", key, { offset: 0, limit: 50 });
    res.json(data.items || data.linkedInAccounts || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/create", async (req, res) => {
  const { key, ...body } = req.body;
  try { res.json(await hrPost("/campaign/Create", key, body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/addlead", async (req, res) => {
  const { key, ...body } = req.body;
  try { res.json(await hrPost("/campaign/AddLeads", key, body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaigns", async (req, res) => {
  const { key } = req.body;
  try {
    const data = await hrPost("/campaign/GetAll", key, { offset: 0, limit: 20 });
    res.json(data.items || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/leads", async (req, res) => {
  const { key, campaignId } = req.body;
  try {
    const data = await hrPost("/campaign/GetLeads", key, { campaignId, offset: 0, limit: 100 });
    res.json(data.items || data.leads || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
