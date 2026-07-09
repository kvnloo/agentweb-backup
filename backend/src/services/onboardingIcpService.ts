/**
 * Onboarding Epic Phase 2 — ICP discovery service.
 *
 * Step 2 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * Mirrors the per-axis onboarding service pattern: pure LLM call exported for
 * unit-testing, plus a fire-and-forget orchestrator that patches the User
 * record's per-axis state machine on the way in (`running`) and out
 * (`ready` | `failed`).
 *
 * Flow the route layer orchestrates:
 *   1. POST /api/onboarding/icp/start
 *   2. Route flips `icpStatus → running` via icpStartPatch.
 *   3. Route calls `startIcpDiscoveryForUser(userId)` (background work).
 *   4. Route returns the running snapshot to the UI.
 *   5. Background: read brand context → call Claude Sonnet-4-6 → patch
 *      User with `icpReadyPatch(personas)` or `icpFailedPatch(error)`.
 *
 * The system prompt is the verbatim Step 2 description from the prod work
 * plan. Do NOT rewrite it locally — if Step 2 changes, update the prod plan
 * via `manage_predefined_work_plan` and re-pull. The unit test asserts the
 * prompt contains a distinctive phrase from the prod copy.
 */

import { LLMService } from "../utils/llmService";
import { reportUIError } from "../utils/errorReporter";
import { getGCSPPrivateKey } from "../utils/secretsManager";
import { getS3ObjectAsString } from "../utils/s3Utils";
import { taskDb, userDb } from "./db";
import { Storage } from "@google-cloud/storage";
import {
  icpFailedPatch,
  icpReadyPatch,
  icpStartPatch,
  ICPPersona,
  ICP_PERSONA_FIELD_NAMES,
  ensurePersonaIds,
  MAX_ICP_PERSONAS,
  sanitizeICPPersonas,
} from "./icpStatusService";

/** Bedrock model alias. Matches the rest of the onboarding-v2 flow. */
const ICP_MODEL = "anthropic.claude-sonnet-4-6";

/** Slightly conservative temperature — ICP personas should be specific, not creative drift. */
const ICP_TEMPERATURE = 0.7;

/** Token budget for 5 personas × ~6 fields each + meta brief. */
const ICP_MAX_TOKENS = 4000;
const MAX_STRATEGIC_CONTEXT_CHARS = 6000;
const MAX_KB_CONTEXT_FILES = 3;
const S3_KEY_PREFIX = "s3:";

let gcsStorage: Storage | null = null;

/**
 * Delay before firing the cascade trigger to the competitor step after
 * persisting `icpStatus: 'ready'`. Lets the UserIdIndex GSI propagate
 * the just-written row so the competitor service's gate read sees
 * `icpStatus === 'ready'` instead of stale `running`. 2s is generous —
 * DynamoDB GSI propagation is typically <1s in us-west-2.
 *
 * Override to 0 in tests via `process.env.CASCADE_TRIGGER_DELAY_MS=0`
 * so unit assertions can fire synchronously.
 */
export const CASCADE_TRIGGER_DELAY_MS =
  process.env.CASCADE_TRIGGER_DELAY_MS !== undefined
    ? Number(process.env.CASCADE_TRIGGER_DELAY_MS)
    : 2_000;

/**
 * Step 2 system prompt — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[1].description. Sourced via
 * `aws dynamodb get-item --table-name AW-WorkPlans --key '{"planId":{"S":"plan_1768351741814_jgc2wwlxa"}}'`.
 *
 * We append a strict JSON-output contract because we're calling Claude
 * directly (no agent loop / function calls), but the descriptive content
 * of the prompt itself is unchanged.
 */
export const ICP_DISCOVERY_SYSTEM_PROMPT = [
  "Show each of the Ideal Customer Profiles (ICP) and persona in the Market Strategy Section, provide the following description on three elements. Each consists of 1 sentence, short and to-the-point:",
  "- List out up to 5 distinct ICPs with illustrative avatars (emoji-based, gradient colors)",
  "- Firmographics: Company size, revenue, industry, geography",
  "- Psychographics: Goals, fears, values",
  "- Key Personas per ICP with motivations",
  "- Expandable cards for each ICP",
  "Ask the user to verify the output. Update their comments to the Market Strategy Section as needed.",
  "IF there is no Brand Guideline or Market Strategy setup, then redirect user to complete the Onboarding Workflow.",
  "",
  "OUTPUT CONTRACT — return ONLY valid JSON matching this exact shape:",
  "{",
  '  "icps": [',
  '    { "name": "...", "pain": "...", "desire": "...", "objection": "...", "meta_targeting_brief": "..." }',
  "  ]",
  "}",
  "Return up to 5 ICPs. Each field is one short sentence. No markdown, no commentary.",
].join("\n");

