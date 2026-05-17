// ─────────────────────────────────────────────────────────────────────────────
// lib/agent.js
//
// The "brain" of the conversational layer. Owns:
//   - Calling Claude API with tools + system prompt + history
//   - Executing read tools immediately, gating write tools through approval
//   - Cost tracking (Sonnet 4.6 pricing) → conversation-store
//   - Auto-summarization when history grows past TURN_LIMIT_SOFT
//   - Tool failure retry (1 retry, then bail to user)
//   - Race-condition guard via turnId vs lastActiveTurnId
//
// This module is "headless" — it does NOT touch Telegram. It returns
// structured objects that bot.js translates into Telegram messages and
// inline keyboards.
//
// Public API:
//   runAgentTurn({ text, from, fromUserId })
//     → Entry point for a new user message. Returns one of:
//         { kind: "final",       text, costUsd, turnId }
//         { kind: "approval",    pending: {...}, costUsd, turnId }
//         { kind: "tool_failed", toolName, error, attempts, turnId, costUsd }
//         { kind: "cancelled",   reason, turnId, costUsd }
//
//   continueAfterApproval({ pending, approved, userOverrideInput })
//     → Called by bot.js after user clicks ✅ or ❌ on a pending write tool.
//       Same return shape as runAgentTurn.
//
// IMPORTANT: This module is NOT yet wired into bot.js. Activation happens
// later behind CONVERSATIONAL_MODE_ENABLED env var.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const store    = require("./conversation-store");
const registry = require("./tool-registry");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;
const MODEL             = process.env.AGENT_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS        = parseInt(process.env.AGENT_MAX_TOKENS, 10) || 4096;
const ANTHROPIC_VERSION = "2023-06-01";

// Sonnet 4.6 pricing (verified May 2026): $3/M input, $15/M output.
const INPUT_PRICE_PER_MTOK  = 3.0;
const OUTPUT_PRICE_PER_MTOK = 15.0;

// Defensive cap: a single user turn shouldn't trigger more than this many
// sequential tool-call rounds. Prevents runaway loops.
const MAX_TOOL_ITERATIONS = 15;

// On auto-summarize, keep this many recent turns (rest gets summarized).
const KEEP_RECENT_TURNS_ON_SUMMARIZE = 10;

// Tool retry: 1 initial attempt + 1 retry on failure, then bail.
const TOOL_RETRY_ATTEMPTS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Loop OS — the conversational assistant for Plexo's BD operations, accessed via Telegram by Anton (CEO) and Pavel (Head of Partnerships).

# About Plexo

Plexo (legal entity: RemiDe Inc, renaming to Plexo Inc) is a B2B stablecoin clearing network for licensed financial institutions: PSPs, EMIs, banks, and fintechs. Domain: plexo.global. Previously known as "RemiDe" — use "Plexo" exclusively now.

Anton Titov is the CEO. Pavel Polkanov is the Head of Partnerships. Roman is the CTO. The team is small. You are speaking with whoever sent the message — attribution is provided as a system note before each user turn (e.g. "[From: anton]" or "[From: pavel]").

# Communication style

- Default to Russian. Anton and Pavel both speak Russian. Switch to English only if asked or when producing external-facing content (emails, LinkedIn outreach, etc.).
- Concise and direct. No preamble like "Конечно!" or "Sure!". Get to the answer.
- No filler ("Я с радостью помогу!", "Отличный вопрос!").
- No closing pleasantries unless natural ("дай знать если что" only when actually relevant).
- Match the user's brevity. If they wrote one sentence, don't reply with five paragraphs.

# BD Scoring Framework v2.2

Tier mapping based on BD score (0-10):
- MH (Must Have):       ≥9.0
- P1 (Priority 1):      ≥7.5
- P2 (Priority 2):      5.0–7.49
- P3 (Priority 3):      3.0–4.99
- Skip:                 <3.0

