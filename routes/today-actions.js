const express = require("express");
const axios   = require("axios");

const router = express.Router();

const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const SELF_BASE = process.env.PROXY_SELF_URL
  || "http://localhost:" + (process.env.PORT || 3000);

// Stage rank — higher = more urgent for action-items merge
const STAGE_RANK = {
  "Negotiations": 5,
  "Call Scheduled": 4,
  "Warm discussions": 3,
  "Keeping in the Loop": 2,
  "initial discussions": 1,
};

// ─────────────────────────────────────────────────────────────────────────────
// /today/action-items
//
// Anton's "Сделать сегодня" block — merges three sources into a ranked list of
// 3-7 action items written in plain Russian:
//
//   1. Ответить Mohammed (XTransfer · 🟢 Warm) — просит ссылку на Discovery Card
//   2. Решить с INXY (🔴 Negotiations · 25д) — добить или закрыть → Lost
//   3. ...
//
// Sources:
//   A) /beeper/replies-waiting (fallback /messaging-hub/replies-waiting)
//      → "Ответить X" actions
//   B) /notion/stale-deals-enriched (only Negotiations + Call Scheduled)
//      → "Решить с X" actions
//   C) /notion/tasks-today (overdue only)
//      → "X" tasks as-is
//
// Haiku merges, dedupes, ranks, writes one-line action.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты ассистент Anton'а — CEO Plexo (B2B stablecoin clearing network для финтехов).
Pavel — Head of Partnerships.

Твоя задача: из трёх списков (входящие чаты ждут ответа, заглохшие сделки в Negotiations, просроченные задачи) собрать ТОП-7 КОНКРЕТНЫХ ДЕЙСТВИЙ на сегодня.

ПРАВИЛА РАНЖИРОВАНИЯ (от важного к неважному):
1. MH сделки (BD score >= 9) — всегда сверху
2. P1 сделки (BD score 7.5-8.99)
3. Negotiations / Call Scheduled stale >20д — нужно решение "добить или закрыть"
4. Warm discussions с явным запросом от контакта
5. P2/P3 ответы
6. Просроченные задачи
7. Прочее

ПРАВИЛА ФОРМАТА КАЖДОГО ITEM:
- Пиши на русском, кратко (до 100 символов)
- Начинай с глагола: "Ответить X", "Решить с X", "Добить X", "Отправить X"
- Указывай company + stage в скобках с emoji tier:
  🟢 = MH/P1, 🟡 = Warm/P2, 🔴 = Negotiations stuck, ⚪ = early stage
- ОБЪЯСНИ что именно нужно сделать (не просто "ответить", а "ответить — просит X")
- Если контакт не в CRM — пиши "(новый контакт, не в CRM)"

ПРИМЕРЫ ХОРОШИХ ITEMS:
- "Ответить Mohammed (XTransfer · 🟢 MH Warm) — просит ссылку на Discovery Card"
- "Решить с Ankit (OpenFX · 🟡 Warm) — отказались от интеграции, закрывать → Lost?"
- "Добить INXY (🔴 Negotiations · 25д тишины) — Discovery Card hard deadline проигнорирован"
- "Отправить Discovery Card Rajit (FV Bank) — задача просрочена 8 дней"

ПРИМЕРЫ ПЛОХИХ ITEMS (НЕ ДЕЛАЙ ТАК):
- "Ответить Mohammed" (нет company, нет reason)
- "Активный диалог с XTransfer" (это не действие)
- "Patrick написал" (что Anton должен сделать?)

ДЕДУП: если один и тот же контакт встречается в replies И в stale (например "Ankit OpenFX" пишет в чате И его сделка в Negotiations >20д) — сделай ОДИН combined item.

Если меньше 7 реальных action items — верни сколько есть (минимум 0). Не выдумывай.

Отвечай строго JSON массивом:
{
  "items": [
    "1. Ответить Mohammed (XTransfer · 🟢 MH Warm) — просит ссылку на Discovery Card",
    "2. ...",
    ...
  ]
}

