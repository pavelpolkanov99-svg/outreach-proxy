const { Bot } = require("grammy");
const axios   = require("axios");
const cron    = require("node-cron");

const agent          = require("./lib/agent");
const approvalFlow   = require("./lib/approval-flow");
const conversationStore = require("./lib/conversation-store");

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const PROXY        = process.env.PROXY_URL || "https://outreach-proxy-production-eb03.up.railway.app";
const VERSION      = "4.27.0-discovery-digest";
const STARTED_AT   = new Date();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const MORNING_PUSH_USERS = (process.env.MORNING_PUSH_USERS || "156632707")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID
  ? parseInt(process.env.GROUP_CHAT_ID.trim(), 10)
  : null;

const ANTON_TG_ID = process.env.ANTON_TG_ID
  ? parseInt(process.env.ANTON_TG_ID.trim(), 10)
  : null;

const CONVERSATIONAL_MODE = process.env.CONVERSATIONAL_MODE_ENABLED === "true";
const PAVEL_TG_ID = 156632707;

const bot = new Bot(BOT_TOKEN);

let BOT_USERNAME = null;
let BOT_ID       = null;

process.on("uncaughtException", err => { console.error("[bot] Uncaught exception (ignored):", err.message); });
process.on("unhandledRejection", err => { console.error("[bot] Unhandled rejection (ignored):", err?.message || err); });

function isAllowed(ctx) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(ctx.from?.id);
}

function guard(ctx, fn) {
  console.log(`[bot] msg from ${ctx.from?.id} (${ctx.from?.username || "no_username"}): ${ctx.message?.text || "no_text"}`);
  if (!isAllowed(ctx)) { console.log(`[bot] denied: ${ctx.from?.id} not in whitelist`); return ctx.reply("⛔ Access denied."); }
  return fn();
}

function whoIs(ctx) {
  const id = ctx.from?.id;
  if (id === PAVEL_TG_ID) return "pavel";
  if (ANTON_TG_ID && id === ANTON_TG_ID) return "anton";
  return "anton";
}

function isGroupChat(ctx) {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup";
}

function stripBotMention(text, botUsername) {
  const raw = String(text || "");
  if (!botUsername) return { mentioned: false, text: raw };
  const re = new RegExp(`@${botUsername}\\b`, "ig");
  const mentioned = re.test(raw);
  if (!mentioned) return { mentioned: false, text: raw };
  const cleaned = raw.replace(re, " ").replace(/\s{2,}/g, " ").trim();
  return { mentioned: true, text: cleaned };
}

function isAddressedToBotInGroup(ctx, botUsername, botId) {
  const text = ctx.message?.text || "";
  const { mentioned } = stripBotMention(text, botUsername);
  if (mentioned) return true;
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.id === botId) return true;
  return false;
}