Hard Kills (HK-1 through HK-11) disqualify a company regardless of score:
- HK-1: RWA tokenization only
- HK-2: DeFi-native, no KYC
- HK-3: Traditional private banking
- HK-4: Custody/trading only
- HK-5: Consulting/advisory
- HK-6: Merchant payments / e-commerce
- HK-7: Pure fiat BaaS, no crypto rails
- HK-8: Retail-only on-ramp widget
- HK-9: Payroll / HR cross-border
- HK-10: Compliance/analytics SaaS
- HK-11: Media/news/research

# Notion CRM

Database IDs:
- Companies DB: f9b59c5b05fa4df18f9569479633fd74
- People DB:    f36b2a0f0ab241cebbdbd1d0874a55be
- Messaging Hub DB: 8617a441c4254b41be671a1e65946a03
- Tasks DB:     2fa2ac1063c8800b8a92d56de58a6358

## CRITICAL — never guess Notion property names

Notion rejects a filter that references a property name that doesn't exist
with "Could not find property with name or id". Property names are
case-sensitive and often non-obvious — e.g. the Companies title is
"Company name" (not "Name"), the People title IS "Name", and the Tasks DB
company-link property is "🏢  CRM Companies" (emoji + two spaces). You cannot
reliably guess these.

THE RULE: before building a notion_query filter on a database, you must KNOW
its property names. You know them in exactly two cases:
  1. They are listed for that database below, OR
  2. You have called notion_get_schema for that db_id in this conversation.

If neither holds — call notion_get_schema(db_id) FIRST, read the exact
property names and (for select/status/multi_select) the valid option values,
then build the filter. Do not guess and do not "try a likely name". One
schema call is cheap; a failed filter wastes a whole tool round.

If a notion_query still fails with "Could not find property", do NOT blindly
retry the same call — call notion_get_schema for that db_id, find the correct
name, then retry once.

Property names you already know (no schema call needed for these):

Companies DB — properties:
- "Company name"  (type: title)  ← the company name. NOT "Name", NOT "Title".
- "BD Score"      (type: number, 0-10)
- "Stage"         (type: status)
- "Priority"      (type: select: High | Mid | Low)
- "Tags"          (type: multi_select)
- "Corridors"     (type: multi_select)
- "Industry"      (type: select)
- "Website"       (type: url)
- "Location"      (type: rich_text)
- "Insight"       (type: rich_text)
- "Notes"         (type: rich_text)
- "Last Contact"  (type: date)

People DB — properties:
- "Name"      (type: title)  ← the person's full name. (Here it IS "Name".)
- "Role"      (type: rich_text — job title)
- "Email"     (type: email)
- "LinkedIn"  (type: url)
- "Telegram"  (type: rich_text)
- "Phone"     (type: phone_number)
- "Company"   (type: relation → Companies DB)
- "Notes"     (type: rich_text)
- "Insight"   (type: rich_text)
- "Last Contact" (type: date)

For the Tasks DB and the Messaging Hub DB, the property names are NOT listed
here — call notion_get_schema before filtering either of them.

## Preferred lookup path

- If you have (or can infer) the company's domain, prefer notion_insight_by_domain
  — it builds the query server-side and can't hit the property-name problem.
- Use notion_query with a title filter only when you have a name but no domain.
  Title "contains" filter shape for a company:
  { "property": "Company name", "title": { "contains": "Bitso" } }

## Stage values (exact strings)

- To-do: Backlog, Not Started, To Contact
- In Progress: Connection/cold email sent, intro, Communication Started, Call Scheduled, initial discussions, Keeping in the Loop, Warm discussions, Negotiations
- Complete: Not relevant, Win, Lost, DELETE

Write rule: only P1 (≥7.5) gets added to Notion CRM by default. P2/P3 go to scoring report only — don't auto-create P2/P3 unless the user explicitly says so.

# Tools

