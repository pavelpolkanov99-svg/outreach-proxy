const { Bot } = require("grammy");
const axios   = require("axios");
const cron    = require("node-cron");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const PROXY        = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION      = "4.20.0-lean-haiku";
const STARTED_AT   = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const MORNING_PUSH_USERS = (process.env.MORNING_PUSH_USERS || "156632707")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const ANTON_TG_ID = process.env.ANTON_TG_ID
  ? parseInt(process.env.ANTON_TG_ID.trim(), 10)
  : null;

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

// ── HTML escape ──────────────────────────────────────────────────────────────
function esc(text) {
  return String(text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
// Russian-localized header
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

  return `Сегодня ${day} ${RU_MONTHS[month - 1]}, ${weekday}.`;
}

function buildLeanHeader() {
  return `☀️ <b>Доброе утро.</b> ${buildRussianHeaderDate()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message splitting (Telegram 4096 char limit)
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
  await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, chunks[0], sendOpts);
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
// Render helpers — lean for /today, full for /details and /full
// ─────────────────────────────────────────────────────────────────────────────

// Lean event renderer (used in /today)
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

// Lean stale renderer
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

// Full event renderer (used in /full)
function renderEventFull(ev) {
  const lines = [];
  const title = esc(ev.summary);
  lines.push(`<code>${ev.timeRange}</code>  <b>${title}</b>`);

  if (ev.isInternal) {
    lines.push(`             <i>internal/focus</i>`);
    return lines.join("\n");
  }

  const indent = "             ";

  if (ev.primaryDomain) {
    lines.push(`${indent}🌐 ${esc(ev.primaryDomain)}`);
  }

  const p = ev.attendeePerson;
  if (p) {
    const personName = p.name || p.email?.split("@")[0] || "?";
    const titlePart  = p.title ? ` — ${esc(p.title)}` : "";
    const linkPart   = p.linkedin ? ` · <a href="${esc(p.linkedin)}">LinkedIn</a>` : "";
    lines.push(`${indent}👤 ${esc(personName)}${titlePart}${linkPart}`);
  }

  const crm = ev.notion;
  if (crm) {
    const t = tierFromCompany(crm);
    if (t?.hardKill) {
      const hkDesc = HK_DESCRIPTIONS[t.code] || "Hard Kill";
      lines.push(`${indent}🔴 <b>Hard Kill — ${esc(t.code)}</b> · ${esc(hkDesc)}`);
      lines.push(`${indent}   <i>Anton, замни диалог</i>`);
    } else if (t) {
      const stagePart = crm.stage ? ` · ${esc(crm.stage)}` : "";
      const lastTouch = daysAgo(crm.lastContact);
      const touchPart = lastTouch ? ` · last touch ${lastTouch}` : "";
      lines.push(`${indent}${t.emoji} <b>${t.tier}</b> · ${t.score}${stagePart}${touchPart}`);
    } else if (crm.stage) {
      lines.push(`${indent}⚪ ${esc(crm.stage)}`);
    }

    if (crm.description) {
      const shortDesc = crm.description.split(/\n\s*\n/)[0].trim();
      const truncated = shortDesc.length > 180 ? shortDesc.slice(0, 177) + "..." : shortDesc;
      lines.push(`${indent}📝 ${esc(truncated)}`);
    }

    if (crm.insight?.bullets?.length) {
      const refreshDate = crm.insight.refreshedAt ? ` <i>(${esc(crm.insight.refreshedAt.slice(0, 10))})</i>` : "";
      lines.push(`${indent}🔍 <b>Refreshed</b>${refreshDate}:`);
      for (const b of crm.insight.bullets) {
        lines.push(`${indent}   • ${esc(b)}`);
      }
    }

    const visibleTags = (crm.tags || []).filter(t => !/^(MH|P1|P2|P3|Hard Kill)/i.test(t));
    if (visibleTags.length) {
      lines.push(`${indent}🏷 ${visibleTags.slice(0, 6).map(esc).join(" · ")}`);
    }
  } else {
    lines.push(`${indent}🆕 <i>not in CRM</i> — cron подхватит ночью`);
  }

  if (ev.meetUrl) {
    lines.push(`${indent}📞 <a href="${esc(ev.meetUrl)}">Join</a>`);
  }

  return lines.join("\n");
}

function renderStaleDealFull(deal) {
  const lines = [];
  const stage = deal.stage || "";
  const isHotStage = stage === "Negotiations" || stage === "Call Scheduled";
  const emoji = isHotStage ? "🔴" : "🟡";

  const stagePart = stage ? ` · ${esc(stage)}` : "";
  lines.push(`${emoji} <b>${esc(deal.name)}</b>${stagePart}`);

  const indent = "   ";
  const t = tierFromCompany(deal);
  const ctxParts = [];
  if (t && !t.hardKill) ctxParts.push(`${t.tier} · ${t.score}`);
  else if (deal.bdScore != null) ctxParts.push(`BD ${deal.bdScore}`);
  if (deal.priority) ctxParts.push(deal.priority);
  if (deal.pipeline) ctxParts.push(deal.pipeline);
  if (ctxParts.length) lines.push(`${indent}<i>${ctxParts.map(esc).join(" · ")}</i>`);

  if (deal.daysStale != null) {
    lines.push(`${indent}📅 <b>Нет активности ${deal.daysStale}д</b>`);
  }
  if (deal.lastActivitySnippet) {
    lines.push(`${indent}💬 <i>"${esc(deal.lastActivitySnippet)}"</i>`);
  }

  return lines.join("\n");
}

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
  const titleSafe = group.template.length > 80 ? group.template.slice(0, 77) + "..." : group.template;
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
// Fetchers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCalendar() {
  try {
    const r = await axios.get(`${PROXY}/calendar/today`, { timeout: 20_000 });
    return r.data;
  } catch (err) {
    console.error("[bot] calendar failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function fetchTodayLean() {
  try {
    const r = await axios.get(`${PROXY}/today/lean`, { timeout: 60_000 });
    console.log(`[bot] /today/lean fetched in ${r.data?.elapsed || "?"}ms (todo=${r.data?.todoToday?.length || 0}, ai=${r.data?.aiAvailable})`);
    return r.data;
  } catch (err) {
    console.error("[bot] /today/lean failed:", err.message);
    return null;
  }
}

async function fetchStaleDeals({ days = 14, limit = 10 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/notion/stale-deals-enriched`, {
      params: { days, limit }, timeout: 18_000,
    });
    return r.data?.deals || [];
  } catch (err) {
    console.warn("[bot] stale-enriched failed, trying plain:", err.message);
  }
  try {
    const r = await axios.get(`${PROXY}/notion/stale-deals`, {
      params: { days, limit }, timeout: 15_000,
    });
    return r.data?.deals || [];
  } catch (err) {
    console.error("[bot] stale failed:", err.message);
    return null;
  }
}

