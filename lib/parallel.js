const PARALLEL_KEY = process.env.PARALLEL_KEY;

function parallelHeaders() {
  return {
    "Authorization": `Bearer ${PARALLEL_KEY}`,
    "Content-Type":  "application/json",
  };
}

// ── Research prompt — aligned with BD Scoring Framework v2.1 ─────────────────
//
// Schema design notes (v3.12 — flat schema for batch performance):
// - Each axis is THREE flat fields: axisN_score, axisN_label, axisN_source
//   (rationale removed — already in FieldBasis.reasoning if needed)
// - hard_kill flattened: hk_triggered + hk_criterion
// - axis10_* optional (only Partners)
// - Property count: 56 nested → 38 flat
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
    `Edge case: if expansion signals exist alongside hard kill, set category="Hard Kill - Watch".`,
    ``,
    `RESEARCH QUALITY RULES (NON-NEGOTIABLE):`,
    `  1. No fabrication. If not found, label UNKNOWN and score conservatively.`,
    `  2. Source everything. Each axis MUST cite at least one source URL in axisN_source.`,
    `  3. Conservative by default. When in doubt, score lower.`,
    `  4. Label every axis: FACT (found+citable) | INFERENCE (derived, ⚠️) | UNKNOWN (cap score at 3/10).`,
    `  5. No flattery bias. Brand size ≠ score.`,
    `  6. Temporal accuracy. Score TODAY's business, not 2-year-old news or future plans.`,
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
    `  Axis 10 (Partnership Infra Fit) — ONLY for Partners. If Client, set axis10_score=0, axis10_label=UNKNOWN, axis10_source="N/A": 9–10 closes specific gap; 7–8 strong integration; 5–6 useful ecosystem; 3–4 vaguely complementary; 1–2 no relevance.`,
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
          description: "HK-1..HK-10 if triggered, else empty string",
        },
        // ── Axes (flat triplets) ──────────────────────────────────────────
        axis1_score:  { type: "number", description: "0-10" },
        axis1_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis1_source: { type: "string", description: "Primary source URL or empty if UNKNOWN" },

        axis2_score:  { type: "number" },
        axis2_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis2_source: { type: "string" },

        axis3_score:  { type: "number" },
        axis3_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis3_source: { type: "string" },

        axis4_score:  { type: "number" },
        axis4_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis4_source: { type: "string" },

        axis5_score:  { type: "number" },
        axis5_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis5_source: { type: "string" },

        axis6_score:  { type: "number" },
        axis6_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis6_source: { type: "string" },

        axis7_score:  { type: "number" },
        axis7_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis7_source: { type: "string" },

        axis8_score:  { type: "number" },
        axis8_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis8_source: { type: "string" },

        // Axis 10 only meaningful for Partners; for Clients return 0/UNKNOWN/"N/A"
        axis10_score:  { type: "number" },
        axis10_label:  { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
        axis10_source: { type: "string" },

        // ── Meta fields ───────────────────────────────────────────────────
        strategic_entrant_signal: {
          type: "string",
          description: "Specific signal+source if all 3 conditions met, else 'NOT APPLICABLE'",
        },
        readiness: {
          type: "string",
          enum: ["Now", "3-6mo", "6-12mo", "12+mo", "Unknown"],
        },
        est_volume_monthly: {
          type: "string",
          description: "Estimated monthly XBorder volume USD, or 'Unknown'",
        },
        confidence_level: {
          type: "string",
          enum: ["High", "Medium", "Low"],
        },
      },
      required: [
        "category", "network_role", "hk_triggered", "hk_criterion",
        "axis1_score", "axis1_label", "axis1_source",
        "axis2_score", "axis2_label", "axis2_source",
        "axis3_score", "axis3_label", "axis3_source",
        "axis4_score", "axis4_label", "axis4_source",
        "axis5_score", "axis5_label", "axis5_source",
        "axis6_score", "axis6_label", "axis6_source",
        "axis7_score", "axis7_label", "axis7_source",
        "axis8_score", "axis8_label", "axis8_source",
        "strategic_entrant_signal", "readiness", "est_volume_monthly", "confidence_level",
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