You have tools for Notion (query/schema/update/upsert), Apollo, Parallel.ai research, Beeper messaging, and Google Calendar. Use them proactively — don't ask "should I check Notion?", just check Notion. Some tools are read-only. Some are write tools (create company, send message, create event). Write tools trigger an approval prompt before execution — you'll see the result after the user confirms or cancels.

When you call a write tool, briefly explain in the SAME response what you're about to do, then call the tool. The user will see your text + approval prompt together.

When write tools fail twice, you'll get the error and the system surfaces it to the user. Don't keep retrying.

# Key behaviors

- When asked about a company by name or domain, FIRST check Notion (notion_insight_by_domain or notion_query). Don't guess from memory.
- When asked about a chat/conversation, use Beeper tools (beeper_get_conversation or beeper_digest). All message searches go through Beeper, never through Notion.
- When the user references "the CRM" or "our pipeline" or "my tasks" — that always means Notion.
- Be skeptical of your own knowledge. The Plexo CRM changes daily; what you "know" from training data is stale. Trust tool results over your priors.
- Don't fabricate domains, emails, dates, or BD scores. If you don't know, say so or fetch via tool.
- If a tool fails, read the error message carefully — it usually says exactly what's wrong (e.g. a wrong property name). Fix the specific problem and retry once; don't repeat the identical failing call.

# Examples of tone

Bad: "Конечно! Я с удовольствием проверю информацию о Bitso в нашем CRM. Сейчас сделаю запрос..."
Good: (call notion_insight_by_domain with domain="bitso.com", then summarize in 2-3 sentences)

Bad: "Я могу записать эту компанию в Notion. Хотите чтобы я это сделал?"
Good: "Записываю Bitso в Notion как P1 7.8, stage To Contact." → call notion_update_company

Bad: длинный план из 5 пунктов на простой вопрос
Good: ответ в 1-2 предложения`;

// ─────────────────────────────────────────────────────────────────────────────
// Cost calculation
// ─────────────────────────────────────────────────────────────────────────────

function computeCostUsd(usage) {
  if (!usage) return 0;
  const inputTokens  = usage.input_tokens  || 0;
  const outputTokens = usage.output_tokens || 0;
  const inputCost  = (inputTokens  / 1_000_000) * INPUT_PRICE_PER_MTOK;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MTOK;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude API call
// ─────────────────────────────────────────────────────────────────────────────

async function callClaudeAPI({ messages, tools, system, timeoutMs = 120_000 }) {
  if (!ANTHROPIC_KEY) {
    throw new Error("ANTHROPIC_API_KEY env var is not set");
  }

  const body = {
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const t0 = Date.now();
  try {
    const r = await axios.post(ANTHROPIC_API_URL, body, {
      headers: {
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type":      "application/json",
      },
      timeout: timeoutMs,
    });
    const elapsedMs = Date.now() - t0;
    console.log(`[agent] Claude API ${elapsedMs}ms · stop=${r.data.stop_reason} · in=${r.data.usage?.input_tokens} out=${r.data.usage?.output_tokens}`);
    return r.data;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const status    = err.response?.status;
    const respBody  = err.response?.data;
    const msg       = respBody?.error?.message || respBody?.message || err.message;
    console.error(`[agent] Claude API failed ${elapsedMs}ms · status=${status} · msg=${msg}`);
    throw new Error(`Claude API: ${msg}${status ? ` (HTTP ${status})` : ""}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-summarization
// ─────────────────────────────────────────────────────────────────────────────

