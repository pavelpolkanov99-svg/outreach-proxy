// Run: node --test test/hub-enrich.test.js
const test = require("node:test");
const assert = require("node:assert");
const { nextStage, sanitizeClassification, domainOf, parseJsonLoose } = require("../lib/hub-enrich");

test("stage: empty company gets default Opened Conversation", () => {
  assert.strictEqual(nextStage(null, null, null), "Opened Conversation");
});
test("stage: only raises, never lowers", () => {
  assert.strictEqual(nextStage("Warm discussions", "Opened Conversation", null), null);
  assert.strictEqual(nextStage("Opened Conversation", "Warm discussions", null), "Warm discussions");
  assert.strictEqual(nextStage("Onboarding", "Discovery Process", 9), null);
});
test("stage: same stage is a no-op", () => {
  assert.strictEqual(nextStage("Warm discussions", "Warm discussions", null), null);
});
test("stage: Discovery Process splits by BD Score", () => {
  assert.strictEqual(nextStage("Warm discussions", "Discovery Process", 8.1), "Discovery Process P1");
  assert.strictEqual(nextStage("Warm discussions", "Discovery Process", 6.4), "Discovery Process P2");
  assert.strictEqual(nextStage("Warm discussions", "Discovery Process", null), "Discovery Process P2");
  assert.strictEqual(nextStage("Discovery Process P2", "Discovery Process", 8.0), "Discovery Process P1");
});
test("stage: terminal stages are never touched", () => {
  for (const t of ["Win", "Lost", "Not relevant", "DELETE"]) assert.strictEqual(nextStage(t, "Onboarding", 9), null);
});
test("stage: legacy options are ranked, unknown ones left alone", () => {
  assert.strictEqual(nextStage("Negotiations", "Warm discussions", null), null);
  assert.strictEqual(nextStage("Communication Started", "Warm discussions", null), "Warm discussions");
  assert.strictEqual(nextStage("Something Custom", "Onboarding", null), null);
});
test("stage: Outreach Started for unanswered outreach on an empty company", () => {
  assert.strictEqual(nextStage(null, "Outreach Started", null), "Outreach Started");
  assert.strictEqual(nextStage("To Contact", "Outreach Started", null), "Outreach Started");
});
test("classification: drops internal people, bad categories and invents nothing", () => {
  const c = sanitizeClassification({
    category: ["Investor / VC", "Bogus"],
    stage: "Win",
    people: [{ name: "Anton Titov" }, { name: "Leah Valente", role: "Partner" }, { name: "x" }],
    company: { name: "ParaFi", type: "Weird" },
  });
  assert.deepStrictEqual(c.category, ["Investor / VC"]);
  assert.strictEqual(c.stage, null);
  assert.deepStrictEqual(c.people.map(p => p.name), ["Leah Valente"]);
  assert.strictEqual(c.company.type, "Other");
  assert.strictEqual(c.company.website, null);
});
test("classification: empty category falls back to Outreach", () => {
  assert.deepStrictEqual(sanitizeClassification({}).category, ["Outreach"]);
});
test("helpers", () => {
  assert.strictEqual(domainOf("https://www.ParaFi.com/team"), "parafi.com");
  assert.strictEqual(domainOf("tap2pay.me"), "tap2pay.me");
  assert.strictEqual(domainOf(null), null);
  assert.deepStrictEqual(parseJsonLoose('Sure:\n{"a":1}\n'), { a: 1 });
});
test("classification: invalid email / linkedin are dropped so Notion writes don't 400", () => {
  const c = sanitizeClassification({ category: ["Client"], people: [
    { name: "Jane Doe", email: "jane at acme", linkedin: "linkedin.com/in/jane" },
    { name: "John Roe", email: "john@acme.io", linkedin: "https://www.linkedin.com/in/johnroe" },
  ]});
  assert.strictEqual(c.people[0].email, null);
  assert.strictEqual(c.people[0].linkedin, null);
  assert.strictEqual(c.people[1].email, "john@acme.io");
  assert.strictEqual(c.people[1].linkedin, "https://www.linkedin.com/in/johnroe");
});
