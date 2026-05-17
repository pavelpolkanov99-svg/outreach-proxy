const { Bot } = require("grammy");
const axios   = require("axios");
const cron    = require("node-cron");

// ── Conversational layer modules (Phase 1-4) ──────────────────────────────────
// These are only exercised when CONVERSATIONAL_MODE_ENABLED === "true".
// require() is safe regardless — the modules are side-effect-free on load.
const agent          = require("./lib/agent");
const approvalFlow   = require("./lib/approval-flow");
const conversationStore = require("./lib/conversation-store");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const PROXY        = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION      = "4.23.0-conversational";
const STARTED_AT   = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const MORNING_PUSH_USERS = (process.env.MORNING_PUSH_USERS || "156632707")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const ANTON_TG_ID = process.env.ANTON_TG_ID
  ? parseInt(process.env.ANTON_TG_ID.trim(), 10)
  : null;

// ── Conversational mode feature flag ──────────────────────────────────────────
// When false (default), bot behaves exactly as before: slash commands only,
// any other text gets the "Команды:" reply. When true, non-command text is
// routed to the Claude agent. Toggle via Railway env, no redeploy needed.
const CONVERSATIONAL_MODE = process.env.CONVERSATIONAL_MODE_ENABLED === "true";

// Pavel's TG id is known; Anton's comes from ANTON_TG_ID env.
const PAVEL_TG_ID = 156632707;

const bot = new Bot(BOT_TOKEN);

process.on("uncaughtException", err => {
  console.error("[bot] Uncaught exception (ignored):", err.message);
});
process.on("unhandledRejection", err => {
  console.error("[bot] Unhandled rejection (ignored):", err?.message || err);
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function isAllowed(ctx) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(ctx.from?.id);
}

function guard(ctx, fn) {
  console.log(`[bot] msg from ${ctx.from?.id} (${ctx.from?.username || "no_username"}): ${ctx.message?.text || "no_text"}`);
  if (!isAllowed(ctx)) {
    console.log(`[bot] denied: ${ctx.from?.id} not in whitelist`);
    return ctx.reply("⛔ Access denied.");
  }
  return fn();
}

// Resolve a TG user id to a logical identity for the agent: "anton" | "pavel".
// Pavel is known by id. Anton is ANTON_TG_ID if set; otherwise any other
// allowed user is treated as "anton" (safe default until env is configured).
function whoIs(ctx) {
  const id = ctx.from?.id;
  if (id === PAVEL_TG_ID) return "pavel";
  if (ANTON_TG_ID && id === ANTON_TG_ID) return "anton";
  return "anton";
}

// ── HTML escape ──────────────────────────────────────────────────────────────
function esc(text) {
  return String(text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Markdown → Telegram HTML ─────────────────────────────────────────────────
// The conversational agent (Claude) tends to format replies in Markdown
// (**bold**, *italic*, `code`, # headers, - bullets). Telegram is sent with
// parse_mode "HTML", so raw Markdown shows literal ** and * to the user.
//
// This converts the common Markdown Claude produces into Telegram-safe HTML.
// Order matters: escape HTML special chars FIRST, then insert our own tags —
// otherwise the <b>/<i> tags we add would get escaped into &lt;b&gt;.
//
// Telegram HTML supports a small tag set: <b> <i> <u> <s> <code> <pre> <a>.
// No <h1>/<ul>/<li> — headers become bold lines, bullets become "• ".
function mdToTelegramHtml(md) {
  if (!md) return "";
  let s = String(md);

  // 1. Escape HTML special chars first.
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 2. Fenced code blocks ```...``` → <pre>. Done before inline code so the
  //    inline-backtick rule doesn't chew through fences.
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) => {
    return `<pre>${code.replace(/\n$/, "")}</pre>`;
  });

  // 3. Inline code `code` → <code>
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // 4. Bold: **text** or __text__ → <b>
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");

  // 5. Italic: *text* or _text_ → <i>
  //    Run after bold so the ** pairs are already consumed. The lookarounds
  //    avoid matching a stray asterisk mid-word.
  s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, "$1<i>$2</i>$3");
  s = s.replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, "$1<i>$2</i>$3");

  // 6. Markdown headers (#, ##, ###) → bold line (Telegram has no headers)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 7. Bullet markers at line start (-, *, +) → "• "
  s = s.replace(/^[ \t]*[-*+]\s+/gm, "• ");

  // 8. Markdown links [text](url) → <a href="url">text</a>
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  return s;
}

function renderClickableName(name, deeplinkUrl) {
  const safeName = esc(name);
  if (!deeplinkUrl) return `<b>${safeName}</b>`;
  return `<a href="${esc(deeplinkUrl)}"><b>${safeName}</b></a> 🔗`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      console.error(`[bot] ${label} timed out after ${ms}ms`);
      resolve({ __timeout: true });
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────────────────────────────────────
// Russian header
// ─────────────────────────────────────────────────────────────────────────────

const RU_MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function buildRussianHeaderDate() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Prague",
    year:    "numeric",
    month:   "numeric",
    day:     "numeric",
    weekday: "short",
  });
  const parts = fmt.formatToParts(new Date());
  const day   = parseInt(parts.find(p => p.type === "day").value,   10);
  const month = parseInt(parts.find(p => p.type === "month").value, 10);
  const wkShort = parts.find(p => p.type === "weekday").value;

  const wkMap = {
    Sun: "воскресенье", Mon: "понедельник", Tue: "вторник",
    Wed: "среда",       Thu: "четверг",     Fri: "пятница",
    Sat: "суббота",
  };
  const weekday = wkMap[wkShort] || "";

  return `${day} ${RU_MONTHS[month - 1]}, ${weekday}`;
}

