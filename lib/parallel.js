const PARALLEL_KEY = process.env.PARALLEL_KEY;

function parallelHeaders() {
  return {
    "Authorization": `Bearer ${PARALLEL_KEY}`,
    "Content-Type":  "application/json",
  };
}

// ── Research prompt — aligned with BD Scoring Framework v2.1 ─────────────────
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
    `HARD KILL CRITERIA — if ANY triggers, set hard_kill.triggered=true, score axes 0:`,
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
    `Edge case: if expansion signals (recent announcements, hiring) exist alongside hard kill, set hard_kill.watch_flag=true.`,
    ``,
    `RESEARCH QUALITY RULES (NON-NEGOTIABLE):`,
    `  1. No fabrication. If not found, say "NOT FOUND" and label UNKNOWN.`,
    `  2. Source everything. Each axis MUST cite at least one source URL.`,
    `  3. Conservative by default. When in doubt, score lower.`,
    `  4. Label every rationale: FACT (found+citable) | INFERENCE (derived, flag ⚠️) | UNKNOWN (cap score at 3/10).`,
    `  5. No flattery bias. Brand size ≠ score.`,
    `  6. Temporal accuracy. Score TODAY's business, not 2-year-old news or future plans.`,
    `Acceptable sources: company website, LinkedIn, Crunchbase, regulatory registers (FCA, BaFin, FINMA, AMF, MAS, ACPR), recognized news outlets (last 18 months).`,
    `NOT acceptable: Reddit, anonymous forums, "general knowledge" without link.`,
    ``,
    `THE 10 AXES — score each 0–10 per framework rubric:`,
    ``,
    `Dimension A — Business Model Fit`,
    `  Axis 1 (Cross-Border Payment Core): 9–10 = XBorder is main business; 7–8 = significant XBorder revenue OR Strategic Entrant (large bank with fiat XBorder exploring stablecoin); 5–6 secondary; 3–4 vague intl ambitions; 1–2 no XBorder.`,
    `  Axis 2 (On/Off Ramp): 9–10 = ramp is core, fiat↔stablecoin at scale; 7–8 major service; 5–6 partial OR large FI with extensible fiat infra; 3–4 indirect via partners; 1–2 no ramp.`,
    `  Axis 3 (Stablecoin Alignment): 9–10 = multi-stablecoin core; 7–8 active with one major stablecoin; 5–6 adjacent OR Strategic Entrant piloting; 3–4 crypto-active but not stablecoin (BTC/ETH); 1–2 none.`,
    `  Axis 4 (Corridor & Geography): 9–10 = Africa+LATAM or MENA with active flows; 7–8 strong EM (Africa OR LATAM OR MENA OR SEA); 5–6 EU with global reach; 3–4 EU/US only; 1–2 single-country. EM presence + confirmed XBorder = floor +2.`,
    ``,
    `Dimension B — Network & Structural Fit`,
    `  Axis 5 (Network Role Clarity OFI/DFI/BFI): 9–10 bidirectional (OFI+DFI); 7–8 clear single role with strong flow; 5–6 one direction clear; 3–4 vague; 1–2 cannot determine.`,
    `  Axis 6 (Regulatory & License Profile): 9–10 multi-jurisdiction (VASP+PSP/EMI), MiCA-aligned; 7–8 licensed in primary, active compliance; 5–6 licensed one jurisdiction expanding; 3–4 pending/transitional; 1–2 unlicensed/anonymous.`,
    `  Axis 7 (B2B / Institutional Scale): 9–10 institutional-focused, OTC desk, B2B volume; 7–8 mix institutional+retail with B2B significant; 5–6 primarily retail with B2B segment; 3–4 consumer-focused; 1–2 micro-payments only.`,
    `  Axis 8 (Competitive Proximity): 9–10 pure client/partner no overlap; 7–8 minimal overlap; 5–6 partial competitor BUT angle exists where they'd benefit; 3–4 significant overlap; 1–2 direct competitor on clearing/settlement/Travel Rule. IMPORTANT: competitor ≠ auto-zero. If angle exists, score 5–6.`,
    ``,
    `Dimension C — People & Partnership`,
    `  Axis 10 (Partnership Infrastructure Fit) — ONLY for Partners (return null/0 if Client): 9–10 closes specific tech/reg gap (GLEIF→LEI, Narvi→BaaS IBANs); 7–8 strong integration point; 5–6 useful ecosystem player; 3–4 vaguely complementary; 1–2 no relevance.`,
    ``,
    `STRATEGIC ENTRANT DETECTION (don't apply modifier yourself, just report signal):`,
    `If company is (1) major bank/Tier-1 fintech AND (2) has confirmed fiat cross-border ops AND (3) has verifiable stablecoin signal (<12 months: hiring, partnership, pilot, public statement, sandbox application) — fill strategic_entrant_signal with the specific signal text + source URL. Otherwise leave it as "NOT APPLICABLE".`,
    ``,
    `CATEGORY DETERMINATION:`,
    `  Client = uses Plexo's network as licensed FI for stablecoin settlement (VASP, PSP, EMI, bank, exchange, wallet doing XBorder)`,
    `  Partner = ecosystem player providing infra to Plexo (identity/verification, BaaS/IBAN, stablecoin issuer, liquidity provider)`,
    `  Hard Kill = does not fit either (apply HK criteria above)`,
    ``,
    `Return ONLY the structured JSON output — no preamble, no markdown.`,
  ].join("\n");
}

