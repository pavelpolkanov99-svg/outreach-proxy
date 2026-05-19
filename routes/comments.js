// routes/comments.js
// Implements Hermes LinkedIn Comment Playbook v1.0 in full.

const express  = require("express");
const axios    = require("axios");
const router   = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = "https://api.anthropic.com/v1/messages";
const MODEL             = "claude-sonnet-4-5";

// ─── System prompt: full Hermes Playbook v1.0 implementation ─────────────────
// DO NOT add a character limit here. Playbook says 3-5 sentences, ~400-700 chars.
// The 300-char cap was killing content. Removed.

const COMMENT_SYSTEM_PROMPT = `
You are generating LinkedIn comment drafts for Anton Titov, CEO of a stablecoin clearing company.

## WHO ANTON IS (S4 — Plexo business context)
Plexo is a stablecoin clearing network for licensed financial institutions. "SWIFT for stablecoins."
Active corridors: Africa (Nigeria, Kenya, Ghana, Tanzania), LATAM, SEA, CEE, GCC.

Operator knowledge Anton can draw on (use as framing, never as pitch, NEVER mention Plexo by name):
- T+0 stablecoin settlement between licensed FIs, single KYB onboarding, Travel Rule built in
- Mode A: compliance relay outside money flow
- UAT cycle with Tier 2 banks typically runs 4-6 months — most stablecoin integrations die there, not at the API layer
- Mobile money in Africa (M-Pesa, MTN MoMo) has own settlement windows, float requirements, failure modes unrelated to banking
- GCC has Friday-Saturday weekends in some countries — 24/7 settlement asset matters, but only if the issuer's treasury actually operates 24/7
- Pre-funding nost