/**
 * Brand context projected from the User record. All optional — early
 * onboarding may have only a subset populated.
 */
export interface IcpBrandContext {
  companyName?: string;
  companyUrl?: string;
  tagline?: string;
  toneOfVoice?: string;
  valueProposition?: string;
  targetAudience?: string;
  strategicContext?: string;
}

interface LlmResponse {
  icps: unknown;
}

/**
 * Project the IcpBrandContext from the persisted User record. Tolerant of
 * partial data — every field is optional.
 */
export function extractIcpBrandContext(user: {
  companyName?: string;
  productDomain?: string;
  brandGuidelines?: {
    brandData?: {
      brandName?: string;
      tagline?: string;
      domain?: string;
      toneOfVoice?: string;
      valueProposition?: string;
      targetAudience?: string;
    };
  };
  onboardingStrategicContext?: string;
  onboardingIcpContext?: string;
  strategicContext?: string;
}): IcpBrandContext {
  const bd = user.brandGuidelines?.brandData || {};
  const ctx: IcpBrandContext = {};
  const companyName = bd.brandName || user.companyName;
  if (companyName) ctx.companyName = companyName;
  const companyUrl = bd.domain || user.productDomain;
  if (companyUrl) ctx.companyUrl = companyUrl;
  if (bd.tagline) ctx.tagline = bd.tagline;
  if (bd.toneOfVoice) ctx.toneOfVoice = bd.toneOfVoice;
  if (bd.valueProposition) ctx.valueProposition = bd.valueProposition;
  if (bd.targetAudience) ctx.targetAudience = bd.targetAudience;
  const strategicContext =
    user.onboardingStrategicContext || user.onboardingIcpContext || user.strategicContext;
  if (typeof strategicContext === "string" && strategicContext.trim()) {
    ctx.strategicContext = strategicContext.trim().slice(0, MAX_STRATEGIC_CONTEXT_CHARS);
  }
  return ctx;
}

function buildUserPrompt(brand: IcpBrandContext): string {
  const lines: string[] = [
    "Generate up to 5 distinct Ideal Customer Profiles (ICPs) for:",
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.tagline) lines.push(`Tagline: ${brand.tagline}`);
  if (brand.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (brand.targetAudience)
    lines.push(`Target audience hint: ${brand.targetAudience}`);
  if (brand.toneOfVoice) lines.push(`Tone of voice: ${brand.toneOfVoice}`);
  if (brand.strategicContext) {
    lines.push("");
    lines.push("Strategic context from user-provided onboarding docs/notes:");
    lines.push(brand.strategicContext);
  }
  lines.push("");
  lines.push(
    "Before generating ICPs, infer the go-to-market sequence from the context: supply-side providers/partners first, demand-side buyers first, or both. If the context says supply/provider/capacity/network partners come first, generate ICPs for those providers first; do not default to generic founders, finance buyers, or end users.",
  );
  lines.push(
    "For each ICP, capture: name (evocative), pain (one sentence), desire (one sentence), objection (one sentence), meta_targeting_brief (one sentence summarising who to target on Meta).",
  );
  lines.push("Return JSON matching the schema in the system prompt.");
  return lines.join("\n");
}

function isReadableContextFile(file: any): boolean {
  const name = String(file?.filename || file?.name || "").toLowerCase();
  const key = String(file?.key || "").toLowerCase();
  const source = `${name} ${key}`;
  return /\.(txt|md|markdown|csv)$/.test(source);
}

function normalizeContextText(text: string): string {
  return text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function appendBoundedContext(parts: string[], next: string, maxChars: number): void {
  const normalized = normalizeContextText(next);
  if (!normalized) return;
  const used = parts.join("\n\n").length;
  const remaining = maxChars - used;
  if (remaining <= 0) return;
  parts.push(normalized.slice(0, remaining));
}

async function getGcsStorage(): Promise<Storage> {
  if (!gcsStorage) {
    const privateKey = await getGCSPPrivateKey();
    gcsStorage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey,
      },
    });
  }
  return gcsStorage;
}

