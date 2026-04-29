const { Bot } = require("grammy");
const axios   = require("axios");
const cron    = require("node-cron");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const PROXY        = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION      = "4.11.0-fcc-no-beeper";
const STARTED_AT   = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const MORNING_PUSH_USERS = (process.env.MORNING_PUSH_USERS || "156632707")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

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

// ── Fetch helpers (all via proxy now) ────────────────────────────────────────

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

function buildTasksSection(tasksData) {
  if (!tasksData || tasksData.__timeout) {
    return `📋 <b>Задачи</b>\n\n<i>⚠️ Notion не ответил по задачам.</i>`;
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

function composeTodayDigest({ calendarRes, tasksData, stale }, { header } = {}) {
  const sections = [];
  if (header) sections.push(header);
  sections.push(buildCalendarSection(calendarRes));
  const tasksBlock = buildTasksSection(tasksData);
  if (tasksBlock) sections.push(tasksBlock);
  const staleBlock = buildStaleSection(stale);
  if (staleBlock) sections.push(staleBlock);
  return sections.join("\n\n━━━━━━━━━━━━━━━\n\n");
}

async function fetchTodayDigestData() {
  const t0 = Date.now();
  const [calendarRes, tasksData, stale] = await Promise.all([
    withTimeout(fetchCalendar(),                             20_000, "calendar"),
    withTimeout(fetchTasksToday({ limit: 20 }),              15_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 5 }),     15_000, "stale"),
  ]);
  console.log(`[bot] digest data fetched in ${Date.now() - t0}ms`);
  return { calendarRes, tasksData, stale };
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n\n` +
    `Команды:\n` +
    `/ping — health check\n` +
    `/today — встречи + задачи + заглохшие сделки\n` +
    `/tasks — открытые задачи\n` +
    `/stale — заглохшие сделки (>14d)\n` +
    `/replies — ждут ответа Anton'а (через Beeper)\n\n` +
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
    `Your TG ID: ${ctx.from?.id}`
  );
}));

// /today — single fetch, single edit
bot.command("today", ctx => guard(ctx, async () => {
  const t0 = Date.now();
  const loadingMsg = await ctx.reply("⏳ Тяну дайджест...");
  try {
    const data = await fetchTodayDigestData();
    const text = composeTodayDigest(data);

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
  const loadingMsg = await ctx.reply("⏳ Сканирую мессенджеры (Beeper)...");
  try {
    const r = await axios.get(`${PROXY}/beeper/replies-waiting`, {
      params: { hoursIdle: 4, limit: 15, days: 7 },
      timeout: 30_000,
    });
    const replies = r.data?.replies || [];
    if (replies.length === 0) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Inbox чист</b>\n\nНет чатов где Anton ещё не ответил &gt;4h.`,
        { parse_mode: "HTML" }
      );
    }
    const text = `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>\n\n` +
      replies.map(rep => {
        const idle = rep.hoursIdle != null ? `${Math.round(rep.hoursIdle)}h` : "?";
        const net = rep.networkFull || rep.network || "Chat";
        const snippet = (rep.lastMsgText || "").slice(0, 150);
        return `<b>${esc(rep.name)}</b> · ${esc(net)} · ${idle}\n   <i>"${esc(snippet)}"</i>`;
      }).join("\n\n");
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Beeper недоступен: ${esc(errMsg)}`
    );
  }
}));

bot.on("message:text", ctx => guard(ctx, () => {
  return ctx.reply(
    `Команды:\n/start  /ping  /today  /tasks  /stale  /replies`
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
