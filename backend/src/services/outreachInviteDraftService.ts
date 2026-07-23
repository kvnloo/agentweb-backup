/**
 * LLM-backed onboarding outreach invite drafting.
 *
 * This is the service that makes the admin-editable prompt real: the system
 * prompt the model is composed with is READ FROM THE DB ROW an admin edits in
 * the partner-portal "Prompt Templates" tab (AC #3). Editing it changes the
 * invites users see on their next visit to the outreach step — no deploy.
 *
 * Guardrails are enforced HERE, not delegated to the prompt. An admin can
 * rewrite the system prompt to say anything, and a model can ignore it either
 * way, so the account's invite char limit and the no-emoji rule (AC #2) are
 * applied to every message after generation. The prompt asks; this code
 * enforces — using the same trim helper as the real LinkedIn send path.
 *
 * Never throws. The onboarding drafts step pre-fills instantly from templates
 * on the frontend and merely *upgrades* to these drafts when they land, so a
 * Bedrock outage or a malformed response must degrade to "no upgrade", never
 * to a broken step. Every failure path returns `{ drafts: [] }`.
 *
 * Model: same Bedrock Claude alias the other onboarding copy steps use.
 */

import { LLMService } from "../utils/llmService";
import { LinkedInOutreachService } from "./linkedInOutreachService";
import { getOutreachInvitePrompt } from "./outreachInvitePromptService";

/** Same family as the other onboarding copy steps. */
const INVITE_MODEL = "anthropic.claude-sonnet-4-6";
/** Invites are short; keep variety but stay tight. */
const INVITE_TEMPERATURE = 0.7;
const INVITE_MAX_TOKENS = 2048;

/**
 * Invite-note length is a PER-ACCOUNT limit, not a constant: LinkedIn allows
 * 300 chars on a Premium account and 200 on a free one. We default to the free
 * limit so we never over-promise capacity — drafting to 300 for a free account
 * means the note the user reviewed and approved gets silently trimmed at send
 * time by `LinkedInOutreachService.trimInviteMessage`, which is exactly the
 * mismatch this default avoids.
 */
export const DEFAULT_INVITE_CHAR_LIMIT =
  LinkedInOutreachService.INVITE_MESSAGE_MAX_CHARS_FREE;

/** LinkedIn's absolute ceiling, regardless of what a caller asks for. */
const MAX_INVITE_CHAR_LIMIT = LinkedInOutreachService.INVITE_MESSAGE_MAX_CHARS;

/** Keep a caller-supplied limit inside [1, LinkedIn max]. */
function clampCharLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_INVITE_CHAR_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_INVITE_CHAR_LIMIT);
}

/**
 * Emoji / pictograph stripper. Mirrors the frontend's `stripEmojis` in
 * `useOutreachDrafts.ts` — keep the two in sync. Deliberately does NOT touch
 * plain typographic marks like an em dash or an arrow.
 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Apply the rules the model is asked for but cannot be trusted to keep: strip
 * emojis, collapse the whitespace that leaves behind, and trim to the account's
 * char limit.
 *
 * Trimming delegates to `LinkedInOutreachService.trimInviteMessage` — the same
 * helper the actual send path uses — so a draft is cut on a sentence or word
 * boundary rather than mid-word, and never leaves a dangling UTF-16 surrogate.
 */