function esc(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToTelegramHtml(md) {
  if (!md) return "";
  let s = String(md);
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) => `<pre>${code.replace(/\n$/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, "$1<i>$2</i>$3");
  s = s.replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, "$1<i>$2</i>$3");
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/^[ \t]*[-*+]\s+/gm, "• ");
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
    timer = setTimeout(() => { console.error(`[bot] ${label} timed out after ${ms}ms`); resolve({ __timeout: true }); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const RU_MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];

function buildRussianHeaderDate() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Prague", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const parts = fmt.formatToParts(new Date());
  const day   = parseInt(parts.find(p => p.type === "day").value, 10);
  const month = parseInt(parts.find(p => p.type === "month").value, 10);
  const wkShort = parts.find(p => p.type === "weekday").value;
  const wkMap = { Sun: "воскресенье", Mon: "понедельник", Tue: "вторник", Wed: "среда", Thu: "четверг", Fri: "пятница", Sat: "суббота" };
  return `${day} ${RU_MONTHS[month - 1]}, ${wkMap[wkShort] || ""}`;
}

function buildLeanHeader() { return `☀️ <b>Доброе утро.</b> ${buildRussianHeaderDate()}.`; }

const MAX_MESSAGE_LEN = 4000;
const SECTION_SEP = "\n\n━━━━━━━━━━━━━━━\n\n";

function splitForTelegram(text) {
  if (!text || text.length <= MAX_MESSAGE_LEN) return [text];
  const sections = text.split(SECTION_SEP);
  const chunks = [];
  let current = "";
  for (const section of sections) {
    const wouldBe = current ? current + SECTION_SEP + section : section;
    if (wouldBe.length <= MAX_MESSAGE_LEN) { current = wouldBe; continue; }
    if (current) { chunks.push(current); current = ""; }
    if (section.length <= MAX_MESSAGE_LEN) { current = section; continue; }
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
  const sendOpts = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...opts };
  await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, chunks[0], sendOpts);
  for (let i = 1; i < chunks.length; i++) await ctx.api.sendMessage(ctx.chat.id, chunks[i], sendOpts);
}

async function sendSplit(chatId, fullText, opts = {}) {
  const chunks = splitForTelegram(fullText);
  const sendOpts = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...opts };
  for (const chunk of chunks) await bot.api.sendMessage(chatId, chunk, sendOpts);
}

async function sendToAllTargets(text, label = "push") {
  const targets = [...MORNING_PUSH_USERS];
  if (GROUP_CHAT_ID && !targets.includes(GROUP_CHAT_ID)) targets.push(GROUP_CHAT_ID);
  for (const chatId of targets) {
    try { await sendSplit(chatId, text); console.log(`[cron] ${label} sent to ${chatId}`); }
    catch (err) { console.error(`[cron] ${label} to ${chatId} failed:`, err.message); }
  }
}

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
  if (hkTag) { const m = hkTag.match(/HK-?(\d+)/i); return { hardKill: true, code: m ? `HK-${m[1]}` : "HK", emoji: "🔴" }; }
  const score = company.bdScore;
  if (score == null) return null;
  if (score >= 9.0) return { tier: "MH", emoji: "🟢", score };
  if (score >= 7.5) return { tier: "P1", emoji: "🟢", score };
  if (score >= 5.0) return { tier: "P2", emoji: "🟡", score };
  return { tier: "P3", emoji: "⚪", score };
}

const HK_DESCRIPTIONS = {
  "HK-1": "RWA tokenization only", "HK-2": "DeFi-native, no KYC", "HK-3": "Traditional private banking",
  "HK-4": "Custody/trading only", "HK-5": "Consulting/advisory", "HK-6": "Merchant payments / e-commerce",
  "HK-7": "Pure fiat BaaS, no crypto rails", "HK-8": "Retail-only on-ramp widget",
  "HK-9": "Payroll / HR cross-border", "HK-10": "Compliance/analytics SaaS", "HK-11": "Media/news/research",
};

const NET_BADGE = { "LI": "💼", "LinkedIn": "💼", "TG": "✈️", "Telegram": "✈️", "WA": "💚", "WhatsApp": "💚" };
const NETWORK_HEADER_EMOJI = (h) => h === "LinkedIn" ? "💼" : h === "Telegram" ? "✈️" : h.startsWith("WhatsApp") ? "💚" : "💬";
const TASK_PRIORITY_EMOJI = { "High": "🔴", "Medium": "🟡", "Low": "⚪" };

function dueLabel(d) {
  if (d == null) return "";
  if (d > 0) return ` · <b>${d}d overdue</b>`;
  if (d === 0) return " · <b>today</b>";
  return ` · in ${Math.abs(d)}d`;
}

function shortStartTime(t) {
  if (!t) return "";
  const m = String(t).match(/^(\d{1,2}:\d{2})/);
  return m ? m[1] : t;
}

function renderEventLean(ev) {
  const lines = [];
  const startTime = shortStartTime(ev.timeRange);
  if (ev.isInternal) { lines.push(`<code>${startTime}</code>  <b>${esc(ev.summary)}</b> · <i>internal/focus</i>`); return lines.join("\n"); }
  const indent = "       ";
  const crm = ev.notion;
  const p = ev.attendeePerson;
  const headlineParts = [];
  if (p) { const pn = p.name || p.email?.split("@")[0] || null; if (pn) { const lp = p.linkedin ? ` <a href="${esc(p.linkedin)}">↗</a>` : ""; headlineParts.push(`${esc(pn)}${lp}`); } }
  if (crm?.name) headlineParts.push(`<b>${esc(crm.name)}</b>`);
  else if (ev.primaryDomain) headlineParts.push(`<b>${esc(ev.primaryDomain)}</b>`);
  if (crm) {
    const t = tierFromCompany(crm);
    if (t?.hardKill) {
      const hkDesc = HK_DESCRIPTIONS[t.code] || "Hard Kill";
      headlineParts.push(`🔴 <b>Hard Kill — ${esc(t.code)}</b>`);
      lines.push(`<code>${startTime}</code>  ${headlineParts.join(" · ")}`);
      lines.push(`${indent}└ <i>${esc(hkDesc)} · Anton, замни диалог</i>`);
      if (ev.meetUrl) lines.push(`${indent}<a href="${esc(ev.meetUrl)}">Join</a> → ${esc(ev.meetUrl.replace(/^https?:\/\//, ""))}`);
      return lines.join("\n");
    }
    if (t) { const sp = crm.stage ? ` · ${esc(crm.stage)}` : ""; headlineParts.push(`${t.emoji} <b>${t.tier}</b> ${t.score}${sp}`); }
    else if (crm.stage) headlineParts.push(`⚪ ${esc(crm.stage)}`);
  } else headlineParts.push(`🆕 <i>not in CRM</i>`);
  if (headlineParts.length === 0) headlineParts.push(`<b>${esc(ev.summary)}</b>`);
  lines.push(`<code>${startTime}</code>  ${headlineParts.join(" · ")}`);
  if (crm?.insight?.bullets?.length) { const top = crm.insight.bullets[0]; if (top) lines.push(`${indent}└ ${esc(top)}`); }
  if (ev.meetUrl) { const su = ev.meetUrl.replace(/^https?:\/\//, ""); lines.push(`${indent}<a href="${esc(ev.meetUrl)}">Join</a> → ${esc(su)}`); }
  return lines.join("\n");
}

function renderStaleDealLean(deal) {
  const stage = deal.stage || "";
  const isHot = stage === "Negotiations" || stage === "Call Scheduled";
  const emoji = isHot ? "🔴" : "🟡";
  const ss = stage.replace(/discussions/i, "").trim();
  const days = deal.daysStale != null ? `${deal.daysStale}д` : "?";
  const headline = `${emoji} <b>${esc(deal.name)}</b> (${esc(ss)} · ${days})`;
  if (isHot && deal.lastActivitySnippet) return `${headline} — <i>${esc(deal.lastActivitySnippet)}</i>`;
  return headline;
}

function renderTask(task) {
  const emoji = TASK_PRIORITY_EMOJI[task.priority] || "⚪";
  const due = dueLabel(task.daysOverdue);
  const n = task.name.length > 80 ? task.name.slice(0, 77) + "..." : task.name;
  const lines = [`${emoji} <b>${esc(n)}</b>${due}`];
  if (task.description && task.description.length > 5) lines.push(`   <i>${esc(task.description)}</i>`);
  if (task.companyName) lines.push(`   🏢 ${esc(task.companyName)}`);
  return lines.join("\n");
}

function renderTaskGroup(group) {
  const emoji = TASK_PRIORITY_EMOJI[group.priority] || "⚪";
  const due = dueLabel(group.daysOverdue);
  const t = group.template.length > 80 ? group.template.slice(0, 77) + "..." : group.template;
  const lines = [`${emoji} <b>${esc(t)}</b>  · <b>×${group.count}</b>${due}`];
  const companies = group.companies || [];
  if (companies.length > 0) { const v = companies.slice(0, 5).map(esc); const ov = companies.length > 5 ? ` · +${companies.length - 5}` : ""; lines.push(`   🏢 ${v.join(" · ")}${ov}`); }
  return lines.join("\n");
}

function renderTaskItem(item) { return item.kind === "group" ? renderTaskGroup(item) : renderTask(item.task); }

function renderCompletedTask(task) {
  const cd = task.completedAt ? daysAgo(task.completedAt) : null;
  const dl = cd ? ` · <i>${cd}</i>` : "";
  const n = task.name.length > 80 ? task.name.slice(0, 77) + "..." : task.name;
  const lines = [`✅ ${esc(n)}${dl}`];
  if (task.companyName) lines.push(`   🏢 ${esc(task.companyName)}`);
  return lines.join("\n");
}

function renderReply(reply) {
  const nb = NET_BADGE[reply.networkFull] || NET_BADGE[reply.network] || "💬";
  const idle = reply.hoursIdle != null ? `${Math.round(reply.hoursIdle)}h` : "?";
  const nl = reply.networkFull || reply.network || "Chat";
  const cn = renderClickableName(reply.name, reply.deeplink);
  const lines = [`${nb} ${cn} · ${esc(nl)} · <b>${idle}</b>`];
  const snippet = (reply.lastMsgText || "").slice(0, 200);
  if (snippet) lines.push(`   <i>"${esc(snippet)}"</i>`);
  if (reply.notion?.name) {
    const t = tierFromCompany(reply.notion);
    const parts = [`🟢 <b>${esc(reply.notion.name)}</b>`];
    if (t && !t.hardKill) parts.push(`${t.tier} · ${t.score}`);
    else if (reply.notion.bdScore != null) parts.push(`BD ${reply.notion.bdScore}`);
    if (reply.notion.stage) parts.push(esc(reply.notion.stage));
    lines.push(`   ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}

async function fetchCalendar() {
  try { const r = await axios.get(`${PROXY}/calendar/today`, { timeout: 20_000 }); return r.data; }
  catch (err) { return { ok: false, error: err.message }; }
}

async function fetchStaleDeals({ days = 14, limit = 5 } = {}) {
  try { const r = await axios.get(`${PROXY}/notion/stale-deals-enriched`, { params: { days, limit }, timeout: 18_000 }); return r.data?.deals || []; } catch (_) {}
  try { const r = await axios.get(`${PROXY}/notion/stale-deals`, { params: { days, limit }, timeout: 15_000 }); return r.data?.deals || []; }
  catch (err) { return null; }
}

async function fetchTasksToday({ limit = 20 } = {}) {
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, { params: { limit }, timeout: 15_000 });
    const data = r.data || {};
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.tasks) ? data.tasks.map(t => ({ kind: "single", task: t })) : [];
    const tasksFlat = Array.isArray(data.tasks) ? data.tasks : [];
    return { items, totalRaw: data.total ?? tasksFlat.length, overdueRaw: tasksFlat.filter(t => t.daysOverdue > 0).length };
  } catch (err) { return null; }
}

async function fetchTasksCompleted({ days = 3, limit = 20 } = {}) {
  try { const r = await axios.get(`${PROXY}/notion/tasks-completed`, { params: { days, limit }, timeout: 12_000 }); return Array.isArray(r.data?.tasks) ? r.data.tasks : []; }
  catch (err) { return null; }
}

async function fetchRepliesWaitingResilient({ hoursIdle = 4, limit = 8, days = 7 } = {}) {
  try { const r = await axios.get(`${PROXY}/beeper/replies-waiting`, { params: { hoursIdle, limit, days }, timeout: 15_000 }); return { source: "beeper", replies: r.data?.replies || [] }; } catch (_) {}
  try { const r = await axios.get(`${PROXY}/messaging-hub/replies-waiting`, { params: { hoursIdle, limit, days }, timeout: 12_000 }); return { source: "messaging-hub", replies: r.data?.replies || [] }; }
  catch (err) { return null; }
}

async function fetchYesterdaySummary() {
  try { const r = await axios.get(`${PROXY}/yesterday/summary`, { timeout: 60_000 }); return r.data; }
  catch (err) { return null; }
}

async function fetchTodayLean() {
  try { const r = await axios.get(`${PROXY}/today/lean`, { timeout: 60_000 }); return r.data || {}; }
  catch (err) { return null; }
}

async function fetchDiscoveryDigest() {
  try { const r = await axios.get(`${PROXY}/discovery/digest`, { timeout: 120_000 }); return r.data; }
  catch (err) { return null; }
}

function buildCalendarSectionLean(cr) {
  if (cr?.__timeout) return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\n<i>⚠️ Календарь не ответил.</i>`;
  if (!cr || !cr.ok) return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\n<i>❌ Calendar error: ${esc(cr?.error || "unknown")}</i>`;
  if (!cr.events?.length) return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b>\n\nКалендарь пустой 🌴`;
  return `📅 <b>ВСТРЕЧИ СЕГОДНЯ</b> · <i>${cr.total}</i>\n\n` + cr.events.map(renderEventLean).join("\n\n");
}

function buildMainMovesSection(ld) {
  if (!ld || ld.__timeout) return null;
  const moves = ld.mainMoves || [];
  if (!moves.length) return null;
  const lines = moves.map((m, i) => {
    const rank = m.rank || (i + 1);
    const tp = m.tierEmoji && m.tierLabel ? `${m.tierEmoji} <b>${esc(m.tierLabel)}</b>` : (m.tierEmoji || (m.tierLabel ? `<b>${esc(m.tierLabel)}</b>` : ""));
    const hb = [m.company ? `<b>${esc(m.company)}</b>` : ""];
    if (tp) hb.push(tp);
    const header = `${rank}. ${hb.filter(Boolean).join(" · ")} — ${m.action ? esc(m.action) : ""}`;
    return m.context ? `${header}\n   ↳ <i>${esc(m.context)}</i>` : header;
  });
  return `🎯 <b>ГЛАВНЫЕ ХОДЫ</b> · <i>${moves.length}</i>\n\n` + lines.join("\n\n");
}

function buildRepliesWaitingSection(ld) {
  if (!ld || ld.__timeout) return null;
  const replies = ld.repliesWaiting || [];
  if (!replies.length) return null;
  const lines = replies.map(r => {
    const nb = NET_BADGE[r.network] || "💬";
    const idle = r.daysIdle ? ` · ${esc(r.daysIdle)}` : "";
    const name = r.name ? `<b>${esc(r.name)}</b>` : "";
    const meta = [r.network ? esc(r.network) : "", r.tierEmoji ? r.tierEmoji + (r.tierLabel ? " " + esc(r.tierLabel) : "") : ""].filter(s => s?.trim()).join(" · ");
    const header = `${nb} ${name}${meta ? " · " + meta : ""}${idle}`;
    return r.context ? `${header}\n   <i>${esc(r.context)}</i>` : header;
  });
  return `💬 <b>ОТВЕТЫ ЖДУТ</b> · <i>${replies.length}</i>\n\n` + lines.join("\n\n");
}

function buildStuckNoDeadlineSection(ld) {
  if (!ld || ld.__timeout) return null;
  const stuck = ld.stuckNoDeadline || [];
  if (!stuck.length) return null;
  const parts = stuck.map(s => `<b>${esc(s.name || "?")}</b> (${s.daysStuck != null ? s.daysStuck + "д" : "?д"}${s.stageShort ? ", " + esc(s.stageShort) : ""})`);
  return `🪦 <b>STUCK БЕЗ DEADLINE</b> · <i>${stuck.length}</i>\n` + parts.join(" · ") + `\n<i>↳ snooze, Lost, или попытка — посмотри на неделе · /stale</i>`;
}

function buildYesterdayPipelineSection(ld) {
  if (!ld || ld.__timeout) return null;
  const yp = ld.yesterdayPipeline || {};
  const win = Array.isArray(yp.win) ? yp.win : [];
  const movement = Array.isArray(yp.movement) ? yp.movement : [];
  if (!win.length && !movement.length) return null;
  const secs = [];
  if (win.length) secs.push(`✅ <b>Win</b>\n` + win.map(b => `   • ${esc(b)}`).join("\n"));
  if (movement.length) secs.push(`🔄 <b>Movement</b> <i>(не требует действий сегодня)</i>\n` + movement.map(b => `   • ${esc(b)}`).join("\n"));
  return `📊 <b>ВЧЕРА В PIPELINE</b>\n\n` + secs.join("\n\n");
}

function buildStaleSectionLean(stale) {
  if (stale?.__timeout) return `🟡 <b>ЗАГЛОХЛИ · решить</b>\n\n<i>⚠️ Notion не ответил по сделкам.</i>`;
  if (!Array.isArray(stale) || !stale.length) return null;
  const hot = stale.filter(d => d.stage === "Negotiations" || d.stage === "Call Scheduled");
  const warm = stale.filter(d => !(d.stage === "Negotiations" || d.stage === "Call Scheduled"));
  const lines = hot.map(renderStaleDealLean);
  if (warm.length) lines.push(`🟡 ` + warm.map(d => `${esc(d.name)} (${(d.stage || "").replace(/discussions/i, "").trim()} · ${d.daysStale != null ? d.daysStale + "д" : "?"})`).join(", "));
  return `🟡 <b>ЗАГЛОХЛИ · решить</b>\n\n` + lines.join("\n");
}

function buildFooter() { return `<i>/details · /full · /stale · /replies · /discovery</i>`; }

function buildTasksSectionFull(td, ct) {
  if (!td || td.__timeout) return `📋 <b>Задачи</b>\n\n<i>⚠️ Notion не ответил по задачам.</i>`;
  if (td.items?.length) {
    const { items, totalRaw, overdueRaw } = td;
    const counter = overdueRaw > 0 ? `<i>${totalRaw} задач · ${overdueRaw} просрочено</i>` : `<i>${totalRaw} задач на сегодня</i>`;
    return `📋 <b>Задачи</b>  · ${counter}\n\n` + items.map(renderTaskItem).join("\n\n");
  }
  if (Array.isArray(ct) && ct.length > 0) {
    const top = ct.slice(0, 8);
    const ov = ct.length > top.length ? `\n\n<i>...и ещё ${ct.length - top.length} закрытых задач</i>` : "";
    return `✅ <b>Все задачи под контролем</b>  · <i>${ct.length} закрыто за 3 дня</i>\n\n` + top.map(renderCompletedTask).join("\n") + ov;
  }
  return null;
}

function buildRepliesSectionFull(rr) {
  if (!rr) return null;
  const { source, replies } = rr;
  if (!Array.isArray(replies) || !replies.length) return null;
  const sl = source === "messaging-hub" ? " · <i>из Messaging Hub</i>" : "";
  return `💬 <b>Ждут ответа</b>  · <i>${replies.length} чатов &gt;4h</i>${sl}\n\n` + replies.map(renderReply).join("\n\n");
}

function buildYesterdaySectionFull(summary) {
  if (!summary) return `📆 <b>Что было вчера</b>\n\n<i>⚠️ Не удалось получить summary мессенджеров.</i>`;
  if (!summary.ok) return null;
  const networks = summary.networks || [];
  const isFiltered = summary.filteredBy === "late-stages";
  let filterTag = "";
  if (isFiltered) { const dc = summary.dropped || 0; filterTag = dc > 0 ? `  · <i>только важные сделки (скрыто ${dc} не-важных)</i>` : `  · <i>только важные сделки</i>`; }
  let sourceLabel = "";
  if (summary.source === "hub-fresh") sourceLabel = `  · <i>из Messaging Hub</i>`;
  else if (summary.source === "hub-stale") sourceLabel = `  · <i>данные за ${esc(summary.dataDate)}</i>`;
  else if (summary.source === "hub-empty") return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности не было.</i>`;
  if (!networks.length) {
    if (isFiltered && summary.totalBeforeFilter > 0) return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности по поздним статусам не было.</i>`;
    return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n<i>Активности не было.</i>`;
  }
  const blocks = [];
  for (const net of networks) {
    const lines = [];
    const emoji = NETWORK_HEADER_EMOJI(net.header);
    const tl = net.totalChats > 0 ? `  · <i>${net.totalChats} чатов</i>` : "";
    lines.push(`${emoji} <b>${esc(net.header)}</b>${tl}`);
    const bullets = (net.summary?.bullets || []).filter(Boolean);
    if (bullets.length) { lines.push(""); for (const b of bullets) lines.push(`   • ${esc(b)}`); }
    if (Array.isArray(net.topChats) && net.topChats.length && summary.source !== "hub-stale") {
      lines.push("");
      for (const c of net.topChats) {
        const arrow = c.direction === "→" ? "→" : "←";
        const dn = (c.name || "").length > 40 ? (c.name || "").slice(0, 40) + "..." : c.name;
        const cn = renderClickableName(dn, c.deeplink);
        const sp = c.crmStage ? ` <i>(${esc(c.crmStage)})</i>` : "";
        lines.push(`   <code>${arrow}</code> ${cn}${sp}: <i>${esc(c.snippet || "")}</i>`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  return `📆 <b>Что было вчера (${esc(summary.yesterdayLabel)})</b>${filterTag}${sourceLabel}\n\n` + blocks.join("\n\n");
}

function composeLeanDigest({ calendarRes, leanData }, { customHeader } = {}) {
  const sections = [customHeader || buildLeanHeader(), buildCalendarSectionLean(calendarRes)];
  const mm = buildMainMovesSection(leanData); if (mm) sections.push(mm);
  const rw = buildRepliesWaitingSection(leanData); if (rw) sections.push(rw);
  const snd = buildStuckNoDeadlineSection(leanData); if (snd) sections.push(snd);
  const yp = buildYesterdayPipelineSection(leanData); if (yp) sections.push(yp);
  sections.push(buildFooter());
  return sections.join(SECTION_SEP);
}

function composeDetailsDigest({ calendarRes, tasksData, stale, repliesResult, completedTasks }, { customHeader } = {}) {
  const sections = [customHeader || `📋 <b>ДЕТАЛИ</b> · <i>полные источники</i>`, buildCalendarSectionLean(calendarRes)];
  const tb = buildTasksSectionFull(tasksData, completedTasks); if (tb) sections.push(tb);
  const rb = buildRepliesSectionFull(repliesResult); if (rb) sections.push(rb);
  const sb = buildStaleSectionLean(stale); if (sb) sections.push(sb);
  return sections.join(SECTION_SEP);
}

function composeFullDigest(allData, { customHeader } = {}) {
  const sections = [customHeader || `🗂 <b>ПОЛНЫЙ ДАЙДЖЕСТ</b>`, buildCalendarSectionLean(allData.calendarRes)];
  const mm = buildMainMovesSection(allData.leanData); if (mm) sections.push(mm);
  const rw = buildRepliesWaitingSection(allData.leanData); if (rw) sections.push(rw);
  const snd = buildStuckNoDeadlineSection(allData.leanData); if (snd) sections.push(snd);
  const yp = buildYesterdayPipelineSection(allData.leanData); if (yp) sections.push(yp);
  const tb = buildTasksSectionFull(allData.tasksData, allData.completedTasks); if (tb) sections.push(tb);
  const rb = buildRepliesSectionFull(allData.repliesResult); if (rb) sections.push(rb);
  const yb = buildYesterdaySectionFull(allData.yesterdaySummary); if (yb) sections.push(yb);
  const sb = buildStaleSectionLean(allData.stale); if (sb) sections.push(sb);
  return sections.join(SECTION_SEP);
}

async function fetchLeanDigestData() {
  const [calendarRes, leanData] = await Promise.all([withTimeout(fetchCalendar(), 20_000, "calendar"), withTimeout(fetchTodayLean(), 65_000, "today-lean")]);
  return { calendarRes, leanData };
}

async function fetchDetailsData() {
  const [calendarRes, tasksData, stale, repliesResult] = await Promise.all([
    withTimeout(fetchCalendar(), 20_000, "calendar"), withTimeout(fetchTasksToday({ limit: 20 }), 15_000, "tasks"),
    withTimeout(fetchStaleDeals({ days: 14, limit: 10 }), 20_000, "stale"), withTimeout(fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 }), 30_000, "replies"),
  ]);
  let completedTasks = null;
  if (tasksData && !tasksData.__timeout && (!tasksData.items || !tasksData.items.length)) {
    completedTasks = await withTimeout(fetchTasksCompleted({ days: 3, limit: 20 }), 12_000, "completed-tasks");
    if (completedTasks?.__timeout) completedTasks = null;
  }
  return { calendarRes, tasksData, stale, repliesResult, completedTasks };
}

async function fetchAllData() {
  const [calendarRes, leanData, tasksData, stale, repliesResult, yesterdaySummary] = await Promise.all([
    withTimeout(fetchCalendar(), 20_000, "calendar"), withTimeout(fetchTodayLean(), 65_000, "today-lean"),
    withTimeout(fetchTasksToday({ limit: 20 }), 15_000, "tasks"), withTimeout(fetchStaleDeals({ days: 14, limit: 10 }), 20_000, "stale"),
    withTimeout(fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 }), 30_000, "replies"), withTimeout(fetchYesterdaySummary(), 65_000, "yesterday-summary"),
  ]);
  let completedTasks = null;
  if (tasksData && !tasksData.__timeout && (!tasksData.items || !tasksData.items.length)) {
    completedTasks = await withTimeout(fetchTasksCompleted({ days: 3, limit: 20 }), 12_000, "completed-tasks");
    if (completedTasks?.__timeout) completedTasks = null;
  }
  const ySummary = (yesterdaySummary && !yesterdaySummary.__timeout) ? yesterdaySummary : null;
  return { calendarRes, leanData, tasksData, stale, repliesResult, completedTasks, yesterdaySummary: ySummary };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversational layer
// ─────────────────────────────────────────────────────────────────────────────

async function renderAgentResult(ctx, statusMsg, result) {
  let budgetNote = "";
  try { const crossing = conversationStore.checkBudgetCrossing(); if (crossing) budgetNote = `\n\n<i>💸 Сегодня потрачено $${crossing.costUsd.toFixed(2)} — дневной бюджет $${crossing.budgetDailyUsd} пройден (${crossing.msgs} сообщений). Не блокирую, просто для инфо.</i>`; } catch (_) {}

  if (result.kind === "final") { await editAndSplit(ctx, statusMsg, mdToTelegramHtml((result.text || "").trim() || "(пустой ответ)") + budgetNote); return; }
  if (result.kind === "approval") {
    const { pending } = result;
    const { approvalId } = approvalFlow.createApproval(pending);
    const summary = pending.approvalSummary || `Выполнить ${pending.toolName}`;
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `🔐 <b>Нужно подтверждение</b>\n\n${summary}\n\n<i>Это write-операция. Подтверди или отклони.</i>${budgetNote}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: approvalFlow.buildInlineKeyboard(approvalId) });
    return;
  }
  if (result.kind === "tool_failed") { await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `⚠️ <b>Не получилось выполнить</b> <code>${esc(result.toolName)}</code>\nПопробовал ${result.attempts || 2} раза. Ошибка:\n<i>${esc(result.error || "unknown")}</i>\n\n@Rvn2332 — глянь логи?\n\n<i>Напиши что делать — попробую заново или поменяю параметры.</i>${budgetNote}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); return; }
  if (result.kind === "cancelled") { await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `<i>↩️ Запрос отменён (пришло новое сообщение).</i>`, { parse_mode: "HTML" }); return; }
  await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `<i>Неизвестный результат агента: ${esc(result.kind)}</i>`, { parse_mode: "HTML" });
}

async function handleConversation(ctx, overrideText) {
  const text = (overrideText != null ? overrideText : ctx.message?.text) || "";
  const statusMsg = await ctx.reply("⏳ Думаю...");
  try {
    const result = await agent.runAgentTurn({ text, from: whoIs(ctx), fromUserId: ctx.from?.id });
    await renderAgentResult(ctx, statusMsg, result);
  } catch (err) {
    console.error("[bot] handleConversation error:", err.message);
    try { await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Внутренняя ошибка: ${esc(err.message)}\n\n@Rvn2332`, { parse_mode: "HTML" }); } catch (_) {}
  }
}

