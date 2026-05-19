// routes/apify.js

const express = require("express");
const axios   = require("axios");
const router  = express.Router();

const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const APIFY_BASE   = "https://api.apify.com/v2";

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

// Build LinkedIn post URL from post id if no direct URL field available
function buildLinkedInUrl(post) {
  // Try all known URL fields first
  const direct = post.url || post.postUrl || post.link || post.postLink
    || post.shareUrl || post.permalinkUrl || post.post_url;
  if (direct) return direct;

  // Construct from id — LinkedIn activity URL format
  const id = post.id || post.postId || post.activityId;
  if (id) return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;

  return null;
}

// ─── POST /apify/linkedin-posts ───────────────────────────────────────────────
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
    contentType:        "all",
    authorsIndustryId:  authorsIndustry,
    profileScraperMode: "short",
  };

  try {
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

    // Log first post keys to help debug field names
    if (raw.length > 0) {
      console.log("[apify] first post keys:", Object.keys(raw[0]).join(", "));
      console.log("[apify] first post sample:", JSON.stringify({
        id: raw[0].id,
        postId: raw[0].postId,
        url: raw[0].url,
        postUrl: raw[0].postUrl,
        link: raw[0].link,
        shareUrl: raw[0].shareUrl,
        permalinkUrl: raw[0].permalinkUrl,
        authorName: raw[0].authorName,
        author: raw[0].author,
      }));
    }

    const seen  = new Set();
    const posts = [];
    for (const post of raw) {
      const id = post.id || post.postId || post.activityId;
      const dedupeKey = id || post.url || post.postUrl;
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const url = buildLinkedInUrl(post);

      posts.push({
        id:          id || null,
        url,
        text:        post.text || post.content || post.description || "",
        authorName:  post.authorName  || post.author?.name  || post.profileName || "",
        authorTitle: post.authorTitle || post.author?.title || post.profileTitle || "",
        authorUrl:   post.authorUrl   || post.author?.url   || post.profileUrl  || "",
        company:     post.companyName || post.author?.company || post.company || "",
        postedAt:    post.postedAt || post.date || post.timestamp || null,
        likes:       post.numLikes    || post.likes    || post.likesCount    || 0,
        comments:    post.numComments || post.comments || post.commentsCount || 0,
        reposts:     post.numReposts  || post.reposts  || post.repostsCount  || 0,
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
    profileScraperMode: "short",
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