async function summarizeHistory() {
  const view = store.getView();
  if (view.totalTurns < KEEP_RECENT_TURNS_ON_SUMMARIZE + 5) return;

  const turnsToCompress = view.turns.slice(0, -KEEP_RECENT_TURNS_ON_SUMMARIZE);
  const compressedText  = turnsToCompress.map((t, i) => {
    const role = t.role === "user"
      ? `USER (${t.metadata?.from || "?"})`
      : "ASSISTANT";
    const content = typeof t.content === "string"
      ? t.content
      : "[tool_use or tool_result blocks]";
    return `[${i + 1}] ${role}: ${String(content).slice(0, 500)}`;
  }).join("\n\n");

  const summarizationPrompt = `Below is a partial conversation history between Loop OS (an AI assistant for Plexo BD ops) and users Anton/Pavel. Summarize in 400-600 words, preserving:
- Decisions made
- Companies/people discussed and what was said about them
- Pending actions or unresolved questions
- Important context the assistant should remember

Skip trivial small-talk. Write the summary in the same language as the conversation (Russian if it's in Russian).

Conversation:
${compressedText}

Summary:`;

  try {
    const r = await callClaudeAPI({
      messages: [{ role: "user", content: summarizationPrompt }],
      tools: undefined,
      system: "You are a precise summarizer. Output only the summary text, no preamble.",
      timeoutMs: 60_000,
    });

    const summaryText = (r.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    if (!summaryText) {
      console.warn("[agent] Summarization returned empty text; skipping");
      return;
    }

    const previousSummary = view.summary
      ? `Earlier summary:\n${view.summary}\n\nNewer activity:\n${summaryText}`
      : summaryText;

    store.applySummarization({
      newSummary: previousSummary,
      keepRecentTurns: KEEP_RECENT_TURNS_ON_SUMMARIZE,
    });

    const cost = computeCostUsd(r.usage);
    console.log(`[agent] Summarized (kept ${KEEP_RECENT_TURNS_ON_SUMMARIZE} recent, summary ${summaryText.length} chars, cost $${cost.toFixed(4)})`);
  } catch (err) {
    console.error(`[agent] Summarization failed: ${err.message}; continuing without refresh`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool execution with retry
// ─────────────────────────────────────────────────────────────────────────────

async function executeToolWithRetry(toolName, toolInput) {
  let lastError = null;
  for (let attempt = 1; attempt <= TOOL_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await registry.executeTool(toolName, toolInput);
      if (result && typeof result === "object" && result.error) {
        lastError = result.error;
        console.warn(`[agent] tool ${toolName} attempt ${attempt} returned error: ${result.error}`);
        if (attempt < TOOL_RETRY_ATTEMPTS) continue;
      } else {
        if (attempt > 1) console.log(`[agent] tool ${toolName} succeeded on attempt ${attempt}`);
        return { ok: true, result };
      }
    } catch (err) {
      lastError = err.message;
      console.warn(`[agent] tool ${toolName} attempt ${attempt} threw: ${err.message}`);
      if (attempt < TOOL_RETRY_ATTEMPTS) continue;
    }
  }
  return { ok: false, error: lastError, attempts: TOOL_RETRY_ATTEMPTS };
}

// ─────────────────────────────────────────────────────────────────────────────
// Race-condition guard
// ─────────────────────────────────────────────────────────────────────────────

let lastActiveTurnId = null;

function newTurnId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function setActiveTurn(turnId) {
  lastActiveTurnId = turnId;
}

function isStillActive(turnId) {
  return lastActiveTurnId === turnId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for building API inputs
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemForApi() {
  return SYSTEM_PROMPT + store.getSummaryForSystem();
}

function buildMessagesForApi() {
  return store.getMessagesForApi();
}

function extractToolUseBlocks(response) {
  return (response.content || []).filter(b => b.type === "tool_use");
}

function extractTextBlocks(response) {
  return (response.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

function buildToolResultBlocks(executions) {
  return executions.map(e => ({
    type:        "tool_result",
    tool_use_id: e.tool_use_id,
    content:     typeof e.result === "string" ? e.result : JSON.stringify(e.result),
    is_error:    e.isError === true,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Append a user turn carrying tool_result content blocks
// ─────────────────────────────────────────────────────────────────────────────
//
// Anthropic spec: after an assistant turn that has tool_use blocks, the next
// user turn must contain tool_result blocks matching each tool_use_id.
//
// This goes through conversation-store.appendUserTurnRaw — which routes the
// write through the store's normal writeStore() path so the in-memory cache
// stays consistent. (An earlier version wrote the JSON file directly from
// here, which left the store's 1-second cache stale; getMessagesForApi() then
// returned a history MISSING this turn, and Anthropic rejected the next
// request with "tool_use ids were found without tool_result blocks", HTTP 400.)
function appendToolResultUserTurn(toolResultContent) {
  store.appendUserTurnRaw({ content: toolResultContent, from: "system" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner loop — shared by runAgentTurn and continueAfterApproval
// ─────────────────────────────────────────────────────────────────────────────

async function runInnerLoop({ turnId, totalCostUsd }) {
  const tools = registry.getToolDefinitions();

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (!isStillActive(turnId)) {
      console.log(`[agent] Turn ${turnId} superseded at iter ${iter}, cancelling`);
      return { kind: "cancelled", reason: "superseded by newer turn", turnId, costUsd: totalCostUsd };
    }

    let response;
    try {
      response = await callClaudeAPI({
        messages: buildMessagesForApi(),
        tools,
        system:   buildSystemForApi(),
      });
    } catch (err) {
      return {
        kind:     "tool_failed",
        toolName: "claude_api",
        error:    err.message,
        attempts: 1,
        turnId,
        costUsd:  totalCostUsd,
      };
    }

    const costThisCall = computeCostUsd(response.usage);
    totalCostUsd += costThisCall;

    // Record assistant turn (full content — text and tool_use blocks)
    store.appendAssistantTurn({
      content:      response.content,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      costUsd:      costThisCall,
      toolCalls:    null,
    });

    if (response.stop_reason === "end_turn") {
      return { kind: "final", text: extractTextBlocks(response), costUsd: totalCostUsd, turnId };
    }

    if (response.stop_reason === "max_tokens") {
      const partial = extractTextBlocks(response) || "(ответ оборван — попробуй короче или /new)";
      return { kind: "final", text: partial, costUsd: totalCostUsd, turnId };
    }

    // stop_reason === "tool_use" or has tool_use blocks
    const toolUseBlocks = extractToolUseBlocks(response);
    if (toolUseBlocks.length === 0) {
      const fallback = extractTextBlocks(response) || "(пустой ответ)";
      return { kind: "final", text: fallback, costUsd: totalCostUsd, turnId };
    }

    // If ANY block is a write tool, gate the entire batch through approval
    const writeBlock = toolUseBlocks.find(b => registry.isWriteTool(b.name));
    if (writeBlock) {
      return {
        kind: "approval",
        pending: {
          turnId,
          toolUseId: writeBlock.id,
          toolName:  writeBlock.name,
          toolInput: writeBlock.input,
          approvalSummary: registry.getApprovalSummary(writeBlock.name, writeBlock.input)
                           || `Выполнить ${writeBlock.name}`,
          allToolUseBlocks: toolUseBlocks.map(b => ({
            id:      b.id,
            name:    b.name,
            input:   b.input,
            isWrite: registry.isWriteTool(b.name),
          })),
        },
        costUsd: totalCostUsd,
      };
    }

    // All read tools — execute in parallel
    console.log(`[agent] iter ${iter}: executing ${toolUseBlocks.length} read tool(s)`);
    const executions = await Promise.all(toolUseBlocks.map(async (b) => {
      const res = await executeToolWithRetry(b.name, b.input);
      if (!res.ok) {
        return { tool_use_id: b.id, result: { error: res.error }, isError: true, toolName: b.name };
      }
      return { tool_use_id: b.id, result: res.result, isError: false, toolName: b.name };
    }));

    // If any tool failed twice, bail
    const hardFail = executions.find(e => e.isError);
    if (hardFail) {
      // Per Anthropic spec, after an assistant tool_use turn we still owe a
      // user turn with tool_result blocks — otherwise the conversation is
      // left in an invalid state for the next request. Persist the results
      // (including the error block) BEFORE bailing.
      appendToolResultUserTurn(buildToolResultBlocks(executions));
      return {
        kind:     "tool_failed",
        toolName: hardFail.toolName,
        error:    hardFail.result.error,
        attempts: TOOL_RETRY_ATTEMPTS,
        turnId,
        costUsd:  totalCostUsd,
      };
    }

    // Feed results back as a tool_result user turn (Anthropic spec)
    const toolResultContent = buildToolResultBlocks(executions);
    appendToolResultUserTurn(toolResultContent);
  }

  console.warn(`[agent] MAX_TOOL_ITERATIONS=${MAX_TOOL_ITERATIONS} hit for turn ${turnId}`);
  return {
    kind:    "final",
    text:    "(превысил лимит tool calls — попробуй переформулировать)",
    costUsd: totalCostUsd,
    turnId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point: runAgentTurn
// ─────────────────────────────────────────────────────────────────────────────

async function runAgentTurn({ text, from, fromUserId }) {
  // 1. Append user turn with attribution baked into text
  const taggedText = `[From: ${from}] ${text}`;
  store.appendUserTurn({ text: taggedText, from, fromUserId });

  // 2. Maybe summarize old history
  const trunc = store.getTruncationStatus();
  if (trunc.shouldSummarize || trunc.mustReset) {
    console.log(`[agent] Turns=${trunc.totalTurns}, summarizing...`);
    await summarizeHistory();
  }

  // 3. Generate turnId and mark active
  const turnId = newTurnId();
  setActiveTurn(turnId);

  // 4. Run the inner loop
  return runInnerLoop({ turnId, totalCostUsd: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Continue after approval (user clicked ✅ or ❌)
// ─────────────────────────────────────────────────────────────────────────────

async function continueAfterApproval({ pending, approved, userOverrideInput }) {
  const { turnId, allToolUseBlocks } = pending;

  if (!isStillActive(turnId)) {
    return { kind: "cancelled", reason: "superseded after approval", turnId, costUsd: 0 };
  }

  // Execute all blocks: writes only if approved, reads always
  const executions = [];

  for (const block of allToolUseBlocks) {
    if (block.isWrite) {
      if (!approved) {
        executions.push({
          tool_use_id: block.id,
          result:      { cancelled: true, reason: "User rejected approval" },
          isError:     false,
          toolName:    block.name,
        });
        continue;
      }
      const effectiveInput = userOverrideInput || block.input;
      const res = await executeToolWithRetry(block.name, effectiveInput);
      if (!res.ok) {
        // Still owe a tool_result user turn before bailing — otherwise the
        // stored conversation is left invalid for the next request.
        executions.push({
          tool_use_id: block.id,
          result:      { error: res.error },
          isError:     true,
          toolName:    block.name,
        });
        appendToolResultUserTurn(buildToolResultBlocks(executions));
        return {
          kind:     "tool_failed",
          toolName: block.name,
          error:    res.error,
          attempts: TOOL_RETRY_ATTEMPTS,
          turnId,
          costUsd:  0,
        };
      }
      executions.push({
        tool_use_id: block.id,
        result:      res.result,
        isError:     false,
        toolName:    block.name,
      });
    } else {
      // Read tool — execute regardless of approval (free)
      const res = await executeToolWithRetry(block.name, block.input);
      executions.push({
        tool_use_id: block.id,
        result:      res.ok ? res.result : { error: res.error },
        isError:     !res.ok,
        toolName:    block.name,
      });
    }
  }

  // Append tool_result user turn
  const toolResultContent = buildToolResultBlocks(executions);
  appendToolResultUserTurn(toolResultContent);

  // Resume the inner loop
  return runInnerLoop({ turnId, totalCostUsd: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  runAgentTurn,
  continueAfterApproval,
  computeCostUsd,
  SYSTEM_PROMPT,
  MODEL,
};
