// ─────────────────────────────────────────────────────────────────────────────
// Messaging Hub auto-enrichment (v3.31.0)
//
// Runs once for every NEW chat the Beeper → Notion sync creates in the
// Messaging Hub. Fully automatic (no approval step):
//
//   1. Classify the chat with Claude Haiku from its recent messages:
//      Category + external people + their company.
//   2. Spam / Noise, Personal, Staff  → set Category only, no spend, stop.
//   3. CRM dedup FIRST. Company: website domain, exact name, corporate email
//      domain (also via the Email Activity Log). Person: ANY match on Telegram
//      handle, email (People + Email Activity Log), LinkedIn or name → link the
//      existing record, never create.
//   4. Apollo people/match only for people not found anywhere → email,
//      LinkedIn, title; then one more dedup pass on Apollo's email / LinkedIn.
//      Never phone numbers (no reveal_phone_number, no waterfall).
//      LinkedIn chats: the profile URL is decoded from the Beeper sender id
//      for free. Existing people missing Email / LinkedIn / Role get ONE Apollo
//      try (empty fields only), then People "Enrichment Status" = Done/Skipped
//      so they are never retried.
//   5. Create only what is still missing (Companies + People).
//   6. BD scoring (Parallel Core, Framework v2.2) only for companies that were
//      just created AND the chat is Partnership / Client. Companies already in
//      Notion are never re-scored. Runs in the background (Core takes 1-5 min).
//      Writes BD Score, Priority (P1→1, P2→2, P3/Skip→3, Hard Kill→HK), an
//      Insight note and the Company description.
//   7. Raise the company's Stage from the chat context (never lowers it,
//      never touches Win / Lost / Not relevant). Default: Opened Conversation.
//      Already-enriched chats get this stage pass on every sync.
//   8. Write Category / Link: People / Link: Companies / Enrichment Status back
//      to the Hub row.
//
// Kill switch: HUB_AUTO_ENRICH=false in Railway env.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const {
  COMPANIES_DB_ID,
  PEOPLE_DB_ID,
  notionQuery,
  notionCreatePage,
  notionUpdatePage,
  notionHeaders,
} = require("./notion");
const { PARALLEL_KEY, parallelHeaders, buildResearchQuery, parallelTaskSpec } = require("./parallel");

const EMAILS_DB_ID    = "9266116f0a404cde91ae290dc8246040"; // 📧 Email Activity Log (Gmail sinker)
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const APOLLO_KEY      = process.env.APOLLO_KEY || null;

const CATEGORIES = [
  "Partnership", "Client", "Investor / VC", "Sales Rep", "Media", "Advisor",
  "Staff", "Regulator", "Personal", "Spam / Noise", "Outreach",
];
const NO_SPEND_CATEGORIES = new Set(["Spam / Noise", "Personal", "Staff"]);
const SCORE_CATEGORIES    = new Set(["Partnership", "Client"]);
const COMPANY_TYPES = [
  "Investor", "Partner", "Client", "Vendor", "Other", "Regulator", "Event",
  "Competitor", "Media", "Foundation", "Stablecoin Issuer", "Infra",
  "Liquidity / FX", "Crypto Exchange",
];
// Companies DB "Stage" ladder, lowest → highest. Stage only ever moves UP.
const STAGE_LADDER = [
  "To Contact", "Outreach Started", "Opened Conversation", "Keeping in the Loop",
  "Warm discussions", "Discovery Process P2", "Discovery Process P1",
  "Early Commitment", "Onboarding", "Win",
];
const TERMINAL_STAGES = new Set(["Win", "Lost", "Not relevant", "DELETE"]); // never touched automatically
const DEFAULT_STAGE   = "Opened Conversation";
const STAGE_SIGNALS = [
  "Outreach Started", "Opened Conversation", "Keeping in the Loop", "Warm discussions",
  "Discovery Process", "Early Commitment", "Onboarding",
];
const INTERNAL_NAME = /(anton|titov|pavel|paul polkanov|polkanov|roman shprenger|plexo|remide)/i;
const AUTO_NOTE = () => `Auto-created by Loop OS Hub enrichment (Beeper), ${new Date().toISOString().slice(0, 10)}.`;

