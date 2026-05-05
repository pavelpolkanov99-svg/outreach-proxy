const express = require("express");
const axios   = require("axios");
const {
  NOTION_TOKEN,
  notionHeaders,
} = require("../lib/notion");
const {
  BEEPER_URL,
  BEEPER_TOKEN,
  beeperHeaders,
  networkFromAccountID,
  beeperGetMessages,
} = require("../lib/beeper");

const router = express.Router();

const MESSAGES_HUB_DB     = "8617a441c4254b41be671a1e65946a03";
const NOTION_COMPANIES_DB = "f9b59c5b05fa4df18f9569479633fd74";
const NOTION_PEOPLE_DB    = "f36b2a0f0ab241cebbdbd1d0874a55be";
const ANTHROPIC_KEY       = process.env.ANTHROPIC_API_KEY;

const LATE_STAGES = new Set([
  "initial discussions",
  "Keeping in the Loop",
  "Warm discussions",
  "Negotiations",
  "Call Scheduled",
]);

const STAGE_RANK = {
  "Negotiations": 5,
  "Call Scheduled": 4,
  "Warm discussions": 3,
  "Keeping in the Loop": 2,
  "initial discussions": 1,
};

const WA_ACCOUNT_PHONE = {
  "Htp4o51CAhE8_SXbpXCKofjvn1Y": "+420777225067",
  "ehMYU4KFPp6AAcwfsxn5Pt1jhV4": "+420774576161",
};

function groupKey(accountID, networkFull) {
  if (!accountID) return networkFull || "Unknown";
  if (networkFull === "WhatsApp") {
    for (const [token] of Object.entries(WA_ACCOUNT_PHONE)) {
      if (accountID.includes(token)) {
        return `WhatsApp:${WA_ACCOUNT_PHONE[token]}`;
      }
    }
  }
  return networkFull || "Unknown";
}

function groupKeyToHeader(key) {
  if (key.startsWith("WhatsApp:")) {
    const phone = key.split(":")[1];
    return `WhatsApp (${phone})`;
  }
  return key;
}

const SKIP_CHAT_NAME_REGEX = /(rocket tech school|frontforumfocus|world impact|africa stablecoin community|deals global investment|beeper developer|blockchain.*tech news|latam venture talks|дедушка)/i;
const INTERNAL_SENDER_REGEX = /(anton ceo|antón|^антон$|^pavel|polkanov|@pavel-remide:beeper\.com|titov|anton t)/i;

function isInternalSender(s) {
  if (!s) return false;
  return INTERNAL_SENDER_REGEX.test(s);
}

function isLowSignalInbound(text) {
  if (!text || !text.trim()) return true;
  const t = text.trim();
  if (/^incoming call\./i.test(t)) return true;
  if (t.length < 10 && /^[\s\p{Emoji}\p{P}ok thanks thx]+$/iu.test(t)) return true;
  if (/^[\s\p{Emoji}\p{P}]+$/u.test(t)) return true;
  return false;
}

const GENERIC_SEED_WORDS = new Set([
  "world", "global", "international", "africa", "latam", "asia", "europe",
  "the", "a", "an",
  "blockchain", "crypto", "fintech", "tech", "ai",
  "venture", "ventures", "capital", "startup", "startups",
  "community", "group", "forum", "initiatives", "network",
  "news", "feed", "channel",
  "intl", "i18n",
]);

function extractLookupCandidate(chatName) {
  if (!chatName) return null;
  let s = String(chatName).trim();

  const sepMatch = s.match(/\s*[|—–-]\s*(.+)$/);
  if (sepMatch && sepMatch[1].trim().length >= 3) {
    s = sepMatch[1].trim();
  }

  s = s.replace(/^Plexo\s*[<>x×|]+\s*/i, "").trim();

  const candidate = s.split(/\s+/)[0];
  if (!candidate || candidate.length < 3) return null;
  if (GENERIC_SEED_WORDS.has(candidate.toLowerCase())) return null;
  return candidate;
}