async function readKnowledgeBaseFileText(
  task: any,
  file: any,
): Promise<string | null> {
  if (typeof file?.searchableText === "string" && file.searchableText.trim()) {
    return file.searchableText;
  }

  const key = typeof file?.key === "string" ? file.key : "";
  if (!key) return null;

  try {
    if (key.startsWith(S3_KEY_PREFIX)) {
      return await getS3ObjectAsString(key.slice(S3_KEY_PREFIX.length));
    }

    const storage = await getGcsStorage();
    const bucketName =
      task?.knowledgeBaseType === "public"
        ? process.env.GCS_BUCKET_NAME || "agentweb-knowledge-base-dev"
        : process.env.GCS_BUCKET_NAME_PRIVATE || "agentweb-knowledge-base-private-dev";
    const bucket = storage.bucket(bucketName);
    const [content] = await bucket.file(key).download();
    return content.toString("utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[onboardingIcpService] could not read KB context file", {
      taskId: task?.taskId,
      filename: file?.filename,
      err: msg,
    });
    return null;
  }
}

export async function loadOnboardingStrategicContextForUser(
  userId: string,
): Promise<string | null> {
  try {
    const tasks = await taskDb.getTasksWithKnowledgeBase(userId);
    if (!Array.isArray(tasks) || tasks.length === 0) return null;

    const preferredTasks = [...tasks].sort((a: any, b: any) => {
      const aName = String(a?.name || "").toLowerCase();
      const bName = String(b?.name || "").toLowerCase();
      const aScore = aName.includes("brand") || aName.includes("onboarding") ? 0 : 1;
      const bScore = bName.includes("brand") || bName.includes("onboarding") ? 0 : 1;
      return aScore - bScore;
    });

    const parts: string[] = [];
    let filesRead = 0;
    for (const task of preferredTasks) {
      const files = Array.isArray(task?.knowledgeBaseFiles)
        ? [...task.knowledgeBaseFiles]
        : [];
      files.sort((a: any, b: any) =>
        String(b?.uploadedAt || "").localeCompare(String(a?.uploadedAt || "")),
      );

      for (const file of files) {
        if (filesRead >= MAX_KB_CONTEXT_FILES) break;
        if (!isReadableContextFile(file)) continue;
        const text = await readKnowledgeBaseFileText(task, file);
        if (!text) continue;
        appendBoundedContext(
          parts,
          `Source: ${file.filename || file.name || file.key}\n${text}`,
          MAX_STRATEGIC_CONTEXT_CHARS,
        );
        filesRead += 1;
      }
      if (filesRead >= MAX_KB_CONTEXT_FILES || parts.join("\n\n").length >= MAX_STRATEGIC_CONTEXT_CHARS) {
        break;
      }
    }

    const context = parts.join("\n\n").trim();
    return context || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[onboardingIcpService] could not load onboarding KB context", {
      userId,
      err: msg,
    });
    return null;
  }
}

/**
 * Inverse of `mapMarketIcpToResult` in `onboardingBrandBuildService.ts`.
 * Mirrors the v2 onboarding ICP result back to `User.marketStrategy.icp[]`
 * shape so the rest of the product (Agent Mode, chatbot, etc.) sees the
 * ICPs the onboarding flow generated.
 *
 * Without this mirror, v2 onboarding writes to `User.icpResult` only and
 * `marketStrategy.icp[]` stays empty — the user finishes onboarding with
 * an apparently-blank market strategy. See agentweb-customer-portal#687
 * companion fix for value-prop hydration; this fixes the ICP half.
 *
 * Exported for unit testing.
 */
export function mapIcpResultToMarketStrategy(
  personas: ICPPersona[],
): Array<{
  title: string;
  description: string;
  valueProposition: string;
  buyerPersonas: string[];
}> {
  if (!Array.isArray(personas)) return [];
  return personas.map((p) => ({
    title: typeof p.name === "string" ? p.name : "",
    description: typeof p.pain === "string" ? p.pain : "",
    valueProposition: typeof p.desire === "string" ? p.desire : "",
    buyerPersonas: typeof p.meta_targeting_brief === "string" && p.meta_targeting_brief
      ? [p.meta_targeting_brief]
      : [],
  }));
}

/**
 * Merge the freshly-generated ICPs into `User.marketStrategy.icp[]`,
 * preserving whatever else (competitors, businessOverview, etc.) is
 * already on the record. Best-effort: errors are logged but do NOT roll
 * back the icpResult write — the user still gets ICPs in the onboarding
 * review flow, the rest of the product just won't see them until the
 * next time something touches marketStrategy.
 *
 * Read-merge-write done in this single function to keep the call-site
 * tidy. The eventual-consistency window we already navigated for the
 * cascade trigger doesn't apply here — we're writing to the base table
 * by email via updateUser, which is strongly consistent.
 */
