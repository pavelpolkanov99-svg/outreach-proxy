// Run: node --test test/crm-lookup.test.js
// Notion / Apollo / Anthropic are stubbed at the axios level, so these tests
// check the credit discipline (what gets called when) without any network.
process.env.APOLLO_KEY = "test-apollo";
process.env.ANTHROPIC_API_KEY = "test-anthropic";
process.env.PARALLEL_KEY = "";

const test   = require("node:test");
const assert = require("node:assert");
const axios  = require("axios");

const calls = [];
let fake = {};
axios.post = async (url, body) => { calls.push({ m: "POST", url, body }); return fake.post(url, body); };
axios.get  = async (url, opts) => { calls.push({ m: "GET", url }); return fake.get(url, opts); };
axios.patch = async (url, body) => { calls.push({ m: "PATCH", url, body }); return { data: { id: url.split("/").pop() } }; };

const lookup = require("../lib/crm-lookup");

const PERSON_FULL = {
  id: "p1", url: "https://notion.so/p1",
  properties: {
    Name: { title: [{ plain_text: "Ivan Petrov" }] },
    Role: { rich_text: [{ plain_text: "CEO" }] },
    Email: { email: "ivan@bitso.com" },
    LinkedIn: { url: "https://www.linkedin.com/in/ivanpetrov" },
    Phone: { phone_number: null },
    Company: { relation: [{ id: "c1" }] },
    "Enrichment Status": { select: null },
  },
};
const COMPANY = (extra = {}) => ({
  id: "c1", url: "https://notion.so/c1",
  properties: {
    "Company name": { title: [{ plain_text: "Bitso" }] },
    Website: { url: "https://bitso.com" },
    "BD Score": { number: null },
    Priority: { multi_select: [] },
    Stage: { status: { name: "Warm discussions" } },
    ...extra,
  },
});

function notionFake({ people = [], companies = [] }) {
  return {
    post: async (url, body) => {
      if (url.includes("/databases/")) {
        const isPeople = url.includes("f36b2a0f0ab241cebbdbd1d0874a55be");
        const f = JSON.stringify(body.filter || {});
        if (isPeople) return { data: { results: f.includes('"Name"') ? people : [] } };
        if (url.includes("f9b59c5b05fa4df18f9569479633fd74")) return { data: { results: f.includes('"Company name"') ? companies : [] } };
        return { data: { results: [] } };
      }
      if (url.includes("apollo.io")) return { data: { person: null } };
      if (url.includes("api.notion.com/v1/pages")) return { data: { id: "new-page" } };
      throw new Error("unexpected POST " + url);
    },
    get: async (url) => {
      const id = url.split("/").pop();
      const all = [...people, ...companies];
      const hit = all.find(p => p.id === id);
      if (hit) return { data: hit };
      throw new Error("unexpected GET " + url);
    },
  };
}

const apolloCalls = () => calls.filter(c => c.url.includes("apollo.io"));

test("fast parse: person with company, phone flag, and scoring", () => {
  assert.deepStrictEqual(lookup.parseRequestFast("Иван Петров из Bitso телефон", "person"),
    { intent: "person", name: "Иван Петров", company: "Bitso", want_phone: true });
  assert.deepStrictEqual(lookup.parseRequestFast("Ivan Petrov, Bitso", "person"),
    { intent: "person", name: "Ivan Petrov", company: "Bitso", want_phone: false });
  assert.strictEqual(lookup.parseRequestFast("скоринг Bitso").company, "Bitso");
  assert.strictEqual(lookup.parseRequestFast("score: Banco KEVE?").company, "Banco KEVE");
  assert.strictEqual(lookup.parseRequestFast("что там по встрече завтра"), null);
});

test("Apollo phone webhook parsing prefers valid mobile numbers", () => {
  const phones = lookup.extractPhones({ people: [{ id: "x", phone_numbers: [
    { sanitized_number: "+1111", type_cd: "work_hq" },
    { sanitized_number: "+2222", type_cd: "mobile", status_cd: "valid_number" },
  ] }] });
  assert.strictEqual(phones[0].number, "+2222");
  assert.deepStrictEqual(lookup.extractPhones({}), []);
});

const WITH_PHOTO = p => ({ ...p, properties: { ...p.properties, photo: { files: [{ type: "file", file: { url: "https://notion-files/p1.jpg" } }] } } });

test("person fully in CRM incl. photo → answered from Notion, zero Apollo calls", async () => {
  calls.length = 0;
  fake = notionFake({ people: [WITH_PHOTO(PERSON_FULL)], companies: [COMPANY({ "BD Score": { number: 7.9 } })] });
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(r.source, "crm");
  assert.strictEqual(r.scoreJobId, null);
  assert.strictEqual(apolloCalls().length, 0);
  assert.match(r.telegram, /ivan@bitso\.com/);
  assert.match(r.telegram, /0 кредитов/);
  assert.deepStrictEqual(r.photo, { url: "https://notion-files/p1.jpg", source: "notion", confident: true });
});