function extractPersonCandidate(chatName) {
  if (!chatName) return null;
  let s = String(chatName).trim();

  if (/^Plexo\s*[<>x×|]/i.test(s)) return null;

  const sepMatch = s.match(/^(.+?)\s*[|—–]\s*/);
  if (sepMatch && sepMatch[1].trim().length >= 3) {
    s = sepMatch[1].trim();
  }

  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return null;
  if (tokens.length === 1 && GENERIC_SEED_WORDS.has(tokens[0].toLowerCase())) return null;

  return tokens.slice(0, 3).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Deeplink construction (v3.18.4)
//
// For each chat, we want Anton to be able to TAP the name and land directly
// in that chat in the native client (WhatsApp / Telegram / LinkedIn profile).
//
// Beeper's chat.id is a matrix-internal ID — useless for this. The actual
// contact identity (phone, @username, linkedin URL) lives in Notion People DB.
//
// Coverage flow:
//   1. extractPersonContacts(personPage) — pull Telegram/Phone/LinkedIn fields
//      from a Notion People row.
//   2. resolveCompanyContacts(companyPageId) — for company-matched chats
//      (e.g. "Plexo <> XTransfer"), follow Company.People relation and
//      grab first attached person's contacts.
//   3. buildChatDeeplink(networkFull, contacts) — turn contacts into native URL.
//
// LinkedIn limitation: there's no public deeplink to a specific DM thread.
// Best we can do is the profile URL — Anton taps once → profile → Message
// button is right there.
// ─────────────────────────────────────────────────────────────────────────────

// Parse contact fields from a Notion People DB page. All fields optional.
function extractPersonContacts(personPage) {
  if (!personPage) return null;
  const props = personPage.properties || {};

  // Telegram is rich_text in People DB (e.g. "@m4rtr3d")
  let telegram = null;
  const tgArr = props["Telegram"]?.rich_text || [];
  const tgRaw = tgArr.map(t => t.plain_text || t.text?.content || "").join("").trim();
  if (tgRaw) {
    // Normalize: strip leading "@", trim, validate it looks like a username
    const cleaned = tgRaw.replace(/^@/, "").trim();
    if (/^[a-zA-Z0-9_]{4,32}$/.test(cleaned)) telegram = cleaned;
  }

  // Phone is phone_number type
  let phone = null;
  const phoneRaw = props["Phone"]?.phone_number;
  if (phoneRaw) {
    // Strip everything except digits
    const digits = String(phoneRaw).replace(/[^\d]/g, "");
    if (digits.length >= 7 && digits.length <= 15) phone = digits;
  }

  // LinkedIn is url type
  let linkedin = props["LinkedIn"]?.url || null;
  if (linkedin && !/^https?:\/\//i.test(linkedin)) {
    linkedin = `https://${linkedin}`;
  }

  if (!telegram && !phone && !linkedin) return null;
  return { telegram, phone, linkedin };
}

// Resolve a company page → first attached person's contacts.
// Used for group chats matched by company name.
async function resolveCompanyContacts(companyPageId) {
  if (!companyPageId) return null;
  try {
    const r = await axios.get(
      `https://api.notion.com/v1/pages/${companyPageId}`,
      { headers: notionHeaders(), timeout: 6_000 }
    );
    const peopleRel = r.data.properties?.People?.relation || [];
    if (!peopleRel.length) return null;

    // Take first linked person and resolve their page
    const personPageRes = await axios.get(
      `https://api.notion.com/v1/pages/${peopleRel[0].id}`,
      { headers: notionHeaders(), timeout: 6_000 }
    );
    return extractPersonContacts(personPageRes.data);
  } catch (err) {
    console.warn(`[yesterday/lookup] resolveCompanyContacts(${companyPageId}) failed:`, err.message);
    return null;
  }
}

// Pure function: contacts → deeplink URL for the chat's network.
// Returns { url, label } where label is "wa.me" / "t.me" / "linkedin" so
// the bot can pick a small icon. Returns null if no usable contact.
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

// ─────────────────────────────────────────────────────────────────────────────
// Notion lookups
// ─────────────────────────────────────────────────────────────────────────────

// Resolve a Notion company page by ID — returns full info incl. attached
// person's contacts (for group-chat deeplinks).
async function resolveCompanyPage(pageId, withContacts = false) {
  try {
    const r = await axios.get(
      `https://api.notion.com/v1/pages/${pageId}`,
      { headers: notionHeaders(), timeout: 6_000 }
    );
    const props = r.data.properties || {};
    const titleArr = props["Company name"]?.title || [];
    const cname = titleArr.map(t => t.plain_text || t.text?.content || "").join("");
    const stage = props["Stage"]?.status?.name || null;
    const bdScore = props["BD Score"]?.number ?? null;
    const skipStages = new Set(["Lost", "DELETE", "Not relevant"]);
    if (stage && skipStages.has(stage)) return null;

    const result = { name: cname, stage, bdScore, _pageId: pageId };

    if (withContacts) {
      const peopleRel = props["People"]?.relation || [];
      if (peopleRel.length > 0) {
        try {
          const personRes = await axios.get(
            `https://api.notion.com/v1/pages/${peopleRel[0].id}`,
            { headers: notionHeaders(), timeout: 6_000 }
          );
          const contacts = extractPersonContacts(personRes.data);
          if (contacts) result.personContacts = contacts;
        } catch (e) { /* swallow */ }
      }
    }

    return result;
  } catch (err) {
    console.warn(`[yesterday/lookup] resolveCompanyPage(${pageId}) failed:`, err.message);
    return null;
  }
}

// Person lookup — returns stage info from linked company AND person's own
// contact fields (Telegram/Phone/LinkedIn from People DB row).
async function lookupPersonStage(personCandidate) {
  if (!NOTION_TOKEN || !personCandidate) return null;
  try {
    const firstToken = personCandidate.split(/\s+/)[0];
    if (!firstToken || firstToken.length < 3) return null;

    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      {
        filter: { property: "Name", title: { contains: firstToken } },
        page_size: 5,
      },
      { headers: notionHeaders(), timeout: 8_000 }
    );

    if (!r.data.results.length) return null;

    const lowerCandidate = personCandidate.toLowerCase();
    const exactMatch = r.data.results.find(page => {
      const titleArr = page.properties?.Name?.title || [];
      const fullName = titleArr.map(t => t.plain_text || t.text?.content || "").join("").toLowerCase();
      return fullName.includes(lowerCandidate) || lowerCandidate.includes(fullName);
    });
    const person = exactMatch || r.data.results[0];

    // Pull person's own contact fields — these are PRIMARY source for deeplink
    const personContacts = extractPersonContacts(person);

    const companyRel = person.properties?.Company?.relation || [];
    let companyInfo = null;
    if (companyRel.length) {
      companyInfo = await resolveCompanyPage(companyRel[0].id, false);
    }

    if (!companyInfo && !personContacts) return null;

    return {
      ...(companyInfo || {}),
      personContacts,
    };
  } catch (err) {
    console.warn(`[yesterday/lookup] person lookup failed for "${personCandidate}":`, err.message);
    return null;
  }
}