async function fetchTasksToday({ limit = 20 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, {
      params: { limit }, timeout: 15_000,
    });
    const data = r.data || {};
    const items = Array.isArray(data.items) ? data.items
                : Array.isArray(data.tasks) ? data.tasks.map(t => ({ kind: "single", task: t }))
                : [];
    const tasksFlat  = Array.isArray(data.tasks) ? data.tasks : [];
    return {
      items,
      totalRaw: data.total ?? tasksFlat.length,
      overdueRaw: tasksFlat.filter(t => t.daysOverdue > 0).length,
    };
  } catch (err) {
    console.error("[bot] tasks failed:", err.message);
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
    console.error("[bot] completed-tasks failed:", err.message);
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
    console.warn("[bot] beeper failed, trying hub:", err.message);
  }
  try {
    const r = await axios.get(`${PROXY}/messaging-hub/replies-waiting`, {
      params: { hoursIdle, limit, days }, timeout: 12_000,
    });
    return { source: "messaging-hub", replies: r.data?.replies || [] };
  } catch (err) {
    console.error("[bot] hub failed:", err.message);
    return null;
  }
}

async function fetchYesterdaySummary() {
  try {
    const r = await axios.get(`${PROXY}/yesterday/summary`, { timeout: 60_000 });
    return r.data;
  } catch (err) {
    console.error("[bot] yesterday summary failed:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section builders — LEAN (for /today)
// ─────────────────────────────────────────────────────────────────────────────

function buildCalendarSectionLean(calendarRes) {
  if (calendarRes?.__timeout) {
    return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\n<i>⚠️ Календарь не ответил.</i>`;
  }
  if (!calendarRes || !calendarRes.ok) {
    return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\n<i>❌ ${esc(calendarRes?.error || "unknown")}</i>`;
  }
  if (!calendarRes.events?.length) {
    return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\nКалендарь пустой 🌴`;
  }
  const blocks = calendarRes.events.map(renderEventLean);
  return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b> · <i>${calendarRes.total}</i>\n\n${blocks.join("\n\n")}`;
}

// 🔥 СДЕЛАТЬ СЕГОДНЯ — Haiku-driven, numbered list
function buildTodoTodaySection(leanData) {
  if (!leanData?.todoToday?.length) return null;
  const lines = leanData.todoToday.map((item, i) =>
    `${i + 1}. ${esc(item)}`
  );
  return `🔥 <b>СДЕЛАТЬ СЕГОДНЯ</b> · <i>${leanData.todoToday.length}</i>\n\n${lines.join("\n")}`;
}

// 📊 ВЧЕРА В PIPELINE — Haiku-driven, 3 categories
function buildYesterdayPipelineSection(leanData) {
  if (!leanData?.yesterdayPipeline) return null;
  const { movement = [], risks = [], newContacts = [] } = leanData.yesterdayPipeline;

  if (movement.length === 0 && risks.length === 0 && newContacts.length === 0) {
    return null;
  }

  const blocks = [];

  if (movement.length > 0) {
    const items = movement.map(m => `   • ${esc(m)}`).join("\n");
    blocks.push(`✅ <b>Movement</b>\n${items}`);
  }
  if (risks.length > 0) {
    const items = risks.map(r => `   • ${esc(r)}`).join("\n");
    blocks.push(`⚠️ <b>Risks</b>\n${items}`);
  }
  if (newContacts.length > 0) {
    const items = newContacts.map(n => `   • ${esc(n)}`).join("\n");
    blocks.push(`🆕 <b>Новые контакты не в CRM</b>\n${items}`);
  }

  return `📊 <b>ВЧЕРА В PIPELINE</b>\n\n${blocks.join("\n\n")}`;
}

// 🟡 ЗАГЛОХЛИ — same as v4.19 lean
function buildStaleSectionLean(stale) {
  if (stale?.__timeout) {
    return `🟡 <b>ЗАГЛОХЛИ · решить</b>\n\n<i>⚠️ Notion не ответил.</i>`;
  }
  if (!Array.isArray(stale) || stale.length === 0) return null;

  const hot  = stale.filter(d => d.stage === "Negotiations" || d.stage === "Call Scheduled");
  const warm = stale.filter(d => !(d.stage === "Negotiations" || d.stage === "Call Scheduled"));

  const lines = [];
  for (const d of hot) lines.push(renderStaleDealLean(d));

  if (warm.length > 0) {
    const compact = warm.map(d => {
      const stageShort = (d.stage || "").replace(/discussions/i, "").trim();
      const days = d.daysStale != null ? `${d.daysStale}д` : "?";
      return `${esc(d.name)} (${esc(stageShort)} · ${days})`;
    }).join(", ");
    lines.push(`🟡 ${compact}`);
  }

  return `🟡 <b>ЗАГЛОХЛИ · решить</b>\n\n${lines.join("\n")}`;
}

function buildFooterLean() {
  return `<i>/details для деталей · /full для полного дайджеста</i>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section builders — FULL (for /details and /full)
// ─────────────────────────────────────────────────────────────────────────────

function buildCalendarSectionFull(calendarRes) {
  if (calendarRes?.__timeout) {
    return `📅 <b>Сегодня</b>\n\n<i>⚠️ Календарь не ответил.</i>`;
  }
  if (!calendarRes || !calendarRes.ok) {
    return `📅 <b>Сегодня</b>\n\n<i>❌ Calendar error: ${esc(calendarRes?.error || "unknown")}</i>`;
  }
  if (!calendarRes.events?.length) {
    return `📅 <b>Сегодня (${esc(calendarRes.date)})</b>\n\nКалендарь пустой 🌴`;
  }
  const blocks = calendarRes.events.map(renderEventFull);
  return `📅 <b>Сегодня (${esc(calendarRes.date)})</b>  · <i>${calendarRes.total} встреч</i>\n\n${blocks.join("\n\n")}`;
}

function buildTasksSectionResilient(tasksData, completedTasks) {
  if (!tasksData || tasksData.__timeout) {
    return `📋 <b>Задачи</b>\n\n<i>⚠️ Notion не ответил.</i>`;
  }

  if (tasksData.items?.length) {
    const { items, totalRaw, overdueRaw } = tasksData;
    const counter = overdueRaw > 0
      ? `<i>${totalRaw} задач · ${overdueRaw} просрочено</i>`
      : `<i>${totalRaw} задач на сегодня</i>`;
    return `📋 <b>Задачи</b>  · ${counter}\n\n${items.map(renderTaskItem).join("\n\n")}`;
  }

  if (Array.isArray(completedTasks) && completedTasks.length > 0) {
    const top = completedTasks.slice(0, 8);
    const overflow = completedTasks.length > top.length
      ? `\n\n<i>...и ещё ${completedTasks.length - top.length} закрытых задач</i>`
      : "";
    return `✅ <b>Все задачи под контролем</b>  · <i>${completedTasks.length} закрыто за 3 дня</i>\n\n${top.map(renderCompletedTask).join("\n")}${overflow}`;
  }

  return null;
}

function buildRepliesSection(repliesResult) {
  if (!repliesResult) return null;
  const { source, replies } = repliesResult;
  if (!Array.isArray(replies) || replies.length === 0) return null;

  const sourceLabel = source === "messaging-hub" ? " · <i>из Messaging Hub</i>" : "";
  return `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>${sourceLabel}\n\n${replies.map(renderReply).join("\n\n")}`;
}

function buildStaleSectionFull(stale) {
  if (stale?.__timeout) {
    return `🟡 <b>Заглохли</b>\n\n<i>⚠️ Notion не ответил.</i>`;
  }
  if (!Array.isArray(stale) || stale.length === 0) return null;
  const dealBlocks = stale.map(renderStaleDealFull);
  return `🟡 <b>Заглохли</b>  · <i>${stale.length} сделок &gt;14d</i>\n\n${dealBlocks.join("\n\n")}`;
}

function buildYesterdaySectionFull(summary) {
  if (!summary) return `📆 <b>Что было вчера</b>\n\n<i>⚠️ Не удалось получить summary.</i>`;
  if (!summary.ok) return null;
  const networks = summary.networks || [];

  const isFiltered = summary.filteredBy === "late-stages";
  let filterTag = "";
  if (isFiltered) {
    const dropCount = summary.dropped || 0;
    filterTag = dropCount > 0
      ? `  · <i>только важные сделки (скрыто ${dropCount})</i>`
      : `  · <i>только важные сделки</i>`;
  }

  let sourceLabel = "";
  if (summary.source === "hub-fresh") sourceLabel = `  · <i>из Messaging Hub</i>`;
  else if (summary.source === "hub-stale") sourceLabel = `  · <i>данные за ${esc(summary.dataDate)}</i>`;
  else if (summary.source === "hub-empty") {
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности не было.</i>`;
  }

  if (networks.length === 0) {
    if (isFiltered && summary.totalBeforeFilter > 0) {
      return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности по поздним статусам не было.</i>`;
    }
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности не было.</i>`;
  }

  const blocks = [];
  for (const net of networks) {
    const lines = [];
    const emoji = NETWORK_HEADER_EMOJI(net.header);
    const totalLabel = net.totalChats > 0 ? `  · <i>${net.totalChats} чатов</i>` : "";
    lines.push(`${emoji} <b>${esc(net.header)}</b>${totalLabel}`);

    const bullets = (net.summary?.bullets || []).filter(Boolean);
    if (bullets.length > 0) {
      lines.push("");
      for (const b of bullets) lines.push(`   • ${esc(b)}`);
    }

    if (Array.isArray(net.topChats) && net.topChats.length > 0 && summary.source !== "hub-stale") {
      lines.push("");
      for (const c of net.topChats) {
        const arrow = c.direction === "→" ? "→" : "←";
        const displayName = (c.name || "").length > 40 ? (c.name || "").slice(0, 40) + "..." : c.name;
        const clickableName = renderClickableName(displayName, c.deeplink);
        const stagePart = c.crmStage ? ` <i>(${esc(c.crmStage)})</i>` : "";
        const safeSnippet = esc(c.snippet || "");
        lines.push(`   <code>${arrow}</code> ${clickableName}${stagePart}: <i>${safeSnippet}</i>`);
      }
    }
    blocks.push(lines.join("\n"));
  }

  return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n${blocks.join("\n\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composers
// ─────────────────────────────────────────────────────────────────────────────

// Lean digest (for /today and morning push)
async function composeLeanDigest({ customHeader } = {}) {
  const t0 = Date.now();
  const [calendarRes, leanData, stale] = await Promise.all([
    withTimeout(fetchCalendar(), 22_000, "calendar"),
    withTimeout(fetchTodayLean(), 65_000, "today-lean"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 10 }), 20_000, "stale"),
  ]);
  console.log(`[bot] lean data fetched in ${Date.now() - t0}ms`);

  const sections = [];
  sections.push(customHeader || buildLeanHeader());
  sections.push(buildCalendarSectionLean(calendarRes));

  const todoBlock = buildTodoTodaySection(leanData);
  if (todoBlock) sections.push(todoBlock);

  const yesterdayBlock = buildYesterdayPipelineSection(leanData);
  if (yesterdayBlock) sections.push(yesterdayBlock);

  const staleBlock = buildStaleSectionLean(stale);
  if (staleBlock) sections.push(staleBlock);

  sections.push(buildFooterLean());

  return sections.join(SECTION_SEP);
}

// Full digest (for /full — all the v4.19 stuff)
async function composeFullDigest({ customHeader, withYesterday = true } = {}) {
  const t0 = Date.now();
  const [calendarRes, tasksData, stale, repliesResult, yesterdaySummary] = await Promise.all([
    withTimeout(fetchCalendar(),                                                    20_000, "calendar"),
    withTimeout(fetchTasksToday({ limit: 20 }),                                     15_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 5 }),                            20_000, "stale"),
    withTimeout(fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 8, days: 7 }), 30_000, "replies"),
    withYesterday
      ? withTimeout(fetchYesterdaySummary(),                                        65_000, "yesterday")
      : Promise.resolve(null),
  ]);

  let completedTasks = null;
  if (tasksData && !tasksData.__timeout && (!tasksData.items || tasksData.items.length === 0)) {
    completedTasks = await withTimeout(fetchTasksCompleted({ days: 3, limit: 20 }), 12_000, "completed-tasks");
    if (completedTasks?.__timeout) completedTasks = null;
  }

  const ySummary = (yesterdaySummary && !yesterdaySummary.__timeout) ? yesterdaySummary : null;
  console.log(`[bot] full data fetched in ${Date.now() - t0}ms`);

  const sections = [];
  sections.push(customHeader || buildLeanHeader());
  sections.push(buildCalendarSectionFull(calendarRes));

  const tasksBlock = buildTasksSectionResilient(tasksData, completedTasks);
  if (tasksBlock) sections.push(tasksBlock);

  const repliesBlock = buildRepliesSection(repliesResult);
  if (repliesBlock) sections.push(repliesBlock);

  if (withYesterday) {
    const yesterdayBlock = buildYesterdaySectionFull(ySummary);
    if (yesterdayBlock) sections.push(yesterdayBlock);
  }

  const staleBlock = buildStaleSectionFull(stale);
  if (staleBlock) sections.push(staleBlock);

  return sections.join(SECTION_SEP);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n\n` +
    `Команды:\n` +
    `/today — lean дайджест (главное за сегодня + Сделать сегодня + Вчера в pipeline)\n` +
    `/details — задачи + чаты ждущие ответа отдельно\n` +
    `/full — полный дайджест с разбивкой по сетям\n\n` +
    `/yesterday — что было вчера (raw)\n` +
    `/tasks — открытые задачи\n` +
    `/stale — заглохшие сделки\n` +
    `/replies — ждут ответа\n` +
    `/digest — отправить Anton'у\n` +
    `/ping — health check\n\n` +
    `Авто:\n` +
    `• Утренний дайджест 08:30 CET (lean)\n` +
    `• CRM auto-prewarm 23:00 и 08:00 CET`
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
    `Anton TG ID: ${ANTON_TG_ID || "не задан"}\n` +
    `Your TG ID: ${ctx.from?.id}`
  );
}));