async function mirrorIcpsToMarketStrategy(
  userId: string,
  personas: ICPPersona[],
): Promise<void> {
  try {
    const fresh: any = await userDb.getUserById(userId);
    if (!fresh) return;
    const now = new Date().toISOString();
    const existing = (fresh.marketStrategy ?? {}) as {
      businessOverview?: string;
      competitors?: Array<{ name: string; description: string }>;
      icp?: Array<{
        title: string;
        description: string;
        valueProposition: string;
        buyerPersonas: string[];
      }>;
      createdAt?: string;
      updatedAt?: string;
    };
    const merged = {
      businessOverview: existing.businessOverview ?? "",
      competitors: existing.competitors ?? [],
      icp: mapIcpResultToMarketStrategy(personas),
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    await userDb.updateUser(userId, { marketStrategy: merged } as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[onboardingIcpService] mirror to marketStrategy failed",
      { userId, err: msg },
    );
    // Non-fatal: don't fire reportUIError here either, this is best-effort
    // backfill — the primary icpResult write already succeeded.
  }
}

/**
 * Pure LLM call — exported for unit-testing with an injected LLMService.
 *
 * Uses `generateJsonRobust` (not `generateJSONContent`) so a stray prose
 * preamble in the model's response no longer cascade-fails the entire
 * Phase 4 ad-gen pipeline. See `services/util/extractJson.ts`.
 */
export async function generateIcpsForUser(
  brand: IcpBrandContext,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
  userId?: string,
): Promise<ICPPersona[]> {
  const llm =
    deps.llm ?? new LLMService(ICP_MODEL, ICP_TEMPERATURE, ICP_MAX_TOKENS);
  const system = ICP_DISCOVERY_SYSTEM_PROMPT;
  const user = buildUserPrompt(brand);
  // Shadow usage metering attribution only — no behavior change.
  const raw = await llm.generateJsonRobust<LlmResponse>(system, user, undefined, {
    userId,
    feature: 'onboarding',
  });
  if (!raw || !Array.isArray((raw as LlmResponse).icps)) {
    throw new Error("LLM returned no icps");
  }
  // Use the same sanitiser the route layer uses on /complete bodies — keeps
  // the persistence shape consistent regardless of which path wrote it.
  return ensurePersonaIds(sanitizeICPPersonas(raw.icps).slice(0, MAX_ICP_PERSONAS));
}

/**
 * Read the User record strongly-consistently when we can.
 *
 * `getUserById` queries the `UserIdIndex` GSI, which is eventually consistent.
 * The FE fires `/icp/edit-one` and `/icp/regenerate-one` a second apart (see
 * the ENG-255 access log), so a GSI read can miss the edit anchor entirely and
 * regenerate from pre-edit text. The base table is keyed by email, so we
 * resolve the id first, then re-read consistently. Falls back to the GSI row
 * if the consistent read is unavailable or misses.
 */
async function readUserForRegeneration(userId: string): Promise<any> {
  const viaIndex: any = await userDb.getUserById(userId);
  const consistentRead = (userDb as any).getUserByEmailConsistent;
  if (!viaIndex?.email || typeof consistentRead !== "function") return viaIndex;
  try {
    return (await consistentRead.call(userDb, viaIndex.email)) ?? viaIndex;
  } catch {
    return viaIndex;
  }
}

/** True when the user has hand-written at least one field of this persona. */
function hasAnchor(persona: ICPPersona | undefined): boolean {
  return Boolean(
    persona?.userIntent && Object.keys(persona.userIntent).length > 0,
  );
}

/**
 * Overlay the user's anchored fields back onto a freshly generated persona.
 * The model is asked to honour them, but we do not trust it to: the anchor is
 * the user's text and it wins. Carries the anchor forward so the next
 * regeneration is driven from the user's words again, never from generated
 * output (no drift across repeated regenerations).
 */
function applyAnchor(fresh: ICPPersona, previous: ICPPersona): ICPPersona {
  // Same card, new content: the FE's per-card spinner and removed-set are
  // keyed on this id, so it must survive a regeneration.
  const carried: ICPPersona = previous.id ? { ...fresh, id: previous.id } : fresh;
  if (!hasAnchor(previous)) return carried;
  const intent = previous.userIntent!;
  const merged: ICPPersona = { ...carried, userIntent: intent };
  for (const field of ICP_PERSONA_FIELD_NAMES) {
    const anchored = intent[field];
    if (typeof anchored === "string") merged[field] = anchored;
  }
  return merged;
}

/**
 * Merge a freshly generated set into the existing one, preserving every
 * persona the user has edited. An implicit full-set run (`/icp/start`, a
 * cascade, a brand change) must never destroy human work — the user has to
 * ask for it explicitly via `/icp/regenerate-one` or `/icp/delete-one`.
 *
 * Anchored personas hold their slot; generated personas fill the rest in
 * order. Exported for unit testing.
 */
export function mergePreservingAnchoredPersonas(
  existing: ICPPersona[],
  generated: ICPPersona[],
): ICPPersona[] {
  if (!Array.isArray(existing) || existing.length === 0) return generated;
  const queue = [...generated];
  const out: ICPPersona[] = [];
  const slots = Math.max(existing.length, generated.length);
  for (let i = 0; i < slots && out.length < MAX_ICP_PERSONAS; i++) {
    const current = existing[i];
    if (hasAnchor(current)) {
      out.push(current);
      continue;
    }
    const next = queue.shift();
    if (next) out.push(next);
    else if (current) out.push(current);
  }
  return out;
}

/**
 * Output contract for regenerating exactly ONE persona. Deliberately separate
 * from `ICP_DISCOVERY_SYSTEM_PROMPT`, which is verbatim prod-work-plan copy
 * for the 5-persona set and must not be edited (see the note on that const).
 */
export const ICP_SINGLE_REGEN_SYSTEM_PROMPT = [
  "You are refining ONE Ideal Customer Profile (ICP) persona within an existing set.",
  "Return a single persona. It must not duplicate any of the other personas in the set.",
  "",
  "OUTPUT CONTRACT — return ONLY valid JSON matching this exact shape:",
  "{",
  '  "icp": { "name": "...", "pain": "...", "desire": "...", "objection": "...", "meta_targeting_brief": "..." }',
  "}",
  "Each field is one short sentence. The name is an evocative archetype. No markdown, no commentary.",
].join("\n");

/**
 * Sent only when regenerating a persona the user has NOT edited — i.e. they
 * rejected it and want something else. On an edited persona this instruction
 * would fight the user's own words, so it is omitted.
 */
export const ICP_REGEN_DISTINCT_INSTRUCTION =
  "The user rejected the persona above. Produce a meaningfully different one — a different role, a different buying motivation — not a rewording of it.";

/**
 * Sent only when regenerating a persona the user HAS edited. They invested in
 * this card rather than rejecting it, so the run is a refinement: keep who the
 * persona is, and move the other fields only as far as coherence with the
 * user's own words requires. Without this (and without showing the model the
 * card's current content) a one-field edit silently replaced the whole persona.
 */
export const ICP_REGEN_REFINE_INSTRUCTION =
  "Refine this persona — keep who it is. Update the other fields only as much as coherence with the user's own words requires. Do not replace it with a different persona.";

function buildSingleRegenPrompt(
  brand: IcpBrandContext,
  target: ICPPersona,
  others: ICPPersona[],
): string {
  const lines: string[] = [
    "Regenerate one Ideal Customer Profile (ICP) persona for:",
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.tagline) lines.push(`Tagline: ${brand.tagline}`);
  if (brand.valueProposition) lines.push(`Value proposition: ${brand.valueProposition}`);
  if (brand.targetAudience) lines.push(`Target audience hint: ${brand.targetAudience}`);
  if (brand.toneOfVoice) lines.push(`Tone of voice: ${brand.toneOfVoice}`);
  if (brand.strategicContext) {
    lines.push("");
    lines.push("Strategic context from user-provided onboarding docs/notes:");
    lines.push(brand.strategicContext);
  }

  if (others.length > 0) {
    lines.push("");
    lines.push(
      "These personas already exist in the set. Do NOT produce another one like any of them:",
    );
    for (const o of others) lines.push(`- ${o.name}`);
  }

  lines.push("");
  if (hasAnchor(target)) {
    // Show the card as it stands. Anchored fields already hold the user's text
    // (`/icp/edit-one` writes both), so this doubles as the anchor. Passing
    // only the anchored field left the model rebuilding a whole persona from
    // one sentence, which replaced the card's identity on a one-field edit.
    lines.push("Persona to refine:");
    lines.push(`- name: ${target.name}`);
    lines.push(`- pain: ${target.pain}`);
    lines.push(`- desire: ${target.desire}`);
    lines.push(`- objection: ${target.objection}`);
    lines.push("");
    const authored = ICP_PERSONA_FIELD_NAMES.filter(
      (field) => target.userIntent?.[field],
    );
    lines.push(
      `The user wrote the following field(s) themselves — keep them exactly, changing only wording that does not alter their meaning: ${authored.join(", ")}.`,
    );
    lines.push("");
    lines.push(ICP_REGEN_REFINE_INSTRUCTION);
  } else {
    lines.push("Persona to replace:");
    lines.push(`- name: ${target.name}`);
    lines.push(`- pain: ${target.pain}`);
    lines.push(`- desire: ${target.desire}`);
    lines.push(`- objection: ${target.objection}`);
    lines.push("");
    lines.push(ICP_REGEN_DISTINCT_INSTRUCTION);
  }

  lines.push("");
  lines.push("Return JSON matching the schema in the system prompt.");
  return lines.join("\n");
}

/**
 * Pure LLM call for a single persona — exported for unit-testing with an
 * injected LLMService.
 */
export async function generateSingleIcpForUser(
  brand: IcpBrandContext,
  target: ICPPersona,
  others: ICPPersona[],
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
  userId?: string,
): Promise<ICPPersona> {
  const llm = deps.llm ?? new LLMService(ICP_MODEL, ICP_TEMPERATURE, ICP_MAX_TOKENS);
  const raw = await llm.generateJsonRobust<{ icp: unknown }>(
    ICP_SINGLE_REGEN_SYSTEM_PROMPT,
    buildSingleRegenPrompt(brand, target, others),
    undefined,
    { userId, feature: "onboarding" },
  );
  const [persona] = sanitizeICPPersonas([raw?.icp]);
  if (!persona) throw new Error("LLM returned no icp");
  return persona;
}

/**
 * Regenerate exactly one persona, in place.
 *
 * `/icp/regenerate-one` previously parsed and validated its `icpId`, then
 * discarded it and re-ran the whole set from brand context alone — replacing
 * all five personas and destroying any the user had edited (ENG-255).
 *
 * Assumes `icpStatus` is already `running` (the route flips it). Validates
 * before touching the DB so a bad index writes nothing. Persists with a
 * read-modify-write so a concurrent `/icp/edit-one` on a different persona is
 * not lost to the ~20s LLM round-trip.
 */
export async function regenerateSingleIcpForUser(
  userId: string,
  index: number,
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    loadStrategicContext?: (userId: string) => Promise<string | null>;
    competitor?: {
      generateCompetitorStrategyForUser: (
        brand: IcpBrandContext,
        personas: ICPPersona[],
        deps?: unknown,
      ) => Promise<{ per_icp: unknown[] }>;
    };
  } = {},
): Promise<void> {
  const user: any = await readUserForRegeneration(userId);
  if (!user) throw new Error(`user ${userId} not found`);

  const personas: ICPPersona[] = Array.isArray(user.icpResult) ? user.icpResult : [];
  if (personas.length === 0) {
    throw new Error("no ICPs to regenerate — run /icp/start first");
  }
  if (!Number.isInteger(index) || index < 0 || index >= personas.length) {
    throw new Error(`icp index ${index} out of range (0..${personas.length - 1})`);
  }

  try {
    const brand = extractIcpBrandContext(user);
    if (!brand.strategicContext) {
      const loaded = await (deps.loadStrategicContext ??
        loadOnboardingStrategicContextForUser)(userId);
      if (loaded) brand.strategicContext = loaded.slice(0, MAX_STRATEGIC_CONTEXT_CHARS);
    }

    const target = personas[index];
    const others = personas.filter((_, i) => i !== index);
    const fresh = applyAnchor(
      await generateSingleIcpForUser(brand, target, others, deps, userId),
      target,
    );

    // Re-read: the LLM call took ~20s and the user may have edited another
    // card meanwhile. Splice into the CURRENT list, not the one we started
    // from, or we silently revert their edit.
    const current: any = (await readUserForRegeneration(userId)) ?? user;
    const currentList: ICPPersona[] = Array.isArray(current.icpResult)
      ? [...current.icpResult]
      : [...personas];

    // Re-resolve the target by its stable id, NOT by the index we started with.
    // A concurrent /icp/delete-one during the ~20s LLM call shifts every later
    // persona down a slot, so the original index now names a different card —
    // splicing there would overwrite a persona the user never touched.
    // (Records predating stable ids fall back to the bounded index.)
    const spliceAt = target.id
      ? currentList.findIndex((p) => p?.id === target.id)
      : index < currentList.length
        ? index
        : -1;

    if (spliceAt < 0) {
      // The card was deleted while we were regenerating it. Nothing to write —
      // but the status must still leave `running`, or the FE spins until it
      // times out.
      console.warn("[onboardingIcpService] regenerated persona no longer exists", {
        userId,
        icpId: target.id,
      });
      const gonePatch = icpReadyPatch(current, currentList);
      if (gonePatch) await userDb.updateUser(userId, gonePatch as any);
      return;
    }

    currentList[spliceAt] = fresh;

    const patch = icpReadyPatch(current, currentList);
    if (patch) {
      await userDb.updateUser(userId, patch as any);
    } else {
      // Not `running` any more: a concurrently-started regeneration of another
      // card already completed and flipped the record to `ready`. Persist the
      // persona anyway — dropping it loses the card the user asked for and
      // leaves its spinner stuck. Status belongs to whoever owns it now.
      await userDb.updateUser(userId, { icpResult: sanitizeICPPersonas(currentList) } as any);
    }
    await mirrorIcpsToMarketStrategy(userId, currentList);

    await regenerateCompetitorEntry(userId, current, brand, fresh, spliceAt, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(userId, icpFailedPatch((current as any) || {}, msg) as any);
    console.error("[onboardingIcpService] single-persona regeneration failed", {
      userId,
      index,
      err: msg,
    });
    throw err;
  }
}

/**
 * Competitor research is a parallel array to the ICP set (`per_icp[i]`
 * describes `icpResult[i]`, labelled by `icp_id: persona.name`). When one
 * persona is replaced, its entry — and only its entry — is stale.
 *
 * Best-effort: the personas are already persisted, so a competitor failure
 * must not roll them back or surface as a failed ICP run.
 */
async function regenerateCompetitorEntry(
  userId: string,
  current: any,
  brand: IcpBrandContext,
  persona: ICPPersona,
  index: number,
  deps: {
    competitor?: {
      generateCompetitorStrategyForUser: (
        brand: IcpBrandContext,
        personas: ICPPersona[],
        deps?: unknown,
      ) => Promise<{ per_icp: unknown[] }>;
    };
  },
): Promise<void> {
  const existing = current?.competitorResult?.per_icp;
  if (!Array.isArray(existing) || index >= existing.length) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const competitor =
      deps.competitor ?? require("./onboardingCompetitorService");
    const result = await competitor.generateCompetitorStrategyForUser(brand, [persona]);
    const entry = result?.per_icp?.[0];
    if (!entry) return;
    const next = [...existing];
    next[index] = entry;
    await userDb.updateUser(userId, { competitorResult: { per_icp: next } } as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[onboardingIcpService] competitor entry refresh failed", {
      userId,
      index,
      err: msg,
    });
  }
}

