// ══════════════════════════════════════════════════════════════════════════════
// HEYREACH SEQUENCE PRESETS (Plexo, confirmed Apr 24, 2026)
// Placeholders: {FIRST_NAME}, {LAST_NAME}, {POSITION}, {COMPANY},
//               {LOCATION}, {INDUSTRY}, {ACCOUNT_NAME}, {ACCOUNT_LAST_NAME}
// Rule: ALL nodes incl. END require actionDelay >= 3 HOURS
// ══════════════════════════════════════════════════════════════════════════════

// Terminal END-node with required 3h delay
const END_NODE = { nodeType: "END", actionDelay: 3, actionDelayUnit: "HOUR" };

const PLEXO_PRESETS = {
  // Preset 1: Connect request with note, END on both branches
  connect_note: (msgs = {}) => ({
    nodeType: "CONNECTION_REQUEST",
    actionDelay: 3,
    actionDelayUnit: "HOUR",
    payload: {
      messages: [
        msgs.note ||
        "Hi {FIRST_NAME}, building Plexo — stablecoin clearing for licensed FIs. Thought {COMPANY} might be relevant. Connect?"
      ],
      fallbackMessage:
        msgs.noteFallback ||
        "Hi, building Plexo — stablecoin clearing for licensed FIs. Connect?",
      toBeWithdrawnAfterDays: msgs.withdrawDays || 14,
    },
    conditionalNode: END_NODE,
    unconditionalNode: END_NODE,
  }),

  // Preset 2: Blank connect + MESSAGE on accept
  connect_fu: (msgs = {}) => ({
    nodeType: "CONNECTION_REQUEST",
    actionDelay: 3,
    actionDelayUnit: "HOUR",
    payload: {
      messages: [""],
      toBeWithdrawnAfterDays: msgs.withdrawDays || 14,
    },
    conditionalNode: {
      nodeType: "MESSAGE",
      actionDelay: msgs.fuDelay || 2,
      actionDelayUnit: "DAY",
      payload: {
        messages: [
          msgs.followup ||
          "Thanks for connecting {FIRST_NAME}. Plexo is a stablecoin clearing network for licensed FIs — cross-border settlement on USDC/USDT/EURC. Curious if relevant to {COMPANY}."
        ],
        fallbackMessage:
          msgs.followupFallback ||
          "Thanks for connecting. Plexo — stablecoin clearing network for licensed FIs. Happy to share a one-pager if useful.",
      },
      unconditionalNode: END_NODE,
    },
    unconditionalNode: END_NODE,
  }),

  // Preset 3: Connect with note → message on accept → second follow-up on no-reply
  connect_note_fu: (msgs = {}) => ({
    nodeType: "CONNECTION_REQUEST",
    actionDelay: 3,
    actionDelayUnit: "HOUR",
    payload: {
      messages: [
        msgs.note ||
        "Hi {FIRST_NAME}, building Plexo — stablecoin clearing for licensed FIs. Saw your work at {COMPANY}. Open to connect?"
      ],
      fallbackMessage:
        msgs.noteFallback ||
        "Hi, building Plexo — stablecoin clearing for licensed FIs. Open to connect?",
      toBeWithdrawnAfterDays: msgs.withdrawDays || 14,
    },
    conditionalNode: {
      nodeType: "MESSAGE",
      actionDelay: msgs.fu1Delay || 3,
      actionDelayUnit: "DAY",
      payload: {
        messages: [
          msgs.followup1 ||
          "Thanks for connecting {FIRST_NAME}. Plexo = SWIFT for stablecoins, built only for licensed FIs. Cross-border USDC/USDT/EURC, fully KYC/AML-compliant. Relevant to {COMPANY}? 15 min next week?"
        ],
        fallbackMessage:
          msgs.followup1Fallback ||
          "Thanks for connecting. Plexo — stablecoin clearing for licensed FIs. 15 min next week to see if there's a fit?",
      },
      unconditionalNode: {
        nodeType: "MESSAGE",
        actionDelay: msgs.fu2Delay || 5,
        actionDelayUnit: "DAY",
        payload: {
          messages: [
            msgs.followup2 ||
            "Quick follow-up {FIRST_NAME} — we're onboarding founding partners now, 4 live corridors (EU↔LATAM, UAE↔SEA, UK↔Africa, US↔Philippines). Worth 15 min this week?"
          ],
          fallbackMessage:
            msgs.followup2Fallback ||
            "Quick follow-up — we're onboarding founding partners now. Worth 15 min this week?",
        },
        unconditionalNode: END_NODE,
      },
    },
    unconditionalNode: END_NODE,
  }),
};

module.exports = { END_NODE, PLEXO_PRESETS };
