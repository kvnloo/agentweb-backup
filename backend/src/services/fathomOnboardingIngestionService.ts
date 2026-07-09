import { LLMService } from '../utils/llmService';
import { accountMemoryDb, crmDb, orgMemoryDb, userDb } from './db';
import { FathomApiService } from './fathomApiService';
import { getFathomAccessToken } from './fathomTokenService';

type Confidence = 'manual' | 'high' | 'medium' | 'low';
type MatchStatus = 'matched' | 'needs_review';
type IngestionStatus = 'needs_review' | 'reviewed' | 'failed';
type ExtractionState = 'auto_extracted' | 'human_reviewed';

export interface FathomOnboardingSourceReference {
  label: string;
  url: string;
  timestampSeconds?: number;
}

export interface FathomOnboardingContext {
  companyName?: string | null;
  primaryContactName?: string | null;
  primaryContactEmail?: string | null;
  website?: string | null;
  productCategory?: string | null;
  icp?: string | null;
  primaryGtmGoal?: string | null;
  relevantChannels?: string[];
  winMetric?: string | null;
  urgency?: string | null;
  setupBlockers?: string[];
  productFitNotes?: string[];
  featureGapsOrRisks?: string[];
  suggestedFirstWinPath?: string | null;
  competitorsOrToolsMentioned?: string[];
  budgetOrPricingSensitivity?: string | null;
  stakeholders?: string[];
  trialOrPaymentStage?: string | null;
  followUpCommitments?: string[];
  confidenceByField?: Record<string, number>;
  sourceReferences?: FathomOnboardingSourceReference[];
}

