/**
 * ENG-55 / ENG-113: chat-level "Compare models".
 *
 * One prompt is fanned out to 2-4 models as plain, TOOL-LESS completions and the
 * answers are returned side by side. The user may then "continue with" one answer,
 * which is appended to the session as an ordinary user/assistant turn.
 *
 * Invariants (see dev/pending/eng-55-model-compare.md):
 *  - `compareModels` is READ-ONLY with respect to the session: it never writes a
 *    message/title/model and never takes the generation lock.
 *  - No tools, no web search, no fallback models, ever. A comparison that could
 *    call tools would duplicate external side effects N times.
 *  - A model that is not honored as requested is REJECTED, never substituted.
 *  - The response carries no usage, token, cost or upstream-id data.
 *  - `selectToken` is an HMAC over everything `/compare/select` will persist, so a
 *    client cannot forge an assistant message or its `llm` attribution without any
 *    server-side storage or schema change.
 *
 * Everything with side effects (LLM, DB, lock, clock, secret) is injected so the
 * flow is unit-testable; controllers/modelCompareController.ts wires the real ones.
 */
import {
  COMPARE_PROVIDER_POLICY_UNAVAILABLE_CODE,
  CompareProviderPolicy,
  isProviderPolicyUnavailableError,
} from './compareProviderPolicy';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { ChatMessage } from '../chatbotService';
import { AGENTWEB_MODEL_ID } from './modelAccess';
import { classifyToolErrorClass } from '../../utils/toolErrorClassifier';
import type { UsageBlockPaygInput } from '../../utils/usageBlockCopy';
import {
  MAX_ALTERNATIVE_LATENCY_MS,
  MAX_COMPARE_ALTERNATIVES,
  SavedAlternative,
  withSavedAlternatives,
} from './compareSaveAlternatives';

// ---------------------------------------------------------------------------
// Limits (single source of truth; exported for tests)
// ---------------------------------------------------------------------------
export const MIN_COMPARE_MODELS = 2;
export const MAX_COMPARE_MODELS = 4;
export const MAX_PROMPT_CHARS = 8000;
/** Most recent user/assistant text turns replayed as context. */
export const MAX_CONTEXT_MESSAGES = 20;
/** Total characters of replayed context, newest-first budget. */
export const MAX_CONTEXT_CHARS = 24000;
/** A single replayed turn is cut to this many characters. */
export const MAX_CONTEXT_MESSAGE_CHARS = 4000;
/**
 * Per-model output cap. It INCLUDES reasoning tokens: OpenRouter counts them against
 * `max_tokens`, and a model that spends the whole budget thinking returns
 * `finish_reason: "length"` with empty content while the reasoning is still billed; OpenAI
 * recommends reserving at least 25,000 tokens for reasoning plus output. The registry sets
 * no reasoning effort, so each model runs at its provider default (e.g. medium for GPT,
 * mandatory high for Claude Opus 5.5) — exactly as in chat.
 *
 * ENG-2648: 32000, the same ceiling /generate sends to every chat model
 * (AGENT_MODE_MAX_OUTPUT_TOKENS), so Compare no longer fails with `output_limit` on an
 * answer the same model gives in chat, and no model is sent a max_tokens that chat does not
 * already send it. It is a ceiling, not a reservation: models emit only what they need and
 * metering bills actual usage; COMPARE_TIMEOUT_MS still bounds each call. A `length` stop is
 * still reported as `output_limit` and never offered for selection.
 */
export const COMPARE_MAX_OUTPUT_TOKENS = 32000;
/** Per-model transport deadline handed to callLLM. */
export const COMPARE_TIMEOUT_MS = 60_000;
/** A select token is honored for this long after the compare was issued. */
export const SELECT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Tolerated clock skew between instances for an `issuedAt` in the future. */
export const SELECT_TOKEN_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Upper bound on the answer text accepted by /compare/select. */
export const MAX_SELECT_CONTENT_CHARS = 200_000;
/**
 * Concurrent /compare requests allowed per user, per instance (in-process counter, not
 * shared across instances). Each request fans out up to 4 calls, and callLLM may retry
 * each once (interactive_chat maxAttempts = 2), so worst case is 2 x N provider calls.
 */
export const MAX_CONCURRENT_COMPARES_PER_USER = 2;
export const COMPARE_FEATURE = 'agent_mode:model_compare';
/** Setting row that switches the feature off; any value other than "false" = enabled. */
export const MODEL_COMPARE_ENABLED_SETTING = 'model_compare_enabled';

const MAX_MODEL_ID_CHARS = 200;
const MAX_ID_CHARS = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT_TOKEN_KEY_LABEL = 'agentweb:model-compare:select-token:v1';

export const COMPARE_SYSTEM_PROMPT =
  'You are Emma, AgentWeb\'s assistant, answering in a side-by-side model comparison. ' +
  'You have no tools in this mode: you cannot browse, search, run code, read files, send messages or ' +
  'change anything. Answer the user\'s latest message directly from the conversation and your own ' +
  'knowledge. If the request needs a tool or live data, say so briefly and answer as far as you can without it. ' +
  // ENG-2648: the answers are shown side by side and rendered as Markdown, so every model must use the same
  // format (without this, Claude Sonnet 5 answered in HTML tags while the others used Markdown).
  'Format your answer in Markdown (headings, lists, tables and fenced code blocks where they help); do not use HTML tags. ' +
  'If the user asks for HTML or other code, put it in a fenced code block.';

export type CompareErrorCode =
  | 'timeout'
  | 'upstream_error'
  | 'model_unavailable'
  | 'model_unpriced'
  | 'model_live_unsupported'
  | 'output_limit'
  | 'model_mismatch'
  | 'empty_response'
  | 'provider_policy_unavailable';

export interface CompareResult {
  model: string;
  name: string;
  provider: string;
  status: 'ok' | 'error' | 'rejected';
  content?: string;
  errorCode?: CompareErrorCode;
  latencyMs: number;
  selectToken?: string;
}

export interface CompareResponseBody {
  compareId: string;
  prompt: string;
  issuedAt: number;
  results: CompareResult[];
  /** ENG-113: binds the whole set of ok columns, so /compare/select can trust the unchosen answers. Present when >= 2 columns are ok. */
  alternativesToken?: string;
}

