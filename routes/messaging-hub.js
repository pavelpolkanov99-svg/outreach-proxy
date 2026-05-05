const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  notionHeaders,
} = require("../lib/notion");

const router = express.Router();

const MESSAGES_HUB_DB     = "8617a441c4254b41be671a1e65946a03";
const NOTION_COMPANIES_DB = "f9b59c5b05fa4df18f9569479633fd74";
const NOTION_PEOPLE_DB    = "f36b2a0f0ab241cebbdbd1d0874a55be";

// Internal sender heuristics — same regex used in beeper/replies-waiting
const INTERNAL_SENDER_REGEX = /(anton ceo|antón|^антон$|^pavel|polkanov|@pavel-remide:beeper\.com|titov|anton t)/i;

function isInternalSenderText(s) {
  if (!s) return false;
  return INTERNAL_SENDER_REGEX.test(s);
}

function hubRowIsOutbound(props) {
  const rawSender = (props["Raw Sender Name"]?.rich_text || [])
    .map(rt => rt.plain_text || rt.text?.content || "").join("");
  if (rawSender) return isInternalSenderText(rawSender);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deeplink helpers (v3.18.5) — same logic as routes/yesterday.js & beeper.js.
// Resolves Notion People row → contacts → native chat URL.
// ─────────────────────────────────────────────────────────────────────────────

function extractPersonContacts(personPage) {
  if (!personPage) return null;
  const props = personPage.properties || {};

  let telegram = null;
  const tgArr = props["Telegram"]?.rich_text || [];
  const tgRaw = tgArr.map(t => t.plain_text || t.text?.content || "").join("").trim();
  if (tgRaw) {
    const cleaned = tgRaw.replace(/^@/, "").trim();
    if (/^[a-zA-Z0-9_]{4,32}$/.test(cleaned)) telegram = cleaned;
  }

  let phone = null;
  const phoneRaw = props["Phone"]?.phone_number;
  if (phoneRaw) {
    const digits = String(phoneRaw).replace(/[^\d]/g, "");
    if (digits.length >= 7 && digits.length <= 15) phone = digits;
  }

  let linkedin = props["LinkedIn"]?.url || null;
  if (linkedin && !/^https?:\/\//i.test(linkedin)) {
    linkedin = `https://${linkedin}`;
  }

  if (!telegram && !phone && !linkedin) return null;
  return { telegram, phone, linkedin };
}

function buildChatDeeplink(networkFull, contacts) {
  if (!contacts) return null;

  if (networkFull === "WhatsApp" && contacts.phone) {
    return { url: `https://wa.me/${contacts.phone}`, label: "wa.me" };
  }
  if (networkFull === "Telegram" && contacts.telegram) {
    return { url: `https://t.me/${contacts.telegram}`, label: "t.me" };
  }
  if (networkFull === "LinkedIn" && contacts.linkedin) {
    return { url: contacts.linkedin, label: "linkedin" };
  }
  return null;
}

// Resolve linked company. Now ALSO pulls first attached person's contacts
// so bot can render clickable deeplink. Best-effort — silent on errors.
async function resolveLinkedCompany(relationArr) {
  if (!Array.isArray(relationArr) || relationArr.length === 0) return null;
  const id = relationArr[0]?.id;
  if (!id) return null;
  try {
    const r = await axios.get(`https://api.notion.com/v1/pages/${id}`, {
      headers: notionHeaders(),
      timeout: 4000,
    });
    const props = r.data.properties || {};
    const titleArr = props["Company name"]?.title || [];
    const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");
    const stage = props["Stage"]?.status?.name || null;
    const bdScore = props["BD Score"]?.number ?? null;
    const priority = props["Priority"]?.select?.name || null;

    // NEW v3.18.5: pull first attached person's contacts
    let personContacts = null;
    const peopleRel = props["People"]?.relation || [];
    if (peopleRel.length > 0) {
      try {
        const personRes = await axios.get(
          `https://api.notion.com/v1/pages/${peopleRel[0].id}`,
          { headers: notionHeaders(), timeout: 4000 }
        );
        personContacts = extractPersonContacts(personRes.data);
      } catch (_) { /* swallow */ }
    }

    return { name: name || null, stage, bdScore, priority, personContacts };
  } catch (_) {
    return null;
  }
}

// NEW v3.18.5: also try Hub's "Link: People" relation directly. The Hub schema
// has both "Link: Companies" AND "Link: People" — for LinkedIn DM rows the
// person is linked directly. Use this BEFORE falling back to company.People[0].
async function resolveLinkedPerson(relationArr) {
  if (!Array.isArray(relationArr) || relationArr.length === 0) return null;
  const id = relationArr[0]?.id;
  if (!id) return null;
  try {
    const r = await axios.get(`https://api.notion.com/v1/pages/${id}`, {
      headers: notionHeaders(),
      timeout: 4000,
    });
    return extractPersonContacts(r.data);
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /messaging-hub/replies-waiting (v3.18.5 — adds deeplinks)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/replies-waiting", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN not set" });

  const days  = Math.max(1, Math.min(30, parseInt(req.query.days,  10) || 7));
  const limit = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 15));
  const hoursIdle = Math.max(0.5, Math.min(168, parseFloat(req.query.hoursIdle) || 4));

  const cutoffISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const idleCutoffMs = Date.now() - hoursIdle * 60 * 60 * 1000;

  try {
    const filter = {
      and: [
        { property: "Status", status: { equals: "Active" } },
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: cutoffISO },
        },
      ],
    };

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${MESSAGES_HUB_DB}/query`,
      {
        filter,
        sorts: [
          { timestamp: "last_edited_time", direction: "descending" },
        ],
        page_size: Math.min(limit * 3, 60),
      },
      { headers: notionHeaders(), timeout: 10_000 }
    );

    const candidates = r.data.results.map(page => {
      const props = page.properties || {};
      const titleArr = props["Chat Name"]?.title || [];
      const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

      const lastMsgArr = props["Last Message"]?.rich_text || [];
      const lastMsgText = lastMsgArr.map(rt => rt.plain_text || rt.text?.content || "").join("").slice(0, 300);

      const networkArr = props["Network"]?.multi_select || [];
      const networkFull = networkArr[0]?.name || null;

      const participantsArr = props["Participants"]?.rich_text || [];
      const participants = participantsArr.map(rt => rt.plain_text || rt.text?.content || "").join("");

      const linkedCompaniesRel = props["Link: Companies"]?.relation || [];
      const linkedPeopleRel    = props["Link: People"]?.relation    || [];

      const lastEditedTime = page.last_edited_time;
      const lastActiveDate = props["Last Active"]?.date?.start || null;
      const effectiveTime = lastActiveDate || lastEditedTime;

      return {
        pageId: page.id,
        name,
        networkFull,
        lastMsgText,
        lastMsgSender: participants,
        participants,
        lastMsgTime: effectiveTime,
        outbound: hubRowIsOutbound(props),
        linkedCompaniesRel,
        linkedPeopleRel,
      };
    });

    const filtered = candidates.filter(c => {
      if (c.outbound) return false;
      if (!c.lastMsgText || !c.lastMsgText.trim()) return false;
      if (!c.lastMsgTime) return false;
      const ts = Date.parse(c.lastMsgTime);
      if (isNaN(ts)) return false;
      if (ts > idleCutoffMs) return false;
      if (/(remide\s*\|.*advisor|plexo\s*\|.*advisor|beeper developer|remide team|plexo team)/i.test(c.name)) return false;
      return true;
    });

    filtered.sort((a, b) => Date.parse(a.lastMsgTime) - Date.parse(b.lastMsgTime));

    const top = filtered.slice(0, limit);

    const enriched = await Promise.all(top.map(async c => {
      // Resolve company AND person in parallel
      const [company, personContacts] = await Promise.all([
        resolveLinkedCompany(c.linkedCompaniesRel),
        resolveLinkedPerson(c.linkedPeopleRel),
      ]);

      const idleMs = Date.now() - Date.parse(c.lastMsgTime);
      const hoursIdleVal = Math.round(idleMs / (60 * 60 * 1000) * 10) / 10;
      const visualTier = company ? "primary" : "secondary";

      // Deeplink priority: linked-person contacts → company's first-person contacts
      const contacts = personContacts || company?.personContacts || null;
      const deeplinkObj = buildChatDeeplink(c.networkFull, contacts);

      return {
        pageId: c.pageId,
        name: c.name,
        networkFull: c.networkFull,
        lastMsgText: c.lastMsgText,
        lastMsgSender: c.lastMsgSender,
        lastMsgTime: c.lastMsgTime,
        hoursIdle: hoursIdleVal,
        notion: company,
        visualTier,
        type: "single",
        deeplink: deeplinkObj?.url || null,
        deeplinkLabel: deeplinkObj?.label || null,
      };
    }));

    const deeplinkCount = enriched.filter(e => e.deeplink).length;
    console.log(`[messaging-hub/replies-waiting] returned ${enriched.length} replies, ${deeplinkCount} with deeplinks`);

    res.json({
      ok: true,
      source: "messaging-hub",
      hoursIdle,
      cutoffISO,
      total: enriched.length,
      replies: enriched,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

module.exports = router;
