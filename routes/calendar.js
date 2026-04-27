const express = require("express");
const axios   = require("axios");

const router = express.Router();

// ── Config from env ──────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN_PAVEL;
const NOTION_TOKEN         = process.env.NOTION_TOKEN;
const NOTION_PEOPLE_DB     = "f36b2a0f0ab241cebbdbd1d0874a55be";
const PORT                 = process.env.PORT || 3000;
const PROXY_BASE           = process.env.PROXY_BASE || `http://127.0.0.1:${PORT}`;

// Default calendar to read = Anton's. Pavel is subscribed to it via his Google
// account (proven in design phase). All requests use Pavel's OAuth credentials.
const DEFAULT_CALENDAR_ID  = process.env.ANTON_CALENDAR_ID || "anton@remide.xyz";
const DEFAULT_TIMEZONE     = "Europe/Prague";

// ── Access token cache ───────────────────────────────────────────────────────
let cachedAccessToken = null;
let cachedExpiresAt   = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedExpiresAt > now + 60_000) {
    return cachedAccessToken;
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google OAuth env vars not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN_PAVEL)");
  }
  const r = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10_000,
    }
  );
  cachedAccessToken = r.data.access_token;
  cachedExpiresAt   = now + (r.data.expires_in * 1000);
  return cachedAccessToken;
}

// ── Helper: fetch events from Google Calendar API ────────────────────────────
async function fetchEvents({ calendarId, timeMin, timeMax, timeZone }) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const r = await axios.get(url, {
    params: {
      timeMin,
      timeMax,
      timeZone,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  return r.data.items || [];
}

// ── Helper: get UTC ms boundaries for "today" in target TZ ───────────────────
function todayBoundaries(timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const ymd = fmt.format(new Date());
  const [year, month, day] = ymd.split("-").map(Number);

  const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
  const noonInTz = new Date(noon).toLocaleString("en-US", { timeZone });
  const noonAsUtc = new Date(noonInTz + " UTC").getTime();
  const tzOffsetMs = noonAsUtc - noon;

  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - tzOffsetMs;
  const endUtcMs   = startUtcMs + 24 * 60 * 60 * 1000;

  return { startUtcMs, endUtcMs, ymd };
}

// ── Internal-attendee detection ──────────────────────────────────────────────
function isInternalAttendee(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.endsWith("@remide.xyz")) return true;
  if (e.endsWith(".calendar.google.com")) return true;
  return false;
}

// ── Helper: format event for digest output ───────────────────────────────────
function formatEvent(ev, viewerTimeZone) {
  const startISO = ev.start?.dateTime || ev.start?.date;
  const endISO   = ev.end?.dateTime   || ev.end?.date;
  const isAllDay = !ev.start?.dateTime;

  const start = new Date(startISO);
  const end   = new Date(endISO);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: viewerTimeZone,
  });
  const timeRange = isAllDay
    ? "all-day"
    : `${fmt.format(start)}–${fmt.format(end)}`;

  const attendees = (ev.attendees || [])
    .filter(a => !a.self && !isInternalAttendee(a.email))
    .map(a => ({
      email:    a.email,
      name:     a.displayName || null,
      response: a.responseStatus,
    }));

  const externalDomains = [...new Set(
    attendees.map(a => (a.email || "").split("@")[1]).filter(Boolean)
  )];

  return {
    id:          ev.id,
    summary:     ev.summary || "(no title)",
    description: ev.description || null,
    location:    ev.location || null,
    start:       startISO,
    end:         endISO,
    isAllDay,
    timeRange,
    timeZone:    ev.start?.timeZone || null,
    htmlLink:    ev.htmlLink,
    meetUrl:     ev.conferenceUrl || ev.hangoutLink || null,
    attendees,
    externalDomains,
    isInternal:  attendees.length === 0,
    eventType:   ev.eventType || "default",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrichment helpers — Notion CRM lookup + Person matching
// ─────────────────────────────────────────────────────────────────────────────

// Personal email providers — never auto-CRM-sync these
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "ymail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "pm.me",
  "aol.com",
  "gmx.com", "gmx.net", "gmx.de",
  "mail.ru", "yandex.ru", "ya.ru",
]);

function pickPrimaryAttendee(formattedEvent) {
  for (const a of (formattedEvent.attendees || [])) {
    const email = (a.email || "").toLowerCase();
    if (!email) continue;
    const domain = email.split("@")[1];
    if (!domain) continue;
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) continue;
    return { email, name: a.name || null };
  }
  return null;
}

// Look up Notion CRM company by domain via /notion/insight-by-domain
async function lookupCrmCompany(domain) {
  try {
    const r = await axios.get(
      `${PROXY_BASE}/notion/insight-by-domain`,
      { params: { domain }, timeout: 10_000 }
    );
    if (r.data?.found) return r.data.company;
    return null;
  } catch (err) {
    console.error(`[calendar/enrich] CRM lookup failed for ${domain}: ${err.message}`);
    return null;
  }
}

