// routes/comments.js
//
// LinkedIn comment generation endpoint for the daily approval cron.
//
// POST /comments/generate
//   Takes one LinkedIn post (text + author metadata) and returns 3 comment
//   drafts written in Anton's voice, grounded in S3/S4 sources, passing all
//   6 editorial gates internally.
//
// POST /comments/batch
//   Takes an array of posts (from /apify/linkedin-posts), runs relevance
//   filtering, generates comments for top N, returns approval-ready cards.

const express  = require("express");
const axios    = require("axios");
const router   = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = "https://api.anthropic.com/v1/messages";
const MODEL             = "claude-sonnet-4-5";

// ─── Plexo S4 context (hardcoded, never used promotionally in comments) ───────
const PLEXO_S4 = `
Plexo is a stablecoin clearing network for licensed financial institutions.
Positioning: "SWIFT for stablecoins."
Corridors: Africa (Nigeria, Kenya, Ghana, Tanzania), LATAM, SEA, CEE, GCC.
Key mechanisms we know from operating:
- T+0 stablecoin settlement between licensed FIs
- Single KYB onboarding, no bilateral integrations
- Travel Rule built in
- Mode A: compliance relay outside money flow
- UAT cycle with Tier 2 banks typically runs 4-6 months
- Mobile money in Africa (M-Pesa, MTN MoMo) has different settlement windows than banking
- GCC has Friday-Saturday weekends — 24/7 settlement asset matters there
- Pre-funding nostro accounts in EM corridors ties up working capital
- Most stablecoin volume is inter-exchange, not business payments
- Sanctions list updates hit OFAC at unpredictable times — mid-flight payout risk

HARD RULE: Never mention Plexo by name in comments. Never pitch.
S4 shows up as operator framing only: "we see this pattern", "I think", "curious if".
`.trim();

// ─── Comment generation system prompt (based on linkedin-comment SKILL.md) ───
const COMMENT_SYSTEM_PROMPT = `
You are generating LinkedIn comment drafts for Anton Titov, CEO of a stablecoin clearing company.
Anton's voice: fast, concrete, slightly imperfect, opinionated. Like a founder who typed from a phone because the point mattered.

Your task: given one LinkedIn post, produce exactly 3 comment drafts using 3 different strategies.

## PLEXO OPERATOR CONTEXT (S4 — use as framing, NEVER promote by name)
${PLEXO_S4}

## THREE STRATEGIES (internal labels — do NOT show in output)
Draft 1 — Pushback/Contradiction: respectfully disagree with one specific claim. Give a concrete reason. End with one sharp question.
Draft 2 — Mechanism/Value-add: agree with direction but add one specific mechanism, number, or pattern not in the post.
Draft 3 — Question/Discovery: open with a reframe of the post's claim, ask one specific question only someone with direct experience can answer.

## ANATOMY OF A GOOD COMMENT (all 3 drafts must follow)
- Layer 1 Hook (1 sentence): Pin to a SPECIFIC claim/number/sentence in the post. NOT a summary.
- Layer 2 Payload (1-3 sentences): Add ONE concrete mechanism, number, or experience the post didn't say. First person ("I", "we") is natural here.
- Layer 3 Hook-back (1 sentence): ONE specific question OR provocative observation. Never triple-choice. Never "from your perspective."
- Total: 3-5 sentences. Dense. Every word earns its place.

## ANTON'S VOICE RULES (mandatory)
- NO em dashes. Use commas, periods, colons, or "..."
- NO "from your perspective/side/view"
- NO triple-choice questions ("which X: A, B, or C?")
- NO Plexo mention
- NO 7+ sentence essays
- NO consultant English ("One might observe", "It is worth noting")
- NO perfect native-speaker polish — slightly non-native rhythm is a feature
- YES ellipsis for real pauses: "just a bit of controversy...", "and it just works... better than anything"
- YES first-person: "I think", "we see this", "curious if"
- YES short punchy closers: "Pain first, liquidity second, regulation third."
- Calibration ceiling (most polished): "slight pushback: OpenFX had traction before GENIUS. Regulation adds legitimacy and speed, but the initial pull came from a very real pain point: intercompany cross-border FX flows."
- Calibration floor (raw voice): "Just a bit of controversy... The traction of OpenFX has started before GENIUS popped out. It adds the legitimacy and speed up scaling, but do not power up it initially."
- Target: the space between. When in doubt, stay closer to the floor.

## TRUTH RULES
- Public fact + analysis: always safe. Use freely.
- Industry pattern: safe if widely known (UAT cycles, mobile money windows, weekend settlement gaps).
- Personal experience ("We've seen 3 PSPs...", "I talked to 4 banks"): ONLY if actually happened. If unsure, rephrase as public fact or industry pattern.
- Default to public facts and industry patterns. The comment can be personal without being fabricated.

## GATE CHECKS (run internally, do NOT show in output)
Before outputting, verify each draft passes ALL 6 gates:
G5 (Alive): at least 1 phone-voice marker (ellipsis/fragment/casual softener). Zero em dashes.
G6 (Truth): All claims are public facts or industry patterns. No invented experience.
G2 (Source Fidelity): Pins to THIS specific post. Would not fit a different post by same company.
G1 (Bullshit): Delete first sentence — comment still loses info. No restatement, no triple-choice, no jargon soup.
G3 (Value): at least 1 specific number/mechanism/named entity NOT in original post.
G4 (Interaction): Question specific enough that only someone with direct experience can answer. One path.

If a draft fails any gate, rewrite it before outputting. Never output a failing draft.

## DEADLY SINS (instant redraft)
Sin 1: All 3 drafts share the same skeleton
Sin 2: First sentence rephrases what the post already said
Sin 3: Triple-choice question "which X: A, B, or C?"
Sin 4: "From your perspective/side/view"
Sin 5: Zero "I" or "we" in the comment
Sin 6: Comment works equally well under a different post by same company
Sin 7: Abstract nouns that survive the "stuff" test
Sin 8: Fabricated experience claims

## OUTPUT FORMAT
Return ONLY valid JSON. No markdown, no preamble, no explanation.

{
  "drafts": [
    { "n": 1, "text": "..." },
    { "n": 2, "text": "..." },
    { "n": 3, "text": "..." }
  ],
  "source_used": "S3 or S4 or S3+S4",
  "substance_anchor": "one line: what specific fact/mechanism was added"
}
`.trim();