test("person not in CRM and no company → no Apollo spend, asks for company", async () => {
  calls.length = 0;
  fake = notionFake({ people: [], companies: [] });
  const r = await lookup.ask({ text: "Ivan Petrov", hint: "person" });
  assert.strictEqual(apolloCalls().length, 0);
  assert.match(r.telegram, /напиши компанию/i);
});

test("phone asked for a CRM person → exactly one Apollo call with webhook, never without one", async () => {
  calls.length = 0;
  fake = notionFake({ people: [PERSON_FULL], companies: [COMPANY()] });
  fake.post = (orig => async (url, body) => url.includes("apollo.io")
    ? { data: { person: { id: "ap1", email: "ivan@bitso.com", linkedin_url: "https://www.linkedin.com/in/ivanpetrov", title: "CEO" } } }
    : orig(url, body))(fake.post);
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso телефон", hint: "person" });
  const ap = apolloCalls();
  assert.strictEqual(ap.length, 1);
  assert.strictEqual(ap[0].body.reveal_phone_number, true);
  assert.match(ap[0].body.webhook_url, /\/lookup\/apollo-phone\/[0-9a-f]+\?k=[0-9a-f]+$/);
  assert.ok(r.phoneJobId);
  assert.match(r.telegram, /пришлю отдельно/);
});

test("company already scored in CRM → no Apollo, no Parallel", async () => {
  calls.length = 0;
  fake = notionFake({ companies: [COMPANY({ "BD Score": { number: 7.9 }, Priority: { multi_select: [{ name: "1" }] } })] });
  const r = await lookup.ask({ text: "скоринг Bitso" });
  assert.strictEqual(r.source, "crm");
  assert.strictEqual(apolloCalls().length, 0);
  assert.strictEqual(calls.filter(c => c.url.includes("parallel.ai")).length, 0);
  assert.match(r.telegram, /BD Score <b>7.9<\/b>/);
});

test("person not in CRM, company given → one Apollo match (no phone reveal), created in CRM", async () => {
  calls.length = 0;
  const created = { id: "new-page", url: "https://notion.so/new", properties: {
    Name: { title: [{ plain_text: "Maria Lopez" }] }, Role: { rich_text: [{ plain_text: "COO" }] },
    Email: { email: "maria@bitso.com" }, LinkedIn: { url: "https://www.linkedin.com/in/marialopez" },
    Company: { relation: [{ id: "c1" }] }, "Enrichment Status": { select: { name: "Done" } } } };
  fake = notionFake({ people: [], companies: [COMPANY(), created] });
  fake.post = (orig => async (url, body) => url.includes("apollo.io")
    ? { data: { person: { id: "ap2", email: "maria@bitso.com", linkedin_url: "https://www.linkedin.com/in/marialopez", title: "COO", organization_name: "Bitso" } } }
    : orig(url, body))(fake.post);
  const r = await lookup.ask({ text: "Maria Lopez из Bitso", hint: "person" });
  const ap = apolloCalls();
  assert.strictEqual(ap.length, 1);
  assert.strictEqual(ap[0].body.reveal_phone_number, undefined);
  assert.strictEqual(r.source, "apollo-new");
  const createCall = calls.find(c => c.m === "POST" && c.url === "https://api.notion.com/v1/pages");
  assert.ok(createCall, "person page created");
  assert.strictEqual(createCall.body.properties.Phone, undefined);
  assert.match(r.telegram, /добавил в CRM/);
});

test("person card shows company mini-scoring, website and a grounded verdict", async () => {
  calls.length = 0;
  fake = notionFake({ people: [WITH_PHOTO(PERSON_FULL)], companies: [COMPANY({
    "BD Score": { number: 4.7 },
    "Company description": { rich_text: [{ plain_text: "Matches licensed EMIs with banks via a unified KYB profile. Also runs a stablecoin bridge." }] },
    Insight: { rich_text: [{ plain_text: "P3 4.7, floor rule G-1 (license < 3). Overlaps with Plexo KYB positioning." }] },
    Tags: { multi_select: [] },
  })] });
  fake.post = (orig => async (url, body) => url.includes("anthropic.com")
    ? { data: { content: [{ text: "Скорее партнёр-канал, чем узел сети: своей лицензии почти нет." }] } }
    : orig(url, body))(fake.post);
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(apolloCalls().length, 0);
  assert.match(r.telegram, /🌐 <a href="https:\/\/bitso\.com">bitso\.com<\/a>/);
  assert.match(r.telegram, /🟡 P3 · 4\.7 · Hard Kill нет/);
  assert.match(r.telegram, /stablecoin bridge/);
  assert.match(r.telegram, /→ Скорее партнёр-канал/);
});

