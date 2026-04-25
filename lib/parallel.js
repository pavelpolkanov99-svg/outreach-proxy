const PARALLEL_KEY = process.env.PARALLEL_KEY;

function parallelHeaders() {
  return {
    "Authorization": `Bearer ${PARALLEL_KEY}`,
    "Content-Type":  "application/json",
  };
}

// ── Research prompt — aligned with BD Scoring Framework v2.1 ─────────────────
//
// Schema design notes (v3.13 — ultra-flat schema for batch + base processor stability):
// - Per-axis label + source DROPPED (rationale already in FieldBasis.reasoning)
// - Single top_sources[] array replaces 9× axisN_source
// - hard_kill kept flat: hk_triggered + hk_criterion
// - axis10_score optional (only Partners)
// - Property count: 38 (v3.12 flat) → 18 total / 15 required
// - Battle test (Apr 2026): v3.12 returned {} on Xapo Bank via base processor
//   due to 35-property schema warning. v3.13 keeps required at 15 for stability.
// - Added HK-11 (media/news/research) — closed BeInCrypto-class edge cases.
//
function buildResearchQuery(company, domain) {
  return [
    `You are BD Scoring — Plexo's deep-research analyst (Plexo was formerly known as RemiDe; treat as synonym in legacy sources).`,
    `Plexo is a Stablecoin Clearing Network for licensed financial institutions, enabling compliant cross-border stablecoin settlements (USDC/USDT/EURC) between licensed FIs.`,
    `Your single job: qualify "${company}"${domain ? ` (${domain})` : ""} as a potential Client (OFI/DFI/BFI) or Partner.`,
    ``,
    `MONEY FLOW TEST — apply first to determine fit:`,
    `  ✅ Business → Business (via FIs) = Plexo Match`,
    `  ❌ Consumer → Merchant (HK-6)`,
    `  ❌ Company → Employee, payroll/HR cross-border (HK-9)`,
    `  ❌ Consumer → Exchange retail on-ramp widget (HK-8)`,
    `  ❌ Investor → Custody only (HK-4)`,
    ``,
    `HARD KILL CRITERIA — if ANY triggers, set hk_triggered=true and hk_criterion to the matching code:`,
    `  HK-1: RWA tokenization only (Canton, Cashlink)`,
    `  HK-2: DeFi-native without KYC (Curve, Quantillon)`,
    `  HK-3: Traditional private banking, no crypto/payments (Maerki Baumann)`,
    `  HK-4: Digital asset custody / trading ONLY (Anchorage, Copper, Aplo)`,
    `  HK-5: Consulting / advisory, not infra (Stratum Finance)`,
    `  HK-6: Merchant payments / e-commerce crypto (BitPay, Alchemy Pay, CoinGate)`,
    `  HK-7: Pure fiat BaaS without crypto on/off-ramp (Fiat Republic)`,
    `  HK-8: Retail-only on-ramp widget (MoonPay, Transak, Wyre)`,
    `  HK-9: Payroll / HR cross-border (Deel, Remote.com, Papaya)`,
    `  HK-10: Compliance / analytics SaaS only (Chainalysis, Elliptic, Scorechain)`,
    `  HK-11: Media / news / research / awards platform — not an FI itself (BeInCrypto, CoinDesk, The Block, Messari, Galaxy Research)`,
    `Edge case: if expansion signals exist alongside hard kill, set category="Hard Kill - Watch".`,
    ``,
    `RESEARCH QUALITY RULES (NON-NEGOTIABLE):`,
    `  1. No fabrication. If not found, score conservatively (cap at 3/10) and lower confidence_level.`,
    `  2. Source everything. Cite up to 3 best URLs in top_sources[].`,
    `  3. Conservative by default. When in doubt, score lower.`,
    `  4. No flattery bias. Brand size ≠ score.`,
    `  5. Temporal accuracy. Score TODAY's business, not 2-year-old news or future plans.`,
    `Acceptable sources: company website, LinkedIn, Crunchbase, regulatory registers (FCA, BaFin, FINMA, AMF, MAS, ACPR), news (last 18 months).`,
    `NOT acceptable: Reddit, anonymous forums, "general knowledge" without link.`,
    ``,
    `THE 10 AXES — score each 0–10 per framework rubric:`,
    ``,
    `Dimension A — Business Model Fit`,
    `  Axis 1 (Cross-Border Payment Core): 9–10 = XBorder is main business; 7–8 = significant XBorder revenue OR Strategic Entrant; 5–6 secondary; 3–4 vague intl ambitions; 1–2 no XBorder.`,
    `  Axis 2 (On/Off Ramp): 9–10 = ramp is core fiat↔stablecoin at scale; 7–8 major service; 5–6 partial OR large FI with extensible infra; 3–4 indirect via partners; 1–2 no ramp.`,
    `  Axis 3 (Stablecoin Alignment): 9–10 = multi-stablecoin core; 7–8 active with one major stablecoin; 5–6 adjacent OR Strategic Entrant piloting; 3–4 crypto-active but not stablecoin; 1–2 none.`,
    `  Axis 4 (Corridor & Geography): 9–10 = Africa+LATAM or MENA active flows; 7–8 strong EM (Africa OR LATAM OR MENA OR SEA); 5–6 EU+global; 3–4 EU/US only; 1–2 single-country. EM + confirmed XBorder = floor +2.`,
    ``,
    `Dimension B — Network & Structural Fit`,
    `  Axis 5 (Network Role Clarity OFI/DFI/BFI): 9–10 bidirectional OFI+DFI; 7–8 clear single role; 5–6 one direction clear; 3–4 vague; 1–2 cannot determine.`,
    `  Axis 6 (Regulatory & License): 9–10 multi-jurisdiction (VASP+PSP/EMI), MiCA-aligned; 7–8 licensed primary, active compliance; 5–6 licensed one jurisdiction; 3–4 pending/transitional; 1–2 unlicensed.`,
    `  Axis 7 (B2B / Institutional Scale): 9–10 institutional-focused, OTC desk; 7–8 mix institutional+retail; 5–6 primarily retail with B2B segment; 3–4 consumer-focused; 1–2 micro-payments only.`,
    `  Axis 8 (Competitive Proximity): 9–10 pure client/partner; 7–8 minimal overlap; 5–6 partial competitor BUT angle exists; 3–4 significant overlap; 1–2 direct competitor on clearing/settlement. Competitor ≠ auto-zero — if angle exists, score 5–6.`,
    ``,
    `Dimension C — Partnership (Partners only)`,
    `  Axis 10 (Partnership Infra Fit) — ONLY for Partners. If Client, set axis10_score=0: 9–10 closes specific gap; 7–8 strong integration; 5–6 useful ecosystem; 3–4 vaguely complementary; 1–2 no relevance.`,
    ``,
    `STRATEGIC ENTRANT DETECTION (don't apply modifier yourself, just report signal):`,
    `If (1) major bank/Tier-1 fintech AND (2) confirmed fiat XBorder AND (3) verifiable stablecoin signal <12 months — fill strategic_entrant_signal with specific signal + source URL. Otherwise "NOT APPLICABLE".`,
    ``,
    `CATEGORY DETERMINATION:`,
    `  Client = licensed FI using Plexo for stablecoin settlement (VASP, PSP, EMI, bank, exchange, wallet doing XBorder)`,
    `  Partner = ecosystem player providing infra (identity, BaaS/IBAN, stablecoin issuer, liquidity)`,
    `  Hard Kill = does not fit (apply HK criteria above)`,
    `  Hard Kill - Watch = HK triggers BUT expansion signals exist`,
    ``,
    `Return ONLY the structured JSON output — no preamble, no markdown.`,
  ].join("\n");
}

