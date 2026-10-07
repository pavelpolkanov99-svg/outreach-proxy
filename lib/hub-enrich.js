// ─────────────────────────────────────────────────────────────────────────────
// Messaging Hub auto-enrichment (v3.30.0)
//
// Runs once for every NEW chat the Beeper → Notion sync creates in the
// Messaging Hub. Fully automatic (no approval step):
//
//   1. Classify the chat with Claude Haiku from its recent messages:
//      Category + external people + their company.
//   2. Spam / Noise, Personal, Staff  → set Category only, no spend, stop.
//   3. CRM dedup FIRST: look up company (by name and website domain) and each
//      person in Notion. Existing records are linked, never re-created.
//   4. Create only what is missing (Companies + People).
//   5. Apollo people/match for NEW people only → email, LinkedIn, title.
//      Never phone numbers (no reveal_phone_number, no waterfall).
//   6. BD scoring (Parallel Core, Framework v2.2) only for companies that were
//      just created AND the chat is Partnership / Client. Companies already in
//      Notion are never re-scored. Runs in the background (Core takes 1-5 min).
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
} = require("./notion");
const { PARALLEL_KEY, parallelHeaders, buildResearchQuery, parallelTaskSpec } = require("./parallel");

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

async function findPerson({ name }, companyId) {
  const hits = await notionQuery(PEOPLE_DB_ID, { property: "Name", title: { contains: name.slice(0, 40) } }, 5);
  if (!hits.length) return null;
  const fullName = name.trim().split(/\s+/).length >= 2;
  const sameCompany = p => (p.properties?.Company?.relation || []).some(r => r.id === companyId);
  if (fullName) return (hits.find(sameCompany) || hits[0]).id;
  // Single first name ("Isa", "Evgen"): only trust a match at the same company.
  return companyId ? (hits.find(sameCompany)?.id || null) : null;
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

async function createPerson(person, companyId, chatName) {
  const props = {
    "Name":  { title: [{ text: { content: person.name } }] },
    "Notes": { rich_text: [{ text: { content: `${AUTO_NOTE()} Chat: ${chatName}.` } }] },
  };
  if (companyId)       props["Company"]  = { relation: [{ id: companyId }] };
  if (person.role)     props["Role"]     = { rich_text: [{ text: { content: person.role } }] };
  if (person.telegram) props["Telegram"] = { rich_text: [{ text: { content: person.telegram } }] };
  if (person.linkedin) props["LinkedIn"] = { url: person.linkedin };
  if (person.email)    props["Email"]    = { email: person.email };
  const page = await notionCreatePage(PEOPLE_DB_ID, props);
  return page.id;
}

// ── 5. Apollo (email / LinkedIn / title — never phone) ──────────────────────
async function apolloEnrichPerson(personId, person, company) {
  if (!APOLLO_KEY) return { skipped: "APOLLO_KEY not set" };
  const parts = person.name.split(/\s+/);
  if (parts.length < 2 && !person.linkedin) return { skipped: "single name" };
  if (!company && !person.linkedin) return { skipped: "no company or linkedin" };
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
  if (!p) return { matched: false };
  const props = {};
  if (p.email && !person.email)              props["Email"]    = { email: p.email };
  if (p.linkedin_url && !person.linkedin)    props["LinkedIn"] = { url: p.linkedin_url };
  if (p.title && !person.role)               props["Role"]     = { rich_text: [{ text: { content: String(p.title).slice(0, 200) } }] };
  if (Object.keys(props).length) await notionUpdatePage(personId, props);
  return { matched: true, fields: Object.keys(props) };
}

// ── 6. BD scoring (background) ──────────────────────────────────────────────
// Scoring math (Framework v2.2 formulas + Floor Rules) lives in
// routes/parallel.js; reuse it through this same server's compact endpoint.
const SELF_URL = `http://127.0.0.1:${process.env.PORT || 3000}`;

async function scoreCompanyInBackground(companyId, company) {
  if (!PARALLEL_KEY) return;
  try {
    const start = await axios.post("https://api.parallel.ai/v1/tasks/runs", {
      input: buildResearchQuery(company.name, domainOf(company.website)),
      processor: "core",
      task_spec: parallelTaskSpec,
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

    const note = `${AUTO_NOTE()} BD Score ${compact.score} (${compact.tier}), ${compact.formula_used}. Parallel task ${taskId}.`;
    await notionUpdatePage(companyId, {
      "BD Score": { number: compact.score },
      "Insight":  { rich_text: [{ text: { content: note.slice(0, 1900) } }] },
    });
    console.log(`[hub-enrich] scored ${company.name}: ${compact.score} ${compact.tier}`);
  } catch (e) {
    console.error(`[hub-enrich] scoring failed for ${company.name}: ${errDetail(e)}`);
  }
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
        companyId = await createCompany(cls.company, network);
        log.companyNew = true;
      }
    }
    log.companyId = companyId;

    const personIds = [];
    for (const person of cls.people) {
      let id = await findPerson(person, companyId);
      if (!id) {
        id = await createPerson(person, companyId, chatName);
        try {
          log.apollo.push({ name: person.name, ...(await apolloEnrichPerson(id, person, cls.company)) });
        } catch (e) {
          log.apollo.push({ name: person.name, error: e.response?.data?.error || e.message });
        }
      }
      personIds.push(id);
      log.people.push(person.name);
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
  sanitizeClassification,
  parseJsonLoose,
  domainOf,
  renderMessages,
};