async function handleApprovalCallback(ctx) {
  const data = ctx.callbackQuery?.data || "";
  const parsed = approvalFlow.parseCallbackData(data);
  if (!parsed) return ctx.answerCallbackQuery();
  const { approvalId, decision } = parsed;
  const approved = decision === "yes";
  await ctx.answerCallbackQuery({ text: approved ? "✅ Выполняю..." : "❌ Отменено" });
  const resolved = approvalFlow.resolveApproval(approvalId, approved);
  if (!resolved.ok) {
    let msg;
    if (resolved.reason === "already_resolved") msg = `<i>Уже обработано ранее (${resolved.priorApproved ? "выполнено" : "отклонено"}).</i>`;
    else if (resolved.reason === "expired") msg = `<i>⏱ Подтверждение устарело (&gt;30 мин). Запрос отменён — повтори если нужно.</i>`;
    else if (resolved.reason === "stale") msg = `<i>↩️ Подтверждение неактуально (был новый запрос). Отменено.</i>`;
    else msg = `<i>Подтверждение не найдено. Возможно бот перезапускался — повтори запрос.</i>`;
    try { await ctx.editMessageText(msg, { parse_mode: "HTML" }); } catch (_) { await ctx.reply(msg, { parse_mode: "HTML" }); }
    return;
  }
  try { await ctx.editMessageText(`${approved ? "✅ Подтверждено" : "❌ Отклонено"} — ${approved ? "выполняю" : "не выполняю"}...`, { parse_mode: "HTML" }); } catch (_) {}
  const statusMsg = await ctx.reply("⏳ Продолжаю...");
  try {
    const result = await agent.continueAfterApproval({ pending: resolved.pending, approved: resolved.approved });
    await renderAgentResult(ctx, statusMsg, result);
  } catch (err) {
    console.error("[bot] handleApprovalCallback error:", err.message);
    try { await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Ошибка после подтверждения: ${esc(err.message)}\n\n@Rvn2332`, { parse_mode: "HTML" }); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", ctx => guard(ctx, () => {
  const convLine = CONVERSATIONAL_MODE ? `\n💬 <b>Чат-режим включён</b> — пиши обычным текстом, отвечу как Claude с доступом к Notion/Beeper/Apollo/Calendar.\n` : "";
  return ctx.reply(
    `🤖 Loop OS — Founder Command Center\n\nВерсия: ${VERSION}\n${convLine}\nКоманды:\n` +
    `/ping — health check\n/today — дайджест на сегодня\n/details — полные данные\n/full — всё\n` +
    `/yesterday — что было вчера\n/digest — отправить Anton'у\n/tasks — задачи\n/stale — заглохшие сделки\n` +
    `/replies — ждут ответа\n/discovery — Discovery Cards digest\n/test_push — тест крона в группу прямо сейчас\n` +
    (CONVERSATIONAL_MODE ? `/new — сбросить контекст\n/budget — расход\n` : "") +
    `\nАвто:\n• Утренний дайджест 08:30 CET → личка + группа\n• Discovery Cards digest 09:00 CET → личка + группа\n• CRM auto-prewarm 23:00 и 08:00 CET`,
    { parse_mode: "HTML" }
  );
}));

