import { populateEmptyBrandGuidelines } from './brandGuidelinesPopulation';
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
import type { LLMUsageContext } from "../utils/llmService";
import { reportUIError } from "../utils/errorReporter";
import { getGCSPPrivateKey } from "../utils/secretsManager";
import { getS3ObjectAsString } from "../utils/s3Utils";
import { taskDb, userDb } from "./db";
import { Storage } from "@google-cloud/storage";
import { trackBackgroundRun } from "../utils/trackedBackgroundRun";
import { withClearedError } from "../utils/clearErrorOnClaim";
import {
  icpFailedPatch,
  icpReadyPatch,
  icpStartPatch,
  ICPPersona,
  ICPStatusFields,
  ICP_PERSONA_FIELD_NAMES,
  ICP_TIMEOUT_MS,
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
 *
 * `completedAt` is stamped onto `marketStrategy.updatedAt` in place of the
 * wall-clock time of this write. This mirror runs a moment (write + re-read
 * round-trip) AFTER `icpCompletedAt` is persisted, so timestamping it with
 * `now()` made every onboarding generation — not just a real edit on the
 * Market Strategy page — look like it happened *after* `icpCompletedAt`,
 * which permanently flipped `GET /icp/filters` onto the lossy
 * marketStrategy-derived persona path (ENG-1955). Backdating to the
 * generation's own completion time keeps this system write indistinguishable
 * in age from the icpResult it mirrors, so only a later, genuine
 * `POST /market-strategy` edit reads as newer.
 */
async function mirrorIcpsToMarketStrategy(
  userId: string,
  personas: ICPPersona[],
  completedAt: string,
): Promise<void> {
  try {
    // Consistent where possible: this rewrites the whole marketStrategy object,
    // so a lagging index read could write back stale competitors/overview.
    const fresh: any = await readUserForRegeneration(userId);
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
      icpUpdatedAt?: string;
    };
    const merged = {
      ...existing,
      businessOverview: existing.businessOverview ?? "",
      competitors: existing.competitors ?? [],
      icp: mapIcpResultToMarketStrategy(personas),
      createdAt: existing.createdAt ?? now,
      updatedAt: completedAt,
      // Tracked separately from `updatedAt` (ENG-1955 follow-up): this write
      // genuinely touches `icp`, so it's correct for icpUpdatedAt to move —
      // unlike a competitors/businessOverview-only save elsewhere, which must
      // NOT look like an ICP correction to the staleness check in
      // routes/crm.ts. Backdated to `completedAt` for the same reason
      // `updatedAt` is: this write runs moments after icpCompletedAt is
      // persisted, so timestamping with wall-clock now() would make it look
      // newer than the generation it mirrors.
      icpUpdatedAt: completedAt,
    };
    await userDb.updateUser(userId, { marketStrategy: merged } as any);
    await populateEmptyBrandGuidelines(userId);
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
 * Mirror the AUTHORITATIVE persona list to marketStrategy, re-checking after
 * the write. The mirror is a whole-list write, so two regenerations finishing
 * together could each mirror a list lacking the other's card, the last one
 * winning. Re-reading `icpResult` consistently and re-mirroring until the list
 * is unchanged across a write makes the final mirror always match it: whichever
 * regeneration finishes last sees the final list and corrects an older mirror.
 */
async function mirrorIcpsUntilStable(userId: string, completedAt: string): Promise<void> {
  const MAX_MIRROR_PASSES = 3;
  const listOf = async (): Promise<ICPPersona[] | null> => {
    const u: any = await readUserForRegeneration(userId);
    return u && Array.isArray(u.icpResult) ? (u.icpResult as ICPPersona[]) : null;
  };
  // Best-effort like the single mirror write it wraps: the card is already
  // saved, so a failed re-read here must not turn the run into `failed`.
  try {
    for (let pass = 0; pass < MAX_MIRROR_PASSES; pass++) {
      const before = await listOf();
      if (!before) return;
      await mirrorIcpsToMarketStrategy(userId, before, completedAt);
      const after = await listOf();
      if (!after || JSON.stringify(after) === JSON.stringify(before)) return;
    }
  } catch (err) {
    console.error("[onboardingIcpService] mirror re-check failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
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

export const ICP_LIST_CONTENDED = "ICP_LIST_CONTENDED";
const MAX_CARD_WRITE_ATTEMPTS = 8;

export type IcpCardOp =
  | { type: "edit"; patch: Record<string, string> }
  | { type: "delete" };

export type IcpCardResult =
  | { ok: true; icpResult: ICPPersona[] }
  | { ok: false; status: 400 | 404 };

const ID_LESS_IDENTITY_FIELDS = ["name", "pain", "desire", "objection"] as const;

function fingerprintOf(card: any): Record<string, unknown> {
  return Object.fromEntries(ID_LESS_IDENTITY_FIELDS.map((f) => [f, card?.[f]]));
}

function sameFingerprint(card: any, fingerprint: Record<string, unknown>): boolean {
  return ID_LESS_IDENTITY_FIELDS.every((f) => JSON.stringify(card?.[f]) === JSON.stringify(fingerprint[f]));
}

/**
 * Edit or delete ONE persona, touching only that card.
 *
 * The routes used to read the whole list, change it in memory and write the whole
 * list back, so two writers that read the same list each stored one change without
 * the other. A whole-list compare-and-swap fixed that but made every write depend
 * on the entire stored list reading back byte-equal, which needs an unconditional
 * last attempt (and so can still lose a change) when it never does.
 *
 * Here each write is a document-path update on the one card, conditioned only on
 * what that write depends on: that the card at the index we read is still the same
 * card. Writers on different cards or fields never conflict, a delete that shifts
 * the list simply makes later writes recompute their index from a fresh read, and
 * nothing here compares data that could fail to read back equal. Reads are
 * base-table reads: the UserIdIndex can still show the list from before the last
 * write, which would make every retry compute the same stale index.
 */
export async function writeIcpCard(
  userId: string,
  resolve: (list: ICPPersona[]) => { index: number } | { status: 400 | 404 },
  op: IcpCardOp,
): Promise<IcpCardResult> {
  // The card the caller meant, fixed on the FIRST read. A retry must find that same
  // card again, not re-run `resolve`: a positional ref such as `icp-2` names
  // whatever sits at position 2 NOW, which after a concurrent delete is a different
  // card.
  let target: { idKnown: boolean; id: unknown; fingerprint: Record<string, unknown>; index: number; length: number; twins: number } | null = null;

  for (let attempt = 0; attempt < MAX_CARD_WRITE_ATTEMPTS; attempt++) {
    const user: any = await readUserForRegeneration(userId);
    const list: ICPPersona[] = Array.isArray(user?.icpResult) ? user.icpResult : [];
    if (list.length === 0) return { ok: false, status: 404 };

    let idx: number;
    if (!target) {
      const resolved = resolve(list);
      if ("status" in resolved) return { ok: false, status: resolved.status };
      idx = resolved.index;
      const first: any = list[idx];
      const fingerprint = fingerprintOf(first);
      // Id-less cards with identical text: once one of them changes, the survivor
      // cannot be told from the card that was clicked.
      const twins = first?.id !== undefined ? 1 : list.filter((p: any) => p?.id === undefined && sameFingerprint(p, fingerprint)).length;
      target = { idKnown: first?.id !== undefined, id: first?.id, fingerprint, index: idx, length: list.length, twins };
    } else {
      // Same card by identity: its id, or, for a card stored before ids existed, its
      // visible text.
      const wanted = target;
      if (!wanted.idKnown && wanted.twins > 1) {
        // The write failed because this position changed; with look-alikes present, a
        // lone survivor of the same text may be the OTHER card. Never guess.
        throw Object.assign(new Error("the persona could not be re-identified"), { code: ICP_LIST_CONTENDED });
      }
      const matches = list
        .map((p: any, i) => ({ i, p }))
        .filter(({ p }) => (wanted.idKnown ? p?.id === wanted.id : p?.id === undefined && sameFingerprint(p, wanted.fingerprint)));
      if (matches.length > 1) {
        // Same-looking cards cannot be told apart: never guess.
        throw Object.assign(new Error("the persona could not be re-identified"), { code: ICP_LIST_CONTENDED });
      }
      if (matches.length === 1) {
        idx = matches[0].i;
      } else if (!wanted.idKnown && list.length === wanted.length && (list[wanted.index] as any)?.id === undefined) {
        // A concurrent edit changed the text this card was matched on. Nothing was
        // added or removed, so it is still where it was.
        idx = wanted.index;
      } else {
        // Gone, or moved and changed beyond recognition. 404 makes the client refresh
        // instead of offering a retry that could land on a different card.
        return { ok: false, status: 404 };
      }
      target.index = idx;
      target.length = list.length;
      if (!wanted.idKnown) target.fingerprint = fingerprintOf(list[idx]);
    }
    const card: any = list[idx];

    // Identity: the same card still sits at this index. Compared with whatever
    // value was read (any type) so a card with an odd stored shape can still match.
    const names: Record<string, string> = { "#cl": "icpResult", "#cid": "id" };
    const values: Record<string, unknown> = {};
    // The element must still exist: a nameless, id-less card would otherwise pass the
    // checks below at an index the list has since shrunk past.
    const clauses: string[] = [`attribute_exists(#cl[${idx}])`];
    if (card?.id !== undefined) {
      values[":cid"] = card.id;
      clauses.push(`#cl[${idx}].#cid = :cid`);
    } else {
      // No id to hold on to: the visible text is the identity. A name alone cannot
      // tell two same-named cards apart, so a card sliding into this position after
      // a concurrent delete would pass it.
      clauses.push(`attribute_not_exists(#cl[${idx}].#cid)`);
      ID_LESS_IDENTITY_FIELDS.forEach((f, n) => {
        names[`#cf${n}`] = f;
        if (card?.[f] === undefined) {
          clauses.push(`attribute_not_exists(#cl[${idx}].#cf${n})`);
        } else {
          values[`:cf${n}`] = card[f];
          clauses.push(`#cl[${idx}].#cf${n} = :cf${n}`);
        }
      });
    }

    const writeOptions: Parameters<typeof userDb.updateUser>[2] = {};
    if (op.type === "delete") {
      writeOptions.pathRemoves = [{ path: ["icpResult", idx] }];
    } else {
      const fields = Object.keys(op.patch);
      writeOptions.pathSets = fields.map((f) => ({ path: ["icpResult", idx, f], value: op.patch[f] }));
      // The user's own words are also kept as an anchor next to the visible field:
      // every later regeneration of this persona is driven from the anchor, so it
      // can neither be overwritten by a full-set run nor drift (ENG-255). Merged,
      // not replaced, so an edit to a second field keeps the first. The write
      // asserts the anchor's current shape, so two first edits racing cannot both
      // think they are the first.
      names["#cui"] = "userIntent";
      const anchor = card?.userIntent;
      const anchorPath = `#cl[${idx}].#cui`;
      if (anchor === undefined) {
        clauses.push(`attribute_not_exists(${anchorPath})`);
        writeOptions.pathSets.push({ path: ["icpResult", idx, "userIntent"], value: { ...op.patch } });
      } else if (anchor !== null && typeof anchor === "object" && !Array.isArray(anchor)) {
        values[":tM"] = "M";
        clauses.push(`attribute_type(${anchorPath}, :tM)`);
        for (const f of fields) writeOptions.pathSets.push({ path: ["icpResult", idx, "userIntent", f], value: op.patch[f] });
      } else {
        // Present but not a map (null, a list, a string): replace it with a fresh anchor.
        clauses.push(`attribute_exists(${anchorPath})`);
        writeOptions.pathSets.push({ path: ["icpResult", idx, "userIntent"], value: { ...op.patch } });
      }
    }
    writeOptions.condition = { expression: clauses.join(" AND "), names, values };

    try {
      const updated: any = await userDb.updateUser(userId, {}, writeOptions);
      return { ok: true, icpResult: Array.isArray(updated?.icpResult) ? updated.icpResult : [] };
    } catch (err: any) {
      if (err?.code !== "ConditionalCheckFailedException") throw err;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1) + Math.random() * 25));
    }
  }
  throw Object.assign(new Error("the persona list kept changing"), { code: ICP_LIST_CONTENDED });
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
  "ALL FIVE fields are required. Never omit meta_targeting_brief: it is one sentence describing who to target in ad platforms (role, industry, company stage).",
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
  // The model sometimes drops a required field (observed ~1 in 3 without the
  // prompt's explicit reminder: it omits meta_targeting_brief), and the
  // sanitiser rejects any persona missing one. One retry is cheap next to
  // failing the user's click.
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.generateJsonRobust<{ icp: unknown }>(
      ICP_SINGLE_REGEN_SYSTEM_PROMPT,
      buildSingleRegenPrompt(brand, target, others),
      undefined,
      { userId, feature: "onboarding" },
    );
    const [persona] = sanitizeICPPersonas([raw?.icp]);
    if (persona) return persona;
  }
  throw new Error("LLM returned no icp");
}

/**
 * Regenerate exactly one persona, in place.
 *
 * `/icp/regenerate-one` previously parsed and validated its `icpId`, then
 * discarded it and re-ran the whole set from brand context alone — replacing
 * all five personas and destroying any the user had edited (ENG-255).
 *
 * Assumes `icpStatus` is already `running` (the route flips it). Validates
 * before touching the DB so a bad index writes nothing. The card is saved by
 * replacing ONLY its own slot (conditioned on the slot still holding that
 * card's id, retried from a fresh read if the list shifted), so concurrent
 * regenerations of other cards, and edits to them, are not lost to the LLM
 * round-trip.
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
    /**
     * The route reused an in-flight claim (icpStartedAt) instead of minting one:
     * either a full /icp/start run or ANOTHER card's regeneration, which look
     * identical. Save this card but leave the status to that claim's owner. The
     * UI stops polling at the first terminal status, so flipping to `ready` here
     * hid a full run's result until a reload.
     */
    statusOwnedElsewhere?: boolean;
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
    const generated = await generateSingleIcpForUser(brand, target, others, deps, userId);
    // Re-anchored on every write attempt below from the card as it stands then:
    // the LLM call took seconds and the user may have edited this very card
    // meanwhile, which their words must survive.
    let fresh = applyAnchor(generated, target);

    // The LLM call took seconds, and the user may have edited, deleted or
    // regenerated ANOTHER card meanwhile. Writing back a whole list built from a
    // read taken before the write silently reverts those (a lost update: two
    // regenerations finishing together each wrote a list lacking the other's
    // card). Instead the write replaces ONLY this card's slot, conditioned on
    // the slot still holding this card; if the condition fails (the list shifted
    // or the card changed) re-read and retry.
    const MAX_CARD_WRITE_ATTEMPTS = 4;
    let current: any = (await readUserForRegeneration(userId)) ?? user;
    let patch: ICPStatusFields | null = null;
    let wrote = false;
    let writtenAt = -1;
    for (let attempt = 0; attempt < MAX_CARD_WRITE_ATTEMPTS && !wrote; attempt++) {
      if (attempt > 0) current = (await readUserForRegeneration(userId)) ?? current;
      const currentList: ICPPersona[] = Array.isArray(current.icpResult)
        ? [...current.icpResult]
        : [...personas];

      // Re-resolve the target by its stable id, NOT by the index we started with.
      // A concurrent /icp/delete-one shifts every later persona down a slot, so
      // the original index now names a different card. (Records predating
      // stable ids fall back to the bounded index.)
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
        // Joined another claim: its owner settles the status, and flipping it
        // here would make its completion (conditioned on `running`) fail.
        if (deps.statusOwnedElsewhere && current.icpStatus === "running") return;
        // Status only: writing the list back too would be a whole-list write that
        // can erase a concurrent regeneration's slot.
        const { icpResult: _unchanged, ...goneStatus } = (icpReadyPatch(current, currentList) ?? {}) as Record<string, unknown>;
        if (Object.keys(goneStatus).length > 0) await userDb.updateUser(userId, goneStatus as any);
        return;
      }

      // The slot must still hold EXACTLY the card this attempt read, not merely a
      // card with the same id: an edit made while the model was thinking changes
      // the card but not its id, and an id-only check let this write replace the
      // user's words with the model's. When the card moved, the retry re-anchors
      // from the card as it stands, so the user's fields win and the rest still
      // regenerate. The equality also fails past the end of the list, where
      // DynamoDB would otherwise append.
      const cardNow = currentList[spliceAt];
      fresh = applyAnchor(generated, cardNow);
      const [card] = sanitizeICPPersonas([fresh]);
      const slot: Record<string, string> = { "#icpResult": "icpResult" };
      const slotIsOurs = "#icpResult[" + spliceAt + "] = :icpCardNow";
      const slotValues: Record<string, unknown> = { ":icpCardNow": cardNow };

      const joinedRun = Boolean(deps.statusOwnedElsewhere) && current.icpStatus === "running";
      // Joined another claim: save the card only. A full run replaces every non-anchored
      // card when it lands and its cascade re-derives the mirror and competitors,
      // and the write is conditioned on that run still being in flight so a
      // newer full set is never overwritten by this one.
      patch = joinedRun ? null : icpReadyPatch(current, currentList);
      const { icpResult: _wholeList, ...statusOnly } = (patch ?? {}) as Record<string, unknown>;
      try {
        await userDb.updateUser(userId, statusOnly as any, {
          elementSets: [{ path: ["icpResult"], index: spliceAt, value: card }],
          condition: {
            expression: joinedRun
              ? `#icpStatus = :icpDeferRunning AND #icpStartedAt = :icpDeferStartedAt AND ${slotIsOurs}`
              : slotIsOurs,
            names: joinedRun
              ? { ...slot, "#icpStatus": "icpStatus", "#icpStartedAt": "icpStartedAt" }
              : slot,
            values: joinedRun
              ? { ...slotValues, ":icpDeferRunning": "running", ":icpDeferStartedAt": current.icpStartedAt }
              : slotValues,
          },
        });
        wrote = true;
        writtenAt = spliceAt;
      } catch (err: any) {
        if (err?.code !== "ConditionalCheckFailedException") throw err;
        // Either the slot moved, or the run we joined ended while this card was
        // being written. Do NOT drop the card in the second case: the "run" may
        // have been another card's regeneration (its claim looks identical to a
        // full run's), and that one finishing first says nothing about this card.
        // Re-read and re-decide: if a full run replaced the list this card's id is
        // gone and the next pass settles as "no longer exists"; otherwise the card
        // is written on the normal path.
        // Slot moved or changed under us: loop to re-read and re-resolve.
      }
    }
    if (!wrote) {
      throw new Error("could not save the regenerated persona: the ICP list kept changing");
    }
    // Runs even when the status was left to another claim's owner. That owner may
    // be a full run (whose cascade re-derives all of this, discarding our work via
    // the persona-name condition below) but is often just ANOTHER card's
    // regeneration, which refreshes only its own card: skipping here left this
    // card's competitor entry describing its previous persona.
    //
    // Use whichever icpCompletedAt this write actually landed under — the
    // patch's freshly-stamped one, or (when another regeneration already
    // owned the `ready` transition) the one already on the record.
    const mirroredCompletedAt =
      patch?.icpCompletedAt ?? current.icpCompletedAt ?? new Date().toISOString();
    await mirrorIcpsUntilStable(userId, mirroredCompletedAt);

    await regenerateCompetitorEntry(userId, current, brand, fresh, writtenAt, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    // Joined another claim: its terminal status is not ours to write.
    if (!(deps.statusOwnedElsewhere && (current as any)?.icpStatus === "running")) {
      await userDb.updateUser(userId, icpFailedPatch((current as any) || {}, msg) as any);
    }
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
        usageContext?: LLMUsageContext,
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
    // ENG-1858: attribute and charge the refresh to this user, not "system".
    const usageContext: LLMUsageContext = { userId, feature: "onboarding_competitors" };
    const result = await competitor.generateCompetitorStrategyForUser(brand, [persona], undefined, usageContext);
    const entry = result?.per_icp?.[0];
    if (!entry) return;
    // Replace only this persona's entry. The LLM and web-search calls above
    // take long enough for another regeneration to finish meanwhile, and
    // writing back the whole `per_icp` read before them would erase its entry.
    //
    // The entry is written only if the card in that slot is STILL the persona it
    // was generated for. Comparing against the entry already stored (as an
    // earlier version did) made two back-to-back regenerations of the same card
    // both expect the same old entry, so whichever refresh landed second was
    // skipped even when it was the newer one. Keyed on the persona instead, a
    // refresh for a card that has since been regenerated again is dropped, and
    // the newer regeneration's own refresh supplies the right entry.
    const slot = "#competitorResult.#perIcp[" + index + "]";
    await userDb.updateUser(userId, {} as any, {
      elementSets: [{ path: ["competitorResult", "per_icp"], index, value: entry }],
      condition: {
        expression: `attribute_exists(${slot}) AND #icpResult[${index}].#personaName = :personaName`,
        names: {
          "#competitorResult": "competitorResult",
          "#perIcp": "per_icp",
          "#icpResult": "icpResult",
          "#personaName": "name",
        },
        values: { ":personaName": persona.name },
      },
    });
  } catch (err: any) {
    if (err?.code === "ConditionalCheckFailedException") {
      console.warn("[onboardingIcpService] competitor slot changed under the refresh — skipped", {
        userId,
        index,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[onboardingIcpService] competitor entry refresh failed", {
      userId,
      index,
      err: msg,
    });
  }
}