function buildLeanHeader() {
  return `☀️ <b>Доброе утро.</b> ${buildRussianHeaderDate()}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message splitting
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MESSAGE_LEN = 4000;
const SECTION_SEP = "\n\n━━━━━━━━━━━━━━━\n\n";

function splitForTelegram(text) {
  if (!text || text.length <= MAX_MESSAGE_LEN) return [text];

  const sections = text.split(SECTION_SEP);
  const chunks = [];
  let current = "";

  for (const section of sections) {
    const wouldBe = current
      ? current + SECTION_SEP + section
      : section;
    if (wouldBe.length <= MAX_MESSAGE_LEN) {
      current = wouldBe;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (section.length <= MAX_MESSAGE_LEN) {
      current = section;
      continue;
    }

    let remaining = section;
    while (remaining.length > MAX_MESSAGE_LEN) {
      let cutAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LEN);
      if (cutAt < MAX_MESSAGE_LEN / 2) cutAt = MAX_MESSAGE_LEN;
      chunks.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).trimStart();
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks;
}

async function editAndSplit(ctx, loadingMsg, fullText, opts = {}) {
  const chunks = splitForTelegram(fullText);
  const sendOpts = {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...opts,
  };

  await ctx.api.editMessageText(
    ctx.chat.id, loadingMsg.message_id, chunks[0], sendOpts
  );

  for (let i = 1; i < chunks.length; i++) {
    await ctx.api.sendMessage(ctx.chat.id, chunks[i], sendOpts);
  }
}

async function sendSplit(userId, fullText, opts = {}) {
  const chunks = splitForTelegram(fullText);
  const sendOpts = {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...opts,
  };
  for (const chunk of chunks) {
    await bot.api.sendMessage(userId, chunk, sendOpts);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(isoDate) {
  if (!isoDate) return null;
  const ts = Date.parse(isoDate);
  if (isNaN(ts)) return null;
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function tierFromCompany(company) {
  if (!company) return null;
  const tags = company.tags || [];
  const hkTag = tags.find(t => /^Hard Kill\s*-\s*HK/i.test(t));
  if (hkTag) {
    const m = hkTag.match(/HK-?(\d+)/i);
    return { hardKill: true, code: m ? `HK-${m[1]}` : "HK", emoji: "🔴" };
  }
  const score = company.bdScore;
  if (score == null) return null;
  if (score >= 9.0)  return { tier: "MH", emoji: "🟢", score };
  if (score >= 7.5)  return { tier: "P1", emoji: "🟢", score };
  if (score >= 5.0)  return { tier: "P2", emoji: "🟡", score };
  return { tier: "P3", emoji: "⚪", score };
}

const HK_DESCRIPTIONS = {
  "HK-1":  "RWA tokenization only",
  "HK-2":  "DeFi-native, no KYC",
  "HK-3":  "Traditional private banking",
  "HK-4":  "Custody/trading only",
  "HK-5":  "Consulting/advisory",
  "HK-6":  "Merchant payments / e-commerce",
  "HK-7":  "Pure fiat BaaS, no crypto rails",
  "HK-8":  "Retail-only on-ramp widget",
  "HK-9":  "Payroll / HR cross-border",
  "HK-10": "Compliance/analytics SaaS",
  "HK-11": "Media/news/research",
};

const NET_BADGE = {
  "LI": "💼", "LinkedIn": "💼",
  "TG": "✈️", "Telegram": "✈️",
  "WA": "💚", "WhatsApp": "💚",
};

const NETWORK_HEADER_EMOJI = (header) => {
  if (header === "LinkedIn") return "💼";
  if (header === "Telegram") return "✈️";
  if (header.startsWith("WhatsApp")) return "💚";
  return "💬";
};

const TASK_PRIORITY_EMOJI = {
  "High":   "🔴",
  "Medium": "🟡",
  "Low":    "⚪",
};

function dueLabel(daysOverdue) {
  if (daysOverdue == null)       return "";
  if (daysOverdue > 0)           return ` · <b>${daysOverdue}d overdue</b>`;
  if (daysOverdue === 0)         return " · <b>today</b>";
  return ` · in ${Math.abs(daysOverdue)}d`;
}

function shortStartTime(timeRange) {
  if (!timeRange) return "";
  const m = String(timeRange).match(/^(\d{1,2}:\d{2})/);
  return m ? m[1] : timeRange;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAN render helpers (used in /today)
// ─────────────────────────────────────────────────────────────────────────────

function renderEventLean(ev) {
  const lines = [];
  const startTime = shortStartTime(ev.timeRange);

  if (ev.isInternal) {
    lines.push(`<code>${startTime}</code>  <b>${esc(ev.summary)}</b> · <i>internal/focus</i>`);
    return lines.join("\n");
  }

  const indent = "       ";
  const crm = ev.notion;
  const p   = ev.attendeePerson;
  const headlineParts = [];

  if (p) {
    const personName = p.name || p.email?.split("@")[0] || null;
    if (personName) {
      const linkPart = p.linkedin ? ` <a href="${esc(p.linkedin)}">↗</a>` : "";
      headlineParts.push(`${esc(personName)}${linkPart}`);
    }
  }

  if (crm?.name) {
    headlineParts.push(`<b>${esc(crm.name)}</b>`);
  } else if (ev.primaryDomain) {
    headlineParts.push(`<b>${esc(ev.primaryDomain)}</b>`);
  }

  if (crm) {
    const t = tierFromCompany(crm);
    if (t?.hardKill) {
      const hkDesc = HK_DESCRIPTIONS[t.code] || "Hard Kill";
      headlineParts.push(`🔴 <b>Hard Kill — ${esc(t.code)}</b>`);
      lines.push(`<code>${startTime}</code>  ${headlineParts.join(" · ")}`);
      lines.push(`${indent}└ <i>${esc(hkDesc)} · Anton, замни диалог</i>`);
      if (ev.meetUrl) {
        lines.push(`${indent}<a href="${esc(ev.meetUrl)}">Join</a> → ${esc(ev.meetUrl.replace(/^https?:\/\//, ""))}`);
      }
      return lines.join("\n");
    }
    if (t) {
      const stagePart = crm.stage ? ` · ${esc(crm.stage)}` : "";
      headlineParts.push(`${t.emoji} <b>${t.tier}</b> ${t.score}${stagePart}`);
    } else if (crm.stage) {
      headlineParts.push(`⚪ ${esc(crm.stage)}`);
    }
  } else {
    headlineParts.push(`🆕 <i>not in CRM</i>`);
  }

  if (headlineParts.length === 0) {
    headlineParts.push(`<b>${esc(ev.summary)}</b>`);
  }

  lines.push(`<code>${startTime}</code>  ${headlineParts.join(" · ")}`);

  if (crm?.insight?.bullets?.length) {
    const top = crm.insight.bullets[0];
    if (top) lines.push(`${indent}└ ${esc(top)}`);
  }

  if (ev.meetUrl) {
    const shortUrl = ev.meetUrl.replace(/^https?:\/\//, "");
    lines.push(`${indent}<a href="${esc(ev.meetUrl)}">Join</a> → ${esc(shortUrl)}`);
  }

  return lines.join("\n");
}

function renderStaleDealLean(deal) {
  const stage = deal.stage || "";
  const isHotStage = stage === "Negotiations" || stage === "Call Scheduled";
  const emoji = isHotStage ? "🔴" : "🟡";

  const stageShort = stage.replace(/discussions/i, "").trim();
  const days = deal.daysStale != null ? `${deal.daysStale}д` : "?";
  const headline = `${emoji} <b>${esc(deal.name)}</b> (${esc(stageShort)} · ${days})`;

  if (isHotStage && deal.lastActivitySnippet) {
    return `${headline} — <i>${esc(deal.lastActivitySnippet)}</i>`;
  }
  return headline;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL render helpers (used in /details and /full — old format)
// ─────────────────────────────────────────────────────────────────────────────

function renderTask(task) {
  const lines = [];
  const emoji = TASK_PRIORITY_EMOJI[task.priority] || "⚪";
  const due = dueLabel(task.daysOverdue);
  const nameSafe = task.name.length > 80 ? task.name.slice(0, 77) + "..." : task.name;
  lines.push(`${emoji} <b>${esc(nameSafe)}</b>${due}`);

  const indent = "   ";
  if (task.description && task.description.length > 5) {
    lines.push(`${indent}<i>${esc(task.description)}</i>`);
  }
  if (task.companyName) {
    lines.push(`${indent}🏢 ${esc(task.companyName)}`);
  }
  return lines.join("\n");
}

function renderTaskGroup(group) {
  const lines = [];
  const emoji = TASK_PRIORITY_EMOJI[group.priority] || "⚪";
  const due = dueLabel(group.daysOverdue);
  const titleSafe = group.template.length > 80
    ? group.template.slice(0, 77) + "..."
    : group.template;
  lines.push(`${emoji} <b>${esc(titleSafe)}</b>  · <b>×${group.count}</b>${due}`);

  const companies = group.companies || [];
  if (companies.length > 0) {
    const SHOW = 5;
    const visible = companies.slice(0, SHOW).map(esc);
    const overflow = companies.length > SHOW ? ` · +${companies.length - SHOW}` : "";
    lines.push(`   🏢 ${visible.join(" · ")}${overflow}`);
  }
  return lines.join("\n");
}

function renderTaskItem(item) {
  if (item.kind === "group") return renderTaskGroup(item);
  return renderTask(item.task);
}

function renderCompletedTask(task) {
  const lines = [];
  const completedDate = task.completedAt ? daysAgo(task.completedAt) : null;
  const dateLabel = completedDate ? ` · <i>${completedDate}</i>` : "";
  const nameSafe = task.name.length > 80 ? task.name.slice(0, 77) + "..." : task.name;
  lines.push(`✅ ${esc(nameSafe)}${dateLabel}`);
  if (task.companyName) {
    lines.push(`   🏢 ${esc(task.companyName)}`);
  }
  return lines.join("\n");
}

function renderReply(reply) {
  const lines = [];
  const networkBadge = NET_BADGE[reply.networkFull] || NET_BADGE[reply.network] || "💬";
  const idle = reply.hoursIdle != null ? `${Math.round(reply.hoursIdle)}h` : "?";
  const networkLabel = reply.networkFull || reply.network || "Chat";

  const clickableName = renderClickableName(reply.name, reply.deeplink);
  lines.push(`${networkBadge} ${clickableName} · ${esc(networkLabel)} · <b>${idle}</b>`);

  const indent = "   ";
  const snippet = (reply.lastMsgText || "").slice(0, 200);
  if (snippet) {
    lines.push(`${indent}<i>"${esc(snippet)}"</i>`);
  }

  if (reply.notion?.name) {
    const t = tierFromCompany(reply.notion);
    const parts = [`🟢 <b>${esc(reply.notion.name)}</b>`];
    if (t && !t.hardKill) parts.push(`${t.tier} · ${t.score}`);
    else if (reply.notion.bdScore != null) parts.push(`BD ${reply.notion.bdScore}`);
    if (reply.notion.stage) parts.push(esc(reply.notion.stage));
    lines.push(`${indent}${parts.join(" · ")}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCalendar() {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/calendar/today`, { timeout: 20_000 });
    console.log(`[bot] calendar fetched in ${Date.now() - t0}ms`);
    return r.data;
  } catch (err) {
    console.error(`[bot] calendar fetch failed in ${Date.now() - t0}ms:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function fetchStaleDeals({ days = 14, limit = 5 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/notion/stale-deals-enriched`, {
      params: { days, limit }, timeout: 18_000,
    });
    return r.data?.deals || [];
  } catch (err) {
    console.warn(`[bot] stale-enriched failed in ${Date.now() - t0}ms:`, err.message);
  }
  try {
    const r = await axios.get(`${PROXY}/notion/stale-deals`, {
      params: { days, limit }, timeout: 15_000,
    });
    return r.data?.deals || [];
  } catch (err) {
    console.error(`[bot] stale (plain) failed:`, err.message);
    return null;
  }
}

async function fetchTasksToday({ limit = 20 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, {
      params: { limit }, timeout: 15_000,
    });
    const data = r.data || {};
    const items = Array.isArray(data.items) ? data.items
                : Array.isArray(data.tasks) ? data.tasks.map(t => ({ kind: "single", task: t }))
                : [];
    const tasksFlat  = Array.isArray(data.tasks) ? data.tasks : [];
    const totalRaw   = data.total ?? tasksFlat.length;
    const overdueRaw = tasksFlat.filter(t => t.daysOverdue > 0).length;
    return { items, totalRaw, overdueRaw };
  } catch (err) {
    console.error(`[bot] tasks fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

async function fetchTasksCompleted({ days = 3, limit = 20 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-completed`, {
      params: { days, limit }, timeout: 12_000,
    });
    return Array.isArray(r.data?.tasks) ? r.data.tasks : [];
  } catch (err) {
    console.error(`[bot] completed-tasks fetch failed:`, err.message);
    return null;
  }
}

async function fetchRepliesWaitingResilient({ hoursIdle = 4, limit = 8, days = 7 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/beeper/replies-waiting`, {
      params: { hoursIdle, limit, days }, timeout: 15_000,
    });
    return { source: "beeper", replies: r.data?.replies || [] };
  } catch (err) {
    console.warn(`[bot] beeper failed (will fallback to hub):`, err.message);
  }
  try {
    const r = await axios.get(`${PROXY}/messaging-hub/replies-waiting`, {
      params: { hoursIdle, limit, days }, timeout: 12_000,
    });
    return { source: "messaging-hub", replies: r.data?.replies || [] };
  } catch (err) {
    console.error(`[bot] hub fetch failed:`, err.message);
    return null;
  }
}

async function fetchYesterdaySummary() {
  try {
    const r = await axios.get(`${PROXY}/yesterday/summary`, { timeout: 60_000 });
    return r.data;
  } catch (err) {
    console.error(`[bot] yesterday summary failed:`, err.message);
    return null;
  }
}

// v4.22: fetch the new structured payload from /today/lean
async function fetchTodayLean() {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/today/lean`, { timeout: 60_000 });
    const d = r.data || {};
    console.log(`[bot] today-lean fetched in ${Date.now() - t0}ms · mainMoves=${d.mainMoves?.length || 0} · replies=${d.repliesWaiting?.length || 0} · stuck=${d.stuckNoDeadline?.length || 0} · win=${d.yesterdayPipeline?.win?.length || 0} · movement=${d.yesterdayPipeline?.movement?.length || 0}`);
    return d;
  } catch (err) {
    console.error(`[bot] today-lean failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAN section builders (for /today) — v4.22 founder-focused format
// ─────────────────────────────────────────────────────────────────────────────

function buildCalendarSectionLean(calendarRes) {
  if (calendarRes && calendarRes.__timeout) {
    return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\n<i>⚠️ Календарь не ответил.</i>`;
  }
  if (!calendarRes || !calendarRes.ok) {
    return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\n<i>❌ Calendar error: ${esc(calendarRes?.error || "unknown")}</i>`;
  }
  if (!calendarRes.events?.length) {
    return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\nКалендарь пустой 🌴`;
  }
  const blocks = calendarRes.events.map(renderEventLean);
  return (
    `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b> · <i>${calendarRes.total}</i>\n` +
    `\n` +
    blocks.join("\n\n")
  );
}

// v4.22: NEW — structured main moves with action + context
function buildMainMovesSection(leanData) {
  if (!leanData || leanData.__timeout) return null;
  const moves = leanData.mainMoves || [];
  if (moves.length === 0) return null;

  const lines = moves.map((m, i) => {
    const rank = m.rank || (i + 1);
    const tierEmoji = m.tierEmoji || "";
    const tierLabel = m.tierLabel ? `<b>${esc(m.tierLabel)}</b>` : "";
    const company = m.company ? `<b>${esc(m.company)}</b>` : "";
    const action = m.action ? esc(m.action) : "";
    const context = m.context ? esc(m.context) : "";

    // Header: "1. 🟢 BCB Group (MH 8.9) — написать Paul follow-up..."
    const tierPart = tierEmoji && tierLabel ? `${tierEmoji} ${tierLabel}` : (tierEmoji || tierLabel);
    const headerBits = [company];
    if (tierPart) headerBits.push(tierPart);
    const header = `${rank}. ${headerBits.filter(Boolean).join(" · ")} — ${action}`;
    if (context) {
      return `${header}\n   ↳ <i>${context}</i>`;
    }
    return header;
  });

  return (
    `🎯 <b>ГЛАВНЫЕ ХОДЫ</b> · <i>${moves.length}</i>\n` +
    `\n` +
    lines.join("\n\n")
  );
}

// v4.22: NEW — replies waiting (inbound from non-CRM/low-tier)
function buildRepliesWaitingSection(leanData) {
  if (!leanData || leanData.__timeout) return null;
  const replies = leanData.repliesWaiting || [];
  if (replies.length === 0) return null;

  const lines = replies.map(r => {
    const networkBadge = NET_BADGE[r.network] || "💬";
    const tierEmoji = r.tierEmoji || "";
    const tierLabel = r.tierLabel ? esc(r.tierLabel) : "";
    const idle = r.daysIdle ? ` · ${esc(r.daysIdle)}` : "";
    const name = r.name ? `<b>${esc(r.name)}</b>` : "";
    const networkPart = r.network ? esc(r.network) : "";

    // Header: "• Anastasia Skrypnyk · LinkedIn · 🆕 not in CRM · 2д"
    const meta = [networkPart, tierEmoji + (tierLabel ? " " + tierLabel : "")]
      .filter(s => s && s.trim()).join(" · ");
    const header = `${networkBadge} ${name}${meta ? " · " + meta : ""}${idle}`;
    const context = r.context ? `   <i>${esc(r.context)}</i>` : "";
    return context ? `${header}\n${context}` : header;
  });

  return (
    `💬 <b>ОТВЕТЫ ЖДУТ</b> · <i>${replies.length}</i>\n` +
    `\n` +
    lines.join("\n\n")
  );
}

// v4.22: NEW — stuck deals without deadline, one-liner compressed
function buildStuckNoDeadlineSection(leanData) {
  if (!leanData || leanData.__timeout) return null;
  const stuck = leanData.stuckNoDeadline || [];
  if (stuck.length === 0) return null;

  const parts = stuck.map(s => {
    const name = esc(s.name || "?");
    const days = s.daysStuck != null ? `${s.daysStuck}д` : "?д";
    const stage = s.stageShort ? `, ${esc(s.stageShort)}` : "";
    return `<b>${name}</b> (${days}${stage})`;
  });

  return (
    `🪦 <b>STUCK БЕЗ DEADLINE</b> · <i>${stuck.length}</i>\n` +
    parts.join(" · ") +
    `\n<i>↳ snooze, Lost, или попытка — посмотри на неделе · /stale</i>`
  );
}

// v4.22: REPLACED — yesterday pipeline (only win + movement, no risks/newContacts)
function buildYesterdayPipelineSection(leanData) {
  if (!leanData || leanData.__timeout) return null;
  const yp = leanData.yesterdayPipeline || {};
  const win      = Array.isArray(yp.win)      ? yp.win      : [];
  const movement = Array.isArray(yp.movement) ? yp.movement : [];

  if (win.length === 0 && movement.length === 0) return null;

  const sections = [];
  if (win.length > 0) {
    sections.push(
      `✅ <b>Win</b>\n` +
      win.map(b => `   • ${esc(b)}`).join("\n")
    );
  }
  if (movement.length > 0) {
    sections.push(
      `🔄 <b>Movement</b> <i>(не требует действий сегодня)</i>\n` +
      movement.map(b => `   • ${esc(b)}`).join("\n")
    );
  }

  return (
    `📊 <b>ВЧЕРА В PIPELINE</b>\n` +
    `\n` +
    sections.join("\n\n")
  );
}

// Legacy stale section kept for /details and /stale commands
function buildStaleSectionLean(stale) {
  if (stale && stale.__timeout) {
    return `🟡 <b>ЗАГЛОХЛИ · решить</b>\n\n<i>⚠️ Notion не ответил по сделкам.</i>`;
  }
  if (!Array.isArray(stale) || stale.length === 0) return null;

  const hot  = stale.filter(d => d.stage === "Negotiations" || d.stage === "Call Scheduled");
  const warm = stale.filter(d => !(d.stage === "Negotiations" || d.stage === "Call Scheduled"));

  const lines = [];
  for (const d of hot) {
    lines.push(renderStaleDealLean(d));
  }

  if (warm.length > 0) {
    const compact = warm.map(d => {
      const stageShort = (d.stage || "").replace(/discussions/i, "").trim();
      const days = d.daysStale != null ? `${d.daysStale}д` : "?";
      return `${esc(d.name)} (${esc(stageShort)} · ${days})`;
    }).join(", ");
    lines.push(`🟡 ${compact}`);
  }

  return (
    `🟡 <b>ЗАГЛОХЛИ · решить</b>\n` +
    `\n` +
    lines.join("\n")
  );
}

function buildFooter() {
  return `<i>/details · /full · /stale · /replies</i>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL section builders (used in /details and /full)
// ─────────────────────────────────────────────────────────────────────────────

function buildTasksSectionFull(tasksData, completedTasks) {
  if (!tasksData || tasksData.__timeout) {
    return `📋 <b>Задачи</b>\n\n<i>⚠️ Notion не ответил по задачам.</i>`;
  }

  if (tasksData.items?.length) {
    const { items, totalRaw, overdueRaw } = tasksData;
    const counter = overdueRaw > 0
      ? `<i>${totalRaw} задач · ${overdueRaw} просрочено</i>`
      : `<i>${totalRaw} задач на сегодня</i>`;
    return (
      `📋 <b>Задачи</b>  · ${counter}\n` +
      `\n` +
      items.map(renderTaskItem).join("\n\n")
    );
  }

  if (Array.isArray(completedTasks) && completedTasks.length > 0) {
    const top = completedTasks.slice(0, 8);
    const overflow = completedTasks.length > top.length
      ? `\n\n<i>...и ещё ${completedTasks.length - top.length} закрытых задач</i>`
      : "";
    return (
      `✅ <b>Все задачи под контролем</b>  · <i>${completedTasks.length} закрыто за 3 дня</i>\n` +
      `\n` +
      top.map(renderCompletedTask).join("\n") +
      overflow
    );
  }

  return null;
}

function buildRepliesSectionFull(repliesResult) {
  if (!repliesResult) return null;
  const { source, replies } = repliesResult;
  if (!Array.isArray(replies) || replies.length === 0) return null;

  const sourceLabel = source === "messaging-hub" ? " · <i>из Messaging Hub</i>" : "";

  return (
    `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>${sourceLabel}\n` +
    `\n` +
    replies.map(renderReply).join("\n\n")
  );
}

function buildYesterdaySectionFull(summary) {
  if (!summary) {
    return `📆 <b>Что было вчера</b>\n\n<i>⚠️ Не удалось получить summary мессенджеров.</i>`;
  }
  if (!summary.ok) {
    return null;
  }
  const networks = summary.networks || [];

  const isFiltered = summary.filteredBy === "late-stages";
  let filterTag = "";
  if (isFiltered) {
    const dropCount = summary.dropped || 0;
    filterTag = dropCount > 0
      ? `  · <i>только важные сделки (скрыто ${dropCount} не-важных)</i>`
      : `  · <i>только важные сделки</i>`;
  }

  let sourceLabel = "";
  if (summary.source === "hub-fresh") {
    sourceLabel = `  · <i>из Messaging Hub</i>`;
  } else if (summary.source === "hub-stale") {
    sourceLabel = `  · <i>данные за ${esc(summary.dataDate)}</i>`;
  } else if (summary.source === "hub-empty") {
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности не было.</i>`;
  }

  if (networks.length === 0) {
    if (isFiltered && summary.totalBeforeFilter > 0) {
      return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности по поздним статусам не было (всего ${summary.totalBeforeFilter} чатов, все early-stage или не в CRM).</i>`;
    }
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности не было.</i>`;
  }

  const blocks = [];
  for (const net of networks) {
    const lines = [];
    const emoji = NETWORK_HEADER_EMOJI(net.header);
    const totalLabel = net.totalChats > 0
      ? `  · <i>${net.totalChats} чатов</i>`
      : "";
    lines.push(`${emoji} <b>${esc(net.header)}</b>${totalLabel}`);

    const bullets = (net.summary?.bullets || []).filter(Boolean);
    if (bullets.length > 0) {
      lines.push("");
      for (const b of bullets) {
        lines.push(`   • ${esc(b)}`);
      }
    }

    if (Array.isArray(net.topChats) && net.topChats.length > 0 && summary.source !== "hub-stale") {
      lines.push("");
      for (const c of net.topChats) {
        const arrow = c.direction === "→" ? "→" : "←";
        const displayName = (c.name || "").length > 40
          ? (c.name || "").slice(0, 40) + "..."
          : c.name;
        const clickableName = renderClickableName(displayName, c.deeplink);
        const stagePart = c.crmStage ? ` <i>(${esc(c.crmStage)})</i>` : "";
        const safeSnippet = esc(c.snippet || "");
        lines.push(`   <code>${arrow}</code> ${clickableName}${stagePart}: <i>${safeSnippet}</i>`);
      }
    }

    blocks.push(lines.join("\n"));
  }

  return (
    `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n` +
    `\n` +
    blocks.join("\n\n")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Composers — /today (lean), /details (full sources), /full (everything)
// ─────────────────────────────────────────────────────────────────────────────

// /today — v4.22 founder-focused lean digest
function composeLeanDigest({ calendarRes, leanData }, { customHeader } = {}) {
  const sections = [];
  sections.push(customHeader || buildLeanHeader());

  sections.push(buildCalendarSectionLean(calendarRes));

  const mainMoves = buildMainMovesSection(leanData);
  if (mainMoves) sections.push(mainMoves);

  const repliesWaiting = buildRepliesWaitingSection(leanData);
  if (repliesWaiting) sections.push(repliesWaiting);

  const stuckCompressed = buildStuckNoDeadlineSection(leanData);
  if (stuckCompressed) sections.push(stuckCompressed);

  const yesterdayPipeline = buildYesterdayPipelineSection(leanData);
  if (yesterdayPipeline) sections.push(yesterdayPipeline);

  sections.push(buildFooter());

  return sections.join(SECTION_SEP);
}

// /details — full source data (Tasks DB + Replies waiting + Stale)
function composeDetailsDigest({ calendarRes, tasksData, stale, repliesResult, completedTasks }, { customHeader } = {}) {
  const sections = [];
  if (customHeader) sections.push(customHeader);
  else sections.push(`📋 <b>ДЕТАЛИ</b> · <i>полные источники</i>`);

  sections.push(buildCalendarSectionLean(calendarRes));

  const tasksBlock = buildTasksSectionFull(tasksData, completedTasks);
  if (tasksBlock) sections.push(tasksBlock);

  const repliesBlock = buildRepliesSectionFull(repliesResult);
  if (repliesBlock) sections.push(repliesBlock);

  const staleBlock = buildStaleSectionLean(stale);
  if (staleBlock) sections.push(staleBlock);

  return sections.join(SECTION_SEP);
}

// /full — everything
function composeFullDigest(allData, { customHeader } = {}) {
  const sections = [];
  if (customHeader) sections.push(customHeader);
  else sections.push(`🗂 <b>ПОЛНЫЙ ДАЙДЖЕСТ</b>`);

  sections.push(buildCalendarSectionLean(allData.calendarRes));

  const mainMoves = buildMainMovesSection(allData.leanData);
  if (mainMoves) sections.push(mainMoves);

  const repliesWaiting = buildRepliesWaitingSection(allData.leanData);
  if (repliesWaiting) sections.push(repliesWaiting);

  const stuckCompressed = buildStuckNoDeadlineSection(allData.leanData);
  if (stuckCompressed) sections.push(stuckCompressed);

  const yesterdayPipeline = buildYesterdayPipelineSection(allData.leanData);
  if (yesterdayPipeline) sections.push(yesterdayPipeline);

  const tasksBlock = buildTasksSectionFull(allData.tasksData, allData.completedTasks);
  if (tasksBlock) sections.push(tasksBlock);

  const repliesBlock = buildRepliesSectionFull(allData.repliesResult);
  if (repliesBlock) sections.push(repliesBlock);

  const yesterdayBlock = buildYesterdaySectionFull(allData.yesterdaySummary);
  if (yesterdayBlock) sections.push(yesterdayBlock);

  const staleBlock = buildStaleSectionLean(allData.stale);
  if (staleBlock) sections.push(staleBlock);

  return sections.join(SECTION_SEP);
}

// ─────────────────────────────────────────────────────────────────────────────
// Data fetchers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLeanDigestData() {
  const t0 = Date.now();
  const [calendarRes, leanData] = await Promise.all([
    withTimeout(fetchCalendar(),                                          20_000, "calendar"),
    withTimeout(fetchTodayLean(),                                         65_000, "today-lean"),
  ]);
  console.log(`[bot] lean digest data fetched in ${Date.now() - t0}ms`);
  return { calendarRes, leanData };
}

async function fetchDetailsData() {
  const t0 = Date.now();
  const [calendarRes, tasksData, stale, repliesResult] = await Promise.all([
    withTimeout(fetchCalendar(),                                          20_000, "calendar"),
    withTimeout(fetchTasksToday({ limit: 20 }),                           15_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 10 }),                 20_000, "stale"),
    withTimeout(fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 }), 30_000, "replies"),
  ]);

  let completedTasks = null;
  if (tasksData && !tasksData.__timeout && (!tasksData.items || tasksData.items.length === 0)) {
    completedTasks = await withTimeout(
      fetchTasksCompleted({ days: 3, limit: 20 }), 12_000, "completed-tasks"
    );
    if (completedTasks?.__timeout) completedTasks = null;
  }

  console.log(`[bot] details data fetched in ${Date.now() - t0}ms`);
  return { calendarRes, tasksData, stale, repliesResult, completedTasks };
}

