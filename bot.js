const { Bot, InlineKeyboard } = require("grammy");
const axios = require("axios");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const PROXY         = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const APOLLO_KEY    = process.env.APOLLO_KEY || "mtztHHOhq1AMUNUGPGQ-4A";
const HR_KEY        = process.env.HEYREACH_KEY || "GBkojH0WLisB1tYtBSBoNSGRQxNE7eFi6Td5eZIq5JY=";
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || "").trim() || null;

// Whitelist — только Паша и Антон
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const bot = new Bot(BOT_TOKEN);

// Prevent grammy crashes from killing the whole process
process.on("uncaughtException", err => {
  console.error("[bot] Uncaught exception (ignored):", err.message);
});
process.on("unhandledRejection", err => {
  console.error("[bot] Unhandled rejection (ignored):", err?.message || err);
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function isAllowed(ctx) {
  if (ALLOWED_USERS.length === 0) return true; // dev mode
  return ALLOWED_USERS.includes(ctx.from?.id);
}

function guard(ctx, fn) {
  if (!isAllowed(ctx)) return ctx.reply("⛔ Access denied.");
  return fn();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function proxyGet(path) {
  const r = await axios.get(`${PROXY}${path}`, { timeout: 30000 });
  return r.data;
}

async function proxyPost(path, body) {
  const r = await axios.post(`${PROXY}${path}`, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });
  return r.data;
}

function esc(text) {
  return String(text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trunc(text, max = 200) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function splitMessage(text, max = 4000) {
  const chunks = [];
  while (text.length > max) {
    let cut = text.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  if (text) chunks.push(text);
  return chunks;
}

// ── AI layer — свободные запросы через Claude API ────────────────────────────
const SYSTEM_PROMPT = `Ты — умный BD-ассистент Plexo (stablecoin clearing network).
Тебя используют Pavel (Паша) и Anton в Telegram для управления партнёрскими переписками.

У тебя есть доступ к данным через HTTP proxy. Когда тебе нужна информация — вызови нужный endpoint и используй результат для ответа.

Доступные endpoints (все через ${PROXY}):
- GET /beeper/inbox?network=tg|wa|li|all&limit=N — последние N чатов с превью
- GET /beeper/chat?name=ИМЯ&limit=N — переписка с контактом по имени
- POST /beeper/find-chat {"name":"X"} — найти чат
- POST /beeper/send {"chatId":"X","text":"Y"} — отправить сообщение
- POST /apollo/match {"apolloKey":"${APOLLO_KEY}","firstName":"X","lastName":"Y","organizationName":"Z"} — Apollo enrichment
- POST /notion/upsert-lead {...} — добавить в Notion CRM
- POST /notion/query {"db_id":"f9b59c5b05fa4df18f9569479633fd74","filter":{...}} — запрос к Notion Companies
- POST /heyreach/proxy {"hrKey":"${HR_KEY}","path":"/campaign/GetAll","payload":{}} — HeyReach

Контекст Plexo:
- Discovery Card = onboarding документ для партнёров, содержит NDA и Partners Portal
- Founding Cohort = первый набор партнёров сети
- Corridors = географические маршруты платежей
- Anton = CEO, Pavel = Head of Partnerships

Правила ответов:
- Отвечай кратко и по делу, на том же языке что вопрос (RU/EN)
- Если нужно получить данные — СНАЧАЛА скажи что делаешь, потом дай результат
- Action items выделяй как списки с эмодзи приоритетов (🔥/⏳/✅)
- Не давай лишнего текста — только суть`;

async function askClaude(userMessage, contextData = "") {
  if (!ANTHROPIC_KEY) return null;

  const content = contextData
    ? `${userMessage}\n\n<context>\n${contextData}\n</context>`
    : userMessage;

  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  ).catch(err => {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("[claude] API error:", detail);
    throw new Error("Claude API: " + detail);
  });
  return r.data?.content?.[0]?.text || null;
}

// ── /start & /help ────────────────────────────────────────────────────────────
bot.command(["start", "help"], ctx => guard(ctx, () => {
  const help = `🤖 <b>Plexo Loop Bot</b>

<b>Команды:</b>
/inbox [tg|wa|li|all] [N] — последние N чатов
/chat [имя] — переписка с контактом
/status — кого пинговать
/ping [чат] | [текст] — отправить сообщение
/enrich [Имя / Компания] — Apollo enrichment
/addlead [Имя / Компания] — добавить в Notion
/campaigns — кампании HeyReach
/replies — ответы LinkedIn

<b>Свободный запрос:</b>
Просто пиши что угодно — бот поймёт 🙂
Например: <i>«расскажи по Discovery карточкам»</i>`;
  return ctx.reply(help, { parse_mode: "HTML" });
}));

// ── /inbox ────────────────────────────────────────────────────────────────────
bot.command("inbox", ctx => guard(ctx, async () => {
  const args = ctx.message.text.split(" ").slice(1);
  const network = ["tg", "wa", "li", "all"].includes(args[0]) ? args[0] : "all";
  const limit = parseInt(args.find(a => !isNaN(parseInt(a)))) || 10;

  const msg = await ctx.reply("⏳ Загружаю чаты...");
  try {
    const data = await proxyGet(`/beeper/inbox?network=${network}&limit=${limit}`);
    if (!data.ok || !data.chats?.length) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, "❌ Чаты не найдены");
    }
    const lines = data.chats.map((c, i) =>
      `<b>${i+1}. ${esc(c.chatName)}</b>\n${esc(trunc(c.lastMsg, 120))}`
    );
    const text = `📱 <b>Inbox ${network.toUpperCase()} (${data.count})</b>\n\n` + lines.join("\n\n");
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: "HTML" });
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

// ── /chat ─────────────────────────────────────────────────────────────────────
bot.command("chat", ctx => guard(ctx, async () => {
  const args = ctx.message.text.split(" ").slice(1);
  const limit = parseInt(args[args.length - 1]);
  const name = isNaN(limit) ? args.join(" ") : args.slice(0, -1).join(" ");
  if (!name) return ctx.reply("❌ Укажи имя: /chat OpenPayd");

  const msg = await ctx.reply(`⏳ Ищу переписку с "${name}"...`);
  try {
    const data = await proxyGet(`/beeper/chat?name=${encodeURIComponent(name)}&limit=${isNaN(limit) ? 20 : limit}`);
    if (!data.ok || !data.chats?.length) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Чат "${name}" не найден`);
    }

    let text = `💬 <b>Переписка: ${esc(name)}</b>\n`;
    for (const chat of data.chats) {
      text += `\n<b>— ${esc(chat.chatName)} (${chat.messageCount} сообщ.)</b>\n`;
      for (const m of chat.messages) {
        const dir = m.isSender ? "→" : "←";
        const sender = m.isSender ? "Ты" : esc(m.sender);
        const unread = m.isUnread ? " 🔴" : "";
        text += `<code>[${m.time}]</code> ${dir} <b>${sender}</b>${unread}: ${esc(trunc(m.text, 200))}\n`;
      }
    }

    const chunks = splitMessage(text);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, chunks[0], { parse_mode: "HTML" });
    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(chunks[i], { parse_mode: "HTML" });
    }
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

// ── /status ───────────────────────────────────────────────────────────────────
bot.command("status", ctx => guard(ctx, async () => {
  const msg = await ctx.reply("⏳ Анализирую переписки...");
  try {
    const data = await proxyGet("/beeper/inbox?network=all&limit=30");
    if (!data.ok) throw new Error("Не удалось получить чаты");

    // Если есть AI — делаем умный анализ
    if (ANTHROPIC_KEY) {
      const chatList = data.chats.map(c =>
        `• ${c.chatName}: ${c.lastMsg}`
      ).join("\n");
      const analysis = await askClaude(
        "Проанализируй эти переписки и составь список action items: кого нужно пинговать срочно, кто ждёт нашего ответа, кто тёплый, кто отказал. Будь краток.",
        chatList
      );
      if (analysis) {
        const chunks = splitMessage(analysis);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, chunks[0]);
        for (let i = 1; i < chunks.length; i++) await ctx.reply(chunks[i]);
        return;
      }
    }

    // Fallback — простой парсинг
    const analysis = [];
    for (const c of data.chats) {
      const last = c.lastMsg || "";
      const name = c.chatName;
      let status = "";
      if (/: no$/i.test(last) || /not interested/i.test(last)) status = "🔴 ОТКАЗ";
      else if (/approval|awesome|thanks|sure|great/i.test(last) && last.includes("←")) status = "🔥 ТЁПЛЫЙ";
      else if (last.includes("→") && !last.includes("←")) status = "⏳ ЖДЁТ ОТВЕТА";
      else if (last.includes("←")) status = "💬 ОТВЕТИЛ";
      if (status) analysis.push(`${status} — <b>${esc(name)}</b>\n<i>${esc(trunc(last.replace(/→|←/, "").trim(), 100))}</i>`);
    }

    const text = analysis.length
      ? `📊 <b>Status Report</b>\n\n` + analysis.join("\n\n")
      : "✅ Нет срочных действий";
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: "HTML" });
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

// ── /ping ─────────────────────────────────────────────────────────────────────
bot.command("ping", ctx => guard(ctx, async () => {
  const full = ctx.message.text.replace("/ping", "").trim();
  const parts = full.split("|");
  if (parts.length < 2) return ctx.reply("❌ Формат: /ping Имя чата | Текст сообщения");

  const chatName = parts[0].trim();
  const text = parts.slice(1).join("|").trim();

  const msg = await ctx.reply(`⏳ Ищу чат "${chatName}"...`);
  try {
    const found = await proxyPost("/beeper/find-chat", { name: chatName });
    if (!found.found || !found.chats?.length) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Чат "${chatName}" не найден`);
    }
    if (found.chats.length > 1) {
      const kb = new InlineKeyboard();
      found.chats.slice(0, 5).forEach(c => {
        kb.text(`${c.network}: ${c.name}`, `send_${c.id}||${encodeURIComponent(text)}`).row();
      });
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id,
        "Найдено несколько чатов. Выбери куда отправить:", { reply_markup: kb });
    }
    const chat = found.chats[0];
    const sent = await proxyPost("/beeper/send", { chatId: chat.id, text });
    if (sent.ok) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id,
        `✅ Отправлено в <b>${esc(chat.name)}</b> [${chat.network}]\n\n<i>${esc(text)}</i>`,
        { parse_mode: "HTML" });
    } else throw new Error(sent.error || "Unknown error");
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

bot.callbackQuery(/^send_(.+)\|\|(.+)$/, async ctx => {
  const chatId = ctx.match[1];
  const text = decodeURIComponent(ctx.match[2]);
  try {
    const sent = await proxyPost("/beeper/send", { chatId, text });
    if (sent.ok) {
      await ctx.editMessageText(`✅ Отправлено!\n\n<i>${esc(text)}</i>`, { parse_mode: "HTML" });
    } else await ctx.editMessageText("❌ Ошибка отправки");
  } catch (e) {
    await ctx.editMessageText(`❌ ${e.message}`);
  }
  await ctx.answerCallbackQuery();
});

// ── /enrich ───────────────────────────────────────────────────────────────────
bot.command("enrich", ctx => guard(ctx, async () => {
  const input = ctx.message.text.replace("/enrich", "").trim();
  const parts = input.split("/");
  const name = parts[0]?.trim();
  const company = parts[1]?.trim();
  if (!name) return ctx.reply("❌ Формат: /enrich Имя / Компания");

  const msg = await ctx.reply(`⏳ Ищу ${name} в Apollo...`);
  try {
    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");
    const data = await proxyPost("/apollo/match", {
      apolloKey: APOLLO_KEY, firstName, lastName, organizationName: company,
    });
    if (!data) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${name} не найден в Apollo`);
    }
    const p = data;
    const text = `👤 <b>${esc(p.name)}</b>
🏢 ${esc(p.title || "—")} @ ${esc(p.company || "—")}
📍 ${esc(p.location || "—")}
✉️ ${esc(p.email || "не найден")}
🔗 ${p.linkedin ? `<a href="${p.linkedin}">LinkedIn</a>` : "—"}
💰 ${esc(p.totalFunding || "—")} | ${esc(p.latestFunding || "—")}
👥 ${p.companyEmployees ? `~${p.companyEmployees} чел.` : "—"}`;

    const kb = new InlineKeyboard()
      .text("➕ Добавить в Notion", `addnotion_${encodeURIComponent(JSON.stringify({
        firstName: p.firstName, lastName: p.lastName, title: p.title,
        company: p.company, linkedin: p.linkedin, email: p.email,
        companyWebsite: p.companyWebsite,
      }))}`);
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, text,
      { parse_mode: "HTML", reply_markup: kb });
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

bot.callbackQuery(/^addnotion_(.+)$/, async ctx => {
  try {
    const person = JSON.parse(decodeURIComponent(ctx.match[1]));
    const data = await proxyPost("/notion/upsert-lead", { ...person, status: "Not Started" });
    const newText = (ctx.message?.text || "") + (data.ok ? "\n\n✅ Добавлен в Notion CRM" : "\n\n❌ Ошибка Notion");
    await ctx.editMessageText(newText, { parse_mode: "HTML" });
  } catch (e) {
    await ctx.editMessageText(`❌ ${e.message}`);
  }
  await ctx.answerCallbackQuery();
});

// ── /addlead ──────────────────────────────────────────────────────────────────
bot.command("addlead", ctx => guard(ctx, async () => {
  const input = ctx.message.text.replace("/addlead", "").trim();
  const parts = input.split("/");
  const name = parts[0]?.trim();
  const company = parts[1]?.trim();
  if (!name || !company) return ctx.reply("❌ Формат: /addlead Имя / Компания");

  const msg = await ctx.reply(`⏳ Добавляю ${name}...`);
  try {
    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");
    const person = await proxyPost("/apollo/match", {
      apolloKey: APOLLO_KEY, firstName, lastName, organizationName: company,
    });
    const lead = person || { firstName, lastName };
    await proxyPost("/notion/upsert-lead", {
      firstName: lead.firstName || firstName, lastName: lead.lastName || lastName,
      title: lead.title, company: lead.company || company,
      linkedin: lead.linkedin, email: lead.email,
      companyWebsite: lead.companyWebsite, status: "Not Started",
    });
    const enriched = person ? "✅ enriched" : "⚠️ manual";
    const text = `✅ <b>${esc(name)}</b> → Notion [${enriched}]
🏢 ${esc(lead.company || company)}
✉️ ${esc(lead.email || "email не найден")}`;
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: "HTML" });
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

// ── /campaigns ────────────────────────────────────────────────────────────────
bot.command("campaigns", ctx => guard(ctx, async () => {
  const msg = await ctx.reply("⏳ Загружаю кампании...");
  try {
    const data = await proxyPost("/heyreach/proxy", {
      hrKey: HR_KEY, path: "/campaign/GetAll", payload: { pageNumber: 0, pageSize: 20 },
    });
    const campaigns = data?.items || data?.campaigns || [];
    if (!campaigns.length) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, "❌ Кампании не найдены");
    }
    const lines = campaigns.slice(0, 15).map(c =>
      `• <b>${esc(c.name)}</b> [${c.status || "—"}] — <code>${c.id}</code>`
    );
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `📢 <b>Кампании (${campaigns.length})</b>\n\n` + lines.join("\n"),
      { parse_mode: "HTML" });
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

// ── /replies ──────────────────────────────────────────────────────────────────
bot.command("replies", ctx => guard(ctx, async () => {
  const msg = await ctx.reply("⏳ Загружаю ответы LinkedIn...");
  try {
    const data = await proxyPost("/heyreach/proxy", {
      hrKey: HR_KEY, path: "/linkedin-conversations/GetAll",
      payload: { pageNumber: 0, pageSize: 10, onlyWithReplies: true },
    });
    const convos = data?.items || data?.conversations || [];
    if (!convos.length) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, "📭 Новых ответов нет");
    }
    const lines = convos.slice(0, 10).map(c =>
      `👤 <b>${esc(c.leadFullName || "?")}</b> @ ${esc(c.leadCompanyName || "?")}\n<i>${esc(trunc(c.lastMessage || "", 100))}</i>`
    );
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `💬 <b>Ответы LinkedIn</b>\n\n` + lines.join("\n\n"),
      { parse_mode: "HTML" });
  } catch (e) {
    return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`);
  }
}));

// ══════════════════════════════════════════════════════════════════════════════
// AI — обработка любого свободного текста
// ══════════════════════════════════════════════════════════════════════════════
bot.on("message:text", ctx => guard(ctx, async () => {
  // Пропускаем команды
  if (ctx.message.text.startsWith("/")) return;
  if (!ANTHROPIC_KEY) {
    return ctx.reply("ℹ️ AI режим недоступен (нет ANTHROPIC_API_KEY). Используй команды: /help");
  }

  const userText = ctx.message.text;
  const msg = await ctx.reply("🤔 Думаю...");

  try {
    // Определяем нужен ли нам контекст из Beeper
    const needsBeeper = /чат|переписк|сообщ|inbox|discovery|пинг|статус|ответ|партнёр|карточ/i.test(userText);

    let contextData = "";
    if (needsBeeper) {
      // Подтягиваем свежий inbox для контекста
      try {
        const inbox = await proxyGet("/beeper/inbox?network=all&limit=20");
        if (inbox.ok) {
          contextData = "Текущий inbox (последние 20 чатов):\n" +
            inbox.chats.map(c => `• ${c.chatName}: ${c.lastMsg}`).join("\n");
        }
      } catch (_) {}
    }

    const answer = await askClaude(userText, contextData);
    if (!answer) throw new Error("Claude не ответил");

    const chunks = splitMessage(answer);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(chunks[i]);
    }
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `❌ Ошибка AI: ${e.message}\n\nПопробуй команды: /help`);
  }
}));

// ── Error handler ─────────────────────────────────────────────────────────────
bot.catch(err => {
  console.error("[bot] Error:", err.message);
});

// ── Start ─────────────────────────────────────────────────────────────────────
console.log("[bot] Plexo Loop Bot starting" + (ANTHROPIC_KEY ? " (AI mode ON)" : " (AI mode OFF)"));
bot.start().then(() => {
  console.log("[bot] Plexo Loop Bot started");
}).catch(err => {
  console.error("[bot] Start error (non-fatal):", err.message);
});
