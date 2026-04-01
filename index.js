const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
}));
app.get("/", (req, res) => res.sendFile(__dirname + "/outreach-agent.html"));

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
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        try {
          resolve({ ok, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          // Empty body or non-JSON — still ok if status is 2xx
          resolve({ ok, status: res.statusCode, data: {} });
        }
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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apolloKey,
    },
    body: JSON.stringify(body),
  });
  return res.data;
}

async function hrPost(key, endpoint, body) {
  const url = "https://api.heyreach.io/api/public" + endpoint;
  const res = await httpRequest(url, {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.log("HeyReach POST", endpoint, "status:", res.status, JSON.stringify(res.data).slice(0,150));
  return res;
}

async function hrGet(key, endpoint) {
  const url = "https://api.heyreach.io/api/public" + endpoint;
  const res = await httpRequest(url, {
    method: "GET",
    headers: { "X-API-KEY": key, "Accept": "application/json" },
  });
  if (!res.ok) console.log("HeyReach GET", endpoint, "status:", res.status);
  return res;
}

function mapPerson(p, company) {
  const org = p.organization || {};
  const linkedin = p.linkedin_url || p.linkedin || (p.contact && p.contact.linkedin_url) || null;
  const linkedinCompany = org.linkedin_url || org.linkedin || null;
  return {
    id: p.id,
    name: p.name,
    title: p.title || "—",
    company: org.name || company,
    location: [p.city, p.country].filter(Boolean).join(", ") || "—",
    linkedin,
    linkedinCompany,
    email: p.email || (p.contact && p.contact.email) || null,
    website: org.website_url || org.primary_domain || null,
    phone: (p.phone_numbers && p.phone_numbers[0] && p.phone_numbers[0].sanitized_number) || null,
    hintUsed: false,
  };
}

// ── APOLLO ────────────────────────────────────────────────────────────────────

app.post("/apollo/search", async (req, res) => {
  const { apolloKey, name, company } = req.body;
  try {
    const d1 = await apolloPost("/mixed_people/api_search", apolloKey, {
      q_person_name: name, q_organization_name: company, page: 1, per_page: 5,
      reveal_personal_emails: true,
    });
    let people = (d1 && Array.isArray(d1.people)) ? d1.people : [];

    if (people.length === 0 && company) {
      const d2 = await apolloPost("/mixed_people/api_search", apolloKey, {
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
      const d3 = await apolloPost("/mixed_people/api_search", apolloKey, {
        q_person_name: name, page: 1, per_page: 5
      });
      people = (d3 && Array.isArray(d3.people)) ? d3.people : [];
    }

    // Enrich top results to get linkedin_url
    for (let i = 0; i < Math.min(people.length, 3); i++) {
      if (!people[i].linkedin_url && people[i].id) {
        try {
          const enrich = await apolloPost("/people/enrich", apolloKey, {
            id: people[i].id, reveal_personal_emails: true,
          });
          if (enrich && enrich.person) people[i] = { ...people[i], ...enrich.person };
        } catch {}
      }
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
    const d = await apolloPost("/people/match", apolloKey, {
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

app.post("/apollo/enrich", async (req, res) => {
  const { apolloKey, id } = req.body;
  try {
    const d = await apolloPost("/people/enrich", apolloKey, { id, reveal_personal_emails: true });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEYREACH ──────────────────────────────────────────────────────────────────

app.post("/heyreach/check", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await hrGet(key, "/auth/CheckApiKey");
    console.log("HeyReach check status:", r.status, "ok:", r.ok);
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    console.error("HeyReach check error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/heyreach/senders", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await hrPost(key, "/linkedInAccount/GetAll", { offset: 0, limit: 50 });
    console.log("Senders raw:", JSON.stringify(r.data).slice(0, 300));
    const senders = r.data.items || r.data.linkedInAccounts || r.data.data || (Array.isArray(r.data) ? r.data : []);
    res.json(senders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/create", async (req, res) => {
  const { key, ...body } = req.body;
  try {
    const r = await hrPost(key, "/campaign/Create", body);
    console.log("Campaign create response:", JSON.stringify(r.data).slice(0, 200));
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/addlead", async (req, res) => {
  const { key, ...body } = req.body;
  try {
    const r = await hrPost(key, "/campaign/AddLeads", body);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaigns", async (req, res) => {
  const { key } = req.body;
  try {
    const r = await hrPost(key, "/campaign/GetAll", { offset: 0, limit: 20 });
    res.json(r.data.items || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/heyreach/campaign/leads", async (req, res) => {
  const { key, campaignId } = req.body;
  try {
    const r = await hrPost(key, "/campaign/GetLeads", { campaignId, offset: 0, limit: 100 });
    res.json(r.data.items || r.data.leads || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
