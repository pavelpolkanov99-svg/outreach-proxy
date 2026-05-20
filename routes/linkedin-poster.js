// routes/linkedin-poster.js
// Proxies comment posting requests to the linkedin-poster Railway service

const express = require("express");
const axios   = require("axios");
const router  = express.Router();

const POSTER_URL = process.env.LINKEDIN_POSTER_URL; // e.g. https://linkedin-poster-xxx.up.railway.app

// POST /linkedin/comment
// Body: { postUrl, commentText }
router.post("/comment", async (req, res) => {
  if (!POSTER_URL) {
    return res.status(503).json({
      ok: false,
      error: "LINKEDIN_POSTER_URL not configured — linkedin-poster service not set up",
    });
  }

  const { postUrl, commentText } = req.body || {};
  if (!postUrl)     return res.status(400).json({ ok: false, error: "postUrl required" });
  if (!commentText) return res.status(400).json({ ok: false, error: "commentText required" });

  try {
    console.log(`[linkedin-poster] proxying comment to ${POSTER_URL}`);
    const r = await axios.post(
      `${POSTER_URL}/linkedin/comment`,
      { postUrl, commentText },
      { timeout: 60_000 }
    );
    return res.json(r.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    console.error(`[linkedin-poster] proxy error: ${msg}`);
    return res.status(err.response?.status || 502).json({ ok: false, error: msg });
  }
});

module.exports = router;