async function fetchAllData() {
  const t0 = Date.now();
  const [calendarRes, leanData, tasksData, stale, repliesResult, yesterdaySummary] = await Promise.all([
    withTimeout(fetchCalendar(),                                          20_000, "calendar"),
    withTimeout(fetchTodayLean(),                                         65_000, "today-lean"),
    withTimeout(fetchTasksToday({ limit: 20 }),                           15_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 10 }),                 20_000, "stale"),
    withTimeout(fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 }), 30_000, "replies"),
    withTimeout(fetchYesterdaySummary(),                                  65_000, "yesterday-summary"),
  ]);

  let completedTasks = null;
  if (tasksData && !tasksData.__timeout && (!tasksData.items || tasksData.items.length === 0)) {
    completedTasks = await withTimeout(
      fetchTasksCompleted({ days: 3, limit: 20 }), 12_000, "completed-tasks"
    );
    if (completedTasks?.__timeout) completedTasks = null;
  }

  const ySummary = (yesterdaySummary && !yesterdaySummary.__timeout) ? yesterdaySummary : null;

  console.log(`[bot] full data fetched in ${Date.now() - t0}ms`);
  return { calendarRes, leanData, tasksData, stale, repliesResult, completedTasks, yesterdaySummary: ySummary };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversational layer — handlers (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────
//
// Only active when CONVERSATIONAL_MODE === true. Routes plain (non-slash) text
// messages to the Claude agent, renders agent results, and handles approval
// inline-keyboard callbacks.

// Render an agent result object into Telegram messages.
// `statusMsg` is the "⏳ Думаю..." message we can edit into the final answer.
async function renderAgentResult(ctx, statusMsg, result) {
  // Budget warning — check once, append if just crossed
  let budgetNote = "";
  try {
    const crossing = conversationStore.checkBudgetCrossing();
    if (crossing) {
      budgetNote = `\n\n<i>💸 Сегодня потрачено $${crossing.costUsd.toFixed(2)} — дневной бюджет $${crossing.budgetDailyUsd} пройден (${crossing.msgs} сообщений). Не блокирую, просто для инфо.</i>`;
    }
  } catch (_) { /* budget check is best-effort */ }

  if (result.kind === "final") {
    const text = (result.text && result.text.trim())
      ? result.text
      : "(пустой ответ)";
    // Claude formats in Markdown; convert to Telegram HTML so **bold** etc.
    // render properly instead of showing literal asterisks.
    await editAndSplit(ctx, statusMsg, mdToTelegramHtml(text) + budgetNote);
    return;
  }

  if (result.kind === "approval") {
    const { pending } = result;
    const { approvalId } = approvalFlow.createApproval(pending);
    const summary = pending.approvalSummary || `Выполнить ${pending.toolName}`;
    const body =
      `🔐 <b>Нужно подтверждение</b>\n\n` +
      `${summary}\n\n` +
      `<i>Это write-операция. Подтверди или отклони.</i>` +
      budgetNote;
    await ctx.api.editMessageText(
      ctx.chat.id, statusMsg.message_id, body,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: approvalFlow.buildInlineKeyboard(approvalId),
      }
    );
    return;
  }

  if (result.kind === "tool_failed") {
    const body =
      `⚠️ <b>Не получилось выполнить</b> <code>${esc(result.toolName)}</code>\n` +
      `Попробовал ${result.attempts || 2} раза. Ошибка:\n<i>${esc(result.error || "unknown")}</i>\n\n` +
      `@Rvn2332 — глянь логи?\n\n` +
      `<i>Напиши что делать — попробую заново или поменяю параметры.</i>` +
      budgetNote;
    await ctx.api.editMessageText(
      ctx.chat.id, statusMsg.message_id, body,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
    return;
  }

  if (result.kind === "cancelled") {
    // Superseded by a newer turn — quietly note it. Don't spam.
    await ctx.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `<i>↩️ Запрос отменён (пришло новое сообщение).</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Unknown kind — defensive
  await ctx.api.editMessageText(
    ctx.chat.id, statusMsg.message_id,
    `<i>Неизвестный результат агента: ${esc(result.kind)}</i>`,
    { parse_mode: "HTML" }
  );
}

// Handle a plain text message in conversational mode.
async function handleConversation(ctx) {
  const text = ctx.message?.text || "";
  const from = whoIs(ctx);
  const fromUserId = ctx.from?.id;

  const statusMsg = await ctx.reply("⏳ Думаю...");

  try {
    const result = await agent.runAgentTurn({ text, from, fromUserId });
    await renderAgentResult(ctx, statusMsg, result);
  } catch (err) {
    console.error("[bot] handleConversation error:", err.message);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, statusMsg.message_id,
        `❌ Внутренняя ошибка: ${esc(err.message)}\n\n@Rvn2332`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}
  }
}

// Handle an approval button tap.
async function handleApprovalCallback(ctx) {
  const data = ctx.callbackQuery?.data || "";
  const parsed = approvalFlow.parseCallbackData(data);
  if (!parsed) {
    // Not ours — ignore silently
    return ctx.answerCallbackQuery();
  }

  const { approvalId, decision } = parsed;
  const approved = decision === "yes";

  // Acknowledge the tap immediately so the spinner stops
  await ctx.answerCallbackQuery({
    text: approved ? "✅ Выполняю..." : "❌ Отменено",
  });

  const resolved = approvalFlow.resolveApproval(approvalId, approved);

  if (!resolved.ok) {
    let msg;
    if (resolved.reason === "already_resolved") {
      msg = `<i>Уже обработано ранее (${resolved.priorApproved ? "выполнено" : "отклонено"}).</i>`;
    } else if (resolved.reason === "expired") {
      msg = `<i>⏱ Подтверждение устарело (&gt;30 мин). Запрос отменён — повтори если нужно.</i>`;
    } else if (resolved.reason === "stale") {
      msg = `<i>↩️ Подтверждение неактуально (был новый запрос). Отменено.</i>`;
    } else {
      msg = `<i>Подтверждение не найдено. Возможно бот перезапускался — повтори запрос.</i>`;
    }
    try {
      await ctx.editMessageText(msg, { parse_mode: "HTML" });
    } catch (_) {
      await ctx.reply(msg, { parse_mode: "HTML" });
    }
    return;
  }

  // Update the approval message to show the decision was registered
  const decisionLabel = approved ? "✅ Подтверждено" : "❌ Отклонено";
  try {
    await ctx.editMessageText(
      `${decisionLabel} — ${approved ? "выполняю" : "не выполняю"}...`,
      { parse_mode: "HTML" }
    );
  } catch (_) {}

  // Continue the agent loop
  const statusMsg = await ctx.reply("⏳ Продолжаю...");
  try {
    const result = await agent.continueAfterApproval({
      pending:  resolved.pending,
      approved: resolved.approved,
    });
    await renderAgentResult(ctx, statusMsg, result);
  } catch (err) {
    console.error("[bot] handleApprovalCallback error:", err.message);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, statusMsg.message_id,
        `❌ Ошибка после подтверждения: ${esc(err.message)}\n\n@Rvn2332`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", ctx => guard(ctx, () => {
  const convLine = CONVERSATIONAL_MODE
    ? `\n💬 <b>Чат-режим включён</b> — пиши обычным текстом, отвечу как Claude с доступом к Notion/Beeper/Apollo/Calendar.\n`
    : "";
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n` +
    convLine +
    `\nКоманды:\n` +
    `/ping — health check\n` +
    `/today — дайджест на сегодня (founder-focused)\n` +
    `/details — полные данные: задачи + replies + stale\n` +
    `/full — всё включая Что было вчера по сетям\n` +
    `/yesterday — что было вчера в мессенджерах\n` +
    `/digest — отправить Anton'у (или себе если ID не задан)\n` +
    `/tasks — открытые задачи\n` +
    `/stale — заглохшие сделки (>14d)\n` +
    `/replies — ждут ответа Anton'а\n` +
    (CONVERSATIONAL_MODE ? `/new — сбросить контекст чата\n/budget — расход за сегодня\n` : "") +
    `\nАвто:\n` +
    `• Утренний дайджест 08:30 CET\n` +
    `• CRM auto-prewarm 23:00 и 08:00 CET`,
    { parse_mode: "HTML" }
  );
}));