/**
 * Restate "the `running` record is still the one THIS run claimed" as a
 * DynamoDB condition (ENG-2308 review follow-up, confirmed by direct
 * reproduction). The stale-claim escape hatch in `icpStartClaimCondition`
 * lets a second claim reclaim the axis while the first claimant's
 * background work is merely slow, not crashed — `icpReadyPatch`'s own
 * guard only checks `icpStatus === "running"`, with nothing distinguishing
 * WHICH run's `running` it is. If the reclaimed (original) run finishes
 * after the reclaiming run has started but before it has finished, its
 * zombie write still passes that guard and can overwrite — or, if it lands
 * second, silently drop — the reclaiming run's actual result. Keying the
 * completion WRITE itself on the `icpStartedAt` this run's own claim
 * minted closes the gap: a reclaim always mints a fresh timestamp, so a
 * zombie's condition no longer matches once it's been superseded.
 */
function icpOwnershipCondition(expectedStartedAt: string) {
  return {
    expression: "#icpStartedAt = :icpOwnerStartedAt",
    names: { "#icpStartedAt": "icpStartedAt" },
    values: { ":icpOwnerStartedAt": expectedStartedAt },
  };
}

/**
 * Fire-and-forget orchestrator. Called from `/icp/start` AFTER the status
 * has been flipped to `running`. Resolves immediately — the LLM work runs
 * in the background and patches the User record on completion.
 *
 * `deps.expectedStartedAt` — the `icpStartedAt` THIS run's own
 * `claimIcpRun` call minted — is optional only for backward compatibility
 * with existing direct callers/tests that don't go through a claim; every
 * real caller (`startIcpDiscoveryForUser`, the orchestrator's `runIcp`)
 * always has it in hand and must pass it, or completion writes fall back
 * to the pre-ENG-2308-review posture (status-only, no ownership check).
 *
 * Tests can `await` the returned promise to assert persisted state.
 */