// Include the API's response body in logs; "Request failed with status code 400"
// alone is not debuggable.
function errDetail(e) {
  const body = e?.response?.data;
  const bodyStr = body ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
  return `${e?.message || e}${bodyStr ? ` | body=${bodyStr.slice(0, 400)}` : ""}`;
}

function isEnabled() {
  return process.env.HUB_AUTO_ENRICH !== "false" && !!ANTHROPIC_KEY;
}

// ── 1. Classification ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You classify a business chat for Plexo, a stablecoin clearing network for licensed financial institutions ("SWIFT for stablecoins").
Plexo team (never list them as external people): Anton Titov (CEO), Pavel / Paul Polkanov (Head of Partnerships), Roman Shprenger (CTO). Plexo was formerly RemiDe.

Categories (pick 1-2):
- Partnership: licensed FI / PSP / VASP / OTC desk / bank that is or may join the network as a counterparty (corridors, onboarding, KYB, liquidity, payouts)
- Client: company that would send flows / use Plexo as a customer
- Investor / VC: funds, angels, family offices, fundraising, investor intros
- Sales Rep: commission-based agents / introducers bringing deals to Plexo
- Media: press, podcasts, PR agencies
- Advisor: advisors to Plexo
- Staff: Plexo team members only
- Regulator: central banks, regulators
- Personal: friends, family, non-work
- Spam / Noise: unrelated cold pitches to us, recruiters, ad sellers, mass community groups, system chats
- Outreach: our own first-touch outreach with no real reply yet

Deal stage reached in THIS chat (pick the highest one the messages clearly support):
- Outreach Started: we wrote, they have not replied yet
- Opened Conversation: they replied, a two-way conversation exists (default once they reply)
- Keeping in the Loop: low-intensity, periodic updates, no active next step
- Warm discussions: active interest, calls scheduled or held, concrete talk about corridors / terms / investment
- Discovery Process: Discovery Card, NDA, KYB documents or detailed data exchanged
- Early Commitment: verbal or written commitment, terms agreed, pilot or LOI agreed
- Onboarding: onboarding link sent, platform onboarding / KYB review in progress
Never output Win, Lost or Not relevant.

Return ONLY JSON:
{"category":["..."],"stage":"Opened Conversation","people":[{"name":"Full Name","role":null,"telegram":null,"linkedin":null,"email":null}],"company":{"name":null,"website":null,"type":"Partner"}}
Rules: people = external counterparts only (max 3). company = the counterpart's main company or null if not visible. Never invent websites, roles, handles or emails: use null unless visible in the chat. company.type is one of: ${COMPANY_TYPES.join(", ")}.`;

function renderMessages(chatName, messages = []) {
  const lines = messages.slice(0, 25).reverse().map(m => {
    const who = m.isSender ? "Plexo" : (m.senderName || "Them");
    return `${who}: ${String(m.text || "[media]").replace(/\s+/g, " ").slice(0, 400)}`;
  });
  return `Chat name: ${chatName}\n\nRecent messages (oldest first):\n${lines.join("\n")}`;
}

function parseJsonLoose(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in model output");
  return JSON.parse(s.slice(start, end + 1));
}

function sanitizeClassification(raw) {
  const category = (Array.isArray(raw?.category) ? raw.category : [raw?.category])
    .filter(c => CATEGORIES.includes(c)).slice(0, 2);
  const people = (Array.isArray(raw?.people) ? raw.people : [])
    .filter(p => p && typeof p.name === "string" && p.name.trim().length >= 2)
    .filter(p => !INTERNAL_NAME.test(p.name))
    .slice(0, 3)
    .map(p => ({
      name: p.name.trim(),
      role: typeof p.role === "string" ? p.role.slice(0, 200) : null,
      telegram: typeof p.telegram === "string" ? p.telegram.slice(0, 100) : null,
      linkedin: typeof p.linkedin === "string" && /^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(p.linkedin) ? p.linkedin : null,
      email: typeof p.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) ? p.email : null,
    }));
  let company = null;
  if (raw?.company && typeof raw.company.name === "string" && raw.company.name.trim().length >= 2
      && !INTERNAL_NAME.test(raw.company.name)) {
    company = {
      name: raw.company.name.trim(),
      website: raw.company.website || null,
      type: COMPANY_TYPES.includes(raw.company.type) ? raw.company.type : "Other",
    };
  }
  const stage = STAGE_SIGNALS.includes(raw?.stage) ? raw.stage : null;
  return { category: category.length ? category : ["Outreach"], stage, people, company };
}