bot.command("ping", ctx => guard(ctx, () => {
  const now = new Date();
  const uptimeSec = Math.floor((now - STARTED_AT) / 1000);
  const uptimeStr = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  return ctx.reply(
    `🏓 pong\n\n` +
    `Версия: ${VERSION}\n` +
    `Uptime: ${uptimeStr}\n` +
    `Server: ${now.toISOString()}\n` +
    `Chat mode: ${CONVERSATIONAL_MODE ? "ON" : "OFF"}\n` +
    `Anton TG ID: ${ANTON_TG_ID || "не задан (env ANTON_TG_ID)"}\n` +
    `Your TG ID: ${ctx.from?.id}`
  );
}));

bot.command("today", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Тяну дайджест (Haiku merge ~30s)...");
  try {
    const data = await fetchLeanDigestData();
    const text = composeLeanDigest(data);
    await editAndSplit(ctx, loadingMsg, text);
    console.log(`[bot] /today completed in ${Date.now() - t0}ms (${text.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /today] error:", errMsg);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Ошибка: ${esc(errMsg)}`
      );
    } catch (_) {}
  }
}));

bot.command("details", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Полные данные (без Haiku)...");
  try {
    const data = await fetchDetailsData();
    const text = composeDetailsDigest(data);
    await editAndSplit(ctx, loadingMsg, text);
    console.log(`[bot] /details completed in ${Date.now() - t0}ms (${text.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /details] error:", errMsg);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Ошибка: ${esc(errMsg)}`
      );
    } catch (_) {}
  }
}));