async function batchLookupCRMStages(chatNames) {
  if (!NOTION_TOKEN) return new Map();

  const result = new Map();
  const candidateToChatNames = new Map();
  const personCandidateToChatNames = new Map();

  for (const name of chatNames) {
    const cand = extractLookupCandidate(name);
    if (cand) {
      const key = cand.toLowerCase();
      if (!candidateToChatNames.has(key)) {
        candidateToChatNames.set(key, { candidate: cand, names: [] });
      }
      candidateToChatNames.get(key).names.push(name);
    }
    const personCand = extractPersonCandidate(name);
    if (personCand) {
      const pKey = personCand.toLowerCase();
      if (!personCandidateToChatNames.has(pKey)) {
        personCandidateToChatNames.set(pKey, { candidate: personCand, names: [] });
      }
      personCandidateToChatNames.get(pKey).names.push(name);
    }
  }

  console.log(`[yesterday/lookup] ${chatNames.length} chats → ${candidateToChatNames.size} company candidates, ${personCandidateToChatNames.size} person candidates`);

  // ── PASS 1: Company-name lookup with contacts ──
  await Promise.all([...candidateToChatNames.values()].map(async ({ candidate, names }) => {
    try {
      const r = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_COMPANIES_DB}/query`,
        {
          filter: { property: "Company name", title: { contains: candidate } },
          page_size: 3,
        },
        { headers: notionHeaders(), timeout: 8_000 }
      );
      const skipStages = new Set(["Lost", "DELETE", "Not relevant"]);
      const candidates = r.data.results
        .map(page => {
          const props = page.properties || {};
          const titleArr = props["Company name"]?.title || [];
          const cname = titleArr.map(t => t.plain_text || t.text?.content || "").join("");
          const stage = props["Stage"]?.status?.name || null;
          const bdScore = props["BD Score"]?.number ?? null;
          const peopleRel = props["People"]?.relation || [];
          return { name: cname, stage, bdScore, _pageId: page.id, _firstPersonId: peopleRel[0]?.id || null };
        })
        .filter(c => !skipStages.has(c.stage));

      const best = candidates[0] || null;
      if (best) {
        // For company-matched chats — try resolve first attached person's contacts
        let personContacts = null;
        if (best._firstPersonId) {
          try {
            const personRes = await axios.get(
              `https://api.notion.com/v1/pages/${best._firstPersonId}`,
              { headers: notionHeaders(), timeout: 6_000 }
            );
            personContacts = extractPersonContacts(personRes.data);
          } catch (e) { /* swallow */ }
        }
        const enriched = { ...best, personContacts };
        delete enriched._firstPersonId;
        console.log(`[yesterday/lookup] company "${candidate}" → "${best.name}" (${best.stage})${personContacts ? " +contacts" : ""}`);
        for (const chatName of names) {
          result.set(chatName, enriched);
        }
      }
    } catch (err) {
      console.warn(`[yesterday/lookup] company lookup failed for "${candidate}":`, err.message);
    }
  }));

  // ── PASS 2: People-fallback for chats not yet matched ──
  const unmatchedPersonLookups = [];
  for (const [pKey, { candidate, names }] of personCandidateToChatNames) {
    const allNamesAlreadyMatched = names.every(n => result.has(n));
    if (allNamesAlreadyMatched) continue;
    unmatchedPersonLookups.push({ candidate, names });
  }

  if (unmatchedPersonLookups.length > 0) {
    console.log(`[yesterday/lookup] trying People-fallback for ${unmatchedPersonLookups.length} candidates`);
    await Promise.all(unmatchedPersonLookups.map(async ({ candidate, names }) => {
      const stageInfo = await lookupPersonStage(candidate);
      if (stageInfo) {
        console.log(`[yesterday/lookup] person "${candidate}" → "${stageInfo.name || "?"}" (${stageInfo.stage || "no-stage"})${stageInfo.personContacts ? " +contacts" : ""}`);
        for (const chatName of names) {
          if (!result.has(chatName)) result.set(chatName, stageInfo);
        }
      } else {
        console.log(`[yesterday/lookup] person "${candidate}" → NO MATCH`);
      }
    }));
  }

  for (const name of chatNames) {
    if (!result.has(name)) result.set(name, null);
  }

  return result;
}