bot.command("ping", ctx => guard(ctx, () => {
  const now = new Date();
  const uptimeSec = Math.floor((now - STARTED_AT) / 1000);
  const uptimeStr = uptimeSec < 60 ? `${uptimeSec}s` : uptimeSec < 3600 ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s` : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
  return ctx.reply(`🏓 pong\n\nВерсия: ${VERSION}\nUptime: ${uptimeStr}\nServer: ${now.toISOString()}\nChat mode: ${CONVERSATIONAL_MODE ? "ON" : "OFF"}\nBot: @${BOT_USERNAME || "?"}\nGroup chat ID: ${GROUP_CHAT_ID || "не задан"}\nYour TG ID: ${ctx.from?.id}`);
}));

bot.command("today", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Тяну дайджест (Haiku merge ~30s)...");
  try { const data = await fetchLeanDigestData(); const text = composeLeanDigest(data); await editAndSplit(ctx, loadingMsg, text); }
  catch (err) { try { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`); } catch (_) {} }
}));

bot.command("details", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Полные данные (без Haiku)...");
  try { const data = await fetchDetailsData(); const text = composeDetailsDigest(data); await editAndSplit(ctx, loadingMsg, text); }
  catch (err) { try { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`); } catch (_) {} }
}));

bot.command("full", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Полный дайджест (~60s)...");
  try { const data = await fetchAllData(); const text = composeFullDigest(data); await editAndSplit(ctx, loadingMsg, text); }
  catch (err) { try { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`); } catch (_) {} }
}));