async function classifyChat(chatName, messages) {
  const r = await axios.post("https://api.anthropic.com/v1/messages", {
    model: ANTHROPIC_MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: renderMessages(chatName, messages) }],
  }, {
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    timeout: 45_000,
  });
  const text = (r.data?.content || []).map(b => b.text || "").join("");
  return sanitizeClassification(parseJsonLoose(text));
}

// ── 3-4. CRM dedup + create ──────────────────────────────────────────────────
function domainOf(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch (_) { return null; }
}

function titleOf(page, prop) {
  return (page?.properties?.[prop]?.title || []).map(t => t.plain_text || "").join("").trim();
}

async function findCompany({ name, website }) {
  const domain = domainOf(website);
  if (domain) {
    const byDomain = await notionQuery(COMPANIES_DB_ID, { property: "Website", url: { contains: domain } }, 3);
    if (byDomain[0]) return byDomain[0].id;
  }
  const hits = await notionQuery(COMPANIES_DB_ID, { property: "Company name", title: { contains: name.slice(0, 40) } }, 5);
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = hits.find(p => norm(titleOf(p, "Company name")) === norm(name));
  if (exact) return exact.id;
  // Loose "contains" match only when it is unambiguous and the name is not tiny,
  // so "Tempo" does not silently attach to "Tempo Capital Partners".
  if (hits.length === 1 && norm(name).length >= 5) return hits[0].id;
  return null;
}

// ── Person dedup: ANY match on any signal → never create ─────────────────────
// Signals, strongest first: Telegram handle, email (People + Email Activity Log),
// LinkedIn profile, then name. Returns { id } to link an existing person,
// { exists: true } when the person is known (e.g. only in the email log) but has
// no People page to link, or null when nothing matched anywhere.
const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|icloud|me|proton|protonmail|mail|yandex)\./i;

function normHandle(h) {
  return String(h || "").trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//i, "").toLowerCase() || null;
}
function linkedinSlug(url) {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function findPersonByTelegram(handle) {
  const h = normHandle(handle);
  if (!h || h.length < 3) return null;
  const hits = await notionQuery(PEOPLE_DB_ID, { property: "Telegram", rich_text: { contains: h } }, 3);
  return hits[0]?.id || null;
}

async function findPersonByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return null;
  const hits = await notionQuery(PEOPLE_DB_ID, { or: [
    { property: "Email",   email: { equals: e } },
    { property: "Email 2", email: { equals: e } },
    { property: "Email 3", email: { equals: e } },
    { property: "Alternative Emails", rich_text: { contains: e } },
  ] }, 3);
  return hits[0]?.id || null;
}

// Email Activity Log: the person already corresponded with us by email.
async function findInEmailLog(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return null;
  const hits = await notionQuery(EMAILS_DB_ID, { or: [
    { property: "From", rich_text: { contains: e } },
    { property: "To",   rich_text: { contains: e } },
  ] }, 3);
  if (!hits.length) return null;
  for (const h of hits) {
    const pid = (h.properties?.People?.relation || [])[0]?.id;
    if (pid) return { id: pid };
  }
  return { exists: true };
}

async function findPersonByLinkedIn(url) {
  const slug = linkedinSlug(url);
  if (!slug) return null;
  const hits = await notionQuery(PEOPLE_DB_ID, { property: "LinkedIn", url: { contains: slug } }, 3);
  return hits[0]?.id || null;
}

async function findPersonByName(name, companyId) {
  if (!name || name.trim().length < 2) return null;
  const hits = await notionQuery(PEOPLE_DB_ID, { property: "Name", title: { contains: name.slice(0, 40) } }, 5);
  if (!hits.length) return null;
  const fullName = name.trim().split(/\s+/).length >= 2;
  const sameCompany = p => (p.properties?.Company?.relation || []).some(r => r.id === companyId);
  if (fullName) return (hits.find(sameCompany) || hits[0]).id;
  // Single first name ("Isa", "Evgen"): only trust a match at the same company.
  return companyId ? (hits.find(sameCompany)?.id || null) : null;
}

