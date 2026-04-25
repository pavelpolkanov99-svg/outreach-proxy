const express = require("express");
const axios   = require("axios");
const {
  HEYREACH_API,
  DEFAULT_LINKEDIN_ACCOUNT_ID,
  heyreachHeaders,
} = require("../lib/heyreach");
const { PLEXO_PRESETS } = require("../lib/presets");

const router = express.Router();

// ══════════════════════════════════════════════════════════════════════════════
// Generic proxy — POST /heyreach/proxy { hrKey, path, payload }
// ══════════════════════════════════════════════════════════════════════════════
router.post("/proxy", async (req, res) => {
  const { hrKey, path, payload } = req.body;
  if (!hrKey || !path) return res.status(400).json({ error: "hrKey and path required" });
  try {
    const r = await axios.post(
      `https://api.heyreach.io/api/public${path}`,
      payload || {},
      { headers: { "X-API-KEY": hrKey, "Content-Type": "application/json" }, timeout: 20000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// HEYREACH CAMPAIGN API (confirmed working Apr 24, 2026)
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /heyreach/list/create — create empty lead list ───────────────────────
router.post("/list/create", async (req, res) => {
  const { hrKey, name, type = "USER_LIST" } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const r = await axios.post(
      `${HEYREACH_API}/list/CreateEmptyList`,
      { name, type },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({
      ok: true,
      listId: r.data?.id,
      name: r.data?.name,
      type: r.data?.listType,
      raw: r.data,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/create — create campaign linked to a list ─────────
router.post("/campaign/create", async (req, res) => {
  const {
    hrKey,
    name,
    linkedInUserListId,
    linkedInAccountIds = [DEFAULT_LINKEDIN_ACCOUNT_ID],
  } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!name || !linkedInUserListId) {
    return res.status(400).json({ error: "name and linkedInUserListId required" });
  }
  try {
    const r = await axios.post(
      `${HEYREACH_API}/campaign/Create`,
      { name, linkedInUserListId, linkedInAccountIds },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({
      ok: true,
      campaignId: r.data?.campaignId,
      name,
      linkedInUserListId,
      linkedInAccountIds,
      status: "DRAFT",
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaigns/list — list all campaigns ────────────────────────
router.post("/campaigns/list", async (req, res) => {
  const { hrKey, offset = 0, limit = 50 } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  try {
    const r = await axios.post(
      `${HEYREACH_API}/campaign/GetAll`,
      { offset, limit },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    const items = r.data?.items || [];
    res.json({
      ok: true,
      total: r.data?.totalCount || 0,
      campaigns: items.map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        listId: c.linkedInUserListId,
        listName: c.linkedInUserListName,
        accountIds: c.campaignAccountIds,
        createdAt: c.creationTime,
        startedAt: c.startedAt,
        stats: c.progressStats,
      })),
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/create-with-list ─────────────────────────────────
router.post("/campaign/create-with-list", async (req, res) => {
  const {
    hrKey,
    campaignName,
    listName,
    linkedInAccountIds = [DEFAULT_LINKEDIN_ACCOUNT_ID],
  } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignName) return res.status(400).json({ error: "campaignName required" });

  const finalListName = listName || `${campaignName} — leads`;
  try {
    const listResp = await axios.post(
      `${HEYREACH_API}/list/CreateEmptyList`,
      { name: finalListName, type: "USER_LIST" },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    const listId = listResp.data?.id;
    if (!listId) return res.status(500).json({ error: "List creation returned no id", raw: listResp.data });

    const campResp = await axios.post(
      `${HEYREACH_API}/campaign/Create`,
      { name: campaignName, linkedInUserListId: listId, linkedInAccountIds },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({
      ok: true,
      campaignId: campResp.data?.campaignId,
      listId,
      campaignName,
      listName: finalListName,
      linkedInAccountIds,
      status: "DRAFT",
      nextStep: `Add leads via HeyReach public API /lead/AddLeadsToCampaignV2 with campaignId=${campResp.data?.campaignId}`,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Sequence / Schedule / Accounts / Start / Pause
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /heyreach/campaign/update-sequence ───────────────────────────────────
router.post("/campaign/update-sequence", async (req, res) => {
  const { hrKey, campaignId, preset, customMessages, sequence } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  let finalSequence;
  if (sequence) {
    finalSequence = sequence;
  } else if (preset) {
    if (!PLEXO_PRESETS[preset]) {
      return res.status(400).json({
        error: `Unknown preset: ${preset}. Valid: ${Object.keys(PLEXO_PRESETS).join(", ")}`,
      });
    }
    finalSequence = PLEXO_PRESETS[preset](customMessages || {});
  } else {
    return res.status(400).json({ error: "Either preset or sequence required" });
  }

  try {
    await axios.post(
      `${HEYREACH_API}/campaign/UpdateSequence`,
      { campaignId, sequence: finalSequence },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({
      ok: true,
      campaignId,
      preset: preset || "custom",
      customMessagesApplied: customMessages ? Object.keys(customMessages) : [],
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── GET /heyreach/campaign/get-sequence ───────────────────────────────────────
router.get("/campaign/get-sequence", async (req, res) => {
  const hrKey = req.query.hrKey || req.headers["x-api-key"];
  const { campaignId } = req.query;
  if (!hrKey) return res.status(400).json({ error: "hrKey required (query or X-API-KEY header)" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });
  try {
    const r = await axios.get(
      `${HEYREACH_API}/campaign/GetCampaignSequence?campaignId=${campaignId}`,
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, campaignId, sequence: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/update-schedule ───────────────────────────────────
router.post("/campaign/update-schedule", async (req, res) => {
  const { hrKey, campaignId, schedule } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const defaultSchedule = {
    dailyStartTime: "09:00:00",
    dailyEndTime:   "17:00:00",
    timeZoneId:     "Europe/Tallinn",
    enabledMonday:    true,
    enabledTuesday:   true,
    enabledWednesday: true,
    enabledThursday:  true,
    enabledFriday:    true,
    enabledSaturday:  false,
    enabledSunday:    false,
  };
  const finalSchedule = { ...defaultSchedule, ...(schedule || {}) };

  try {
    await axios.post(
      `${HEYREACH_API}/campaign/UpdateSchedule`,
      { campaignId, schedule: finalSchedule },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, campaignId, schedule: finalSchedule });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/update-accounts ───────────────────────────────────
router.post("/campaign/update-accounts", async (req, res) => {
  const {
    hrKey,
    campaignId,
    linkedInAccountIds = [DEFAULT_LINKEDIN_ACCOUNT_ID],
  } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });
  try {
    await axios.post(
      `${HEYREACH_API}/campaign/UpdateAccounts`,
      { campaignId, linkedInAccountIds },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, campaignId, linkedInAccountIds });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/start — activate DRAFT (Resume) ───────────────────
router.post("/campaign/start", async (req, res) => {
  const { hrKey, campaignId } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });
  try {
    const r = await axios.post(
      `${HEYREACH_API}/campaign/Resume`,
      { campaignId },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, campaignId, result: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/pause ─────────────────────────────────────────────
router.post("/campaign/pause", async (req, res) => {
  const { hrKey, campaignId } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });
  try {
    const r = await axios.post(
      `${HEYREACH_API}/campaign/Pause`,
      { campaignId },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, campaignId, result: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/campaign/delete ────────────────────────────────────────────
// Permanently deletes a campaign (and removes leads from it). Cannot be undone.
router.post("/campaign/delete", async (req, res) => {
  const { hrKey, campaignId } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });
  try {
    const r = await axios.delete(
      `${HEYREACH_API}/campaign/Delete?campaignId=${campaignId}`,
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, campaignId, result: r.data || "deleted" });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /heyreach/list/delete ────────────────────────────────────────────────
// Permanently deletes a lead list. Cannot be undone.
router.post("/list/delete", async (req, res) => {
  const { hrKey, listId } = req.body;
  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!listId) return res.status(400).json({ error: "listId required" });
  try {
    const r = await axios.delete(
      `${HEYREACH_API}/list/DeleteList?listId=${listId}`,
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    res.json({ ok: true, listId, result: r.data || "deleted" });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ⭐ POST /heyreach/campaign/create-full — ONE-SHOT end-to-end
//    list + campaign + sequence + schedule + optional start
//
// IMPORTANT: customMessages must be a plain object (e.g. {note, followup1, ...}).
// If using this via MCP, the MCP tool schema must declare customMessages as an
// explicit z.object — z.any() drops the value somewhere in Streamable HTTP transit.
// See lib/mcp.js for the canonical schema.
// ══════════════════════════════════════════════════════════════════════════════
router.post("/campaign/create-full", async (req, res) => {
  const {
    hrKey,
    campaignName,
    listName,
    preset = "connect_note",
    customMessages,
    sequence: customSequence,
    linkedInAccountIds = [DEFAULT_LINKEDIN_ACCOUNT_ID],
    schedule,
    startImmediately = false,
  } = req.body;

  if (!hrKey) return res.status(400).json({ error: "hrKey required" });
  if (!campaignName) return res.status(400).json({ error: "campaignName required" });

  // Defensive log: surface what arrived so future debugging in Railway logs
  // doesn't require code changes.
  console.log("[heyreach/campaign/create-full] input:", JSON.stringify({
    campaignName,
    preset,
    customMessagesKeys: customMessages ? Object.keys(customMessages) : [],
    hasCustomSequence: !!customSequence,
    startImmediately,
  }));

  const finalListName = listName || `${campaignName} — leads`;
  const result = { ok: true, campaignName };

  try {
    // Step 1: Create list
    const listResp = await axios.post(
      `${HEYREACH_API}/list/CreateEmptyList`,
      { name: finalListName, type: "USER_LIST" },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    result.listId   = listResp.data?.id;
    result.listName = finalListName;
    if (!result.listId) throw new Error("List creation returned no id");

    // Step 2: Create campaign
    const campResp = await axios.post(
      `${HEYREACH_API}/campaign/Create`,
      {
        name: campaignName,
        linkedInUserListId: result.listId,
        linkedInAccountIds,
      },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    result.campaignId          = campResp.data?.campaignId;
    result.linkedInAccountIds  = linkedInAccountIds;
    if (!result.campaignId) throw new Error("Campaign creation returned no id");

    // Step 3: Resolve sequence
    let finalSequence;
    if (customSequence) {
      finalSequence = customSequence;
      result.preset = "custom";
    } else {
      if (!PLEXO_PRESETS[preset]) {
        throw new Error(
          `Unknown preset: ${preset}. Valid: ${Object.keys(PLEXO_PRESETS).join(", ")}`
        );
      }
      finalSequence = PLEXO_PRESETS[preset](customMessages || {});
      result.preset = preset;
    }

    // Surface what was applied — caller can verify w/o another API round-trip.
    result.customMessagesApplied = customMessages ? Object.keys(customMessages) : [];

    // Step 4: Upload sequence
    await axios.post(
      `${HEYREACH_API}/campaign/UpdateSequence`,
      { campaignId: result.campaignId, sequence: finalSequence },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    result.sequenceUploaded = true;

    // Step 5: Apply schedule
    const defaultSchedule = {
      dailyStartTime: "09:00:00",
      dailyEndTime:   "17:00:00",
      timeZoneId:     "Europe/Tallinn",
      enabledMonday:    true,
      enabledTuesday:   true,
      enabledWednesday: true,
      enabledThursday:  true,
      enabledFriday:    true,
      enabledSaturday:  false,
      enabledSunday:    false,
    };
    const finalSchedule = { ...defaultSchedule, ...(schedule || {}) };
    await axios.post(
      `${HEYREACH_API}/campaign/UpdateSchedule`,
      { campaignId: result.campaignId, schedule: finalSchedule },
      { headers: heyreachHeaders(hrKey), timeout: 15000 }
    );
    result.schedule = finalSchedule;

    // Step 6: Optionally start
    if (startImmediately) {
      await axios.post(
        `${HEYREACH_API}/campaign/Resume`,
        { campaignId: result.campaignId },
        { headers: heyreachHeaders(hrKey), timeout: 15000 }
      );
      result.status = "IN_PROGRESS";
    } else {
      result.status = "DRAFT";
    }

    result.nextStep = result.status === "DRAFT"
      ? `Add leads via /lead/AddLeadsToCampaignV2 with campaignId=${result.campaignId}, then POST /heyreach/campaign/start to activate`
      : `Campaign is live. Add leads via /lead/AddLeadsToCampaignV2 with campaignId=${result.campaignId}`;

    res.json(result);
  } catch (err) {
    result.ok    = false;
    result.error = err.response?.data || err.message;
    result.failedAt = result.sequenceUploaded
      ? "schedule_or_start"
      : result.campaignId
      ? "sequence_upload"
      : result.listId
      ? "campaign_create"
      : "list_create";
    res.status(err.response?.status || 500).json(result);
  }
});

module.exports = router;
