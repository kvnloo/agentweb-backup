/**
 * AI-drafted golden-case label suggestions (ENG-2200, ENG-2128).
 *
 * 130 golden cases were seeded into AW-EvalGoldenCases and need a human to label them one by one
 * through /eval-labelling — slow. This script speeds that up with an AI drafting pass: for each
 * unlabelled, non-pairwise case it resolves the real source content (never a judge's own prior
 * verdict on that content — see the resolvers below), asks an LLM to suggest a label + rationale
 * per criterion, and writes it to the case's advisory `draft` field via `store.saveDraft`.
 *
 * A draft is never the ground truth and never counts toward `isFullyLabelled`: a human reviews
 * and explicitly accepts/edits/rejects every suggestion in the partner portal before it becomes a
 * real label. AI-generated labels cannot themselves validate the AI judges this golden set exists
 * to validate — that would be circular.
 *
 * Usage (default AWS profile; NODE_ENV=development reads the Dev- table):
 *   npm run eval:draft-labels -- \
 *     [--surface agent|creative|account_health] [--model <id>] [--force] [--dry-run] [--limit N] [--yes]
 * (equivalently: npx ts-node --transpile-only src/scripts/generateGoldenDraftLabels.ts ...)
 *
 * It first prints a preflight (resolved table, surface, number of cases it would draft, model). A
 * non-dry run without --yes stops there with exit 1: no LLM call, no write. --dry-run still calls
 * the LLM but prints only criterion and draft label, never the rationale text.
 *
 * Never run this against the real EVAL_GOLDEN_CASES_TABLE production table from an agent session
 * — verify with unit tests and --dry-run only; a human runs the real batch after PR review.
 */

import { agentModeService } from '../services/agentModeService';
import { chatbotDb, type ChatMessage, type ChatSession } from '../services/chatbotService';
import { humanEvalService, type HumanEvalCandidate } from '../services/humanEvalService';
import { userDb, type User } from '../services/db';
import { gatherAccountHealthSignals, type AccountHealthUser } from '../cron/accountHealthClassifierCron';
import type { AccountHealthSignals, CampaignDeliveryInput } from '../services/accountHealthClassifier';
import type { AdConnectionAccount } from '../services/clientHealthService';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import {
  criteriaFor,
  isFullyLabelled,
  parseDraft,
  GoldenCaseValidationError,
  type GoldenCase,
  type GoldenCriterion,
  type GoldenCaseDraft,
} from '../loops/eval/goldenSet';
import { goldenSetStoreFromEnv, type GoldenSetStore } from '../loops/eval/goldenSetStore';
import type { EvalSurface } from '../loops/eval/evalRegistry';

export const DEFAULT_DRAFT_LABEL_MODEL = 'anthropic.claude-sonnet-4-6';
const SURFACES: readonly EvalSurface[] = ['agent', 'creative', 'account_health'];
/** Small pacing gap between sequential LLM calls — this hits a real LLM and, live, prod DynamoDB. */
const LLM_CALL_DELAY_MS = 250;

// Copied verbatim from partner-portal/src/pages/EvalLabelling.tsx's CRITERION_HELP map — that
// file is the source of truth for these descriptions; keep both in sync if either changes.
const CRITERION_HELP: Record<string, string> = {
  task_success: 'Pass = the final state is what the user asked for. Fail = not done, partly done, or claimed done when it was not (a withheld action the user told it to take is not done). N/A only if there was no task at all (a greeting, an empty message).',
  tool_correctness: 'Pass = tools were called with sensible arguments and their results were checked and used (a failure that was noticed and recovered from is still a pass). Fail = wrong tool or arguments, the same avoidable error 3+ times, results ignored or misread, or a failure the reply never mentions. N/A only if no tool was called.',
  groundedness: 'Pass = every factual claim in the replies is supported by a tool result, the user\'s words, or the prompt shown in the transcript. Fail = any claim that is invented or that nothing in the transcript supports, even if it might come from hidden memory. N/A only if there are no factual claims.',
  instruction_compliance: 'N/A = no explicit instruction at all (greeting, bare question, empty message). Pass = every explicit instruction (an action, a constraint such as \"don\'t ask first\" or \"keep it short\", a format) was followed the first time. Fail = any was missed, only partly met, or needed repeating. Retry nudges restate the original instruction.',
  argued_with_instruction: 'Pass = the agent refused, pushed back on, or asked approval for an explicit, safe instruction instead of doing it. Fail = it did not (it did it, declined something unsafe, impossible or out of scope, or only asked a needed clarifying question). N/A = there was no explicit instruction to do something.',
  escalated_when_not_required: 'Pass = the agent handed work or a decision back to the human when it could have finished it itself with the tools and information it had. Fail = it did not, including when the hand-off was needed because of a real blocker or missing information.',
  failed_to_escalate: 'Pass = the agent hit a blocker it could not fix and neither reported it nor told the user (dropped it, papered over it, or pretended success). Fail = otherwise: there was no blocker, or the blocker was reported.',
  hook: 'Stops the scroll in the first second',
  offer: 'A clear, specific offer',
  proof_integrity: 'Proof points are real, not invented. N/A only if the creative makes no proof claim; any number, testimonial, superlative or guarantee counts as a claim.',
  brand_fidelity: 'Matches the brand colours, logo and tone',
  format_readiness: 'Right size and layout for the placement',
  policy_risk: 'Pass = no ad-policy risk',
  buyer_usefulness: 'Useful to the target buyer',
  activation_incomplete: 'Pass = the account never finished setup (never connected an ad platform). Judge the state today; exactly one of the three states is Pass. N/A for a deleted or synthetic account.',
  at_risk: 'Pass = was working, now at risk (expired, revoked, stopped)',
  healthy: 'Pass = connected and working',
};