async function findPerson(person, companyId) {
  const byTg = await findPersonByTelegram(person.telegram);
  if (byTg) return { id: byTg, via: "telegram" };
  if (person.email) {
    const byMail = await findPersonByEmail(person.email);
    if (byMail) return { id: byMail, via: "email" };
    const inLog = await findInEmailLog(person.email);
    if (inLog) return { ...inLog, via: "email-log" };
  }
  const byLi = await findPersonByLinkedIn(person.linkedin);
  if (byLi) return { id: byLi, via: "linkedin" };
  const byName = await findPersonByName(person.name, companyId);
  if (byName) return { id: byName, via: "name" };
  return null;
}

// Company fallback via a corporate email domain already seen in the email log.
async function findCompanyByEmailDomain(email) {
  const e = String(email || "").toLowerCase();
  if (!e.includes("@") || FREE_MAIL.test(e)) return null;
  const domain = e.split("@")[1];
  const byWebsite = await notionQuery(COMPANIES_DB_ID, { property: "Website", url: { contains: domain } }, 3);
  if (byWebsite[0]) return byWebsite[0].id;
  const logHits = await notionQuery(EMAILS_DB_ID, { property: "Company Domain", rich_text: { equals: domain } }, 3);
  for (const h of logHits) {
    const cid = (h.properties?.Company?.relation || [])[0]?.id;
    if (cid) return cid;
  }
  return null;
}

const NETWORK_TO_CHANNEL = { WhatsApp: "WhatsApp", Telegram: "Telegram", LinkedIn: "LinkedIn" };

async function createCompany(company, network) {
  const props = {
    "Company name": { title: [{ text: { content: company.name } }] },
    "Type":         { multi_select: [{ name: company.type }] },
    "Notes":        { rich_text: [{ text: { content: AUTO_NOTE() } }] },
    "Source":       { select: { name: "Beeper Auto-Enrich" } },
  };
  const domain = domainOf(company.website);
  if (domain) props["Website"] = { url: `https://${domain}` };
  if (NETWORK_TO_CHANNEL[network]) props["Communication channel"] = { select: { name: NETWORK_TO_CHANNEL[network] } };
  const page = await notionCreatePage(COMPANIES_DB_ID, props);
  return page.id;
}

async function createPerson(person, companyId, chatName, enrichmentStatus) {
  const props = {
    "Name":  { title: [{ text: { content: person.name } }] },
    "Notes": { rich_text: [{ text: { content: `${AUTO_NOTE()} Chat: ${chatName}.` } }] },
  };
  if (companyId)       props["Company"]  = { relation: [{ id: companyId }] };
  if (person.role)     props["Role"]     = { rich_text: [{ text: { content: person.role } }] };
  if (person.telegram) props["Telegram"] = { rich_text: [{ text: { content: person.telegram } }] };
  if (person.linkedin) props["LinkedIn"] = { url: person.linkedin };
  if (person.email)    props["Email"]    = { email: person.email };
  // Apollo already tried once → never retried by the top-up pass.
  if (enrichmentStatus) props["Enrichment Status"] = { select: { name: enrichmentStatus } };
  const page = await notionCreatePage(PEOPLE_DB_ID, props);
  return page.id;
}

// LinkedIn chats via Beeper: the sender's Matrix id carries the LinkedIn member
// URN (e.g. @linkedin__a_co_a_a_b...:beeper.local). Decoding it gives a working
// profile URL for free — no Apollo needed. Escaping: "_x" = "X", "__" = "_".
function linkedinUrlFromSenderId(senderID) {
  const m = /^@linkedin_([^:]+):/.exec(String(senderID || ""));
  if (!m) return null;
  const esc = m[1];
  let out = "";
  for (let i = 0; i < esc.length; i++) {
    const c = esc[i];
    if (c === "_" && i + 1 < esc.length) {
      const n = esc[++i];
      out += n === "_" ? "_" : n.toUpperCase();
    } else out += c;
  }
  return /^ACo[A-Za-z0-9_-]{20,}$/.test(out) ? `https://www.linkedin.com/in/${out}` : null;
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-zÀ-ɏЀ-ӿ ]/g, "").replace(/\s+/g, " ").trim();
}