bot.command("full", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Полный дайджест (lean + details + yesterday, ~60s)...");
  try {
    const data = await fetchAllData();
    const text = composeFullDigest(data);
    await editAndSplit(ctx, loadingMsg, text);
    console.log(`[bot] /full completed in ${Date.now() - t0}ms (${text.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /full] error:", errMsg);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Ошибка: ${esc(errMsg)}`
      );
    } catch (_) {}
  }
}));

bot.command("yesterday", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Собираю summary мессенджеров за вчера (~30-60s)...");
  try {
    const summary = await fetchYesterdaySummary();
    if (!summary) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Не удалось получить summary за вчера.`
      );
    }
    const block = buildYesterdaySectionFull(summary);
    if (!block) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `📆 <b>Что было вчера</b>\n\n<i>АктивBIGINTERNAL</i>`,
        { parse_mode: "HTML" }
      );
    }
    await editAndSplit(ctx, loadingMsg, block);
    console.log(`[bot] /yesterday completed in ${Date.now() - t0}ms (${block.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /yesterday] error:", errMsg);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Ошибка: ${esc(errMsg)}`
      );
    } catch (_) {}
  }
}));

bot.command("digest", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply(
    ANTON_TG_ID
      ? "⏳ Собираю lean дайджест для Anton'а..."
      : "⏳ Собираю lean дайджест (тестовый — пришлю только тебе)..."
  );

  try {
    const data = await fetchLeanDigestData();

    if (ANTON_TG_ID) {
      const customHeader = `${buildLeanHeader()}\n<i>(отправлен Pavel вручную)</i>`;
      const text = composeLeanDigest(data, { customHeader });
      await sendSplit(ANTON_TG_ID, text);

      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ Дайджест отправлен Anton'у (TG ID ${ANTON_TG_ID}).`,
        { parse_mode: "HTML" }
      );
    } else {
      const customHeader = `🧪 <b>Тестовый дайджест</b> · ANTON_TG_ID не задан, шлю тебе\n\n${buildLeanHeader()}`;
      const text = composeLeanDigest(data, { customHeader });
      await editAndSplit(ctx, loadingMsg, text);
    }
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /digest] error:", errMsg);
    await ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

