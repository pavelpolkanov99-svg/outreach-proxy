// ─────────────────────────────────────────────────────────────────────────────
// CRM lookup for the Telegram bot (v3.33.0)
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
    photo:    photoFromFiles(pr.photo || pr.Photo),
    companyId: (pr.Company?.relation || [])[0]?.id || null,
    enrichmentStatus: pr["Enrichment Status"]?.select?.name || null,
  };
}

function photoFromFiles(prop) {
  const f = (prop?.files || [])[0];
  return f ? (f.file?.url || f.external?.url || null) : null;
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
    hardKill:    hardKillFrom(pr),
  };
}

// "Hard Kill - HK-7 ..." tag on the company, or "Hard Kill" in the scoring note.
function hardKillFrom(pr) {
  const tag = (pr.Tags?.multi_select || []).map(o => o.name).find(n => /hard kill/i.test(n));
  if (tag) return tag.replace(/^hard kill\s*[-–:]\s*/i, "").trim() || "Hard Kill";
  const ins = txt(pr.Insight);
  const m = /Hard Kill\s*(HK-?\d+[^.,)]*)?/i.exec(ins);
  return m ? (m[1] ? m[1].trim() : "Hard Kill") : null;
}

const tierOf = score => score === null || score === undefined ? null
  : score >= 9 ? "MH" : score >= 7.5 ? "P1" : score >= 5 ? "P2" : score >= 3 ? "P3" : "Skip";
const tierEmoji = (score, hk) => hk ? "🔴" : score === null || score === undefined ? "⚪" : score >= 7.5 ? "🟢" : "🟡";

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
    orgDescription: org.short_description ? twoSentences(org.short_description) : null,
    headline: p.headline || null,
    photoUrl: realPhoto(p.photo_url),
    employment: (p.employment_history || []).map(e => ({
      org: e.organization_name || null, title: e.title || null, current: !!e.current,
    })),
  };
}

// First two sentences of Apollo's company blurb.
function twoSentences(text) {
  const parts = String(text).replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+(\s|$)/g) || [String(text)];
  return parts.slice(0, 2).join("").trim().slice(0, 450);
}

// LinkedIn's grey "ghost" avatar is not a photo.
function realPhoto(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (/static\.licdn\.com|ghost|default[_-]?avatar|no[_-]?photo/i.test(url)) return null;
  return url;
}

// "Visa Inc." / "VISA" / "ex-Visa" / "bankstore.ai" → comparable core name.
function coreName(s) {
  return String(s || "").toLowerCase()
    .replace(/https?:\/\/|www\./g, "")
    .replace(/\.(com|ai|io|co|net|org|finance|money|xyz|app|global)\b/g, " ")
    .replace(/\b(inc|ltd|llc|gmbh|s\.?a|ag|plc|limited|group|holdings?|corp(oration)?|co|bv|ab|oy|pte|sas|srl)\b\.?/g, " ")
    .replace(/[^a-z0-9а-яё]+/g, " ").replace(/\s+/g, " ").trim();
}

// The LinkedIn photo is only trusted when the profile actually ties the person
// to the company we asked about: current org, title / headline, or any past job.
function profileMatchesCompany(ap, companyName) {
  const want = coreName(companyName);
  if (!ap || want.length < 2) return false;
  const fields = [ap.orgName, ap.title, ap.headline, ...(ap.employment || []).flatMap(e => [e.org, e.title])]
    .map(coreName).filter(Boolean);
  const wordRe = new RegExp(`(^|\\s)${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
  return fields.some(f => f === want || wordRe.test(f) || (f.length >= 4 && want.includes(f)));
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

// ── Photo ────────────────────────────────────────────────────────────────────
// Gravatar: free, no key. A photo tied to the person's own email address.
async function gravatarPhoto(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return null;
  const hash = crypto.createHash("sha256").update(e).digest("hex");
  const url = `https://gravatar.com/avatar/${hash}?s=400&d=404`;
  try {
    const r = await axios.get(url, { timeout: 8_000, responseType: "arraybuffer", validateStatus: () => true });
    return r.status === 200 ? url : null;
  } catch (_) { return null; }
}

// Verified photo → Notion People "photo" (Files). Downloads the image and uploads
// it to Notion, because LinkedIn image links expire.
async function savePhotoToNotion(pageId, imageUrl) {
  const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15_000, maxContentLength: 5 * 1024 * 1024 });
  const contentType = String(img.headers["content-type"] || "image/jpeg").split(";")[0];
  if (!/^image\//.test(contentType)) throw new Error(`not an image: ${contentType}`);
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const filename = `photo.${ext}`;
  const { notionHeaders } = require("./notion");
  const h = notionHeaders();
  const created = await axios.post("https://api.notion.com/v1/file_uploads", { filename, content_type: contentType }, { headers: h, timeout: 15_000 });
  const form = new FormData();
  form.append("file", new Blob([img.data], { type: contentType }), filename);
  await axios.post(`https://api.notion.com/v1/file_uploads/${created.data.id}/send`, form, {
    headers: { Authorization: h.Authorization, "Notion-Version": h["Notion-Version"] }, timeout: 30_000,
  });
  await notionUpdatePage(pageId, { photo: { files: [{ type: "file_upload", file_upload: { id: created.data.id }, name: filename }] } });
}

