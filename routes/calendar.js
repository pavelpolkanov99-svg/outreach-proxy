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

// ── Helper: get UTC ms boundaries for "today" in target TZ ───────────────────
// Returns { startUtcMs, endUtcMs, ymd } where startUtcMs/endUtcMs bracket the
// civil day (00:00:00 → 24:00:00) in the given timezone, expressed as UTC ms.
// `ymd` is the YYYY-MM-DD string for that civil day in the target TZ.
function todayBoundaries(timeZone) {
  // Get current Y/M/D as seen in the target TZ
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const ymd = fmt.format(new Date()); // e.g. "2026-04-27" (en-CA gives ISO order)

  // Build a Date that represents "00:00:00 in target TZ on that civil day".
  // Trick: ask the formatter what UTC offset that civil moment has, then apply.
  const [year, month, day] = ymd.split("-").map(Number);

  // Compute target TZ offset for that day's noon (avoids DST edge issues at midnight)
  const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
  const noonInTz = new Date(noon).toLocaleString("en-US", { timeZone });
  const noonAsUtc = new Date(noonInTz + " UTC").getTime();
  const tzOffsetMs = noonAsUtc - noon;  // negative for east-of-UTC

  // 00:00 of civil day in target TZ, expressed as UTC ms:
  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - tzOffsetMs;
  const endUtcMs   = startUtcMs + 24 * 60 * 60 * 1000;

  return { startUtcMs, endUtcMs, ymd };
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

  // Attendees: filter out @remide.xyz (internal team) — keep only externals
  const attendees = (ev.attendees || [])
    .filter(a => !a.self && !(a.email || "").endsWith("@remide.xyz"))
    .map(a => ({
      email:    a.email,
      name:     a.displayName || null,
      response: a.responseStatus,
    }));

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
    isInternal:  attendees.length === 0,
    eventType:   ev.eventType || "default",
  };
}

// ── GET /calendar/today ──────────────────────────────────────────────────────
router.get("/today", async (req, res) => {
  const calendarId = req.query.calendarId || DEFAULT_CALENDAR_ID;
  const timeZone   = req.query.timeZone   || DEFAULT_TIMEZONE;

  const { startUtcMs, endUtcMs, ymd } = todayBoundaries(timeZone);

  // Google Calendar API requires RFC3339 with TZ offset/Z
  const timeMin = new Date(startUtcMs).toISOString(); // "2026-04-27T22:00:00.000Z" (UTC)
  const timeMax = new Date(endUtcMs).toISOString();

  try {
    const events = await fetchEvents({ calendarId, timeMin, timeMax, timeZone });
    const formatted = events.map(ev => formatEvent(ev, timeZone));

    res.json({
      ok: true,
      calendarId,
      timeZone,
      date: ymd,
      total: formatted.length,
      events: formatted,
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