Не добавляй объяснений вокруг JSON. Не нумеруй items сам — нумерация уже в строке.`;

async function fetchRepliesWaiting() {
  // Try Beeper first, fall back to Hub. Same logic as bot.js does.
  try {
    const r = await axios.get(`${SELF_BASE}/beeper/replies-waiting`, {
      params: { hoursIdle: 4, limit: 15, days: 7 },
      timeout: 15_000,
    });
    return { source: "beeper", replies: r.data?.replies || [] };
  } catch (err) {
    console.warn(`[today/actions] beeper fetch failed: ${err.message} — trying hub`);
  }
  try {
    const r = await axios.get(`${SELF_BASE}/messaging-hub/replies-waiting`, {
      params: { hoursIdle: 4, limit: 15, days: 7 },
      timeout: 12_000,
    });
    return { source: "messaging-hub", replies: r.data?.replies || [] };
  } catch (err) {
    console.warn(`[today/actions] hub fetch failed: ${err.message}`);
    return { source: null, replies: [] };
  }
}

async function fetchHotStaleDeals() {
  // Only Negotiations / Call Scheduled — those need decisions
  try {
    const r = await axios.get(`${SELF_BASE}/notion/stale-deals-enriched`, {
      params: { days: 14, limit: 20 },
      timeout: 18_000,
    });
    const all = r.data?.deals || [];
    return all.filter(d => d.stage === "Negotiations" || d.stage === "Call Scheduled");
  } catch (err) {
    console.warn(`[today/actions] stale fetch failed: ${err.message}`);
    return [];
  }
}

async function fetchOverdueTasks() {
  try {
    const r = await axios.get(`${SELF_BASE}/notion/tasks-today`, {
      params: { limit: 30 },
      timeout: 15_000,
    });
    const tasks = r.data?.tasks || [];
    // Only overdue tasks (daysOverdue > 0) for action items.
    // On-track and future tasks stay in /details.
    return tasks.filter(t => t.daysOverdue > 0);
  } catch (err) {
    console.warn(`[today/actions] tasks fetch failed: ${err.message}`);
    return [];
  }
}

// Build a compact textual summary of all 3 sources for Haiku to ingest.
function buildPromptInput(replies, staleDeals, tasks) {
  const lines = [];

  // Section A: Replies waiting
  lines.push("=== ВХОДЯЩИЕ ЧАТЫ ЖДУТ ОТВЕТА ===");
  if (replies.length === 0) {
    lines.push("(пусто)");
  } else {
    for (const r of replies) {
      const networkLabel = r.networkFull || r.network || "?";
      const idle = r.hoursIdle != null ? `${Math.round(r.hoursIdle)}h` : "?";
      const company = r.notion?.name ? r.notion.name : "(не в CRM)";
      const stage   = r.notion?.stage || "—";
      const score   = r.notion?.bdScore != null ? ` · BD ${r.notion.bdScore}` : "";
      const sender  = r.lastMsgSender || "?";
      const snippet = (r.lastMsgText || "").slice(0, 200).replace(/\n+/g, " ");
      lines.push(`[${networkLabel}] "${r.name}" — sender: ${sender}, idle: ${idle}, company: ${company}, stage: ${stage}${score}`);
      lines.push(`  msg: ${snippet}`);
    }
  }
  lines.push("");

  // Section B: Hot stale deals (Negotiations / Call Scheduled)
  lines.push("=== ЗАСТРЯВШИЕ В NEGOTIATIONS / CALL SCHEDULED ===");
  if (staleDeals.length === 0) {
    lines.push("(пусто)");
  } else {
    for (const d of staleDeals) {
      const score = d.bdScore != null ? ` · BD ${d.bdScore}` : "";
      const days  = d.daysStale != null ? `${d.daysStale}д` : "?";
      const snippet = d.lastActivitySnippet
        ? ` last: "${d.lastActivitySnippet.slice(0, 140)}"`
        : "";
      lines.push(`${d.name} — stage: ${d.stage}${score}, stale: ${days}${snippet}`);
    }
  }
  lines.push("");

  // Section C: Overdue tasks
  lines.push("=== ПРОСРОЧЕННЫЕ ЗАДАЧИ ===");
  if (tasks.length === 0) {
    lines.push("(пусто)");
  } else {
    for (const t of tasks) {
      const company = t.companyName ? ` (${t.companyName})` : "";
      const desc = t.description ? ` — ${t.description.slice(0, 120)}` : "";
      lines.push(`${t.name}${company} — overdue ${t.daysOverdue}д${desc}`);
    }
  }

  return lines.join("\n");
}

router.get("/action-items", async (req, res) => {
  const t0 = Date.now();

  if (!ANTHROPIC_KEY) {
    return res.json({
      ok: true,
      source: "no-haiku",
      items: [],
      reason: "ANTHROPIC_API_KEY not set",
    });
  }

  // Fetch all 3 sources in parallel — they don't depend on each other.
  const [repliesResult, staleDeals, tasks] = await Promise.all([
    fetchRepliesWaiting(),
    fetchHotStaleDeals(),
    fetchOverdueTasks(),
  ]);

  const replies = repliesResult.replies || [];
  console.log(`[today/actions] sources: replies=${replies.length} (${repliesResult.source}), stale=${staleDeals.length}, tasks=${tasks.length}`);

  // If everything empty — short-circuit, no need to call Haiku.
  if (replies.length === 0 && staleDeals.length === 0 && tasks.length === 0) {
    return res.json({
      ok: true,
      source: "empty",
      items: [],
      meta: { replies: 0, stale: 0, tasks: 0 },
    });
  }

  const promptInput = buildPromptInput(replies, staleDeals, tasks);

  try {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Сегодня нужно сделать ТОП-7 действий. Вот данные:\n\n${promptInput}\n\nДай action items в JSON.`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30_000,
      }
    );

    const textBlock = (r.data?.content || []).find(b => b.type === "text");
    const raw = textBlock?.text || "";
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean);
    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 7) : [];

    console.log(`[today/actions] Haiku returned ${items.length} items in ${Date.now() - t0}ms`);

    return res.json({
      ok: true,
      source: "haiku",
      items,
      meta: {
        replies: replies.length,
        stale: staleDeals.length,
        tasks: tasks.length,
        repliesSource: repliesResult.source,
      },
    });
  } catch (err) {
    const status = err.response?.status;
    const responseBody = err.response?.data;
    const bodyStr = responseBody
      ? (typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody))
      : "(no body)";
    console.error(`[today/actions] Haiku failed: ${err.message} | status=${status} | body=${bodyStr.slice(0, 400)}`);

    return res.json({
      ok: false,
      source: "error",
      items: [],
      error: err.message,
      errorStatus: status,
      errorBody: typeof responseBody === "object" ? responseBody : null,
    });
  }
});

module.exports = router;
