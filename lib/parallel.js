const PARALLEL_KEY = process.env.PARALLEL_KEY;

function parallelHeaders() {
  return {
    "Authorization": `Bearer ${PARALLEL_KEY}`,
    "Content-Type":  "application/json",
  };
}

function buildResearchQuery(company, domain) {
  return [
    `You are a B2B fintech analyst qualifying "${company}"${domain ? ` (${domain})` : ""} as a potential client or partner for Plexo — a Stablecoin Clearing Network for licensed financial institutions.`,
    `Plexo enables compliant cross-border stablecoin settlements (USDC/USDT/EURC) between licensed FIs.`,
    `Research this company and answer ONLY the following scoring questions. For each, provide a factual answer with source URL. If not found, say NOT FOUND.`,
    `AXIS 1 — Cross-Border Payments Core: Does this company process cross-border B2B payments as a core business? Any volume or corridor data?`,
    `AXIS 2 — On/Off Ramp: Do they convert between fiat and stablecoins/crypto? Any USDC/USDT/EURC ramp infrastructure?`,
    `AXIS 3 — Stablecoin Alignment: Any public stablecoin activity in last 12 months? Pilots, integrations, announcements, partnerships with Circle/Tether/Paxos?`,
    `AXIS 4 — Corridors: Which geographic corridors do they operate in?`,
    `AXIS 5 — Network Role: Are they likely an Originating FI, Destination FI, or Beneficiary FI?`,
    `AXIS 6 — Regulatory Licenses: What licenses do they hold? (EMI, PI, MSB, VASP, MiCA CASP, PSD2, banking license) Which jurisdictions?`,
    `AXIS 7 — B2B Scale: Do they serve businesses (not retail)? Any employee count, revenue, or transaction volume signals?`,
    `AXIS 8 — Competitive Proximity: Are they a potential competitor to Plexo or clearly a client/partner?`,
    `HARD KILL CHECK: Is this company ONLY doing: RWA tokenization, DeFi without KYC, custody/trading only, consulting, payroll, retail on-ramp widget, or compliance SaaS? If yes, say HARD KILL and why.`,
    `STRATEGIC SIGNAL: Any recent signal (last 12 months) suggesting urgency — new funding, hiring payments/crypto roles, regulatory approval, expansion announcement?`,
  ].join(" ");
}

const parallelTaskSpec = {
  output_schema: {
    type: "json",
    json_schema: {
      type: "object",
      properties: {
        axis1_xborder_core:         { type: "string" },
        axis2_ramp:                 { type: "string" },
        axis3_stablecoin_alignment: { type: "string" },
        axis4_corridors:            { type: "string" },
        axis5_network_role:         { type: "string" },
        axis6_licenses:             { type: "string" },
        axis7_b2b_scale:            { type: "string" },
        axis8_competitive:          { type: "string" },
        hard_kill:                  { type: "string" },
        strategic_signal:           { type: "string" },
        sources:                    { type: "array", items: { type: "string" } },
      }
    }
  }
};

module.exports = {
  PARALLEL_KEY,
  parallelHeaders,
  buildResearchQuery,
  parallelTaskSpec,
};
