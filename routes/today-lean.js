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
    // Hot = Negotiations / Call Scheduled — Anton MUST decide on these
    return deals;
  } catch (err) {
    console.warn("[today-lean] stale failed:", err.message);
    return null;
  }
}

async function fetchReplies() {
  // Try Beeper first; fallback to messaging-hub
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
  // Use /yesterday/activity (raw chats, no AI) — we'll do our own AI-classify
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
// We pre-summarize each source into compact text so the prompt stays tight
// (saves tokens, keeps cost <$0.02 per call).
// ─────────────────────────────────────────────────────────────────────────────

function summarizeRepliesForPrompt(repliesData) {
  if (!repliesData?.replies?.length) return "(no replies waiting)";
  return repliesData.replies.slice(0, 12).map(r => {
    const tier   = r.notion?.bdScore != null
      ? `BD ${r.notion.bdScore}`
      : (r.notion ? "in-CRM" : "not-in-CRM");
    const stage  = r.notion?.stage ? `, ${r.notion.stage}` : "";
    const idle   = r.hoursIdle ? `${Math.round(r.hoursIdle)}h` : "?h";
    const snippet = (r.lastMsgText || "").slice(0, 150).replace(/\n/g, " ");
    const company = r.notion?.name || "(no CRM match)";
    return `- "${r.name}" [${r.networkFull || "?"}] · ${company} · ${tier}${stage} · idle ${idle}\n  msg: "${snippet}"`;
  }).join("\n");
}

function summarizeStaleForPrompt(staleData) {
  if (!staleData?.length) return "(no stale deals)";
  // Only HOT stales matter for "Сделать сегодня" — Negotiations/Call Scheduled
  const hot = staleData.filter(d =>
    d.stage === "Negotiations" || d.stage === "Call Scheduled"
  );
  if (!hot.length) return "(no hot stale deals)";
  return hot.slice(0, 6).map(d => {
    const days = d.daysStale != null ? `${d.daysStale}д` : "?д";
    const score = d.bdScore != null ? `BD ${d.bdScore}` : "no-score";
    const snippet = (d.lastActivitySnippet || "").slice(0, 150).replace(/\n/g, " ");
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
    const desc = (t.description || "").slice(0, 100).replace(/\n/g, " ");
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
      const text = (msgs[msgs.length - 1].text || "").slice(0, 200).replace(/\n/g, " ");
      lines.push(`- "${chat.name}" [${chat.networkFull || group.header}] · ${direction}\n  last: "${text}"`);
    }
  }
  return lines.length ? lines.slice(0, 25).join("\n") : "(no yesterday activity)";
}

// ─────────────────────────────────────────────────────────────────────────────
// The single Haiku call — all the magic happens here.
// ─────────────────────────────────────────────────────────────────────────────

async function callHaikuMerge(payload) {
  if (!ANTHROPIC_KEY) {
    console.warn("[today-lean] no ANTHROPIC_KEY — returning empty");
    return null;
  }

  const systemPrompt = `Ты ассистент BD-команды Plexo (B2B stablecoin clearing network для финтехов).
Anton — CEO. Твоя задача — превратить сырые данные за сегодня и вчера в ДВА коротких блока.

ВАЖНЫЕ ПРАВИЛА:
- BD Tier по score: MH ≥9.0, P1 ≥7.5, P2 = 5-7.4, P3 <5. Всегда показывай tier (🟢 MH X.X / 🟢 P1 X.X / 🟡 P2 X.X / ⚪ P3 X.X).
- Если в CRM нет — пиши "🆕 not in CRM".
- Hard Kill компании (HK-1..HK-11) — Anton ДОЛЖЕН их закрывать как Lost.
- На русском, лаконично, без воды. Каждый action item — ОДНА строка до 110 символов.

БЛОК 1: "todoToday" — топ-7 actionable items, отсортированные по приоритету:
  Priority: 1) MH/P1 чаты ждут ответа > 2) hot stale (Negotiations/Call Scheduled >20д) > 3) P2 warm стоит > 4) tasks
  Формат каждого item:
    "Ответить <Person> (<Company> · <Tier emoji+code>) — <что просят/что они сказали>"
    "Решить с <X> (<Company> · <Stage>) — <что произошло, suggest action: добить/закрыть/Lost?>"
    "<Company> · <Stage> · <N>д тишины — добить или закрыть → Lost"
  Если items < 7 — это нормально, не выдумывай. Если 0 — верни пустой массив.

БЛОК 2: "yesterdayPipeline" — три категории за вчерашний день:
  - "movement": positive progress — новые ответы от качественных лидов, продвижение по stage, теплые outbound. Формат: "<Company> (<Tier>) — <что произошло>"
  - "risks": negative signals — отказ от интеграции, "still working on details" уже несколько недель, тишина после deadline. Формат: "<Company> (<Stage>) — <риск>"  
  - "newContacts": первые контакты ещё не в CRM, но звучат релевантно (финтех, банк, payments). Формат: "<Person/Company> (<Network>) — <о чём пишет>"
  Каждый bullet — до 100 символов.
  Если в категории нет ничего — верни пустой массив для неё.
  Не дублируй одну компанию в разные категории.

ОТВЕТ — строго JSON:
{
  "todoToday": ["item1", "item2", ...],
  "yesterdayPipeline": {
    "movement": ["item1", ...],
    "risks": ["item1", ...],
    "newContacts": ["item1", ...]
  }
}`;

  const userPrompt = `=== REPLIES WAITING (>4h, нужен ответ Anton'а) ===
${payload.repliesText}

=== HOT STALE DEALS (Negotiations/Call Scheduled stuck) ===
${payload.staleText}

=== OVERDUE TASKS ===
${payload.tasksText}

=== YESTERDAY ACTIVITY (все мессенджеры, raw) ===
${payload.yesterdayText}

Сделай два блока: todoToday (топ-7) + yesterdayPipeline (Movement/Risks/Новые).`;

  try {
    const t0 = Date.now();
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 40_000,
      }
    );
    console.log(`[today-lean] Haiku call done in ${Date.now() - t0}ms`);

    const textBlock = (r.data?.content || []).find(b => b.type === "text");
    const raw = textBlock?.text || "";
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean);

    return {
      todoToday: Array.isArray(parsed.todoToday) ? parsed.todoToday.slice(0, 7) : [],
      yesterdayPipeline: {
        movement:    Array.isArray(parsed.yesterdayPipeline?.movement)    ? parsed.yesterdayPipeline.movement.slice(0, 6)    : [],
        risks:       Array.isArray(parsed.yesterdayPipeline?.risks)       ? parsed.yesterdayPipeline.risks.slice(0, 6)       : [],
        newContacts: Array.isArray(parsed.yesterdayPipeline?.newContacts) ? parsed.yesterdayPipeline.newContacts.slice(0, 6) : [],
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
// Pulls all sources in parallel, calls Haiku once, returns structured payload.
// Bot does the rendering.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/lean", async (req, res) => {
  const t0 = Date.now();
  console.log(`[today-lean] === START ===`);

  // Parallel fetch
  const [tasks, stale, replies, yesterday] = await Promise.all([
    fetchTasks(),
    fetchHotStale(),
    fetchReplies(),
    fetchYesterdayActivity(),
  ]);

  console.log(`[today-lean] sources fetched in ${Date.now() - t0}ms — tasks:${tasks?.length ?? "null"} stale:${stale?.length ?? "null"} replies:${replies?.replies?.length ?? "null"} yesterday-groups:${yesterday?.groups?.length ?? "null"}`);

  // Build merged prompt payload
  const payload = {
    repliesText:   summarizeRepliesForPrompt(replies),
    staleText:     summarizeStaleForPrompt(stale),
    tasksText:     summarizeTasksForPrompt(tasks),
    yesterdayText: summarizeYesterdayForPrompt(yesterday),
  };

  // Single Haiku call
  const haikuResult = await callHaikuMerge(payload);

  const elapsed = Date.now() - t0;
  console.log(`[today-lean] === END === ${elapsed}ms · todo=${haikuResult?.todoToday?.length || 0} · movement=${haikuResult?.yesterdayPipeline?.movement?.length || 0} · risks=${haikuResult?.yesterdayPipeline?.risks?.length || 0} · new=${haikuResult?.yesterdayPipeline?.newContacts?.length || 0}`);

  res.json({
    ok: true,
    elapsed,
    todoToday:         haikuResult?.todoToday || [],
    yesterdayPipeline: haikuResult?.yesterdayPipeline || { movement: [], risks: [], newContacts: [] },
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