bot.command("today", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Собираю lean дайджест (~30-60s)...");
  try {
    const text = await composeLeanDigest();
    await editAndSplit(ctx, loadingMsg, text);
    console.log(`[bot] /today completed in ${Date.now() - t0}ms (${text.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /today] error:", errMsg);
    try {
      await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(errMsg)}`);
    } catch (_) {}
  }
}));

bot.command("details", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Собираю детальный дайджест (без раздела вчера)...");
  try {
    const text = await composeFullDigest({ withYesterday: false });
    await editAndSplit(ctx, loadingMsg, text);
    console.log(`[bot] /details completed in ${Date.now() - t0}ms (${text.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /details] error:", errMsg);
    try {
      await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(errMsg)}`);
    } catch (_) {}
  }
}));

bot.command("full", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Собираю полный дайджест (~60s)...");
  try {
    const text = await composeFullDigest({ withYesterday: true });
    await editAndSplit(ctx, loadingMsg, text);
    console.log(`[bot] /full completed in ${Date.now() - t0}ms (${text.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /full] error:", errMsg);
    try {
      await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(errMsg)}`);
    } catch (_) {}
  }
}));

bot.command("yesterday", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Собираю summary мессенджеров за вчера (~30-60s)...");
  try {
    const summary = await fetchYesterdaySummary();
    if (!summary) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Не удалось получить summary за вчера.`);
    }
    const block = buildYesterdaySectionFull(summary);
    if (!block) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `📆 <b>Что было вчера</b>\n\n<i>Активности не было.</i>`, { parse_mode: "HTML" });
    }
    await editAndSplit(ctx, loadingMsg, block);
    console.log(`[bot] /yesterday completed in ${Date.now() - t0}ms (${block.length} chars)`);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /yesterday] error:", errMsg);
    try {
      await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(errMsg)}`);
    } catch (_) {}
  }
}));

