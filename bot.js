const { Bot } = require("grammy");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VERSION = "4.0.0-fcc-skeleton";
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

// ── /start ────────────────────────────────────────────────────────────────────
bot.command("start", ctx => guard(ctx, () => {
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\n` +
    `Версия: ${VERSION}\n` +
    `Статус: жив, фичи пока в разработке.\n\n` +
    `Доступно сейчас:\n` +
    `/ping — health check\n\n` +
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

// ── Catch-all for any other text ──────────────────────────────────────────────
bot.on("message:text", ctx => guard(ctx, () => {
  return ctx.reply(
    `Пока я понимаю только команды:\n` +
    `/start — что я умею\n` +
    `/ping — health check`
  );
}));

// ── Error handler ─────────────────────────────────────────────────────────────
bot.catch(err => {
  console.error("[bot] Error:", err.message);
});

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[bot] Loop OS FCC skeleton ${VERSION} starting...`);
bot.start().then(() => {
  console.log(`[bot] Loop OS FCC skeleton ${VERSION} started at ${STARTED_AT.toISOString()}`);
}).catch(err => {
  console.error("[bot] Start error (non-fatal):", err.message);
});
