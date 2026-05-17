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
function buildMainMovesS