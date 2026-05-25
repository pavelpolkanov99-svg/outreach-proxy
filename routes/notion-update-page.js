const express = require("express");
const axios   = require("axios");
const { NOTION_TOKEN, notionHeaders } = require("../lib/notion");

const router = express.Router();

// ── POST /notion/update-page-props ────────────────────────────────────────────
// Updates rich_text and select properties on ANY Notion page by pageId.
// Body: { pageId, props: { "FieldName": "text value" } }
// Also supports: { pageId, props: { "Field": { type: "select", name: "val" } } }
router.post("/update-page-props", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });
  const { pageId, props } = req.body || {};
  if (!pageId) return res.status(400).json({ error: "pageId required" });
  if (!props || typeof props !== "object" || !Object.keys(props).length) {
    return res.status(400).json({ error: "props object required" });
  }
  try {
    const notionProps = {};
    for (const [key, val] of Object.entries(props)) {
      if (typeof val === "string") {
        notionProps[key] = { rich_text: [{ text: { content: val.slice(0, 2000) } }] };
      } else if (val && typeof val === "object" && val.type === "select") {
        notionProps[key] = { select: { name: val.name } };
      } else if (val && typeof val === "object" && val.type === "multi_select") {
        notionProps[key] = { multi_select: (val.values || []).map(v => ({ name: v })) };
      }
    }
    if (!Object.keys(notionProps).length) {
      return res.status(400).json({ error: "No valid props to update" });
    }
    await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: notionProps },
      { headers: notionHeaders() }
    );
    res.json({ ok: true, pageId, updated: Object.keys(notionProps) });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

module.exports = router;