bot.command("yesterday", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Собираю summary мессенджеров за вчера (~30-60s)...");
  try {
    const summary = await fetchYesterdaySummary();
    if (!summary) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Не удалось получить summary за вчера.`);
    const block = buildYesterdaySectionFull(summary);
    if (!block) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `📆 <b>Что было вчера</b>\n\n<i>Активности не было.</i>`, { parse_mode: "HTML" });
    await editAndSplit(ctx, loadingMsg, block);
  } catch (err) { try { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.message)}`); } catch (_) {} }
}));

bot.command("digest", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply(ANTON_TG_ID ? "⏳ Собираю lean дайджест для Anton'а..." : "⏳ Собираю lean дайджест (тестовый)...");
  try {
    const data = await fetchLeanDigestData();
    if (ANTON_TG_ID) {
      const text = composeLeanDigest(data, { customHeader: `${buildLeanHeader()}\n<i>(отправлен Pavel вручную)</i>` });
      await sendSplit(ANTON_TG_ID, text);
      await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ Дайджест отправлен Anton'у (TG ID ${ANTON_TG_ID}).`, { parse_mode: "HTML" });
    } else {
      await editAndSplit(ctx, loadingMsg, composeLeanDigest(data, { customHeader: `🧪 <b>Тестовый дайджест</b> · ANTON_TG_ID не задан, шлю тебе\n\n${buildLeanHeader()}` }));
    }
  } catch (err) { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.response?.data?.error || err.message)}`); }
}));

bot.command("tasks", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую Tasks Tracker...");
  try {
    const tasksData = await fetchTasksToday({ limit: 30 });
    if (!tasksData) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Не удалось получить задачи из Notion.`);
    if (!tasksData.items.length) {
      const completed = await fetchTasksCompleted({ days: 3, limit: 20 });
      if (Array.isArray(completed) && completed.length > 0) {
        const top = completed.slice(0, 10);
        const ov = completed.length > top.length ? `\n\n<i>...и ещё ${completed.length - top.length}</i>` : "";
        return editAndSplit(ctx, loadingMsg, `✅ <b>Все задачи под контролем</b>  · <i>${completed.length} закрыто за 3 дня</i>\n\n` + top.map(renderCompletedTask).join("\n") + ov);
      }
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ <b>Все задачи под контролем</b>\n\nНи открытых задач, ни закрытых за 3 дня.`, { parse_mode: "HTML" });
    }
    return editAndSplit(ctx, loadingMsg, buildTasksSectionFull(tasksData, null));
  } catch (err) { return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.message)}`); }
}));