// ─── Build user prompt for one post ──────────────────────────────────────────
function buildPostPrompt(post) {
  const lines = [];
  lines.push("## POST TO COMMENT ON");
  if (post.authorName)  lines.push(`Author: ${post.authorName}`);
  if (post.authorTitle) lines.push(`Title: ${post.authorTitle}`);
  if (post.company)     lines.push(`Company: ${post.company}`);
  if (post.url)         lines.push(`URL: ${post.url}`);
  lines.push("");
  lines.push("Post text:");
  lines.push(post.text || "(no text)");
  lines.push("");
  lines.push("Now generate 3 comment drafts. Return only valid JSON as specified.");
  return lines.join("\n");
}

// ─── Call Claude API ──────────────────────────────────────────────────────────
async function generateComments(post) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await axios.post(
    ANTHROPIC_URL,
    {
      model:      MODEL,
      max_tokens: 1500,
      system:     COMMENT_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildPostPrompt(post) }
      ],
    },
    {
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 30_000,
    }
  );

  const raw = response.data?.content?.[0]?.text || "";

  // Strip markdown code fences if present
  const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON: ${clean.slice(0, 200)}`);
  }

  return parsed;
}

// ─── Relevance filter ─────────────────────────────────────────────────────────
const RELEVANCE_KEYWORDS = [
  "stablecoin", "usdc", "usdt", "crypto", "blockchain", "defi",
  "cross-border", "cross border", "remittance", "payment", "fintech",
  "settlement", "clearing", "swift", "correspondent", "banking",
  "fx", "foreign exchange", "cbdc", "regulation", "compliance",
  "africa", "latam", "sea", "gcc", "mena", "emea",
  "psp", "money transfer", "liquidity", "treasury",
];

function isRelevant(post) {
  const text = (post.text || "").toLowerCase();
  const strong = ["stablecoin", "usdc", "usdt", "cross-border", "cbdc", "swift"];
  if (strong.some(kw => text.includes(kw))) return true;
  const matches = RELEVANCE_KEYWORDS.filter(kw => text.includes(kw));
  return matches.length >= 2;
}

function isCommentable(post) {
  const text = (post.text || "").toLowerCase();
  if (/\bwe.re hiring\b|\bjoin our team\b|\bjob opening\b|\bapply now\b/i.test(text)) return false;
  if (/\bregister now\b|\brsvp\b|\bjoin us at\b/i.test(text) && text.length < 300) return false;
  if ((post.text || "").trim().length < 100) return false;
  return true;
}

// ─── POST /comments/generate ──────────────────────────────────────────────────
router.post("/generate", async (req, res) => {
  const post = req.body;
  if (!post?.text) {
    return res.status(400).json({ ok: false, error: "post.text required" });
  }

  try {
    const result = await generateComments(post);
    return res.json({
      ok:               true,
      postId:           post.id || null,
      postUrl:          post.url || null,
      author:           post.authorName || null,
      company:          post.company || null,
      drafts:           result.drafts,
      source_used:      result.source_used || "S4",
      substance_anchor: result.substance_anchor || null,
    });
  } catch (err) {
    console.error(`[comments/generate] error: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /comments/batch ─────────────────────────────────────────────────────
router.post("/batch", async (req, res) => {
  const { posts = [], maxCards = 7 } = req.body || {};

  if (!posts.length) {
    return res.status(400).json({ ok: false, error: "posts array required" });
  }

  const candidates = posts
    .filter(p => isRelevant(p) && isCommentable(p))
    .slice(0, maxCards);

  if (!candidates.length) {
    return res.json({ ok: true, total: 0, cards: [], message: "No relevant posts found after filtering" });
  }

  const cards  = [];
  const errors = [];

  for (const post of candidates) {
    try {
      const result = await generateComments(post);
      cards.push({
        postId:           post.id || null,
        postUrl:          post.url || null,
        postText:         (post.text || "").slice(0, 500),
        authorName:       post.authorName || "",
        authorTitle:      post.authorTitle || "",
        authorUrl:        post.authorUrl || "",
        company:          post.company || "",
        postedAt:         post.postedAt || null,
        drafts:           result.drafts,
        source_used:      result.source_used || "S4",
        substance_anchor: result.substance_anchor || null,
      });
    } catch (err) {
      console.error(`[comments/batch] failed for post ${post.id}: ${err.message}`);
      errors.push({ postId: post.id, error: err.message });
    }
  }

  return res.json({
    ok:           true,
    total:        cards.length,
    filtered:     posts.length - candidates.length,
    errors:       errors.length,
    cards,
    errorDetails: errors.length ? errors : undefined,
  });
});

module.exports = router;