interface TextContentBlock {
  type: 'text';
  text: string;
}
interface ImageContentBlock {
  type: 'image_url';
  image_url: { url: string };
}
type ContentBlock = TextContentBlock | ImageContentBlock;

export type ContentResolution = { ok: true; content: string | ContentBlock[] } | { ok: false; reason: string };

/** agent surface (sourceRef.kind === 'sessionId'): the session transcript, or a skip if it's gone. */
export function serializeAgentTranscript(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => {
      const who = m.role === 'tool' ? `tool${m.name ? `:${m.name}` : ''}` : m.role;
      const toolCalls = m.tool_calls && m.tool_calls.length > 0 ? `\n  tool_calls: ${JSON.stringify(m.tool_calls)}` : '';
      return `[${who}] ${m.content}${toolCalls}`;
    })
    .join('\n\n');
}

export async function resolveAgentContent(
  getChatSession: (sessionId: string) => Promise<ChatSession | null>,
  sessionId: string,
): Promise<ContentResolution> {
  const session = await getChatSession(sessionId);
  if (!session) return { ok: false, reason: `chat session ${sessionId} not found` };
  return { ok: true, content: serializeAgentTranscript(session.messages ?? []) };
}

/**
 * creative surface (sourceRef.kind === 'candidateId'): only originalRequest, outputSummary,
 * artifactUrl and reviewType — never creativeGates/creativeRubric/creativePairwise, which are
 * existing judge outputs. Feeding a judge's own verdict into the prompt that drafts a label meant
 * to validate that judge would contaminate the ground truth, so those fields are never read here.
 */
