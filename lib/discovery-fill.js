/**
 * Discovery Card fill scoring — structural approach
 *
 * "Filled" = partner actually typed/checked something.
 * "Empty"  = only our pre-fill template content (placeholders, labels, boilerplate).
 *
 * Rules:
 *   to_do checked:true            → filled (partner ticked a checkbox)
 *   to_do checked:false           → empty  (unticked template checkbox)
 *   paragraph containing ___      → empty  (placeholder)
 *   paragraph that is a pure label (ends with ":", short) → empty
 *   paragraph matching known boilerplate phrases          → empty
 *   paragraph with real content (> 3 chars, no ___)      → filled
 *   table_row (non-header) with at least one real cell    → filled
 *   column/callout: recurse children
 */

"use strict";

// Known boilerplate phrases we pre-fill — these do NOT count as partner input.
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
  /^minimum data you need to receive/i,
  /^additional fields required/i,
  /^your aml screening process/i,
  /^what'?s not working well today/i,
  /^biggest single pain point/i,
  /^which plexo capabilities/i,
  /^what do you need from us/i,
  /^partners hub →/i,
  /^📄 read the tap protocol/i,
  /^🌐 partners hub/i,
  /^founding cohort · stablecoin/i,
  /^onboarding checklist/i,
  /^the tap protocol · regulatory/i,
  /^off-ramp: local fiat disbursement/i,
  /^where are you already strong/i,
  /^where do you need access/i,
  /^stablecoins you currently support/i,
  /^chains you operate on/i,
  /^cost structure:/i,
  /^onboarding model:/i,
  /^corridors you currently serve/i,
  /^on-ramp \/ off-ramp:/i,
  /^integration model:/i,
  /^annual volume last year/i,
  /^expected monthly volume/i,
  /^avg transaction size/i,
  /^min transaction size/i,
  /^max \/ daily limit/i,
  /^settlement speed:/i,
  /^business model:/i,
  /^licenses held/i,
  /^primary role/i,
  /^contact person:/i,
  /^title \/ role:/i,
  /^email:/i,
  /^phone:/i,
  /^country of incorporation:/i,
  /^company legal name:/i,
  /^travel rule solution/i,
  /^share this document with/i,
  /^review partners hub/i,
  /^sign mutual nda/i,
  /^fill in this discovery card/i,
  /^upload documents for kyb/i,
  /^review & sign msa/i,
  /^book demo call/i,
  /^read the tap protocol/i,
];

// Section heading patterns (heading_3 blocks in the card)
const SECTION_HEADING_PATTERNS = [
  /^\d+[a-z]?\.\s/i,  // "1. Partner Profile", "2b. Business Profile", etc.
  /^partner profile$/i,
  /^business profile$/i,
  /^client mix/i,
  /^stablecoins & chains/i,
  /^current corridors/i,
  /^desired corridors/i,
  /^compliance/i,
  /^challenges/i,
  /^areas of interest/i,
  /^questions.*plexo/i,
  /^network/i,
  /^interest$/i,
];

function isSectionHeading(text) {
  if (!text) return false;
  for (const p of SECTION_HEADING_PATTERNS) {
    if (p.test(text.trim())) return true;
  }
  return false;
}

