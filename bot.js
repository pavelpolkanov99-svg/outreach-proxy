const { Bot } = require("grammy");
const axios   = require("axios");
const cron    = require("node-cron");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const PROXY        = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION      = "4.14.0-yesterday-block";
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

// Per-network header emoji for the yesterday block
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

// ── Render helpers ───────────────────────────────────────────────────────────

function renderEvent(ev) {
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
      lines.push(
        `${indent}${t.emoji} <b>${t.tier}</b> · ${t.score}${stagePart}${touchPart}`
      );
    } else if (crm.stage) {
      lines.push(`${indent}⚪ ${esc(crm.stage)}`);
    }

    if (crm.description) {
      const shortDesc = crm.description.split(/\n\s*\n/)[0].trim();
      const truncated = shortDesc.length > 180
        ? shortDesc.slice(0, 177) + "..."
        : shortDesc;
      lines.push(`${indent}📝 ${esc(truncated)}`);
    }

    if (crm.insight?.bullets?.length) {
      const refreshDate = crm.insight.refreshedAt
        ? ` <i>(${esc(crm.insight.refreshedAt.slice(0, 10))})</i>`
        : "";
      lines.push(`${indent}🔍 <b>Refreshed</b>${refreshDate}:`);
      for (const b of crm.insight.bullets) {
        lines.push(`${indent}   • ${esc(b)}`);
      }
    }

    const visibleTags = (crm.tags || []).filter(t =>
      !/^(MH|P1|P2|P3|Hard Kill)/i.test(t)
    );
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