export async function resolveCreativeContent(
  getCandidate: (candidateId: string) => Promise<HumanEvalCandidate | null>,
  candidateId: string,
): Promise<ContentResolution> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) return { ok: false, reason: `human-eval candidate ${candidateId} not found` };
  const { originalRequest, outputSummary, artifactUrl, reviewType } = candidate;
  const isImage = reviewType === 'creative_image' && Boolean(artifactUrl);
  const lines = [
    `reviewType: ${reviewType}`,
    originalRequest ? `originalRequest: ${originalRequest}` : undefined,
    `outputSummary: ${outputSummary}`,
    // On an image candidate the artifact is attached below as an image block instead of a URL line.
    artifactUrl && !isImage ? `artifactUrl: ${artifactUrl}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const text = lines.join('\n');
  if (isImage) {
    return { ok: true, content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: artifactUrl as string } }] };
  }
  return { ok: true, content: text };
}

/**
 * A criteria-relevant, allowlisted view of one connected account: never account_id, account_name,
 * scopes, access_token or refresh_token — `signals.connectedAccounts` carries those as live,
 * unencrypted OAuth credentials (AW-Users `connected_accounts[].config`), and this text is about
 * to be sent to an external LLM.
 */
interface AccountHealthPromptAccount {
  platform?: string;
  accountType?: string;
  hasUsableToken: boolean;
  tokenExpiresAt?: number;
}

/** Same allowlisting for a delivery row: campaignId is an identifier this drafting task has no need for. */
type AccountHealthPromptCampaign = Omit<CampaignDeliveryInput, 'campaignId'>;

interface AccountHealthPromptView {
  nowMs: number;
  hasLegacyAdAccount: boolean;
  connectedAccounts: AccountHealthPromptAccount[];
  requirement: AccountHealthSignals['requirement'];
  subscriptionStatus?: string;
  currentPeriodEnd?: string;
  payments: AccountHealthSignals['payments'];
  campaigns: AccountHealthPromptCampaign[] | null;
  recentAdSpend: AccountHealthSignals['recentAdSpend'];
  lastActiveAt?: string | null;
  adDays?: AccountHealthSignals['adDays'];
  feedback?: AccountHealthSignals['feedback'];
  tracking?: AccountHealthSignals['tracking'];
}

export function toAccountHealthPromptView(signals: AccountHealthSignals): AccountHealthPromptView {
  const accounts = (signals.connectedAccounts ?? []).filter((a): a is AdConnectionAccount => a != null);
  return {
    nowMs: signals.nowMs,
    hasLegacyAdAccount: Boolean(signals.legacyAdAccount),
    connectedAccounts: accounts.map((a) => ({
      platform: a.platform,
      accountType: a.config?.account_type,
      hasUsableToken: typeof a.config?.token_expires_at !== 'number' || a.config.token_expires_at > signals.nowMs || Boolean(a.config?.refresh_token),
      tokenExpiresAt: a.config?.token_expires_at,
    })),
    requirement: signals.requirement,
    subscriptionStatus: signals.subscriptionStatus,
    currentPeriodEnd: signals.currentPeriodEnd,
    payments: signals.payments,
    campaigns: signals.campaigns ? signals.campaigns.map(({ campaignId: _campaignId, ...rest }) => rest) : null,
    recentAdSpend: signals.recentAdSpend,
    lastActiveAt: signals.lastActiveAt,
    adDays: signals.adDays,
    feedback: signals.feedback,
    tracking: signals.tracking,
  };
}

/**
 * account_health surface (sourceRef.kind === 'userId'): ONLY the gathered signals, never
 * classifyAccountHealth's output. The parameter type below is AccountHealthSignals, not
 * AccountHealthClassification — it is structurally impossible to pass the classifier's own
 * verdict into the drafting prompt, since that verdict is exactly what the golden label is meant
 * to independently validate.
 */
export function buildAccountHealthContentText(signals: AccountHealthSignals): string {
  return JSON.stringify(toAccountHealthPromptView(signals), null, 2);
}

export async function resolveAccountHealthContent(
  getUserById: (userId: string) => Promise<User | undefined>,
  gatherSignals: (user: AccountHealthUser, nowMs: number) => Promise<{ signals: AccountHealthSignals }>,
  userId: string,
  nowMs: number,
): Promise<ContentResolution> {
  const user = await getUserById(userId);
  if (!user?.userId) return { ok: false, reason: `user ${userId} not found` };
  const { signals } = await gatherSignals(user as unknown as AccountHealthUser, nowMs);
  return { ok: true, content: buildAccountHealthContentText(signals) };
}

export interface GenerateDraftDeps {
  getChatSession: (sessionId: string) => Promise<ChatSession | null>;
  getCandidate: (candidateId: string) => Promise<HumanEvalCandidate | null>;
  getUserById: (userId: string) => Promise<User | undefined>;
  gatherAccountHealthSignals: (user: AccountHealthUser, nowMs: number) => Promise<{ signals: AccountHealthSignals }>;
  callLLM: (
    model: string,
    messages: unknown[],
    opts: Record<string, unknown>,
  ) => Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
  store: Pick<GoldenSetStore, 'listCases' | 'saveDraft'>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

async function resolveContent(deps: GenerateDraftDeps, c: GoldenCase, nowMs: number): Promise<ContentResolution> {
  switch (c.surface) {
    case 'agent':
      return resolveAgentContent(deps.getChatSession, c.sourceRef.id);
    case 'creative':
      return resolveCreativeContent(deps.getCandidate, c.sourceRef.id);
    case 'account_health':
      return resolveAccountHealthContent(deps.getUserById, deps.gatherAccountHealthSignals, c.sourceRef.id, nowMs);
  }
}

export function buildDraftSystemPrompt(surface: EvalSurface, criteria: readonly GoldenCriterion[]): string {
  const defs = criteria.map((c) => `- ${c}: ${CRITERION_HELP[c] ?? ''}`).join('\n');
  return [
    'You are DRAFTING a suggested label for a human reviewer building a golden evaluation set that will ' +
      'be used to validate other AI judges. Your output is an advisory SUGGESTION only — never the ground ' +
      'truth. A human will accept, edit or reject every criterion before it becomes a real label. Do not ' +
      'claim certainty you do not have; use "na" when a criterion genuinely does not apply to this case.',
    '',
    `Criteria for this ${surface} case:`,
    defs,
    '',
    'Respond with ONLY strict JSON, one entry per criterion listed above, each an object with a ' +
      '"label" of "pass", "fail" or "na" and a "rationale" of at most 240 characters, for example:',
    `{ ${criteria.map((c) => `"${c}": {"label": "pass", "rationale": "..."}`).join(', ')} }`,
  ].join('\n');
}

function buildUserMessage(content: string | ContentBlock[], taskType: string): { role: 'user'; content: string | ContentBlock[] } {
  const intro = `Case type: ${taskType}\n\n`;
  if (typeof content === 'string') return { role: 'user', content: intro + content };
  return { role: 'user', content: [{ type: 'text', text: intro }, ...content] };
}

export interface DraftResult {
  status: 'drafted' | 'skipped';
  reason?: string;
  draft?: GoldenCaseDraft;
}

/** Resolves content, calls the LLM, and validates its output. Never throws — a bad case is a skip. */
export async function draftLabelsForCase(deps: GenerateDraftDeps, c: GoldenCase, model: string): Promise<DraftResult> {
  let resolved: ContentResolution;
  try {
    resolved = await resolveContent(deps, c, deps.now().getTime());
  } catch (error) {
    return { status: 'skipped', reason: `content resolution failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!resolved.ok) return { status: 'skipped', reason: resolved.reason };

  const messages = [
    { role: 'system', content: buildDraftSystemPrompt(c.surface, c.criteria) },
    buildUserMessage(resolved.content, c.taskType),
  ];

  let response: { choices?: Array<{ message?: { content?: string } }> };
  try {
    response = await deps.callLLM(model, messages, {
      temperature: 0,
      max_completion_tokens: 2000,
      response_format: { type: 'json_object' },
      // Deliberately no userId: system spend, not billed to any customer (mirrors
      // finalize_guard_shadow_judge's usageContext in agentModeService.ts).
      usageContext: { feature: 'golden_draft_label_generator' },
      taskClass: 'nonstandard_consumer',
    });
  } catch (error) {
    return { status: 'skipped', reason: `LLM call failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const raw = response?.choices?.[0]?.message?.content;
  let labels: unknown;
  try {
    labels = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch (error) {
    return { status: 'skipped', reason: `malformed LLM JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  let draft: GoldenCaseDraft;
  try {
    draft = parseDraft(c.surface, c.criteria, { labels, model, generatedAt: deps.now().toISOString() });
  } catch (error) {
    return { status: 'skipped', reason: error instanceof GoldenCaseValidationError ? error.message : String(error) };
  }
  // A missing criterion (empty or partial LLM reply) would otherwise save a draft that still
  // blocks selectCandidateCases from re-attempting this case on the next run without --force.
  const missing = c.criteria.filter((criterion) => draft.labels[criterion] === undefined);
  if (missing.length > 0) return { status: 'skipped', reason: `LLM omitted criteria: ${missing.join(', ')}` };
  return { status: 'drafted', draft };
}

/** Non-pairwise, not already fully labelled, and no existing draft unless --force. */
export function selectCandidateCases(cases: readonly GoldenCase[], force: boolean): GoldenCase[] {
  return cases.filter((c) => {
    if (c.pair !== undefined) return false;
    if (isFullyLabelled(c)) return false;
    if (c.draft && !force) return false;
    return true;
  });
}

export async function collectCandidates(
  deps: Pick<GenerateDraftDeps, 'store'>,
  opts: Pick<CliOptions, 'surface' | 'force' | 'limit'>,
): Promise<GoldenCase[]> {
  const surfaces = opts.surface ? [opts.surface] : SURFACES;
  const all: GoldenCase[] = [];
  for (const surface of surfaces) {
    const cases = await deps.store.listCases(surface);
    all.push(...selectCandidateCases(cases, opts.force));
  }
  return opts.limit !== undefined ? all.slice(0, opts.limit) : all;
}

export interface RunSummary {
  processed: number;
  drafted: number;
  skipped: number;
}

/** Dry-run print: criterion and draft label only. Rationales can quote customer text, so they are never printed. */
export function redactedDraftSummary(draft: GoldenCaseDraft): string {
  return Object.entries(draft.labels)
    .map(([criterion, entry]) => `${criterion}=${entry?.label}`)
    .join(' ');
}

export async function run(deps: GenerateDraftDeps, opts: CliOptions): Promise<RunSummary> {
  const candidates = await collectCandidates(deps, opts);
  const summary: RunSummary = { processed: 0, drafted: 0, skipped: 0 };
  for (const c of candidates) {
    summary.processed++;
    const result = await draftLabelsForCase(deps, c, opts.model);
    if (result.status === 'skipped') {
      summary.skipped++;
      console.log(`[generateGoldenDraftLabels] ${c.caseId}: skipped (${result.reason})`);
    } else {
      if (opts.dryRun) {
        summary.drafted++;
        console.log(`[generateGoldenDraftLabels] ${c.caseId}: would draft (dry-run) ${redactedDraftSummary(result.draft as GoldenCaseDraft)}`);
      } else {
        try {
          await deps.store.saveDraft(c.caseId, result.draft as GoldenCaseDraft);
          summary.drafted++;
          console.log(`[generateGoldenDraftLabels] ${c.caseId}: drafted`);
        } catch (error) {
          summary.skipped++;
          console.log(`[generateGoldenDraftLabels] ${c.caseId}: save failed (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
    await deps.sleep(LLM_CALL_DELAY_MS);
  }
  console.log(
    `[generateGoldenDraftLabels] done: processed=${summary.processed} drafted=${summary.drafted} skipped=${summary.skipped}` +
      (opts.dryRun ? ' (dry-run: nothing written)' : ''),
  );
  return summary;
}

export interface CliOptions {
  surface?: EvalSurface;
  model: string;
  force: boolean;
  dryRun: boolean;
  limit?: number;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const operand = argv[i + 1];
    if (operand === undefined || operand.startsWith('--')) throw new Error(`${flag} needs a value`);
    return operand;
  };

  const surfaceRaw = value('--surface');
  if (surfaceRaw !== undefined && !(SURFACES as readonly string[]).includes(surfaceRaw)) {
    throw new Error(`--surface must be one of ${SURFACES.join(', ')}`);
  }

  const model = value('--model') ?? DEFAULT_DRAFT_LABEL_MODEL;
  if (!LLM_MODEL_REGISTRY[model]) {
    throw new Error(`--model '${model}' is not in LLM_MODEL_REGISTRY`);
  }

  const limitRaw = value('--limit');
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) throw new Error('--limit must be a positive integer');
    limit = n;
  }

  return {
    surface: surfaceRaw as EvalSurface | undefined,
    model,
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    limit,
  };
}

/** `--yes` is the explicit go-ahead for a non-dry run; kept out of CliOptions so parseArgs's shape is unchanged. */
export function hasYesFlag(argv: readonly string[]): boolean {
  return argv.includes('--yes');
}

/** Lines naming exactly what a run would touch, printed before any LLM call or write. */
export function buildPreflight(info: { tableName: string | null; opts: CliOptions; wouldDraft: number }): string[] {
  const { tableName, opts, wouldDraft } = info;
  return [
    '[generateGoldenDraftLabels] preflight',
    `  table:   ${tableName ?? '(not provisioned)'}`,
    `  surface: ${opts.surface ?? 'all'}`,
    `  cases it would draft: ${wouldDraft}`,
    `  model:   ${opts.model}`,
    `  mode:    ${opts.dryRun ? 'dry-run (LLM is called, nothing is written)' : 'LIVE (calls the LLM and writes drafts)'}`,
  ];
}

/**
 * Preflight, then run. Returns the process exit code. A non-dry run without --yes prints the
 * preflight and returns 1 before any LLM call or write.
 */
export async function runCli(
  argv: readonly string[],
  deps: GenerateDraftDeps,
  tableName: string | null,
  log: (line: string) => void = console.log,
): Promise<number> {
  const opts = parseArgs(argv);
  if (tableName === null) {
    console.error('Golden-set store not provisioned: set EVAL_GOLDEN_CASES_TABLE.');
    return 1;
  }
  const candidates = await collectCandidates(deps, opts);
  for (const line of buildPreflight({ tableName, opts, wouldDraft: candidates.length })) log(line);
  if (!opts.dryRun && !hasYesFlag(argv)) {
    log('Refusing to run live without --yes. Re-run with --yes (a human, against the intended table), or use --dry-run.');
    return 1;
  }
  await run(deps, opts);
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const store = goldenSetStoreFromEnv();
  const deps: GenerateDraftDeps = {
    getChatSession: (sessionId) => chatbotDb.getChatSession(sessionId),
    getCandidate: (candidateId) => humanEvalService.getCandidate(candidateId),
    getUserById: (userId) => userDb.getUserById(userId) as Promise<User | undefined>,
    gatherAccountHealthSignals: (user, nowMs) => gatherAccountHealthSignals(user, nowMs),
    callLLM: (model, messages, callOpts) => agentModeService.callLLM(model, messages as never[], callOpts as never),
    store,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  process.exit(await runCli(argv, deps, store.tableName));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