function filterByImportance(chatsWithCRM) {
  return chatsWithCRM.filter(chat => {
    if (!chat.crm) return true;
    const stage = chat.crm.stage;
    if (!stage) return true;
    return LATE_STAGES.has(stage);
  });
}

function getYesterdayWindow() {
  const TZ = "Europe/Prague";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  const label = `${y}-${m}-${d}`;

  const probe = new Date(`${label}T12:00:00Z`);
  const fmtCheck = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", hour12: false,
  });
  const hourInPrague = parseInt(fmtCheck.format(probe), 10);
  const offsetHours = hourInPrague - 12;

  const startISO = new Date(`${label}T00:00:00Z`).getTime() - offsetHours * 3600_000;
  const endISO = startISO + 24 * 3600_000;

  return {
    startISO: new Date(startISO).toISOString(),
    endISO:   new Date(endISO).toISOString(),
    label,
  };
}

const MAX_CHATS_TO_INSPECT = 60;

async function fetchYesterdayFromBeeper({ startISO, endISO }) {
  if (!BEEPER_TOKEN) throw new Error("BEEPER_TOKEN not set");

  const r = await axios.get(`${BEEPER_URL}/v1/chats?limit=200`, {
    headers: beeperHeaders(),
    timeout: 12_000,
  });
  const items = r.data?.items || [];

  console.log(`[yesterday/beeper] /v1/chats returned ${items.length} chats`);

  const candidates = items.filter(c => {
    const name = c.title || c.name || "";
    if (SKIP_CHAT_NAME_REGEX.test(name)) return false;
    return true;
  });

  console.log(`[yesterday/beeper] ${candidates.length} after skip-regex (was ${items.length})`);

  const sorted = candidates.slice().sort((a, b) => {
    const ta = Date.parse(a.lastMessageAt || a.lastActivityAt || a.updatedAt || 0);
    const tb = Date.parse(b.lastMessageAt || b.lastActivityAt || b.updatedAt || 0);
    if (!isNaN(ta) && !isNaN(tb)) return tb - ta;
    if (!isNaN(ta)) return -1;
    if (!isNaN(tb)) return 1;
    return 0;
  });

  const toInspect = sorted.slice(0, MAX_CHATS_TO_INSPECT);
  console.log(`[yesterday/beeper] inspecting top ${toInspect.length} chats for messages`);

  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);

  const enriched = await Promise.all(toInspect.map(async c => {
    let messagesYesterday = [];
    let msgsTotal = 0;
    let parseFailures = 0;
    try {
      const msgs = await beeperGetMessages(c.id, 8);
      msgsTotal = msgs.length;

      messagesYesterday = msgs.filter(m => {
        const ts = m.timestamp;
        const tsMs = typeof ts === "number" ? ts : Date.parse(ts || 0);
        if (isNaN(tsMs)) {
          parseFailures++;
          return false;
        }
        return tsMs >= startMs && tsMs < endMs;
      }).map(m => ({
        sender: m.sender?.fullName || m.sender?.displayName || m.senderName || "?",
        text: (m.content?.text || m.content?.body || m.text || m.body || "").slice(0, 400),
        timestamp: m.timestamp,
        isSender: !!m.isSender,
      })).filter(m => m.text);
    } catch (e) {
      console.warn(`[yesterday/beeper] msg fetch failed for "${c.title || c.name}":`, e.message);
    }

    return {
      id: c.id,
      name: c.title || c.name || "",
      type: c.type,
      accountID: c.accountID,
      networkFull: networkFromAccountID(c.accountID),
      messagesYesterday,
      _msgsTotal: msgsTotal,
      _parseFailures: parseFailures,
    };
  }));

  const survived = enriched.filter(c => c.messagesYesterday.length > 0);

  console.log(`[yesterday/beeper] ${survived.length}/${enriched.length} chats have messages in window`);
  if (survived.length > 0) {
    console.log(`[yesterday/beeper] survivors: ${survived.slice(0, 10).map(c => `"${c.name}"`).join(", ")}`);
  }
  if (survived.length === 0 && enriched.length > 0) {
    const samples = enriched.slice(0, 5).map(c => `"${c.name}" msgs=${c._msgsTotal} parseFailures=${c._parseFailures}`);
    console.log(`[yesterday/beeper] ZERO survivors — samples: ${samples.join(", ")}`);
  }

  return survived.map(({ _msgsTotal, _parseFailures, ...rest }) => rest);
}