bot.command("tasks", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую Tasks Tracker...");
  try {
    const tasksData = await fetchTasksToday({ limit: 30 });
    if (tasksData === null) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Не удалось получить задачи из Notion.`
      );
    }
    if (!tasksData.items.length) {
      const completed = await fetchTasksCompleted({ days: 3, limit: 20 });
      if (Array.isArray(completed) && completed.length > 0) {
        const top = completed.slice(0, 10);
        const overflow = completed.length > top.length
          ? `\n\n<i>...и ещё ${completed.length - top.length}</i>`
          : "";
        const text =
          `✅ <b>Все задачи под контролем</b>  · <i>${completed.length} закрыто за 3 дня</i>\n\n` +
          top.map(renderCompletedTask).join("\n") +
          overflow;
        return editAndSplit(ctx, loadingMsg, text);
      }
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Все задачи под контролем</b>\n\nНи открытых задач, ни закрытых за 3 дня.`,
        { parse_mode: "HTML" }
      );
    }
    const text = buildTasksSectionFull(tasksData, null);
    return editAndSplit(ctx, loadingMsg, text);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

bot.command("stale", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую CRM...");
  try {
    const stale = await fetchStaleDeals({ days: 14, limit: 10 });
    if (stale === null) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Не удалось получить данные из CRM.`
      );
    }
    if (stale.length === 0) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Pipeline здоров</b>\n\nНет сделок без активности &gt;14d среди MH/P1/P2.`,
        { parse_mode: "HTML" }
      );
    }
    const block = buildStaleSectionLean(stale);
    return editAndSplit(ctx, loadingMsg, block);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

