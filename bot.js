const { Bot } = require("grammy");
const axios   = require("axios");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY     = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION   = "4.2.0-fcc-today-enriched";
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

// ── Helpers for /today rendering ─────────────────────────────────────────────

// Days since ISO date string, returns string like "2d", "3w", "1mo"
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

// Map "High"/"Mid"/"Low" + bdScore → tier emoji + label
// Scoring is on /17 scale: MH ≥9, P1 ≥7.5, P2 5-7.4, P3 3-4.9
function tierFromCompany(company) {
  if (!company) return null;
  // Hard Kill detection — look in tags
  const tags = company.tags || [];
  const hkTag = tags.find(t => /^Hard Kill\s*-\s*HK/i.test(t));
  if (hkTag) {
    const m = hkTag.match(/HK-?(\d+)/i);
    return { hardKill: true, code: m ? `HK-${m[1]}` : "HK", emoji: "🔴" };
  }
  // Tier from BD score on /17 scale
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

// Render one event into HTML lines for Telegram
function renderEvent(ev) {
  const lines = [];
  const time  = ev.timeRange;
  const title = esc(ev.summary);

  // Header line: time + title
  lines.push(`<code>${time}</code>  <b>${title}</b>`);

  if (ev.isInternal) {
    lines.push(`             <i>internal/focus</i>`);
    return lines.join("\n");
  }

  const indent = "             ";  // 13 spaces — visual alignment under timeRange

  // Domain line
  if (ev.primaryDomain) {
    lines.push(`${indent}🌐 ${esc(ev.primaryDomain)}`);
  }

  // Person line
  const p = ev.attendeePerson;
  if (p) {
    const personName = p.name || p.email?.split("@")[0] || "?";
    const titlePart  = p.title ? ` — ${esc(p.title)}` : "";
    const linkPart   = p.linkedin ? ` · <a href="${esc(p.linkedin)}">LinkedIn</a>` : "";
    lines.push(`${indent}👤 ${esc(personName)}${titlePart}${linkPart}`);
  }

  // CRM company line
  const crm = ev.notion;
  if (crm) {
    const t = tierFromCompany(crm);
    if (t?.hardKill) {
      // Hard Kill plate — red, bold, plus advisory
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
      // No score yet, but we have a stage
      lines.push(`${indent}⚪ ${esc(crm.stage)}`);
    }

    // Description — short, single-paragraph excerpt
    if (crm.description) {
      const shortDesc = crm.description.split(/\n\s*\n/)[0].trim();
      const truncated = shortDesc.length > 180
        ? shortDesc.slice(0, 177) + "..."
        : shortDesc;
      lines.push(`${indent}📝 ${esc(truncated)}`);
    }

    // Insight bullets
    if (crm.insight?.bullets?.length) {
      const refreshDate = crm.insight.refreshedAt
        ? ` <i>(${esc(crm.insight.refreshedAt.slice(0, 10))})</i>`
        : "";
      lines.push(`${indent}🔍 <b>Refreshed</b>${refreshDate}:`);
      for (const b of crm.insight.bullets) {
        lines.push(`${indent}   • ${esc(b)}`);
      }
    }

    // Tags (skip Hard Kill/MH/P1/P2/P3 tags — they're already in the tier line)
    const visibleTags = (crm.tags || []).filter(t =>
      !/^(MH|P1|P2|P3|Hard Kill)/i.test(t)
    );
    if (visibleTags.length) {
      lines.push(`${indent}🏷 ${visibleTags.slice(0, 6).map(esc).join(" · ")}`);
    }
  } else {
    // Not in CRM yet
    lines.push(`${indent}🆕 <i>not in CRM</i> — cron подхватит ночью`);
  }

  if (ev.meetUrl) {
    lines.push(`${indent}📞 <a href="${esc(ev.meetUrl)}">Join</a>`);
  }

  return lines.join("\n");
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n` +
    `Статус: жив, фичи строим по одной.\n\n` +
    `Доступно сейчас:\n` +
    `/ping — health check\n` +
    `/today — встречи Anton'а на сегодня (с CRM данными)\n\n` +
    `Скоро:\n` +
    `• Morning digest (9:00 CET)\n` +
    `• Pre-call briefing (за час до звонка)\n` +
    `• Post-call follow-up (через 15 мин после)`
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
  const loadingMsg = await ctx.reply("⏳ Тяну календарь + CRM...");
  try {
    // 30s timeout — enrichment can take a few seconds (4 parallel Notion lookups per event)
    const r = await axios.get(`${PROXY}/calendar/today`, { timeout: 30_000 });
    const data = r.data;

    if (!data.ok) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `❌ Calendar error: ${esc(data.error || "unknown")}`
      );
    }

    if (!data.events?.length) {
      return ctx.api.editMessageText(
        ctx.chat.id, loadingMsg.message_id,
        `📅 <b>Сегодня (${esc(data.date)})</b>\n\nКалендарь пустой 🌴`,
        { parse_mode: "HTML" }
      );
    }

    const blocks = data.events.map(renderEvent);
    const text =
      `📅 <b>Сегодня (${esc(data.date)})</b>  · <i>${data.total} встреч</i>\n` +
      `\n` +
      blocks.join("\n\n");

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

// ── Catch-all for any other text ──────────────────────────────────────────────
bot.on("message:text", ctx => guard(ctx, () => {
  return ctx.reply(
    `Пока я понимаю только команды:\n` +
    `/start — что я умею\n` +
    `/ping — health check\n` +
    `/today — встречи Anton'а на сегодня`
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