async function fetchYesterdayFromHub({ startISO, endISO }) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN not set");

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const r = await axios.post(
    `https://api.notion.com/v1/databases/${MESSAGES_HUB_DB}/query`,
    {
      filter: {
        and: [
          { property: "Status", status: { equals: "Active" } },
          {
            timestamp: "last_edited_time",
            last_edited_time: { on_or_after: sevenDaysAgo },
          },
        ],
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 100,
    },
    { headers: notionHeaders(), timeout: 10_000 }
  );

  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);

  const allRows = r.data.results.map(page => {
    const props = page.properties || {};
    const titleArr = props["Chat Name"]?.title || [];
    const name = titleArr.map(t => t.plain_text || t.text?.content || "").join("");

    const lastMsgArr = props["Last Message"]?.rich_text || [];
    const lastMsgText = lastMsgArr.map(rt => rt.plain_text || rt.text?.content || "").join("").slice(0, 400);

    const networkArr = props["Network"]?.multi_select || [];
    const networkFull = networkArr[0]?.name || null;

    const rawSender = (props["Raw Sender Name"]?.rich_text || [])
      .map(rt => rt.plain_text || rt.text?.content || "").join("");

    const accountID = null;

    const lastActiveDate = props["Last Active"]?.date?.start || null;
    const lastEditedTime = page.last_edited_time;
    const effectiveTime = lastActiveDate || lastEditedTime;

    return {
      name, networkFull, accountID,
      lastMsgText,
      lastMsgSender: rawSender,
      lastMsgTime: effectiveTime,
      lastEditedTime,
      outbound: rawSender ? isInternalSender(rawSender) : false,
    };
  });

  const freshestEdit = allRows.length > 0
    ? allRows.reduce((max, row) => {
        const ts = Date.parse(row.lastEditedTime || 0);
        return !isNaN(ts) && ts > max ? ts : max;
      }, 0)
    : 0;

  const yesterdayRows = allRows.filter(row => {
    if (!row.lastMsgText || !row.lastMsgText.trim()) return false;
    if (SKIP_CHAT_NAME_REGEX.test(row.name)) return false;
    const tsMs = Date.parse(row.lastMsgTime);
    if (isNaN(tsMs)) return false;
    return tsMs >= startMs && tsMs < endMs;
  });

  let stalestFallbackRows = [];
  if (yesterdayRows.length === 0) {
    stalestFallbackRows = allRows
      .filter(row => row.lastMsgText && row.lastMsgText.trim() && !SKIP_CHAT_NAME_REGEX.test(row.name))
      .slice(0, 30);
  }

  console.log(`[yesterday/hub] ${allRows.length} active rows, ${yesterdayRows.length} in window, ${stalestFallbackRows.length} fallback`);

  return {
    yesterdayRows,
    stalestFallbackRows,
    freshestEditISO: freshestEdit > 0 ? new Date(freshestEdit).toISOString() : null,
  };
}

function groupChatsForRender(chats) {
  const groups = new Map();

  for (const chat of chats) {
    const key = groupKey(chat.accountID, chat.networkFull);
    if (!groups.has(key)) {
      groups.set(key, { key, header: groupKeyToHeader(key), chats: [] });
    }
    groups.get(key).chats.push(chat);
  }

  const orderRank = (key) => {
    if (key === "LinkedIn") return 0;
    if (key === "Telegram") return 1;
    if (key.startsWith("WhatsApp:+420777225067")) return 2;
    if (key.startsWith("WhatsApp:+420774576161")) return 3;
    if (key.startsWith("WhatsApp")) return 4;
    return 99;
  };

  return Array.from(groups.values()).sort((a, b) =>
    orderRank(a.key) - orderRank(b.key)
  );
}