test("hard kill tag is shown in red", async () => {
  calls.length = 0;
  fake = notionFake({ people: [WITH_PHOTO(PERSON_FULL)], companies: [COMPANY({
    "BD Score": { number: 2.1 },
    Tags: { multi_select: [{ name: "Hard Kill - HK-7 Pure fiat BaaS" }] },
  })] });
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.match(r.telegram, /🔴 Skip · 2\.1 · 🔴 Hard Kill: HK-7 Pure fiat BaaS/);
});

test("LinkedIn photo trusted only when the profile ties the person to the asked company", () => {
  const ap = { orgName: "Stripe", title: "Head of Partnerships", headline: null,
    employment: [{ org: "Visa Inc.", title: "Director", current: false }] };
  assert.strictEqual(lookup.profileMatchesCompany(ap, "Visa"), true);     // ex-Visa in experience
  assert.strictEqual(lookup.profileMatchesCompany(ap, "Stripe"), true);   // current org
  assert.strictEqual(lookup.profileMatchesCompany(ap, "Bitso"), false);   // unrelated
  assert.strictEqual(lookup.profileMatchesCompany({ orgName: "Bankstore", employment: [] }, "bankstore.ai"), true);
  assert.strictEqual(lookup.profileMatchesCompany({ orgName: "Visionary Labs", employment: [] }, "Visa"), false);
  assert.strictEqual(lookup.realPhoto("https://static.licdn.com/aero-v1/sc/h/ghost.png"), null);
});

test("CRM person without photo → one Apollo call; matching profile photo is used without disclaimer", async () => {
  calls.length = 0;
  const p2 = { ...PERSON_FULL, id: "p2" };
  fake = notionFake({ people: [p2], companies: [COMPANY()] });
  fake.post = (orig => async (url, body) => url.includes("apollo.io")
    ? { data: { person: { id: "ap9", title: "CEO", organization_name: "Bitso", photo_url: "https://media.licdn.com/dms/image/abc.jpg", employment_history: [] } } }
    : orig(url, body))(fake.post);
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(apolloCalls().length, 1);
  assert.strictEqual(r.photo.source, "linkedin");
  assert.strictEqual(r.photo.confident, true);
  assert.doesNotMatch(r.telegram, /может быть не он/);
  // second lookup in the same process does not spend again
  calls.length = 0;
  await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(apolloCalls().length, 0);
});

test("Apollo photo of someone not tied to the company is not trusted", async () => {
  calls.length = 0;
  const p3 = { ...PERSON_FULL, id: "p3" };
  fake = notionFake({ people: [p3], companies: [COMPANY()] });
  fake.post = (orig => async (url, body) => url.includes("apollo.io")
    ? { data: { person: { id: "ap10", title: "Teacher", organization_name: "School 5", photo_url: "https://media.licdn.com/dms/image/zzz.jpg", employment_history: [] } } }
    : orig(url, body))(fake.post);
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(r.photo.source, "linkedin-unverified");
  assert.strictEqual(r.photo.confident, false);
  assert.match(r.telegram, /может быть не он/);
});

test("unscored company of a looked-up person → scoring starts once, blurb filled from Apollo", async () => {
  calls.length = 0;
  const p4 = { ...PERSON_FULL, id: "p4" };
  fake = notionFake({ people: [p4], companies: [COMPANY()] });
  fake.post = (orig => async (url, body) => url.includes("apollo.io")
    ? { data: { person: { id: "ap4", title: "CEO", organization_name: "Bitso", employment_history: [],
        organization: { short_description: "Bitso is a crypto exchange in LatAm. It runs payouts in MXN and ARS. It has 9M users." } } } }
    : orig(url, body))(fake.post);
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.ok(r.scoreJobId);
  assert.match(r.telegram, /Bitso is a crypto exchange in LatAm\. It runs payouts in MXN and ARS\./);
  assert.doesNotMatch(r.telegram, /9M users/);
  assert.match(r.telegram, /запустил/);
  assert.ok(calls.some(c => c.m === "PATCH" && c.body?.properties?.["Company description"]), "blurb saved to Notion");
});

test("namesake in CRM at another company is not used for the asked-about company", async () => {
  calls.length = 0;
  const other = { ...PERSON_FULL, id: "p5", properties: { ...PERSON_FULL.properties, Company: { relation: [{ id: "c-other" }] } } };
  fake = notionFake({ people: [other], companies: [COMPANY()] });
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(apolloCalls().length, 1);           // went to Apollo for the Bitso person
  assert.notStrictEqual(r.person?.pageId, "p5");
});
