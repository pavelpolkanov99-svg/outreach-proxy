// Run: node --test test/hub-enrich.test.js
const test = require("node:test");
const assert = require("node:assert");
const { nextStage, sanitizeClassification, domainOf, parseJsonLoose, shouldRunStagePass, normHandle, linkedinSlug, priorityForTier } = require("../lib/hub-enrich");

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
test("stage: unanswered outreach still starts at Opened Conversation", () => {
  assert.strictEqual(nextStage(null, "Outreach Started", null), "Opened Conversation");
  assert.strictEqual(nextStage("To Contact", "Outreach Started", null), "Opened Conversation");
  assert.strictEqual(nextStage("Warm discussions", "Outreach Started", null), null);
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
test("stage pass: skipped for Staff / Personal / Spam rows in the Hub", () => {
  assert.strictEqual(shouldRunStagePass(["Staff"]), false);
  assert.strictEqual(shouldRunStagePass(["Personal"]), false);
  assert.strictEqual(shouldRunStagePass(["Spam / Noise"]), false);
  assert.strictEqual(shouldRunStagePass(["Investor / VC"]), true);
  assert.strictEqual(shouldRunStagePass(["Partnership", "Client"]), true);
});
test("dedup helpers: telegram handle and LinkedIn slug normalisation", () => {
  assert.strictEqual(normHandle("@NicolasMauer"), "nicolasmauer");
  assert.strictEqual(normHandle("https://t.me/kushzoth"), "kushzoth");
  assert.strictEqual(normHandle(""), null);
  assert.strictEqual(linkedinSlug("http://www.linkedin.com/in/maria-lobanova-01881447"), "maria-lobanova-01881447");
  assert.strictEqual(linkedinSlug("https://linkedin.com/in/JohnRoe/?trk=x"), "johnroe");
  assert.strictEqual(linkedinSlug("https://example.com"), null);
});
test("priority: scoring tier maps to the Companies Priority option", () => {
  assert.strictEqual(priorityForTier("P1"), "1");
  assert.strictEqual(priorityForTier("P2"), "2");
  assert.strictEqual(priorityForTier("P3"), "3");
  assert.strictEqual(priorityForTier("Skip"), "3");
  assert.strictEqual(priorityForTier("Hard Kill"), "HK");
  assert.strictEqual(priorityForTier("Manual Review"), null);
});

test("linkedinUrlFromSenderId decodes Beeper LinkedIn URNs", () => {
  const { linkedinUrlFromSenderId } = require("../lib/hub-enrich");
  assert.equal(
    linkedinUrlFromSenderId("@linkedin__a_co_a_a_b___n__k4_b0_c_k_c_l_c_or_qx-_x_t6_f5_h_fbg6_evt__j_y:beeper.local"),
    "https://www.linkedin.com/in/ACoAAB_N_k4B0CKCLCOrQx-XT6F5HFbg6Evt_jY");
  assert.equal(
    linkedinUrlFromSenderId("@linkedin__a_co_a_a_a_nf_bu_a_b_jlzu_k_vs_h_k2_b7c98r7z7w_t1_q_h4_lk:beeper.local"),
    "https://www.linkedin.com/in/ACoAAANfBuABJlzuKVsHK2B7c98r7z7wT1QH4Lk");
  assert.equal(linkedinUrlFromSenderId("@pavel-remide:beeper.com"), null);
  assert.equal(linkedinUrlFromSenderId("@whatsapp_123:beeper.local"), null);
});

test("attachLinkedInFromMessages fills only LinkedIn chats, never overwrites", () => {
  const { attachLinkedInFromMessages } = require("../lib/hub-enrich");
  const msgs = [
    { isSender: true, senderID: "@pavel-remide:beeper.com", senderName: "x" },
    { isSender: false, senderName: "Durga Prasad Uppu",
      senderID: "@linkedin__a_co_a_a_a_nf_bu_a_b_jlzu_k_vs_h_k2_b7c98r7z7w_t1_q_h4_lk:beeper.local" },
  ];
  const out = attachLinkedInFromMessages([{ name: "Durga Prasad Uppu", linkedin: null }], msgs, "LinkedIn");
  assert.match(out[0].linkedin, /ACoAAANfBu/);
  const kept = attachLinkedInFromMessages([{ name: "Durga Prasad Uppu", linkedin: "https://linkedin.com/in/durga" }], msgs, "LinkedIn");
  assert.equal(kept[0].linkedin, "https://linkedin.com/in/durga");
  const wa = attachLinkedInFromMessages([{ name: "Durga Prasad Uppu", linkedin: null }], msgs, "WhatsApp");
  assert.equal(wa[0].linkedin, null);
});
