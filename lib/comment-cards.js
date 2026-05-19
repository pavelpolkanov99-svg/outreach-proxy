// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn Comment Approval Flow
//
// In-memory store for pending comment cards.
// Key: cardId (string) → { card, chatId, messageId, resolved }
// ─────────────────────────────────────────────────────────────────────────────

const commentCards = new Map();
let commentCardCounter = 0;

function storeCommentCard(card, chatId, messageId) {
  const cardId = `cc_${Date.now()}_${++commentCardCounter}`;
  commentCards.set(cardId, { card, chatId, messageId, resolved: false });
  // Auto-expire after 24h
  setTimeout(() => commentCards.delete(cardId), 24 * 60 * 60 * 1000);
  return cardId;
}

function resolveCommentCard(cardId) {
  const entry = commentCards.get(cardId);
  if (!entry || entry.resolved) return null;
  entry.resolved = true;
  return entry;
}

// Build one approval card message for Telegram
function buildCommentCardText(card, index, total) {
  const author = esc(card.authorName || "Unknown");
  const company = card.company ? ` · ${esc(card.company)}` : "";
  const postPreview = (card.postText || "").slice(0, 300);
  const postUrl = card.postUrl ? `\n<a href="${esc(card.postUrl)}">🔗 Открыть пост</a>` : "";

  const lines = [
    `💬 <b>Комментарий ${index}/${total}</b>`,
    `👤 <b>${author}</b>${company}`,
    ``,
    `<i>${esc(postPreview)}${postPreview.length >= 300 ? "..." : ""}</i>${postUrl}`,
    ``,
    `━━━━━━━━━━━━`,
    ``,
  ];

  for (const draft of (card.drafts || [])) {
    lines.push(`<b>${draft.n}️⃣</b> ${esc(draft.text)}`);
    lines.push(``);
  }

  if (card.substance_anchor) {
    lines.push(`<i>📎 ${esc(card.substance_anchor)}</i>`);
  }

  return lines.join("\n");
}

function buildCommentCardKeyboard(cardId) {
  return {
    inline_keyboard: [
      [
        { text: "1️⃣", callback_data: `cc:${cardId}:1` },
        { text: "2️⃣", callback_data: `cc:${cardId}:2` },
        { text: "3️⃣", callback_data: `cc:${cardId}:3` },
        { text: "✕ Пропустить", callback_data: `cc:${cardId}:skip` },
      ],
    ],
  };
}

// Fetch comment cards from proxy
async function fetchCommentCards(maxCards = 7) {
  const r = await axios.post(`${PROXY}/apify/linkedin-posts`, {
    maxPostsPerQuery: 5,
  }, { timeout: 130_000 });

  if (!r.data?.ok) throw new Error(r.data?.error || "Apify fetch failed");

  const batchRes = await axios.post(`${PROXY}/comments/batch`, {
    posts: r.data.posts,
    maxCards,
  }, { timeout: 180_000 });

  if (!batchRes.data?.ok) throw new Error(batchRes.data?.error || "Batch generation failed");

  return batchRes.data.cards || [];
}

// Send comment approval cards to a user
async function sendCommentCards(userId, cards) {
  if (!cards.length) {
    await bot.api.sendMessage(userId,
      `💬 <b>LinkedIn Comments</b>\n\n<i>Нет релевантных постов для комментирования сегодня.</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const text = buildCommentCardText(card, i + 1, cards.length);
    const msg = await bot.api.sendMessage(userId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: buildCommentCardKeyboard("placeholder"),
    });
    const cardId = storeCommentCard(card, userId, msg.message_id);
    // Re-send with correct cardId in keyboard
    await bot.api.editMessageReplyMarkup(userId, msg.message_id, {
      reply_markup: buildCommentCardKeyboard(cardId),
    });
  }
}

module.exports = { sendCommentCards, fetchCommentCards };
