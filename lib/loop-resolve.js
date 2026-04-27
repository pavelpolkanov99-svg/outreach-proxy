// lib/loop-resolve.js
// ─────────────────────────────────────────────────────────────────────────────
// Helpers for Loop's auto-CRM-sync flow:
//   1. Resolve canonical Company name from a meeting context
//      (cascade: title parsing → Apollo org-enrich → Parallel research)
//   2. Dedup check against Notion CRM before creating new Company
//
// All HTTP calls go through the same outreach-proxy (axios → 127.0.0.1:PORT)
// so the helpers stay agnostic to whether they're invoked from a route handler
// or a cron job.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const APOLLO_KEY     = process.env.APOLLO_KEY;
const PORT           = process.env.PORT || 3000;
const PROXY_BASE     = process.env.PROXY_BASE || `http://127.0.0.1:${PORT}`;

// ── Domain normalization (re-exported for reuse) ─────────────────────────────
function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).toLowerCase().trim();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  return s || null;
}

// ── Title parsing (cheapest first attempt) ───────────────────────────────────
// Try to extract the company name from a meeting title like:
//   "Plexo <> Banking Circle | Discovery"
//   "Plexo x Monerium - Sync"
//   "Banking Circle Sync"
//   "Discovery: Banking Circle"
//
// Returns null if no clean match — we do NOT want to guess.
function parseCompanyFromTitle(title, ourBrand = "Plexo") {
  if (!title) return null;
  const t = String(title).trim();

  // Pattern: "Plexo <> Foo Co | something" or "Plexo x Foo Co - something"
  // The our-brand-on-the-left form is the dominant one Pavel uses.
  const sep = "(?:<>|x|×|<-?->|->|/|\\|)";
  const re1 = new RegExp(
    `^\\s*${ourBrand}\\s*${sep}\\s*([^|\\-—:]+?)(?:\\s*[|\\-—:]\\s*.+)?$`,
    "i"
  );
  const m1 = t.match(re1);
  if (m1 && m1[1]) {
    const name = m1[1].trim();
    if (name.length >= 2 && name.length <= 60) return name;
  }

  // Pattern: "Discovery: Foo Co" / "Sync with Foo Co" / "Intro - Foo Co"
  const re2 = /(?:discovery|sync|intro|call|meeting|chat)\s*(?:with|:|-|—)\s*([A-Z][^|:]{1,40})$/i;
  const m2 = t.match(re2);
  if (m2 && m2[1]) {
    const name = m2[1].trim();
    if (name.length >= 2 && name.length <= 60) return name;
  }

  // Pattern: "Foo Co Sync" / "Foo Co Discovery"
  const re3 = /^([A-Z][\w &.-]{1,40}?)\s+(?:sync|discovery|intro|call)$/i;
  const m3 = t.match(re3);
  if (m3 && m3[1]) {
    const name = m3[1].trim();
    if (name.length >= 2 && name.length <= 60) return name;
  }

  return null;
}

// ── Apollo org-enrich (second cascade step) ──────────────────────────────────
async function apolloOrgEnrich(domain) {
  if (!APOLLO_KEY) return null;
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return null;
  try {
    const r = await axios.post(
      `${PROXY_BASE}/apollo/org-enrich`,
      { apolloKey: APOLLO_KEY, domain: cleanDomain },
      { timeout: 20000 }
    );
    return r.data || null;  // filterOrganization shape, or null
  } catch (err) {
    console.error(`[loop-resolve] Apollo org-enrich failed for ${cleanDomain}: ${err.message}`);
    return null;
  }
}

// ── Apollo people enrichment (for person + LinkedIn discovery) ───────────────
async function apolloPersonEnrich({ email, firstName, lastName, organizationName, domain, linkedinUrl }) {
  if (!APOLLO_KEY) return null;
  try {
    // Apollo's /people/match accepts email indirectly via firstName+lastName+domain.
    // If we only have an email, split into local-part + domain as a hint.
    const payload = {};
    if (email) {
      const [local, dom] = String(email).toLowerCase().split("@");
      if (local) {
        const parts = local.split(/[._-]/).filter(Boolean);
        payload.firstName = firstName || parts[0];
        payload.lastName  = lastName  || (parts[1] || "");
      }
      if (dom) payload.domain = dom;
    } else {
      if (firstName)        payload.firstName        = firstName;
      if (lastName)         payload.lastName         = lastName;
      if (organizationName) payload.organizationName = organizationName;
      if (domain)           payload.domain           = domain;
      if (linkedinUrl)      payload.linkedinUrl      = linkedinUrl;
    }

    const r = await axios.post(
      `${PROXY_BASE}/apollo/match`,
      { apolloKey: APOLLO_KEY, ...payload },
      { timeout: 20000 }
    );
    return r.data || null;  // filterPerson shape, or null
  } catch (err) {
    console.error(`[loop-resolve] Apollo person-enrich failed: ${err.message}`);
    return null;
  }
}