export function sanitizeInvite(
  input: string,
  charLimit: number = DEFAULT_INVITE_CHAR_LIMIT,
): string {
  const cleaned = input
    .replace(EMOJI_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return LinkedInOutreachService.trimInviteMessage(
    cleaned,
    clampCharLimit(charLimit),
  );
}

export interface InviteProspect {
  id: string;
  name?: string;
  company?: string;
  title?: string;
}

export interface InviteDraftContext {
  /** The sender's brand, from the brand-setup step. */
  brandName?: string;
  /** The chosen ICP cohort. */
  icpName?: string;
  /** Free-text targeting specifics the user typed. */
  specs?: string;
  /**
   * Invite-note char limit for the account that will send these: 300 for a
   * Premium LinkedIn account, 200 for a free one. Defaults to the free limit.
   */
  charLimit?: number;
}

export interface InviteDraft {
  prospectId: string;
  message: string;
}

export interface InviteDraftResult {
  drafts: InviteDraft[];
  /** Version of the admin prompt row these were composed with. */
  promptVersion: string;
  /**
   * The char limit actually applied. Returned so the frontend can render the
   * same budget in its counter instead of assuming 300.
   */
  charLimit: number;
}

/** Minimal seam so tests (and future callers) can inject a fake model. */
interface InviteLlm {
  generateJsonRobust: <T = any>(
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<T>;
}

/** What we ask the model to return. */
interface LlmDraftsResponse {
  drafts?: Array<{ prospectId?: unknown; message?: unknown }>;
}

/**
 * Appended to the admin's prompt. The admin owns tone and content; these are
 * the structural requirements the response must satisfy to be usable at all,
 * so they are not left to the editable text.
 */
function buildSystemPrompt(adminPrompt: string, charLimit: number): string {
  return [
    adminPrompt.trim(),
    "",
    "Return ONLY valid JSON of the form:",
    '{"drafts":[{"prospectId":"<id>","message":"<invite>"}]}',
    "Write exactly one entry per prospect, reusing the prospectId given to you.",
    `Every message must be plain text, under ${charLimit} characters, and contain no emojis.`,
  ].join("\n");
}

/**
 * Per-field input caps. A LinkedIn invite is short and these fields are just
 * personalization hints, so the model needs nowhere near a full name/company of
 * unbounded length. Capping every field before it reaches the prompt bounds the
 * input-token cost of the endpoint: without it an authenticated caller could
 * POST 50 prospects (the batch cap) each carrying megabytes of text and drive
 * arbitrarily large — and expensive — Bedrock requests.
 */
const FIELD_CAPS = {
  brand: 120,
  icp: 200,
  specs: 500,
  name: 120,
  company: 120,
  title: 120,
} as const;

/** Trim, then hard-cap a field's length so one caller can't inflate the prompt. */
function capField(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function buildUserPrompt(
  prospects: InviteProspect[],
  ctx: InviteDraftContext,
): string {
  const lines: string[] = [];
  const brand = capField(ctx.brandName, FIELD_CAPS.brand);
  const icp = capField(ctx.icpName, FIELD_CAPS.icp);
  const specs = capField(ctx.specs, FIELD_CAPS.specs);

  lines.push("Sender context:");
  lines.push(`- Brand: ${brand || "(not provided)"}`);
  lines.push(`- Audience (ICP): ${icp || "(not provided)"}`);
  lines.push(`- Targeting specifics: ${specs || "(not provided)"}`);
  lines.push("");
  lines.push("Write one LinkedIn connection request per prospect below.");
  lines.push("Personalize each one; do not reuse the same sentence twice.");
  lines.push("");
  lines.push("Prospects:");
  for (const p of prospects) {
    const bits = [
      `prospectId: ${p.id}`,
      `name: ${capField(p.name, FIELD_CAPS.name) || "(unknown)"}`,
    ];
    const company = capField(p.company, FIELD_CAPS.company);
    const title = capField(p.title, FIELD_CAPS.title);
    if (company) bits.push(`company: ${company}`);
    if (title) bits.push(`title: ${title}`);
    lines.push(`- ${bits.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Draft one invite per prospect using the admin-editable system prompt.
 *
 * Resolves to `{ drafts: [] }` on every failure path (LLM error, malformed
 * response, no prospects) — callers treat an empty list as "keep whatever the
 * frontend already generated".
 */
export async function generateInviteDrafts(
  prospects: InviteProspect[],
  ctx: InviteDraftContext,
  deps: { llm?: InviteLlm } = {},
): Promise<InviteDraftResult> {
  const row = await getOutreachInvitePrompt();
  const charLimit = clampCharLimit(ctx.charLimit);

  if (!Array.isArray(prospects) || prospects.length === 0) {
    return { drafts: [], promptVersion: row.version, charLimit };
  }

  const llm =
    deps.llm ??
    new LLMService(INVITE_MODEL, INVITE_TEMPERATURE, INVITE_MAX_TOKENS);

  let raw: LlmDraftsResponse;
  try {
    raw = await llm.generateJsonRobust<LlmDraftsResponse>(
      buildSystemPrompt(row.systemPrompt, charLimit),
      buildUserPrompt(prospects, ctx),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[outreachInviteDraftService] generation failed", {
      error: err instanceof Error ? err.message : String(err),
      prospects: prospects.length,
    });
    return { drafts: [], promptVersion: row.version, charLimit };
  }

  if (!raw || !Array.isArray(raw.drafts)) {
    // eslint-disable-next-line no-console
    console.warn("[outreachInviteDraftService] malformed model response");
    return { drafts: [], promptVersion: row.version, charLimit };
  }

  // Only accept ids we asked for — a model can invent prospects.
  const requested = new Set(prospects.map((p) => p.id));
  const seen = new Set<string>();
  const drafts: InviteDraft[] = [];

  for (const entry of raw.drafts) {
    const prospectId = entry?.prospectId;
    const message = entry?.message;
    if (typeof prospectId !== "string" || typeof message !== "string") continue;
    if (!requested.has(prospectId) || seen.has(prospectId)) continue;

    const clean = sanitizeInvite(message, charLimit);
    if (clean.length === 0) continue; // never hand back a blank textarea

    seen.add(prospectId);
    drafts.push({ prospectId, message: clean });
  }

  return { drafts, promptVersion: row.version, charLimit };
}
