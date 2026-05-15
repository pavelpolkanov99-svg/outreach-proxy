const express = require("express");
const axios   = require("axios");
const router  = express.Router();

const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// PROXY base URL — for self-calls. In Railway, services in same project
// can talk via 0.0.0.0:PORT. We use the public URL since this proxy IS
// the same service (loopback through public DNS works fine).
const PROXY = process.env.SELF_URL || "http://localhost:" + (process.env.PORT || 3000);

// ─────────────────────────────────────────────────────────────────────────────
// Source fetchers — parallel, with timeouts, all fault-tolerant.
// Each returns null on error; bot tolerates missing pieces.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchTasks() {
  try {
    const r = await axios.get(`${PROXY}/notion/tasks-today`, {
      params: { limit: 20 }, timeout: 12_000,
    });
    const tasks = Array.isArray(r.data?.tasks) ? r.data.tasks : [];
    return tasks.filter(t => t.daysOverdue >= 0);
  } catch (err) {
    console.warn("[today-lean] tasks failed:", err.message);
    return null;
  }
}

async function fetchHotStale() {
  try {
    const r = await axios.get(`${PROXY}/notion/stale-deals-enriched`, {
      params: { days: 14, limit: 10 }, timeout: 15_000,
    });
    const deals = r.data?.deals || [];
    return deals;
  } catch (err) {
    console.warn("[today-lean] stale failed:", err.message);
    return null;
  }
}

async function fetchReplies() {
  try {
    const r = await axios.get(`${PROXY}/beeper/replies-waiting`, {
      params: { hoursIdle: 4, limit: 15, days: 7 }, timeout: 12_000,
    });
    return { source: "beeper", replies: r.data?.replies || [] };
  } catch (err) {
    console.warn("[today-lean] beeper replies failed, trying hub:", err.message);
  }
  try {
    const r = await axios.get(`${PROXY}/messaging-hub/replies-waiting`, {
      params: { hoursIdle: 4, limit: 15, days: 7 }, timeout: 10_000,
    });
    return { source: "messaging-hub", replies: r.data?.replies || [] };
  } catch (err) {
    console.warn("[today-lean] hub replies failed:", err.message);
    return null;
  }
}

