const { Bot } = require("grammy");
const axios   = require("axios");
const cron    = require("node-cron");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY     = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION   = "4.9.0-fcc-progressive-today";
const STARTED_AT = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const MORNING_PUSH_USERS = (process.env.MORNING_PUSH_USERS || "156632707")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const bot = new Bot(BOT_TOKEN);

// ── Crash protection ──────────────────────────────────────────────────────────
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

// ── HTML escape (Telegram parse_mode: HTML) ──────────────────────────────────
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

// ── Helpers shared between /today, /stale, /replies, /tasks ──────────────────

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

function formatIdle(hours) {
  if (hours == null) return "?";
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
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
  const time  = ev.timeRange;
  const title = esc(ev.summary);

  lines.push(`<code>${time}</code>  <b>${title}</b>`);

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

function renderReply(reply) {
  const lines = [];

  const networkBadge = NET_BADGE[reply.networkFull] || NET_BADGE[reply.network] || "💬";
  const idle = formatIdle(reply.hoursIdle);
  const typeMark = reply.type === "group" ? " <i>(group)</i>" : "";
  const networkLabel = reply.networkFull || reply.network || "Chat";

  lines.push(`${networkBadge} <b>${esc(reply.name)}</b> · ${esc(networkLabel)}${typeMark} · <b>${esc(idle)}</b>`);

  const indent = "   ";

  const snippet = reply.lastMsgText || "";
  const trimmed = snippet.length > 200
    ? snippet.slice(0, 197).replace(/\s+\S*$/, "") + "..."
    : snippet;

  if (reply.type === "group" && reply.lastMsgSender) {
    lines.push(`${indent}<b>${esc(reply.lastMsgSender)}</b>: <i>"${esc(trimmed)}"</i>`);
  } else if (trimmed) {
    lines.push(`${indent}<i>"${esc(trimmed)}"</i>`);
  }

  if (reply.notion) {
    const t = tierFromCompany(reply.notion);
    const parts = [];
    parts.push(`🟢 <b>${esc(reply.notion.name)}</b>`);
    if (t && !t.hardKill) parts.push(`${t.tier} · ${t.score}`);
    else if (reply.notion.bdScore != null) parts.push(`BD ${reply.notion.bdScore}`);
    if (reply.notion.stage) parts.push(esc(reply.notion.stage));
    lines.push(`${indent}${parts.join(" · ")}`);
  }

  if (reply.person?.title) {
    lines.push(`${indent}👤 ${esc(reply.person.title)}`);
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

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchCalendar() {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/calendar/today`, { timeout: 25_000 });
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
      timeout: 12_000,
    });
    console.log(`[bot] stale fetched in ${Date.now() - t0}ms (${r.data?.deals?.length || 0} deals)`);
    return r.data?.deals || [];
  } catch (err) {
    console.error(`[bot] stale fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

async function fetchRepliesWaiting({ hoursIdle = 4, limit = 15, days = 7 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/beeper/replies-waiting`, {
      params: { hoursIdle, limit, days },
      timeout: 25_000,
    });
    console.log(`[bot] replies fetched in ${Date.now() - t0}ms (${r.data?.replies?.length || 0} replies)`);
    return r.data?.replies || [];
  } catch (err) {
    console.error(`[bot] replies fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

async function fetchTasksToday({ limit = 10 } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, {
      params: { limit },
      timeout: 12_000,
    });
    const data = r.data || {};
    const items = Array.isArray(data.items) ? data.items
                : Array.isArray(data.tasks) ? data.tasks.map(t => ({ kind: "single", task: t }))
                : [];
    const tasksFlat = Array.isArray(data.tasks) ? data.tasks : [];
    const totalRaw   = data.total ?? tasksFlat.length;
    const overdueRaw = tasksFlat.filter(t => t.daysOverdue > 0).length;
    console.log(`[bot] tasks fetched in ${Date.now() - t0}ms (${totalRaw} total)`);
    return { items, totalRaw, overdueRaw };
  } catch (err) {
    console.error(`[bot] tasks fetch failed in ${Date.now() - t0}ms:`, err.message);
    return null;
  }
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildCalendarSection(calendarRes) {
  if (calendarRes && calendarRes.__timeout) {
    return `📅 <b>Сегодня</b>\n\n<i>⚠️ Календарь ответил долго.</i>`;
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

function buildTasksSection(tasksData) {
  if (!tasksData || tasksData.__timeout) {
    return `📋 <b>Задачи</b>\n\n<i>⚠️ Notion ответил долго — пропустил блок.</i>`;
  }
  if (!tasksData.items?.length) return null;
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

function buildRepliesSection(replies) {
  if (replies && replies.__timeout) {
    return `💬 <b>Ждут ответа</b>\n\n<i>⚠️ Beeper ответил долго — пропустил блок.</i>`;
  }
  if (!Array.isArray(replies) || replies.length === 0) return null;

  const primary = replies.filter(r => r.visualTier === "primary");
  const secondary = replies.filter(r => r.visualTier === "secondary");

  const replyParts = [];
  if (primary.length > 0) {
    replyParts.push(primary.map(renderReply).join("\n\n"));
  }
  if (secondary.length > 0) {
    if (primary.length > 0) {
      replyParts.push(`<i>—  остальные  —</i>\n\n` + secondary.map(renderReply).join("\n\n"));
    } else {
      replyParts.push(secondary.map(renderReply).join("\n\n"));
    }
  }

  return (
    `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>\n` +
    `\n` +
    replyParts.join("\n\n")
  );
}

function buildStaleSection(stale) {
  if (stale && stale.__timeout) {
    return `🟡 <b>Заглохли</b>\n\n<i>⚠️ Notion ответил долго — пропустил блок.</i>`;
  }
  if (!Array.isArray(stale) || stale.length === 0) return null;

  const dealBlocks = stale.map(renderStaleDeal);
  return (
    `🟡 <b>Заглохли</b>  · <i>${stale.length} сделок &gt;14d</i>\n` +
    `\n` +
    dealBlocks.join("\n\n")
  );
}

// Compose digest from already-fetched data (used by morning push cron).
function composeTodayDigest({ calendarRes, tasksData, stale, replies }, { header } = {}) {
  const sections = [];
  if (header) sections.push(header);

  sections.push(buildCalendarSection(calendarRes));

  const tasksBlock = buildTasksSection(tasksData);
  if (tasksBlock) sections.push(tasksBlock);

  const repliesBlock = buildRepliesSection(replies);
  if (repliesBlock) sections.push(repliesBlock);

  const staleBlock = buildStaleSection(stale);
  if (staleBlock) sections.push(staleBlock);

  return sections.join("\n\n━━━━━━━━━━━━━━━\n\n");
}

// Used by morning cron only — parallel fetch (since cron has no UX concerns)
async function fetchTodayDigestData() {
  const t0 = Date.now();
  const [calendarRes, tasksData, stale, replies] = await Promise.all([
    withTimeout(fetchCalendar(),                                          25_000, "calendar"),
    withTimeout(fetchTasksToday({ limit: 20 }),                           12_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 5 }),                  12_000, "stale"),
    withTimeout(fetchRepliesWaiting({ hoursIdle: 4, limit: 8, days: 7 }), 25_000, "replies"),
  ]);
  console.log(`[bot] aggregate digest fetch took ${Date.now() - t0}ms`);
  return { calendarRes, tasksData, stale, replies };
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n` +
    `Статус: жив, фичи строим по одной.\n\n` +
    `Доступно сейчас:\n` +
    `/ping — health check\n` +
    `/today — встречи + tasks + replies + stale\n` +
    `/tasks — открытые задачи (сегодня + просрочены)\n` +
    `/stale — заглохшие сделки (>14d тишины)\n` +
    `/replies — кто ждёт ответа Anton'а (>4h)\n\n` +
    `Авто:\n` +
    `• Утренний дайджест каждый день в 08:30 CET\n` +
    `• CRM auto-prewarm в 23:00 и 08:00 CET\n\n` +
    `Скоро:\n` +
    `• Pre-call briefing (за час до звонка)\n` +
    `• Post-call follow-up (через 15 мин после)\n` +
    `• Loop's nudge`
  );
}));

// ── /ping ─────────────────────────────────────────────────────────────────────
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
    `Server time: ${now.toISOString()}\n` +
    `Uptime: ${uptimeStr}\n` +
    `Your TG ID: ${ctx.from?.id}`
  );
}));

