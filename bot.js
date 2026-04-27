const { Bot } = require("grammy");
const axios   = require("axios");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY     = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION   = "4.1.0-fcc-today";
const STARTED_AT = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

// Whitelist — Pavel + Anton only. If empty, dev mode (anyone can use).
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

// ── /start ────────────────────────────────────────────────────────────────────
bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n` +
    `Статус: жив, фичи строим по одной.\n\n` +
    `Доступно сейчас:\n` +
    `/ping — health check\n` +
    `/today — встречи Anton'а на сегодня\n\n` +
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
// Fetches Anton's calendar for today via outreach-proxy /calendar/today.
bot.command("today", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Тяну календарь...");
  try {
    const r = await axios.get(`${PROXY}/calendar/today`, { timeout: 20_000 });
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

    // Build human-readable list
    const lines = data.events.map(ev => {
      const time = ev.timeRange;
      const title = esc(ev.summary);

      // External attendees if any
      let metaParts = [];
      if (ev.isInternal) {
        metaParts.push("internal/focus");
      } else if (ev.attendees?.length) {
        const ext = ev.attendees
          .map(a => a.name || a.email?.split("@")[0])
          .filter(Boolean)
          .slice(0, 3)
          .join(", ");
        if (ext) metaParts.push(esc(ext));
      }
      if (ev.meetUrl) metaParts.push("📞");

      const meta = metaParts.length ? ` · <i>${metaParts.join(" · ")}</i>` : "";
      return `<code>${time}</code>  ${title}${meta}`;
    });

    const text =
      `📅 <b>Сегодня (${esc(data.date)})</b>\n` +
      `<i>${data.total} событий, TZ: ${esc(data.timeZone)}</i>\n\n` +
      lines.join("\n");

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
