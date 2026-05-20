/**
 * Discovery Card fill scoring — structural approach v3
 *
 * "Filled" = partner actually typed/checked something NEW.
 * "Empty"  = only our pre-fill template content.
 *
 * Rules:
 *   to_do checked:true                               → filled
 *   to_do checked:false                              → empty
 *   paragraph containing ___                         → empty
 *   paragraph matching known boilerplate phrase      → empty
 *   paragraph starting with known field label + ":"  → empty (our pre-fill)
 *   standalone stablecoin/chain name                 → empty (our pre-fill)
 *   paragraph with real partner content              → filled
 *   table_row: filled only if cells[1..] have data   → first cell is always our label
 */

"use strict";

// ── Known field label prefixes (we pre-fill these as "Label: ___") ─────────────
const FIELD_LABEL_PATTERNS = [
  /^company legal name\s*:/i,
  /^country of incorporation\s*:/i,
  /^website\s*:/i,
  /^founded\s*:/i,
  /^contact person\s*:/i,
  /^title\s*\/\s*role\s*:/i,
  /^email\s*:/i,
  /^phone\s*:/i,
  /^telegram\s*\/?s*whatsapp\s*:/i,
  /^licenses held/i,
  /^primary role/i,
  /^business description\s*(\(.*?\))?\s*:/i,
  /^annual volume last year/i,
  /^expected monthly volume/i,
  /^avg transaction size/i,
  /^min transaction size/i,
  /^max\s*\/\s*daily limit/i,
  /^settlement speed\s*:/i,
  /^business model\s*:/i,
  /^on-ramp\s*\/\s*off-ramp\s*:/i,
  /^integration model\s*:/i,
  /^off-ramp\s*:/i,
  /^cost structure\s*:/i,
  /^onboarding model\s*:/i,
  /^corridors you currently serve/i,
  /^stablecoins you currently support/i,
  /^chains you operate on/i,
  /^other stablecoins\s*:/i,
  /^travel rule solution/i,
  /^minimum data you need/i,
  /^additional fields required/i,
  /^your aml screening process/i,
  /^biggest single pain point/i,
  /^which plexo capabilities/i,
  /^what do you need from us/i,
];

// ── Known boilerplate prose blocks ────────────────────────────────────────────
const BOILERPLATE_PATTERNS = [
  /^we['']re inviting you/i,
  /^founding partners get/i,
  /^your gateway to the network/i,
  /^we have authored the tap protocol/i,
  /^why it matters to you/i,
  /^draft version/i,
  /^company identity, key contact/i,
  /^additional business details/i,
  /^helps us understand the composition/i,
  /^which stablecoins and blockchains/i,
  /^where you already move money/i,
  /^where you want to move money/i,
  /^what originator\/beneficiary data/i,
  /^what'?s not working well today/i,
  /^partners hub →/i,
  /^📄 read the tap protocol/i,
  /^🌐 partners hub/i,
  /^founding cohort · stablecoin/i,
  /^onboarding checklist/i,
  /^the tap protocol · regulatory/i,
  /^off-ramp: local fiat disbursement/i,
  /^where are you already strong/i,
  /^where do you need access/i,
  /^share this document with/i,
  /^review partners hub/i,
  /^sign mutual nda/i,
  /^fill in this discovery card/i,
  /^upload documents for kyb/i,
  /^review & sign msa/i,
  /^book demo call/i,
  /^read the tap protocol/i,
  /^what the company does/i,
  // Stablecoin names as standalone paragraphs (our pre-fill column headers)
  /^(usdt|usdc|eurc|eure|usde|dai|pyusd|busd|tusd|usdp)$/i,
  // Chain names as standalone paragraphs (our pre-fill)
  /^(tron|ethereum|polygon|base|solana|bnb chain|arbitrum|gnosis chain|optimism|avalanche)$/i,
];

// ── Section heading patterns ──────────────────────────────────────────────────
const SECTION_HEADING_PATTERNS = [
  /^\d+[a-z]?\.\s/i,
  /^partner profile$/i,
  /^business profile$/i,
  /^client mix/i,
  /^stablecoins & chains$/i,
  /^current corridors$/i,
  /^desired corridors$/i,
  /^compliance/i,
  /^challenges/i,
  /^areas of interest/i,
  /^questions.*plexo/i,
  /^network/i,
  /^interest$/i,
  /^current capabilities$/i,
];

function isSectionHeading(text) {
  if (!text) return false;
  const t = text.trim();
  for (const p of SECTION_HEADING_PATTERNS) {
    if (p.test(t)) return true;
  }
  return false;
}

function isBoilerplate(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (/^[_\-—–\s]+$/.test(t)) return true;
  if (/^n\/?a$/i.test(t)) return true;
  if (/_{3,}/.test(t)) return true;
  for (const p of FIELD_LABEL_PATTERNS) {
    if (p.test(t)) return true;
  }
  for (const p of BOILERPLATE_PATTERNS) {
    if (p.test(t)) return true;
  }
  if (t.endsWith(":") && t.length <= 80) return true;
  if (isSectionHeading(t)) return true;
  return false;
}

function isFilledParagraph(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t || t.length < 4) return false;
  if (isBoilerplate(t)) return false;
  return true;
}

// ── Block scoring ─────────────────────────────────────────────────────────────

