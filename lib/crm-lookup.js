// ─────────────────────────────────────────────────────────────────────────────
// CRM lookup for the Telegram bot (v3.32.0)
//
// Anton tags the bot in the sales chat with a person or a company:
//   "@bot Иван Петров из Bitso"            → person card
//   "@bot Иван Петров Bitso телефон"       → person card + phone
//   "@bot скоринг Bitso"                    → company score
//
// Credit discipline — Notion first, always:
//   Person : CRM hit with Email + LinkedIn + Role → answer from Notion, 0 credits.
//            Missing fields → ONE Apollo people/match, fill only the empty
//            fields, write back. Not in CRM → Apollo (needs a company: a bare
//            name is too ambiguous to spend on) → dedup again → create in CRM.
//            Phone only when asked AND Notion has none: Apollo reveals it
//            asynchronously to our webhook, which writes it to Notion.
//   Company: CRM hit with a BD Score → answer from Notion, 0 credits.
//            Otherwise one Apollo org lookup (website, if unknown) + v2.2
//            scoring on Parallel Core (1-5 min) → written to Notion.
// Long-running parts (scoring, phone) run as jobs the bot polls.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const crypto = require("crypto");
const { PEOPLE_DB_ID, notionUpdatePage } = require("./notion");
const enrich = require("./hub-enrich");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const APOLLO_KEY    = process.env.APOLLO_KEY || null;
const PUBLIC_URL    = (process.env.PUBLIC_URL || process.env.PROXY_URL
  || "https://outreach-proxy-production-eb03.up.railway.app").replace(/\/$/, "");

// ── Jobs (in memory; the bot polls them) ─────────────────────────────────────
const jobs = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

function newJob(kind, meta = {}) {
  for (const [id, j] of jobs) if (Date.now() - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, kind, status: "running", createdAt: Date.now(), secret: crypto.randomBytes(12).toString("hex"), ...meta };
  jobs.set(id, job);
  return job;
}
function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { secret, ...pub } = j;
  return pub;
}

// ── Request parsing (Haiku, ~0.1¢) ───────────────────────────────────────────
const PARSE_PROMPT = `You route a message sent to Plexo's CRM bot in a sales team chat (Russian or English).
Return ONLY JSON: {"intent":"person|company|other","name":null,"company":null,"want_phone":false}
- person: they ask about a specific human (contacts, who is X, email, LinkedIn, phone). name = the person's full name as written (Latin or Cyrillic), company = their company if mentioned.
- company: they ask for scoring / BD score / "what about company X" / "насколько подходит". company = the company name.
- other: anything else (tasks, questions, chit-chat).
- want_phone: true only if they explicitly ask for a phone / номер / телефон / WhatsApp number.
Never invent names or companies.`;

function parseLoose(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

// Cheap deterministic path for the obvious forms, so most requests need no LLM.
function parseRequestFast(text, hint) {
  const t = String(text || "").trim();
  const wantPhone = /(телефон|номер|phone|whatsapp|ватсап)/i.test(t);
  const scoreM = /^(?:скоринг|скорь|оцени|score|scoring)\s*[:\-]?\s*(.+)$/i.exec(t);
  if (hint === "company" || scoreM) {
    const company = (scoreM ? scoreM[1] : t).replace(/[?.!]+$/, "").trim();
    return company ? { intent: "company", name: null, company, want_phone: false } : null;
  }
  if (hint === "person") {
    const cleaned = t.replace(/(телефон|номер|phone|whatsapp|ватсап)/ig, " ").replace(/\s{2,}/g, " ").trim();
    const m = /^(.+?)\s*(?:,|\/|\||\s(?:из|at|from|@)\s)\s*(.+)$/i.exec(cleaned);
    if (m) return { intent: "person", name: m[1].trim(), company: m[2].trim(), want_phone: wantPhone };
    if (cleaned) return { intent: "person", name: cleaned, company: null, want_phone: wantPhone };
  }
  return null;
}

async function parseRequest(text, hint) {
  const fast = parseRequestFast(text, hint);
  if (fast) return fast;
  if (!ANTHROPIC_KEY) return { intent: "other" };
  const r = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: PARSE_PROMPT,
    messages: [{ role: "user", content: String(text).slice(0, 1000) }],
  }, {
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    timeout: 20_000,
  });
  const out = parseLoose((r.data?.content || []).map(b => b.text || "").join("")) || {};
  const intent = ["person", "company"].includes(out.intent) ? out.intent : "other";
  return {
    intent,
    name: typeof out.name === "string" && out.name.trim() ? out.name.trim() : null,
    company: typeof out.company === "string" && out.company.trim() ? out.company.trim() : null,
    want_phone: !!out.want_phone,
  };
}

