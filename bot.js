const { Bot } = require("grammy");
const axios   = require("axios");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY     = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION   = "4.5.0-fcc-tasks";
const STARTED_AT = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
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

// Format hours idle into compact string. Used for replies-waiting.
function formatIdle(hours) {
  if (hours == null) return "?";
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

// Map "High"/"Mid"/"Low" + bdScore → tier emoji + label
// Scoring is on /17 scale: MH ≥9, P1 ≥7.5, P2 5-7.4, P3 3-4.9
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

// Hard Kill description from tag code
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

// Network emoji map for messenger badges
const NET_BADGE = {
  "LI": "💼", "LinkedIn": "💼",
  "TG": "✈️", "Telegram": "✈️",
  "WA": "💚", "WhatsApp": "💚",
};

// Task priority emoji
const TASK_PRIORITY_EMOJI = {
  "High":   "🔴",
  "Medium": "🟡",
  "Low":    "⚪",
};

// ── Render helpers ───────────────────────────────────────────────────────────

// Render one event into HTML lines for Telegram
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

// Compact one-deal format. Negotiations gets a 🔴 plate (deal at risk),
// other active stages get 🟡 (gone quiet, needs nudge).
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

// Render one reply-waiting chat
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

// Render one task
//
// Format:
//   🔴 Sign Dfns contract  · 3d overdue
//      Donald sent DocuSign for review and signing.
//      🏢 Dfns
//
//   🟡 Reply Anupam (Nium)  · today
//      Brief warm update re corridors after Money 20/20.
//      🏢 Nium
//
//   ⚪ Update Notion stage for Belo  · today
//
function renderTask(task) {
  const lines = [];

  const emoji = TASK_PRIORITY_EMOJI[task.priority] || "⚪";

  // Due label: "X days overdue" / "today" / formatted date
  let dueLabel;
  if (task.daysOverdue == null) {
    dueLabel = "";
  } else if (task.daysOverdue > 0) {
    dueLabel = ` · <b>${task.daysOverdue}d overdue</b>`;
  } else if (task.daysOverdue === 0) {
    dueLabel = " · <b>today</b>";
  } else {
    // future task that snuck in (shouldn't happen with on_or_before today filter)
    dueLabel = ` · in ${Math.abs(task.daysOverdue)}d`;
  }

  // Truncate task name to fit in one line nicely
  const nameSafe = task.name.length > 80 ? task.name.slice(0, 77) + "..." : task.name;
  lines.push(`${emoji} <b>${esc(nameSafe)}</b>${dueLabel}`);

  const indent = "   ";

  if (task.description && task.description.length > 5) {
    lines.push(`${indent}<i>${esc(task.description)}</i>`);
  }

  if (task.companyName) {
    lines.push(`${indent}🏢 ${esc(task.companyName)}`);
  }

  return lines.join("\n");
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchStaleDeals({ days = 14, limit = 5 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/notion/stale-deals`, {
      params: { days, limit },
      timeout: 15_000,
    });
    return r.data?.deals || [];
  } catch (err) {
    console.error("[bot] fetchStaleDeals failed:", err.message);
    return null;
  }
}

async function fetchRepliesWaiting({ hoursIdle = 4, limit = 15, days = 7 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/beeper/replies-waiting`, {
      params: { hoursIdle, limit, days },
      timeout: 30_000,
    });
    return r.data?.replies || [];
  } catch (err) {
    console.error("[bot] fetchRepliesWaiting failed:", err.message);
    return null;
  }
}

async function fetchTasksToday({ limit = 10 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, {
      params: { limit },
      timeout: 15_000,
    });
    return r.data?.tasks || [];
  } catch (err) {
    console.error("[bot] fetchTasksToday failed:", err.message);
    return null;
  }
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

// ── /today ────────────────────────────────────────────────────────────────────
bot.command("today", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Тяну календарь, задачи, CRM и мессенджеры...");
  try {
    // Calendar + tasks + stale + replies — all in parallel for fastest response
    const [calendarRes, tasks, stale, replies] = await Promise.all([
      axios.get(`${PROXY}/calendar/today`, { timeout: 30_000 })
        .then(r => r.data)
        .catch(err => ({ ok: false, error: err.message })),
      fetchTasksToday({ limit: 10 }),
      fetchStaleDeals({ days: 14, limit: 5 }),
      fetchRepliesWaiting({ hoursIdle: 4, limit: 8, days: 7 }),
    ]);

    if (!calendarRes.ok) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Calendar error: ${esc(calendarRes.error || "unknown")}`
      );
    }

    const sections = [];

    // 1. Calendar block
    if (!calendarRes.events?.length) {
      sections.push(
        `📅 <b>Сегодня (${esc(calendarRes.date)})</b>\n\nКалендарь пустой 🌴`
      );
    } else {
      const blocks = calendarRes.events.map(renderEvent);
      sections.push(
        `📅 <b>Сегодня (${esc(calendarRes.date)})</b>  · <i>${calendarRes.total} встреч</i>\n` +
        `\n` +
        blocks.join("\n\n")
      );
    }

    // 2. Tasks today block
    if (Array.isArray(tasks) && tasks.length > 0) {
      const overdueCount = tasks.filter(t => t.daysOverdue > 0).length;
      const todayCount   = tasks.filter(t => t.daysOverdue === 0).length;
      const counter = overdueCount > 0
        ? `<i>${tasks.length} задач · ${overdueCount} просрочено</i>`
        : `<i>${tasks.length} задач на сегодня</i>`;
      const taskBlocks = tasks.map(renderTask);
      sections.push(
        `📋 <b>Задачи</b>  · ${counter}\n` +
        `\n` +
        taskBlocks.join("\n\n")
      );
    }

    // 3. Replies waiting block (split primary/secondary)
    if (Array.isArray(replies) && replies.length > 0) {
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

      sections.push(
        `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>\n` +
        `\n` +
        replyParts.join("\n\n")
      );
    }

    // 4. Stale-deals block
    if (Array.isArray(stale) && stale.length > 0) {
      const dealBlocks = stale.map(renderStaleDeal);
      sections.push(
        `🟡 <b>Заглохли</b>  · <i>${stale.length} сделок &gt;14d</i>\n` +
        `\n` +
        dealBlocks.join("\n\n")
      );
    }

    const text = sections.join("\n\n━━━━━━━━━━━━━━━\n\n");

    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id, text,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error("[bot /today] error:", errMsg);
    return ctx.api.editMessageText(
      ctx.chat.id, loadingMsg.message_id,
      `❌ Ошибка: ${esc(errMsg)}`
    );
  }
}));

// ── /tasks ────────────────────────────────────────────────────────────────────
bot.command("tasks", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую Tasks Tracker...");
  try {
    const tasks = await fetchTasksToday({ limit: 20 });

    if (tasks === null) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Не удалось получить задачи из Notion.`
      );
    }

    if (tasks.length === 0) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `✅ <b>Все задачи под контролем</b>\n\nНи одной задачи на сегодня или просроченной.`,
        { parse_mode: "HTML" }
      );
    }

    const overdueCount = tasks.filter(t => t.daysOverdue > 0).length;
    const counter = overdueCount > 0
      ? `<i>${tasks.length} задач · ${overdueCount} просрочено</i>`
      : `<i>${tasks.length} задач на сегодня</i>`;

    const text =
      `📋 <b>Задачи</b>  · ${counter}\n` +
      `\n` +
      tasks.map(renderTask).join("\n\n");

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

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[bot] Loop OS FCC ${VERSION} starting...`);
console.log(`[bot] Proxy URL: ${PROXY}`);
bot.start().then(() => {
  console.log(`[bot] Loop OS FCC ${VERSION} started at ${STARTED_AT.toISOString()}`);
}).catch(err => {
  console.error("[bot] Start error (non-fatal):", err.message);
});