bot.command("stale", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую CRM...");
  try {
    const stale = await fetchStaleDeals({ days: 14, limit: 10 });
    if (!stale) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Не удалось получить данные из CRM.`);
    if (!stale.length) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ <b>Pipeline здоров</b>\n\nНет сделок без активности &gt;14d среди MH/P1/P2.`, { parse_mode: "HTML" });
    return editAndSplit(ctx, loadingMsg, buildStaleSectionLean(stale));
  } catch (err) { return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.message)}`); }
}));

bot.command("replies", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую мессенджеры...");
  try {
    const result = await fetchRepliesWaitingResilient({ hoursIdle: 4, limit: 15, days: 7 });
    if (!result) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Beeper и Messaging Hub оба недоступны.`);
    if (!result.replies.length) return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ <b>Inbox чист</b>\n\nНет чатов где Anton ещё не ответил &gt;4h.`, { parse_mode: "HTML" });
    return editAndSplit(ctx, loadingMsg, buildRepliesSectionFull(result));
  } catch (err) { return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.message)}`); }
}));

// ── /discovery ────────────────────────────────────────────────────────────────
bot.command("discovery", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Сканирую Discovery Cards (~60-90s)...");
  try {
    const data = await withTimeout(fetchDiscoveryDigest(), 110_000, "discovery-digest");
    if (!data || data.__timeout) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Discovery digest не ответил (timeout). Попробуй позже.`);
    }
    if (!data.ok) {
      return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(data.error || "unknown")}`);
    }
    await editAndSplit(ctx, loadingMsg, data.telegram);
  } catch (err) {
    try { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.message)}`); } catch (_) {}
  }
}));

bot.command("test_push", ctx => guard(ctx, async () => {
  const loadingMsg = await ctx.reply("⏳ Тестирую push в группу...", { parse_mode: "HTML" });
  try {
    const data = await fetchLeanDigestData();
    const text = composeLeanDigest(data, { customHeader: `🧪 <b>Test Push</b> · проверка крона\n\n${buildLeanHeader()}` });
    const targets = [...MORNING_PUSH_USERS];
    if (GROUP_CHAT_ID && !targets.includes(GROUP_CHAT_ID)) targets.push(GROUP_CHAT_ID);
    const results = [];
    for (const chatId of targets) {
      try { await sendSplit(chatId, text); results.push(`✅ ${chatId}`); }
      catch (err) { results.push(`❌ ${chatId}: ${err.message}`); }
    }
    await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `🧪 <b>Test Push готово</b>\n\n${results.join("\n")}`, { parse_mode: "HTML" });
  } catch (err) { try { await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `❌ Ошибка: ${esc(err.message)}`); } catch (_) {} }
}));

bot.command("new", ctx => guard(ctx, () => {
  if (!CONVERSATIONAL_MODE) return ctx.reply("Чат-режим выключен. /new недоступна.");
  try {
    const res = conversationStore.resetConversation({ keepSummary: true, reason: "/new command" });
    approvalFlow.invalidateAll("/new command");
    return ctx.reply(`🆕 Контекст сброшен (было ${res.oldTurns} реплик).` + (res.keptSummary ? `\n<i>Краткое summary прошлого разговора сохранено.</i>` : ""), { parse_mode: "HTML" });
  } catch (err) { return ctx.reply(`❌ Не получилось сбросить: ${esc(err.message)}`); }
}));

bot.command("budget", ctx => guard(ctx, () => {
  if (!CONVERSATIONAL_MODE) return ctx.reply("Чат-режим выключен. /budget недоступна.");
  try {
    const view = conversationStore.getView();
    const c = view.costsToday;
    return ctx.reply(`💸 <b>Расход за сегодня</b>\n\nПотрачено: $${(c.usd || 0).toFixed(4)}\nСообщений: ${c.msgs || 0}\nДневной бюджет: $${view.budgetDailyUsd} (soft — не блокирую)\nРеплик в контексте: ${view.totalTurns}`, { parse_mode: "HTML" });
  } catch (err) { return ctx.reply(`❌ Ошибка: ${esc(err.message)}`); }
}));

bot.on("message:text", ctx => guard(ctx, () => {
  const text = ctx.message?.text || "";
  const isSlash = text.trim().startsWith("/");
  if (isGroupChat(ctx)) {
    if (isSlash) return;
    if (!isAddressedToBotInGroup(ctx, BOT_USERNAME, BOT_ID)) return;
    if (!CONVERSATIONAL_MODE) return ctx.reply("Чат-режим выключен — отвечаю только на команды (/today, /ping, ...).");
    const { text: cleaned } = stripBotMention(text, BOT_USERNAME);
    if (!cleaned) return ctx.reply("Да? Напиши что нужно.");
    return handleConversation(ctx, cleaned);
  }
  if (CONVERSATIONAL_MODE && !isSlash) return handleConversation(ctx);
  return ctx.reply(`Команды:\n/start  /ping  /today  /details  /full  /yesterday  /digest  /tasks  /stale  /replies  /discovery  /test_push` + (CONVERSATIONAL_MODE ? `  /new  /budget` : ""));
}));

bot.on("callback_query:data", async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCallbackQuery({ text: "⛔ Access denied" });
  const data = ctx.callbackQuery?.data || "";
  if (!CONVERSATIONAL_MODE) return ctx.answerCallbackQuery();
  try { await handleApprovalCallback(ctx); }
  catch (err) { console.error("[bot] callback_query handler error:", err.message); try { await ctx.answerCallbackQuery({ text: "Ошибка обработки" }); } catch (_) {} }
});

bot.catch(err => { console.error("[bot] Error:", err.message); });

// ─────────────────────────────────────────────────────────────────────────────
// Cron jobs
// ─────────────────────────────────────────────────────────────────────────────

async function sendMorningPush() {
  console.log("[cron] morning push start");
  try { const data = await fetchLeanDigestData(); await sendToAllTargets(composeLeanDigest(data), "morning-push"); }
  catch (err) { console.error("[cron] morning push failed:", err.message); }
}

async function sendDiscoveryPush() {
  console.log("[cron] discovery push start");
  try {
    const data = await withTimeout(fetchDiscoveryDigest(), 110_000, "discovery-cron");
    if (!data || data.__timeout || !data.ok) {
      console.error("[cron] discovery push: no data or error", data?.error);
      return;
    }
    await sendToAllTargets(data.telegram, "discovery-push");
    console.log("[cron] discovery push sent");
  } catch (err) { console.error("[cron] discovery push failed:", err.message); }
}

// 08:30 CET — morning digest
cron.schedule("30 8 * * *", sendMorningPush, { timezone: "Europe/Prague" });
console.log("[cron] morning push registered (08:30 Europe/Prague → личка + группа)");

// 09:00 CET — discovery cards digest
cron.schedule("0 9 * * 1-5", sendDiscoveryPush, { timezone: "Europe/Prague" });
console.log("[cron] discovery push registered (09:00 Mon-Fri Europe/Prague → личка + группа)");

// NOTE: LinkedIn comments cron DISABLED — pending Playwright linkedin-poster setup

console.log(`[bot] Loop OS FCC ${VERSION} starting...`);
console.log(`[bot] Proxy URL: ${PROXY}`);
console.log(`[bot] Anton TG ID: ${ANTON_TG_ID || "(not set)"}`);
console.log(`[bot] Morning push recipients: ${MORNING_PUSH_USERS.join(",") || "(none)"}`);
console.log(`[bot] Group chat ID: ${GROUP_CHAT_ID || "(not set)"}`);
console.log(`[bot] Conversational mode: ${CONVERSATIONAL_MODE ? "ENABLED" : "disabled"}`);

(async () => {
  try {
    await bot.init();
    if (bot.botInfo) { BOT_USERNAME = bot.botInfo.username || null; BOT_ID = bot.botInfo.id || null; }
    console.log(`[bot] Bot identity: @${BOT_USERNAME || "?"} (id ${BOT_ID || "?"})`);
  } catch (err) { console.error("[bot] bot.init() failed:", err.message); }
  console.log(`[bot] Loop OS FCC ${VERSION} started at ${STARTED_AT.toISOString()}`);
  bot.start().catch(err => { console.error("[bot] Start error (non-fatal):", err.message); });
})();
