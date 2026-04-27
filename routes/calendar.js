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
function todayBoundaries(timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const ymd = fmt.format(new Date());
  const [year, month, day] = ymd.split("-").map(Number);

  // Compute target TZ offset for that day's noon (avoids DST edge issues at midnight)
  const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
  const noonInTz = new Date(noon).toLocaleString("en-US", { timeZone });
  const noonAsUtc = new Date(noonInTz + " UTC").getTime();
  const tzOffsetMs = noonAsUtc - noon;

  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - tzOffsetMs;
  const endUtcMs   = startUtcMs + 24 * 60 * 60 * 1000;

  return { startUtcMs, endUtcMs, ymd };
}

// ── Internal-attendee detection ──────────────────────────────────────────────
// An attendee is "internal" if:
//   - their email is on the @remide.xyz Workspace, OR
//   - their email is a Google Calendar proxy address (resource cals, group
//     cals, transferred-from cals — all live under *.calendar.google.com).
// Anything else counts as external.
function isInternalAttendee(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.endsWith("@remide.xyz")) return true;
  if (e.endsWith(".calendar.google.com")) return true;  // catches *.calendar.google.com
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

  // Keep only attendees that are external (not @remide.xyz, not GCal proxies)
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
    isInternal:  attendees.length === 0,   // no externals after filtering = internal
    eventType:   ev.eventType || "default",
  };
}

// ── GET /calendar/today ──────────────────────────────────────────────────────
// By default returns only events with at least one external attendee.
// Pass ?includeInternal=1 to get everything (focus blocks, team syncs, etc).
router.get("/today", async (req, res) => {
  const calendarId      = req.query.calendarId || DEFAULT_CALENDAR_ID;
  const timeZone        = req.query.timeZone   || DEFAULT_TIMEZONE;
  const includeInternal = req.query.includeInternal === "1" || req.query.includeInternal === "true";

  const { startUtcMs, endUtcMs, ymd } = todayBoundaries(timeZone);
  const timeMin = new Date(startUtcMs).toISOString();
  const timeMax = new Date(endUtcMs).toISOString();

  try {
    const events     = await fetchEvents({ calendarId, timeMin, timeMax, timeZone });
    const formatted  = events.map(ev => formatEvent(ev, timeZone));
    const visible    = includeInternal ? formatted : formatted.filter(ev => !ev.isInternal);

    res.json({
      ok: true,
      calendarId,
      timeZone,
      date: ymd,
      total: visible.length,
      hiddenInternal: includeInternal ? 0 : (formatted.length - visible.length),
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
// Returns ALL events in the range — including internal/focus blocks. Used by
// pre-call briefing triggers which need to see every meeting Anton has.
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