function renderStaleDeal(deal) {
  const lines = [];
  const stage = deal.stage || "";
  const isHotStage = stage === "Negotiations" || stage === "Call Scheduled";
  const emoji = isHotStage ? "🔴" : "🟡";

  const stagePart = stage ? ` · ${esc(stage)}` : "";
  const stalePart = deal.daysStale != null ? ` · <b>${deal.daysStale}d</b>` : "";
  lines.push(`${emoji} <b>${esc(deal.name)}</b>${stagePart}${stalePart}`);

  const indent = "   ";
  const t = tierFromCompany(deal);
  const ctxParts = [];
  if (t && !t.hardKill) ctxParts.push(`${t.tier} · ${t.score}`);
  else if (deal.bdScore != null) ctxParts.push(`BD ${deal.bdScore}`);
  if (deal.priority) ctxParts.push(deal.priority);
  if (deal.pipeline) ctxParts.push(deal.pipeline);
  if (ctxParts.length) lines.push(`${indent}<i>${ctxParts.map(esc).join(" · ")}</i>`);

  const lastTouch = daysAgo(deal.lastContact);
  if (lastTouch && lastTouch !== "today") {
    lines.push(`${indent}📅 last contact: ${esc(lastTouch)} ago`);
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

  lines.push(`${networkBadge} <b>${esc(reply.name)}</b> · ${esc(networkLabel)} · <b>${idle}</b>`);

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

// ── Fetch helpers ────────────────────────────────────────────────────────────

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
    const r = await axios.get(`${PROXY}/notion/stale-deals`, {
      params: { days, limit },
      timeout: 15_000,
    });
    console.log(`[bot] stale fetched in ${Date.now() - t0}ms`);
    return r.data?.deals || [];
  } catch (err) {
    console.error(`[bot] stale fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

async function fetchTasksToday({ limit = 20 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, {
      params: { limit },
      timeout: 15_000,
    });
    const data = r.data || {};
    const items = Array.isArray(data.items) ? data.items
                : Array.isArray(data.tasks) ? data.tasks.map(t => ({ kind: "single", task: t }))
                : [];
    const tasksFlat  = Array.isArray(data.tasks) ? data.tasks : [];
    const totalRaw   = data.total ?? tasksFlat.length;
    const overdueRaw = tasksFlat.filter(t => t.daysOverdue > 0).length;
    console.log(`[bot] tasks fetched in ${Date.now() - t0}ms (${totalRaw} total)`);
    return { items, totalRaw, overdueRaw };
  } catch (err) {
    console.error(`[bot] tasks fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

async function fetchTasksCompleted({ days = 3, limit = 20 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-completed`, {
      params: { days, limit },
      timeout: 12_000,
    });
    const tasks = Array.isArray(r.data?.tasks) ? r.data.tasks : [];
    console.log(`[bot] completed-tasks fetched in ${Date.now() - t0}ms (${tasks.length})`);
    return tasks;
  } catch (err) {
    console.error(`[bot] completed-tasks fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

async function fetchRepliesWaitingResilient({ hoursIdle = 4, limit = 8, days = 7 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/beeper/replies-waiting`, {
      params: { hoursIdle, limit, days },
      timeout: 15_000,
    });
    console.log(`[bot] beeper replies fetched in ${Date.now() - t0}ms`);
    return { source: "beeper", replies: r.data?.replies || [] };
  } catch (err) {
    console.warn(`[bot] beeper failed in ${Date.now() - t0}ms (will fallback to hub):`, err.message);
  }

  const t1 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/messaging-hub/replies-waiting`, {
      params: { hoursIdle, limit, days },
      timeout: 12_000,
    });
    console.log(`[bot] hub replies fetched in ${Date.now() - t1}ms`);
    return { source: "messaging-hub", replies: r.data?.replies || [] };
  } catch (err) {
    console.error(`[bot] hub fetch failed in ${Date.now() - t1}ms:`, err.message);
    return null;
  }
}

// Yesterday summary — calls /yesterday/summary which handles Beeper→Hub fallback
// internally and adds AI-generated bullets per network. Generous timeout because
// the endpoint makes parallel Haiku calls (one per network group).
async function fetchYesterdaySummary() {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/yesterday/summary`, {
      timeout: 60_000,
    });
    console.log(`[bot] yesterday summary fetched in ${Date.now() - t0}ms (source=${r.data?.source})`);
    return r.data;
  } catch (err) {
    console.error(`[bot] yesterday summary failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildCalendarSection(calendarRes) {
  if (calendarRes && calendarRes.__timeout) {
    return `📅 <b>Сегодня</b>\n\n<i>⚠️ Календарь не ответил.</i>`;
  }
  if (!calendarRes || !calendarRes.ok) {
    return `📅 <b>Сегодня</b>\n\n<i>❌ Calendar error: ${esc(calendarRes?.error || "unknown")}</i>`;
  }
  if (!calendarRes.events?.length) {
    return `📅 <b>Сегодня (${esc(calendarRes.date)})</b>\n\nКалендарь пустой 🌴`;
  }
  const blocks = calendarRes.events.map(renderEvent);
  return (
    `📅 <b>Сегодня (${esc(calendarRes.date)})</b>  · <i>${calendarRes.total} встреч</i>\n` +
    `\n` +
    blocks.join("\n\n")
  );
}

function buildTasksSectionResilient(tasksData, completedTasks) {
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

function buildRepliesSection(repliesResult) {
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

function buildStaleSection(stale) {
  if (stale && stale.__timeout) {
    return `🟡 <b>Заглохли</b>\n\n<i>⚠️ Notion не ответил по сделкам.</i>`;
  }
  if (!Array.isArray(stale) || stale.length === 0) return null;

  const dealBlocks = stale.map(renderStaleDeal);
  return (
    `🟡 <b>Заглохли</b>  · <i>${stale.length} сделок &gt;14d</i>\n` +
    `\n` +
    dealBlocks.join("\n\n")
  );
}

// Yesterday block — per-network AI summary + top-3 chats with one-line snippet.
//
// Layout per network:
//   💼 <b>LinkedIn</b>  · 8 чатов
//      • Maximilian Bruckner запросил intro call
//      • Anton отправил pitch Nick Woodruff и Patrick Chu
//      • Don-West Macauley забронировал Calendly
//
//      → Anton: "Feel free to grab a free slot..."  (Don-West)
//      ← Maximilian: "Hi Anton, sorry for getting back..."
//      → Anton: "Hi Patrick, will book within today"
//
// Header is annotated with source badge:
//   · из Messaging Hub  (when source = hub-fresh)
//   · данные за 2026-04-26 (Pavel оффлайн)  (when source = hub-stale)
function buildYesterdaySection(summary) {
  if (!summary) {
    return `📆 <b>Что было вчера</b>\n\n<i>⚠️ Не удалось получить summary мессенджеров.</i>`;
  }
  if (!summary.ok) {
    return null;
  }
  const networks = summary.networks || [];

  // Source badge
  let sourceLabel = "";
  if (summary.source === "hub-fresh") {
    sourceLabel = `  · <i>из Messaging Hub</i>`;
  } else if (summary.source === "hub-stale") {
    sourceLabel = `  · <i>данные за ${esc(summary.dataDate)} (Pavel оффлайн, Beeper-актуалка позже)</i>`;
  } else if (summary.source === "hub-empty") {
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${sourceLabel}\n\n<i>Активности не было.</i>`;
  }

  if (networks.length === 0) {
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${sourceLabel}\n\n<i>Активности не было.</i>`;
  }

  const blocks = [];
  for (const net of networks) {
    const lines = [];
    const emoji = NETWORK_HEADER_EMOJI(net.header);
    const totalLabel = net.totalChats > 0
      ? `  · <i>${net.totalChats} чатов</i>`
      : "";
    lines.push(`${emoji} <b>${esc(net.header)}</b>${totalLabel}`);

    // AI summary bullets
    const bullets = (net.summary?.bullets || []).filter(Boolean);
    if (bullets.length > 0) {
      lines.push("");
      for (const b of bullets) {
        lines.push(`   • ${esc(b)}`);
      }
    }

    // Top chats with snippets — only if we got real data, skip if hub-stale
    // because the snippets there would be misleading
    if (Array.isArray(net.topChats) && net.topChats.length > 0 && summary.source !== "hub-stale") {
      lines.push("");
      for (const c of net.topChats) {
        const arrow = c.direction === "→" ? "→" : "←";
        const senderHint = arrow === "→" ? "Anton" : (c.lastSender || "?");
        const safeName = esc(c.name).slice(0, 40);
        const safeSnippet = esc(c.snippet || "");
        lines.push(`   <code>${arrow}</code> <b>${safeName}</b>: <i>${safeSnippet}</i>`);
      }
    }

    blocks.push(lines.join("\n"));
  }

  return (
    `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${sourceLabel}\n` +
    `\n` +
    blocks.join("\n\n")
  );
}

// Stale-data warning — shown at TOP of digest when replies came from Hub.
const HUB_FALLBACK_DISCLAIMER =
  `⚠️ <b>Внимание Anton</b>: данные мессенджеров могут быть частично неактуальными — ` +
  `Pavel сейчас не подключен к Beeper. Когда подключение восстановится, Pavel пришлёт ` +
  `актуальную сводку вручную.`;

function composeTodayDigest(
  { calendarRes, tasksData, stale, repliesResult, completedTasks, yesterdaySummary },
  { header, withDisclaimer = false } = {}
) {
  const sections = [];
  if (header) sections.push(header);
  if (withDisclaimer && repliesResult?.source === "messaging-hub") {
    sections.push(HUB_FALLBACK_DISCLAIMER);
  }

  sections.push(buildCalendarSection(calendarRes));

  const tasksBlock = buildTasksSectionResilient(tasksData, completedTasks);
  if (tasksBlock) sections.push(tasksBlock);

  const repliesBlock = buildRepliesSection(repliesResult);
  if (repliesBlock) sections.push(repliesBlock);

  const yesterdayBlock = buildYesterdaySection(yesterdaySummary);
  if (yesterdayBlock) sections.push(yesterdayBlock);

  const staleBlock = buildStaleSection(stale);
  if (staleBlock) sections.push(staleBlock);

  return sections.join("\n\n━━━━━━━━━━━━━━━\n\n");
}

async function fetchTodayDigestData() {
  const t0 = Date.now();
  const [calendarRes, tasksData, stale, repliesResult, yesterdaySummary] = await Promise.all([
    withTimeout(fetchCalendar(),                                                    20_000, "calendar"),
    withTimeout(fetchTasksToday({ limit: 20 }),                                     15_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 5 }),                            15_000, "stale"),
    withTimeout(fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 8, days: 7 }), 30_000, "replies"),
    withTimeout(fetchYesterdaySummary(),                                            65_000, "yesterday"),
  ]);

  let completedTasks = null;
  if (tasksData && !tasksData.__timeout && (!tasksData.items || tasksData.items.length === 0)) {
    completedTasks = await withTimeout(
      fetchTasksCompleted({ days: 3, limit: 20 }),
      12_000,
      "completed-tasks"
    );
    if (completedTasks?.__timeout) completedTasks = null;
  }

  const ySummary = (yesterdaySummary && !yesterdaySummary.__timeout) ? yesterdaySummary : null;

  console.log(`[bot] digest data fetched in ${Date.now() - t0}ms`);
  return { calendarRes, tasksData, stale, repliesResult, completedTasks, yesterdaySummary: ySummary };
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n\n` +
    `Команды:\n` +
    `/ping — health check\n` +
    `/today — встречи + задачи + сделки + replies + вчера\n` +
    `/yesterday — что было вчера в мессенджерах\n` +
    `/digest — собрать дайджест (для Anton'а или для теста)\n` +
    `/tasks — открытые задачи\n` +
    `/stale — заглохшие сделки (>14d)\n` +
    `/replies — ждут ответа Anton'а\n\n` +
    `Авто:\n` +
    `• Утренний дайджест 08:30 CET\n` +
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
    `Anton TG ID: ${ANTON_TG_ID || "не задан (env ANTON_TG_ID)"}\n` +
    `Your TG ID: ${ctx.from?.id}`
  );
}));

bot.command("today", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Тяну дайджест (yesterday-summary через Claude Haiku, ~30-60s)...");
  try {
    const data = await fetchTodayDigestData();
    const text = composeTodayDigest(data, { withDisclaimer: false });

    await ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
    console.log(`[bot] /today completed in ${Date.now() - t0}ms`);
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

// /yesterday — standalone command for the messenger summary block
bot.command("yesterday", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Собираю summary мессенджеров за вчера (Claude Haiku, ~30-60s)...");
  try {
    const summary = await fetchYesterdaySummary();
    if (!summary) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Не удалось получить summary за вчера.`
      );
    }
    const block = buildYesterdaySection(summary);
    if (!block) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `📆 <b>Что было вчера</b>\n\n<i>Активности не было.</i>`,
        { parse_mode: "HTML" }
      );
    }
    await ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, block,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
    console.log(`[bot] /yesterday completed in ${Date.now() - t0}ms`);
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
      ? "⏳ Собираю дайджест для Anton'а..."
      : "⏳ Собираю дайджест (тестовый — пришлю только тебе)..."
  );

  try {
    const data = await fetchTodayDigestData();

    if (ANTON_TG_ID) {
      const header = `☀️ <b>Дайджест от Loop OS</b> (отправлен Pavel вручную)`;
      const text = composeTodayDigest(data, { header, withDisclaimer: true });

      await bot.api.sendMessage(ANTON_TG_ID, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });

      const hubNote = data.repliesResult?.source === "messaging-hub"
        ? `\n\n⚠️ Replies взяты из Messaging Hub (Beeper offline) — Anton получил предупреждение.`
        : "";

      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ Дайджест отправлен Anton'у (TG ID ${ANTON_TG_ID}).${hubNote}`,
        { parse_mode: "HTML" }
      );
    } else {
      const header = `🧪 <b>Тестовый дайджест</b> · ANTON_TG_ID не задан, шлю тебе`;
      const text = composeTodayDigest(data, { header, withDisclaimer: true });

      await ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id, text,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
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
        return ctx.api.editMessageText(
          ctx.chat.id, loadingMsg.message_id, text,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
      }
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Все задачи под контролем</b>\n\nНи открытых задач, ни закрытых за 3 дня.`,
        { parse_mode: "HTML" }
      );
    }
    const text = buildTasksSectionResilient(tasksData, null);
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
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
    const dealBlocks = stale.map(renderStaleDeal);
    const text =
      `🟡 <b>Заглохли</b>  · <i>${stale.length} сделок &gt;14d</i>\n\n` +
      dealBlocks.join("\n\n");
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
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
    const block = buildRepliesSection(result);
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, block,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

bot.on("message:text", ctx => guard(ctx, () => {
  return ctx.reply(
    `Команды:\n/start  /ping  /today  /yesterday  /digest  /tasks  /stale  /replies`
  );
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
    const data = await fetchTodayDigestData();
    const header = `☀️ <b>Доброе утро!</b> Дайджест на сегодня.`;
    const text = composeTodayDigest(data, { header, withDisclaimer: true });
    for (const userId of MORNING_PUSH_USERS) {
      try {
        await bot.api.sendMessage(userId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        console.log(`[cron] morning push sent to ${userId}`);
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
bot.start().then(() => {
  console.log(`[bot] Loop OS FCC ${VERSION} started at ${STARTED_AT.toISOString()}`);
}).catch(err => {
  console.error("[bot] Start error (non-fatal):", err.message);
});