// ── Notion readers ───────────────────────────────────────────────────────────
const txt   = p => (p?.rich_text || []).map(t => t.plain_text || "").join("").trim();
const title = p => (p?.title || []).map(t => t.plain_text || "").join("").trim();

function personView(page) {
  const pr = page.properties || {};
  return {
    pageId:   page.id,
    url:      page.url,
    name:     title(pr.Name),
    role:     txt(pr.Role) || null,
    email:    pr.Email?.email || pr["Email 2"]?.email || pr["Email 3"]?.email || null,
    linkedin: pr.LinkedIn?.url || null,
    phone:    pr.Phone?.phone_number || null,
    telegram: txt(pr.Telegram) || null,
    companyId: (pr.Company?.relation || [])[0]?.id || null,
    enrichmentStatus: pr["Enrichment Status"]?.select?.name || null,
  };
}

function companyView(page) {
  const pr = page.properties || {};
  return {
    pageId:      page.id,
    url:         page.url,
    name:        title(pr["Company name"]),
    website:     pr.Website?.url || null,
    bdScore:     typeof pr["BD Score"]?.number === "number" ? pr["BD Score"].number : null,
    priority:    (pr.Priority?.multi_select || []).map(o => o.name).join(", ") || null,
    stage:       pr.Stage?.status?.name || null,
    description: txt(pr["Company description"]) || null,
    insight:     txt(pr.Insight) || null,
  };
}

// ── Apollo ───────────────────────────────────────────────────────────────────
// One people/match call. revealPhone asks Apollo to deliver the phone number
// to our webhook (it never arrives in this response).
async function apolloMatch({ name, company, linkedin, revealPhone, webhookUrl }) {
  if (!APOLLO_KEY) throw new Error("APOLLO_KEY not set");
  const parts = String(name || "").trim().split(/\s+/);
  const payload = {
    first_name: parts[0] || undefined,
    last_name: parts.slice(1).join(" ") || undefined,
    organization_name: company?.name || undefined,
    domain: company?.website ? String(company.website).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : undefined,
    linkedin_url: linkedin && !enrich.isUrnProfile(linkedin) ? linkedin : undefined,
  };
  if (revealPhone && webhookUrl) { payload.reveal_phone_number = true; payload.webhook_url = webhookUrl; }
  const r = await axios.post("https://api.apollo.io/api/v1/people/match", payload, {
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    timeout: 20_000,
  });
  const p = r.data?.person;
  if (!p) return null;
  const org = p.organization || {};
  return {
    apolloId: p.id,
    email:    p.email && !/not_unlocked|email_not/i.test(p.email) ? p.email : null,
    linkedin: p.linkedin_url && !enrich.isUrnProfile(p.linkedin_url) ? p.linkedin_url : null,
    title:    p.title ? String(p.title).slice(0, 200) : null,
    orgName:  p.organization_name || org.name || null,
    orgWebsite: org.website_url || null,
  };
}

async function apolloOrgByName(name) {
  if (!APOLLO_KEY) return null;
  const r = await axios.post("https://api.apollo.io/api/v1/organizations/search",
    { q_organization_name: name, page: 1, per_page: 1 },
    { headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY }, timeout: 15_000 });
  const o = r.data?.organizations?.[0];
  if (!o) return null;
  return { name: o.name, website: o.website_url || (o.primary_domain ? `https://${o.primary_domain}` : null) };
}

