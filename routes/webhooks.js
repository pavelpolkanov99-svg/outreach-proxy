const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  NOTION_COMPANIES_DB,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

// ── POST /webhook/heyreach ────────────────────────────────────────────────────
router.post("/heyreach", async (req, res) => {
  res.json({ ok: true });
  const { eventType, lead, campaignId } = req.body || {};
  if (!eventType || !lead) return;
  const company = lead.companyName;
  if (!company) return;
  console.log(`[webhook] ${eventType} — ${lead.firstName} ${lead.lastName} @ ${company}`);
  try {
    const newStatus = (eventType === "CONNECTION_REQUEST_ACCEPTED" || eventType === "MESSAGE_REPLY_RECEIVED")
      ? "Initial Discussion" : null;
    if (!newStatus || !NOTION_TOKEN) return;
    const search = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
      { filter: { property: "Company name", title: { equals: company } }, page_size: 1 },
      { headers: notionHeaders() }
    );
    if (search.data.results.length === 0) return;
    const pageId = search.data.results[0].id;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Stage": { status: { name: newStatus } } } }, { headers: notionHeaders() });
    const note = eventType === "CONNECTION_REQUEST_ACCEPTED"
      ? `✅ Connection accepted by ${lead.firstName} ${lead.lastName} (Campaign ID: ${campaignId})`
      : `💬 Reply received from ${lead.firstName} ${lead.lastName} (Campaign ID: ${campaignId})`;
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties: { "Notes": { rich_text: [{ text: { content: note } }] } } }, { headers: notionHeaders() });
    console.log(`[webhook] Notion updated: ${company} → ${newStatus}`);
  } catch (err) {
    console.error("[webhook] Notion update failed:", err.response?.data?.message || err.message);
  }
});

module.exports = router;