bot.command("digest", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply(
    ANTON_TG_ID ? "⏳ Собираю lean дайджест для Anton'а..." : "⏳ Собираю lean дайджест (тестовый — пришлю только тебе)..."
  );

  try {
    if (ANTON_TG_ID) {
      const customHeader = `${buildLeanHeader()}\n<i>(отправлен Pavel вручную)</i>`;
      const text = await composeLeanDigest({ customHeader });

      await sendSplit(ANTON_TG_ID, text);

      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ Lean дайджест отправлен Anton'у (TG ID ${ANTON_TG_ID}).`,
        { parse_mode: "HTML" }
      );
    } else {
      const customHeader = `🧪 <b>Тестовый дайджест</b> · ANTON_TG_ID не задан, шлю тебе\n\n${buildLeanHeader()}`;
      const text = await composeLeanDigest({ customHeader });
      await editAndSplit(ctx, loadingMsg, text);
    }
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /digest] error:", errMsg);
    await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(errMsg)}`);
  }
}));

bot.command("tasks", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую Tasks Tracker...");
  try {
    const tasksData = await fetchTasksToday({ limit: 30 });
    if (tasksData === null) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Не удалось получить задачи.`);
    }
    if (!tasksData.items.length) {
      const completed = await fetchTasksCompleted({ days: 3, limit: 20 });
      if (Array.isArray(completed) && completed.length > 0) {
        const top = completed.slice(0, 10);
        const overflow = completed.length > top.length ? `\n\n<i>...и ещё ${completed.length - top.length}</i>` : "";
        const text = `✅ <b>Все задачи под контролем</b>  · <i>${completed.length} закрыто за 3 дня</i>\n\n${top.map(renderCompletedTask).join("\n")}${overflow}`;
        return editAndSplit(ctx, loadingMsg, text);
      }
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ <b>Все задачи под контролем</b>\n\nНи открытых задач, ни закрытых за 3 дня.`, { parse_mode: "HTML" });
    }
    const text = buildTasksSectionResilient(tasksData, null);
    return editAndSplit(ctx, loadingMsg, text);
  } catch (err) {
    return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`);
  }
}));