function scoreBlocksFill(blocks) {
  let filled = 0;
  let total = 0;

  function walk(blist) {
    for (const b of blist) {
      const type = b.type;

      if (type === "to_do") {
        total++;
        if (b.checked) filled++;
        continue;
      }

      if (type === "paragraph") {
        const t = (b.text || "").trim();
        if (!t) continue;
        if (isBoilerplate(t)) continue;
        total++;
        if (isFilledParagraph(t)) filled++;
        continue;
      }

      if (type === "table_row") {
        const cells = b.cells || [];
        if (cells.length === 0) continue;

        // Skip header row: first cell title-case, no digits
        const firstCell = (cells[0] || "").trim();
        const isHeader = firstCell.length > 0 &&
          /^[A-Z]/.test(firstCell) &&
          firstCell.length < 60 &&
          !/\d/.test(firstCell) &&
          cells.slice(1).every(c => !c || !c.trim());
        if (isHeader) continue;

        // Data row: filled only if cells[1..] (partner-editable columns) have content
        // cells[0] is always our row label (e.g. "SME / Business Payments")
        const dataCells = cells.slice(1);
        if (dataCells.length === 0) continue;
        const hasData = dataCells.some(c => c && c.trim() && !/^[_\-—–]+$/.test(c.trim()));
        total++;
        if (hasData) filled++;
        continue;
      }

      if (type.startsWith("heading_")) continue;
      if (type === "divider") continue;

      if (b.children && b.children.length > 0) {
        const sub = scoreBlocksFill(b.children);
        filled += sub.filled;
        total += sub.total;
      }
    }
  }

  walk(blocks);
  return { filled, total };
}

// ── Section splitting ─────────────────────────────────────────────────────────

function splitIntoSections(blocks) {
  const sections = [];
  let current = null;

  function processBlock(b) {
    const type = b.type;

    if (b.children && b.children.length > 0) {
      for (const child of b.children) {
        if ((child.type === "heading_3" || child.type === "heading_2") && isSectionHeading(child.text || "")) {
          if (current) sections.push(current);
          current = { name: (child.text || "").trim(), blocks: [] };
          continue;
        }
        if (current) current.blocks.push(child);
        else {
          if (!sections.length) current = { name: "pre", blocks: [] };
          if (current) current.blocks.push(child);
        }
      }
      return;
    }

    if ((type === "heading_3" || type === "heading_2") && isSectionHeading(b.text || "")) {
      if (current) sections.push(current);
      current = { name: (b.text || "").trim(), blocks: [] };
      return;
    }

    if (current) current.blocks.push(b);
  }

  for (const b of blocks) processBlock(b);
  if (current && current.blocks.length > 0) sections.push(current);

  return sections;
}

function canonicalSectionName(heading) {
  if (!heading) return heading;
  const h = heading.trim();
  if (/partner profile/i.test(h)) return "Partner Profile";
  if (/business profile/i.test(h) && !/client/i.test(h)) return "Business Profile";
  if (/client mix|volume breakdown/i.test(h)) return "Client Mix & Volume";
  if (/stablecoins|chains/i.test(h)) return "Stablecoins & Chains";
  if (/current corridors/i.test(h)) return "Current Corridors";
  if (/desired corridors/i.test(h)) return "Desired Corridors";
  if (/compliance|data requirements/i.test(h)) return "Compliance";
  if (/challenges|pain points/i.test(h)) return "Challenges";
  if (/areas of interest|^9\.\s*interest/i.test(h)) return "Areas of Interest";
  if (/questions.*plexo|requirements.*plexo/i.test(h)) return "Questions for Plexo";
  if (/network|counterpart/i.test(h)) return "Network";
  if (/current capabilities/i.test(h)) return "Current Capabilities";
  return h.replace(/^\d+[a-z]?\.\s*/i, "").trim();
}

// ── Main entry point ──────────────────────────────────────────────────────────

function scoreDiscoveryCard(blocks) {
  const rawSections = splitIntoSections(blocks);

  const sectionMap = new Map();
  for (const sec of rawSections) {
    if (sec.name === "pre" || !sec.name) continue;
    const canonical = canonicalSectionName(sec.name);
    if (!sectionMap.has(canonical)) sectionMap.set(canonical, { name: canonical, blocks: [] });
    sectionMap.get(canonical).blocks.push(...sec.blocks);
  }

  let sections = [];
  if (sectionMap.size === 0) {
    const score = scoreBlocksFill(blocks);
    sections = score.total > 0
      ? [{ name: "All", filled: score.filled, total: score.total, fillPct: Math.round(score.filled / score.total * 100) }]
      : [];
  } else {
    for (const [name, sec] of sectionMap) {
      const score = scoreBlocksFill(sec.blocks);
      if (score.total === 0) continue;
      sections.push({
        name,
        filled: score.filled,
        total: score.total,
        fillPct: Math.round(score.filled / score.total * 100),
      });
    }
  }

  const totalFilled = sections.reduce((s, x) => s + x.filled, 0);
  const totalFields = sections.reduce((s, x) => s + x.total, 0);
  const fillPct = totalFields > 0 ? Math.round(totalFilled / totalFields * 100) : 0;

  return { totalFilled, totalFields, fillPct, sections };
}

module.exports = { scoreDiscoveryCard, isBoilerplate, isFilledParagraph };