// Fill person.linkedin from the LinkedIn chat's sender id when the classifier left it empty.
function attachLinkedInFromMessages(people, messages, network) {
  if (network !== "LinkedIn") return people;
  const senders = new Map();
  for (const m of messages || []) {
    if (m.isSender || !m.senderName) continue;
    const url = linkedinUrlFromSenderId(m.senderID);
    if (url) senders.set(normName(m.senderName), url);
  }
  const only = senders.size === 1 ? [...senders.values()][0] : null;
  return people.map(p => {
    if (p.linkedin) return p;
    const url = senders.get(normName(p.name)) || (people.length === 1 ? only : null);
    return url ? { ...p, linkedin: url } : p;
  });
}

async function notionGetPage(pageId) {
  const r = await axios.get(`https://api.notion.com/v1/pages/${pageId}`, { headers: notionHeaders(), timeout: 15_000 });
  return r.data;
}

// Existing person linked to a chat but missing Email / LinkedIn / Role:
// one Apollo try, fill ONLY empty fields, then mark "Enrichment Status" so the
// person is never sent to Apollo again. Never touches phone numbers.
async function topUpExistingPerson(personId, person, company) {
  const page = await notionGetPage(personId);
  const pr = page.properties || {};
  if (pr["Enrichment Status"]?.select?.name) return { skipped: "already-tried" };
  const has = {
    email:    !!(pr.Email?.email || pr["Email 2"]?.email || pr["Email 3"]?.email),
    linkedin: !!pr.LinkedIn?.url,
    role:     !!(pr.Role?.rich_text || []).map(t => t.plain_text).join("").trim(),
  };
  const props = {};
  if (!has.linkedin && person.linkedin) { props.LinkedIn = { url: person.linkedin }; has.linkedin = true; }
  let apollo = null;
  if (!has.email || !has.linkedin || !has.role) {
    const name = titleOf(page, "Name") || person.name;
    const linkedin = pr.LinkedIn?.url || person.linkedin || null;
    try { apollo = await apolloLookup({ name, linkedin }, company); } catch (_) { apollo = null; }
    if (apollo?.email && !has.email)       props.Email    = { email: apollo.email };
    if (apollo?.linkedin && !has.linkedin) props.LinkedIn = { url: apollo.linkedin };
    if (apollo?.title && !has.role)        props.Role     = { rich_text: [{ text: { content: apollo.title } }] };
  }
  props["Enrichment Status"] = { select: { name: apollo ? "Done" : "Skipped" } };
  await notionUpdatePage(personId, props);
  return { filled: Object.keys(props).filter(k => k !== "Enrichment Status"), apollo: !!apollo };
}

// ── 5. Apollo (email / LinkedIn / title — never phone) ──────────────────────
// Lookup only. Runs BEFORE a person is created so its email / LinkedIn can be
// used for one more dedup pass (catches "Nico" vs "Nicolas Mauer").
const isUrnProfile = url => /linkedin\.com\/in\/aco/i.test(String(url || ""));

async function apolloLookup(person, company) {
  if (!APOLLO_KEY) return null;
  // Apollo can't resolve URN-style profile links (linkedin.com/in/ACoAA...) — don't send them.
  if (isUrnProfile(person.linkedin)) person = { ...person, linkedin: null };
  const parts = person.name.split(/\s+/);
  if (parts.length < 2 && !person.linkedin) return null;   // single first name: too ambiguous
  if (!company && !person.linkedin) return null;            // name alone: too ambiguous
  const payload = {
    first_name: parts[0],
    last_name: parts.slice(1).join(" ") || undefined,
    organization_name: company?.name,
    domain: domainOf(company?.website) || undefined,
    linkedin_url: person.linkedin || undefined,
    // phone numbers intentionally never requested
  };
  const r = await axios.post("https://api.apollo.io/api/v1/people/match", payload, {
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    timeout: 15_000,
  });
  const p = r.data?.person;
  if (!p) return null;
  const out = {
    email:    p.email && !/not_unlocked|email_not/i.test(p.email) ? p.email : null,
    linkedin: p.linkedin_url && !isUrnProfile(p.linkedin_url) ? p.linkedin_url : null,
    title:    p.title ? String(p.title).slice(0, 200) : null,
  };
  return (out.email || out.linkedin || out.title) ? out : null;
}

