/**
 * ENG-2530 (slice of ENG-246): pure Fathom summary/transcript -> structured
 * onboarding context.
 *
 * Deliberately storage-free: no DB, no account creation, no customer comms.
 * The LLM is injected so tests run against a fake client, and its output is
 * schema-validated — malformed output yields a typed retryable failure, never
 * a partial object. Every field carries its Fathom source reference and a
 * fact-vs-internal-note flag so speculation never reads as a customer fact.
 */
import { z } from 'zod';

export const ONBOARDING_SCALAR_FIELDS = [
  'companyName',
  'contactName',
  'contactEmail',
  'domain',
  'productCategory',
  'icp',
  'primaryGtmGoal',
  'winMetric',
  'urgency',
  'suggestedFirstWinPath',
] as const;

export const ONBOARDING_LIST_FIELDS = [
  'channels',
  'setupBlockers',
  'fitNotes',
  'featureGapsOrRisks',
] as const;

export type OnboardingScalarField = (typeof ONBOARDING_SCALAR_FIELDS)[number];
export type OnboardingListField = (typeof ONBOARDING_LIST_FIELDS)[number];

/** `fact` = stated by the customer; `internal_note` = speculation / internal remark. */
export type OnboardingFieldKind = 'fact' | 'internal_note';

export interface OnboardingSourceRef {
  url: string;
  timestampSeconds?: number;
}

export interface OnboardingField<T> {
  value: T;
  confidence: number;
  kind: OnboardingFieldKind;
  source: OnboardingSourceRef;
}

export type OnboardingContext = {
  sourceUrl: string;
} & { [K in OnboardingScalarField]: OnboardingField<string> | null } & {
  [K in OnboardingListField]: OnboardingField<string>[];
};

export type OnboardingExtractionFailure = {
  ok: false;
  error: { code: 'invalid_llm_output' | 'llm_call_failed'; retryable: true; message: string };
};

export type OnboardingExtractionResult = { ok: true; context: OnboardingContext } | OnboardingExtractionFailure;

/** Minimal injected port. Returns raw parsed JSON (or a JSON string). */
export interface OnboardingExtractorLlm {
  generateJson(systemPrompt: string, userPrompt: string): Promise<unknown>;
}

const rawFieldSchema = z
  .object({
    value: z.string().trim().min(1),
    confidence: z.number().finite().min(0).max(1),
    kind: z.enum(['fact', 'internal_note']),
    timestampSeconds: z.number().finite().nonnegative().optional(),
  })
  .strict();

const rawContextSchema = z
  .object({
    ...Object.fromEntries(ONBOARDING_SCALAR_FIELDS.map((f) => [f, rawFieldSchema.nullable()])),
    ...Object.fromEntries(ONBOARDING_LIST_FIELDS.map((f) => [f, z.array(rawFieldSchema)])),
  } as Record<string, z.ZodTypeAny>)
  .strict();

type RawField = z.infer<typeof rawFieldSchema>;

const SYSTEM_PROMPT =
  'Extract onboarding context from a Fathom sales/onboarding call. Return only JSON. ' +
  'For every field return {"value":string,"confidence":0..1,"kind":"fact"|"internal_note","timestampSeconds"?:number} or null/[] when absent. ' +
  'kind="fact" only when the customer stated it; speculation or internal team remarks are "internal_note". ' +
  'Never invent emails, domains, budgets or timelines.';

function buildUserPrompt(sourceText: string, recordingUrl: string): string {
  return (
    `Source Fathom URL: ${recordingUrl}\n` +
    `Scalar fields (field|null): ${ONBOARDING_SCALAR_FIELDS.join(', ')}\n` +
    `List fields (field[]): ${ONBOARDING_LIST_FIELDS.join(', ')}\n\n` +
    sourceText.slice(0, 60000)
  );
}

function toField(raw: RawField, sourceUrl: string): OnboardingField<string> {
  const source: OnboardingSourceRef = { url: sourceUrl };
  if (raw.timestampSeconds !== undefined) source.timestampSeconds = raw.timestampSeconds;
  return { value: raw.value.trim(), confidence: raw.confidence, kind: raw.kind, source };
}

function failure(code: OnboardingExtractionFailure['error']['code'], message: string): OnboardingExtractionFailure {
  return { ok: false, error: { code, retryable: true, message } };
}

export function parseOnboardingContext(raw: unknown, recordingUrl: string): OnboardingExtractionResult {
  let candidate = raw;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return failure('invalid_llm_output', 'LLM output is not valid JSON');
    }
  }
  const parsed = rawContextSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    return failure('invalid_llm_output', issues);
  }
  const data = parsed.data as Record<string, RawField | RawField[] | null>;
  const context = { sourceUrl: recordingUrl } as OnboardingContext;
  for (const f of ONBOARDING_SCALAR_FIELDS) {
    const v = data[f] as RawField | null;
    (context as any)[f] = v ? toField(v, recordingUrl) : null;
  }
  for (const f of ONBOARDING_LIST_FIELDS) {
    (context as any)[f] = (data[f] as RawField[]).map((v) => toField(v, recordingUrl));
  }
  return { ok: true, context };
}

export async function extractOnboardingContext(
  input: { sourceText: string; recordingUrl: string },
  deps: { llm: OnboardingExtractorLlm },
): Promise<OnboardingExtractionResult> {
  const recordingUrl = input.recordingUrl.trim();
  if (!recordingUrl) return failure('invalid_llm_output', 'recordingUrl is required for source attribution');
  let raw: unknown;
  try {
    raw = await deps.llm.generateJson(SYSTEM_PROMPT, buildUserPrompt(input.sourceText, recordingUrl));
  } catch (err) {
    return failure('llm_call_failed', err instanceof Error ? err.message : String(err));
  }
  return parseOnboardingContext(raw, recordingUrl);
}

/** Customer-stated facts only (internal notes excluded). */
export function onboardingFacts(context: OnboardingContext): Array<[string, OnboardingField<string>]> {
  const out: Array<[string, OnboardingField<string>]> = [];
  for (const f of ONBOARDING_SCALAR_FIELDS) {
    const v = context[f];
    if (v && v.kind === 'fact') out.push([f, v]);
  }
  for (const f of ONBOARDING_LIST_FIELDS) {
    for (const v of context[f]) if (v.kind === 'fact') out.push([f, v]);
  }
  return out;
}