const photoTried = new Set();   // CRM people we already asked Apollo for a photo (per process)

// Order (no paid services):
//   1. Notion "photo"                                   → verified
//   2. LinkedIn photo via Apollo, profile mentions the company (current job,
//      title, headline or any past job)                 → verified, saved to Notion
//   3. Gravatar of the person's email                   → verified, saved to Notion
//   4. LinkedIn photo via Apollo WITHOUT the company in the profile
//                                                       → shown with a disclaimer, not saved
const PHOTOS_ON = () => process.env.LOOKUP_PHOTOS !== "false";   // kill switch for photos

async function resolvePhoto({ person, companyName, ap }) {
  if (!PHOTOS_ON()) return null;
  if (person?.photo) return { url: person.photo, source: "notion", confident: true };
  const save = url => { if (person?.pageId) savePhotoToNotion(person.pageId, url).catch(e => console.error(`[lookup] photo save failed: ${enrich.errDetail(e)}`)); };
  if (ap?.photoUrl && companyName && profileMatchesCompany(ap, companyName)) {
    save(ap.photoUrl);
    return { url: ap.photoUrl, source: "linkedin", confident: true };
  }
  const g = await gravatarPhoto(person?.email || ap?.email);
  if (g) { save(g); return { url: g, source: "gravatar", confident: true }; }
  if (ap?.photoUrl) {
    return { url: ap.photoUrl, source: "linkedin-unverified", confident: false,
      reason: companyName ? `в LinkedIn-профиле нет ${companyName}` : "компания не указана" };
  }
  return null;
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
  let companyCard = null;   // full CRM company view for the mini-scoring block
  if (companyId) {
    companyCard = companyView(await enrich.notionGetPage(companyId));
    companyInfo = { name: companyCard.name || company, website: companyCard.website };
  }

  const hit = await enrich.findPerson({ name, telegram: null, email: null, linkedin: null }, companyId);
  let person = hit?.id ? personView(await enrich.notionGetPage(hit.id)) : null;
  // A name-only CRM hit linked to a DIFFERENT company than the one asked about is
  // treated as a namesake: look the asked-about person up in Apollo instead.
  if (person && companyId && person.companyId && person.companyId !== companyId) person = null;
  let source = person ? "crm" : null;

  if (person && !companyCard && person.companyId) {
    companyCard = companyView(await enrich.notionGetPage(person.companyId));
    companyInfo = { name: companyCard.name, website: companyCard.website };
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
    return { ok: true, kind: "person", found: true, source: "crm", spent, person, company: null, companyCard: null,
      note: `Чтобы дозаполнить${needPhone ? " и достать телефон" : ""} через Apollo, напиши компанию: <i>${esc(name)} из …</i>` };
  }
  const callApollo = (person && (missing.length && apolloAllowed)) || !person || needPhone;
  let ap = null;

  if (callApollo) {
    if (!person && !companyInfo) {
      return { ok: true, kind: "person", found: false,
        message: `В CRM нет «${name}». Напиши компанию (например: <i>${name} из Bitso</i>) — по одному имени в Apollo не ищу, чтобы не жечь кредиты.` };
    }
    if (needPhone) {
      phoneJob = newJob("phone", { name, personPageId: person?.pageId || null });
    }
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

  // Newly created / re-linked person: pick up the company card if we don't have it yet.
  if (!companyCard && person?.companyId) {
    try { companyCard = companyView(await enrich.notionGetPage(person.companyId)); } catch (_) {}
  }
  // Photo: CRM people without one get a single Apollo match (≈1 credit) when
  // Apollo can identify them; the result is saved to Notion so it's free next time.
  // Match the profile against the name Anton typed (CRM names can be long taglines).
  const companyName = company || companyCard?.name || companyInfo?.name || null;
  if (PHOTOS_ON() && !person.photo && !ap && identifiable && !photoTried.has(person.pageId)) {
    photoTried.add(person.pageId);
    try {
      ap = await apolloMatch({ name: person.name, company: companyInfo, linkedin: person.linkedin });
      spent.push("Apollo match (фото)");
    } catch (_) { ap = null; }
  }

  // Company blurb missing in CRM → take Apollo's (came free with the match) and save it.
  if (companyCard && !companyCard.description && ap?.orgDescription) {
    companyCard.description = ap.orgDescription;
    notionUpdatePage(companyCard.pageId, { "Company description": { rich_text: [{ text: { content: ap.orgDescription } }] } })
      .catch(e => console.error(`[lookup] description save failed: ${enrich.errDetail(e)}`));
  }
  // Company not scored yet → score it now (once; the result lands in Notion and
  // arrives in the chat as a follow-up message).
  let scoreJobId = null;
  if (companyCard && (companyCard.bdScore === null || companyCard.bdScore === undefined) && !companyCard.hardKill) {
    scoreJobId = startScoreJob(companyCard.pageId, companyCard);
    spent.push("Parallel Core scoring");
  }
  const verdict = companyCard ? await companyVerdict(companyCard).catch(() => null) : null;

  const photo = await resolvePhoto({ person, companyName, ap }).catch(() => null);

  return {
    ok: true, kind: "person", found: true, source, spent,
    person, company: companyInfo, companyCard, verdict, photo, scoreJobId,
    phoneJobId: phoneJob && jobs.get(phoneJob.id)?.status === "running" ? phoneJob.id : null,
  };
}

// One-line "what to do with them" for the card, grounded ONLY in what the
// scoring already wrote to Notion (no new research, ~0.1¢). Skipped when the
// company has no score yet.
const VERDICT_PROMPT = `You write ONE short line in Russian (max 160 characters) for Plexo's BD team: how to treat this company — node in the network (licensed FI that would send/receive flows), channel partner, investor, competitor, or not relevant — and the single main reason. Plexo is a stablecoin clearing network for licensed financial institutions. Use ONLY the facts given. No em-dashes, no marketing words. Return only the line.`;

async function companyVerdict(cv) {
  if (!ANTHROPIC_KEY || cv.bdScore === null || cv.bdScore === undefined) return null;
  const facts = [
    `Company: ${cv.name}`,
    `BD score: ${cv.bdScore} (${tierOf(cv.bdScore)})`,
    cv.hardKill ? `Hard Kill: ${cv.hardKill}` : "Hard Kill: none",
    cv.description ? `What they do: ${cv.description}` : "",
    cv.insight ? `Scoring note: ${cv.insight}` : "",
  ].filter(Boolean).join("\n");
  const r = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-haiku-4-5-20251001", max_tokens: 120, system: VERDICT_PROMPT,
    messages: [{ role: "user", content: facts.slice(0, 2500) }],
  }, {
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    timeout: 15_000,
  });
  const line = (r.data?.content || []).map(b => b.text || "").join("").replace(/\s+/g, " ").replace(/—/g, ",").trim();
  return line ? line.slice(0, 200) : null;
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
// One scoring run per company at a time (two people from the same company asked
// back to back share it).
const scoringNow = new Map();   // companyId → jobId
function startScoreJob(companyId, cv) {
  const running = scoringNow.get(companyId);
  if (running && jobs.get(running)?.status === "running") return running;
  const job = newJob("score", { companyId, companyName: cv.name });
  scoringNow.set(companyId, job.id);
  enrich.scoreCompany(companyId, { name: cv.name, website: cv.website })
    .then(async res => {
      const j = jobs.get(job.id);
      j.result = res;
      j.company = companyView(await enrich.notionGetPage(companyId));
      j.status = "done";
    })
    .catch(e => { const j = jobs.get(job.id); j.status = "failed"; j.error = enrich.errDetail(e); });
  return job.id;
}
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

  spent.push("Parallel Core scoring");
  const scoreJobId = startScoreJob(companyId, cv);
  return { ok: true, kind: "company", found: !!cv, created, source: "scoring", spent, company: cv, scoreJobId };
}