// Pull phone numbers out of Apollo's webhook body, whatever its exact shape.
function extractPhones(body) {
  const out = [];
  const walk = v => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (Array.isArray(v.phone_numbers)) {
      for (const n of v.phone_numbers) {
        const num = n?.sanitized_number || n?.raw_number || n?.number;
        if (num) out.push({ number: String(num), type: n.type_cd || n.type || null, status: n.status_cd || n.status || null });
      }
    }
    for (const k of Object.keys(v)) if (k !== "phone_numbers") walk(v[k]);
  };
  walk(body);
  const rank = p => (/mobile/i.test(p.type || "") ? 0 : 1) + (/invalid/i.test(p.status || "") ? 10 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ── Person lookup ────────────────────────────────────────────────────────────
async function lookupPerson({ name, company, wantPhone }) {
  const spent = [];
  if (!name) return { ok: false, message: "Не понял, кого искать. Напиши имя и фамилию, можно с компанией." };

  // Company context: CRM page if we have it, else just the name from the request.
  let companyId = company ? await enrich.findCompany({ name: company }) : null;
  let companyInfo = company ? { name: company, website: null } : null;
  if (companyId) {
    const cv = companyView(await enrich.notionGetPage(companyId));
    companyInfo = { name: cv.name || company, website: cv.website };
  }

  const hit = await enrich.findPerson({ name, telegram: null, email: null, linkedin: null }, companyId);
  let person = hit?.id ? personView(await enrich.notionGetPage(hit.id)) : null;
  let source = person ? "crm" : null;

  if (person && !companyInfo && person.companyId) {
    const cv = companyView(await enrich.notionGetPage(person.companyId));
    companyInfo = { name: cv.name, website: cv.website };
    companyId = person.companyId;
  }

  const needPhone = !!wantPhone && !person?.phone;
  const missing = person ? ["email", "linkedin", "role"].filter(k => !person[k]) : [];
  // Apollo already tried and found nothing → only retry when the request adds a company.
  const apolloAllowed = !person || person.enrichmentStatus !== "Skipped" || !!company;

  let phoneJob = null;
  // An existing CRM person is only sent to Apollo when Apollo can identify them
  // (company or a real LinkedIn URL) — never by bare name, to avoid writing
  // someone else's email into the card.
  const identifiable = !!companyInfo || !!(person?.linkedin && !enrich.isUrnProfile(person.linkedin));
  if (person && !identifiable && (missing.length || needPhone)) {
    return { ok: true, kind: "person", found: true, source: "crm", spent, person, company: null,
      note: `Чтобы дозаполнить${needPhone ? " и достать телефон" : ""} через Apollo, напиши компанию: <i>${esc(name)} из …</i>` };
  }
  const callApollo = (person && (missing.length && apolloAllowed)) || !person || needPhone;

  if (callApollo) {
    if (!person && !companyInfo) {
      return { ok: true, kind: "person", found: false,
        message: `В CRM нет «${name}». Напиши компанию (например: <i>${name} из Bitso</i>) — по одному имени в Apollo не ищу, чтобы не жечь кредиты.` };
    }
    if (needPhone) {
      phoneJob = newJob("phone", { name, personPageId: person?.pageId || null });
    }
    let ap = null;
    try {
      ap = await apolloMatch({
        name: person?.name || name,
        company: companyInfo,
        linkedin: person?.linkedin || null,
        revealPhone: needPhone,
        webhookUrl: phoneJob ? `${PUBLIC_URL}/lookup/apollo-phone/${phoneJob.id}?k=${jobs.get(phoneJob.id).secret}` : null,
      });
      spent.push(needPhone ? "Apollo match + phone" : "Apollo match");
    } catch (e) {
      if (phoneJob) { const j = jobs.get(phoneJob.id); j.status = "failed"; j.error = enrich.errDetail(e); }
      return { ok: false, message: `Apollo ответил ошибкой: ${enrich.errDetail(e).slice(0, 200)}` };
    }

    if (!person) {
      if (!ap) {
        if (phoneJob) { const j = jobs.get(phoneJob.id); j.status = "done"; j.phone = null; }
        return { ok: true, kind: "person", found: false, spent,
          message: `Не нашёл «${name}» ни в CRM, ни в Apollo${companyInfo ? ` (компания: ${companyInfo.name})` : ""}.` };
      }
      // Apollo found them — dedup once more on email / LinkedIn before creating.
      const again = await enrich.findPerson({ name: "", telegram: null, email: ap.email, linkedin: ap.linkedin }, companyId).catch(() => null);
      if (again?.id) {
        person = personView(await enrich.notionGetPage(again.id));
        source = "crm";
      } else {
        if (!companyId && companyInfo) {
          companyId = await enrich.findCompany({ name: ap.orgName || companyInfo.name, website: ap.orgWebsite || companyInfo.website });
          if (!companyId) {
            companyId = await enrich.createCompany(
              { name: ap.orgName || companyInfo.name, website: ap.orgWebsite || companyInfo.website, type: "Other" }, null);
          }
        }
        const newId = await enrich.createPerson(
          { name, role: ap.title, linkedin: ap.linkedin, email: ap.email, telegram: null },
          companyId, "Telegram CRM lookup", "Done");
        person = personView(await enrich.notionGetPage(newId));
        source = "apollo-new";
      }
      if (phoneJob) jobs.get(phoneJob.id).personPageId = person.pageId;
    }

    if (source === "crm" && ap) {
      const props = {};
      if (!person.email && ap.email)       props.Email    = { email: ap.email };
      if (!person.linkedin && ap.linkedin) props.LinkedIn = { url: ap.linkedin };
      if (!person.role && ap.title)        props.Role     = { rich_text: [{ text: { content: ap.title } }] };
      if (missing.length) props["Enrichment Status"] = { select: { name: "Done" } };
      if (Object.keys(props).length) {
        await notionUpdatePage(person.pageId, props);
        person = personView(await enrich.notionGetPage(person.pageId));
        source = "crm+apollo";
      }
    } else if (source === "crm" && !ap && missing.length && apolloAllowed) {
      await notionUpdatePage(person.pageId, { "Enrichment Status": { select: { name: "Skipped" } } });
    }
    if (phoneJob && !ap) { const j = jobs.get(phoneJob.id); j.status = "done"; j.phone = null; }
  }

  return {
    ok: true, kind: "person", found: true, source, spent,
    person, company: companyInfo,
    phoneJobId: phoneJob && jobs.get(phoneJob.id)?.status === "running" ? phoneJob.id : null,
  };
}

// Apollo phone webhook → Notion Phone + job result.
async function handlePhoneWebhook(jobId, key, body) {
  const job = jobs.get(jobId);
  if (!job || job.secret !== key) return { ok: false, status: 404 };
  const phones = extractPhones(body);
  job.phone = phones[0]?.number || null;
  job.phones = phones.slice(0, 3);
  if (job.phone && job.personPageId) {
    try {
      const pv = personView(await enrich.notionGetPage(job.personPageId));
      if (!pv.phone) await notionUpdatePage(job.personPageId, { Phone: { phone_number: job.phone } });
    } catch (e) { job.writeError = enrich.errDetail(e); }
  }
  job.status = "done";
  return { ok: true };
}

// ── Company lookup / scoring ─────────────────────────────────────────────────
async function lookupCompany({ company }) {
  if (!company) return { ok: false, message: "Не понял, какую компанию скорить." };
  const spent = [];
  let companyId = await enrich.findCompany({ name: company });
  let cv = companyId ? companyView(await enrich.notionGetPage(companyId)) : null;

  if (cv && cv.bdScore !== null) {
    return { ok: true, kind: "company", found: true, source: "crm", spent, company: cv };
  }

  // Not scored yet → website via Apollo only if CRM doesn't have it.
  let website = cv?.website || null;
  let canonical = cv?.name || company;
  if (!website) {
    try {
      const org = await apolloOrgByName(company);
      spent.push("Apollo org search");
      if (org?.website) { website = org.website; canonical = cv ? canonical : (org.name || company); }
    } catch (_) { /* scoring still works on the name alone */ }
  }

  if (!companyId) {
    companyId = await enrich.findCompany({ name: canonical, website });
  }
  let created = false;
  if (!companyId) {
    companyId = await enrich.createCompany({ name: canonical, website, type: "Other" }, null);
    created = true;
  } else if (website && !cv?.website) {
    await notionUpdatePage(companyId, { Website: { url: website.startsWith("http") ? website : `https://${website}` } });
  }
  cv = companyView(await enrich.notionGetPage(companyId));

  const job = newJob("score", { companyId, companyName: cv.name });
  spent.push("Parallel Core scoring");
  enrich.scoreCompany(companyId, { name: cv.name, website: cv.website })
    .then(async res => {
      const j = jobs.get(job.id);
      j.result = res;
      j.company = companyView(await enrich.notionGetPage(companyId));
      j.status = "done";
    })
    .catch(e => { const j = jobs.get(job.id); j.status = "failed"; j.error = enrich.errDetail(e); });

  return { ok: true, kind: "company", found: !!cv, created, source: "scoring", spent, company: cv, scoreJobId: job.id };
}

// ── Telegram rendering (HTML) ────────────────────────────────────────────────
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SOURCE_LABEL = {
  "crm":        "из CRM, 0 кредитов",
  "crm+apollo": "CRM + дозаполнил из Apollo, записал в Notion",
  "apollo-new": "из Apollo, добавил в CRM",
};

function renderPerson(r) {
  const p = r.person;
  const lines = [`👤 <b>${esc(p.name)}</b>${p.role ? ` — ${esc(p.role)}` : ""}`];
  if (r.company?.name) lines.push(`🏢 ${esc(r.company.name)}`);
  lines.push(`✉️ ${p.email ? esc(p.email) : "<i>email нет</i>"}`);
  lines.push(`🔗 ${p.linkedin ? `<a href="${esc(p.linkedin)}">LinkedIn</a>` : "<i>LinkedIn нет</i>"}`);
  if (p.phone) lines.push(`📞 ${esc(p.phone)}`);
  else if (r.phoneJobId) lines.push(`📞 <i>запросил в Apollo, пришлю отдельным сообщением</i>`);
  if (p.telegram) lines.push(`✈️ ${esc(p.telegram)}`);
  lines.push("");
  lines.push(`<i>${SOURCE_LABEL[r.source] || ""}</i>${p.url ? ` · <a href="${esc(p.url)}">Notion</a>` : ""}`);
  if (r.note) lines.push(r.note);
  return lines.join("\n");
}

function renderCompany(c, { header = "", note = "" } = {}) {
  const lines = [];
  if (header) lines.push(header);
  const score = c.bdScore !== null && c.bdScore !== undefined ? `BD Score <b>${c.bdScore}</b>` : "<i>не скорена</i>";
  lines.push(`🏢 <b>${esc(c.name)}</b> — ${score}${c.priority ? ` · Priority ${esc(c.priority)}` : ""}`);
  if (c.stage) lines.push(`Стадия: ${esc(c.stage)}`);
  if (c.website) lines.push(`🌐 ${esc(c.website)}`);
  if (c.description) lines.push(`\n${esc(c.description.slice(0, 600))}`);
  if (c.insight) lines.push(`\n<i>${esc(c.insight.slice(0, 500))}</i>`);
  if (note) lines.push(`\n<i>${note}</i>`);
  if (c.url) lines.push(`<a href="${esc(c.url)}">Notion</a>`);
  return lines.join("\n");
}

function renderResult(r) {
  if (!r.ok || r.message) return r.message ? esc(r.message).replace(/&lt;(\/?)i&gt;/g, "<$1i>") : "❌ Ошибка";
  if (r.kind === "person") return renderPerson(r);
  if (r.kind === "company") {
    if (r.source === "crm") return renderCompany(r.company, { note: "из CRM, 0 кредитов" });
    return renderCompany(r.company, {
      header: `⏳ ${r.created ? "Компании не было в CRM — добавил." : "В CRM есть, но без скоринга."} Запустил скоринг (Parallel Core, обычно 1-5 минут), пришлю результат сюда.`,
    });
  }
  return "";
}

function renderJob(job) {
  if (!job) return null;
  if (job.kind === "phone") {
    if (job.status === "failed") return `📞 ${esc(job.name)}: Apollo не смог выдать телефон (${esc(job.error || "ошибка")}).`;
    return job.phone
      ? `📞 <b>${esc(job.name)}</b>: ${esc(job.phone)}${job.personPageId ? "\n<i>записал в Notion</i>" : ""}`
      : `📞 ${esc(job.name)}: в Apollo телефона нет.`;
  }
  if (job.kind === "score") {
    if (job.status === "failed") return `❌ Скоринг ${esc(job.companyName)} не получился: ${esc(String(job.error || "").slice(0, 200))}`;
    const tier = job.result?.tier ? ` (${esc(job.result.tier)})` : "";
    return renderCompany(job.company, { header: `✅ Скоринг готов${tier}, записал в Notion.` });
  }
  return null;
}

// ── Entry point used by the route ────────────────────────────────────────────
async function ask({ text, hint }) {
  const req = await parseRequest(text, hint);
  if (req.intent === "person")  { const r = await lookupPerson({ name: req.name, company: req.company, wantPhone: req.want_phone }); return { intent: "person", request: req, ...r, telegram: renderResult(r) }; }
  if (req.intent === "company") { const r = await lookupCompany({ company: req.company || req.name }); return { intent: "company", request: req, ...r, telegram: renderResult(r) }; }
  return { intent: "other", request: req };
}

module.exports = {
  ask,
  getJob,
  renderJob,
  handlePhoneWebhook,
  // tests
  parseRequestFast,
  extractPhones,
  personView,
  companyView,
};