// Look up Notion People by email — direct DB query (avoids new endpoint)
async function lookupCrmPersonByEmail(email) {
  if (!NOTION_TOKEN || !email) return null;
  try {
    const r = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_PEOPLE_DB}/query`,
      {
        filter: { property: "Email", email: { equals: email } },
        page_size: 1,
      },
      {
        headers: {
          "Authorization":   `Bearer ${NOTION_TOKEN}`,
          "Notion-Version":  "2022-06-28",
          "Content-Type":    "application/json",
        },
        timeout: 10_000,
      }
    );
    const page = r.data?.results?.[0];
    if (!page) return null;
    const props = page.properties || {};
    return {
      pageId:   page.id,
      url:      page.url,
      name:     (props["Name"]?.title || []).map(t => t.plain_text || t.text?.content || "").join(""),
      title:    (props["Role"]?.rich_text || []).map(t => t.plain_text || t.text?.content || "").join("") || null,
      email:    props["Email"]?.email || email,
      linkedin: props["LinkedIn"]?.url || null,
      telegram: (props["Telegram"]?.rich_text || []).map(t => t.plain_text || t.text?.content || "").join("") || null,
    };
  } catch (err) {
    console.error(`[calendar/enrich] People lookup failed for ${email}: ${err.message}`);
    return null;
  }
}

// Enrich one external event with CRM data + person info.
// Mutates the event object in place by adding `notion` and `attendeePerson` fields.
async function enrichOneEvent(event) {
  if (event.isInternal) return event;

  const primary = pickPrimaryAttendee(event);
  if (!primary) {
    event.notion = null;
    event.attendeePerson = null;
    event.primaryDomain = null;
    return event;
  }

  const domain = primary.email.split("@")[1];
  event.primaryDomain = domain;

  // Run both lookups in parallel
  const [company, person] = await Promise.all([
    lookupCrmCompany(domain),
    lookupCrmPersonByEmail(primary.email),
  ]);

  event.notion = company;
  event.attendeePerson = person || {
    // Fallback to raw Calendar attendee data if not in CRM People
    pageId: null, url: null,
    name: primary.name || primary.email.split("@")[0],
    email: primary.email,
    title: null, linkedin: null, telegram: null,
    fromCalendar: true,
  };

  return event;
}

// Concurrency-limited enrichment runner
async function enrichWithLimit(events, limit) {
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (idx < events.length) {
      const myIdx = idx++;
      try {
        await enrichOneEvent(events[myIdx]);
      } catch (err) {
        console.error(`[calendar/enrich] event ${myIdx} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
}

// ── GET /calendar/today ──────────────────────────────────────────────────────
// By default returns only events with at least one external attendee.
// Each external event is enriched with `notion` (CRM company digest) and
// `attendeePerson` (matched person from Notion People DB, or fallback to
// Calendar attendee data).
//
// Query params:
//   ?includeInternal=1  — include internal/focus blocks too
//   ?enrich=0           — skip CRM enrichment (faster, no Notion calls)
router.get("/today", async (req, res) => {
  const calendarId      = req.query.calendarId || DEFAULT_CALENDAR_ID;
  const timeZone        = req.query.timeZone   || DEFAULT_TIMEZONE;
  const includeInternal = req.query.includeInternal === "1" || req.query.includeInternal === "true";
  const skipEnrich      = req.query.enrich === "0" || req.query.enrich === "false";

  const { startUtcMs, endUtcMs, ymd } = todayBoundaries(timeZone);
  const timeMin = new Date(startUtcMs).toISOString();
  const timeMax = new Date(endUtcMs).toISOString();

  try {
    const events     = await fetchEvents({ calendarId, timeMin, timeMax, timeZone });
    const formatted  = events.map(ev => formatEvent(ev, timeZone));
    const visible    = includeInternal ? formatted : formatted.filter(ev => !ev.isInternal);

    if (!skipEnrich) {
      await enrichWithLimit(visible, 4);
    }

    res.json({
      ok: true,
      calendarId,
      timeZone,
      date: ymd,
      total: visible.length,
      hiddenInternal: includeInternal ? 0 : (formatted.length - visible.length),
      enriched: !skipEnrich,
      events: visible,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    console.error("[calendar/today] error:", JSON.stringify(detail));
    res.status(status).json({
      ok: false,
      error: typeof detail === "string" ? detail : (detail.error_description || detail.error?.message || err.message),
    });
  }
});

// ── GET /calendar/range ──────────────────────────────────────────────────────
router.get("/range", async (req, res) => {
  const calendarId = req.query.calendarId || DEFAULT_CALENDAR_ID;
  const timeZone   = req.query.timeZone   || DEFAULT_TIMEZONE;
  const { timeMin, timeMax } = req.query;
  if (!timeMin || !timeMax) {
    return res.status(400).json({ ok: false, error: "timeMin and timeMax required (RFC3339 with TZ)" });
  }
  try {
    const events = await fetchEvents({ calendarId, timeMin, timeMax, timeZone });
    res.json({
      ok: true,
      calendarId,
      timeZone,
      timeMin,
      timeMax,
      total: events.length,
      events: events.map(ev => formatEvent(ev, timeZone)),
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    console.error("[calendar/range] error:", JSON.stringify(detail));
    res.status(status).json({
      ok: false,
      error: typeof detail === "string" ? detail : (detail.error_description || detail.error?.message || err.message),
    });
  }
});

// ── GET /calendar/health ─────────────────────────────────────────────────────
router.get("/health", async (_req, res) => {
  const envOk = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);
  if (!envOk) {
    return res.json({
      ok: false,
      configured: false,
      missing: [
        !GOOGLE_CLIENT_ID     && "GOOGLE_CLIENT_ID",
        !GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
        !GOOGLE_REFRESH_TOKEN && "GOOGLE_REFRESH_TOKEN_PAVEL",
      ].filter(Boolean),
    });
  }
  try {
    await getAccessToken();
    res.json({ ok: true, configured: true, defaultCalendar: DEFAULT_CALENDAR_ID });
  } catch (err) {
    res.status(500).json({ ok: false, configured: true, error: err.message });
  }
});

module.exports = router;