// ── Telegram rendering (HTML) ────────────────────────────────────────────────
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SOURCE_LABEL = {
  "crm":        "из CRM",
  "crm+apollo": "CRM + дозаполнил из Apollo, записал в Notion",
  "apollo-new": "из Apollo, добавил в CRM",
};
const spendLabel = spent => (spent && spent.length) ? `потрачено: ${spent.join(", ")}` : "0 кредитов";

// "Archway Finance – Secure & Fast Payments for Freelancers" → "Archway Finance"
const shortName = n => String(n || "").split(/\s+[–—|:]\s+|\s+-\s+/)[0].trim() || n;
const linkOf = url => url ? (/^https?:\/\//i.test(url) ? url : `https://${url}`) : null;
const hostOf = url => { try { return new URL(linkOf(url)).hostname.replace(/^www\./, ""); } catch (_) { return url; } };

// Person card (layout "D"): contacts, then a mini-scoring block for their company.
function renderPerson(r) {
  const p = r.person;
  const c = r.companyCard;
  const companyName = shortName(c?.name || r.company?.name || "") || null;
  const lines = [`👤 <b>${esc(p.name)}</b>${p.role ? ` — ${esc(p.role)}` : ""}${companyName ? `, ${esc(companyName)}` : ""}`];

  const contacts = [];
  contacts.push(p.email ? `✉️ ${esc(p.email)}` : "✉️ <i>нет email</i>");
  contacts.push(p.linkedin ? `🔗 <a href="${esc(p.linkedin)}">LinkedIn</a>` : "🔗 <i>нет LinkedIn</i>");
  const site = c?.website || r.company?.website;
  if (site) contacts.push(`🌐 <a href="${esc(linkOf(site))}">${esc(hostOf(site))}</a>`);
  if (p.phone) contacts.push(`📞 ${esc(p.phone)}`);
  else if (r.phoneJobId) contacts.push("📞 <i>запросил, пришлю отдельно</i>");
  if (p.telegram) contacts.push(`✈️ ${esc(p.telegram)}`);
  lines.push(contacts.join(" · "));

  if (c) {
    lines.push("");
    const tier = tierOf(c.bdScore);
    const score = c.bdScore !== null && c.bdScore !== undefined
      ? `${tierEmoji(c.bdScore, c.hardKill)} ${tier} · ${c.bdScore}`
      : "⚪ не скорена";
    const hk = c.hardKill ? `🔴 Hard Kill: ${esc(c.hardKill)}` : (c.bdScore !== null && c.bdScore !== undefined ? "Hard Kill нет" : "");
    lines.push(`🏢 <b>${esc(shortName(c.name))}</b> — ${score}${hk ? ` · ${hk}` : ""}`);
    if (c.description) lines.push(esc(c.description.slice(0, 450)));
    if (r.verdict) lines.push(`→ ${esc(r.verdict)}`);
    else if (r.scoreJobId) lines.push(`⏳ <i>Скоринга ещё не было, запустил. Пришлю оценку сюда через 1-5 минут.</i>`);
  }

  if (r.photo && !r.photo.confident) {
    lines.push("");
    lines.push(`⚠️ <i>Фото из LinkedIn, но ${esc(r.photo.reason)}, может быть не он</i>`);
  }

  lines.push("");
  const meta = [c?.stage ? esc(c.stage) : null, SOURCE_LABEL[r.source] || null, esc(spendLabel(r.spent)), p.url ? `<a href="${esc(p.url)}">Notion</a>` : null].filter(Boolean);
  lines.push(`<i>${meta.join(" · ")}</i>`);
  if (r.note) lines.push(r.note);
  return lines.join("\n");
}

function renderCompany(c, { header = "", note = "" } = {}) {
  const lines = [];
  if (header) lines.push(header);
  const score = c.bdScore !== null && c.bdScore !== undefined ? `BD Score <b>${c.bdScore}</b>` : "<i>не скорена</i>";
  lines.push(`🏢 <b>${esc(shortName(c.name))}</b> — ${score}${c.priority ? ` · Priority ${esc(c.priority)}` : ""}`);
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
  profileMatchesCompany,
  renderPerson,
  realPhoto,
  personView,
  companyView,
};