// ── /today — PROGRESSIVE RENDERING ───────────────────────────────────────────
//
// Sequential fetches with edits between each phase. The user sees the message
// update as each block resolves, so they always know what's happening — and if
// something hangs, the last visible status line tells us exactly which block
// is the culprit.
//
// Phases:
//   1. fetch calendar     → render calendar block + spinner "тяну задачи..."
//   2. fetch tasks        → render +tasks + spinner "тяну заглохшие сделки..."
//   3. fetch stale        → render +stale + spinner "тяну Beeper..."
//   4. fetch replies      → final render
//
// Each phase has a hard timeout via withTimeout(). If a fetch resolves to
// __timeout, the section shows ⚠️ but the rest of the digest still works.
bot.command("today", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Тяну календарь...");
  const chatId = ctx.chat.id;
  const msgId = loadingMsg.message_id;

  // Helper to safely edit the message — never throws (Telegram errors get
  // logged; we don't want them to break the digest).
  async function safeEdit(text, opts = {}) {
    try {
      await ctx.api.editMessageText(chatId, msgId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...opts,
      });
    } catch (err) {
      console.error("[bot /today] editMessageText failed:", err.message);
    }
  }

  const sections = [];
  const SEPARATOR = "\n\n━━━━━━━━━━━━━━━\n\n";

  // Phase 1: calendar
  const calendarRes = await withTimeout(fetchCalendar(), 25_000, "calendar");
  sections.push(buildCalendarSection(calendarRes));
  await safeEdit(sections.join(SEPARATOR) + SEPARATOR + "⏳ <i>Тяну задачи...</i>");

  // Phase 2: tasks
  const tasksData = await withTimeout(fetchTasksToday({ limit: 20 }), 12_000, "tasks");
  const tasksBlock = buildTasksSection(tasksData);
  if (tasksBlock) sections.push(tasksBlock);
  await safeEdit(sections.join(SEPARATOR) + SEPARATOR + "⏳ <i>Тяну заглохшие сделки...</i>");

  // Phase 3: stale
  const stale = await withTimeout(fetchStaleDeals({ days: 14, limit: 5 }), 12_000, "stale");
  const staleBlock = buildStaleSection(stale);
  if (staleBlock) sections.push(staleBlock);
  await safeEdit(sections.join(SEPARATOR) + SEPARATOR + "⏳ <i>Тяну Beeper...</i>");

  // Phase 4: replies (last because Beeper is usually slowest)
  const replies = await withTimeout(
    fetchRepliesWaiting({ hoursIdle: 4, limit: 8, days: 7 }),
    25_000,
    "replies"
  );
  const repliesBlock = buildRepliesSection(replies);
  if (repliesBlock) {
    // Insert replies block before stale (consistent with morning push order)
    if (staleBlock) {
      sections.splice(sections.length - 1, 0, repliesBlock);
    } else {
      sections.push(repliesBlock);
    }
  }

  await safeEdit(sections.join(SEPARATOR));
  console.log(`[bot] /today completed in ${Date.now() - t0}ms`);
}));