bot.command("stale", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую CRM...");
  try {
    const stale = await fetchStaleDeals({ days: 14, limit: 10 });
    if (stale === null) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Не удалось получить данные.`);
    }
    if (stale.length === 0) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ <b>Pipeline здоров</b>\n\nНет сделок без активности &gt;14d.`, { parse_mode: "HTML" });
    }
    const block = buildStaleSectionLean(stale);
    return editAndSplit(ctx, loadingMsg, block);
  } catch (err) {
    return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`);
  }
}));

bot.command("replies", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую мессенджеры...");
  try {
    const result = await fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 });
    if (!result) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Beeper и Hub оба недоступны.`);
    }
    if (result.replies.length === 0) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ <b>Inbox чист</b>\n\nНет чатов где Anton ждёт.`, { parse_mode: "HTML" });
    }
    const block = buildRepliesSection(result);
    return editAndSplit(ctx, loadingMsg, block);
  } catch (err) {
    return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`);
  }
}));

bot.on("message:text", ctx => guard(ctx, () => {
  return ctx.reply(`Команды:\n/today  /details  /full  /yesterday  /tasks  /stale  /replies  /digest  /ping`);
}));

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
    const text = await composeLeanDigest();
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
console.log("[cron] morning push registered (08:30 Europe/Prague)");

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[bot] Loop OS FCC ${VERSION} starting...`);
console.log(`[bot] Proxy URL: ${PROXY}`);
console.log(`[bot] Anton TG ID: ${ANTON_TG_ID || "(not set)"}`);
console.log(`[bot] Morning push recipients: ${MORNING_PUSH_USERS.join(",") || "(none)"}`);
bot.start().then(() => {
  console.log(`[bot] Loop OS FCC ${VERSION} started at ${STARTED_AT.toISOString()}`);
}).catch(err => {
  console.error("[bot] Start error:", err.message);
});