/**
 * Fire-and-forget orchestrator. Called from `/icp/start` AFTER the status
 * has been flipped to `running`. Resolves immediately — the LLM work runs
 * in the background and patches the User record on completion.
 *
 * Tests can `await` the returned promise to assert persisted state.
 */
export async function triggerIcpDiscoveryForUser(
  userId: string,
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    loadStrategicContext?: (userId: string) => Promise<string | null>;
  } = {},
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;
  const brand = extractIcpBrandContext(user as any);
  if (!brand.strategicContext) {
    const loadedContext = await (deps.loadStrategicContext ?? loadOnboardingStrategicContextForUser)(userId);
    if (loadedContext) {
      brand.strategicContext = loadedContext.slice(0, MAX_STRATEGIC_CONTEXT_CHARS);
    }
  }
  try {
    const generated = await generateIcpsForUser(brand, deps, userId);
    const current = await userDb.getUserById(userId);
    // An implicit full-set run must not destroy personas the user wrote by
    // hand. Anchored personas hold their slot; the rest are replaced. See
    // ENG-255 — this is the write that silently ate the user's edits.
    const existing: ICPPersona[] = Array.isArray((current as any)?.icpResult)
      ? ((current as any).icpResult as ICPPersona[])
      : [];
    const personas = ensurePersonaIds(
      mergePreservingAnchoredPersonas(existing, generated),
    );
    const patch = icpReadyPatch((current as any) || {}, personas);
    if (!patch) {
      // User no longer in `running` (UI navigated away or watchdog flipped).
      // Stale completion is not an error — drop silently.
      return;
    }
    await userDb.updateUser(userId, patch as any);

    // Mirror to marketStrategy.icp[] so the main account (Agent Mode,
    // chatbot, etc.) sees the ICPs the onboarding flow generated. Without
    // this, v2 onboarding writes to User.icpResult only and the user
    // finishes onboarding with an apparently-blank market strategy.
    // Best-effort — errors logged but do NOT block the cascade.
    await mirrorIcpsToMarketStrategy(userId, personas);

    // Cascade kickoff: fire-and-forget the competitor step now that ICPs
    // are persisted and `icpStatus === 'ready'`. Without this, the user
    // had to wait for the next FE polling tick before competitor research
    // started — adding 20s+ of dead time to onboarding. Combined with
    // the gate inside `triggerCompetitorStrategyForUser`, this makes the
    // ICP→Competitor handoff race-free. We intentionally `require` here
    // (not `import`) to avoid a circular module dep —
    // onboardingCompetitorService imports `extractIcpBrandContext` from
    // this file. Errors are swallowed by the competitor service itself
    // (it has its own try/catch).
    //
    // We use `startCompetitorStrategyForUser` (NOT `trigger`) because
    // `competitorReadyPatch` is gated on `competitorStatus === 'running'`
    // — the start variant flips status to `running` before invoking the
    // background work. Without that prior flip the LLM result is silently
    // dropped on completion (`competitorReadyPatch` returns null).
    //
    // We delay the cascade kickoff by `CASCADE_TRIGGER_DELAY_MS` to let
    // the UserIdIndex GSI propagate the icpReadyPatch we just wrote —
    // without this, the immediate read inside the cascade sees the
    // pre-update row and the gate inside
    // `triggerCompetitorStrategyForUser` trips with `gated by icp step`
    // even though icp is genuinely ready. Default is 2s (generous;
    // DynamoDB GSI propagation is typically <1s in us-west-2). Tests
    // inject 0 to assert the cascade synchronously.
    //
    // Eager DAG sub-task 2: when the user is on `useEagerPipeline`, the
    // OnboardingPipelineOrchestrator owns step ordering — skip the
    // legacy cross-call cascade entirely. The orchestrator's reconcile
    // loop will pick up `competitor` once `icp` is `ready` in the
    // `User.steps` table. For everyone else (the default path), keep
    // the legacy cascade so this PR is a pure no-op for non-flag users.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      isEagerPipelineActiveFor,
    } = require("./onboardingOrchestratorWiring");
    if (!isEagerPipelineActiveFor(current as any)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { startCompetitorStrategyForUser } = require("./onboardingCompetitorService");
      const delay = CASCADE_TRIGGER_DELAY_MS;
      if (delay > 0) {
        setTimeout(() => {
          void startCompetitorStrategyForUser(userId);
        }, delay);
      } else {
        void startCompetitorStrategyForUser(userId);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(
      userId,
      icpFailedPatch((current as any) || {}, msg) as any,
    );
    console.error("[onboardingIcpService] generation failed", { userId, err: msg });
    void reportUIError({
      operation: "onboarding:icp:llm-generation",
      errorMessage: msg,
      userId,
      context: {
        Source: "backend",
        Step: "icp",
        Stack: err instanceof Error ? (err.stack ?? "").slice(0, 1000) : "",
      },
    });
  }
}

/**
 * Synchronous entry point for routes — flips status to `running` and
 * launches background work. Returns once the start patch has been
 * persisted so the route can return the running snapshot.
 */
export async function startIcpDiscoveryForUser(
  userId: string,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
): Promise<void> {
  await userDb.updateUser(userId, icpStartPatch() as any);
  // Eager DAG sub-task 2: kick the orchestrator. No-op for users not on
  // `useEagerPipeline`; for opted-in users the orchestrator drives the
  // ICP runner (which delegates to triggerIcpDiscoveryForUser), so we
  // do NOT invoke the legacy trigger directly to avoid running the
  // step twice in parallel. For everyone else, the legacy trigger is
  // the source of truth.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    isEagerPipelineActiveFor,
    reconcileForUser,
  } = require("./onboardingOrchestratorWiring");
  const current = (await userDb.getUserById(userId)) as
    | { useEagerPipeline?: boolean }
    | null;
  if (isEagerPipelineActiveFor(current)) {
    void reconcileForUser(userId);
    return;
  }
  // Intentionally not awaited — the route returns immediately.
  // Errors inside triggerIcpDiscoveryForUser are caught + persisted there.
  void triggerIcpDiscoveryForUser(userId, deps);
}