function buildNetworkPayload(group) {
  const items = [];
  for (const chat of group.chats) {
    const msgs = chat.messagesYesterday || [];
    if (msgs.length === 0) continue;

    const filtered = msgs.filter(m => m.isSender || !isLowSignalInbound(m.text));
    if (filtered.length === 0) continue;

    items.push({
      chatName: chat.name,
      type: chat.type || "single",
      crm: chat.crm
        ? {
            companyName: chat.crm.name,
            stage: chat.crm.stage,
            bdScore: chat.crm.bdScore,
          }
        : null,
      messages: filtered.map(m => ({
        sender: m.sender,
        text: m.text,
        direction: m.isSender ? "out" : "in",
      })),
    });
  }
  return items;
}

// Top chats per network — now also includes deeplink derived from
// chat.crm.personContacts via buildChatDeeplink.
function pickTopChats(group, n = 3) {
  const scored = group.chats.map(chat => {
    const msgs = chat.messagesYesterday || [];
    const hasOutbound = msgs.some(m => m.isSender);
    const totalLength = msgs.reduce((sum, m) => sum + (m.text?.length || 0), 0);
    const stageScore = chat.crm?.stage ? (STAGE_RANK[chat.crm.stage] || 0) * 5000 : 0;
    const score = stageScore + (hasOutbound ? 1000 : 0) + totalLength;
    return { chat, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map(s => {
    const chat = s.chat;
    const lastMsg = chat.messagesYesterday[chat.messagesYesterday.length - 1];
    const direction = lastMsg?.isSender ? "→" : "←";
    const snippet = (lastMsg?.text || "").slice(0, 120);

    // Build deeplink from CRM person contacts
    const contacts = chat.crm?.personContacts;
    const deeplinkObj = buildChatDeeplink(chat.networkFull, contacts);

    return {
      name: chat.name,
      direction,
      lastSender: lastMsg?.sender || "?",
      snippet,
      crmStage: chat.crm?.stage || null,
      bdScore: chat.crm?.bdScore ?? null,
      deeplink: deeplinkObj?.url || null,
      deeplinkLabel: deeplinkObj?.label || null,
    };
  });
}

function generateFallbackSummary(items) {
  if (!items.length) return { bullets: [], skipped: true, fallback: true };

  const ranked = items.slice().sort((a, b) => {
    const stageA = a.crm?.stage ? (STAGE_RANK[a.crm.stage] || 0) : 0;
    const stageB = b.crm?.stage ? (STAGE_RANK[b.crm.stage] || 0) : 0;
    if (stageA !== stageB) return stageB - stageA;
    const outA = a.messages.filter(m => m.direction === "out").length;
    const outB = b.messages.filter(m => m.direction === "out").length;
    return outB - outA;
  });

  const bullets = [];
  for (const item of ranked.slice(0, 5)) {
    const stageInfo = item.crm?.stage
      ? `${item.crm.companyName || item.chatName.split(/\s*[|—–]\s*/)[0]}, ${item.crm.stage}`
      : item.chatName;

    const outbound = item.messages.filter(m => m.direction === "out");
    const inbound  = item.messages.filter(m => m.direction === "in");

    if (outbound.length > 0 && inbound.length === 0) {
      bullets.push(`Anton отправил сообщение: ${stageInfo}`);
    } else if (inbound.length > 0 && outbound.length === 0) {
      bullets.push(`Входящее от ${stageInfo} — нужен ответ`);
    } else {
      bullets.push(`Активный диалог: ${stageInfo} (${outbound.length} out, ${inbound.length} in)`);
    }
  }

  return { bullets, fallback: true };
}

async function summarizeNetwork(networkHeader, items) {
  if (!ANTHROPIC_KEY) {
    console.log(`[yesterday/summary] no ANTHROPIC_KEY — using fallback for ${networkHeader}`);
    return generateFallbackSummary(items);
  }
  if (items.length === 0) {
    return { bullets: [], skipped: true };
  }

  const lines = [];
  for (const item of items) {
    const stagePart = item.crm
      ? ` [CRM: ${item.crm.stage || "?"}${item.crm.bdScore ? ` · BD ${item.crm.bdScore}` : ""}]`
      : ` [новый контакт, не в CRM]`;
    lines.push(`### ${item.chatName}${item.type === "group" ? " (group)" : ""}${stagePart}`);
    for (const msg of item.messages) {
      const arrow = msg.direction === "out" ? "→ Anton" : `← ${msg.sender}`;
      lines.push(`${arrow}: ${msg.text}`);
    }
    lines.push("");
  }
  const conversationText = lines.join("\n");

  const systemPrompt = `Ты ассистент BD-команды Plexo (B2B stablecoin clearing network для финтехов).
Anton — CEO. Pavel — Head of Partnerships.
Твоя задача — кратко суммировать что важного произошло за вчерашний день в одном мессенджере.

ВАЖНО: ты получаешь ТОЛЬКО важные сделки (поздние стадии воронки) + новые контакты не в CRM.
Используй CRM stage как сигнал важности: Negotiations > Call Scheduled > Warm discussions > Keeping in the Loop > initial discussions.

Формат вывода — 3-5 буллетов, каждый по 1 строке (до 100 символов).
Каждый буллет должен ОТВЕЧАТЬ на вопрос "что важного?", а не пересказывать кто-кому-что-сказал.

Если в input ничего по-настоящему важного нет — верни 1 буллет "Только тех.переписка по активным сделкам".

Отвечай строго JSON: { "bullets": ["bullet 1", "bullet 2", ...] }
Не добавляй объяснений вокруг JSON.`;

  const userPrompt = `Network: ${networkHeader}

Активность за вчера (только late-stage сделки и новые контакты):

${conversationText}

Дай 3-5 буллетов про что важного.`;

  try {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 25_000,
      }
    );

    const textBlock = (r.data?.content || []).find(b => b.type === "text");
    const raw = textBlock?.text || "";
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean);
    const bullets = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5) : [];
    return { bullets };
  } catch (err) {
    console.error(`[yesterday/summary] AI failed for ${networkHeader}:`, err.message);
    const fallback = generateFallbackSummary(items);
    fallback.aiError = err.message;
    return fallback;
  }
}

