  for (let i = 0; i < cards.length; i++) {
    const card   = cards[i];
    const cardId = storeCommentCard(card, userId);
    const text   = buildCommentCardText(card, i + 1, cards.length);
    try {
      await bot.api.sendMessage(userId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: buildCommentKeyboard(cardId),
      });
      // Small delay to ensure Telegram delivers cards in correct order
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error(`[bot] failed to send card ${i + 1}:`, err.message);
    }
  }