// ── 6. BD scoring (background) ──────────────────────────────────────────────
// Companies DB "Priority" from the scoring tier. "Manual Review" stays empty
// for a human to decide; "Skip" (< 3) goes to the lowest bucket.
function priorityForTier(tier) {
  return ({ "P1": "1", "P2": "2", "P3": "3", "Skip": "3", "Hard Kill": "HK" })[tier] || null;
}

// Scoring math (Framework v2.2 formulas + Floor Rules) lives in
// routes/parallel.js; reuse it through this same server's compact endpoint.
const SELF_URL = `http://127.0.0.1:${process.env.PORT || 3000}`;

// Same v2.2 spec + one optional field, so every auto-scored company also gets a
// plain "what they do" line for the Company description column.
const HUB_SCORING_SPEC = {
  output_schema: {
    ...parallelTaskSpec.output_schema,
    json_schema: {
      ...parallelTaskSpec.output_schema.json_schema,
      properties: {
        ...parallelTaskSpec.output_schema.json_schema.properties,
        company_description: {
          type: "string",
          description: "1-2 factual sentences: what the company does, for whom, where it operates. No marketing language.",
        },
      },
    },
  },
};

// Runs the v2.2 scoring on Parallel Core, writes BD Score / Priority / Insight /
// Company description to the company page and returns what it wrote.
// Throws on failure. Used by the Hub enrichment (background) and by the
// Telegram CRM lookup (which reports the result back to the chat).
async function scoreCompany(companyId, company) {
  if (!PARALLEL_KEY) throw new Error("PARALLEL_KEY not set");
  const start = await axios.post("https://api.parallel.ai/v1/tasks/runs", {
    input: buildResearchQuery(company.name, domainOf(company.website)),
    processor: "core",
    task_spec: HUB_SCORING_SPEC,
  }, { headers: parallelHeaders(), timeout: 15_000 });
  const taskId = start.data?.run_id || start.data?.id;
  if (!taskId) throw new Error("Parallel: no task id");

  const deadline = Date.now() + 8 * 60_000;
  let compact = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000));
    const r = await axios.get(`${SELF_URL}/parallel/result/${taskId}/compact`, { timeout: 30_000 });
    if (r.data?.failed) throw new Error(`Parallel task ${r.data.status}`);
    if (r.data?.done) { compact = r.data.compact; break; }
  }
  if (!compact) throw new Error("Parallel scoring timed out or returned no content");

  let description = null;
  try {
    const raw = await axios.get(`https://api.parallel.ai/v1/tasks/runs/${taskId}/result`, { headers: parallelHeaders(), timeout: 15_000 });
    const c = raw.data?.output?.content || raw.data?.content || {};
    if (typeof c.company_description === "string" && c.company_description.trim()) description = c.company_description.trim();
  } catch (_) {}

  const hk = compact.hk && compact.hk !== true ? ` ${compact.hk}` : "";
  const note = `${AUTO_NOTE()} BD Score ${compact.score} (${compact.tier}${hk}), ${compact.formula_used}. Parallel task ${taskId}.`;
  const props = {
    "BD Score": { number: compact.score },
    "Insight":  { rich_text: [{ text: { content: note.slice(0, 1900) } }] },
  };
  if (description) props["Company description"] = { rich_text: [{ text: { content: description.slice(0, 1900) } }] };
  const priority = priorityForTier(compact.tier);
  if (priority) props["Priority"] = { multi_select: [{ name: priority }] };
  await notionUpdatePage(companyId, props);
  console.log(`[hub-enrich] scored ${company.name}: ${compact.score} ${compact.tier}`);
  return { score: compact.score, tier: compact.tier, hk: compact.hk || null, priority, description, insight: note, taskId };
}