bot.command("replies", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую мессенджеры...");
  try {
    const result = await fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 });
    if (!result) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Beeper и Messaging Hub оба недоступны.`
      );
    }
    if (result.replies.length === 0) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Inbox чист</b>\n\nНет чатов где Anton ещё не ответил &gt;4h.`,
        { parse_mode: "HTML" }
      );
    }
    const block = buildRepliesSectionFull(result);
    return editAndSplit(ctx, loadingMsg, block);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

// ── Conversational-mode commands (only meaningful when CONVERSATIONAL_MODE) ────

bot.command("new", ctx => guard(ctx, () => {
  if (!CONVERSATIONAL_MODE) {
    return ctx.reply("Чат-режим выключен. /new недоступна.");
  }
  try {
    const res = conversationStore.resetConversation({ keepSummary: true, reason: "/new command" });
    approvalFlow.invalidateAll("/new command");
    return ctx.reply(
      `🆕 Контекст сброшен (было ${res.oldTurns} реплик).` +
      (res.keptSummary ? `\n<i>Краткое summary прошлого разговора сохранено.</i>` : ""),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    return ctx.reply(`❌ Не получилось сбросить: ${esc(err.message)}`);
  }
}));

bot.command("budget", ctx => guard(ctx, () => {
  if (!CONVERSATIONAL_MODE) {
    return ctx.reply("Чат-режим выключен. /budget недоступна.");
  }
  try {
    const view = conversationStore.getView();
    const c = view.costsToday;
    return ctx.reply(
      `💸 <b>Расход за сегодня</b>\n\n` +
      `Потрачено: $${(c.usd || 0).toFixed(4)}\n` +
      `Сообщений: ${c.msgs || 0}\n` +
      `Дневной бюджет: $${view.budgetDailyUsd} (soft — не блокирую)\n` +
      `Реплик в контексте: ${view.totalTurns}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    return ctx.reply(`❌ Ошибка: ${esc(err.message)}`);
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Plain text handler — routes to conversational agent OR shows command list
// ─────────────────────────────────────────────────────────────────────────────

bot.on("message:text", ctx => guard(ctx, () => {
  const text = ctx.message?.text || "";

  // Slash commands that weren't matched by a bot.command() handler above
  // (e.g. a typo'd /foo). Keep old behavior — show the command list.
  const isSlash = text.trim().startsWith("/");

  if (CONVERSATIONAL_MODE && !isSlash) {
    // Route to the Claude agent
    return handleConversation(ctx);
  }

  // Default (conversational mode off, OR an unrecognized slash command)
  return ctx.reply(
    `Команды:\n/start  /ping  /today  /details  /full  /yesterday  /digest  /tasks  /stale  /replies` +
    (CONVERSATIONAL_MODE ? `  /new  /budget` : "")
  );
}));

// ── Approval inline-keyboard callback handler ────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  // Only conversational mode produces approval buttons
  if (!CONVERSATIONAL_MODE) {
    return ctx.answerCallbackQuery();
  }
  // Auth check — only allowed users can resolve approvals
  if (!isAllowed(ctx)) {
    return ctx.answerCallbackQuery({ text: "⛔ Access denied" });
  }
  try {
    await handleApprovalCallback(ctx);
  } catch (err) {
    console.error("[bot] callback_query handler error:", err.message);
    try { await ctx.answerCallbackQuery({ text: "Ошибка обработки" }); } catch (_) {}
  }
});

bot.catch(err => {
  console.error("[bot] Error:", err.message);
});

// ── Morning push cron ────────────────────────────────────────────────────────
async function sendMorningPush() {
  if (MORNING_PUSH_USERS.length === 0) {
    console.log("[cron] morning push skipped — no recipients");
    return;
  }
  console.log(`[cron] morning push start, recipients: ${MORNING_PUSH_USERS.join(",")}`);
  try {
    const data = await fetchLeanDigestData();
    const text = composeLeanDigest(data);
    for (const userId of MORNING_PUSH_USERS) {
      try {
        await sendSplit(userId, text);
        console.log(`[cron] morning push sent to ${userId} (${text.length} chars)`);
      } catch (err) {
        console.error(`[cron] morning push to ${userId} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("[cron] morning push aggregate failed:", err.message);
  }
}

cron.schedule("30 8 * * *", sendMorningPush, { timezone: "Europe/Prague" });
console.log("[cron] morning push registered (08:30 Europe/Prague, every day)");

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[bot] Loop OS FCC ${VERSION} starting...`);
console.log(`[bot] Proxy URL: ${PROXY}`);
console.log(`[bot] Anton TG ID: ${ANTON_TG_ID || "(not set)"}`);
console.log(`[bot] Morning push recipients: ${MORNING_PUSH_USERS.join(",") || "(none)"}`);
console.log(`[bot] Conversational mode: ${CONVERSATIONAL_MODE ? "ENABLED" : "disabled"}`);
bot.start().then(() => {
  console.log(`[bot] Loop OS FCC ${VERSION} started at ${STARTED_AT.toISOString()}`);
}).catch(err => {
  console.error("[bot] Start error (non-fatal):", err.message);
});