function isBoilerplate(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  // Pure placeholder
  if (/^[_\-—–\s]+$/.test(t)) return true;
  if (/^n\/?a$/i.test(t)) return true;
  // Contains placeholder anywhere
  if (/_{3,}/.test(t)) return true;
  // Known boilerplate
  for (const p of BOILERPLATE_PATTERNS) {
    if (p.test(t)) return true;
  }
  // Pure label (ends with colon, ≤ 80 chars)
  if (t.endsWith(":") && t.length <= 80) return true;
  // Section heading
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

/**
 * Walk blocks recursively, count filled vs total "answer slots".
 * Returns { filled, total }
 */
function scoreBlocksFill(blocks) {
  let filled = 0;
  let total = 0;

  function walk(blist) {
    for (const b of blist) {
      const type = b.type;

      if (type === "to_do") {
        total++;
        if (b.checked) filled++;
        continue; // don't recurse into to_do children
      }

      if (type === "paragraph") {
        const t = (b.text || "").trim();
        if (!t) continue;           // blank — skip, don't count
        if (isBoilerplate(t)) continue; // template text — skip
        // Real paragraph
        total++;
        if (isFilledParagraph(t)) filled++;
        continue;
      }

      if (type === "table_row") {
        const cells = (b.cells || []);
        const nonEmpty = cells.filter(c => c && c.trim() && !/^[_\-—–]+$/.test(c.trim()));
        if (nonEmpty.length === 0) continue;
        // Skip header row: all cells look like title-case labels with no numbers
        const isHeader = nonEmpty.every(c => /^[A-Z]/.test(c.trim()) && c.trim().length < 50 && !/\d/.test(c));
        if (isHeader) continue;
        total++;
        const hasReal = nonEmpty.some(c => c.trim().length > 1);
        if (hasReal) filled++;
        continue;
      }

      // heading_3 / heading_2 / heading_1 — skip, just structural
      if (type.startsWith("heading_")) continue;

      // divider — skip
      if (type === "divider") continue;

      // For container types (callout, column_list, column, bulleted_list_item, etc.)
      // recurse into children
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

/**
 * Split top-level blocks into sections by heading_3.
 * Returns [ { name, blocks[] } ]
 */
function splitIntoSections(blocks) {
  const sections = [];
  let current = null;

  function processBlock(b) {
    const type = b.type;

    // heading_3 inside a callout — check children
    if (b.children && b.children.length > 0) {
      for (const child of b.children) {
        if ((child.type === "heading_3" || child.type === "heading_2") && isSectionHeading(child.text || "")) {
          // Start new section
          if (current) sections.push(current);
          current = { name: (child.text || "").trim(), blocks: [] };
          continue;
        }
        if (current) current.blocks.push(child);
        else {
          if (!sections.length) { current = { name: "pre", blocks: [] }; }
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

/**
 * Map raw section heading to canonical display name
 */
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

/**
 * Main entry point: score a Discovery Card's blocks.
 *
 * @param {Array} blocks  - output of fetchBlocksRecursive()
 * @returns {{ totalFilled, totalFields, fillPct, sections }}
 */
function scoreDiscoveryCard(blocks) {
  const rawSections = splitIntoSections(blocks);

  // Merge by canonical name
  const sectionMap = new Map();
  for (const sec of rawSections) {
    if (sec.name === "pre" || !sec.name) continue;
    const canonical = canonicalSectionName(sec.name);
    if (!sectionMap.has(canonical)) sectionMap.set(canonical, { name: canonical, blocks: [] });
    sectionMap.get(canonical).blocks.push(...sec.blocks);
  }

  let sections = [];
  if (sectionMap.size === 0) {
    // Fallback: score everything as one section
    const score = scoreBlocksFill(blocks);
    sections = score.total > 0
      ? [{ name: "All", filled: score.filled, total: score.total, fillPct: score.total > 0 ? Math.round(score.filled / score.total * 100) : 0 }]
      : [];
  } else {
    for (const [name, sec] of sectionMap) {
      const score = scoreBlocksFill(sec.blocks);
      if (score.total === 0) continue;
      sections.push({
        name,
        filled: score.filled,
        total: score.total,
        fillPct: score.total > 0 ? Math.round(score.filled / score.total * 100) : 0,
      });
    }
  }

  const totalFilled = sections.reduce((s, x) => s + x.filled, 0);
  const totalFields = sections.reduce((s, x) => s + x.total, 0);
  const fillPct = totalFields > 0 ? Math.round(totalFilled / totalFields * 100) : 0;

  return { totalFilled, totalFields, fillPct, sections };
}

module.exports = { scoreDiscoveryCard, isBoilerplate, isFilledParagraph };