async function scoreCompanyInBackground(companyId, company) {
  if (!PARALLEL_KEY) return;
  try { await scoreCompany(companyId, company); }
  catch (e) { console.error(`[hub-enrich] scoring failed for ${company.name}: ${errDetail(e)}`); }
}

// ── Stage progression (only up, never down) ─────────────────────────────────
// Legacy Stage options that may still sit on older company pages.
const LEGACY_STAGE_RANK = {
  "Backlog": 0, "Not Started": 0,
  "Connection/cold email sent": 1,
  "intro": 2, "Communication Started": 2, "initial discussions": 2,
  "Call Scheduled": 4,
  "Negotiations": 7,
};
function stageRank(stage) {
  const i = STAGE_LADDER.indexOf(stage);
  if (i >= 0) return i;
  return Object.prototype.hasOwnProperty.call(LEGACY_STAGE_RANK, stage) ? LEGACY_STAGE_RANK[stage] : -1;
}

// Map the model's signal to a concrete Companies DB option.
// Every company starts at Opened Conversation (also when we wrote first and
// they have not replied yet). "Discovery Process" splits by BD Score tier:
// P1 >= 7.5, otherwise P2.
function resolveStage(signal, bdScore) {
  const s = (!signal || signal === "Outreach Started") ? DEFAULT_STAGE : signal;
  if (s === "Discovery Process") return (typeof bdScore === "number" && bdScore >= 7.5) ? "Discovery Process P1" : "Discovery Process P2";
  return s;
}

// Pure decision: returns the stage to write, or null to leave it as is.
function nextStage(current, signal, bdScore) {
  if (current && TERMINAL_STAGES.has(current)) return null;
  const proposed = resolveStage(signal, bdScore);
  if (stageRank(proposed) < 0) return null;
  if (!current) return proposed;                                     // empty → set
  if (stageRank(current) < 0) return null;                           // unrecognised option → leave alone
  return stageRank(proposed) > stageRank(current) ? proposed : null; // only raise
}

async function advanceCompanyStage(companyId, signal) {
  const r = await axios.get(`https://api.notion.com/v1/pages/${companyId}`, { headers: require("./notion").notionHeaders(), timeout: 10_000 });
  const current = r.data?.properties?.Stage?.status?.name || null;
  const bdScore = r.data?.properties?.["BD Score"]?.number ?? null;
  const target = nextStage(current, signal, bdScore);
  if (!target) return { from: current, to: null };
  await notionUpdatePage(companyId, { "Stage": { status: { name: target } } });
  console.log(`[hub-enrich] stage ${current || "∅"} → ${target} (company ${companyId})`);
  return { from: current, to: target };
}

// The stage pass trusts the Category already on the Hub row (set by hand or by
// enrichment). Staff / Personal / Spam chats never move a company's Stage,
// even if a fresh classification would say otherwise.
function shouldRunStagePass(hubCategories = []) {
  return !hubCategories.some(c => NO_SPEND_CATEGORIES.has(c));
}