router.get("/summary", async (req, res) => {
  const t0 = Date.now();
  const window = getYesterdayWindow();
  const lateStagesOnly = req.query.lateStagesOnly !== "0" && req.query.lateStagesOnly !== "false";

  console.log(`[yesterday] === START === window: ${window.startISO} → ${window.endISO} (label: ${window.label}) lateStagesOnly=${lateStagesOnly}`);

  let chats = null;
  let source = null;
  let dataDate = window.label;
  let freshestEditISO = null;

  try {
    chats = await fetchYesterdayFromBeeper(window);
    source = "beeper";
    console.log(`[yesterday] beeper SUCCESS: ${chats.length} chats`);
  } catch (beeperErr) {
    console.warn(`[yesterday] beeper FAILED: ${beeperErr.message} — falling back to hub`);
  }

  if (!chats) {
    try {
      const hub = await fetchYesterdayFromHub(window);
      freshestEditISO = hub.freshestEditISO;

      if (hub.yesterdayRows.length > 0) {
        source = "hub-fresh";
        chats = hub.yesterdayRows.map(row => ({
          name: row.name,
          accountID: row.accountID,
          networkFull: row.networkFull,
          messagesYesterday: [{
            sender: row.lastMsgSender || "?",
            text: row.lastMsgText,
            timestamp: row.lastMsgTime,
            isSender: row.outbound,
          }],
        }));
        console.log(`[yesterday] hub-fresh: ${chats.length} chats`);
      } else if (hub.stalestFallbackRows.length > 0) {
        source = "hub-stale";
        if (freshestEditISO) {
          const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Prague",
            year: "numeric", month: "2-digit", day: "2-digit",
          });
          const parts = fmt.formatToParts(new Date(freshestEditISO));
          dataDate = `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
        }
        chats = hub.stalestFallbackRows.map(row => ({
          name: row.name,
          accountID: row.accountID,
          networkFull: row.networkFull,
          messagesYesterday: [{
            sender: row.lastMsgSender || "?",
            text: row.lastMsgText,
            timestamp: row.lastMsgTime,
            isSender: row.outbound,
          }],
        }));
        console.log(`[yesterday] hub-stale: ${chats.length} chats from ${dataDate}`);
      } else {
        console.log(`[yesterday] hub EMPTY — both yesterdayRows and fallbackRows are 0`);
        return res.json({
          ok: true,
          source: "hub-empty",
          yesterdayLabel: window.label,
          dataDate: null,
          freshestEditISO,
          filteredBy: lateStagesOnly ? "late-stages" : "none",
          totalBeforeFilter: 0,
          dropped: 0,
          networks: [],
        });
      }
    } catch (hubErr) {
      console.error(`[yesterday] hub FAILED: ${hubErr.message}`);
      return res.status(500).json({
        error: "both beeper and hub failed",
        hubError: hubErr.message,
      });
    }
  }

  const totalBeforeFilter = chats.length;

  let filteredChats = chats;
  let dropped = 0;
  let crmMap = new Map();
  if (chats.length > 0) {
    const chatNames = chats.map(c => c.name).filter(Boolean);
    crmMap = await batchLookupCRMStages(chatNames);
    const enriched = chats.map(c => ({ ...c, crm: crmMap.get(c.name) || null }));

    if (lateStagesOnly) {
      filteredChats = filterByImportance(enriched);
      dropped = totalBeforeFilter - filteredChats.length;
      console.log(`[yesterday] CRM filter: ${totalBeforeFilter} → ${filteredChats.length} (dropped ${dropped})`);
      if (dropped > 0) {
        const droppedSamples = enriched
          .filter(c => c.crm && c.crm.stage && !LATE_STAGES.has(c.crm.stage))
          .slice(0, 10)
          .map(c => `"${c.name}" (${c.crm.stage})`);
        console.log(`[yesterday] dropped samples: ${droppedSamples.join(", ")}`);
      }
    } else {
      filteredChats = enriched;
    }
  }

  const groups = groupChatsForRender(filteredChats);
  console.log(`[yesterday] grouped into ${groups.length} networks: ${groups.map(g => `${g.header}=${g.chats.length}`).join(", ")}`);

  const networks = await Promise.all(groups.map(async group => {
    const payload = buildNetworkPayload(group);
    const topChats = pickTopChats(group, 3);
    const summary = await summarizeNetwork(group.header, payload);
    return {
      header: group.header,
      key: group.key,
      summary,
      topChats,
      totalChats: group.chats.length,
    };
  }));

  // Count deeplinks for visibility / debugging
  const deeplinkCount = networks.reduce((sum, n) =>
    sum + (n.topChats || []).filter(c => c.deeplink).length, 0);
  console.log(`[yesterday] === END === ${Date.now() - t0}ms · source=${source} · totalBefore=${totalBeforeFilter} · dropped=${dropped} · networks=${networks.length} · deeplinks=${deeplinkCount}`);

  return res.json({
    ok: true,
    source,
    yesterdayLabel: window.label,
    dataDate,
    freshestEditISO,
    filteredBy: lateStagesOnly ? "late-stages" : "none",
    totalBeforeFilter,
    dropped,
    networks,
  });
});

router.get("/activity", async (req, res) => {
  const window = getYesterdayWindow();

  try {
    const chats = await fetchYesterdayFromBeeper(window);
    const groups = groupChatsForRender(chats);
    return res.json({
      ok: true,
      source: "beeper",
      yesterdayLabel: window.label,
      dataDate: window.label,
      groups,
      totalChats: chats.length,
    });
  } catch (beeperErr) {
    console.warn(`[yesterday] beeper failed: ${beeperErr.message} — falling back to hub`);
  }

  try {
    const { yesterdayRows, stalestFallbackRows, freshestEditISO } = await fetchYesterdayFromHub(window);

    if (yesterdayRows.length > 0) {
      const groups = groupChatsForRender(yesterdayRows.map(row => ({
        name: row.name, accountID: row.accountID, networkFull: row.networkFull,
        messagesYesterday: [{
          sender: row.lastMsgSender || "?", text: row.lastMsgText,
          timestamp: row.lastMsgTime, isSender: row.outbound,
        }],
      })));
      return res.json({
        ok: true, source: "hub-fresh",
        yesterdayLabel: window.label, dataDate: window.label,
        freshestEditISO, groups, totalChats: yesterdayRows.length,
      });
    }

    if (stalestFallbackRows.length > 0) {
      let staleDateLabel = "unknown";
      if (freshestEditISO) {
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Prague",
          year: "numeric", month: "2-digit", day: "2-digit",
        });
        const parts = fmt.formatToParts(new Date(freshestEditISO));
        staleDateLabel = `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
      }
      const groups = groupChatsForRender(stalestFallbackRows.map(row => ({
        name: row.name, accountID: row.accountID, networkFull: row.networkFull,
        messagesYesterday: [{
          sender: row.lastMsgSender || "?", text: row.lastMsgText,
          timestamp: row.lastMsgTime, isSender: row.outbound,
        }],
      })));
      return res.json({
        ok: true, source: "hub-stale",
        yesterdayLabel: window.label, dataDate: staleDateLabel,
        freshestEditISO, groups, totalChats: stalestFallbackRows.length,
      });
    }

    return res.json({
      ok: true, source: "hub-empty",
      yesterdayLabel: window.label, dataDate: null,
      freshestEditISO, groups: [], totalChats: 0,
    });
  } catch (hubErr) {
    return res.status(500).json({
      error: "both beeper and hub failed",
      hubError: hubErr.message,
    });
  }
});

module.exports = router;
