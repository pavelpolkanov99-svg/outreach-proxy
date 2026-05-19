// routes/comments.js

const express  = require("express");
const axios    = require("axios");
const router   = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = "https://api.anthropic.com/v1/messages";
const MODEL             = "claude-sonnet-4-5";

const MAX_COMMENT_CHARS = 300;

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

const COMMENT_SYSTEM_PROMPT = `
You are generating LinkedIn comment drafts for Anton Titov, CEO of a stablecoin clearing company.
Anton's voice: fast, concrete, slightly imperfect, opinionated. Like a founder who typed from a phone because the point mattered.

Your task: given one LinkedIn post, produce exactly 3 comment drafts using 3 different strategies.

CRITICAL LENGTH CONSTRAINT: Each comment draft MUST be 300 characters or fewer (including spaces and punctuation). This is a hard limit. Count carefully before outputting.

## PLEXO OPERATOR CONTEXT (S4 — use as framing, NEVER promote by name)
${PLEXO_S4}

## THREE STRATEGIES (internal labels — do NOT show in output)
Draft 1 — Pushback/Contradiction: respectfully disagree with one specific claim. Give a concrete reason. End with one sharp question.
Draft 2 — Mechanism/Value-add: agree with direction but add one specific mechanism, number, or pattern not in the post.
Draft 3 — Question/Discovery: open with a reframe of the post's claim, ask one specific question only someone with direct experience can answer.

## ANATOMY OF A GOOD COMMENT (all 3 drafts must follow)
- Hook (1 sentence): Pin to a SPECIFIC claim in the post.
- Payload (1-2 sentences): Add ONE concrete mechanism or number not in the post.
- Close (1 sentence): ONE specific question. Never triple-choice.
- Total: 2-3 sentences MAX. Every word earns its place. Stay under 300 chars.

## ANTON'S VOICE RULES (mandatory)
- NO em dashes. Use commas, periods, colons.
- NO "from your perspective/side/view"
- NO triple-choice questions ("which X: A, B, or C?")
- NO Plexo mention
- NO consultant English
- YES first-person: "I think", "we see this", "curious if"
- YES short punchy closers

## GATE CHECKS (run internally, do NOT show in output)
G5 (Alive): at least 1 phone-voice marker. Zero em dashes.
G6 (Truth): All claims are public facts or industry patterns.
G1 (Bullshit): No restatement, no triple-choice, no jargon soup.
G3 (Value): at least 1 specific number/mechanism NOT in original post.
G4 (Length): Each draft is 300 characters or fewer. Count before outputting.

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
  lines.push(`Generate 3 comment drafts. Each must be ${MAX_COMMENT_CHARS} characters or fewer. Return only valid JSON.`);
  return lines.join("\n");
}

async function generateComments(post) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await axios.post(
    ANTHROPIC_URL,
    {
      model:      MODEL,
      max_tokens: 1000,
      system:     COMMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPostPrompt(post) }],
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

  const raw   = response.data?.content?.[0]?.text || "";
  const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON: ${clean.slice(0, 200)}`);
  }

  // Hard truncation failsafe — never exceed MAX_COMMENT_CHARS
  if (Array.isArray(parsed.drafts)) {
    parsed.drafts = parsed.drafts.map(d => ({
      ...d,
      text: typeof d.text === "string" && d.text.length > MAX_COMMENT_CHARS
        ? d.text.slice(0, MAX_COMMENT_CHARS - 1).trimEnd() + "…"
        : d.text,
    }));
  }

  return parsed;
}

const RELEVANCE_KEYWORDS = [
  "stablecoin", "usdc", "usdt", "crypto", "blockchain", "defi",
  "cross-border", "cross border", "remittance", "payment", "fintech",
  "settlement", "clearing", "swift", "correspondent", "banking",
  "fx", "foreign exchange", "cbdc", "regulation", "compliance",
  "africa", "latam", "sea", "gcc", "mena", "emea",
  "psp", "money transfer", "liquidity", "treasury",
];

function isRelevant(post) {
  const text   = (post.text || "").toLowerCase();
  const strong = ["stablecoin", "usdc", "usdt", "cross-border", "cbdc", "swift"];
  if (strong.some(kw => text.includes(kw))) return true;
  return RELEVANCE_KEYWORDS.filter(kw => text.includes(kw)).length >= 2;
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
  const body     = req.body || {};
  const posts    = Array.isArray(body) ? body : (body.posts || []);
  const maxCards = body.maxCards || 7;

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