// ── Notion dedup check (4-step cascade) ──────────────────────────────────────
// Returns the matched Notion page (digest-shaped) or null if truly new.
//
// Steps:
//   1. Domain exact match via /notion/insight-by-domain
//   2. Name exact match (Notion title.equals)
//   3. Name fuzzy match (Notion title.contains) — guarded against short generic names
//   4. None matched → new company
async function dedupCheck({ canonicalName, domain }) {
  // Step 1: domain exact
  if (domain) {
    try {
      const r = await axios.get(
        `${PROXY_BASE}/notion/insight-by-domain`,
        { params: { domain }, timeout: 15000 }
      );
      if (r.data?.found && r.data?.company) {
        return { matched: true, via: "domain", company: r.data.company };
      }
    } catch (err) {
      console.error(`[loop-resolve] dedup domain lookup failed: ${err.message}`);
    }
  }

  if (!canonicalName) return { matched: false };

  // Step 2 + 3: name match via /notion/check-duplicates (server uses contains)
  // Guard against false positives on short generic names (Bee, API, Loop, etc.)
  const skipFuzzy = canonicalName.length < 6 ||
    /^(api|bank|fin|pay|tech|labs?)$/i.test(canonicalName.trim());

  try {
    const r = await axios.post(
      `${PROXY_BASE}/notion/check-duplicates`,
      { names: [canonicalName] },
      { timeout: 15000 }
    );
    const found = r.data?.found || [];
    if (found.length) {
      // /check-duplicates uses "contains" — good enough for fuzzy, but we
      // refuse the match if the name is too short to be reliable.
      if (skipFuzzy) {
        // Re-query with strict equals via /notion/search-company (does equals first)
        const strict = await axios.post(
          `${PROXY_BASE}/notion/search-company`,
          { name: canonicalName },
          { timeout: 15000 }
        );
        if (strict.data?.found) {
          return { matched: true, via: "name-equals", company: strict.data };
        }
        return { matched: false };
      }
      return { matched: true, via: "name-contains", company: found[0] };
    }
  } catch (err) {
    console.error(`[loop-resolve] dedup name lookup failed: ${err.message}`);
  }

  return { matched: false };
}

// ── Cascade resolver: { meetingTitle, attendeeEmail } → canonical company name + signals
// Returns:
//   {
//     canonicalName: string|null,    // best name we have
//     domain: string|null,           // normalized domain from email
//     source: "title"|"apollo"|"parallel"|null,
//     apolloOrg: filteredOrganization|null,   // populated if apollo step ran
//     // (parallel research is NOT done here — that's the cron's job)
//   }
async function resolveCompanyName({ meetingTitle, attendeeEmail }) {
  const result = {
    canonicalName: null,
    domain: null,
    source: null,
    apolloOrg: null,
  };

  // Extract domain from email
  if (attendeeEmail) {
    const dom = String(attendeeEmail).toLowerCase().split("@")[1];
    if (dom && !/^(gmail|yahoo|outlook|hotmail|icloud|protonmail|proton|aol|live|msn)\./.test(dom + ".")) {
      result.domain = normalizeDomain(dom);
    }
  }

  // Step 1: title parsing (cheap, instant)
  const fromTitle = parseCompanyFromTitle(meetingTitle);
  if (fromTitle) {
    result.canonicalName = fromTitle;
    result.source = "title";
    return result;
  }

  // Step 2: Apollo org-enrich by domain
  if (result.domain) {
    const org = await apolloOrgEnrich(result.domain);
    if (org && org.name) {
      result.canonicalName = org.name;
      result.apolloOrg     = org;
      result.source        = "apollo";
      return result;
    }
  }

  // Step 3: caller is expected to fall through to Parallel research with whatever
  // we have (just the domain, possibly). resolveCompanyName itself does NOT call
  // Parallel because that's a 1-3min op and shouldn't block path discovery.
  return result;
}

module.exports = {
  normalizeDomain,
  parseCompanyFromTitle,
  apolloOrgEnrich,
  apolloPersonEnrich,
  dedupCheck,
  resolveCompanyName,
};