async function fetchYesterdayActivity() {
  try {
    const r = await axios.get(`${PROXY}/yesterday/activity`, {
      timeout: 15_000,
    });
    return r.data;
  } catch (err) {
    console.warn("[today-lean] yesterday activity failed:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the merged input for Haiku.
// Pre-summarize each source into compact text so the prompt stays tight.
// ─────────────────────────────────────────────────────────────────────────────

function summarizeRepliesForPrompt(repliesData) {
  if (!repliesData?.replies?.length) return "(no replies waiting)";
  return repliesData.replies.slice(0, 15).map(r => {
    const tier   = r.notion?.bdScore != null
      ? `BD ${r.notion.bdScore}`
      : (r.notion ? "in-CRM" : "not-in-CRM");
    const stage  = r.notion?.stage ? `, ${r.notion.stage}` : "";
    const idle   = r.hoursIdle ? `${Math.round(r.hoursIdle)}h` : "?h";
    const snippet = (r.lastMsgText || "").slice(0, 200).replace(/\n/g, " ");
    const company = r.notion?.name || "(no CRM match)";
    return `- "${r.name}" [${r.networkFull || "?"}] · ${company} · ${tier}${stage} · idle ${idle}\n  msg: "${snippet}"`;
  }).join("\n");
}

function summarizeStaleForPrompt(staleData) {
  if (!staleData?.length) return "(no stale deals)";
  // Pass ALL stale to Haiku (not just hot) — Haiku decides what has deadline-pressure
  // (i.e. action-able now) vs what's just stuck without urgent trigger.
  return staleData.slice(0, 10).map(d => {
    const days = d.daysStale != null ? `${d.daysStale}д` : "?д";
    const score = d.bdScore != null ? `BD ${d.bdScore}` : "no-score";
    const snippet = (d.lastActivitySnippet || "").slice(0, 200).replace(/\n/g, " ");
    return `- ${d.name} · ${d.stage} · ${score} · stuck ${days}\n  last: "${snippet}"`;
  }).join("\n");
}

function summarizeTasksForPrompt(tasksData) {
  if (!tasksData?.length) return "(no overdue tasks)";
  const overdue = tasksData.filter(t => t.daysOverdue > 0);
  if (!overdue.length) return "(no overdue tasks)";
  return overdue.slice(0, 8).map(t => {
    const days = t.daysOverdue != null ? `${t.daysOverdue}d overdue` : "?";
    const company = t.companyName ? ` (${t.companyName})` : "";
    const desc = (t.description || "").slice(0, 120).replace(/\n/g, " ");
    return `- ${t.name}${company} · ${days}${desc ? `\n  desc: "${desc}"` : ""}`;
  }).join("\n");
}

function summarizeYesterdayForPrompt(activityData) {
  if (!activityData?.groups?.length) return "(no yesterday activity)";
  const lines = [];
  for (const group of activityData.groups) {
    for (const chat of (group.chats || []).slice(0, 8)) {
      const msgs = chat.messagesYesterday || [];
      if (!msgs.length) continue;
      const direction = msgs.some(m => m.isSender)
        ? (msgs.every(m => m.isSender) ? "outbound" : "two-way")
        : "inbound";
      const text = (msgs[msgs.length - 1].text || "").slice(0, 250).replace(/\n/g, " ");
      const crmHint = chat.crmCompany ? ` [CRM: ${chat.crmCompany}${chat.crmStage ? "/" + chat.crmStage : ""}${chat.crmBdScore != null ? "/BD " + chat.crmBdScore : ""}]` : " [not in CRM]";
      lines.push(`- "${chat.name}" [${chat.networkFull || group.header}]${crmHint} · ${direction}\n  last: "${text}"`);
    }
  }
  return lines.length ? lines.slice(0, 30).join("\n") : "(no yesterday activity)";
}

// ─────────────────────────────────────────────────────────────────────────────
// The single Haiku call — produces the new structured payload.
// ─────────────────────────────────────────────────────────────────────────────

async function callHaikuMerge(payload) {
  if (!ANTHROPIC_KEY) {
    console.warn("[today-lean] no ANTHROPIC_KEY — returning empty");
    return null;
  }

  const systemPrompt = `Ты ассистент Anton'а — CEO Plexo (B2B stablecoin clearing для финтехов).
Anton — занятой фаундер. За 20 секунд он должен понять что делать сегодня. Каждое слово на счету.

ВАЖНЫЕ ПРАВИЛА:
- BD Tier по score: MH ≥9.0, P1 ≥7.5, P2 = 5-7.4, P3 <5.
- Используй emoji tier: 🟢 для MH/P1, 🟡 для P2, ⚪ для P3, 🆕 для not-in-CRM
- Hard Kill (HK-1..HK-11) — Anton должен закрывать как Lost.
- На русском, без воды. Конкретные глаголы (написать, ответить, отправить, добить, закрыть, re-engage).
- НИКАКИХ вопросительных знаков в концах — Anton не должен думать "что делать"; он должен ВИДЕТЬ что делать.
- НЕТ ДУБЛЕЙ: если компания в mainMoves — её не должно быть в repliesWaiting или yesterdayPipeline.

ТЕБЕ НУЖНО ВЕРНУТЬ ЧЕТЫРЕ БЛОКА.

═══════════════════════════════════════════════════
БЛОК 1 — "mainMoves" — ровно 3-5 главных хода на сегодня
═══════════════════════════════════════════════════
Это самые важные действия дня. Anton реально сделает их сегодня. Качество > количество.

Критерии что попадает:
- MH/P1 контакты ждут ответа от Anton'а (replies waiting)
- Stuck сделки с DEADLINE (Negotiations >20д где был hard deadline или явная договорённость)
- Hot stale (Negotiations/Call Scheduled) высокого tier'а

НЕ попадают сюда (это в другие блоки):
- Stuck сделки БЕЗ deadline (без явной договорённости о сроке) → блок stuckNoDeadline
- Inbound от новых людей не в CRM → блок repliesWaiting
- P2/P3 inbound где нет срочности → блок repliesWaiting

Сортировка: по tier (MH сверху, P1, P2, P3) → потом по urgency (days).

Каждый main move — это объект:
{
  "rank": 1,
  "tierEmoji": "🟢",
  "tierLabel": "MH 8.9",
  "company": "BCB Group",
  "action": "написать Paul follow-up по 23.02 синку",  ← глагол + объект, до 70 символов
  "context": "stuck 30д · самая ценная сделка в pipeline, не теряем"  ← почему сейчас + что произойдёт, до 100 символов
}

Не пиши слово "Решить" или "Добить" в action — Anton не понимает что это значит. Пиши конкретно:
плохо: "Добить LeoPay"
хорошо: "финальное 'да/нет' перед закрытием Lost"

═══════════════════════════════════════════════════
БЛОК 2 — "repliesWaiting" — кто ещё ждёт ответа Anton'а
═══════════════════════════════════════════════════
Все inbound сообщения waiting reply, КРОМЕ тех что уже в mainMoves.
Если человек/компания не в CRM или P2/P3 — он почти наверняка сюда (не в mainMoves).
Если P1/MH inbound — он скорее в mainMoves, тут можно его пропустить.

Каждый — объект:
{
  "name": "Anastasia Skrypnyk",
  "network": "LinkedIn",  ← или "WhatsApp", "Telegram"
  "tierEmoji": "🆕",  ← или 🟡/⚪ если в CRM
  "tierLabel": "🆕 not in CRM",  ← или например "P2 6.2"
  "daysIdle": "2д",  ← или "6h" если меньше суток
  "context": "dispute rate calculator vs Visa/MC — релевантно нашему KYC/AML stack"  ← о чём пишут + ПОЧЕМУ нам это интересно, до 110 символов
}

Если новый контакт пишет про релевантную нам тему (финтех, stablecoin, payments, compliance, banking, regulation) — объясни **зачем нам отвечать** (потенциальный partner / source of intel / etc).

Макс 5 items. Сортировка по relevance (CRM > 🆕 релевантные > 🆕 нерелевантные).

═══════════════════════════════════════════════════
БЛОК 3 — "stuckNoDeadline" — короткий список stuck без deadline
═══════════════════════════════════════════════════
Сделки которые stuck >14д, НО без явного deadline/договорённости. Anton НЕ должен сегодня их трогать — это просто напоминание что они есть.

Каждый — объект:
{
  "name": "VelaFi",
  "daysStuck": 28,
  "stageShort": "Negotiations"  ← или "P2"
}

Макс 5 items. Если нет stuck без deadline — верни пустой массив.

═══════════════════════════════════════════════════
БЛОК 4 — "yesterdayPipeline" — что произошло вчера
═══════════════════════════════════════════════════
ТОЛЬКО две категории:
- "win": реальные wins — закрытые шаги (NDA подписана, integration done, deal moved to Negotiations, P1 lead согласился на call)
- "movement": positive activity которая не требует action от Anton'а сегодня (потому что либо уже в mainMoves либо неважно)

НЕ включай сюда:
- Risks → они должны быть в mainMoves если есть action, или в stuckNoDeadline если нет
- Новые контакты → они в repliesWaiting если ждут ответа

Каждый item — строка до 100 символов: "<Company/Person> (<Tier>) — <что произошло>"

Макс 5 win + 5 movement. Если категория пустая — пустой массив.

═══════════════════════════════════════════════════
ОТВЕТ — строго JSON, без markdown, без комментариев:

{
  "mainMoves": [
    {"rank": 1, "tierEmoji": "🟢", "tierLabel": "MH 8.9", "company": "BCB Group", "action": "...", "context": "..."},
    ...
  ],
  "repliesWaiting": [
    {"name": "...", "network": "LinkedIn", "tierEmoji": "🆕", "tierLabel": "🆕 not in CRM", "daysIdle": "2д", "context": "..."},
    ...
  ],
  "stuckNoDeadline": [
    {"name": "VelaFi", "daysStuck": 28, "stageShort": "Negotiations"},
    ...
  ],
  "yesterdayPipeline": {
    "win": ["..."],
    "movement": ["..."]
  }
}`;

  const userPrompt = `=== REPLIES WAITING (>4h, нужен ответ Anton'а) ===
${payload.repliesText}

=== STALE DEALS (все stuck >14д, ты решаешь у кого есть deadline-pressure для mainMoves) ===
${payload.staleText}

=== OVERDUE TASKS ===
${payload.tasksText}

=== YESTERDAY ACTIVITY (все мессенджеры, raw) ===
${payload.yesterdayText}

Сделай четыре блока: mainMoves (3-5), repliesWaiting (до 5), stuckNoDeadline (до 5), yesterdayPipeline (win + movement).
АНТИ-ДУБЛИКАЦИЯ: одна компания/контакт идёт ТОЛЬКО в один блок.`;

  try {
    const t0 = Date.now();
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 50_000,
      }
    );
    console.log(`[today-lean] Haiku call done in ${Date.now() - t0}ms`);

    const textBlock = (r.data?.content || []).find(b => b.type === "text");
    const raw = textBlock?.text || "";
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean);

    return {
      mainMoves:       Array.isArray(parsed.mainMoves)       ? parsed.mainMoves.slice(0, 5)       : [],
      repliesWaiting:  Array.isArray(parsed.repliesWaiting)  ? parsed.repliesWaiting.slice(0, 5)  : [],
      stuckNoDeadline: Array.isArray(parsed.stuckNoDeadline) ? parsed.stuckNoDeadline.slice(0, 5) : [],
      yesterdayPipeline: {
        win:      Array.isArray(parsed.yesterdayPipeline?.win)      ? parsed.yesterdayPipeline.win.slice(0, 5)      : [],
        movement: Array.isArray(parsed.yesterdayPipeline?.movement) ? parsed.yesterdayPipeline.movement.slice(0, 5) : [],
      },
    };
  } catch (err) {
    const status = err.response?.status;
    const responseBody = err.response?.data;
    const bodyStr = responseBody
      ? (typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody))
      : "(no body)";
    console.error(`[today-lean] Haiku failed: ${err.message} | status=${status} | body=${bodyStr.slice(0, 400)}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main endpoint: GET /today/lean
// ─────────────────────────────────────────────────────────────────────────────

router.get("/lean", async (req, res) => {
  const t0 = Date.now();
  console.log(`[today-lean] === START ===`);

  const [tasks, stale, replies, yesterday] = await Promise.all([
    fetchTasks(),
    fetchHotStale(),
    fetchReplies(),
    fetchYesterdayActivity(),
  ]);

  console.log(`[today-lean] sources fetched in ${Date.now() - t0}ms — tasks:${tasks?.length ?? "null"} stale:${stale?.length ?? "null"} replies:${replies?.replies?.length ?? "null"} yesterday-groups:${yesterday?.groups?.length ?? "null"}`);

  const payload = {
    repliesText:   summarizeRepliesForPrompt(replies),
    staleText:     summarizeStaleForPrompt(stale),
    tasksText:     summarizeTasksForPrompt(tasks),
    yesterdayText: summarizeYesterdayForPrompt(yesterday),
  };

  const haikuResult = await callHaikuMerge(payload);

  const elapsed = Date.now() - t0;
  console.log(`[today-lean] === END === ${elapsed}ms · mainMoves=${haikuResult?.mainMoves?.length || 0} · replies=${haikuResult?.repliesWaiting?.length || 0} · stuck=${haikuResult?.stuckNoDeadline?.length || 0} · win=${haikuResult?.yesterdayPipeline?.win?.length || 0} · movement=${haikuResult?.yesterdayPipeline?.movement?.length || 0}`);

  res.json({
    ok: true,
    elapsed,
    mainMoves:         haikuResult?.mainMoves || [],
    repliesWaiting:    haikuResult?.repliesWaiting || [],
    stuckNoDeadline:   haikuResult?.stuckNoDeadline || [],
    yesterdayPipeline: haikuResult?.yesterdayPipeline || { win: [], movement: [] },
    // Legacy fields for bw-compat (in case bot still reads them) — empty arrays
    todoToday: [],
    sources: {
      tasksCount:    tasks?.length || 0,
      staleCount:    stale?.length || 0,
      repliesCount:  replies?.replies?.length || 0,
      repliesSource: replies?.source || null,
      yesterdayChats: yesterday?.totalChats || 0,
    },
    aiAvailable: !!haikuResult,
  });
});

module.exports = router;