export interface FathomOnboardingIngestion {
  recordingId: string;
  recordingUrl?: string;
  status: IngestionStatus;
  extractionState: ExtractionState;
  context: FathomOnboardingContext;
  targetUserId?: string | null;
  targetLead?: Record<string, any> | null;
  matchReason?: string;
  matchConfidence?: Confidence;
  memoryIds: string[];
  orgMemoryIds: string[];
  reviewOwnerUserId: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MatchResult {
  status: MatchStatus;
  confidence: Confidence;
  reason: string;
  userId: string | null;
  lead: Record<string, any> | null;
}

interface IngestInput {
  recordingId?: string | number;
  recordingUrl?: string;
  fathomUserId?: string;
  reviewOwnerUserId: string;
  targetUserId?: string;
  reviewed?: boolean;
  meetingText?: string;
  transcriptText?: string;
  extractedContext?: FathomOnboardingContext;
}

interface IngestDeps {
  userDb: Pick<typeof userDb, 'getUserById' | 'getUserByEmail' | 'getUsersByEmailDomain' | 'updateUser'>;
  crmDb: Pick<typeof crmDb, 'findLeadsByEmail'>;
  accountMemoryDb: Pick<typeof accountMemoryDb, 'addMemory'>;
  orgMemoryDb: Pick<typeof orgMemoryDb, 'addMemory'>;
  llm: Pick<LLMService, 'generateJsonRobust'>;
  getFathomAccessToken?: typeof getFathomAccessToken;
  FathomApiService?: typeof FathomApiService;
  now: () => string;
}

const MAX_INGESTIONS_PER_USER = 25;

const defaultDeps = (): IngestDeps => ({
  userDb,
  crmDb,
  accountMemoryDb,
  orgMemoryDb,
  llm: new LLMService('anthropic.claude-sonnet-4-6', 0, 4096),
  getFathomAccessToken,
  FathomApiService,
  now: () => new Date().toISOString(),
});

const clean = (value?: string | null): string => (value ?? '').trim();
const compact = (values?: Array<string | null | undefined>): string[] =>
  (values ?? []).map((v) => clean(v)).filter(Boolean);

function deriveRecordingId(input: Pick<IngestInput, 'recordingId' | 'recordingUrl'>): string {
  const explicitId = clean(input.recordingId == null ? '' : String(input.recordingId));
  if (explicitId) return explicitId;

  const recordingUrl = clean(input.recordingUrl);
  if (!recordingUrl) return '';

  try {
    const parsed = new URL(recordingUrl);
    const match = parsed.pathname.match(/\/calls\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  } catch {
    const match = recordingUrl.match(/fathom\.video\/calls\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  }
}

function sameLedgerRecording(
  item: FathomOnboardingIngestion,
  next: Pick<FathomOnboardingIngestion, 'recordingId' | 'recordingUrl'>,
): boolean {
  if (String(item.recordingId) === String(next.recordingId)) return true;
  return Boolean(item.recordingUrl && next.recordingUrl && item.recordingUrl === next.recordingUrl);
}

function normalizeDomain(value?: string | null): string | null {
  const raw = clean(value).toLowerCase();
  if (!raw) return null;
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.replace(/^www\./, '') || null;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || null;
  }
}

function normalizeEmail(value?: string | null): string | null {
  const email = clean(value).toLowerCase();
  return email && email.includes('@') ? email : null;
}

function normalizeContext(input: FathomOnboardingContext, recordingUrl?: string): FathomOnboardingContext {
  return {
    ...input,
    companyName: clean(input.companyName) || null,
    primaryContactName: clean(input.primaryContactName) || null,
    primaryContactEmail: normalizeEmail(input.primaryContactEmail),
    website: clean(input.website) || null,
    productCategory: clean(input.productCategory) || null,
    icp: clean(input.icp) || null,
    primaryGtmGoal: clean(input.primaryGtmGoal) || null,
    relevantChannels: compact(input.relevantChannels),
    winMetric: clean(input.winMetric) || null,
    urgency: clean(input.urgency) || null,
    setupBlockers: compact(input.setupBlockers),
    productFitNotes: compact(input.productFitNotes),
    featureGapsOrRisks: compact(input.featureGapsOrRisks),
    suggestedFirstWinPath: clean(input.suggestedFirstWinPath) || null,
    competitorsOrToolsMentioned: compact(input.competitorsOrToolsMentioned),
    budgetOrPricingSensitivity: clean(input.budgetOrPricingSensitivity) || null,
    stakeholders: compact(input.stakeholders),
    trialOrPaymentStage: clean(input.trialOrPaymentStage) || null,
    followUpCommitments: compact(input.followUpCommitments),
    confidenceByField: input.confidenceByField ?? {},
    sourceReferences: input.sourceReferences?.length
      ? input.sourceReferences
      : recordingUrl
        ? [{ label: 'Fathom recording', url: recordingUrl }]
        : [],
  };
}

export async function extractFathomOnboardingContext(
  sourceText: string,
  recordingUrl: string | undefined,
  deps: Pick<IngestDeps, 'llm'>,
): Promise<FathomOnboardingContext> {
  const systemPrompt =
    'Extract onboarding context from a sales, prospect, or onboarding call. ' +
    'Return only JSON. Separate facts from speculation. Use null or [] when a field is missing. ' +
    'Do not invent contact emails, websites, budgets, or timelines.';
  const userPrompt = `Source Fathom URL: ${recordingUrl || 'unknown'}\n\n` +
    'Return this shape: {"companyName":string|null,"primaryContactName":string|null,' +
    '"primaryContactEmail":string|null,"website":string|null,"productCategory":string|null,' +
    '"icp":string|null,"primaryGtmGoal":string|null,"relevantChannels":string[],' +
    '"winMetric":string|null,"urgency":string|null,"setupBlockers":string[],' +
    '"productFitNotes":string[],"featureGapsOrRisks":string[],"suggestedFirstWinPath":string|null,' +
    '"competitorsOrToolsMentioned":string[],"budgetOrPricingSensitivity":string|null,' +
    '"stakeholders":string[],"trialOrPaymentStage":string|null,"followUpCommitments":string[],' +
    '"confidenceByField":Record<string,number>,"sourceReferences":[{"label":string,"url":string,"timestampSeconds"?:number}]}\n\n' +
    sourceText.slice(0, 60000);

  const parsed = await deps.llm.generateJsonRobust<FathomOnboardingContext>(
    systemPrompt,
    userPrompt,
    undefined,
    { userId: 'system', feature: 'fathom_onboarding_ingestion' },
  );
  return normalizeContext(parsed, recordingUrl);
}

export async function matchFathomOnboardingTarget(
  context: FathomOnboardingContext,
  deps: Pick<IngestDeps, 'userDb' | 'crmDb'>,
): Promise<MatchResult> {
  const email = normalizeEmail(context.primaryContactEmail);
  if (email) {
    const user = await deps.userDb.getUserByEmail(email);
    if (user?.userId) {
      return { status: 'matched', confidence: 'high', reason: 'exact_email', userId: user.userId, lead: null };
    }

    const leads = await deps.crmDb.findLeadsByEmail(email);
    if (leads.length === 1) {
      const lead = leads[0];
      if (lead.userId) {
        return { status: 'matched', confidence: 'medium', reason: 'crm_lead_email', userId: lead.userId, lead };
      }
    }
  }

  const websiteDomain = normalizeDomain(context.website);
  const emailDomain = email?.split('@')[1] ?? null;
  const domain = websiteDomain || emailDomain;
  if (domain) {
    const users = await deps.userDb.getUsersByEmailDomain(domain);
    if (users.length === 1 && users[0]?.userId) {
      return { status: 'matched', confidence: 'medium', reason: 'domain', userId: users[0].userId, lead: null };
    }
  }

  return { status: 'needs_review', confidence: 'low', reason: 'manual_review_required', userId: null, lead: null };
}

export function buildFathomOnboardingMemoryContent(
  context: FathomOnboardingContext,
  source: { recordingUrl?: string },
): string {
  const lines = [
    'Fathom-derived onboarding context',
    context.companyName ? `Company: ${context.companyName}` : null,
    context.primaryContactName || context.primaryContactEmail
      ? `Primary contact: ${compact([context.primaryContactName, context.primaryContactEmail]).join(' / ')}`
      : null,
    context.website ? `Website: ${context.website}` : null,
    context.productCategory ? `Product/category: ${context.productCategory}` : null,
    context.icp ? `ICP: ${context.icp}` : null,
    context.primaryGtmGoal ? `Primary GTM goal: ${context.primaryGtmGoal}` : null,
    context.relevantChannels?.length ? `Relevant channels: ${context.relevantChannels.join(', ')}` : null,
    context.winMetric ? `Win metric: ${context.winMetric}` : null,
    context.urgency ? `Urgency/timeline: ${context.urgency}` : null,
    context.setupBlockers?.length ? `Setup blockers: ${context.setupBlockers.join('; ')}` : null,
    context.productFitNotes?.length ? `Product-fit notes: ${context.productFitNotes.join('; ')}` : null,
    context.featureGapsOrRisks?.length ? `Feature gaps/risks: ${context.featureGapsOrRisks.join('; ')}` : null,
    context.suggestedFirstWinPath ? `Suggested first-win path: ${context.suggestedFirstWinPath}` : null,
    context.followUpCommitments?.length ? `Follow-up commitments: ${context.followUpCommitments.join('; ')}` : null,
    source.recordingUrl ? `Source: ${source.recordingUrl}` : null,
  ].filter(Boolean) as string[];

  const content = lines.join('\n');
  return content.length <= 2000 ? content : `${content.slice(0, 1997)}...`;
}

function mergeLedger(
  existing: FathomOnboardingIngestion[] | undefined,
  next: FathomOnboardingIngestion,
): FathomOnboardingIngestion[] {
  const prior = Array.isArray(existing) ? existing : [];
  const withoutCurrent = prior.filter((item) => !sameLedgerRecording(item, next));
  const previous = prior.find((item) => sameLedgerRecording(item, next));
  const merged = {
    ...previous,
    ...next,
    createdAt: previous?.createdAt || next.createdAt,
    memoryIds: next.memoryIds.length > 0 ? next.memoryIds : (previous?.memoryIds || []),
    orgMemoryIds: next.orgMemoryIds.length > 0 ? next.orgMemoryIds : (previous?.orgMemoryIds || []),
  };
  return [merged, ...withoutCurrent].slice(0, MAX_INGESTIONS_PER_USER);
}

async function loadRecordingText(input: IngestInput, deps: IngestDeps): Promise<string> {
  const provided = [input.meetingText, input.transcriptText].map(clean).filter(Boolean).join('\n\n');
  if (provided) return provided;
  if (!input.recordingId || !input.fathomUserId) return '';

  const token = await deps.getFathomAccessToken!(input.fathomUserId);
  if (!token) throw new Error('No Fathom account connected for recording fetch.');

  const api = new deps.FathomApiService!(token);
  const [recording, transcript] = await Promise.all([
    api.getRecording(String(input.recordingId)).catch(() => null),
    api.getTranscript(String(input.recordingId)).catch(() => []),
  ]);

  const summary = [
    recording?.title,
    recording?.default_summary?.short_hand_bullet,
    typeof recording?.default_summary === 'string' ? recording.default_summary : null,
    Array.isArray(recording?.action_items)
      ? recording.action_items.map((item: any) => item.text || item.title || item).join('\n')
      : null,
  ].map(clean).filter(Boolean).join('\n\n');
  const transcriptText = transcript
    .map((turn: any) => `${turn.speaker || 'Speaker'}: ${turn.text || ''}`.trim())
    .filter(Boolean)
    .join('\n');
  return [summary, transcriptText].filter(Boolean).join('\n\n');
}

export async function ingestFathomOnboardingRecording(
  input: IngestInput,
  injectedDeps?: Partial<IngestDeps>,
): Promise<FathomOnboardingIngestion & { target: MatchResult; memoryIds: string[]; orgMemoryIds: string[] }> {
  const deps: IngestDeps = { ...defaultDeps(), ...injectedDeps } as IngestDeps;
  const recordingId = deriveRecordingId(input);
  if (!recordingId) {
    throw new Error('recordingId or Fathom /calls/:id recordingUrl is required.');
  }
  if (!input.reviewOwnerUserId) {
    throw new Error('reviewOwnerUserId is required.');
  }

  const sourceText = await loadRecordingText(input, deps);
  if (!input.extractedContext && !sourceText) {
    throw new Error('meetingText, transcriptText, extractedContext, or fetchable Fathom recording text is required.');
  }
  const context = normalizeContext(
    input.extractedContext || await extractFathomOnboardingContext(sourceText, input.recordingUrl, deps),
    input.recordingUrl,
  );

  const target: MatchResult = input.targetUserId
    ? { status: 'matched', confidence: 'manual', reason: 'manual_target_user', userId: input.targetUserId, lead: null }
    : await matchFathomOnboardingTarget(context, deps);

  const ledgerUserId = target.userId || input.reviewOwnerUserId;
  const ledgerUser = await deps.userDb.getUserById(ledgerUserId);
  if (!ledgerUser) {
    throw new Error(`Target/review user ${ledgerUserId} was not found.`);
  }

  const existing = (ledgerUser as any).fathomOnboardingIngestions as FathomOnboardingIngestion[] | undefined;
  const previous = existing?.find((item) => sameLedgerRecording(item, { recordingId, recordingUrl: input.recordingUrl }));
  const reviewed = input.reviewed === true;
  const status: IngestionStatus = reviewed ? 'reviewed' : 'needs_review';
  const extractionState: ExtractionState = reviewed ? 'human_reviewed' : 'auto_extracted';
  const now = deps.now();
  let memoryIds = previous?.memoryIds || [];
  let orgMemoryIds = previous?.orgMemoryIds || [];

  if (reviewed && target.userId && memoryIds.length === 0) {
    const memoryContent = buildFathomOnboardingMemoryContent(context, { recordingUrl: input.recordingUrl });
    const memory = await deps.accountMemoryDb.addMemory(target.userId, 'insight', memoryContent, undefined, undefined);
    memoryIds = [memory.memoryId];

    const targetUser = target.userId === ledgerUserId ? ledgerUser : await deps.userDb.getUserById(target.userId);
    if (targetUser?.orgId) {
      const orgMemory = await deps.orgMemoryDb.addMemory(targetUser.orgId, 'insight', memoryContent, input.reviewOwnerUserId, undefined);
      orgMemoryIds = [orgMemory.memoryId];
    }
  }

  const next: FathomOnboardingIngestion = {
    recordingId,
    recordingUrl: input.recordingUrl,
    status,
    extractionState,
    context,
    targetUserId: target.userId,
    targetLead: target.lead,
    matchReason: target.reason,
    matchConfidence: target.confidence,
    memoryIds,
    orgMemoryIds,
    reviewOwnerUserId: input.reviewOwnerUserId,
    error: null,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };

  const ledger = mergeLedger(existing, next);
  await deps.userDb.updateUser(ledgerUserId, { fathomOnboardingIngestions: ledger } as any);

  return { ...next, target, memoryIds, orgMemoryIds };
}