/** HTTP-shaped outcome so handlers stay thin: `res.status(out.status).json(out.body)`. */
export interface ServiceOutcome<T = unknown> {
  status: number;
  body: T;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------
export interface CompareUser {
  userId: string;
  isAdmin: boolean;
}

/** The subset of a chat session this feature reads. */
export interface CompareSession {
  sessionId: string;
  userId: string;
  portalType?: NonNullable<ChatMessage['metadata']>['portalType'];
  messages?: ChatMessage[];
}

export interface CompareModelInfo {
  name: string;
  provider: string;
  isLive: boolean;
  /** Internal models (e.g. research agents) are not chat models for anyone. */
  internalOnly: boolean;
}

export interface CompareModelDecision {
  effectiveModel: string | null;
  modelSelection: string;
}

export interface CompareUsageStatus {
  allowed: boolean;
  month?: string | null;
  /** ENG-668: set when the block is pay-as-you-go's own (cap reached / suspended / not covered). */
  paygBlock?: UsageBlockPaygInput;
}

export interface CompareDeps {
  isAcceptingWork(): boolean;
  isFeatureEnabled(): Promise<boolean>;
  /** Plan add-on gate (see modelCompareEntitlement). Omitted = not gated. */
  isEntitled?(user: CompareUser): Promise<boolean>;
  /**
   * ENG-669 (D3): the SESSION OWNER's tier runs fewer than two models, so no comparison is possible. Null = not
   * blocked (also while the tier allowlist is off). Omitted = not gated.
   */
  getTierCompareBlock?(ownerUserId: string): Promise<{ tier: string | null; upgradeRequired: string[] } | null>;
  /**
   * ENG-669 PR-C: whether the AgentWeb Model router is on. While it is, `agentweb-model` is refused as a Compare column
   * (it is a router, not one model; v0 compares concrete models only). Read only when a column names it.
   * Omitted = off (the id is an unknown model, rejected per column as before).
   */
  isAgentWebModelRouterEnabled?(): Promise<boolean>;
  getSession(sessionId: string): Promise<CompareSession | null>;
  checkUsage(userId: string): Promise<CompareUsageStatus>;
  /** Builds the 429 body fields shared with /generate (message + structured usageBlock). */
  buildUsageBlock(month: string | null | undefined, paygBlock?: UsageBlockPaygInput): { message: string };
  normalizeModelId(model: string): string;
  resolveModel(input: { userId: string; requestedModel: string }): Promise<CompareModelDecision>;
  getModelInfo(model: string): CompareModelInfo | null;
  isPriced(model: string): boolean;
  /**
   * Did the model the gateway reports as having answered correspond to the one that was requested?
   * Only the selected model may ever answer a comparison column.
   */
  servedModelMatches(requestedCanonical: string, served: unknown): boolean | Promise<boolean>;
  /** Resolves a billing owner id for metering (org members pool onto the owner). */
  resolveBillingUserId(userId: string): Promise<string>;
  callLLM(model: string, messages: Array<{ role: string; content: string }>, options: CompareCallOptions): Promise<unknown>;
  /**
   * ENG-55: provider data-collection policy (AW-Settings `model_compare_deny_data_collection`).
   * Omitted or null => no policy, i.e. the request is exactly what it was before. Must not throw.
   */
  getProviderPolicy?(): Promise<CompareProviderPolicy | null>;
  /** Throws when the server secret is unavailable. */
  getSecret(): string;
  now(): number;
  newId(): string;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The exact options object handed to callLLM. Deliberately has no tools/webSearch/fallbackModels. */
export interface CompareCallOptions {
  max_completion_tokens: number;
  timeoutMs: number;
  taskClass: 'interactive_chat';
  usageContext: { userId: string; billingUserId: string; feature: string; sessionId: string };
  /** ENG-55: present only when the data-collection switch is on; merged into the OpenRouter `provider` object. */
  providerPolicy?: CompareProviderPolicy;
}

export interface SelectDeps {
  isAcceptingWork(): boolean;
  isFeatureEnabled(): Promise<boolean>;
  /** Plan add-on gate (see modelCompareEntitlement). Omitted = not gated. */
  isEntitled?(user: CompareUser): Promise<boolean>;
  /** `consistentRead` is requested for the re-read under the lock (replay/guard must see our own writes). */
  getSession(sessionId: string, options?: { consistentRead?: boolean }): Promise<CompareSession | null>;
  tryClaim(sessionId: string, ownerUserId?: string): boolean;
  release(sessionId: string): void;
  appendMessages(sessionId: string, messages: ChatMessage[]): Promise<{ messages?: ChatMessage[] }>;
  updateSessionModel(sessionId: string, model: string): Promise<unknown>;
  maxSessionMessages: number;
  getSecret(): string;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
  /** ENG-113: AW-Settings `compare_save_alternatives` (exact 'true'). Omitted => off. Must not throw. */
  isSaveAlternativesEnabled?(): Promise<boolean>;
  /** ENG-113: server registry lookup for the saved alternatives' display name/provider (never taken from the client). */
  getModelInfo?(model: string): CompareModelInfo | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): ServiceOutcome {
  return { status, body: { error, code, ...extra } };
}

/** The plan does not include Compare models. Neutral wording; checked before any session read, lock or model call. */
function notEntitledOutcome(): ServiceOutcome {
  return fail(403, 'Compare models is not available on your current plan.', 'model_compare_not_entitled');
}

/** ENG-669 (D3): the owner's plan runs fewer than two models. Checked before any usage read, lock or model call. */
function tierCompareBlockedOutcome(block: { tier: string | null; upgradeRequired: string[] }): ServiceOutcome {
  return fail(
    403,
    'Comparing models needs at least two models, and your current plan includes fewer. Upgrade your plan to compare models.',
    'compare_not_available_for_tier',
    { tier: block.tier, upgradeRequired: block.upgradeRequired },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Select token
// ---------------------------------------------------------------------------
export interface SelectTokenFields {
  userId: string;
  sessionId: string;
  compareId: string;
  prompt: string;
  model: string;
  content: string;
  issuedAt: number;
}

/** Purpose-specific key: the raw JWT secret is never used directly as the HMAC key. */
export function deriveSelectTokenKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(SELECT_TOKEN_KEY_LABEL).digest();
}

/** Fixed key order (object literal insertion order) => deterministic bytes. */
export function canonicalSelectPayload(fields: SelectTokenFields): string {
  return JSON.stringify({
    userId: fields.userId,
    sessionId: fields.sessionId,
    compareId: fields.compareId,
    prompt: fields.prompt,
    model: fields.model,
    contentSha256: sha256Hex(fields.content),
    issuedAt: fields.issuedAt,
  });
}

export function signSelectToken(secret: string, fields: SelectTokenFields): string {
  return createHmac('sha256', deriveSelectTokenKey(secret)).update(canonicalSelectPayload(fields)).digest('hex');
}

/** Constant-time; tolerates a caller-supplied value of any type/length. */
export function verifySelectToken(secret: string, fields: SelectTokenFields, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(signSelectToken(secret, fields), 'utf8');
  const given = Buffer.from(supplied, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Alternatives (SET) token - ENG-113
// ---------------------------------------------------------------------------
const ALTERNATIVES_TOKEN_KIND = 'compare-alternatives-set:v1';

export interface AlternativesTokenFields {
  userId: string;
  sessionId: string;
  compareId: string;
  prompt: string;
  issuedAt: number;
  /** EVERY ok column of the comparison (the chosen one included), in any order. */
  columns: ReadonlyArray<{ model: string; content: string }>;
}

/**
 * Same key derivation as the select token, with a `kind` tag inside the payload so a select token can never be
 * replayed as a set token (or the reverse). Columns are sorted by model so the order the client sends is irrelevant.
 * The setting state is deliberately NOT part of it: the token is issued whether or not saving is on.
 */
export function canonicalAlternativesPayload(fields: AlternativesTokenFields): string {
  const columns = fields.columns
    .map((c) => ({ model: c.model, contentSha256: sha256Hex(c.content) }))
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return JSON.stringify({
    kind: ALTERNATIVES_TOKEN_KIND,
    userId: fields.userId,
    sessionId: fields.sessionId,
    compareId: fields.compareId,
    prompt: fields.prompt,
    issuedAt: fields.issuedAt,
    columns,
  });
}

export function signAlternativesToken(secret: string, fields: AlternativesTokenFields): string {
  return createHmac('sha256', deriveSelectTokenKey(secret)).update(canonicalAlternativesPayload(fields)).digest('hex');
}

/** Constant-time; tolerates a caller-supplied value of any type/length. */
export function verifyAlternativesToken(secret: string, fields: AlternativesTokenFields, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(signAlternativesToken(secret, fields), 'utf8');
  const given = Buffer.from(supplied, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------
function isReplayableTurn(message: ChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (typeof message.content !== 'string' || message.content.trim().length === 0) return false;
  // An assistant turn that issued tool calls is only half of an exchange without its
  // tool results, which are deliberately not replayed.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  const meta = message.metadata;
  if (meta) {
    if (meta.isErrorMessage || meta.isRunFailureNotice || meta.jobIncomplete || meta.isDiagnosticMessage) return false;
    if (meta.isContextMessage) return false;
    // Server-authored directives (e.g. media auto-continuation) are not customer turns.
    if (meta.kind === 'auto-continuation') return false;
  }
  return true;
}

/**
 * System prompt + the most recent plain user/assistant text turns (chronological) + the
 * new prompt. Tool/system messages are excluded. Budgeted newest-first so the turns
 * nearest the new prompt survive when the history is long. The result always alternates
 * roles strictly (user first, user last): leading assistant turns are dropped and
 * consecutive same-role turns (e.g. around an errored turn) are merged, because several
 * providers reject or mishandle consecutive same-role messages.
 */
export function buildCompareMessages(history: readonly ChatMessage[] | undefined, prompt: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const picked: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let budget = MAX_CONTEXT_CHARS;
  const turns = (history ?? []).filter(isReplayableTurn);
  for (let i = turns.length - 1; i >= 0 && picked.length < MAX_CONTEXT_MESSAGES && budget > 0; i--) {
    const text = (turns[i].content as string).slice(0, Math.min(MAX_CONTEXT_MESSAGE_CHARS, budget));
    budget -= text.length;
    picked.push({ role: turns[i].role as 'user' | 'assistant', content: text });
  }
  picked.reverse();
  while (picked.length > 0 && picked[0].role !== 'user') picked.shift();

  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of picked) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${turn.content}`.slice(0, MAX_CONTEXT_MESSAGE_CHARS);
    } else {
      merged.push({ ...turn });
    }
  }
  const tail = merged[merged.length - 1];
  if (tail && tail.role === 'user') {
    // The new prompt stays intact and last; only the replayed part is ever truncated.
    tail.content = `${tail.content.slice(0, MAX_CONTEXT_MESSAGE_CHARS)}\n\n${prompt}`;
    return [{ role: 'system', content: COMPARE_SYSTEM_PROMPT }, ...merged];
  }
  return [{ role: 'system', content: COMPARE_SYSTEM_PROMPT }, ...merged, { role: 'user', content: prompt }];
}

/**
 * /compare/select appends a user+assistant pair; buildMarketingContext slices off message 0
 * (startIdx = 1) and /generate only writes the system prompt for a session with no user
 * turn. A started chat is therefore one with at least one user turn, wherever the system
 * message sits (a skill-started chat has an assistant welcome at 0 and the system message at
 * 1, and real turns work fine there). Appending to a session without a user turn would hide
 * the pair from later context. Shared by both routes so they cannot drift; /compare uses it
 * as a preflight so no model is billed for a result that could never be continued.
 */
function sessionNotStartedOutcome(history: readonly ChatMessage[] | undefined): ServiceOutcome | null {
  // A fresh sidebar chat already has its system message but no turn yet: require a user turn too.
  if (!history || !history.some((m) => m.role === 'user')) {
    return fail(409, 'Send a message in this chat before continuing from a comparison.', 'compare_session_not_started');
  }
  return null;
}

// ---------------------------------------------------------------------------
// /compare
// ---------------------------------------------------------------------------
export interface ValidatedCompareRequest {
  sessionId: string;
  prompt: string;
  models: string[];
}

export function validateCompareRequest(body: unknown): { ok: true; value: ValidatedCompareRequest } | { ok: false; outcome: ServiceOutcome } {
  const bad = (error: string, code: string) => ({ ok: false as const, outcome: fail(400, error, code) });
  if (!isPlainObject(body)) return bad('Request body must be a JSON object', 'invalid_request');
  const { sessionId, prompt, models } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_ID_CHARS) {
    return bad('sessionId is required', 'invalid_session_id');
  }
  if (typeof prompt !== 'string') return bad('prompt is required', 'invalid_prompt');
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return bad('prompt must not be empty', 'invalid_prompt');
  if (trimmed.length > MAX_PROMPT_CHARS) {
    return bad(`prompt must be at most ${MAX_PROMPT_CHARS} characters`, 'prompt_too_long');
  }
  if (!Array.isArray(models)) return bad('models must be an array', 'invalid_models');
  // Bound before inspecting elements so an enormous array is never walked.
  if (models.length < MIN_COMPARE_MODELS || models.length > MAX_COMPARE_MODELS) {
    return bad(`Select between ${MIN_COMPARE_MODELS} and ${MAX_COMPARE_MODELS} models`, 'invalid_model_count');
  }
  const cleaned: string[] = [];
  for (const entry of models) {
    if (typeof entry !== 'string') return bad('models must be strings', 'invalid_models');
    const id = entry.trim();
    if (id.length === 0 || id.length > MAX_MODEL_ID_CHARS) return bad('models must be non-empty model ids', 'invalid_models');
    cleaned.push(id);
  }
  return { ok: true, value: { sessionId, prompt: trimmed, models: cleaned } };
}

/** Process-local in-flight counter (per instance); limits fan-out amplification while the usage ledger lags. */
const inFlightCompares = new Map<string, number>();
export function __resetCompareInFlightForTests(): void {
  inFlightCompares.clear();
}

function extractText(response: unknown): { text: string; finishReason: string | null } {
  const choice = (response as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> } | null | undefined)
    ?.choices?.[0];
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  const content = choice?.message?.content;
  if (typeof content === 'string') return { text: content, finishReason };
  if (Array.isArray(content)) {
    return {
      text: content
        .map((part) => (isPlainObject(part) && typeof part.text === 'string' ? part.text : ''))
        .join(''),
      finishReason,
    };
  }
  return { text: '', finishReason };
}

/**
 * Is `served` (the model the gateway says answered) the SAME model as `upstreamModel` (the gateway id we
 * requested)? OpenRouter reports its CANONICAL slug, which is dated (`openai/gpt-5.5` ->
 * `openai/gpt-5.5-20260423`) and for some Claude models also reordered (`anthropic/claude-opus-4.8` ->
 * `anthropic/claude-4.8-opus-20260528`). So: same vendor prefix, trailing date dropped, and the remaining
 * `-` tokens compared as an order-insensitive multiset (a version like `4.8` is one atom, so 4.6 != 6.4).
 * A longer or different name is a DIFFERENT model (`gpt-5.5-pro`, `gpt-5.5-mini`, `gpt-5`), as is any
 * `:variant` or other vendor. Metering's tolerant prefix matcher is deliberately not used.
 */
export function isSameServedModel(
  upstreamModel: string,
  served: unknown,
  /**
   * Other registered upstream ids. A base id (`deepseek/deepseek-v4-pro`) must not accept the dated slug of a
   * registered MMDD sibling (`deepseek/deepseek-v4-pro-0813` -> `...-20260813`), which the date-stripping alone
   * cannot tell apart from the base id's own snapshot. Callers also pass the live catalog's ids so a sibling
   * that exists upstream but is not registered yet is refused too.
   */
  knownUpstreamIds: Iterable<string> = [],
): boolean {
  if (typeof served !== 'string' || typeof upstreamModel !== 'string') return false;
  const want = splitServedModel(upstreamModel);
  const got = splitServedModel(served);
  if (!want || !got || want.vendor !== got.vendor) return false;

  const wantMmdd = trailingMmdd(want.tokens);
  if (wantMmdd) {
    // A trailing MMDD is part of the model identity: the id itself, or its full-date canonical slug
    // whose date ends in the same MMDD (`-0813` <-> `-20260813`) over identical base tokens.
    if (!got.date) return sameTokens(want.tokens, got.tokens);
    return got.date.slice(4) === wantMmdd && sameTokens(want.tokens.slice(0, -1), got.tokens);
  }
  if (!sameTokens(want.tokens, got.tokens)) return false;
  if (got.date) {
    for (const known of knownUpstreamIds) {
      const sibling = typeof known === 'string' ? splitServedModel(normalizeCatalogId(known)) : null;
      const m = sibling && sibling.vendor === want.vendor ? trailingMmdd(sibling.tokens) : null;
      if (sibling && m && !sibling.date && got.date.slice(4) === m && sameTokens(sibling.tokens.slice(0, -1), want.tokens)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Catalog/registry ids come in forms a served slug never does: `:free` / `:nitro` variants, a trailing `/`,
 * an `openrouter/` registry prefix, mixed case. All of them name the same sibling model, so reduce to `vendor/name`.
 */
export function normalizeCatalogId(id: string): string {
  let out = id.trim().toLowerCase();
  const colon = out.indexOf(':');
  if (colon >= 0) out = out.slice(0, colon);
  out = out.replace(/\/+$/, '');
  return out.startsWith('openrouter/') ? out.slice('openrouter/'.length) : out;
}

/** Does this served slug carry a snapshot date (`-20260423` / `-2026-04-23`)? Only those need sibling disambiguation. */
export function isDatedServedSlug(served: unknown): boolean {
  return typeof served === 'string' && splitServedModel(served)?.date != null;
}

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of b) {
    const n = counts.get(t);
    if (!n) return false;
    counts.set(t, n - 1);
  }
  return true;
}

/** Last token as `MMDD` (month 01-12, day 01-31), only when it is not the whole name. */
function trailingMmdd(tokens: string[]): string | null {
  const last = tokens[tokens.length - 1];
  if (tokens.length < 2 || !/^\d{4}$/.test(last)) return null;
  const month = Number(last.slice(0, 2));
  const day = Number(last.slice(2));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? last : null;
}

function splitServedModel(id: string): { vendor: string; tokens: string[]; date: string | null } | null {
  const trimmed = id.trim().toLowerCase();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const vendor = trimmed.slice(0, slash);
  const rawName = trimmed.slice(slash + 1);
  const dm = /-(\d{4})-?(\d{2})-?(\d{2})$/.exec(rawName);
  const dated = dm && /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(rawName) ? dm : null;
  const name = dated ? rawName.slice(0, dated.index) : rawName;
  if (!name || name.includes(':') || name.includes('/')) return null;
  const tokens = name.split('-');
  if (tokens.some((t) => t.length === 0)) return null;
  return { vendor, tokens, date: dated ? `${dated[1]}${dated[2]}${dated[3]}` : null };
}

function mapCallError(error: unknown, policy: CompareProviderPolicy | null | undefined, modelKnown: boolean): { errorCode: CompareErrorCode; errorClass: string } {
  let errorClass = 'unknown';
  try {
    // classifyToolErrorClass tolerates non-Error values, but never let classification itself throw.
    errorClass = classifyToolErrorClass(error);
  } catch {
    /* keep 'unknown' */
  }
  if (isProviderPolicyUnavailableError(error, policy, modelKnown)) {
    return { errorCode: COMPARE_PROVIDER_POLICY_UNAVAILABLE_CODE, errorClass };
  }
  return { errorCode: errorClass === 'timeout' ? 'timeout' : 'upstream_error', errorClass };
}

type Candidate = {
  requested: string;
  canonical: string;
  info: CompareModelInfo | null;
  /** Set when the model must not run; otherwise it is dispatched. */
  rejection?: CompareErrorCode;
};

export async function compareModels(
  deps: CompareDeps,
  input: { user: CompareUser; body: unknown },
): Promise<ServiceOutcome> {
  if (!deps.isAcceptingWork()) {
    return { status: 503, body: { message: 'Instance draining — retry on new instance' } };
  }
  if (!(await deps.isFeatureEnabled())) {
    return fail(503, 'Model comparison is currently unavailable', 'model_compare_disabled');
  }
  if (deps.isEntitled && !(await deps.isEntitled(input.user))) return notEntitledOutcome();
  const parsed = validateCompareRequest(input.body);
  if (!parsed.ok) return parsed.outcome;
  const { sessionId, prompt, models } = parsed.value;
  if (models.includes(AGENTWEB_MODEL_ID) && deps.isAgentWebModelRouterEnabled && await deps.isAgentWebModelRouterEnabled()) {
    return fail(
      400,
      'The AgentWeb Model picks a different model per task, so it cannot be a comparison column. Compare specific models instead.',
      'agentweb_model_not_comparable',
    );
  }

  const session = await deps.getSession(sessionId);
  if (!session) return fail(404, 'Session not found', 'session_not_found');
  // Same owner-or-admin predicate (and deliberately distinct 403) as /generate (ENG-346).
  if (session.userId !== input.user.userId && !input.user.isAdmin) {
    return fail(403, 'Unauthorized access to session', 'forbidden');
  }

  // ENG-669 (D3): judged for the SESSION OWNER, like every column below, before any spend.
  const tierBlock = deps.getTierCompareBlock ? await deps.getTierCompareBlock(session.userId) : null;
  if (tierBlock) return tierCompareBlockedOutcome(tierBlock);

  // Before any usage check or spend: a session that select would refuse is refused here.
  const notStarted = sessionNotStartedOutcome(session.messages);
  if (notStarted) return notStarted;

  // Fail closed BEFORE any spend: without the secret no result could be selected.
  try {
    deps.getSecret();
  } catch {
    deps.log('ModelCompare: select-token secret unavailable; refusing to fan out');
    return fail(500, 'Model comparison is temporarily unavailable', 'compare_unavailable');
  }

  const usage = await deps.checkUsage(input.user.userId);
  if (!usage.allowed) return usagePausedOutcome(deps, usage);

  // Canonicalize first (aliases must not count as two models), then dedupe and re-check count.
  // normalizeModelId indexes an alias table with the raw id, so ids such as 'constructor' or
  // '__proto__' can come back as non-strings; fall back to the requested id so the model is
  // rejected cleanly (not in the registry) and `model`/`name` stay strings.
  const canonical = models.map((m) => {
    const resolved: unknown = deps.normalizeModelId(m);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : m;
  });
  if (new Set(canonical).size !== canonical.length) {
    return fail(400, 'Each model may be selected only once', 'duplicate_models');
  }

  const inFlight = inFlightCompares.get(input.user.userId) ?? 0;
  if (inFlight >= MAX_CONCURRENT_COMPARES_PER_USER) {
    return fail(429, 'A comparison is already running. Please wait for it to finish.', 'compare_in_progress');
  }
  inFlightCompares.set(input.user.userId, inFlight + 1);
  try {
    // Classify every model (policy reads are I/O) in parallel, and finish ALL of it before
    // the first model call so a paused policy anywhere in the list never spends.
    const candidates: Candidate[] = await Promise.all(
      models.map((m, i) => classifyCandidate(deps, input.user, session.userId, m, canonical[i])),
    );
    const billingUserId = await deps.resolveBillingUserId(session.userId).catch(() => session.userId);
    const messages = buildCompareMessages(session.messages, prompt);
    const issuedAt = deps.now();
    const compareId = deps.newId();
    const secret = deps.getSecret();

    const settled = await Promise.allSettled(
      candidates.map((c) => runOne(deps, c, messages, {
        userId: session.userId,
        billingUserId,
        sessionId,
      })),
    );

    const results: CompareResult[] = settled.map((outcome, i) => {
      const c = candidates[i];
      const base = {
        model: c.canonical,
        name: c.info?.name ?? c.canonical,
        provider: c.info?.provider ?? 'other',
      };
      if (outcome.status === 'rejected') {
        // runOne catches everything itself; this is a belt-and-braces mapping.
        deps.log('ModelCompare: unexpected fan-out rejection', { model: c.canonical });
        return { ...base, status: 'error', errorCode: 'upstream_error', latencyMs: 0 };
      }
      const r = outcome.value;
      if (r.status !== 'ok') return { ...base, ...r };
      return {
        ...base,
        ...r,
        selectToken: signSelectToken(secret, {
          userId: session.userId,
          sessionId,
          compareId,
          prompt,
          model: c.canonical,
          content: r.content as string,
          issuedAt,
        }),
      };
    });

    const body: CompareResponseBody = { compareId, prompt, issuedAt, results };
    const okColumns = results.filter((r) => r.status === 'ok' && typeof r.content === 'string');
    if (okColumns.length >= 2) {
      body.alternativesToken = signAlternativesToken(secret, {
        userId: session.userId,
        sessionId,
        compareId,
        prompt,
        issuedAt,
        columns: okColumns.map((r) => ({ model: r.model, content: r.content as string })),
      });
    }
    return { status: 200, body };
  } catch (error) {
    // A paused policy blocks every model; surface it exactly like /generate.
    if (error instanceof UsagePausedError) return usagePausedOutcome(deps, usage);
    deps.log('ModelCompare: compare failed', { errorClass: safeClass(error) });
    return fail(500, 'Failed to compare models', 'compare_failed');
  } finally {
    const remaining = (inFlightCompares.get(input.user.userId) ?? 1) - 1;
    if (remaining <= 0) inFlightCompares.delete(input.user.userId);
    else inFlightCompares.set(input.user.userId, remaining);
  }
}

class UsagePausedError extends Error {
  constructor() {
    super('usage_paused');
    this.name = 'UsagePausedError';
  }
}

function safeClass(error: unknown): string {
  try {
    return classifyToolErrorClass(error);
  } catch {
    return 'unknown';
  }
}

function usagePausedOutcome(deps: CompareDeps, usage: CompareUsageStatus): ServiceOutcome {
  const block = deps.buildUsageBlock(usage.month, usage.paygBlock);
  return {
    status: 429,
    // Same shape as /generate's non-policy 429 (agentModeController generateResponse).
    body: { error: block.message, usageBlock: block, code: 'usage_paused', usageMode: 'paused' },
  };
}

async function classifyCandidate(
  deps: CompareDeps,
  user: CompareUser,
  ownerId: string,
  requested: string,
  canonical: string,
): Promise<Candidate> {
  // Entitlement is evaluated for the SESSION OWNER (`ownerId`), not the caller: an admin comparing
  // inside someone else's session gets the owner's model set. Consistent with /generate.
  const info = deps.getModelInfo(canonical);
  const candidate: Candidate = { requested, canonical, info };
  if (!info) return { ...candidate, rejection: 'model_unavailable' };
  if (info.isLive) return { ...candidate, rejection: 'model_live_unsupported' };
  // Compare has NO role logic: every user and admin may compare any model they can select. Who can
  // select what is decided in one place only (the registry + usage-policy resolver below, which also
  // applies the owner's tier allowlist, ENG-669), never by the model's name (a name-based "opus" deny
  // was ruled stale in ENG-2028) and never here.
  if (info.internalOnly) return { ...candidate, rejection: 'model_unavailable' };

  let decision: CompareModelDecision;
  try {
    decision = await deps.resolveModel({ userId: ownerId, requestedModel: canonical });
  } catch (error) {
    // Fail closed: an unresolvable policy never turns into a call.
    deps.log('ModelCompare: model policy resolution failed', { model: canonical, errorClass: safeClass(error) });
    return { ...candidate, rejection: 'model_unavailable' };
  }
  if (decision.modelSelection === 'blocked') {
    // Paused: the whole request is refused, same as /generate.
    throw new UsagePausedError();
  }
  // P7: anything other than the requested model being honored is a rejection, never a swap.
  if (decision.modelSelection !== 'honored' || decision.effectiveModel !== canonical) {
    return { ...candidate, rejection: 'model_unavailable' };
  }
  if (!deps.isPriced(canonical)) return { ...candidate, rejection: 'model_unpriced' };
  return candidate;
}

async function runOne(
  deps: CompareDeps,
  candidate: Candidate,
  messages: Array<{ role: string; content: string }>,
  ctx: { userId: string; billingUserId: string; sessionId: string },
): Promise<Pick<CompareResult, 'status' | 'content' | 'errorCode' | 'latencyMs'>> {
  if (candidate.rejection) {
    return { status: 'rejected', errorCode: candidate.rejection, latencyMs: 0 };
  }
  const started = deps.now();
  let policy: CompareProviderPolicy | null = null;
  try {
    policy = (await deps.getProviderPolicy?.()) ?? null;
  } catch {
    policy = null; // never let the privacy switch read break a column
  }
  try {
    const options: CompareCallOptions = {
      max_completion_tokens: COMPARE_MAX_OUTPUT_TOKENS,
      timeoutMs: COMPARE_TIMEOUT_MS,
      taskClass: 'interactive_chat',
      usageContext: {
        userId: ctx.userId,
        billingUserId: ctx.billingUserId,
        feature: COMPARE_FEATURE,
        sessionId: ctx.sessionId,
      },
      ...(policy ? { providerPolicy: policy } : {}),
    };
    const response = await deps.callLLM(candidate.canonical, messages, options);
    const latencyMs = Math.max(0, deps.now() - started);
    // The selected model must be the ONLY one that answers. The request names no fallback chain, so the
    // gateway should serve exactly it; verify what it reports and discard anything else rather than
    // label another model's answer with the selected model's name (or sign it for "Continue").
    const served = (response as { model?: unknown } | null | undefined)?.model;
    if (typeof served === 'string' && served.trim() !== '' && !(await deps.servedModelMatches(candidate.canonical, served))) {
      deps.log('ModelCompare: a different model answered than the one selected', { requested: candidate.canonical, served });
      return { status: 'error', errorCode: 'model_mismatch', latencyMs };
    }
    const { text, finishReason } = extractText(response);
    // A `length` stop is a truncated answer (possibly all reasoning, no text): never offer
    // it for "Continue", whether or not any text came back.
    if (finishReason === 'length') {
      return { status: 'error', errorCode: 'output_limit', latencyMs };
    }
    if (text.trim().length === 0) {
      return { status: 'error', errorCode: 'empty_response', latencyMs };
    }
    return { status: 'ok', content: text, latencyMs };
  } catch (error) {
    const latencyMs = Math.max(0, deps.now() - started);
    const { errorCode, errorClass } = mapCallError(error, policy, !!candidate.info);
    // Class only: provider error text can echo the prompt or carry provider internals.
    deps.log('ModelCompare: model call failed', { model: candidate.canonical, errorClass });
    return { status: 'error', errorCode, latencyMs };
  }
}

// ---------------------------------------------------------------------------
// /compare/select
// ---------------------------------------------------------------------------
export interface ValidatedSelectRequest extends Omit<SelectTokenFields, 'userId'> {
  selectToken: string;
}

export function validateSelectRequest(body: unknown): { ok: true; value: ValidatedSelectRequest } | { ok: false; outcome: ServiceOutcome } {
  const bad = (error: string, code: string) => ({ ok: false as const, outcome: fail(400, error, code) });
  if (!isPlainObject(body)) return bad('Request body must be a JSON object', 'invalid_request');
  const { sessionId, compareId, prompt, model, content, issuedAt, selectToken } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_ID_CHARS) {
    return bad('sessionId is required', 'invalid_session_id');
  }
  if (typeof compareId !== 'string' || !UUID_RE.test(compareId)) return bad('compareId is invalid', 'invalid_compare_id');
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    return bad('prompt is invalid', 'invalid_prompt');
  }
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_ID_CHARS) {
    return bad('model is invalid', 'invalid_models');
  }
  if (typeof content !== 'string' || content.trim().length === 0) return bad('content is required', 'invalid_content');
  if (content.length > MAX_SELECT_CONTENT_CHARS) return bad('content is too long', 'content_too_long');
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    return bad('issuedAt is invalid', 'invalid_issued_at');
  }
  // Hex SHA-256 HMAC is 64 chars; anything else cannot match, so reject cheaply with the same code.
  if (typeof selectToken !== 'string' || selectToken.length === 0 || selectToken.length > 256) {
    return bad('selectToken is invalid', 'invalid_select_token');
  }
  return { ok: true, value: { sessionId, compareId, prompt, model, content, issuedAt, selectToken } };
}

export async function selectCompareResult(
  deps: SelectDeps,
  input: { user: CompareUser; body: unknown },
): Promise<ServiceOutcome> {
  // Any unexpected throw (session read, settings read, anything before the lock) must be observable and
  // JSON, never the global handler's generic 500. Class and a truncated message only, never content.
  try {
    return await selectCompareResultInner(deps, input);
  } catch (error) {
    let message = '';
    try {
      message = String((error as Error)?.message ?? '').slice(0, 200);
    } catch {
      /* keep empty */
    }
    deps.log('ModelCompare: select failed unexpectedly', { errorClass: safeClass(error), message });
    return fail(500, 'Failed to continue from this answer', 'select_failed');
  }
}

async function selectCompareResultInner(
  deps: SelectDeps,
  input: { user: CompareUser; body: unknown },
): Promise<ServiceOutcome> {
  if (!deps.isAcceptingWork()) {
    return { status: 503, body: { message: 'Instance draining — retry on new instance' } };
  }
  if (!(await deps.isFeatureEnabled())) {
    return fail(503, 'Model comparison is currently unavailable', 'model_compare_disabled');
  }
  if (deps.isEntitled && !(await deps.isEntitled(input.user))) return notEntitledOutcome();
  const parsed = validateSelectRequest(input.body);
  if (!parsed.ok) return parsed.outcome;
  const req = parsed.value;

  const session = await deps.getSession(req.sessionId);
  if (!session) return fail(404, 'Session not found', 'session_not_found');
  if (session.userId !== input.user.userId && !input.user.isAdmin) {
    return fail(403, 'Unauthorized access to session', 'forbidden');
  }

  // Authenticate the payload BEFORE any session write or lock.
  let secret: string;
  try {
    secret = deps.getSecret();
  } catch {
    deps.log('ModelCompare: select-token secret unavailable');
    return fail(500, 'Model comparison is temporarily unavailable', 'compare_unavailable');
  }
  const fields: SelectTokenFields = { ...req, userId: session.userId };
  if (!verifySelectToken(secret, fields, req.selectToken)) {
    return fail(400, 'Invalid or tampered comparison result', 'invalid_select_token');
  }
  const now = deps.now();
  if (now - req.issuedAt > SELECT_TOKEN_TTL_MS || req.issuedAt - now > SELECT_TOKEN_FUTURE_SKEW_MS) {
    return fail(410, 'This comparison has expired. Run it again.', 'compare_expired');
  }

  if (!deps.tryClaim(req.sessionId, session.userId)) {
    return fail(409, 'A response is already being generated for this session. Please wait.', 'SESSION_BUSY', {
      message: 'A response is already being generated for this session. Please wait.',
    });
  }
  try {
    // Re-read under the lock: the pre-lock copy may be stale.
    const fresh = await deps.getSession(req.sessionId, { consistentRead: true });
    if (!fresh) return fail(404, 'Session not found', 'session_not_found');
    const history = fresh.messages ?? [];

    // Defence in depth: /compare already checked this, but the session may have changed.
    const notStarted = sessionNotStartedOutcome(history);
    if (notStarted) return notStarted;

    // Replay: the same selection already persisted as the last user+assistant pair.
    const replay = findPersistedPair(history, req);
    if (replay) {
      return { status: 200, body: { messages: replay, llmModel: req.model, replayed: true } };
    }

    // A comparison yields at most one pair: a different column of the same comparison (same signed
    // prompt, persisted at/after its issuedAt) must not append a second pair or override the choice.
    // A later comparison with the same prompt has a later issuedAt and is unaffected.
    if (hasResolvedComparison(history, req)) {
      return fail(409, 'An answer from this comparison was already added to the chat.', 'compare_already_selected');
    }

    if (history.length + 2 > deps.maxSessionMessages) {
      return fail(409, 'This session has reached its message limit. Start a new session to continue.', 'SESSION_MESSAGE_LIMIT_EXCEEDED');
    }

    // Never stamp before the comparison's issuedAt: a select instance whose clock lags the compare
    // instance would otherwise persist a stamp the >= issuedAt guards (409 / replay) cannot see.
    const stamp = new Date(Math.max(now, req.issuedAt)).toISOString();
    // Same shapes /generate persists for a normal turn (user: generateSessionResponse's
    // userMessageObj; assistant: the loop's responseMessage with `llm`), minus usage —
    // the per-call usage was already metered when the comparison ran.
    const userMessage: ChatMessage = {
      role: 'user',
      content: req.prompt,
      timestamp: stamp,
      metadata: { timestamp: stamp, portalType: fresh.portalType ?? 'agent', attachments: [] },
    };
    let assistantMessage: ChatMessage = {
      role: 'assistant',
      content: req.content,
      timestamp: stamp,
      llm: req.model,
      metadata: { timestamp: stamp, portalType: fresh.portalType ?? 'agent' },
    };
    // ENG-113: reached only for a NEW pair (an exact replay returned above and never rewrites anything). Any
    // problem with the alternatives leaves the chosen answer exactly as it was.
    const alternatives = await verifiedAlternatives(deps, secret, session.userId, req, input.body);
    if (alternatives) assistantMessage = withSavedAlternatives(assistantMessage, req.compareId, alternatives);

    const saved = await deps.appendMessages(req.sessionId, [userMessage, assistantMessage]);
    const tail = (saved?.messages ?? []).slice(-2);
    const persisted = tail.length === 2 ? tail : [userMessage, assistantMessage];

    try {
      await deps.updateSessionModel(req.sessionId, req.model);
    } catch (error) {
      // The turn is already persisted; a replay will detect it. Surface via logs only.
      deps.log('ModelCompare: failed to update session model after select', { errorClass: safeClass(error) });
    }
    return { status: 200, body: { messages: persisted, llmModel: req.model } };
  } catch (error) {
    deps.log('ModelCompare: select failed', { errorClass: safeClass(error) });
    return fail(500, 'Failed to continue from this answer', 'select_failed');
  } finally {
    deps.release(req.sessionId);
  }
}

/**
 * ENG-113: the unchosen answers, accepted ONLY when every one of these holds; otherwise null (and the select
 * still succeeds for the chosen answer):
 *  - the AW-Settings switch is on (the setting state is not part of the token);
 *  - the body has 1-3 well-formed `{model, content, latencyMs?}` entries with distinct models, none equal to the
 *    chosen model, each content a non-empty string <= MAX_SELECT_CONTENT_CHARS;
 *  - `alternativesToken` verifies (constant-time) over {user, session, compareId, prompt, issuedAt} and the SET of
 *    {model, sha256(content)} made of these alternatives PLUS the chosen answer - so the set is exactly the ok columns
 *    the server produced: nothing can be added, edited, dropped or re-attributed;
 *  - display name/provider come from the server registry, never from the request.
 */
async function verifiedAlternatives(
  deps: SelectDeps,
  secret: string,
  ownerId: string,
  req: ValidatedSelectRequest,
  rawBody: unknown,
): Promise<SavedAlternative[] | null> {
  const body = rawBody as Record<string, unknown>;
  if (!isPlainObject(body) || body.alternatives === undefined || body.alternatives === null) return null;
  try {
    if (!deps.isSaveAlternativesEnabled || !(await deps.isSaveAlternativesEnabled())) return null;
    const ignore = (reason: string): null => {
      deps.log('ModelCompare: ignoring saved alternatives', { reason });
      return null;
    };
    const raw = body.alternatives;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COMPARE_ALTERNATIVES) return ignore('shape');
    const seen = new Set<string>([req.model]);
    const parsed: Array<{ model: string; content: string; latencyMs: number }> = [];
    for (const entry of raw) {
      if (!isPlainObject(entry)) return ignore('entry');
      const { model, content, latencyMs } = entry;
      if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_ID_CHARS || seen.has(model)) return ignore('model');
      if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_SELECT_CONTENT_CHARS) return ignore('content');
      seen.add(model);
      const ms = typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? Math.round(latencyMs) : 0;
      parsed.push({ model, content, latencyMs: Math.min(MAX_ALTERNATIVE_LATENCY_MS, Math.max(0, ms)) });
    }
    const fields: AlternativesTokenFields = {
      userId: ownerId,
      sessionId: req.sessionId,
      compareId: req.compareId,
      prompt: req.prompt,
      issuedAt: req.issuedAt,
      columns: [{ model: req.model, content: req.content }, ...parsed],
    };
    if (!verifyAlternativesToken(secret, fields, body.alternativesToken)) return ignore('token');
    return parsed.map((a) => {
      const info = deps.getModelInfo?.(a.model) ?? null;
      return { model: a.model, name: info?.name ?? a.model, provider: info?.provider ?? 'other', content: a.content, latencyMs: a.latencyMs };
    });
  } catch (error) {
    deps.log('ModelCompare: saved alternatives check failed; ignoring', { errorClass: safeClass(error) });
    return null;
  }
}

/** Most recent messages scanned when looking for an already-persisted selection (replay). */
const REPLAY_SCAN_MAX_MESSAGES = 500;

function hasResolvedComparison(history: readonly ChatMessage[], req: ValidatedSelectRequest): boolean {
  const lowest = Math.max(0, history.length - REPLAY_SCAN_MAX_MESSAGES);
  for (let i = history.length - 1; i >= lowest; i--) {
    const m = history[i];
    if (m.role !== 'user' || m.content !== req.prompt || typeof m.timestamp !== 'string') continue;
    const at = Date.parse(m.timestamp);
    if (Number.isFinite(at) && at >= req.issuedAt) return true;
  }
  return false;
}

function findPersistedPair(history: readonly ChatMessage[], req: ValidatedSelectRequest): ChatMessage[] | null {
  // Scan the history newest-first (bounded, O(n)): a late replay must be recognised even after
  // further turns were appended. The timestamp >= issuedAt guard keeps an identical earlier turn
  // that predates the comparison from being mistaken for a replay.
  const issuedIso = new Date(req.issuedAt).toISOString();
  const lowest = Math.max(1, history.length - REPLAY_SCAN_MAX_MESSAGES);
  for (let i = history.length - 1; i >= lowest; i--) {
    const assistant = history[i];
    const user = history[i - 1];
    if (
      user.role === 'user' && user.content === req.prompt
      && typeof user.timestamp === 'string' && user.timestamp >= issuedIso
      && assistant.role === 'assistant' && assistant.content === req.content && assistant.llm === req.model
    ) {
      return [user, assistant];
    }
  }
  return null;
}

/** Production dependency helpers kept here so the controller stays wiring-only. */
export function newCompareId(): string {
  return randomUUID();
}
