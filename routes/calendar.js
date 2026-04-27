const express = require("express");
const axios   = require("axios");

const router = express.Router();

// ── Config from env ──────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN_PAVEL;

// Default calendar to read = Anton's. Pavel is subscribed to it via his Google
// account (proven in design phase). All requests use Pavel's OAuth credentials.
const DEFAULT_CALENDAR_ID  = process.env.ANTON_CALENDAR_ID || "anton@remide.xyz";
const DEFAULT_TIMEZONE     = "Europe/Prague";

// ── Access token cache ───────────────────────────────────────────────────────
// Google access tokens last 1 hour. We cache and refresh ~5 min before expiry.
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
      singleEvents: true,    // expand recurring events into instances
      orderBy: "startTime",
      maxResults: 50,
    },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  return r.data.items || [];
}

// ── Helper: format event for digest output ───────────────────────────────────
// Returns clean shape: time, title, attendees (external only), meet URL, etc.
function formatEvent(ev, viewerTimeZone) {
  const startISO = ev.start?.dateTime || ev.start?.date;
  const endISO   = ev.end?.dateTime   || ev.end?.date;
  const isAllDay = !ev.start?.dateTime;

  // Time formatted in viewer's TZ (default: Europe/Prague for Anton)
  const start = new Date(startISO);
  const end   = new Date(endISO);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: viewerTimeZone,
  });
  const timeRange = isAllDay
    ? "all-day"
    : `${fmt.format(start)}–${fmt.format(end)}`;

  // Attendees: filter out @remide.xyz (internal team) — keep only externals
  const attendees = (ev.attendees || [])
    .filter(a => !a.self && !(a.email || "").endsWith("@remide.xyz"))
    .map(a => ({
      email:    a.email,
      name:     a.displayName || null,
      response: a.responseStatus,
    }));

  // Counterparty company guess from email domain
  const externalDomains = [...new Set(
    attendees
      .map(a => (a.email || "").split("@")[1])
      .filter(Boolean)
      .filter(d => !d.includes("calendar.google.com") && !d.includes("group.calendar.google.com"))
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
    isInternal:  attendees.length === 0,  // no externals = team meeting / focus block
    eventType:   ev.eventType || "default",
  };
}

// ── GET /calendar/today ──────────────────────────────────────────────────────
// Returns today's events (Europe/Prague day boundaries by default) for Anton's
// calendar. Query params:
//   calendarId  — override (default: anton@remide.xyz via env)
//   timeZone    — override viewer TZ (default: Europe/Prague)
//   includeInternal — "1" to include team-only meetings (default: include all)
router.get("/today", async (req, res) => {
  const calendarId = req.query.calendarId || DEFAULT_CALENDAR_ID;
  const timeZone   = req.query.timeZone   || DEFAULT_TIMEZONE;

  // Compute "today" in the target timezone
  const now = new Date();
  const dayStart = new Date(now.toLocaleString("en-US", { timeZone }));
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  // Convert local TZ boundaries to UTC ISO for the API (uses date string + TZ)
  const pad = n => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const timeMin = `${ymd(dayStart)}T00:00:00`;
  const timeMax = `${ymd(dayEnd)}T23:59:59`;

  try {
    const events = await fetchEvents({ calendarId, timeMin, timeMax, timeZone });
    const formatted = events.map(ev => formatEvent(ev, timeZone));

    res.json({
      ok: true,
      calendarId,
      timeZone,
      date: ymd(dayStart),
      total: formatted.length,
      events: formatted,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    console.error("[calendar/today] error:", detail);
    res.status(status).json({
      ok: false,
      error: typeof detail === "string" ? detail : (detail.error_description || detail.error?.message || err.message),
    });
  }
});

// ── GET /calendar/range ──────────────────────────────────────────────────────
// More general: events between arbitrary timeMin/timeMax. Used by future
// pre-call briefing trigger (looks at next 2 hours).
router.get("/range", async (req, res) => {
  const calendarId = req.query.calendarId || DEFAULT_CALENDAR_ID;
  const timeZone   = req.query.timeZone   || DEFAULT_TIMEZONE;
  const { timeMin, timeMax } = req.query;
  if (!timeMin || !timeMax) {
    return res.status(400).json({ ok: false, error: "timeMin and timeMax required (ISO 8601)" });
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
    console.error("[calendar/range] error:", detail);
    res.status(status).json({
      ok: false,
      error: typeof detail === "string" ? detail : (detail.error_description || detail.error?.message || err.message),
    });
  }
});

// ── GET /calendar/health ─────────────────────────────────────────────────────
// Quick check that OAuth env is set and refresh works.
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