// ── Parallel task spec — structured output aligned with framework v2.1 ────────
//
// Schema design notes:
// - Each axis is an OBJECT (score + rationale + label + source_url) per rule 8.4
// - hard_kill is a structured object, not a string-with-prefix (fixes B2)
// - Removed top-level `sources` field (fixes B3 — Parallel emitted spec_validation_warning)
// - axis10_partner_fit only meaningful when category=Partner
// - strategic_entrant_signal — Parallel reports detected signal + source; Claude applies modifier post-hoc (option a)
//
const axisSchema = {
  type: "object",
  properties: {
    score:      { type: "number", description: "0-10 per framework rubric" },
    rationale:  { type: "string", description: "1-sentence reasoning citing the source" },
    label:      { type: "string", enum: ["FACT", "INFERENCE", "UNKNOWN"] },
    source_url: { type: "string", description: "URL of primary source; empty string if UNKNOWN" },
  },
  required: ["score", "rationale", "label", "source_url"],
};

const parallelTaskSpec = {
  output_schema: {
    type: "json",
    json_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["Client", "Partner", "Hard Kill", "Hard Kill - Watch", "Hard Kill - Plexo Direct candidate"],
          description: "Top-level classification per framework section 3 + 13",
        },
        network_role: {
          type: "string",
          enum: ["OFI", "DFI", "BFI", "OFI+DFI", "N/A"],
          description: "Originating FI / Disbursement FI / Beneficiary FI; N/A for Partners",
        },
        hard_kill: {
          type: "object",
          properties: {
            triggered:  { type: "boolean" },
            criterion:  { type: "string", description: "HK-1..HK-10 if triggered, else empty string" },
            reasoning:  { type: "string", description: "Brief explanation of why triggered or why passed" },
            watch_flag: { type: "boolean", description: "True if HK triggered BUT expansion signals exist" },
          },
          required: ["triggered", "criterion", "reasoning", "watch_flag"],
        },
        axis1_xborder_core:         axisSchema,
        axis2_ramp:                 axisSchema,
        axis3_stablecoin_alignment: axisSchema,
        axis4_corridors:            axisSchema,
        axis5_network_role:         axisSchema,
        axis6_licenses:             axisSchema,
        axis7_b2b_scale:            axisSchema,
        axis8_competitive:          axisSchema,
        axis10_partner_fit:         axisSchema, // Only meaningful if category=Partner
        strategic_entrant_signal: {
          type: "string",
          description: "Specific signal+source if all 3 conditions met, else 'NOT APPLICABLE'",
        },
        readiness: {
          type: "string",
          enum: ["Now", "3-6mo", "6-12mo", "12+mo", "Unknown"],
          description: "When this account is likely actionable per framework section 10",
        },
        est_volume_monthly: {
          type: "string",
          description: "Estimated monthly cross-border volume in USD, or 'Unknown'",
        },
        confidence_level: {
          type: "string",
          enum: ["High", "Medium", "Low"],
          description: "Overall confidence per framework section 10",
        },
      },
      required: [
        "category", "network_role", "hard_kill",
        "axis1_xborder_core", "axis2_ramp", "axis3_stablecoin_alignment",
        "axis4_corridors", "axis5_network_role", "axis6_licenses",
        "axis7_b2b_scale", "axis8_competitive", "axis10_partner_fit",
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