export async function triggerIcpDiscoveryForUser(
  userId: string,
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    loadStrategicContext?: (userId: string) => Promise<string | null>;
    expectedStartedAt?: string;
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
    // A card regeneration that overlapped this run keeps our icpStartedAt but
    // sets its own status when it finishes (`ready`, or `failed` on an LLM
    // miss). That is not a newer owner: this run still holds the claim, and the
    // write below is conditioned on it. Without this the regenerate finishing
    // first (~6s against ~12-22s here) silently discarded the whole-set result.
    const currentRec = (current as any) || {};
    const stillOurClaim =
      Boolean(deps.expectedStartedAt) &&
      currentRec.icpStartedAt === deps.expectedStartedAt;
    const patch = icpReadyPatch(
      stillOurClaim && currentRec.icpStatus !== "running"
        ? { ...currentRec, icpStatus: "running" }
        : currentRec,
      personas,
    );
    if (!patch) {
      // User no longer in `running` (UI navigated away or watchdog flipped).
      // Stale completion is not an error — drop silently.
      return;
    }
    // Landing over a `failed` status (a watchdog or a regenerate miss) must also
    // clear that failure's message; `undefined` in the patch is skipped on write.
    const writePatch =
      stillOurClaim && currentRec.icpStatus !== "running"
        ? withClearedError(patch, "icpError")
        : patch;
    if (deps.expectedStartedAt) {
      try {
        await userDb.updateUser(userId, writePatch as any, {
          condition: icpOwnershipCondition(deps.expectedStartedAt),
        });
      } catch (err: any) {
        if (err?.code === "ConditionalCheckFailedException") {
          // A reclaim superseded us while we were generating — our result
          // is stale even though icpStatus still reads "running" (it's the
          // RECLAIMING run's running, not ours). Drop silently, same as
          // the icpReadyPatch===null case above.
          console.warn(
            "[onboardingIcpService] dropping stale completion — a newer claim owns the axis",
            { userId },
          );
          return;
        }
        throw err;
      }
    } else {
      await userDb.updateUser(userId, patch as any);
    }

    // Mirror to marketStrategy.icp[] so the main account (Agent Mode,
    // chatbot, etc.) sees the ICPs the onboarding flow generated. Without
    // this, v2 onboarding writes to User.icpResult only and the user
    // finishes onboarding with an apparently-blank market strategy.
    // Best-effort — errors logged but do NOT block the cascade.
    await mirrorIcpsToMarketStrategy(userId, personas, patch.icpCompletedAt!);

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
          trackBackgroundRun("onboardingCompetitorKickoff", startCompetitorStrategyForUser(userId));
        }, delay);
      } else {
        trackBackgroundRun("onboardingCompetitorKickoff", startCompetitorStrategyForUser(userId));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    const failedPatch = icpFailedPatch((current as any) || {}, msg);
    if (deps.expectedStartedAt) {
      try {
        await userDb.updateUser(userId, failedPatch as any, {
          condition: icpOwnershipCondition(deps.expectedStartedAt),
        });
      } catch (condErr: any) {
        if (condErr?.code === "ConditionalCheckFailedException") {
          // Same reasoning as the success path above: a reclaim superseded
          // THIS run while its LLM call was failing. Reporting OUR failure
          // here would stomp whatever the reclaiming run has since done —
          // drop it, the reclaiming run owns the axis's fate now.
          console.warn(
            "[onboardingIcpService] dropping stale failure — a newer claim owns the axis",
            { userId },
          );
          return;
        }
        throw condErr;
      }
    } else {
      await userDb.updateUser(userId, failedPatch as any);
    }
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
 * Guards the non-running -> `running` transition with a DynamoDB
 * ConditionExpression (ENG-2308) — a plain read-then-write here lets two
 * concurrent `/icp/start` calls both observe a non-running status and both
 * win, launching two fully parallel LLM generations that race to decide
 * which personas persist. This is not a rare interleaving: `OutreachIcpPick`'s
 * watchdog (`ICP_AUTO_RETRY_MS` = 8s) re-fires `/icp/start` whenever
 * generation is still running past that window, which real ICP generation
 * routinely exceeds. `userDb.updateUser` already supports conditional
 * writes for exactly this class of race (see designSystemBuild.ts's
 * `START_CLAIM_CONDITION`, ENG-328); this uses the same primitive to make
 * the claim atomic instead of trusting a prior read.
 *
 * Also allows a fresh claim once the in-flight run has exceeded
 * `ICP_TIMEOUT_MS` (caught live: without this, a run genuinely stuck in
 * `running` — background job lost to a deploy/instance recycle/crash —
 * could never be retried again, since the claim would block every future
 * `/icp/start` forever. Before this PR the write was unconditional, so a
 * stuck run was always one retry away from unsticking itself; this clause
 * keeps that escape hatch while still closing the sub-timeout double-fire
 * race. The threshold matches `icpSnapshot`'s own `timedOut` flag exactly,
 * so a claim becomes possible at precisely the moment the FE is told the
 * run has timed out and offers a retry.
 *
 * NOT reusable for `/icp/regenerate-one`, even though that route flips the
 * same `icpStatus` field: this condition treats `icpStatus` as a one-slot
 * lock, but regenerate-one's actual concurrency unit is the PERSONA, not
 * the user. Two different cards regenerating at once is a real, tested,
 * intentional flow (ENG-255) — a prior version of this comment claimed
 * regenerate-one had "the exact same race" and reused this condition
 * there; that broke two-cards-at-once (the second card's claim lost the
 * race and its regeneration silently never ran) and was reverted after
 * review caught it before merge. See the comment on `/icp/regenerate-one`
 * for the full reasoning.
 */
function icpStartClaimCondition(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - ICP_TIMEOUT_MS).toISOString();
  return {
    expression:
      "attribute_not_exists(#icpStatus) OR #icpStatus <> :icpRunning OR #icpStartedAt <= :icpStaleBefore",
    names: { "#icpStatus": "icpStatus", "#icpStartedAt": "icpStartedAt" },
    values: { ":icpRunning": "running", ":icpStaleBefore": staleBefore },
  };
}

/**
 * Claim the icp axis for a new run: atomically flip `icpStatus` to
 * `running` (or no-op, returning `null`, if someone else already holds
 * the claim). Every entry point that wants to run ICP generation must go
 * through here — both `/icp/start` (via `startIcpDiscoveryForUser`) and
 * the eager-pipeline orchestrator's `runIcp` (`onboardingOrchestratorWiring.ts`).
 *
 * `runIcp` needed this split out (ENG-2308 follow-up, caught live): it
 * used to call `triggerIcpDiscoveryForUser` directly, with nothing ever
 * flipping `icpStatus` to `running` first on a pure orchestrator-driven
 * cascade (one where `/icp/start`'s own route was never separately hit).
 * `icpReadyPatch` requires `current.icpStatus === 'running'` to persist a
 * result — without it, `triggerIcpDiscoveryForUser` ran the real LLM call,
 * then silently dropped the result (returned without writing or
 * throwing), and the orchestrator recorded the step `ready` with a `null`
 * output anyway, since nothing threw. `shouldFire`'s hash-match then never
 * re-fires it. Confirmed live: ICP only ever "worked" in testing because
 * the test happened to call `/icp/start` manually first, which flipped the
 * field as an incidental side effect of a completely different call path
 * — not because the orchestrator's own cascade could make it succeed on
 * its own.
 */
export async function claimIcpRun(
  userId: string,
): Promise<ICPStatusFields | null> {
  const patch = icpStartPatch();
  try {
    await userDb.updateUser(userId, withClearedError(patch, "icpError") as any, {
      condition: icpStartClaimCondition(),
    });
  } catch (err: any) {
    if (err?.code === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
  return patch;
}

/**
 * Synchronous entry point for routes — flips status to `running` and
 * launches background work. Returns the persisted start patch once it has
 * landed so the route can return the running snapshot, or `null` if a
 * concurrent call already claimed this run (ENG-2308) — callers must NOT
 * launch a second background generation in that case.
 *
 * Checks eager-pipeline status BEFORE claiming (ENG-2308 fix-of-a-fix,
 * caught live): the orchestrator's `runIcp` claims this SAME axis itself
 * (via `claimIcpRun`) when it actually fires the step. If this function
 * also claimed before checking eager status, it would win the claim an
 * instant before handing off to `reconcileForUser` — and since `runIcp`'s
 * own claim attempt happens inside that SAME reconcile pass, moments
 * later, it would always lose to this function's own prior write,
 * permanently starving the real trigger. Exactly the same shape as the
 * ad-image pre-claim bug (`startAdImageGenerationForUser`) — this mirrors
 * that fix: skip claiming entirely on the eager branch, leaving
 * `claimIcpRun` as the sole claimant there.
 */
export async function startIcpDiscoveryForUser(
  userId: string,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
): Promise<ICPStatusFields | null> {
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
    return null;
  }
  const patch = await claimIcpRun(userId);
  if (!patch) return null;
  // Intentionally not awaited — the route returns immediately.
  // Errors inside triggerIcpDiscoveryForUser are caught + persisted there.
  // expectedStartedAt: this run's own claim, so a later reclaim's zombie
  // completion can't be confused with a terminal state THIS run published.
  // Tracked so a deploy's graceful shutdown waits for this run (cronJobRegistry
  // is drained before the listener closes) instead of killing it mid-flight and
  // leaving a dead `running` claim that nothing completes until it times out.
  trackBackgroundRun(
    "onboardingIcp",
    triggerIcpDiscoveryForUser(userId, {
      ...deps,
      expectedStartedAt: patch.icpStartedAt,
    }),
  );
  return patch;
}
