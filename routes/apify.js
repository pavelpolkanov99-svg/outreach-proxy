// routes/apify.js
//
// Apify LinkedIn scraping endpoints for the daily comment cron.
//
// POST /apify/linkedin-posts
//   Runs harvestapi/linkedin-post-search actor synchronously (waits for result).
//   Returns deduplicated posts array ready for comment generation.
//
// POST /apify/linkedin-reactions
//   Runs harvestapi/linkedin-post-reactions actor to check engagement on a
//   posted comment URL. Used in the 24h watch loop.

const express = require("express");
const axios   = require("axios");
const router  = express.Router();

const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const APIFY_BASE   = "https://api.apify.com/v2";

// Default search config — overridable per-request
const DEFAULT_QUERIES = [
  "stablecoins",
  "stablecoin settlement",
  "stablecoin clearing",
  "cross-border payments",
  "payment infrastructure",
  "fintech Africa",
  "CBDCs",
  "USDC",
  "USDT",
];

const DEFAULT_INDUSTRIES = [
  "Financial Services",
  "Fintech",
  "Bank",
  "Banking",
];

// ─── POST /apify/linkedin-posts ───────────────────────────────────────────────
// Body params (all optional — defaults used if omitted):
//   queries          string[]  — search keywords
//   maxPostsPerQuery number    — default 15
//   postedLimit      string    — "week" | "month" | "day" (default "week")
//   authorsIndustry  string[]  — industry filters
router.post("/linkedin-posts", async (req, res) => {
  if (!APIFY_TOKEN) {
    return res.status(500).json({ ok: false, error: "APIFY_TOKEN not set" });
  }

  const {
    queries          = DEFAULT_QUERIES,
    maxPostsPerQuery = 15,
    postedLimit      = "week",
    authorsIndustry  = DEFAULT_INDUSTRIES,
  } = req.body || {};

  const input = {
    searchQueries:      queries,
    maxPostsPerQuery:   maxPostsPerQuery,
    postedLimit:        postedLimit,
    sortBy:             "date",
    contentType:        "all",          // lowercase — Apify enum requirement
    authorsIndustryId:  authorsIndustry,
    profileScraperMode: "Short",
  };

  try {
    // Run the actor synchronously (waits until finished, up to 120s)
    const runRes = await axios.post(
      `${APIFY_BASE}/acts/harvestapi~linkedin-post-search/run-sync-get-dataset-items`,
      input,
      {
        params:  { token: APIFY_TOKEN },
        headers: { "Content-Type": "application/json" },
        timeout: 130_000,
      }
    );

    const raw = Array.isArray(runRes.data) ? runRes.data : [];

    // Deduplicate by post id — multiple queries can return the same post
    const seen  = new Set();
    const posts = [];
    for (const post of raw) {
      const id = post.id || post.postId || post.url;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      posts.push({
        id:          post.id || post.postId,
        url:         post.url || post.postUrl,
        text:        post.text || post.content || "",
        authorName:  post.authorName  || post.author?.name  || "",
        authorTitle: post.authorTitle || post.author?.title || "",
        authorUrl:   post.authorUrl   || post.author?.url   || "",
        company:     post.companyName || post.author?.company || "",
        postedAt:    post.postedAt || post.date || null,
        likes:       post.numLikes    || post.likes    || 0,
        comments:    post.numComments || post.comments || 0,
        reposts:     post.numReposts  || post.reposts  || 0,
      });
    }

    return res.json({ ok: true, total: posts.length, posts });

  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.message;
    console.error(`[apify] linkedin-posts error: ${msg}`);
    return res.status(502).json({ ok: false, error: msg, status });
  }
});

// ─── POST /apify/linkedin-reactions ──────────────────────────────────────────
// Body params:
//   postUrls            string[]  — LinkedIn post/comment URLs to check
//   maxReactionsPerPost number    — default 50
router.post("/linkedin-reactions", async (req, res) => {
  if (!APIFY_TOKEN) {
    return res.status(500).json({ ok: false, error: "APIFY_TOKEN not set" });
  }

  const {
    postUrls            = [],
    maxReactionsPerPost = 50,
  } = req.body || {};

  if (!postUrls.length) {
    return res.status(400).json({ ok: false, error: "postUrls array required" });
  }

  const input = {
    posts:              postUrls,
    maxReactionsPerPost,
    profileScraperMode: "Short",
  };

  try {
    const runRes = await axios.post(
      `${APIFY_BASE}/acts/harvestapi~linkedin-post-reactions/run-sync-get-dataset-items`,
      input,
      {
        params:  { token: APIFY_TOKEN },
        headers: { "Content-Type": "application/json" },
        timeout: 60_000,
      }
    );

    const raw = Array.isArray(runRes.data) ? runRes.data : [];
    return res.json({ ok: true, total: raw.length, reactions: raw });

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[apify] linkedin-reactions error: ${msg}`);
    return res.status(502).json({ ok: false, error: msg });
  }
});

module.exports = router;
