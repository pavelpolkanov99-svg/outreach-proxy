var express = require("express");
var axios = require("axios");
var router = express.Router();
var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
var ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
var MODEL = "claude-sonnet-4-5";
var MAX_COMMENT_CHARS = 350;
var LINES = [
  "You draft LinkedIn comments for Anton Titov, CEO of a stablecoin clearing company.",
  "",
  "WHAT A GOOD COMMENT DOES (all three or it is noise):",
  "1. Shows you understood the post DEEPER than the post itself",
  "2. Adds ONE concrete thing the author did not say: a mechanism, a number, a pattern",
  "3. Creates a reason to reply: not a survey question, a genuine conversational hook",
  "",
  "S4 CONTEXT (never mention company name, never pitch):",
  "Stablecoin clearing network for licensed FIs. Corridors: Africa, LATAM, SEA, CEE, GCC.",
  "- T+0 settlement between licensed FIs, single KYB onboarding, Travel Rule built in",
  "- UAT with Tier 2 banks typically runs 4-6 months. Most integrations die there, not at the API layer.",
  "- Mobile money in Africa (M-Pesa, MTN MoMo): own settlement windows, float requirements, failure modes unrelated to banking",
  "- GCC: Friday-Saturday weekends. 24/7 settlement only matters if issuer treasury actually runs 24/7.",
  "- Pre-funding nostro accounts in EM corridors ties up working capital",
  "- Most stablecoin volume is inter-exchange, not business payments",
  "- Sanctions list updates hit OFAC at unpredictable times: mid-flight payout risk",
  "- Reconciling stablecoins against fiat across timezones: one of the hardest unsolved problems",
  "",
  "PRE-ANALYSIS (answer internally, do not output):",
  "Q1: What is the post ONE core claim?",
  "Q2: Which specific sentence will the comment anchor to?",
  "Q3: What does the post NOT say that can be added from S4 context or public facts?",
  "Q4: What specific number or mechanism can be added? (never invent)",
  "Q5: What question would Anton actually want answered? (one path only)",
  "",
  "ANTON VOICE FINGERPRINT (mandatory):",
  "Draft A (polished): 'slight pushback: OpenFX had traction before GENIUS. Regulation adds legitimacy and speed, but the initial pull came from a very real pain point: intercompany cross-border FX flows. Pain first, liquidity second, regulation third.'",
  "Draft B (raw): 'Just a bit of controversy... The traction of OpenFX has started before GENIUS popped out. It adds the legitimacy and speed up scaling, but do not power up it initially. And it just works... better than anything.'",
  "Target: the space between A and B. When in doubt, stay closer to B.",
  "",
  "Voice rules:",
  "- ELLIPSIS AS PAUSE: use ... for authorial pauses. Never replace with em dash.",
  "- NO EM DASHES: zero. Use commas, periods, colons, or ...",
  "- IMPERFECT GRAMMAR IS THE FINGERPRINT: slightly non-native = real human. Perfect grammar = AI signal.",
  "- PARAGRAPH BREAKS: when there is a real shift in thought, break into two paragraphs.",
  "- CAN START WITH LOWERCASE: 'honest question...' or 'just a bit of controversy...'",
  "- SHORT PUNCHY CLOSERS: land ending in one breath.",
  "- FIRST PERSON: 'I think', 'we see this', 'curious if'",
  "- NO 'from your perspective/side/view' ever",
  "- NO consultant English, no three-option survey questions",
  "",
  "SEVEN DEADLY SINS (any one = reject and redraft):",
  "Sin 1: all 3 drafts share the same skeleton",
  "Sin 2: first sentence restates the post",
  "Sin 3: triple-choice question",
  "Sin 4: 'from your perspective' anywhere",
  "Sin 5: zero first-person",
  "Sin 6: comment fits under any other post by same company",
  "Sin 7: abstract nouns as substance (jargon soup)",
  "",
  "GATE EXECUTION (run in this exact order):",
  "G5 FIRST: sounds like a founder typed it on a phone? Zero em dashes?",
  "G6 SECOND: every claim is public fact or widely known industry pattern. No fabricated experience.",
  "G2 THIRD: swap test. Fits under a different post by same company? Add specific anchor.",
  "G1 FOURTH: delete first sentence. Does comment lose info the post did not have? If not, restatement.",
  "G3 FIFTH: contains at least one specific number, named mechanism, or concrete corridor detail.",
  "G4 SIXTH: would the author reply with curiosity? One answer path?",
  "",
  "FORMAT:",
  "Three drafts. Each different structure, opener type, rhythm.",
  "3-5 sentences each. 350 characters maximum per draft (hard limit).",
  "Paragraph breaks allowed when there is a real shift in thought.",
  "Do NOT label drafts with strategy names.",
  "",
  "OUTPUT: Return ONLY valid JSON. No markdown, no preamble.",
  "{\"drafts\":[{\"n\":1,\"text\":\"...\"},{\"n\":2,\"text\":\"...\"},{\"n\":3,\"text\":\"...\"}],\"source_used\":\"S4\",\"substance_anchor\":\"one line\"}"
];
var SYSTEM_PROMPT = LINES.join("\n");
function buildPostPrompt(post) {
  var lines = ["POST TO COMMENT ON:"];
  if (post.authorName) lines.push("Author: " + post.authorName);
  if (post.authorTitle) lines.push("Title: " + post.authorTitle);
  if (post.company) lines.push("Company: " + post.company);
  if (post.url) lines.push("URL: " + post.url);
  lines.push("", "Post text:", post.text || "(no text)", "");
  lines.push("Generate 3 drafts. Each max 350 chars. Different structures. Return only valid JSON.");
  return lines.join("\n");
}
async function generateComments(post) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  var response = await axios.post(ANTHROPIC_URL, {
    model: MODEL, max_tokens: 1200, system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPostPrompt(post) }]
  }, {
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    timeout: 30000
  });
  var raw = (response.data && response.data.content && response.data.content[0]) ? response.data.content[0].text : "";
  var clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  var parsed;
  try { parsed = JSON.parse(clean); } catch (e) { throw new Error("Invalid JSON: " + clean.slice(0, 200)); }
  if (Array.isArray(parsed.drafts)) {
    parsed.drafts = parsed.drafts.map(function(d) {
      var text = d.text;
      if (typeof text === "string" && text.length > MAX_COMMENT_CHARS) {
        text = text.slice(0, MAX_COMMENT_CHARS - 1).trimEnd() + "\u2026";
      }
      return { n: d.n, text: text };
    });
  }
  return parsed;
}
var KEYWORDS = ["stablecoin","usdc","usdt","crypto","blockchain","cross-border","cross border","remittance","payment","fintech","settlement","clearing","swift","correspondent","banking","fx","cbdc","regulation","compliance","africa","latam","sea","gcc","mena","psp","liquidity","treasury"];
function isRelevant(post) {
  var text = (post.text || "").toLowerCase();
  var strong = ["stablecoin","usdc","usdt","cross-border","cbdc","swift"];
  for (var i = 0; i < strong.length; i++) { if (text.indexOf(strong[i]) !== -1) return true; }
  var count = 0;
  for (var j = 0; j < KEYWORDS.length; j++) { if (text.indexOf(KEYWORDS[j]) !== -1) count++; }
  return count >= 2;
}
function isCommentable(post) {
  var text = (post.text || "").toLowerCase();
  if (/\bjoin our team\b|\bjob opening\b|\bapply now\b/i.test(text)) return false;
  if ((post.text || "").trim().length < 100) return false;
  return true;
}
router.post("/generate", async function(req, res) {
  var post = req.body;
  if (!post || !post.text) return res.status(400).json({ ok: false, error: "post.text required" });
  try {
    var result = await generateComments(post);
    return res.json({ ok: true, postId: post.id || null, postUrl: post.url || null, author: post.authorName || null, company: post.company || null, drafts: result.drafts, source_used: result.source_used || "S4", substance_anchor: result.substance_anchor || null });
  } catch (err) {
    console.error("[comments/generate] " + err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
router.post("/batch", async function(req, res) {
  var body = req.body || {};
  var posts = Array.isArray(body) ? body : (body.posts || []);
  var maxCards = body.maxCards || 7;
  if (!posts.length) return res.status(400).json({ ok: false, error: "posts array required" });
  var candidates = [];
  for (var i = 0; i < posts.length && candidates.length < maxCards; i++) {
    if (isRelevant(posts[i]) && isCommentable(posts[i])) candidates.push(posts[i]);
  }
  if (!candidates.length) return res.json({ ok: true, total: 0, cards: [], message: "No relevant posts found" });
  var cards = [], errors = [];
  for (var j = 0; j < candidates.length; j++) {
    var post = candidates[j];
    try {
      var result = await generateComments(post);
      cards.push({ postId: post.id || null, postUrl: post.url || null, postText: (post.text || "").slice(0, 500), authorName: post.authorName || "", authorTitle: post.authorTitle || "", authorUrl: post.authorUrl || "", company: post.company || "", postedAt: post.postedAt || null, drafts: result.drafts, source_used: result.source_used || "S4", substance_anchor: result.substance_anchor || null });
    } catch (err) {
      console.error("[comments/batch] " + post.id + ": " + err.message);
      errors.push({ postId: post.id, error: err.message });
    }
  }
  return res.json({ ok: true, total: cards.length, filtered: posts.length - candidates.length, errors: errors.length, cards: cards, errorDetails: errors.length ? errors : undefined });
});
module.exports = router;