// Hourly pass for chats that were already enriched: re-read context and only
// raise the linked companies' Stage. No CRM creation, no Apollo, no scoring.
async function progressHubChatStage({ chatName, companyIds, messages }) {
  if (!isEnabled() || !companyIds?.length) return null;
  try {
    const cls = await classifyChat(chatName, messages);
    if (cls.category.some(c => NO_SPEND_CATEGORIES.has(c))) return null;
    const out = [];
    for (const id of companyIds.slice(0, 2)) out.push(await advanceCompanyStage(id, cls.stage));
    return out;
  } catch (e) {
    console.error(`[hub-enrich] stage pass failed for ${chatName}: ${errDetail(e)}`);
    return null;
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
async function enrichHubChat({ hubPageId, chatName, network, messages }) {
  if (!isEnabled()) return { skipped: "disabled" };
  const log = { chatName, category: null, companyId: null, companyNew: false, people: [], apollo: [], scoring: false };
  try {
    const cls = await classifyChat(chatName, messages);
    log.category = cls.category;

    const hubProps = {
      "Category": { multi_select: cls.category.map(name => ({ name })) },
    };

    if (cls.category.some(c => NO_SPEND_CATEGORIES.has(c))) {
      hubProps["Enrichment Status"] = { select: { name: "Skipped" } };
      await notionUpdatePage(hubPageId, hubProps);
      console.log(`[hub-enrich] ${chatName}: ${cls.category.join(",")} — no spend`);
      return log;
    }

    let companyId = null;
    if (cls.company) {
      companyId = await findCompany(cls.company);
      if (!companyId) {
        for (const p of cls.people) {
          companyId = await findCompanyByEmailDomain(p.email);
          if (companyId) break;
        }
      }
      if (!companyId) {
        companyId = await createCompany(cls.company, network);
        log.companyNew = true;
      }
    }
    log.companyId = companyId;

    const people = attachLinkedInFromMessages(cls.people, messages, network);
    const personIds = [];
    for (const person of people) {
      // 1) Any match on Telegram / email / email log / LinkedIn / name → never create.
      let hit = await findPerson(person, companyId);
      // 2) Not found: ask Apollo, then dedup again on Apollo's email / LinkedIn.
      let apollo = null;
      if (!hit) {
        try { apollo = await apolloLookup(person, cls.company); }
        catch (e) { log.apollo.push({ name: person.name, error: errDetail(e) }); }
        if (apollo) {
          log.apollo.push({ name: person.name, matched: true });
          hit = await findPerson({ ...person, email: apollo.email, linkedin: apollo.linkedin, telegram: null, name: "" }, companyId)
             .catch(() => null);
        }
      }
      if (hit) {
        if (hit.id) {
          personIds.push(hit.id);
          try { log.topUp = (log.topUp || []).concat({ name: person.name, ...(await topUpExistingPerson(hit.id, person, cls.company)) }); }
          catch (e) { log.topUp = (log.topUp || []).concat({ name: person.name, error: errDetail(e) }); }
        }
        log.people.push(`${person.name} (existing via ${hit.via})`);
        continue;
      }
      // 3) Genuinely new: create once, with whatever Apollo found.
      const toCreate = {
        ...person,
        email:    person.email    || apollo?.email    || null,
        linkedin: person.linkedin || apollo?.linkedin || null,
        role:     person.role     || apollo?.title    || null,
      };
      personIds.push(await createPerson(toCreate, companyId, chatName, apollo ? "Done" : "Skipped"));
      log.people.push(`${person.name} (new)`);
    }

    if (personIds.length) hubProps["Link: People"]    = { relation: personIds.map(id => ({ id })) };
    if (companyId)        hubProps["Link: Companies"] = { relation: [{ id: companyId }] };
    hubProps["Enrichment Status"] = { select: { name: "Done" } };
    await notionUpdatePage(hubPageId, hubProps);

    if (companyId) {
      try { log.stage = await advanceCompanyStage(companyId, cls.stage); }
      catch (e) { log.stage = { error: e.message }; }
    }

    // Only brand-new companies get scored — never re-score what is already in Notion.
    if (log.companyNew && cls.category.some(c => SCORE_CATEGORIES.has(c))) {
      log.scoring = true;
      scoreCompanyInBackground(companyId, cls.company); // fire-and-forget
    }
    console.log(`[hub-enrich] ${chatName}: ${JSON.stringify(log)}`);
    return log;
  } catch (e) {
    console.error(`[hub-enrich] ${chatName} failed: ${errDetail(e)}`);
    try { await notionUpdatePage(hubPageId, { "Enrichment Status": { select: { name: "Failed" } } }); } catch (_) {}
    return { ...log, error: e.message };
  }
}

module.exports = {
  enrichHubChat,
  progressHubChatStage,
  shouldRunStagePass,
  isEnabled,
  nextStage,
  STAGE_LADDER,
  // exported for tests
  priorityForTier,
  normHandle,
  linkedinSlug,
  linkedinUrlFromSenderId,
  attachLinkedInFromMessages,
  sanitizeClassification,
  // shared with lib/crm-lookup.js (Telegram bot CRM lookup)
  findCompany,
  findPerson,
  createCompany,
  createPerson,
  notionGetPage,
  scoreCompany,
  titleOf,
  isUrnProfile,
  errDetail,
  parseJsonLoose,
  domainOf,
  renderMessages,
};
