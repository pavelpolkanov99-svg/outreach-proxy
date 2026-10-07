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

test("person fully in CRM → answered from Notion, zero Apollo calls", async () => {
  calls.length = 0;
  fake = notionFake({ people: [PERSON_FULL], companies: [COMPANY()] });
  const r = await lookup.ask({ text: "Ivan Petrov из Bitso", hint: "person" });
  assert.strictEqual(r.source, "crm");
  assert.strictEqual(apolloCalls().length, 0);
  assert.match(r.telegram, /ivan@bitso\.com/);
  assert.match(r.telegram, /0 кредитов/);
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
  assert.match(r.telegram, /пришлю отдельным сообщением/);
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