// v3.13 ultra-flat: 18 total props, 15 required.
// Drop axisN_label + axisN_source per-axis (was 18 props).
// Single top_sources[] (1 prop) replaces 9× axisN_source.
const parallelTaskSpec = {
  output_schema: {
    type: "json",
    json_schema: {
      type: "object",
      properties: {
        // ── Classification ────────────────────────────────────────────────
        category: {
          type: "string",
          enum: ["Client", "Partner", "Hard Kill", "Hard Kill - Watch", "Hard Kill - Plexo Direct candidate"],
        },
        network_role: {
          type: "string",
          enum: ["OFI", "DFI", "BFI", "OFI+DFI", "N/A"],
        },
        // ── Hard kill (flat) ──────────────────────────────────────────────
        hk_triggered: { type: "boolean" },
        hk_criterion: {
          type: "string",
          description: "HK-1..HK-11 if triggered, else empty string",
        },
        // ── Axes (score only) ─────────────────────────────────────────────
        axis1_score:  { type: "number", description: "0-10, Cross-Border Payment Core" },
        axis2_score:  { type: "number", description: "0-10, On/Off Ramp" },
        axis3_score:  { type: "number", description: "0-10, Stablecoin Alignment" },
        axis4_score:  { type: "number", description: "0-10, Corridor & Geography" },
        axis5_score:  { type: "number", description: "0-10, Network Role Clarity" },
        axis6_score:  { type: "number", description: "0-10, Regulatory & License" },
        axis7_score:  { type: "number", description: "0-10, B2B Institutional Scale" },
        axis8_score:  { type: "number", description: "0-10, Competitive Proximity" },
        // Axis 10 only meaningful for Partners; for Clients return 0
        axis10_score: { type: "number", description: "0-10, Partnership Infra Fit (Partners only, else 0)" },
        // ── Meta fields ───────────────────────────────────────────────────
        top_sources: {
          type: "array",
          description: "Up to 3 best source URLs supporting the scoring",
          items: { type: "string" },
        },
        strategic_entrant_signal: {
          type: "string",
          description: "Specific signal+source if all 3 conditions met, else 'NOT APPLICABLE'",
        },
        readiness: {
          type: "string",
          enum: ["Now", "3-6mo", "6-12mo", "12+mo", "Unknown"],
        },
        confidence_level: {
          type: "string",
          enum: ["High", "Medium", "Low"],
        },
      },
      required: [
        "category", "network_role", "hk_triggered", "hk_criterion",
        "axis1_score", "axis2_score", "axis3_score", "axis4_score",
        "axis5_score", "axis6_score", "axis7_score", "axis8_score",
        "strategic_entrant_signal", "readiness", "confidence_level",
      ],
    },
  },
};

module.exports = {
  PARALLEL_KEY,
  parallelHeaders,
  buildResearchQuery,
  parallelTaskSpec,
};
