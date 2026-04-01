const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());
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
        try {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          console.log("Non-JSON:", url, res.statusCode, data.slice(0, 150));
          resolve({ ok: false, status: res.statusCode, data: {} });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Apollo uses api_key in request body, not header
async function apolloSearch(apolloKey, endpoint, body) {
  const res = await httpRequest("https://api.apollo.io/v1" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify({ ...body, api_key: apolloKey }),
  });
  return res.data;
}

async function hrRequest(key, endpoint, body) {
  const res = await httpRequest("https://api.heyreach.io/api/public" + endpoint, {
    method: body ? "POST" : "GET",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, data: res.data };
}

function mapPerson(p, company) {
  return {
    id: p.id,
    name: p.name,
    title: p.title || "—",
    company: (p.organization && p.organization.name) || company,
    location: [p.city, p.country].filter(Boolean).join(", ") || "—",
    linkedin: p.linkedin_url || null,
    email: p.email || null,
    website: (p.organization && p.organization.website_url) || null,
    phone: (p.phone_numbers && p.phone_numbers[0] && p.phone_numbers[0].sanitized_number) || null,
    hintUsed: false,
  };
}

app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  try {
    const d1 = await apolloSearch(apolloKey, "/people/search", {
      q_person_name: name, q_organization_name: company, page: 1, per_page: 5
    });
    let people = (d1 && Array.isArray(d1.people)) ? d1.people : [];

    if (people.length === 0 && company) {
      const d2 = await apolloSearch(apolloKey, "/people/search", {
        q_organization_name: company, page: 1, per_page: 25
      });
      const all = (d2 && Array.isArray(d2.people)) ? d2.people : [];
      const parts = name.toLowerCase().split(" ").filter(Boolean);
      people = all
        .map(p => ({ p, score: parts.filter(pt => (p.name || "").toLowerCase().includes(pt)).length }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(x => x.p);
    }

    if (people.length === 0 && name) {
      const d3 = await apolloSearch(apolloKey, "/people/search", {
        q_person_name: name, page: 1, per_page: 5
      });
      people = (d3 && Array.isArray(d3.people)) ? d3.people : [];
    }

    res.json(people.map(p => mapPerson(p, company)));
  } catch (e) {
    console.error("Apollo search error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/apollo/match", async (req, res) => {
  const { apolloKey, linkedinUrl, name, company } = req.body;
  try {
    const d = await apolloSearch(apolloKey, "/people/match", {
      linkedin_url: linkedinUrl, reveal_personal_emails: true
    });
    const p = d && d.person;
    if (!p) return res.json(null);
    res.json({
      id: p.id || linkedinUrl,
      name: p.name || name,
      title: p.title || "—",
      company: (p.organization && p.organization.name) || company,
      location: [p.city, p.country].filter(Boolean).join(", ") || "—",
      linkedin: p.linkedin_url || linkedinUrl,
      email: p.email || null,
      website: (p.organization && p.organization.website_url) || null,
      phone: (p.phone_numbers && p.phone_numbers[0] && p.phone_numbers[0].sanitized_number) || null,
      hintUsed: true,
    });
  } catch (e) {
    console.error("Apollo match error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/heyreach/check", async (req, res) => {
  const { key } = req.body;
  try {
    console.log("Checking HeyReach key:", key ? key.slice(0,8) + "..." : "empty");
    const res2 = await httpRequest("https://api.heyreach.io/api/public/auth/CheckApiKey", {
      method: "GET",
      headers: { "X-API-KEY": key, "Accept": "application/json" },
    });
    console.log("HeyReach check status:", res2.status, "ok:", res2.ok);
    // HeyReach CheckApiKey returns 200 with empty body on success
    res.json({ ok: res2.status === 200, status: res2.status });
  } catch (e) {
    console.error("HeyReach check error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/heyreach/senders", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await hrRequest(key, "/linkedInAccount/GetAll", { offset: 0, limit: 50 });
    res.json(r.data.items || r.data.linkedInAccounts || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/create", async (req, res) => {
  const { key, ...body } = req.body;
  try {
    const r = await hrRequest(key, "/campaign/Create", body);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/addlead", async (req, res) => {
  const { key, ...body } = req.body;
  try {
    const r = await hrRequest(key, "/campaign/AddLeads", body);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaigns", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await hrRequest(key, "/campaign/GetAll", { offset: 0, limit: 20 });
    res.json(r.data.items || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/leads", async (req, res) => {
  const { key, campaignId } = req.body;
  try {
    const r = await hrRequest(key, "/campaign/GetLeads", { campaignId, offset: 0, limit: 100 });
    res.json(r.data.items || r.data.leads || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