// ── /tasks ────────────────────────────────────────────────────────────────────
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
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Все задачи под контролем</b>\n\nНи одной задачи на сегодня или просроченной.`,
        { parse_mode: "HTML" }
      );
    }

    const text = buildTasksSection(tasksData);

    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /tasks] error:", errMsg);
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

// ── /stale ────────────────────────────────────────────────────────────────────
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
      `🟡 <b>Заглохли</b>  · <i>${stale.length} сделок &gt;14d</i>\n` +
      `\n` +
      dealBlocks.join("\n\n");

    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /stale] error:", errMsg);
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

// ── /replies ──────────────────────────────────────────────────────────────────
bot.command("replies", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую мессенджеры...");
  try {
    const replies = await fetchRepliesWaiting({ hoursIdle: 4, limit: 15, days: 7 });

    if (replies === null) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Не удалось получить данные из Beeper.`
      );
    }

    if (replies.length === 0) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Inbox чист</b>\n\nНет чатов где Anton ещё не ответил &gt;4h.`,
        { parse_mode: "HTML" }
      );
    }

    const primary = replies.filter(r => r.visualTier === "primary");
    const secondary = replies.filter(r => r.visualTier === "secondary");

    const parts = [];
    if (primary.length > 0) {
      parts.push(primary.map(renderReply).join("\n\n"));
    }
    if (secondary.length > 0) {
      if (primary.length > 0) {
        parts.push(`<i>—  остальные  —</i>\n\n` + secondary.map(renderReply).join("\n\n"));
      } else {
        parts.push(secondary.map(renderReply).join("\n\n"));
      }
    }

    const text =
      `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>\n` +
      `\n` +
      parts.join("\n\n");

    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /replies] error:", errMsg);
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

// ── Catch-all for any other text ──────────────────────────────────────────────
bot.on("message:text", ctx => guard(ctx, () => {
  return ctx.reply(
    `Пока я понимаю только команды:\n` +
    `/start — что я умею\n` +
    `/ping — health check\n` +
    `/today — всё сразу\n` +
    `/tasks — задачи\n` +
    `/stale — заглохшие сделки\n` +
    `/replies — ждут ответа`
  );
}));

// ── Error handler ─────────────────────────────────────────────────────────────
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
    const text = composeTodayDigest(data, { header });

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
console.log(`[bot] Morning push recipients: ${MORNING_PUSH_USERS.join(",") || "(none)"}`);
bot.start().then(() => {
  console.log(`[bot] Loop OS FCC ${VERSION} started at ${STARTED_AT.toISOString()}`);
}).catch(err => {
  console.error("[bot] Start error (non-fatal):", err.message);
});
