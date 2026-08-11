import { Request, Response } from 'express';
import { AuthenticatedRequest, getUserFromToken } from '../middleware/auth';
import { agentModeService, AgentModeService } from '../services/agentModeService';
import { ABOUT_AGENTWEB_TEAM, getUnattendedExecutionDirective } from '../docs/agentModeSystemPrompt';
import { chatbotDb, updateTaskExecutionStatus, ChatMessage, getEmmaSystemContext } from '../services/chatbotService';
import { scheduleDb, userDb, taskDb, scheduleTemplateDb } from '../services/db';
import { User } from '../types/auth';
import multer from 'multer';
import crypto from 'crypto';
import { uploadFileToS3, uploadScreenshotToS3 } from '../utils/s3Utils';
import { emailService } from '../services/emailService';
import { settingsService } from '../services/settingsService';
import { workPlanService } from '../services/workPlanService';
import { v4 as uuidv4 } from 'uuid';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { resolveInboundAnswer, buildAnswerAcknowledgement, buildReaskDirective, AskUserQuestionError, PendingUserQuestion } from '../services/agentMode/core/askUserQuestion';
import { planScheduledRunResume, isRunFailurePlaceholder } from '../services/agentMode/core/resumePlan';
import { emitProgress, registerProgressCallback, getLatestProgress, progressStore, requestCancel, clearCancel } from '../utils/sseProgress';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { isContextLimitError, isSessionLimitError, isTransientLLMError, isWorkerShutdownError } from '../utils/agentModeErrors';
import { findInFlightJobForSession, claimCompletion, markAwaitingReconnect } from '../services/durableLandingService';
import { formatAttachmentUrls } from '../utils/attachmentFormatting';
import { isCronEnabled } from '../utils/instanceState';
import { resolvePublishAuthorized } from '../utils/schedulePublishApproval';
import { toolCallSucceeded } from '../utils/toolCallOutcome';
import { trackScheduledRun } from '../utils/scheduledRunTracker';
import {
  isRunStoreEnabled,
  interactiveIdempotencyKey,
  createSessionIdempotencyKey,
  claimIdempotency,
  releaseIdempotency,
  recordIdempotencySessionId,
  createRunRecord,
  markRunTerminal,
  IDEM_TTL_INTERACTIVE_S,
} from '../services/agentMode/runStore';
import { stripImageDataForPersistence } from '../services/agentMode/incrementalPersist';
// ENG-446: the single seam that puts canonical marketing-action payloads (ENG-445)
// on existing report/run envelopes. No surface parses or re-ranks on its own.
import { MarketingActionCarrier, normalizeMarketingActions } from '../services/marketingActionEnvelope';
import { DiagnosisContext } from '../services/agentModeService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { collectMediaGeneratedSince, buildTimeoutContinuationMessage } from '../utils/timeoutContinuation';
import {
  reconcileFalseFailureReport,
  ledgerFromSucceededFunctions,
  diffSucceededFunctions,
  appendConfirmedPublishNotice,
  collectConfirmedPublishActions,
  collectPublishActionsSince,
  FalseFailureLedgerEntry,
} from '../utils/falseFailureReport';
import * as loopEventsEmitter from '../services/loopEventsEmitter';
import { fileAutoIssue } from '../services/intakeService';
import { skillService } from '../services/skillService';
import { normalizeEmailList } from '../utils/validation';
import { getAllowedSkills } from '../services/subscriptionService';
import { checkTokenUsage, deriveBlockedByCost } from '../services/tokenUsageService';
import { transcribeSpeech } from '../services/voiceService';
import { summarizeSessionIfNeeded } from '../services/sessionSummaryService';
import { DynamoDB } from 'aws-sdk';

const ZERO_ASSISTANT_REQUEUE_BASE_MS = 15 * 60 * 1000;
const ZERO_ASSISTANT_REQUEUE_MAX_MS = 2 * 60 * 60 * 1000;
const ZERO_ASSISTANT_MAX_REQUEUES = 3;

// ENG-324: durable in-flight lease + reconciliation. The graceful-shutdown drain
// only saves a run that finishes within DRAIN_CEILING_MS (10 min) of SIGTERM; a
// longer run, a SIGKILL, or an OOM kills the process before its catch can persist
// a failure/requeue, leaving the session at messageCount=2 with no run result.
// A live run heartbeats its lease every HEARTBEAT_INTERVAL_MS; a surviving
// instance's reconciler requeues any lease whose heartbeat is older than
// LEASE_STALE_MS (i.e. the owning process died). LEASE_STALE_MS is heartbeat-based
// (not startedAt-based) so a legitimately long run is never falsely reaped.
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 min
const LEASE_STALE_MS = 5 * 60 * 1000; // reap after 5 missed heartbeats
export const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // reconciler sweep cadence
// Per-process identity (mirrors the social executor's INSTANCE_ID) — stamped on
// each lease so a rebooted instance can recognise/reclaim its own prior-life runs.
const SCHEDULED_RUN_INSTANCE_ID: string = require('uuid').v4();

// User-facing fallback shown when a scheduled run terminates with zero assistant
// output because it genuinely ran out of its time/memory/size budget (a big job
// that timed out, hit the context limit, was OOM-killed, or ran but emitted no
// assistant turn). A silent, empty session reads as a total failure to the user
// (ENG-209: a 40-competitor report produced no output). The "split into smaller
// batches" next step only makes sense for THIS class of failure — see
// SCHEDULED_RUN_SYSTEM_ERROR_MESSAGE for the deterministic-error class.
const SCHEDULED_JOB_INCOMPLETE_MESSAGE =
  "This scheduled run stopped before it could produce a response, so no results were generated. " +
  "Large jobs that research many items in a single run — for example, dozens of competitors in one report — " +
  "can exceed the run's time or memory budget and end without finishing. " +
  "The run will be retried automatically. If this keeps happening, split the request into smaller batches " +
  "(fewer items per run) so each run can complete and report its results.";

// ENG-826: user-facing fallback for a zero-output run that failed on a DETERMINISTIC
// system/provider error (e.g. a schema-validation 400, an auth failure, a content
// filter), NOT a time/memory budget overrun. Blaming job size here is misleading and
// the "split into smaller batches" advice is useless — the run would fail identically
// however small it is. The failing session's stored assistant message used to assert
// the budget cause unconditionally, sending anyone debugging from the transcript down
// the wrong path (the ENG-826 gemini-3.5-flash union-schema 400 read as a size limit).
// Wording note: this per-run message is shown for EVERY failed attempt (including the
// early ones that will still auto-retry), so it only promises recording + automatic
// retry + a support contact. The proactive owner email (ENG-826 #1) is sent separately
// and ONLY once the retries are exhausted (see the requeue-exhaustion branch below), so
// it is not claimed here — that would over-promise on attempts that haven't exhausted yet.
const SCHEDULED_RUN_SYSTEM_ERROR_MESSAGE =
  "This scheduled run stopped before it could produce a response, so no results were generated. " +
  "It ran into an unexpected system error — not a time or size limit — so retrying or splitting the " +
  "request into smaller batches won't help on its own. The run has been recorded as failed and will " +
  "be retried automatically. If it keeps failing, please contact support.";

// ENG-826 edge case: a TRANSIENT failure (rate limit, 429/5xx, timeout, dropped
// connection) is neither a size/budget overrun nor a deterministic error. It really
// does recover on retry — so it must NOT get the system-error copy that says "retrying
// won't help" (that copy is only true for deterministic errors). Give it its own honest
// message: temporary, auto-retried, usually self-clearing.
/**
 * ENG-971: the zero-output copy above all opens with "so no results were generated"
 * and closes with "will be retried automatically". Both are false for a run that
 * published to production and then died before writing its summary — and the retry
 * is worse than the wording, because it republishes. This message replaces them for
 * that case, and the requeue is suppressed alongside it.
 */
function zeroAssistantPublishedMessage(actions: string[], willResume: boolean, paused = false): string {
  // No action names means the run's ledger could not be read (Greptile P1). Say that
  // plainly rather than inventing a list or, worse, implying nothing happened — the
  // whole point of this branch is that something may well have gone out.
  const landed = actions.length > 0
    ? 'This scheduled run stopped before it could report back — but it did not stop before doing the work: it '
      + `${actions.join('; ')}. That is live and saved. `
    : 'This scheduled run stopped before it could report back, and I could not confirm how far it got — '
      + 'some of its work may already have gone out. ';
  return willResume
    // Resuming continues the same session from its last settled step, so the rest of
    // the task finishes without repeating what already went out.
    ? landed
      + 'I will pick up where this run left off shortly and finish the rest — '
      + 'what already went out will not be repeated, so there is nothing for you to re-run.'
    // Not safely continuable: a restart would repeat the publish, so we stop and tell
    // the owner rather than leaving a part-finished run to look like a success.
    : landed
      + 'The rest of this run could not be continued safely, and re-running it from the start '
      + 'would repeat what already went out — so it has NOT been retried automatically. '
      + (paused
        // Saying this only when the pause actually persisted: an email cannot stop a
        // cron, so the schedule is what had to change, and the user must know it did.
        ? 'I have paused this schedule so its next run cannot repeat that work — '
          + 'review what is outstanding, then resume the schedule when you are ready.'
        : 'Check whether anything is still outstanding.');
}

const SCHEDULED_RUN_TRANSIENT_ERROR_MESSAGE =
  "This scheduled run stopped before it could produce a response, so no results were generated. " +
  "It hit a temporary problem — a rate limit or a brief service hiccup — not a time or size limit. " +
  "It has been recorded and will be retried automatically, and a transient issue like this usually " +
  "clears on its own. If it keeps happening, please contact support.";

// ENG-764: a run ABANDONED because its owning process died (prod-verified: an EB
// immutable deploy terminated the instance mid-run) is not a budget overrun either.
// The reconciler used to persist the budget copy here, telling the user their job was
// too large and to split it into smaller batches — a misdiagnosis of the user's own
// workload for an outage on our side, and a direct contradiction of the accurate
// "the owning process terminated mid-run" that the same recovery writes to
// session.error. Splitting the request genuinely cannot help: the next deploy would
// interrupt a smaller run just the same. Be honest about the cause, and reassure —
// the requeue (and, on a safe boundary, the ENG-657 resume) recovers it unattended.
const SCHEDULED_RUN_ABANDONED_MESSAGE =
  "This scheduled run was interrupted before it could finish — the server process running it stopped " +
  "mid-run, which normally happens during a routine deployment or restart on our side. " +
  "Nothing is wrong with your request, and splitting it into smaller batches would not have helped. " +
  "The run has been recorded as failed and will be retried automatically. " +
  "If it keeps happening, please contact support.";

// ENG-826: classify a zero-output scheduled-run failure so the persisted message and
// the `failureClass` metadata match the ACTUAL cause. Precedence:
//  1) 'budget' — context-limit, generation timeout, worker OOM/replacement, or a run
//     that emitted no assistant turn: the "split into smaller batches" guidance applies.
//  2) 'transient' — rate limit / 5xx / timeout / dropped connection: recovers on the
//     automatic retry (checked AFTER budget because isContextLimitError is excluded
//     from transient, and worker-shutdown/zero-output are budget-shaped by definition).
//  3) 'system' — everything else (deterministic provider/validation errors like the
//     gemini union-schema 400, auth, content filters): retrying won't help on its own.
// Exported for direct unit testing.
export type ScheduledRunFailureClass = 'budget' | 'transient' | 'system';

export function classifyZeroAssistantFailure(error: unknown): ScheduledRunFailureClass {
  const budgetShaped =
    isContextLimitError(error) ||
    isWorkerShutdownError(error) ||
    isZeroAssistantOutputError(error) ||
    Boolean((error as any)?.isGenerationTimeout);
  if (budgetShaped) return 'budget';
  if (isTransientLLMError(error)) return 'transient';
  return 'system';
}

// The reconciler path has no error object to classify, but it does not need one: a
// stale lease means the owning process died, so it uses SCHEDULED_RUN_ABANDONED_MESSAGE
// directly rather than falling back to the budget copy (ENG-764).
export function zeroAssistantIncompleteMessage(error: unknown): string {
  switch (classifyZeroAssistantFailure(error)) {
    case 'budget':
      return SCHEDULED_JOB_INCOMPLETE_MESSAGE;
    case 'transient':
      return SCHEDULED_RUN_TRANSIENT_ERROR_MESSAGE;
    default:
      return SCHEDULED_RUN_SYSTEM_ERROR_MESSAGE;
  }
}

// ENG-826 (recommendation #4): compact run-health summary surfaced on each schedule
// in the list so an owner can see a run of consecutive failures — e.g. the 3 silent
// gemini-3.5-flash failures in this issue — straight on the card, without opening the
// run-history panel. getScheduledChats deliberately strips the full runResults array
// for payload size, so the client can't derive this itself; we compute it server-side.
export interface ScheduleRunHealth {
  lastRunStatus: 'success' | 'failure' | 'pending_user_input' | null;
  lastRunAt: string | null;
  // Failures counted back from the MOST RECENT run, stopping at the first non-failure.
  // A 'success' or a 'pending_user_input' (parked, awaiting a human) breaks the streak —
  // a park is not a failure. So this reflects an ongoing, unresolved failure run only.
  consecutiveFailures: number;
}

export function computeScheduleRunHealth(runResults: any[] | undefined | null): ScheduleRunHealth {
  const results = Array.isArray(runResults) ? runResults : [];
  if (results.length === 0) {
    return { lastRunStatus: null, lastRunAt: null, consecutiveFailures: 0 };
  }
  const last = results[results.length - 1] || {};
  let consecutiveFailures = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]?.status === 'failure') consecutiveFailures++;
    else break;
  }
  return {
    lastRunStatus: last.status ?? null,
    lastRunAt: last.createdAt ?? null,
    consecutiveFailures,
  };
}

// ENG-657: injected as the user turn when RESUMING an abandoned scheduled run
// (its instance was terminated mid-flight, e.g. by a deploy). The full transcript
// up to the last completed step is already the session history, so the model must
// continue from there — NOT restart the task or re-run steps whose results it can
// already see above.
const SCHEDULED_RUN_RESUME_MESSAGE =
  "[SYSTEM] This scheduled run was interrupted (the machine it was running on was " +
  "replaced) after completing the steps shown above. This is an automated run with no " +
  "human present. Do NOT start over and do NOT repeat any tool call whose result is " +
  "already visible in the history above. Continue from exactly where you left off, using " +
  "the data already gathered, and produce the final deliverable the task asked for.";

/**
 * In-memory set of session IDs that are currently generating a response.
 * Used to reject concurrent /generate requests for the same session with 409.
 * Exported so tests can inspect and reset it.
 */
export const activeSessionGenerations = new Set<string>();

/**
 * Atomically claim the generation lock for a session.
 *
 * Replaces the previous hand-rolled `has()`-then-`add()` pattern that was
 * duplicated at the /generate call sites. Those two statements were only
 * race-free because nothing `await`ed between them; co-locating the
 * check-and-set in a single synchronous function makes the claim atomic by
 * construction — an `await` can never be inserted between the check and the
 * set, so two near-simultaneous requests can never both proceed.
 *
 * @returns `true` if the caller claimed the lock (session was free),
 *          `false` if the session is already generating (caller must reject).
 */
export function tryClaimSessionGeneration(sessionId: string): boolean {
  if (activeSessionGenerations.has(sessionId)) {
    return false;
  }
  activeSessionGenerations.add(sessionId);
  return true;
}

/**
 * Release a session's generation lock. Idempotent — safe to call in a
 * `finally` block whether or not the claim succeeded.
 */
export function releaseSessionGeneration(sessionId: string): void {
  activeSessionGenerations.delete(sessionId);
}

/**
 * Wall-clock timeout for a single agent-mode generation. Without this, a hung
 * LLM call (stuck await, runaway tool loop, never-resolving upstream) keeps
 * the activeSessionGenerations lock held indefinitely — every subsequent
 * /generate request then returns 409 "Session is busy" forever. The lock
 * release lives in a try/finally that only runs when the inner promise
 * settles; Promise.race against this timeout forces a rejection so the
 * finally runs and the lock releases.
 *
 * Note: this does NOT cancel the underlying generation (would require an
 * AbortController plumbed through every layer). The orphaned generation
 * continues in the background until it settles. That's acceptable — the
 * critical thing is that the user-facing lock releases.
 */
const GENERATION_TIMEOUT_MS = parseInt(
  process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || '600000',
  10
); // 10 minutes default — long-running browser/research tasks need > 5 min

async function withGenerationTimeout<T>(
  promise: Promise<T>,
  sessionId: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err: any = new Error(
        `Generation timed out after ${GENERATION_TIMEOUT_MS}ms for session ${sessionId}. ` +
        `The lock has been released; the orphaned generation may still complete in the background.`
      );
      // Tag so the durable-execution path can distinguish a run-timeout (where the
      // detached work may still finish) from a genuine generation error.
      err.isGenerationTimeout = true;
      reject(err);
    }, GENERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Shown when a landing-page build outlives the run timeout but is still running.
 * Replaces the old false "took longer than expected" failure for this case.
 */
const STILL_BUILDING_MESSAGE =
  "🛠️ Your landing page is still building — this one's taking a little longer than usual. " +
  "I'll drop the live link right here the moment it's ready, so there's no need to resend.";

/**
 * Attach a completion handler to a still-running landing-page generation whose run
 * already timed out. When the detached generation finishes, its assistant response
 * has already been persisted to the session by generateSessionResponse — so we only
 * need to (a) claim the completion exactly once (vs the redeploy poller) and
 * (b) push the result to the user's open session over Socket.IO. Best-effort:
 * any failure is logged, never thrown (this runs detached).
 */
function attachInProcessCompletion(
  genPromise: Promise<any>,
  pageId: string,
  userId: string,
  sessionId: string
): void {
  genPromise
    .then(async (resolved: any) => {
      const claimed = await claimCompletion(pageId);
      if (!claimed) return; // the poller already delivered this one
      const { io } = await import('../server');
      io.to(`user:${userId}`).emit('session-message-appended', {
        sessionId,
        message: {
          role: 'assistant',
          content: resolved?.content || '✅ Your landing page is ready.',
        },
      });
    })
    .catch((err: any) =>
      console.error(`AgentMode: in-process completion hook failed for page ${pageId}:`, err)
    );
}

/**
 * Returns the effective expiration date for an interactive share.
 *
 * Only an explicit `expiresAt` causes expiry. Shares created without one —
 * every public plan/ishare link (createSessionWithPlan sets `sharedAt` only)
 * and all legacy shares — never expire on a timer; their availability is
 * governed solely by the `isActive` flag. (Previously, a missing `expiresAt`
 * was treated as "sharedAt + 7 days", which silently 410'd every such link a
 * week after creation and broke all ishare links.)
 */
function getInteractiveShareExpiresAt(share: { expiresAt?: string; sharedAt?: string }): Date {
  if (share.expiresAt) return new Date(share.expiresAt);
  return new Date(8640000000000000); // No expiresAt — never expires
}

/**
 * Auto-files a Linear "Customer Reported" issue for context-limit errors.
 * Skips if the session already has contextLimitReported set (dedup).
 */
async function autoReportContextLimitToLinear(
  sessionId: string | undefined,
  userEmail: string | undefined,
  userId: string | undefined,
  llmModel: string | undefined,
  session: import('../services/chatbotService').ChatSession | null
): Promise<void> {
  if (!sessionId || session?.contextLimitReported) return;
  try {
    await fileAutoIssue({
      title: `Context limit reached - session ${sessionId}`,
      description: `User hit the context window limit in agent mode.\n\nUser: ${userEmail || 'Unknown'}\nModel: ${llmModel || 'Not specified'}\nSession messages: ${session?.messages?.length ?? 'N/A'}\nSession title: ${session?.title || 'N/A'}`,
      source: 'Context limit',
      executionRoute: 'human-triage',
      extraLabels: ['Customer Reported', 'Context Limit'],
      notionContext: {
        'User ID': userId || 'N/A',
        'User Email': userEmail || 'N/A',
        'Session ID': sessionId,
        'LLM Model': llmModel || 'Not specified',
        'Session Message Count': session?.messages?.length ?? 'N/A',
        'Session Title': session?.title || 'N/A',
      },
    });
    chatbotDb.updateSessionContextLimitReported(sessionId).catch(err =>
      console.error('Failed to set contextLimitReported flag:', err)
    );
  } catch (err) {
    console.error('Failed to create context-limit Linear issue:', err);
  }
}

/** Classify an error for the diagnosis agent. */
function classifyErrorType(error: unknown): DiagnosisContext['errorType'] {
  if (isContextLimitError(error)) return 'context_limit';
  if (error instanceof Error) {
    if (error.message.includes('content policies') || error.message.includes('content_filter')) return 'content_filter';
    if (error.message.includes('high demand') || (error as any)?.status === 429) return 'rate_limit';
    if (isTransientLLMError(error)) return 'transient';
  }
  return 'unknown';
}

/** Build a compact work plan summary string for the diagnosis agent. */
function buildWorkPlanSummary(session: any): string | null {
  if (!session?.workPlan?.steps?.length) return null;
  return session.workPlan.steps
    .map((s: any) => `Step ${s.stepCount}: ${s.title} [${s.status}]`)
    .join('\n');
}

/**
 * Invoke the diagnosis agent to produce a context-aware error message.
 * Returns null if diagnosis fails — caller should fall back to the generic message.
 *
 * ENG-971: this is where the production false-failure report was written. The turn
 * hit GENERATION_TIMEOUT_MS three minutes AFTER publish_landing_page_changes had
 * landed and been verified live, so none of the truthful-reporting guards inside
 * generateMarketingResponse (finalize guard, ENG-736 landing reconciler, ENG-971
 * false-failure guard) ran — a thrown turn never reaches that seam. The diagnosis
 * agent was handed only the error and `failedFunctions`, and turned "be specific
 * about what was accomplished" into "your changes were not saved. Please try your
 * request again", risking a re-run of a production deploy that had already landed.
 *
 * Two fixes, both here: the agent is now given the run's SUCCESS ledger
 * (`calledFunctions`, which toolDispatch flushes per iteration and is therefore
 * durable at the moment of the throw), and its output goes through the same
 * deterministic, append-only guard the loop edge uses.
 *
 * The ledger comes back alongside the message because the caller needs it too: when
 * diagnosis is unavailable the generic fallback still ends in "please try sending
 * your message again", and that advice is just as wrong after a landed publish.
 */
interface DiagnosisResult {
  /** The diagnosis agent's message, already reconciled. Null when unavailable. */
  message: string | null;
  /** Publish/deploy calls this run is confirmed to have completed. */
  publishLedger: FalseFailureLedgerEntry[];
}

/**
 * The publish/deploy calls a session is confirmed to have completed. Used on the
 * error branches that never reach the diagnosis agent — a worker shutdown replaces
 * it with a fixed string, and that string still ends in "please send your message
 * again", which is the wrong advice after a landed publish.
 */
async function loadPublishLedger(
  sessionId: string,
  baseline?: Record<string, number> | null,
): Promise<FalseFailureLedgerEntry[] | null> {
  // Retried, because UNKNOWN is no longer a soft outcome: it can stop a scheduled
  // restart and even pause a customer's schedule. A single transient DynamoDB blip
  // must not be enough to trigger that — "unreadable" has to mean actually
  // unreadable, not unlucky once.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      return ledgerFromSucceededFunctions(
        diffSucceededFunctions(baseline, session?.calledFunctions || null),
      );
    } catch (readError) {
      if (attempt === 3) {
        console.error(`loadPublishLedger: session ${sessionId} unreadable after 3 attempts:`, readError);
      }
    }
  }
  try {
    // NULL means UNKNOWN, and that is deliberately not the same as "nothing was
    // published" (Greptile P1). Collapsing the two let a failed read on the
    // scheduled path restart a run from scratch and repeat a production publish.
    // Callers that only annotate a message may treat null as empty; the caller that
    // decides whether to RE-RUN work must not.
    return null;
  } catch {
    return null;
  }
}

async function getDiagnosticErrorMessage(
  error: unknown,
  sessionId: string,
  userMessage: string,
  baseline?: Record<string, number> | null
): Promise<DiagnosisResult> {
  try {
    const session = await chatbotDb.getChatSession(sessionId).catch(() => null);
    // THIS TURN's successes, not the session's lifetime total — see
    // diffSucceededFunctions. "What was accomplished" must mean this request.
    const succeededFunctions = diffSucceededFunctions(baseline, session?.calledFunctions || null);
    const publishLedger = ledgerFromSucceededFunctions(succeededFunctions);
    const context: DiagnosisContext = {
      errorType: classifyErrorType(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      userMessage: userMessage || '',
      workPlanSummary: buildWorkPlanSummary(session),
      failedFunctions: session?.failedFunctions || null,
      succeededFunctions,
    };
    const message = await agentModeService.generateDiagnosticMessage(context);
    return {
      message: message ? reconcileFalseFailureReport(message, publishLedger) : null,
      publishLedger,
    };
  } catch {
    return { message: null, publishLedger: [] };
  }
}

// Common function: ensure a campaign execution exists and contains all HTML report URLs
async function syncEmailCampaignExecution(
  userId: string,
  sessionId: string,
  emailCampaignTaskId: string
): Promise<void> {
  try {
    if (!emailCampaignTaskId) return;

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) return;

    // Collect unique HTML S3 URLs from assistant messages
    const assistantMessages = Array.isArray(session.messages)
      ? session.messages.filter((m: any) => m && m.role === 'assistant' && typeof m.content === 'string')
      : [];
    const htmlUrlRegex = /(https?:\/\/[^\s\"]+\.amazonaws\.com\/[^\s\"]+\.html)/gi;
    const foundUrlsSet = new Set<string>();
    assistantMessages.forEach((msg: any) => {
      let match;
      while ((match = htmlUrlRegex.exec(msg.content)) !== null) {
        foundUrlsSet.add(match[1]);
      }
    });

    const foundUrls = Array.from(foundUrlsSet);
    if (foundUrls.length === 0) return;

    const execId = `agentmode_${sessionId}`;
    const existingExecution = await taskDb.getTaskExecutionById(execId);
    if (!existingExecution) {
      const nowIso = new Date().toISOString();
      await taskDb.createTaskExecution({
        executionId: execId,
        taskId: emailCampaignTaskId,
        userId,
        status: 'completed',
        startTime: nowIso
      });
      const resultFiles = foundUrls.map((url) => ({
        url,
        filename: url.split('/').pop() || 'report.html',
        token: Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
        is_html: true
      }));
      await taskDb.updateTaskExecution(execId, {
        result_files: resultFiles as any
      });
      await taskDb.updateTaskExecution(execId, {
        completedAt: nowIso
      });
    } else {
      const current = existingExecution.result_files || [];
      const currentUrlSet = new Set<string>(current.map((f: any) => f.url));
      const additions = foundUrls
        .filter((u) => !currentUrlSet.has(u))
        .map((url) => ({
          url,
          filename: url.split('/').pop() || 'report.html',
          token: Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
          is_html: true
        }));
      if (additions.length > 0) {
        await taskDb.updateTaskExecution(execId, {
          result_files: [...current, ...additions] as any
        });
      }
    }
  } catch (err) {
    console.error('AgentMode: Email campaign execution sync error:', err);
  }
}

// Interface for scheduled chat test results
interface ScheduledChatTestResult {
  scheduleId: string;
  runId: string;
  status: 'success' | 'failure';
  passed: boolean;
  actualResponse: string;
  actualFunctionCalls: string[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
  executionTime: number; // milliseconds
  sessionId: string; // Test session ID for viewing conversation
  attempt: number; // Which attempt this was (1-3)
  createdAt: string;
}

interface ScheduledChatVariable {
  name: string;
  description?: string;
  type?: 'text' | 'long_text' | 'file';
}

const SCHEDULED_CHAT_VARIABLE_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// How many previous scheduled-chat prompts to retain for revert. Oldest are dropped.
export const SCHEDULE_PROMPT_REVISION_LIMIT = 10;

function extractScheduledChatVariableNames(startingMessage: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  SCHEDULED_CHAT_VARIABLE_REGEX.lastIndex = 0;
  while ((match = SCHEDULED_CHAT_VARIABLE_REGEX.exec(startingMessage)) !== null) {
    seen.add(match[1]);
  }
  return Array.from(seen);
}

function validateAndBuildScheduledChatVariables(
  startingMessage: string,
  inputVariables: unknown,
  existingVariables: ScheduledChatVariable[] = []
): { variables: ScheduledChatVariable[]; error?: string } {
  const variableNames = extractScheduledChatVariableNames(startingMessage);
  if (variableNames.length === 0) {
    return { variables: [] };
  }

  const VALID_VARIABLE_TYPES = new Set(['text', 'long_text', 'file']);
  const normalizedInputVariables: ScheduledChatVariable[] = Array.isArray(inputVariables)
    ? inputVariables
        .filter((v: any) => v && typeof v.name === 'string')
        .map((v: any) => ({
          name: v.name.trim(),
          description: typeof v.description === 'string' ? v.description.trim() : '',
          ...(typeof v.type === 'string' && VALID_VARIABLE_TYPES.has(v.type) ? { type: v.type as 'text' | 'long_text' | 'file' } : {}),
        }))
    : [];

  const inputNames = new Set(normalizedInputVariables.map(v => v.name));
  const unknownVariables = Array.from(inputNames).filter(name => !variableNames.includes(name));
  if (unknownVariables.length > 0) {
    return {
      variables: [],
      error: `Variables not found in startingMessage: ${unknownVariables.join(', ')}`
    };
  }

  const existingMap = new Map(
    (existingVariables || []).map(variable => [variable.name, variable])
  );
  const inputMap = new Map(
    normalizedInputVariables.map(variable => [variable.name, variable])
  );

  const variables: ScheduledChatVariable[] = variableNames.map((name) => {
    const input = inputMap.get(name);
    const existing = existingMap.get(name);
    const description = input ? (input.description || '') : (existing?.description || '');
    const type = input?.type || existing?.type;
    return {
      name,
      description,
      ...(type ? { type } : {}),
    };
  });

  return { variables };
}

function getMissingScheduledChatVariableNames(
  variables: ScheduledChatVariable[],
  variableValues: Record<string, string> = {}
): string[] {
  return variables
    .filter(variable => !variableValues[variable.name] || !String(variableValues[variable.name]).trim())
    .map(variable => variable.name);
}

function parseFileVariableValue(value: string): { url: string; filename: string; size: number; mimetype: string } | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.url === 'string' && typeof parsed.filename === 'string') {
      return parsed;
    }
  } catch {
    // not a file variable JSON
  }
  return null;
}

function applyScheduledChatVariableValues(
  startingMessage: string,
  variableValues: Record<string, string> = {},
  variables: ScheduledChatVariable[] = []
): string {
  const variableTypeMap = new Map(variables.map(v => [v.name, v.type || 'text']));
  return startingMessage.replace(SCHEDULED_CHAT_VARIABLE_REGEX, (_, variableName: string) => {
    const value = variableValues[variableName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `{{${variableName}}}`;
    }
    // For file variables, replace with a markdown link
    if (variableTypeMap.get(variableName) === 'file') {
      const fileMeta = parseFileVariableValue(value);
      if (fileMeta) {
        return `[${fileMeta.filename}](${fileMeta.url})`;
      }
    }
    return value;
  });
}

function extractFileAttachmentsFromVariables(
  variables: ScheduledChatVariable[],
  variableValues: Record<string, string> = {}
): Array<{ url: string; filename: string; size: number; mimetype: string }> {
  const attachments: Array<{ url: string; filename: string; size: number; mimetype: string }> = [];
  for (const variable of variables) {
    if (variable.type === 'file') {
      const value = variableValues[variable.name];
      if (typeof value === 'string') {
        const fileMeta = parseFileVariableValue(value);
        if (fileMeta) {
          attachments.push(fileMeta);
        }
      }
    }
  }
  return attachments;
}

function hashScheduledChatVariableAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Helper function to reconstruct actualResponse from session messages (only used when sending emails)
async function getActualResponseFromSession(sessionId: string): Promise<string> {
  try {
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.messages || !Array.isArray(session.messages) || session.messages.length === 0) {
      return '';
    }
    
    // Iterate backwards to find the last assistant message with content
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0) {
        return msg.content.trim();
      }
    }
    
    return '';
  } catch (error) {
    console.error(`[getActualResponseFromSession] Error getting actualResponse from session ${sessionId}:`, error);
    return '';
  }
}

// Evaluate schedule response against expected criteria
function evaluateScheduleResponse(
  actualResponse: string,
  actualFunctionCalls: string[],
  expectedOutput: {
    keywords: string[];
    functionCalls: string[];
    functionCallMinCalls?: { [functionName: string]: number };
  }
): {
  passed: boolean;
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
} {
  const expectedKeywords = expectedOutput.keywords || [];
  const expectedFunctionCalls = expectedOutput.functionCalls || [];
  const functionCallMinCalls = expectedOutput.functionCallMinCalls || {};

  // Evaluate keywords
  const keywordMatches: string[] = [];
  const keywordMisses: string[] = [];

  expectedKeywords.forEach((keyword: string) => {
    if (actualResponse.toLowerCase().includes(keyword.toLowerCase())) {
      keywordMatches.push(keyword);
    } else {
      keywordMisses.push(keyword);
    }
  });

  // Evaluate function calls with minimum call requirements
  const functionCallMatches: string[] = [];
  const functionCallMisses: string[] = [];
  const functionCallDetails: { [functionName: string]: { actual: number; required: number } } = {};

  // Count actual function calls using a hash map
  const actualFunctionCallCounts: { [functionName: string]: number } = {};
  actualFunctionCalls.forEach((call: string) => {
    actualFunctionCallCounts[call] = (actualFunctionCallCounts[call] || 0) + 1;
  });

  expectedFunctionCalls.forEach((expectedCall: string) => {
    const actualCount = actualFunctionCallCounts[expectedCall] || 0;
    const requiredCount = functionCallMinCalls[expectedCall] || 1; // Default to 1 if not specified

    functionCallDetails[expectedCall] = {
      actual: actualCount,
      required: requiredCount
    };

    if (actualCount >= requiredCount) {
      functionCallMatches.push(expectedCall);
    } else {
      functionCallMisses.push(expectedCall);
    }
  });

  // Pass only if ALL expected keywords and ALL expected function calls meet minimum requirements
  const allKeywordsPresent = expectedKeywords.length === 0 || keywordMisses.length === 0;
  const allFunctionCallsPresent = expectedFunctionCalls.length === 0 || functionCallMisses.length === 0;
  const passed = allKeywordsPresent && allFunctionCallsPresent;

  return {
    passed,
    keywordMatches,
    keywordMisses,
    functionCallMatches,
    functionCallMisses,
    functionCallDetails
  };
}

// Common function to filter messages for client display
const filterMessagesForClient = (messages: any[]) => {
  return messages.filter(message => {
    // Remove tool messages
    if (message.role === 'tool') {
      return false;
    }

    // Remove assistant messages that have tool_calls (intermediate messages during tool execution)
    // BUT keep assistant messages that have metadata.toolCalls (final messages with tool execution results)
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 && !message.metadata?.toolCalls) {
      return false;
    }

    return true;
  });
};

// Helper function to check if this is the last run of the day for an hourly schedule
function isLastRunOfDayForHourlySchedule(currentTime: Date, nextRunTime: Date): boolean {
  const currentDay = currentTime.getDate();
  const nextDay = nextRunTime.getDate();
  const currentMonth = currentTime.getMonth();
  const nextMonth = nextRunTime.getMonth();
  const currentYear = currentTime.getFullYear();
  const nextYear = nextRunTime.getFullYear();

  // If the next run is on a different day, month, or year, this is the last run of the current day
  return nextDay !== currentDay || nextMonth !== currentMonth || nextYear !== currentYear;
}

// Helper function to send daily digest email
async function sendDailyDigestEmail(schedule: any, emailNotifications: string[]) {
  try {
    // Get all run results for today
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const runResults = await scheduleDb.getRunResults(schedule.scheduleId);
    const todaysResultsRaw = runResults.filter((result: any) => {
      const resultDate = new Date(result.createdAt);
      return resultDate >= startOfDay && resultDate < endOfDay;
    });
    
    // Reconstruct actualResponse for results that don't have it (only needed for email)
    const todaysResults = await Promise.all(
      todaysResultsRaw.map(async (result: any) => {
        if (!result.actualResponse && result.sessionId) {
          const actualResponse = await getActualResponseFromSession(result.sessionId);
          return { ...result, actualResponse };
        }
        return result;
      })
    );

    if (todaysResults.length === 0) {
      console.log(`No run results found for today for schedule ${schedule.scheduleName}`);
      return;
    }

    // Send daily digest email
    await emailService.sendDailyDigestEmail(
      emailNotifications,
      schedule.scheduleName,
      todaysResults,
      schedule.scheduleId
    );

    console.log(`Daily digest email sent for schedule ${schedule.scheduleName} with ${todaysResults.length} results`);
  } catch (error) {
    console.error(`Error sending daily digest email for schedule ${schedule.scheduleName}:`, error);
    throw error;
  }
}

// Deterministic completion-gate detector for scheduled runs.
//
// PR #1941's PER-ENTITY COMPLETION LOOP directive reduces the chance a scheduled
// multi-entity run stops short, but it is a probabilistic prompt nudge. This
// detector is the deterministic backstop: it returns true when the final turn of
// a scheduled run ADMITS it left work unfinished that the agent could have done
// (so runVerifiedChat issues one more continuation turn), and false otherwise.
//
// It must NOT fire on legitimate per-entity blockers ("LinkedIn not connected /
// not accessible") — those are a valid terminal state handled by BLOCKER
// ISOLATION, and looping on them would waste attempts. The patterns below match
// explicit "I stopped / did not finish / not yet processed / will continue later"
// admissions, which are distinct from "I cannot access X".
const INCOMPLETE_WORK_PATTERNS: RegExp[] = [
  /\bi (?:did\s*not|didn'?t)\s+(?:complete|finish)\b/i,
  /\b(?:did\s*not|didn'?t)\s+finish\b/i,
  /\bstopped\b[^.]*\bbefore\s+(?:fully|finish|complet|resolving)/i,
  /\bhave\s*not\s+yet\s+(?:processed|completed|finished|researched)\b/i,
  /\b(?:remaining|other)\s+(?:events|leads|items|entities)\b[^.]*\b(?:were|was)?\s*not\s+(?:processed|completed|finished|researched|done)\b/i,
  /\bi\s+will\s+continue\b[^.]*\b(?:later|remaining|next)\b/i,
  /\bi(?:\s+will|'ll|’ll)\s+(?:continue|proceed|move on|start|begin|work on)\b[^.]*\b(?:remaining|next|rest|step\s*\d+|phase|workflow)\b/i,
  /\b(?:i|we)\s+(?:skipped|omitted)\b[^.]*\b(?:remaining|other|rest|events|leads|items|entities|steps?|workflow)\b/i,
  /\b(?:i|we)\s+left\b[^.]*\b(?:remaining|other|rest|events|leads|items|entities|steps?|workflow)\b[^.]*\b(?:unfinished|incomplete|undone|unprocessed|unresearched)\b/i,
];

export function scheduledRunSignalsIncompleteWork(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  return INCOMPLETE_WORK_PATTERNS.some((re) => re.test(content));
}

// ENG-844: Deterministic detector for a scheduled run that LEGITIMATELY
// short-circuited on a conditional CADENCE guard — e.g. a schedule that runs
// DAILY but is instructed to publish only on Mon/Wed/Fri, running on a
// non-publishing day. Such a run correctly produces ZERO write calls
// (post_on_connected_account / generate_image) BY DESIGN and reports a skip.
//
// Without recognising this, runVerifiedChat keeps retrying to satisfy the
// schedule's requiredFunctionCalls, re-sending an identical "Please try again.
// Make sure to <write tool> (1 more time needed)" prompt. That pressure is aimed
// at IRREVERSIBLE, live-publishing tools, and repeating the identical prompt
// eventually trips the anti-loop override in agentModeService — pushing a
// correctly-behaving agent toward off-cadence publishing or fabricating success.
//
// A freeform-text match ALONE is unsafe: a genuine FAILURE worded as a skip
// ("Skipping today's post — I couldn't access LinkedIn", "No post today; auth
// failed") would be silently waived, un-auditing a live publishing pipeline
// (the retry + fileAutoIssue + oncall path would never fire). So the carve-out
// only fires when ALL of these hold:
//   0. the SCHEDULE'S OWN INSTRUCTION authorizes a conditional skip (defines the
//      cadence / non-publishing-day rule) — the authorization comes from the human
//      who wrote the schedule, not from the model's post-hoc prose; and
//   1. the skip is tied to a CADENCE/weekday rationale, not a bare "skip today"
//      (a self-contained cadence phrase, or a skip declaration + a cadence
//      rationale in the same turn);
//   2. NO failure/tool-error signal appears in the turn's prose; and
//   3. NO tool call in the run actually errored (the non-spoofable ledger check
//      used elsewhere — `'error' in toolCall`); and
//   4. if the turn asserts a specific weekday as "today", it agrees with the
//      server's actual weekday (a hallucinated/mis-dated skip is rejected).
//
// This is DISTINCT from scheduledRunSignalsIncompleteWork (which detects a run
// that left SOME items undone and should continue). Here the WHOLE run is a
// deliberate no-op.

// A phrase that BY ITSELF expresses a cadence/weekday skip (rationale baked in).
const CADENCE_SKIP_PATTERNS: RegExp[] = [
  /\bnon-?publishing\s+day\b/i,
  /\bnot\s+a\s+(?:publishing|posting)\s+day\b/i,
  /\btoday\s+is\s+(?:not\s+a\s+(?:publishing|posting)\s+day|a\s+(?:non-?publishing|skip|rest|off)\s+day)\b/i,
  /\b(?:rest|off|skip|non-?publishing)\s+day\s+for\s+this\s+(?:schedule|cadence)\b/i,
  /\bcreat(?:e|ing)\s+and\s+publish(?:ing)?\s+nothing\b/i,
  // Self-contained because it names the publishing window itself (ENG-844 audit).
  /\boutside\s+(?:the\s+|its\s+|this\s+)?(?:publish(?:ing)?|post(?:ing)?)\s+(?:window|cadence|days?|schedule)\b/i,
];

// A bare skip declaration. On its own this is ambiguous (a failure can be worded
// the same way), so it only counts as a cadence skip when paired with a
// CADENCE_RATIONALE match below.
const SKIP_DECLARATION_PATTERNS: RegExp[] = [
  /\bskipp?(?:ing|ed)?\s+(?:today|this\s+(?:run|cycle|schedule|post))\b/i,
  /\bno\s+(?:post|publishing|publish)\s+(?:today|scheduled\s+(?:for\s+)?today)\b/i,
  /\bnothing\s+to\s+(?:post|publish)\s+today\b/i,
  // Real phrasings a model reaches for that the original set missed (audited against
  // production skip transcripts, ENG-844). Each still requires a CADENCE_RATIONALE
  // match in the same turn, so none of these can authorize a skip on its own.
  /\bstanding\s+down\b/i,
  /\bno\s+action\s+(?:taken|needed|required)\b/i,
  /\b(?:no\s+(?:content|posts?|images?)\s+(?:was|were)\s+(?:produced|created|generated|published)|nothing\s+(?:was|were)\s+(?:produced|created|generated|published))\b/i,
];

// Evidence the skip is driven by the schedule's PUBLISHING CADENCE (a weekday
// window), not by an error — this is what separates a legitimate skip from a
// failure dressed up as one.
const CADENCE_RATIONALE_PATTERNS: RegExp[] = [
  /\bcadence\b/i,
  /\bonly\s+(?:publish|post)(?:es|ing|s)?\b/i,
  /\b(?:publish|post)(?:es|ing|s)?\s+only\b/i,
  /\bonly\s+on\s+(?:mon|tue|wed|thu|fri|sat|sun)/i,
  /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[\/,]\s*(?:mon|tue|wed|thu|fri|sat|sun)/i,
  /\bnon-?publishing\s+day\b/i,
  /\bnot\s+a\s+(?:publishing|posting)\s+day\b/i,
];

// A run that hit a FAILURE (missing access, auth, timeout, tool error) is NOT a
// cadence skip — it must still retry + alert. Any of these veto the carve-out.
// HARD failure signals: unambiguous evidence something broke. These veto wherever
// they appear (after the zero-ledger neutralisation below).
const HARD_FAILURE_PATTERNS: RegExp[] = [
  /\b(?:failed(?:\s+to)?|failure|errored?|an?\s+error|timed?\s*out|time[\s-]?out)\b/i,
  /\b(?:unauthori[sz]ed|not\s+authori[sz]ed|access\s+denied|permission\s+denied|forbidden|rate[\s-]?limit)\b/i,
  /\bauth(?:entication|orization)?\s+(?:fail(?:ed|ure)?|error|issue|problem)\b/i,
  /\b(?:token\s+expired|invalid\s+(?:token|credential))/i,
  /\bdid\s+not\s+work\b/i,
];

// INABILITY / REFUSAL phrasing. This is genuinely ambiguous: on a skip day
// "I cannot post today because the cadence forbids it" is a correct REFUSAL, while
// "I could not access LinkedIn" is a FAILURE. The original rule vetoed on ANY
// `\w+n't` contraction, which silently rejected the most natural ways to describe a
// legitimate skip — "today isn't a publishing day", "I won't publish anything
// today", "I didn't create anything" — the same phrasing-fragility class that caused
// the 2026-08-06 production regression (ENG-844). So these veto ONLY when the
// sentence does not justify itself by the cadence, or when it names an external
// resource (which turns a refusal into a report of a broken dependency).
const INABILITY_PATTERNS: RegExp[] = [
  /\b(?:cannot|could\s+not|was\s+not\s+able|were\s+not\s+able|not\s+able\s+to|unable\s+to|would\s+not|refused)\b/i,
];

// An external dependency named alongside an inability means it is a failure report
// ("LinkedIn would not accept the post"), not a cadence refusal.
const FAILURE_RESOURCE_PATTERN =
  /\b(?:linkedin|instagram|twitter|facebook|api|endpoint|server|network|gateway|upstream|http|token|credential|account)\b/i;

// "no access" is only an auth failure when it is about an external resource
// ("no access to the LinkedIn account"). On its own it is ordinary prose — e.g.
// "no access to the calendar was needed" — and must not veto a legitimate skip.
const NO_ACCESS_PATTERN = /\bno\s+access\b/i;

// Expand contractions so the veto reasons about words, not apostrophes: "couldn't"
// → "could not" (still an inability), while "isn't"/"didn't"/"won't" become plain
// negations that no longer trip anything by themselves.
function expandContractions(text: string): string {
  return text
    .replace(/\bcan['’]t\b/gi, 'cannot')
    .replace(/\bwon['’]t\b/gi, 'will not')
    .replace(/\bshan['’]t\b/gi, 'shall not')
    .replace(/\b(\w+)n['’]t\b/gi, '$1 not');
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Extract a weekday the turn asserts is TODAY (e.g. "Today is Sunday",
// "Sunday, which is a non-publishing day"). Returns the 0–6 index or null.
function assertedTodayWeekday(content: string): number | null {
  const m =
    content.match(/\btoday\s+is\s+(?:a\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i) ||
    content.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*,?\s+(?:which\s+)?is\s+(?:a\s+)?(?:non-?publishing|not\s+a\s+(?:publishing|posting))/i);
  if (!m) return null;
  return WEEKDAY_NAMES.indexOf(m[1].toLowerCase());
}

// The waiver must be AUTHORIZED BY THE SCHEDULE OWNER, not merely asserted by the
// model. These match the OWNER'S configured instruction (the schedule's starting
// message) for evidence it defines a conditional publishing cadence — "publish
// only on Mon/Wed/Fri", a named "non-publishing day", or an explicit "if today is
// X … publish nothing / skip". Without this, a model that spontaneously claims a
// skip on a day it was actually supposed to publish would silently waive its
// required write calls (Greptile P1, ENG-844): the skip prose is the model's, but
// the authorization to skip has to come from the human who wrote the schedule.
const SCHEDULE_SKIP_AUTHORIZATION_PATTERNS: RegExp[] = [
  /\b(?:publish|post|posts?|publishing)\s+only\s+(?:on|when|if)\b/i,
  /\bonly\s+(?:publish|post)(?:es|ing|s)?\b/i,
  /\b(?:publish|post)(?:es|ing|s)?\s+only\s+on\b/i,
  /\bonly\s+on\s+(?:mon|tue|wed|thu|fri|sat|sun)/i,
  /\bnon-?publishing\s+day\b/i,
  /\bnot\s+a\s+(?:publishing|posting)\s+day\b/i,
  /\bif\b[^.]*\b(?:skip|publish\s+nothing|post\s+nothing|create\s+(?:and\s+publish\s+)?nothing|do\s*n['’o]?t\s+(?:publish|post)|don['’]t\s+(?:publish|post))/i,
  /\b(?:skip|publish\s+nothing|post\s+nothing|no\s+post)\b[^.]*\b(?:mon|tue|wed|thu|fri|sat|sun|weekend|weekday)/i,
  // A negative cadence stated directly — "DO NOT create or publish anything on
  // Tue/Thu", "doesn't publish on weekends" (contractions are expanded first). The
  // object between the negation and the verb is why the `if …` pattern above missed
  // these (ENG-844 audit).
  /\b(?:do|does|will|should)\s+not\b[^.]{0,40}?\b(?:publish|post|create|generate)\b/i,
];

function instructionAuthorizesConditionalSkip(instruction: string): boolean {
  if (!instruction || typeof instruction !== 'string') return false;
  // Expand contractions here too, so an owner who wrote "doesn't publish on
  // weekends" is read the same as "does not publish on weekends" (ENG-844 audit).
  const text = expandContractions(instruction.replace(/<[^>]+>/g, ' '));
  return SCHEDULE_SKIP_AUTHORIZATION_PATTERNS.some((re) => re.test(text));
}

const WEEKDAY_ABBREV_TO_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// Every ACCEPTED spelling of a weekday → 0–6. Matched only as whole tokens (see
// WEEKDAY_TOKEN) so "monetary"/"wedding"/"satisfaction" are NOT read as Mon/Wed/Sat
// (Greptile P1: a loose `(mon|tue|…)[a-z]*` prefix invented cadences, ENG-844).
const WEEKDAY_WORD_TO_INDEX: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
// Whole-token weekday matcher — full names or the exact accepted abbreviations,
// never an arbitrary word that merely starts with those three letters.
const WEEKDAY_TOKEN = /\b(sunday|saturday|monday|tuesday|wednesday|thursday|friday|sun|mon|tues?|weds?|thurs?|thu|fri|sat)\b/gi;
// A range like "Mon-Fri" / "Monday to Friday" / "Monday through Friday".
const WEEKDAY_RANGE = /\b(sunday|saturday|monday|tuesday|wednesday|thursday|friday|sun|mon|tues?|weds?|thurs?|thu|fri|sat)\b\s*(?:-|–|—|to|through|thru|till|until)\s*\b(sunday|saturday|monday|tuesday|wednesday|thursday|friday|sun|mon|tues?|weds?|thurs?|thu|fri|sat)\b/gi;

// A singleton weekday counts as a cadence day only if what immediately follows it
// marks it as a LIST ITEM — end of clause, a separator/connective, or a cadence
// keyword — and NOT a possessive or an unrelated noun. This is what distinguishes
// "publish only on Mon/Wed/Fri" (a cadence) from "publish only on Monday's
// approval" or "publish only on the Monday team" (an approval gate that merely
// names a day), which would otherwise invent a cadence and waive required calls
// (Greptile P1, ENG-844).
// NB: range connectives (-, –, —, to, through, thru, till, until) are deliberately
// NOT "listy" here. A day followed by one is a RANGE start — handled by WEEKDAY_RANGE
// with its OWN trailing-context check — so if the whole range is bound to a noun
// ("Monday to Friday team approves") both the range AND its endpoint singletons are
// rejected, instead of the leading day leaking through (Greptile P1, ENG-844).
const AFTER_CADENCE_DAY = /^\s*(?:$|[,/&.;:!?()]|(?:and|or|then|otherwise|else|per|please|publish\w*|post\w*|posting|only|nothing|create|creating|skip\w*|days?|weekly|week|schedule|cadence)\b|(?:sun|mon|tue|wed|thu|fri|sat))/i;
function followsAsCadenceDay(after: string): boolean {
  if (/^['’]/.test(after)) return false; // possessive: "Monday's approval"
  return AFTER_CADENCE_DAY.test(after);
}

// Extract every weekday named in a text fragment (Mon, Tuesday, THU, …) as 0–6
// indices, expanding inclusive ranges ("Mon-Fri" → Mon,Tue,Wed,Thu,Fri, wrapping
// Sun..Sat) and the "weekend"/"weekday" shorthands. EVERY path — singletons,
// ranges, and shorthands — must pass the grammatical-context guard
// (followsAsCadenceDay), so an approval clause that merely contains a range or
// shorthand ("publish only on Mon-Fri's approval", "weekend approvals") does not
// get reinterpreted as a cadence (Greptile P1, ENG-844). Order/dupes don't matter —
// callers collect into a Set.
function weekdaysInFragment(fragment: string): number[] {
  const out: number[] = [];
  const followsHere = (matchEnd: number) => followsAsCadenceDay(fragment.slice(matchEnd));
  for (const m of fragment.matchAll(WEEKDAY_RANGE)) {
    const a = WEEKDAY_WORD_TO_INDEX[m[1].toLowerCase()];
    const b = WEEKDAY_WORD_TO_INDEX[m[2].toLowerCase()];
    if (a === undefined || b === undefined) continue;
    if (!followsHere((m.index ?? 0) + m[0].length)) continue;
    for (let i = a, steps = 0; steps < 7; i = (i + 1) % 7, steps++) {
      out.push(i);
      if (i === b) break;
    }
  }
  for (const m of fragment.matchAll(WEEKDAY_TOKEN)) {
    const idx = WEEKDAY_WORD_TO_INDEX[m[1].toLowerCase()];
    if (idx === undefined) continue;
    if (!followsHere((m.index ?? 0) + m[0].length)) continue;
    out.push(idx);
  }
  for (const m of fragment.matchAll(/\bweekends?\b/gi)) {
    if (followsHere(m.index + m[0].length)) out.push(0, 6);
  }
  for (const m of fragment.matchAll(/\bweekdays?\b/gi)) {
    if (followsHere(m.index + m[0].length)) out.push(1, 2, 3, 4, 5);
  }
  return out;
}

// Parse the schedule OWNER'S instruction into the day-sets that define its
// publishing cadence: the days it publishes on ("publish only on Mon/Wed/Fri")
// and/or the days it explicitly skips ("if Tue/Thu/Sat/Sun, publish nothing").
// Used to cross-check the actual RUN DATE — a skip claimed on a real publishing
// day must NOT be waived even if the model omits or mislabels the weekday
// (Greptile P1, ENG-844). Clause-scoped so a "publish" clause and a "skip" clause
// in the same instruction are classified independently; an ambiguous day-bearing
// clause (neither keyword) is ignored rather than guessed.
function parseScheduleCadence(instruction: string): { publishDays: Set<number>; skipDays: Set<number> } {
  const publishDays = new Set<number>();
  const skipDays = new Set<number>();
  if (!instruction || typeof instruction !== 'string') return { publishDays, skipDays };
  const text = expandContractions(instruction.replace(/<[^>]+>/g, ' '));
  // "do not publish" must tolerate an intervening object — real instructions say
  // "DO NOT create or publish anything" (ENG-844 audit). Contractions are already
  // expanded above, so only the "do not" form needs matching here.
  const skipKeyword =
    /\b(?:skip|publish\s+nothing|post\s+nothing|create\s+(?:and\s+publish\s+)?nothing|non-?publishing|not\s+a\s+(?:publishing|posting)\s+day)\b|\b(?:do|does|will|should)\s+not\b[^.;\n]{0,40}?\b(?:publish|post|create|generate)\b/i;
  // NB the inflections: `only\s+(?:publish|post)\b` does NOT match "only publishes",
  // which is the single most common way owners write a cadence. That omission left
  // publishDays EMPTY for the LUCAS schedule; it only ever corroborated because its
  // skip clause happened to quote the words "non-publishing day". Any owner who
  // wrote just "only publishes on Mon/Wed/Fri" got no cadence at all and every skip
  // failed closed into the retry press (ENG-844 audit).
  const publishOnlyKeyword =
    /\b(?:publish|post|publishing)(?:es|s)?\s+only\b|\bonly\s+(?:publish|post)(?:es|ing|s)?\b|\bonly\s+on\b/i;
  for (const clause of text.split(/[.;\n]+/)) {
    const days = weekdaysInFragment(clause);
    if (days.length === 0) continue;
    const isSkip = skipKeyword.test(clause);
    const isPublishOnly = publishOnlyKeyword.test(clause);
    // A "publish only on <days>" clause names the PUBLISH days; a skip clause names
    // the SKIP days. A clause naming the verb ("publish only" / "only publishes") is
    // an unambiguous positive cadence and wins. A bare "only on <days>" is a WEAK
    // signal — "skip only on Saturday" also contains it — so when the clause also
    // reads as a skip, the skip interpretation wins (otherwise Saturday would be
    // recorded as a PUBLISH day and every legitimate Saturday skip rejected).
    const strongPublishOnly =
      /\b(?:publish|post|publishing)(?:es|s)?\s+only\b|\bonly\s+(?:publish|post)(?:es|ing|s)?\b/i.test(clause);
    if (strongPublishOnly || (isPublishOnly && !isSkip)) days.forEach((d) => publishDays.add(d));
    else if (isSkip) days.forEach((d) => skipDays.add(d));
  }
  return { publishDays, skipDays };
}

// The owner's weekday cadence ("publish Mon/Wed/Fri") is expressed in the
// SCHEDULE'S local calendar, so the cadence day-of-week must be read in the
// schedule's timezone — evaluating it in UTC mis-judges the day for any run near
// a midnight boundary and can waive a skip on the owner's actual publishing day
// (Greptile P1, ENG-844). Falls back to UTC when no/invalid timezone is given.
// NB: the model-asserted-weekday VETO stays UTC on purpose — the model is handed
// its "Current date" as a UTC calendar date, so that is the reference IT reasons in.
// True iff `tz` is a valid IANA timezone identifier (e.g. "America/Los_Angeles").
// Intl.DateTimeFormat throws RangeError on an unknown zone. Used to validate the
// timezone persisted on a schedule so the cadence check has a trustworthy value
// (ENG-844).
export function isValidIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function weekdayInTimeZone(when: Date, timeZone?: string): number {
  if (!timeZone) return when.getUTCDay();
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(when);
    const idx = WEEKDAY_ABBREV_TO_INDEX[wd.slice(0, 3).toLowerCase()];
    return idx ?? when.getUTCDay();
  } catch {
    return when.getUTCDay();
  }
}

// A legitimate cadence skip makes NO write of consequence — not just none of the
// schedule's REQUIRED minimums. A run can call other side-effecting tools not in
// requiredFunctions (send_email_from_sender, add_leads_to_list, launch_campaign,
// save_*, set_*, …); any such call means the run was not a clean no-op and must
// not be laundered into a successful skip (Greptile P1, ENG-844).
//
// Detection is fail-SAFE: rather than enumerate write verbs (an allowlist that
// leaks — `email`, `add_*`, `assign_*`, `manage_*`, `freeze_*` all slipped past an
// earlier verb list), we allowlist READ/CONTEXT tools and treat EVERYTHING ELSE as
// a side effect. A new or unrecognized tool therefore counts as a write until
// proven read-only, so no write can be silently concealed.
// Reads are named verb-FIRST (get_*, read_*, list_*, describe_*, analyze_*), so
// anchor to the leading token — otherwise a write like `add_leads_to_list` or
// `create_lead_list` would be mistaken for a read because it merely CONTAINS a read
// word. Irregular read names that don't lead with a read verb are listed exactly.
const READ_ONLY_TOOL = /^(?:get|read|list|fetch|search|describe|analy[sz]e|ask|audit|lookup|view|show|load|query|count|retrieve|summari[sz]e|inspect)(?:_|$)/i;
const READ_ONLY_TOOL_EXACT = new Set(['account_summary', 'you_search_web', 'web_search']);
function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_TOOL_EXACT.has(name) || READ_ONLY_TOOL.test(name);
}
function isWriteToolCall(toolCall: any): boolean {
  const name = typeof toolCall?.name === 'string' ? toolCall.name : '';
  return name.length > 0 && !isReadOnlyToolName(name);
}

// Reconstruct the tool calls an abandoned session already made, for an ENG-657
// resume. A message can carry BOTH the request-only assistant `tool_calls` and the
// persisted EXECUTION ledger `metadata.toolCalls`; prefer the executed ledger
// because only it carries result/error markers. Preferring the request list would
// drop a FAILED abandoned call's error, which the conditional-skip error-veto needs
// to reject a failed run (Greptile P1, ENG-844). Falls back to the request list
// only for a message that has no executed ledger. Each returned entry keeps the
// name and, when the call failed, its error.
export function reconstructPriorToolCalls(messages: any[]): Array<{ name: string; error?: any }> {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((m: any) => {
    const executed = Array.isArray(m?.metadata?.toolCalls) ? m.metadata.toolCalls : [];
    const requested = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
    const calls = executed.length ? executed : requested;
    return calls
      .map((tc: any) => {
        const name = tc?.function?.name || tc?.name;
        if (!name) return null;
        return (tc && typeof tc === 'object' && tc.error != null) ? { name, error: tc.error } : { name };
      })
      .filter(Boolean);
  }) as Array<{ name: string; error?: any }>;
}

export function scheduledRunSignalsConditionalSkip(
  content: string,
  options: { toolCalls?: any[]; now?: Date; instruction?: string; timezone?: string } = {}
): boolean {
  if (!content || typeof content !== 'string') return false;

  const now = options.now ?? new Date();
  // UTC weekday — the reference the MODEL reasons in (its "Current date" is a UTC
  // calendar date), used only for the model-asserted-weekday VETO in step (4).
  const todayIdx = now.getUTCDay();
  // The OWNER'S cadence weekday, read in the schedule's timezone — the reference
  // the cadence day-lists ("publish Mon/Wed/Fri") are expressed in (Greptile P1).
  const cadenceDayIdx = weekdayInTimeZone(now, options.timezone);
  // Tracks whether the skip has been corroborated against the actual RUN DATE
  // (by the parsed cadence and/or the model naming today's weekday). When an
  // instruction is provided we REQUIRE this before waiving (see final gate).
  let runDateCorroborated = false;

  // (0) Authorization + run-date gate: only honor a skip the SCHEDULE OWNER
  // authorized, ON a day that owner's cadence actually excludes. When the caller
  // supplies the schedule's instruction (it always does on the real scheduled
  // path):
  //   - the instruction must itself define a conditional cadence (else a
  //     model-authored skip on a run carrying write-call minimums is unauthorized);
  //   - and TODAY must be a non-publishing day under that cadence. Parsing the
  //     instruction's publish/skip day-lists lets us reject a skip emitted ON a
  //     publishing day even when the model omits or mislabels the weekday — the
  //     deeper form of the same bug (Greptile P1, ENG-844).
  // Undefined instruction (pure text-classifier callers) leaves this gate inert.
  const instruction = options.instruction;
  const instructionProvided = typeof instruction === 'string' && instruction.length > 0;
  if (instructionProvided) {
    if (!instructionAuthorizesConditionalSkip(instruction!)) return false;
    const { publishDays, skipDays } = parseScheduleCadence(instruction!);
    if (publishDays.size > 0) {
      // Positive cadence: today (in the schedule's timezone) must fall OUTSIDE the
      // publish window.
      if (publishDays.has(cadenceDayIdx)) return false;
      runDateCorroborated = true;
    } else if (skipDays.size > 0) {
      // Only a skip-day list was given: today (schedule timezone) must be one of
      // the named skip days.
      if (!skipDays.has(cadenceDayIdx)) return false;
      runDateCorroborated = true;
    }
  }

  // Emma emits HTML (the marketing persona renders <strong>, <ul>, <table>…), so
  // strip tags before matching — otherwise "<strong>Sunday</strong>" hides the
  // weekday assertion and a "<td>Failed</td><td>0</td>" completion ledger is read
  // as prose. Verified against the real ENG-844 session (442e7880…): both
  // happened, and without this the carve-out never fired on the actual skip.
  // Contractions are expanded up-front so EVERY stage reasons about words rather
  // than apostrophes. Without this, the most natural skip phrasing of all —
  // "today isn't a publishing day" — never even matched the cadence-skip patterns
  // (which look for "not a publishing day"), so the run was never recognised as a
  // skip (ENG-844 audit).
  const text = expandContractions(content.replace(/<[^>]+>/g, ' '));

  // (1) Must be a cadence-anchored skip, not a bare "skip today".
  const isCadenceSkip =
    CADENCE_SKIP_PATTERNS.some((re) => re.test(text)) ||
    (SKIP_DECLARATION_PATTERNS.some((re) => re.test(text)) &&
      CADENCE_RATIONALE_PATTERNS.some((re) => re.test(text)));
  if (!isCadenceSkip) return false;

  // (2) A failure worded as a skip is not a cadence skip. But FIRST neutralize a
  // zero/none-valued failure ledger — a clean run routinely reports "Failed: 0" /
  // "Failed  0" (a "<td>Failed</td><td>0</td>" cell) / "failures: none", which is
  // a SUCCESS signal, not a failure. A nonzero or asserted failure ("Failed 1",
  // "post failed", "auth failed", "couldn't reach the API") is untouched and still
  // vetoes.
  //
  // BOTH orders must be neutralized (prod regression, session 25ec4670 on
  // 2026-08-06): agents also write the count FIRST, as an inline ledger —
  // "Ledger: 0 attempted / 0 succeeded / 0 failed / 0 queued." Only handling
  // label-then-count let the bare word "failed" survive there and veto a perfectly
  // legitimate cadence skip, sending the run into the full 20-attempt retry press
  // this ticket exists to prevent.
  //
  // The count-then-label rule carries a negative lookahead for a FOLLOWING nonzero
  // count, which is what makes it safe: a stripped HTML table renders as
  // "Succeeded 0 Failed 1", where the "0" belongs to the PREVIOUS row — there,
  // "Failed" is followed by "1", so it is left intact and still vetoes.
  //
  // That lookahead must tolerate PUNCTUATION between the label and its own count
  // (Greptile P1): "Succeeded 0 Failed, 1" / "… Failed; 1" / "… Failed | 1" all bind
  // the 1 to "Failed", but a separator class of only [:=-] failed to see it, so the
  // "0 Failed" was neutralised and a reported failure was waived as a clean skip.
  // Widening the class is strictly fail-CLOSED — it can only make the veto fire more
  // often, never less — and the real production ledger is unaffected because every
  // count after "0 failed" there is itself a zero ("0 failed / 0 queued").
  const failureScan = expandContractions(
    text
      .replace(/\b(?:failed|failures?|errors?|errored)\b\s*[:=-]?\s*(?:0+|zero|none)\b/gi, ' ')
      .replace(/\b(?:0+|zero|none)\s*[:=-]?\s*(?:failed|failures?|errors?|errored)\b(?!\s*[,;:=|/–—-]?\s*\d*[1-9])/gi, ' ')
  );
  // (2a) Hard failure evidence vetoes anywhere in the turn.
  if (HARD_FAILURE_PATTERNS.some((re) => re.test(failureScan))) return false;
  // (2b) Inability/refusal is judged PER SENTENCE: it only vetoes when the sentence
  // does not justify itself by the cadence, or when it names an external resource
  // (a broken dependency rather than a deliberate refusal).
  for (const sentence of failureScan.split(/[.;!?\n]+/)) {
    // "no access" + a named external resource is an auth failure.
    if (NO_ACCESS_PATTERN.test(sentence) && FAILURE_RESOURCE_PATTERN.test(sentence)) return false;
    if (!INABILITY_PATTERNS.some((re) => re.test(sentence))) continue;
    const cadenceJustified =
      CADENCE_RATIONALE_PATTERNS.some((re) => re.test(sentence)) ||
      CADENCE_SKIP_PATTERNS.some((re) => re.test(sentence));
    if (cadenceJustified && !FAILURE_RESOURCE_PATTERN.test(sentence)) continue;
    return false;
  }

  // (3) Non-spoofable ledger check: a legitimate cadence skip makes NO write calls
  // AND no tool errors. Any tool error means this was a failure, not a skip; any
  // WRITE call — even one not in the schedule's requiredFunctions, e.g.
  // send_email_from_sender — means the run had an external side effect and is not
  // a clean no-op, so it must not be waived (Greptile P1, ENG-844).
  const toolCalls = options.toolCalls;
  if (Array.isArray(toolCalls) &&
      toolCalls.some((tc) => (tc && typeof tc === 'object' && 'error' in tc) || isWriteToolCall(tc))) {
    return false;
  }

  // (4) Weekday cross-check — VETO ONLY. If the turn names a weekday as "today" it
  // must agree with the actual UTC weekday (getUTCDay — the model is handed its
  // "Current date" as a UTC calendar date via new Date().toISOString(), see
  // generateMarketingResponse; a server-LOCAL getDay would desync on a non-UTC
  // host). This is deliberately UTC even though the cadence check uses the
  // schedule timezone: the veto validates the MODEL's claim, and the model reasons
  // in UTC. This catches a
  // grossly mis-dated skip. It does NOT corroborate the waiver: the model naming
  // today's weekday only proves it knows the date, not that today is genuinely a
  // non-publishing day. For a schedule whose cadence is not weekday-based (e.g.
  // "publish only when approved"), a correctly-named weekday says nothing about
  // whether a skip is legitimate — so authorization to skip must come only from
  // the OWNER's parsed weekday cadence in step (0), never the model's self-report
  // (Greptile, ENG-844).
  const asserted = assertedTodayWeekday(text);
  if (asserted !== null && asserted !== todayIdx) return false;

  // (5) When the schedule instruction is provided (the real scheduled path always
  // provides it), the skip MUST be corroborated against the run date by the OWNER's
  // parsed weekday cadence (step 0). If the instruction authorizes a skip but names
  // no weekday cadence we can evaluate against today, fail closed rather than waive
  // a possibly-missed publication on an audited pipeline (Greptile, ENG-844).
  if (instructionProvided && !runDateCorroborated) return false;

  return true;
}

// Deterministic, TOOL-CALL-based completion detector for scheduled runs (ENG-518).
//
// Some workflows split a mutation into a dry-run PREVIEW tool and a write-back
// EXECUTE tool (the preview samples the result and its description tells the
// model to confirm with the user before committing). In a scheduled, unattended
// run the model can present the preview samples as if they were the deliverable
// and end the turn — the enrichment is previewed but never committed. The
// text/flag-based classifier above cannot see this: the closing text need not
// admit anything or ask to confirm, so the gate lets the run finish mid-pipeline.
//
// This maps each preview tool to the execute tool that commits its result. If a
// scheduled run previewed a list but never ran the execute counterpart FOR THAT
// SAME LIST, the run stopped before write-back and needs one more continuation.
const PREVIEW_EXECUTE_TOOL_PAIRS: Record<string, string> = {
  enrich_leads_preview: 'enrich_leads_execute',
};

// The tool call arg identifying which CRM list a preview/execute call targeted.
// list_id is a required arg on both tools; `arguments` is normally the parsed
// object, but a preflight-failure path can carry the raw JSON string, so handle
// both shapes.
function previewExecuteListId(toolCall: any): string | null {
  const args = toolCall?.arguments;
  if (!args) return null;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed?.list_id === 'string' ? parsed.list_id : null;
    } catch {
      return null;
    }
  }
  return typeof args.list_id === 'string' ? args.list_id : null;
}

// Deterministic, PER-LIST, RESULT-AWARE detector for the preview→write-back gap.
//
// Takes the whole run's accumulated tool-call objects ({ name, arguments, result }).
// For each preview/execute pair it fires only when a list was previewed AND the
// engine confirmed that preview is enrichable (processedCount > 0) AND no execute
// ran for that same list_id. This deliberately does NOT fire for:
//   - a list whose preview resolved nobody (processedCount 0): forcing a write there
//     would loop on an unenrichable list and commit nothing useful; and
//   - a list already committed by its execute call (per-list, so a partial
//     multi-list run still fires for the lists that were NOT executed).
// Both narrowings keep the gate from commanding CRM writes a preview never warranted.
export function scheduledRunPreviewedWithoutExecute(toolCalls: any[]): boolean {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  return Object.entries(PREVIEW_EXECUTE_TOOL_PAIRS).some(([previewTool, executeTool]) => {
    const enrichablePreviewedLists = new Set<string>();
    const executedLists = new Set<string>();
    for (const tc of toolCalls) {
      const listId = previewExecuteListId(tc);
      if (!listId) continue;
      if (tc?.name === previewTool) {
        if (Number(tc?.result?.processedCount) > 0) enrichablePreviewedLists.add(listId);
      } else if (tc?.name === executeTool) {
        // Only a SUCCESSFUL write-back closes the gap. An execute closes a list
        // when it (a) did not throw, (b) persisted at least one record
        // (processedCount > 0), and (c) had NO write-back failure
        // (failureBreakdown.updateFailed === 0). A thrown/zero-write execute, or one
        // that produced values but failed to PERSIST some of them (updateFailed > 0
        // — a genuine uncommitted write, distinct from a lead the engine simply
        // could not resolve or find data for), leaves the enrichment uncommitted, so
        // the gate keeps chasing (bounded by completionGateMaxContinuations) to
        // retry the write instead of silently accepting a partially-persisted list.
        const r = tc?.result;
        const persistedSomething = Number(r?.processedCount) > 0;
        const hadWriteFailure = Number(r?.failureBreakdown?.updateFailed) > 0;
        if (!tc?.error && persistedSomething && !hadWriteFailure) executedLists.add(listId);
      }
    }
    for (const listId of enrichablePreviewedLists) {
      if (!executedLists.has(listId)) return true;
    }
    return false;
  });
}

// Deterministic detector for the ENG-369 failure mode: a scheduled/unattended
// run that halted to ask a HUMAN to confirm/approve before proceeding, when no
// human is present to answer — so the task dead-ends with no deliverable.
//
// The canonical case: the agent finds the requested approach infeasible (e.g.
// "maximum granularity is impossible — no per-session transcript tool"), then
// ends its turn with "Reply 'go' to proceed with the best-effort approach"
// instead of just proceeding. In an automated run nobody replies.
//
// It must NOT fire on a finished report that merely surfaces actionable
// next-steps for the user ("connect Bob's LinkedIn next run") — those are a
// valid terminal state. The patterns therefore anchor strictly on an explicit
// request for permission/confirmation TO PROCEED, not on generic mentions of
// the user or of follow-up actions.
const AWAITING_CONFIRMATION_PATTERNS: RegExp[] = [
  // "Reply 'go'", "Reply go to proceed", "reply with yes/proceed/confirm"
  /\breply\s+(?:with\s+)?["'“]?\s*(?:go|yes|ok|okay|proceed|confirm|approved?)\b/i,
  // "Should/Shall/May/Can/Do/Would I|we proceed|continue|go ahead|move forward"
  /\b(?:should|shall|may|can|do|would)\s+(?:i|we)\s+(?:go\s+ahead|proceed|continue|move\s+forward)\b/i,
  // "Would you like me to proceed/continue/go ahead"
  /\bwould\s+you\s+like\s+me\s+to\s+(?:go\s+ahead|proceed|continue|move\s+forward)\b/i,
  // "Do you want me to proceed" / "want me to continue"
  /\bwant\s+me\s+to\s+(?:go\s+ahead|proceed|continue|move\s+forward)\b/i,
  // "Let me know if/whether/how you'd like me to proceed/continue"
  /\blet\s+me\s+know\b[^\n.?!]*\b(?:proceed|continue|go\s+ahead|move\s+forward|like\s+me\s+to)\b/i,
  // "Awaiting/wait for your confirmation/approval/go-ahead/sign-off/response before proceeding"
  /\b(?:await(?:ing)?|wait\s+for)\b[^\n.?!]*\b(?:confirmation|approval|sign-?off|go-?ahead|your\s+(?:go|response|reply|input|approval))\b/i,
  // "confirm to proceed" / "confirm before I continue/generate/build/send/deliver"
  // (an explicit confirm-gate ahead of the deliverable action, not just "proceed")
  /\bconfirm\b[^\n.?!]*\b(?:to|before)\b[^\n.?!]*\b(?:proceed|continu|generat|build|start|begin|send|creat|draft|deliver|run\b)/i,
  // Numbered/lettered option prompt: "Reply 1 (…) or 2 (…)", "reply with option 2".
  // Opus emitted this exact form ("Reply 1 … or 2 …") instead of "Reply go" (ENG-369).
  /\breply\s+(?:with\s+)?(?:option\s+)?["'“]?\d\b/i,
  // "please confirm one of these / the following / which option / your choice below"
  /\bconfirm\b[^\n.?!]*\b(?:one of|which\b|the following|your\s+(?:choice|preference|selection)|these\b|option\b)/i,
  // "get/need/require/request your confirmation", "awaiting your confirmation"
  /\b(?:get|need|needs|require[sd]?|request(?:ing)?|await(?:ing)?)\s+(?:your\s+)?confirmation\b/i,
  // "need you to confirm/decide/choose/pick/select …" (asks the human to make the call)
  /\bneed\s+you\s+to\s+(?:confirm|decide|choose|pick|select|tell\s+me)\b/i,
  // "pick/choose/select an option", "once you pick an option" — enumerated-choice halt
  /\b(?:pick|choose|select)\s+(?:an?|one)\s+(?:option|of\b)/i,
  // "I'll pause here for your input", "pausing until you confirm", "holding off /
  // standing by until you reply / before proceeding". Anchored on a halt verb
  // FOLLOWED by an explicit wait-for-the-user object so a report that merely
  // mentions something being "paused" cannot trigger it.
  /\b(?:paus(?:e|ing|ed)|hold(?:ing)?\s+off|standing\s+by)\b[^\n.?!]*\b(?:your\s+(?:input|response|reply|confirmation|approval|go-?ahead|sign-?off)|you\s+(?:confirm|reply|respond|approve)|before\s+(?:proceed|continu))/i,
  // Generic decision-solicitation: the turn ends by asking the HUMAN to choose a
  // path rather than delivering. Opus emitted "How do you want to proceed?" +
  // "Reply 1, 2, or 3" — a different phrasing every run — so these key on the
  // structural act of handing the decision back to the user, not a fixed phrase.
  // "How do you want / would you like / should you prefer …" to proceed/handle this
  /\bhow\s+(?:do|would|should|shall)\s+you\s+(?:want|like|wish|prefer)\b/i,
  // "how should I|we proceed", "how would you like me to proceed"
  /\bhow\s+(?:should|shall|do|would)\s+(?:i|we|you\s+(?:want|like)\s+me)\b[^\n.?!]*\bproceed\b/i,
  // "which option/one/approach/route/path … (do) you …" — pick-a-branch question
  /\bwhich\s+(?:option|one|approach|route|path|of\s+(?:these|the))\b[^\n?!]*\byou\b/i,
  // "would you prefer / would you rather …"
  /\bwould\s+you\s+(?:prefer|rather)\b/i,
  // Deterministic backstop for ENG-480: the run reframes an impossible per-item
  // pattern correctly but STILL dead-ends by asking the human to supply a scope
  // parameter (a date range / time window) before it will deliver — a novel
  // phrasing the LLM judge is the only other line of defense against, and that
  // judge fails safe when its provider is unavailable. Two scoped catches:
  //   "Reply 'last 24h' (or give me an exact date range) and I'll generate…" —
  //   the turn tells the user to REPLY WITH A VALUE and dangles the deliverable
  //   behind it. Anchored on reply + a quoted value + a following "(", "," or
  //   "or" so a report that merely quotes text ("reply to my email") can't match.
  /\breply\s+["'“”][^"'“”\n]{1,40}["'“”]\s*(?:\(|,|\bor\b)/i,
  //   "what time window / date range / period … do you want?" — asks the human to
  //   specify the scope before proceeding. Scoped to scope-nouns so a delivered
  //   report asking a rhetorical "what does this mean" cannot trip it.
  /\bwhat\s+(?:time\s*window|date\s*range|range|time\s*frame|period|scope|window|day|month|week)\b[^\n?]{0,50}\bdo\s+you\b/i,
];

// Markdown emphasis and inline code fences (**bold**, _italic_, `code`) split
// words like "Reply **1**" so the pattern's \d never lands next to "Reply". The
// model routinely bolds the option numbers, so strip emphasis/code markers (and
// collapse the whitespace they leave behind) before the detector runs.
function stripMarkdownEmphasis(content: string): string {
  return content.replace(/[*_`~]+/g, '').replace(/[^\S\n]+/g, ' ');
}

export function scheduledRunAwaitsConfirmation(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  const normalized = stripMarkdownEmphasis(content);
  return AWAITING_CONFIRMATION_PATTERNS.some((re) => re.test(normalized));
}

// The distinct reasons a scheduled run's latest turn needs one more
// continuation before it can be considered finished. null = no continuation
// needed. Ordered by precedence when more than one signal is present.
export type ScheduledContinuationReason = 'preview-only' | 'budget' | 'confirmation' | 'unfinished';

// Classify why (if at all) a scheduled run's latest turn needs a continuation:
//   (a) 'budget' — the run was truncated because it exhausted its step budget
//       (truncatedByStepBudget) — the ENG-244 root cause. This is a
//       deterministic STATE flag set by generateSessionResponse whenever the
//       tool loop hits maxIterations, so it fires whether the final content is
//       the canned "reached the maximum steps" apology OR the model's own
//       partial text (the model usually complies with the "wrap up" nudge and
//       writes non-report text, so text-pattern matching alone misses it);
//   (b) 'confirmation' — the turn halted to ask a human to confirm/approve
//       before proceeding, with no human present to answer (ENG-369); or
//   (c) 'unfinished' — the final text explicitly admits it left work unfinished
//       (scheduledRunSignalsIncompleteWork).
// A 'preview-only' write-back gap (ENG-518) takes precedence over everything: it
// is a hard, tool-call-based fact (a list was previewed as enrichable but its
// execute counterpart never committed it) that stays true whatever the closing
// text said, and its continuation message is the most specific ("commit the
// write-back now"). Budget truncation comes next (also a hard state signal); a
// confirmation halt takes precedence over a plain unfinished-work admission so
// the continuation message can be tailored to "proceed best-effort".
// ENG-803: the terminal marker a publish-withheld run is instructed to end on (see
// the approval-required branch of getScheduledSessionOverride).
//
// Without this the fix would loop the very runs it protects. A withheld run
// correctly ends by saying its drafts are saved and nothing was posted — wording
// that the confirmation detector reads as "awaiting … approval", i.e. a run halting
// for a human answer. It would then be nudged to continue, on a schedule whose owner
// asked it NOT to publish, which is the ~21-turn nudge loop this whole area exists to
// avoid. The marker is emitted only on the withheld branch, so it distinguishes a
// deliberate, complete withhold from a genuine mid-run halt.
const PUBLISH_WITHHELD_MARKER = /PUBLISH WITHHELD:\s*this schedule requires approval before publishing/i;

// NOTE: this matches MODEL-AUTHORED text, so on its own it proves nothing. Callers
// must confirm the run was actually withheld before honouring it — see the
// publishAuthorized parameter on the classifiers below (Greptile review #20).
export function scheduledRunWithheldPublish(content?: string): boolean {
  if (!content || typeof content !== 'string') return false;
  return PUBLISH_WITHHELD_MARKER.test(content);
}

/**
 * ENG-803: may this run's publish-withheld marker be honoured?
 *
 * The marker is text the MODEL wrote, so trusting it alone re-opens the exact hole
 * this ticket is about (Greptile review #20): an AUTHORIZED run that simply does not
 * want to post can emit the sentence, suppress its own corrective continuation, and
 * finish "successfully" having published nothing. That is the fabricated publishing
 * constraint again, except this time the platform hands it a machine-readable way to
 * escape the nudge.
 *
 * So the marker is only honoured when the schedule ACTUALLY withheld authorization —
 * an explicit `false` resolved from the record. `undefined` (a caller with no
 * schedule to read) deliberately does NOT exempt: the two failure modes are not
 * symmetric. Refusing the exemption costs a genuinely-withheld run one extra
 * continuation, bounded by completionGateMaxContinuations; granting it on an unknown
 * lets any run talk its way out of a mandated publish.
 */
function withholdIsGenuine(content: string, publishAuthorized?: boolean): boolean {
  return publishAuthorized === false && scheduledRunWithheldPublish(content);
}

export function classifyScheduledContinuation(response: {
  content?: string;
  truncatedByStepBudget?: boolean;
  toolCalls?: any[];
}, publishAuthorized?: boolean): ScheduledContinuationReason | null {
  if (scheduledRunPreviewedWithoutExecute(response?.toolCalls || [])) return 'preview-only';
  if (response?.truncatedByStepBudget === true) return 'budget';
  const content = response?.content || '';
  // ENG-803: a deliberate publish-withhold is a COMPLETE terminal state, not a halt
  // awaiting an answer. Suppress only 'confirmation' — a withheld run can still be
  // genuinely truncated or leave other work unfinished, and those must still continue.
  if (!withholdIsGenuine(content, publishAuthorized) && scheduledRunAwaitsConfirmation(content)) return 'confirmation';
  if (scheduledRunSignalsIncompleteWork(content)) return 'unfinished';
  return null;
}

// Whole-response completion-gate check for scheduled runs — true when the latest
// turn needs one more continuation for any of the reasons above.
export function scheduledRunSignalsIncompleteResponse(response: {
  content?: string;
  truncatedByStepBudget?: boolean;
  toolCalls?: any[];
}): boolean {
  return classifyScheduledContinuation(response) !== null;
}

// LLM-judge fallback for the confirmation-halt case (ENG-369). The regex detector
// (scheduledRunAwaitsConfirmation) is a cheap fast-path, but live claude-opus-4-8
// runs proved it cannot keep up: the model invents a NEW phrasing of "stop and
// ask the human" on nearly every run (numbered menus, "how do you want to
// proceed?", "Reply 'all users' or name an account", …). A pattern list will
// always trail the model. So when the regex says "no", we ask a cheap, fast model
// the phrasing-independent question: did this turn defer the task to the user
// instead of delivering? This runs at most once per scheduled turn (only when the
// turn otherwise passes its requirements) and fails SAFE — any error/timeout falls
// back to the regex verdict, so the judge can only ADD detections, never remove.
const CONFIRMATION_JUDGE_MODEL = 'gemini-3.1-flash-lite';
const CONFIRMATION_JUDGE_TIMEOUT_MS = 8000;
const CONFIRMATION_JUDGE_SYSTEM = `You classify one message from an AUTOMATED, unattended run where NO human is available to reply.

Decide whether the assistant's message DEFERS finishing the task — i.e. it stops short of delivering the result and instead asks the human to confirm, approve, choose, decide, or reply BEFORE it will produce the deliverable.

Answer "yes" when the message, instead of delivering, does any of:
- asks the user to confirm/approve or to choose before it proceeds
- offers a numbered/lettered/quoted menu of options and tells the user to reply or pick one
- ends by asking how to proceed, which scope/approach/account to use, or "do you want…"
- says it is waiting for the user's input/decision before generating the result

Answer "no" when the message actually DELIVERS the result (a report, analysis, or the actions it took) — even if it also notes limitations, assumptions, or optional follow-up "next steps" that do not block completion.

Reply with ONLY one word: yes or no.`;

export async function scheduledTurnDefersToUser(content: string): Promise<boolean> {
  if (!content || typeof content !== 'string') return false;
  // Fast path: the regex catches the common forms with zero LLM cost/latency.
  if (scheduledRunAwaitsConfirmation(content)) return true;
  try {
    const llmPromise = agentModeService.callLLM(
      CONFIRMATION_JUDGE_MODEL,
      [
        { role: 'system', content: CONFIRMATION_JUDGE_SYSTEM },
        // The closing of the message is where a halt lives; cap input for cost.
        { role: 'user', content: content.slice(-2500) },
      ],
      { temperature: 0, max_completion_tokens: 3 }
    );
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('confirmation judge timed out')), CONFIRMATION_JUDGE_TIMEOUT_MS)
    );
    const res: any = await Promise.race([llmPromise, timeoutPromise]);
    const raw = (res?.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    return raw.startsWith('yes');
  } catch {
    return false; // fail-safe: never force a continuation on judge failure
  }
}

/**
 * ENG-803: resolve the publish authorization that is true RIGHT NOW.
 *
 * A scheduled run lives for minutes, and the owner can flip "Require approval before
 * publishing" while it is in flight. The prompt builder
 * (agentModeService.resolveScheduledPublishAuthorized) and the dispatch guard
 * (blockedByScheduledPublishApproval) both re-read the record at the moment they act,
 * so a snapshot taken when the worker loaded the schedule can disagree with both
 * (Greptile review #30). The disagreement is not cosmetic: with a stale `false`, an
 * owner who has just AUTHORIZED publishing gets a run whose model-authored
 * `PUBLISH WITHHELD` marker is still believed, suppressing the corrective
 * continuation — ENG-803's original "finished without posting" failure, rebuilt out
 * of a cache. So this reads the record, exactly like the other two consumers, and
 * feeds the same pure `resolvePublishAuthorized`.
 *
 * A READ FAILURE RETURNS undefined, NOT false. `false` is the one value that makes
 * the marker believable, so inventing it from a DynamoDB blip would let an unverified
 * model-authored sentence end the run. `undefined` withholds the exemption instead:
 * the run spends one more bounded continuation, and any genuinely unauthorized
 * publish it then attempts is still refused by the dispatch guard, which does its own
 * independent read. The two layers fail in opposite directions on purpose.
 */
async function resolveLivePublishAuthorized(scheduleId: string): Promise<boolean | undefined> {
  try {
    return resolvePublishAuthorized(await scheduleDb.getScheduleById(scheduleId) as any);
  } catch (error) {
    console.error(
      `AgentMode ENG-803: could not re-read schedule ${scheduleId} to verify a publish-withheld marker; refusing the exemption rather than trusting model-authored text:`,
      error
    );
    return undefined;
  }
}

// Async classifier used at the completion-gate decision points. Identical to the
// sync classifier except the 'confirmation' case also consults the LLM judge when
// the regex misses — so an unanticipated halt phrasing still triggers the
// best-effort continuation instead of dead-ending.
export async function classifyScheduledContinuationAsync(response: {
  content?: string;
  truncatedByStepBudget?: boolean;
  toolCalls?: any[];
}, resolvePublishAuthorizedNow?: () => Promise<boolean | undefined>): Promise<ScheduledContinuationReason | null> {
  if (scheduledRunPreviewedWithoutExecute(response?.toolCalls || [])) return 'preview-only';
  if (response?.truncatedByStepBudget === true) return 'budget';
  const content = response?.content || '';
  // ENG-803: resolve authorization LAZILY — only a turn that actually emitted the
  // marker can be exempted, so a turn without one must not pay for a schedule read.
  // Absent resolver (callers with no schedule) stays `undefined`, which never exempts.
  const publishAuthorized = scheduledRunWithheldPublish(content)
    ? await resolvePublishAuthorizedNow?.()
    : undefined;
  // ENG-803: same withhold exemption as the sync classifier above — and it must be
  // checked BEFORE the LLM judge, which would otherwise be asked to rule on text
  // that is deliberately shaped like a deferral.
  if (!withholdIsGenuine(content, publishAuthorized) && await scheduledTurnDefersToUser(content)) return 'confirmation';
  if (scheduledRunSignalsIncompleteWork(content)) return 'unfinished';
  return null;
}

// Result shape of a verified/scheduled chat run. Named so the ENG-396
// park/auto-take helper can return the same type the function returns.
type RunVerifiedChatResult = {
  success: boolean;
  content: string;
  toolCalls: any[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  functionStatus: Array<{
    functionName: string;
    requiredCount: number;
    actualCount: number;
    met: boolean;
  }>;
  attempts: number;
  workPlanCompleted: boolean;
  // ENG-396: set when a headless turn left an unanswered blocking AskUserQuestion.
  // The run stopped without proceeding on a guess; a human must answer it. The
  // scheduled caller maps this to a `pending_user_input` outcome and notifies.
  parked?: boolean;
  pendingUserQuestion?: PendingUserQuestion;
  // ENG-636: set when a run had to stop on a blocking question but the caller has
  // NO channel to reach a human (headless, fire-and-forget). The run failed
  // explicitly instead of parking into a void; there is no pendingUserQuestion to
  // answer. Distinct from `parked` so monitoring/callers can tell the two apart.
  parkedUnnotifiable?: boolean;
  // ENG-635: the run met its tool/keyword requirements but its final turn still
  // deferred to an absent human (completion gate exhausted while still asking to
  // confirm). `success` stays true (a deliverable existed for HTTP callers), but the
  // SCHEDULED path treats this as a failed run (records failure + oncall).
  deferredUnresolved?: boolean;
  // ENG-844: set when a scheduled run legitimately short-circuited on a conditional
  // guard (e.g. a Mon/Wed/Fri schedule running on a non-publishing day) and correctly
  // produced zero write calls. The run is a SUCCESSFUL skip — required write-call
  // minimums are waived instead of retry-pressed toward irreversible publishing.
  conditionalSkip?: boolean;
};

// Common function to run verified chat with work plan, keywords, and function call verification
// Used by both scheduled chat and verified-generate
export async function runVerifiedChat(
  params: {
    sessionId: string;
    userId: string;
    startingMessage: string;
    keywords: string[];
    requiredFunctions: Array<{ functionName: string; minCount: number }>;
    maxAttempts?: number;
    attachments?: any[];
    llmModel?: string;
    // Opt-in deterministic completion gate (scheduled runs only). When true and
    // the latest turn admits unfinished work (scheduledRunSignalsIncompleteWork),
    // issue up to `completionGateMaxContinuations` extra continuation turns
    // before returning success. Default off so other callers are unaffected.
    completionGate?: boolean;
    completionGateMaxContinuations?: number;
    // ENG-396: opt-in "full autonomy" (from the schedule). When true, a headless
    // turn that hits a blocking AskUserQuestion AUTO-TAKES Emma's recommended
    // option (logged as delegation) and continues, instead of parking — including
    // for IMMUTABLE questions. This is a deliberate, default-off WAIVER of the
    // human protection on irreversible decisions (owner opted in per-schedule).
    fullAutonomy?: boolean;
    // ENG-636: does a PARK on this run actually reach a human? Only true for
    // callers with a notification/answer channel: runScheduledChat (owner email)
    // and the interactive verifiedGenerate endpoint (the live session renders the
    // pendingUserQuestion card). Default FALSE so any headless, fire-and-forget
    // caller (resultEndpoint, imageReports, slack/humanEval/revision) is fail-safe:
    // an unanswerable park is surfaced as an explicit `parkedUnnotifiable` failure
    // rather than dropped into a void no one will ever action. Fail-safe default
    // means a NEW headless caller is covered automatically (no drift).
    parkNotifiable?: boolean;
    // ENG-803: reads this run's publish authorization AS IT IS NOW. Used ONLY to
    // decide whether the model's publish-withheld marker may be believed — see
    // withholdIsGenuine. Deliberately a resolver rather than a value: the owner can
    // change the setting mid-run, and a snapshot would disagree with the prompt
    // builder and the dispatch guard, which both re-read it (Greptile review #30).
    // Undefined for callers with no schedule, which never honour the marker.
    publishAuthorized?: () => Promise<boolean | undefined>;
    // ENG-657: tool calls already made in a PRIOR (abandoned) portion of this
    // session that this run is RESUMING. Seeded into the run's accumulated tool
    // calls so keyword/required-function verification counts the whole task, not
    // just the continuation turns — otherwise a resumed run would be wrongly marked
    // `passed: false` for calls it made before the interruption, and the verify
    // retry loop could re-prompt the model into re-running a completed side-effect.
    // `error` is preserved (ENG-844) so the conditional-skip error-veto can reject a
    // resumed run whose ABANDONED portion had a failed tool call — reconstructing only
    // names would hide that failure and let it be recorded as a clean skip.
    priorToolCalls?: Array<{ name: string; error?: any }>;
    // Injectable clock for the conditional-skip run-date cross-check (ENG-844).
    // Production leaves it undefined (the detector uses `new Date()`); tests pin it
    // so the cadence-vs-today check is deterministic regardless of the day CI runs.
    now?: Date;
    // Schedule's IANA timezone (ENG-844): the owner's weekday cadence is read in
    // this zone so a run near a midnight boundary is judged on the owner's calendar
    // day, not UTC. Undefined falls back to UTC.
    scheduleTimezone?: string;
  }
): Promise<RunVerifiedChatResult> {
  const {
    sessionId,
    userId,
    startingMessage,
    keywords = [],
    requiredFunctions = [],
    maxAttempts = 20,
    attachments = [],
    completionGate = false,
    completionGateMaxContinuations = 2,
    fullAutonomy = false,
    parkNotifiable = false,
    publishAuthorized
  } = params;

  // ENG-396: bound how many times a single full-autonomy run may auto-take a
  // question, so a model that keeps re-asking cannot loop until maxAttempts. Once
  // exhausted, the run parks (falls back to the safe default).
  let autoTakesUsed = 0;
  const MAX_AUTO_TAKES = 3;

  // Tracks how many completion-gate continuation turns we've already spent, so a
  // model that keeps admitting "not finished" can't loop indefinitely.
  let completionGateContinuationsUsed = 0;
  
  // Ensure attachments is always an array
  const attachmentsArray = Array.isArray(attachments) ? attachments : [];
  console.log('AgentMode runVerifiedChat: Received attachments:', attachmentsArray.length, attachmentsArray);

  let attempt = 0;
  let allContent = '';
  const allToolCalls: any[] = [];
  const sessionForModel = await chatbotDb.getChatSession(sessionId);
  let sessionModel = sessionForModel?.llmModel;
  const normalizedStartingMessage = startingMessage.toLowerCase();

  // Only apply task-type model overrides when no explicit model was provided.
  // When params.llmModel is set (e.g. from a scheduled chat's configured model),
  // respect the caller's choice instead of overriding based on required functions.
  if (!params.llmModel) {
    const shouldUseReportGenerationModel = requiredFunctions.some((reqFunc) => (
      reqFunc.functionName === 'update_html_file' || reqFunc.functionName === 'read_file_content' || reqFunc.functionName === 'create_blog_article'
    ));
    const shouldUseImageGenerationModel = requiredFunctions.some((reqFunc) => (
      reqFunc.functionName === 'generate_image'
    ));
    const shouldUseVideoGenerationModel = requiredFunctions.some((reqFunc) => (
      reqFunc.functionName === 'generate_video'
    ));
    if (shouldUseReportGenerationModel) {
      const reportGenModel = await agentModeService.getReportGenerationDefaultModel();
      if (sessionModel !== reportGenModel) {
        await chatbotDb.updateSessionLlmModel(sessionId, reportGenModel);
        sessionModel = reportGenModel;
      }
    } else if (shouldUseImageGenerationModel) {
      const imageGenModel = await agentModeService.getImageGenerationDefaultModel();
      if (sessionModel !== imageGenModel) {
        await chatbotDb.updateSessionLlmModel(sessionId, imageGenModel);
        sessionModel = imageGenModel;
      }
    } else if (shouldUseVideoGenerationModel) {
      const videoGenModel = await agentModeService.getVideoGenerationDefaultModel();
      if (sessionModel !== videoGenModel) {
        await chatbotDb.updateSessionLlmModel(sessionId, videoGenModel);
        sessionModel = videoGenModel;
      }
    }
  }
  const defaultModel = params.llmModel || sessionModel || await agentModeService.getDefaultModel();

  // Auto-install skills that contain required function calls so the LLM has
  // access to them from the start (avoids relying on the LLM to call install_skills).
  if (requiredFunctions.length > 0) {
    try {
      const [publishedSkills, userAllowedSkillIds] = await Promise.all([
        skillService.getPublishedSkills(),
        getAllowedSkills(userId)
      ]);
      const isWildcard = userAllowedSkillIds.includes('*');
      const requiredToolNames = new Set(requiredFunctions.map(rf => rf.functionName));

      // Find skills that contain any of the required tools and are allowed
      const skillIdsToInstall: string[] = [];
      for (const skill of publishedSkills) {
        const hasRequiredTool = skill.toolNames?.some(t => requiredToolNames.has(t));
        const isAllowed = isWildcard || userAllowedSkillIds.includes(skill.skillId);
        if (hasRequiredTool && isAllowed) {
          skillIdsToInstall.push(skill.skillId);
        }
      }

      // Also check if any required tools are "other" (not in any published skill)
      const adminToolNames = new Set(agentModeService.getAdminToolNames());
      const allSkillToolNames = new Set(publishedSkills.flatMap(s => s.toolNames || []));
      const hasOtherTools = [...requiredToolNames].some(t => !allSkillToolNames.has(t) && !adminToolNames.has(t));
      if (hasOtherTools && (isWildcard || userAllowedSkillIds.includes('__other_skills__'))) {
        skillIdsToInstall.push('__other_skills__');
      }

      // Auto-install admin tools if any required function calls are admin-only tools
      const hasAdminTools = [...requiredToolNames].some(t => adminToolNames.has(t));
      if (hasAdminTools) {
        skillIdsToInstall.push('__admin_tools__');
      }

      if (skillIdsToInstall.length > 0) {
        await agentModeService.installSkills(skillIdsToInstall, userId, sessionId);
      }
    } catch (error) {
      console.error('AgentMode runVerifiedChat: Error auto-installing skills for required functions:', error);
    }
  }

  // Count how many times a required function was called.
  const countCallsForRequirement = (functionName: string, calls: string[]): number => {
    return calls.filter(c => c === functionName).length;
  };

  // Track remaining keywords and function calls
  let remainingKeywords = [...keywords];
  const remainingFunctionCallCounts: Record<string, number> = {};
  requiredFunctions.forEach((reqFunc) => {
    remainingFunctionCallCounts[reqFunc.functionName] = reqFunc.minCount;
  });

  // Track all function calls across attempts. ENG-657: on a resume, seed with the
  // tool calls the abandoned portion already made so requiredFunctionCalls counts
  // the whole task — otherwise a resumed run is falsely marked incomplete and the
  // verify loop could re-prompt the model into re-running a completed side effect.
  const allActualFunctionCallsForReporting: string[] = Array.isArray(params.priorToolCalls)
    ? params.priorToolCalls.map((c) => c.name).filter(Boolean)
    : [];

  // Set when the completion gate asks for one more continuation turn; the next
  // iteration uses a "finish the unfinished entities" continuation message.
  let completionGateContinue = false;
  // Why the pending continuation was triggered, so the continuation message can
  // be tailored to the cause: 'budget' (cut off at its step budget, ENG-244),
  // 'confirmation' (halted asking a human to confirm before proceeding, ENG-369),
  // or 'unfinished' (admitted it left per-entity work undone).
  let completionGateReason: ScheduledContinuationReason = 'unfinished';

  // ENG-396: A turn — the MAIN turn OR a completion-gate continuation turn — may
  // have left an unanswered blocking AskUserQuestion (the tool handler persisted
  // it via updateSessionAskUserQuestion). Handle it identically at BOTH LLM call
  // sites so the park guarantee can never be bypassed: re-read from the DB (never
  // trust a stale in-memory blank), then decide between AUTO-TAKE and PARK.
  //
  // ENG-517: a headless/scheduled run must NOT block on a REVERSIBLE question —
  // a data shortfall, report-scope choice, etc. has an obvious safe default
  // (Emma's recommended option), so auto-take it and keep going rather than
  // parking and never delivering. IMMUTABLE questions (e.g. the Meta campaign
  // objective) still PARK unless the schedule opted into full autonomy — those
  // are the irreversible decisions a human must own (auto-taking one is the
  // deliberate per-schedule WAIVER that `fullAutonomy` represents).
  //
  // Either way the auto-take is bounded (MAX_AUTO_TAKES) and logged as a
  // delegation. Returns 'autoTake' (caller retries), a 'park' result to return,
  // or null when no question is awaiting.
  const resolveAwaitingUserQuestion = async (): Promise<
    { action: 'autoTake' } | { action: 'park'; result: RunVerifiedChatResult } | null
  > => {
    const postTurnSession = await chatbotDb.getChatSession(sessionId);
    if (postTurnSession?.pendingUserQuestion?.status !== 'awaiting') return null;
    const pending = postTurnSession.pendingUserQuestion;

    // Reversible questions auto-proceed in any headless run; immutable ones only
    // when the schedule explicitly waived the human protection (full autonomy).
    const canAutoTake = fullAutonomy || pending.immutable !== true;
    if (canAutoTake && autoTakesUsed < MAX_AUTO_TAKES) {
      autoTakesUsed++;
      const answered = resolveInboundAnswer(pending, { delegated: true }, new Date().toISOString());
      await chatbotDb.updateSessionAskUserQuestion(sessionId, answered, {
        requireStillAwaiting: pending.questionId,
      });
      const chosen = answered.options.find(o => o.id === answered.answer!.optionId);
      const takeKind = fullAutonomy && pending.immutable === true ? 'full-autonomy' : 'reversible-default';
      console.log(
        `AgentMode runVerifiedChat: ${takeKind} auto-take on session ${sessionId} — question ${pending.questionId} → "${chosen?.label}" (delegation); continuing`
      );
      // Breadcrumb in history so Emma sees the decision and resumes without
      // re-asking (best-effort; the persisted answer is the source of truth).
      // Label the breadcrumb by the actual session, not the trigger: runVerifiedChat
      // is also invoked from non-scheduled callers (verifiedGenerate, slack revision,
      // revisionService, humanEvalActionService, imageReports), so hardcoding
      // '[Scheduled run]' would write a false label into those sessions' history.
      const breadcrumbPrefix =
        fullAutonomy && pending.immutable === true
          ? '[Full autonomy]'
          : postTurnSession.sessionType === 'scheduled'
            ? '[Scheduled run]'
            : '[Auto-proceed]';
      try {
        await chatbotDb.addMessageToSession(sessionId, {
          role: 'user',
          content: `${breadcrumbPrefix} Proceed with "${chosen?.label}"${answered.answer?.rationale ? ` — ${answered.answer.rationale}` : ''}.`,
          timestamp: new Date().toISOString(),
          metadata: { timestamp: new Date().toISOString(), autoDelegatedAnswer: true, questionId: pending.questionId } as any,
        });
      } catch (breadcrumbError) {
        console.error('Failed to persist auto-take breadcrumb:', breadcrumbError);
      }
      return { action: 'autoTake' };
    }

    // Shared failure body for both park variants below.
    const stopResultBase = {
      success: false as const,
      content: allContent,
      toolCalls: allToolCalls,
      keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
      keywordMisses: remainingKeywords,
      functionCallMatches: [] as string[],
      functionCallMisses: requiredFunctions.map(f => f.functionName),
      functionStatus: requiredFunctions.map(reqFunc => ({
        functionName: reqFunc.functionName,
        requiredCount: reqFunc.minCount,
        actualCount: countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting),
        met: false,
      })),
      attempts: attempt,
      workPlanCompleted: false,
    };

    // ENG-636: a PARK only makes sense when a human will actually see and answer
    // the question. Callers with a notification/answer channel (scheduled →
    // owner email; interactive verifiedGenerate → live session card) set
    // parkNotifiable. Headless, fire-and-forget callers do NOT — for them a park
    // is a dead end: no one is told, no one can answer, and the run silently
    // delivers nothing. In that case FAIL EXPLICITLY (parkedUnnotifiable) instead
    // of returning a pendingUserQuestion nobody will ever action. This is the
    // correct terminal behavior for an IMMUTABLE question too: we must never
    // auto-decide an irreversible choice, and the write gate still blocks the
    // action — so an honest, monitorable failure is the safe outcome.
    if (!parkNotifiable) {
      console.error(
        `AgentMode runVerifiedChat: session ${sessionId} hit a blocking user question (${pending.questionId}, immutable=${pending.immutable === true}) after ${autoTakesUsed} auto-take(s), but this run has NO channel to reach a human (parkNotifiable=false). Failing explicitly rather than parking into a void — no deliverable, no one to answer (ENG-636).`
      );
      return {
        action: 'park',
        result: { ...stopResultBase, parkedUnnotifiable: true },
      };
    }

    console.warn(
      `AgentMode runVerifiedChat: parking session ${sessionId} — blocking user question (${pending.questionId}, immutable=${pending.immutable === true}) awaiting a human selection after ${autoTakesUsed} auto-take(s); run will not proceed on a guess. A human will be notified (scheduled owner email / interactive card).`
    );
    return {
      action: 'park',
      result: {
        ...stopResultBase,
        parked: true,
        pendingUserQuestion: postTurnSession.pendingUserQuestion,
      },
    };
  };

  while (attempt < maxAttempts) {
    attempt++;

    try {
      // Prepare user message for this attempt
      let userMessage = startingMessage;

      if (completionGateContinue) {
        // Completion-gate continuation. Tailor the message to why the prior turn
        // needed continuing, so a merely-truncated turn is not falsely told it
        // "indicated" unfinished work (ENG-244), and a confirmation halt is told
        // to proceed best-effort rather than to "finish remaining entities" (ENG-369).
        completionGateContinue = false;
        userMessage =
          completionGateReason === 'preview-only'
            ? 'Your previous run produced enrichment PREVIEWS (a dry-run sample) but ' +
              'never committed them with the write-back step (enrich_leads_execute), and ' +
              'a preview does not change any data. This is an automated run with no human ' +
              'present — do NOT wait for confirmation or approval. Act on what THIS ' +
              "scheduled task actually asked for:\n" +
              '• If the task asked you to ENRICH, update, populate, refresh, or fill in ' +
              'the leads (the usual case), you MUST now call enrich_leads_execute for ' +
              'every list whose preview was enrichable (processedCount > 0), using the ' +
              'same output_fields you previewed — do not merely describe what would ' +
              'happen; actually run the write-back. Skip only a list whose preview ' +
              'failed (processedCount === 0 with identityResolutionFailed > 0).\n' +
              '• If, and only if, the task EXPLICITLY asked to preview / sample / show ' +
              'what enrichment WOULD do WITHOUT changing the data, do NOT call ' +
              'enrich_leads_execute — deliver that preview report instead.\n' +
              'Then complete the rest of the requested workflow (e.g. recommendations, ' +
              'drafts) and produce the final report.'
          : completionGateReason === 'budget'
            ? 'The previous run was cut short because it exhausted its processing-step ' +
              'budget before it could produce the final deliverable. Using the data ' +
              'already gathered, produce the final consolidated report now. Surface any ' +
              'entities you could not fully research as actionable next steps.'
          : completionGateReason === 'confirmation'
            ? 'Your previous response paused to ask for confirmation or approval before ' +
              'proceeding, but this is an automated run with no human present to reply. ' +
              'Do NOT wait for confirmation. Proceed now with the best-effort approach you ' +
              'described: complete the task using the most reasonable available method, ' +
              'produce the final deliverable, and clearly note any assumptions or ' +
              'limitations you had to make. Never end an automated run by asking the user ' +
              'to reply before continuing.'
          : 'Your previous response indicated some entities/steps were not finished. ' +
            'Complete ALL remaining per-entity work now (research, filtering, approval ' +
            'checks, drafts) for every entity that is not finished and not genuinely ' +
            'blocked. Do not stop early. Then produce the final consolidated report, ' +
            'surfacing any genuinely blocked items as actionable next steps.';
        completionGateReason = 'unfinished';
        const continuationResponse = await generateSessionResponse(
          sessionId,
          userMessage,
          userId,
          defaultModel,
          []
        );
        if (continuationResponse.content) {
          allContent += (allContent ? '\n\n' : '') + continuationResponse.content;
        }
        const continuationToolCalls = continuationResponse.toolCalls || [];
        allToolCalls.push(...continuationToolCalls);
        allActualFunctionCallsForReporting.push(
          ...continuationToolCalls.map((call: any) => call.name).filter(Boolean)
        );
        // ENG-396: a completion-gate continuation turn can ALSO emit a blocking
        // AskUserQuestion. Route it through the same park/auto-take handler as the
        // main turn instead of falling through and returning success on an
        // unanswered question (the second LLM call site the original park missed).
        const continuationQuestion = await resolveAwaitingUserQuestion();
        if (continuationQuestion?.action === 'autoTake') {
          await waitForVerifiedChatRetry(attempt);
          continue;
        }
        if (continuationQuestion?.action === 'park') {
          return continuationQuestion.result;
        }
        // Re-evaluate the gate against the continuation's own output. Pass the
        // whole run's accumulated tool-call objects (name + arguments + result) so a
        // still-uncommitted per-list preview→execute gap (ENG-518) keeps the gate
        // firing until the write-back actually runs for every enrichable list.
        const continuationReason = await classifyScheduledContinuationAsync({
          ...continuationResponse,
          toolCalls: allToolCalls,
        }, publishAuthorized);
        if (
          completionGateContinuationsUsed < completionGateMaxContinuations &&
          attempt < maxAttempts &&
          continuationReason !== null
        ) {
          completionGateContinuationsUsed++;
          completionGateContinue = true;
          completionGateReason = continuationReason;
          await waitForVerifiedChatRetry(attempt);
          continue;
        }
        // ENG-635: the continuation budget (or attempt budget) is exhausted. If this
        // final continuation STILL defers the task to an absent human (a 'confirmation'
        // halt) rather than delivering, the run produced no real deliverable. Flag it
        // via `deferredUnresolved` (rather than flipping `success`) so the SCHEDULED
        // path records a failure + oncall, WITHOUT changing the success/HTTP contract
        // for non-scheduled callers (imageReports/revision/etc.) — those met their
        // required tool calls, so a deliverable DID exist and they must not 500.
        // Scoped to 'confirmation' only: an 'unfinished'/'budget' turn that still
        // surfaces a partial report with actionable next-steps is a valid terminal state.
        const haltedUnresolved = continuationReason === 'confirmation';
        if (haltedUnresolved) {
          console.warn(
            `AgentMode runVerifiedChat: session ${sessionId} exhausted the completion gate ` +
            `(${completionGateContinuationsUsed}/${completionGateMaxContinuations}) but the final turn still ` +
            `defers to the user — flagging deferredUnresolved (scheduled runs record a failure).`
          );
        }
        // Continuation produced no further blocking signal (or an accepted partial) → done.
        return {
          success: true,
          deferredUnresolved: haltedUnresolved,
          content: allContent,
          toolCalls: allToolCalls,
          keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
          keywordMisses: remainingKeywords,
          functionCallMatches: requiredFunctions.filter(reqFunc =>
            countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount
          ).map(reqFunc => reqFunc.functionName),
          functionCallMisses: requiredFunctions.filter(reqFunc =>
            countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) < reqFunc.minCount
          ).map(reqFunc => reqFunc.functionName),
          functionStatus: requiredFunctions.map((reqFunc) => {
            const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
            return { functionName: reqFunc.functionName, requiredCount: reqFunc.minCount, actualCount, met: actualCount >= reqFunc.minCount };
          }),
          attempts: attempt,
          workPlanCompleted: true
        };
      }

      if (attempt > 1) {
        // Check work plan status
        const session = await chatbotDb.getChatSession(sessionId);
        const workPlan = session?.workPlan;
        const workPlanCompleted = workPlan && workPlan.steps.every((step: any) => step.status === 'completed' || step.status === 'skipped');

        if (workPlan && !workPlanCompleted) {
          // Remind to complete pending steps
          userMessage = `Please perform the work on pending steps. After you are done, mark the steps as completed with set_work_plan_status.`;
        } else {
          // Work plan completed or doesn't exist - check keywords and function calls
          // NOTE: Only missing function calls are requested on retry. If a search tool
          // (e.g. you_search_web) was already called, it won't be re-requested even if the
          // output was insufficient. Avoid adding search tools to requiredFunctionCalls
          // unless a minimum call count is truly needed — the LLM calls them organically.
          const keywordText = remainingKeywords.length > 0
            ? `include these keywords: ${remainingKeywords.join(', ')}`
            : '';
          const functionCallText = requiredFunctions
            .filter(reqFunc => {
              const currentCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
              return currentCount < reqFunc.minCount;
            })
            .map(reqFunc => {
              const currentCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
              const remaining = reqFunc.minCount - currentCount;
              return `${reqFunc.functionName} (${remaining} more time${remaining > 1 ? 's' : ''} needed)`;
            })
            .join(', ');

          const parts = [keywordText, functionCallText].filter(Boolean);
          userMessage = parts.length > 0
            ? `Please try again. Make sure to ${parts.join(' and ')}.`
            : startingMessage;
        }
      }

      // Generate response
      // Only pass attachments on the first attempt to avoid duplicating them
      const attachmentsForThisAttempt = attempt === 1 ? attachmentsArray : [];
      console.log(`AgentMode runVerifiedChat: Attempt ${attempt}, passing ${attachmentsForThisAttempt.length} attachments to generateSessionResponse`);
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        userId,
        defaultModel,
        attachmentsForThisAttempt
      );

      if (!hasAssistantOutput(response)) {
        throw new ZeroAssistantOutputError(
          `Scheduled/verified chat attempt ${attempt} produced zero assistant output for session ${sessionId}`
        );
      }

      // Update content
      if (response.content) {
        allContent += (allContent ? '\n\n' : '') + response.content;
      }

      // Extract function calls from the response
      const toolCalls = response.toolCalls || [];
      allToolCalls.push(...toolCalls);
      const actualFunctionCalls = toolCalls.map((call: any) => call.name).filter(Boolean);

      allActualFunctionCallsForReporting.push(...actualFunctionCalls);

      // ENG-396: this MAIN turn may have left an unanswered blocking
      // AskUserQuestion — auto-take (full autonomy) or park before doing anything
      // else. Same handler covers the completion-gate continuation turn below.
      const mainTurnQuestion = await resolveAwaitingUserQuestion();
      if (mainTurnQuestion?.action === 'autoTake') {
        await waitForVerifiedChatRetry(attempt);
        continue;
      }
      if (mainTurnQuestion?.action === 'park') {
        return mainTurnQuestion.result;
      }

      // Check work plan status
      const workPlan = response.workPlan;
      const workPlanCompleted = workPlan && workPlan.steps.every((step: any) => step.status === 'completed' || step.status === 'skipped');

      // Only evaluate keywords and function calls if work plan is completed or doesn't exist
      let keywordMatches: string[] = [];
      let keywordMisses: string[] = [];
      let functionCallMatches: string[] = [];
      let functionCallMisses: string[] = [];

      if (!workPlan || workPlanCompleted) {
        // Evaluate keywords
        remainingKeywords.forEach((keyword: string) => {
          if (allContent.toLowerCase().includes(keyword.toLowerCase())) {
            keywordMatches.push(keyword);
          } else {
            keywordMisses.push(keyword);
          }
        });

        // Remove matched keywords
        remainingKeywords = remainingKeywords.filter(keyword =>
          !keywordMatches.includes(keyword)
        );

        // Evaluate function calls
        requiredFunctions.forEach((reqFunc) => {
          const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
          if (actualCount >= reqFunc.minCount) {
            functionCallMatches.push(reqFunc.functionName);
          } else {
            functionCallMisses.push(reqFunc.functionName);
          }
        });
      }

      // Check if all requirements are met
      const allKeywordsMet = remainingKeywords.length === 0;
      const allFunctionCallsMet = requiredFunctions.every(reqFunc => {
        return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount;
      });
      const allRequirementsMet = (!workPlan || workPlanCompleted) && allKeywordsMet && allFunctionCallsMet;

      // ENG-844: A scheduled run that legitimately short-circuited on a conditional
      // guard (e.g. a "publish only Mon/Wed/Fri" schedule running on a non-publishing
      // day) produces zero write calls BY DESIGN and reports a clean skip. Do NOT keep
      // retrying to satisfy requiredFunctionCalls — that pressure is aimed at
      // IRREVERSIBLE publishing tools (post_on_connected_account / generate_image) and,
      // because each retry re-sends an identical prompt, eventually trips the anti-loop
      // override. Treat it as a SUCCESSFUL skip: waive the unmet write-call minimums and
      // exit cleanly. Scoped to scheduled runs (completionGate) so interactive/image/
      // revision callers are unaffected, and only fires when a required call is actually
      // unmet — a run that DID publish flows through the normal success path below.
      //
      // A true cadence skip makes ZERO write calls by design. If ANY required write
      // call was actually made (a partially-executed run — e.g. it published to one
      // destination then emitted skip wording), this is NOT a skip: waiving here would
      // launder partial external state into a clean "skip" and clear the misses on the
      // still-unmet calls. Require every required call to have zero invocations before
      // the carve-out is even eligible (Greptile P1, ENG-844).
      const noRequiredWriteCallsMade = requiredFunctions.every(
        (reqFunc) => countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) === 0
      );
      // The no-side-effects skip invariant must see the WHOLE task's tool calls,
      // including any made in an abandoned portion that this run resumed. Those
      // live in params.priorToolCalls (seeded into the required-call counts but not
      // into allToolCalls), so a resumed non-required write — e.g. an email sent
      // before the interruption — would otherwise be invisible to the write-veto
      // and a partial run could be laundered into a clean skip (Greptile P1, ENG-844).
      const skipLedgerToolCalls = [...(params.priorToolCalls ?? []), ...allToolCalls];
      if (completionGate && !allFunctionCallsMet && noRequiredWriteCallsMade &&
          scheduledRunSignalsConditionalSkip(allContent, { toolCalls: skipLedgerToolCalls, instruction: startingMessage, now: params.now, timezone: params.scheduleTimezone })) {
        // Low-severity breadcrumb: a conditional skip is a SUCCESSFUL run, but it is
        // waiving write-call minimums on an audited publishing pipeline, so keep it
        // observable (and threaded into runResults via `conditionalSkip`) rather than
        // laundering it through the silent success path (ENG-844).
        const waivedWriteCalls = requiredFunctions
          .filter((reqFunc) => countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) < reqFunc.minCount)
          .map((reqFunc) => reqFunc.functionName);
        console.log(
          `AgentMode runVerifiedChat: session ${sessionId} legitimately short-circuited on a conditional ` +
          `CADENCE skip day (no write calls, no tool errors) — recording a successful skip without pressing ` +
          `for required write calls. Unmet write minimums waived: ${waivedWriteCalls.join(', ') || '(none)'}`
        );
        const skipFunctionStatus = requiredFunctions.map((reqFunc) => {
          const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
          return { functionName: reqFunc.functionName, requiredCount: reqFunc.minCount, actualCount, met: actualCount >= reqFunc.minCount };
        });
        return {
          success: true,
          conditionalSkip: true,
          content: allContent,
          toolCalls: allToolCalls,
          keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
          keywordMisses: [],
          functionCallMatches: requiredFunctions.filter(reqFunc =>
            countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount
          ).map(reqFunc => reqFunc.functionName),
          functionCallMisses: [],
          functionStatus: skipFunctionStatus,
          attempts: attempt,
          workPlanCompleted: workPlanCompleted || !workPlan,
        };
      }

      // Deterministic completion gate (opt-in, scheduled runs only): if all other
      // requirements are met but the latest turn admits it left work unfinished,
      // spend one more continuation turn instead of returning success — unless we
      // still have attempts left AND haven't exhausted the continuation budget.
      // Only consult the classifier (which may make one cheap LLM-judge call) when
      // the gate is actually eligible to fire — avoids any judge cost on the
      // common path where completionGate is off or requirements are unmet.
      const gateEligible =
        allRequirementsMet &&
        completionGate &&
        completionGateContinuationsUsed < completionGateMaxContinuations &&
        attempt < maxAttempts;
      const responseContinuationReason = gateEligible
        ? await classifyScheduledContinuationAsync({
            ...response,
            // Preview→execute detection needs the whole run's tool-call objects
            // (name + arguments + result), not just this turn's — an earlier attempt
            // may hold the unmatched, still-uncommitted preview.
            toolCalls: allToolCalls,
          }, publishAuthorized)
        : null;
      if (gateEligible && responseContinuationReason !== null) {
        completionGateContinuationsUsed++;
        console.log(
          `AgentMode runVerifiedChat: completion gate triggered (continuation ${completionGateContinuationsUsed}/${completionGateMaxContinuations}, reason=${responseContinuationReason}) for session ${sessionId}`
        );
        completionGateContinue = true;
        completionGateReason = responseContinuationReason;
        await waitForVerifiedChatRetry(attempt);
        continue;
      }

      if (allRequirementsMet) {
        // Build final function status
        const functionStatus = requiredFunctions.map((reqFunc) => {
          const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
          return {
            functionName: reqFunc.functionName,
            requiredCount: reqFunc.minCount,
            actualCount: actualCount,
            met: actualCount >= reqFunc.minCount
          };
        });

        return {
          success: true,
          content: allContent,
          toolCalls: allToolCalls,
          keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
          keywordMisses: remainingKeywords,
          functionCallMatches: requiredFunctions.filter(reqFunc => {
            return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount;
          }).map(reqFunc => reqFunc.functionName),
          functionCallMisses: requiredFunctions.filter(reqFunc => {
            return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) < reqFunc.minCount;
          }).map(reqFunc => reqFunc.functionName),
          functionStatus,
          attempts: attempt,
          workPlanCompleted: workPlanCompleted || !workPlan
        };
      }

    } catch (error) {
      console.error(`Run verified chat attempt ${attempt} failed:`, error);
      if (isZeroAssistantOutputError(error)) {
        if (attempt === maxAttempts) {
          throw error;
        }
        await waitForVerifiedChatRetry(attempt);
        continue;
      }
      if (isSessionLimitError(error)) {
        throw error;
      }
      if (!isTransientLLMError(error) || isContextLimitError(error)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw error;
      }
      await waitForVerifiedChatRetry(attempt);
    }
  }

  // If we get here, we've exhausted all attempts
  const functionStatus = requiredFunctions.map((reqFunc) => {
    const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
    return {
      functionName: reqFunc.functionName,
      requiredCount: reqFunc.minCount,
      actualCount: actualCount,
      met: actualCount >= reqFunc.minCount
    };
  });

  return {
    success: false,
    content: allContent,
    toolCalls: allToolCalls,
    keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
    keywordMisses: remainingKeywords,
    functionCallMatches: requiredFunctions.filter(reqFunc => {
      return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount;
    }).map(reqFunc => reqFunc.functionName),
    functionCallMisses: requiredFunctions.filter(reqFunc => {
      return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) < reqFunc.minCount;
    }).map(reqFunc => reqFunc.functionName),
    functionStatus,
    attempts: attempt,
    workPlanCompleted: false
  };
}

class ZeroAssistantOutputError extends Error {
  code = 'ZERO_ASSISTANT_OUTPUT';

  constructor(message: string) {
    super(message);
    this.name = 'ZeroAssistantOutputError';
  }
}

function isZeroAssistantOutputError(error: unknown): boolean {
  return error instanceof ZeroAssistantOutputError
    || (typeof error === 'object' && error !== null && (error as any).code === 'ZERO_ASSISTANT_OUTPUT')
    || (error instanceof Error && error.name === 'ZeroAssistantOutputError');
}

function hasAssistantOutput(response: {
  content?: string;
  toolCalls?: any[];
  responseMessages?: any[];
}): boolean {
  const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
  const hasToolCalls = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  const hasAssistantMessage = Array.isArray(response.responseMessages)
    && response.responseMessages.some((message: any) => message?.role === 'assistant');

  return hasContent || hasToolCalls || hasAssistantMessage;
}

async function waitForVerifiedChatRetry(attempt: number): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;

  const delayMs = Math.min(30_000, 1_000 * Math.pow(2, Math.max(0, attempt - 1)));
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

async function sessionHasAssistantMessage(sessionId: string): Promise<boolean | undefined> {
  try {
    const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
    if (!Array.isArray(messages)) return undefined;
    return messages.some((message: any) => message?.role === 'assistant');
  } catch (error) {
    console.error(`Scheduled chat zero-output check failed for session ${sessionId}:`, error);
    return undefined;
  }
}

function getZeroAssistantRetryCount(schedule: any): number {
  const rawCount = Number(schedule?.zeroAssistantRetryCount || 0);
  return Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
}

/**
 * Tell the schedule owner a run needs a human look. Recipients: the schedule's
 * configured notification list, else the owner's account email. Best-effort by
 * design — a notification failure must never break the run.
 */
async function notifyScheduleOwnerOfFailure(
  schedule: any,
  userId: string,
  detail: { failedAttempts: number; failureClass: any }
): Promise<void> {
  try {
    let recipients: string[] = Array.isArray(schedule.emailNotifications)
      ? schedule.emailNotifications.filter((e: any) => typeof e === 'string' && e.trim())
      : [];
    if (recipients.length === 0) {
      const owner = await userDb.getUserById(userId);
      if (owner?.email) recipients = [owner.email];
    }
    if (recipients.length > 0) {
      await emailService.sendScheduledRunFailedEmail(
        recipients, schedule.scheduleName, schedule.scheduleId, detail
      );
    } else {
      console.error(
        `No notification recipients for schedule ${schedule.scheduleId}; owner alert skipped.`
      );
    }
  } catch (notifyError) {
    console.error(`Failed to send owner failure alert for schedule ${schedule.scheduleId}:`, notifyError);
  }
}

function getZeroAssistantRequeueDelayMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  return Math.min(ZERO_ASSISTANT_REQUEUE_MAX_MS, ZERO_ASSISTANT_REQUEUE_BASE_MS * Math.pow(2, exponent));
}

// Common function to run a scheduled chat (used by both test and actual execution)
//
// ENG-446: the run result IS the run envelope. It carries the canonical
// marketing-action payload (MarketingActionCarrier — optional, because legacy
// runs carry none) alongside the existing output, and is persisted verbatim by
// scheduleDb.addRunResult, so no separate action storage path exists.
export async function runScheduledChat(
  schedule: any,
  userId: string,
  isTest: boolean = false,
  preGeneratedRunId?: string,
  // Injectable clock forwarded to the conditional-skip run-date cross-check
  // (ENG-844). Production omits it; tests pin it for a deterministic weekday.
  nowOverride?: Date
): Promise<MarketingActionCarrier & {
  scheduleId: string;
  runId: string;
  // ENG-396: 'pending_user_input' when the run parked on a blocking AskUserQuestion.
  status: 'success' | 'failure' | 'pending_user_input';
  passed: boolean;
  actualResponse: string;
  actualFunctionCalls: string[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  executionTime: number;
  sessionId: string;
  attempt: number;
  createdAt: string;
  summary?: string;
  // Present only on a parked run — links the pending question for the UI.
  pendingQuestionId?: string;
}> {
  const now = new Date();
  let sessionId: string = '';
  let generatedSummary: string | undefined;

  // ENG-324: durable in-flight lease. Set once the session exists (below), kept
  // fresh by a heartbeat timer, and always cleared in `finally`. Skipped for test
  // runs, which are never requeued.
  const leaseRunId: string = preGeneratedRunId || require('uuid').v4();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let leaseAcquired = false;
  // ENG-971: successes already on the session when THIS run started — empty for a
  // fresh session, the abandoned run's totals when resuming one. Hoisted above the
  // try because the zero-output requeue decision reads it from the CATCH.
  let runStartCalledFunctions: Record<string, number> | null = null;

  try {
    // Guard against orphaned schedules whose owning user no longer exists.
    // Without this, downstream calls (e.g. token-usage checks) throw
    // "User not found: <userId>" on every run, repeatedly alerting oncall.
    // Auto-pause the schedule so it stops firing, and return gracefully.
    const scheduleOwner = await userDb.getUserById(userId);
    if (!scheduleOwner) {
      console.warn(
        `Scheduled chat "${schedule.scheduleName}" (${schedule.scheduleId}) references a missing user ${userId}. Auto-pausing schedule.`
      );

      if (!isTest) {
        try {
          await scheduleDb.updateSchedule(schedule.scheduleId, {
            status: 'paused',
            updatedAt: new Date().toISOString(),
          });
        } catch (pauseError) {
          console.error(
            `Failed to auto-pause orphaned schedule ${schedule.scheduleId}:`,
            pauseError
          );
        }
      }

      const orphanedUserResult = {
        scheduleId: schedule.scheduleId,
        runId: preGeneratedRunId || require('uuid').v4(),
        status: 'failure' as const,
        passed: false,
        actualResponse: `Scheduled chat paused: the owning user (${userId}) no longer exists.`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString(),
      };

      try {
        await scheduleDb.addRunResult(schedule.scheduleId, orphanedUserResult);
      } catch (saveError) {
        console.error('Error saving orphaned-user run result:', saveError);
      }

      return orphanedUserResult;
    }

    const scheduleVariables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
    const scheduleVariableValues = (schedule.variableValues && typeof schedule.variableValues === 'object')
      ? schedule.variableValues as Record<string, string>
      : {};
    const missingVariableNames = getMissingScheduledChatVariableNames(scheduleVariables, scheduleVariableValues);
    if (scheduleVariables.length > 0 && missingVariableNames.length > 0) {
      return {
        scheduleId: schedule.scheduleId,
        runId: require('uuid').v4(),
        status: 'failure' as const,
        passed: false,
        actualResponse: `Scheduled chat cannot run. Missing variable values: ${missingVariableNames.map(name => `{{${name}}}`).join(', ')}`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString()
      };
    }

    // Check if required function calls are allowed for the user's subscription
    const expectedFunctionCalls = schedule.requiredFunctionCalls || [];
    if (expectedFunctionCalls.length > 0) {
      const { getAllowedFunctionCalls } = await import('../services/subscriptionService');
      const allowedFunctionCalls = await getAllowedFunctionCalls(userId);

      // If wildcard is present, all function calls are allowed — skip filtering
      const allAllowed = allowedFunctionCalls.includes("*");

      // Foundation tools are always allowed regardless of subscription
      const foundationTools = agentModeService.getFoundationToolNames();
      // Admin tools are allowed for admin users
      const { userDb } = await import('../services/db');
      const scheduleUser = await userDb.getUserById(userId);
      const adminToolNames = new Set(agentModeService.getAdminToolNames());
      const isAdminUser = scheduleUser?.isAdmin || false;
      const disallowedFunctions = allAllowed ? [] : expectedFunctionCalls.filter((funcName: string) =>
        !allowedFunctionCalls.includes(funcName) && !foundationTools.has(funcName) && !(isAdminUser && adminToolNames.has(funcName))
      );

      if (disallowedFunctions.length > 0) {
        const emailNotifications = schedule.emailNotifications || [];
        
        // Send error email instead of running
        const { emailService } = await import('../services/emailService');
        await emailService.sendScheduledChatErrorEmail(
          emailNotifications.length > 0 ? emailNotifications : (scheduleUser?.email ? [scheduleUser.email] : []),
          schedule.scheduleName,
          disallowedFunctions,
          schedule.scheduleId
        );
        
        // Create failure result
        const errorResult = {
          scheduleId: schedule.scheduleId,
          runId: require('uuid').v4(),
          status: 'failure' as const,
          passed: false,
          actualResponse: `Scheduled chat cannot run: Required function calls are not allowed by your subscription: ${disallowedFunctions.join(', ')}`,
          actualFunctionCalls: [],
          keywordMatches: [],
          keywordMisses: [],
          functionCallMatches: [],
          functionCallMisses: disallowedFunctions,
          executionTime: 0,
          sessionId: '',
          attempt: 0,
          createdAt: new Date().toISOString()
        };
        
        // Save the error result to database
        try {
          await scheduleDb.addRunResult(schedule.scheduleId, errorResult);
        } catch (error) {
          console.error('Error saving error run result:', error);
        }
        
        return errorResult;
      }
    }

    // Check token usage limits before creating the session
    const usageStatus = await checkTokenUsage(userId);
    if (!usageStatus.allowed) {
      const emailNotifications = schedule.emailNotifications || [];
      let notifyEmails: string[] = emailNotifications;
      if (notifyEmails.length === 0) {
        const { userDb: tokenUserDb } = await import('../services/db');
        const tokenUser = await tokenUserDb.getUserById(userId);
        if (tokenUser?.email) notifyEmails = [tokenUser.email];
      }

      if (notifyEmails.length > 0) {
        const { emailService } = await import('../services/emailService');
        await emailService.sendScheduledChatTokenLimitEmail(
          notifyEmails,
          schedule.scheduleName,
          schedule.scheduleId,
          usageStatus
        );
      }

      // A block can be caused by either the token-count cap or the dollar cost
      // cap (ENG-200). When the cost cap is the trigger — which is the only reason
      // a user with an unlimited token allowance can be blocked — render a
      // cost-based message so it doesn't misleadingly read "0 tokens used".
      const { blockedByCost } = deriveBlockedByCost(usageStatus);
      const blockMessage = blockedByCost
        ? `Scheduled chat cannot run: Monthly cost limit reached ($${(usageStatus.costUsed ?? 0).toFixed(2)} / $${(usageStatus.costAllowance ?? 0).toFixed(2)} spent this month).`
        : `Scheduled chat cannot run: Monthly token limit reached (${usageStatus.used?.toLocaleString() ?? 0} / ${usageStatus.allowance?.toLocaleString() ?? 0} tokens used).`;

      const tokenLimitResult = {
        scheduleId: schedule.scheduleId,
        runId: require('uuid').v4(),
        status: 'failure' as const,
        passed: false,
        actualResponse: blockMessage,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString()
      };

      try {
        await scheduleDb.addRunResult(schedule.scheduleId, tokenLimitResult);
      } catch (error) {
        console.error('Error saving token limit run result:', error);
      }

      return tokenLimitResult;
    }

    const sessionTitle = isTest ? `Test: ${schedule.scheduleName}` : `Scheduled: ${schedule.scheduleName}`;
    const pageIdentifier = `${sessionTitle}|scheduleId:${schedule.scheduleId}`;

    // ENG-479 (GAP 1): stamp the durable in-flight lease BEFORE creating the session
    // and start heartbeating it. ENG-324 stamped the lease only AFTER
    // createChatSession, which left a window: a hard-kill (OOM/SIGKILL) landing
    // between session creation and the lease write produced a session with no lease
    // — invisible to the reconciler (getInFlightSchedules keys off attribute_exists
    // (runInFlight)), so it was never requeued and stayed silently zero-output.
    // Stamping first makes any death from here through the LLM turn reconciler-
    // visible. The lease carries no sessionId yet; it's attached below once the
    // session exists (the reconciler tolerates an empty sessionId — it just skips
    // annotation, but still requeues the run).
    if (!isTest) {
      try {
        const leaseOutcome = await scheduleDb.setRunInFlight(schedule.scheduleId, {
          runId: leaseRunId,
          sessionId: '',
          startedAt: new Date().toISOString(),
          instanceId: SCHEDULED_RUN_INSTANCE_ID,
        });
        if (leaseOutcome === 'already_in_flight') {
          // Another dispatcher already owns this schedule's run right now (a real
          // cross-instance race, not hypothetical). Bail out completely — no session,
          // no resume check, nothing — rather than proceed alongside it and risk
          // clobbering its lease later via our own (conditional-on-our-runId) clear.
          console.warn(`runScheduledChat: schedule ${schedule.scheduleId} already has an active in-flight run on another dispatcher; skipping this concurrent dispatch.`);
          return {
            scheduleId: schedule.scheduleId,
            runId: leaseRunId,
            status: 'success' as const,
            passed: false,
            actualResponse: 'Scheduled run skipped: this schedule is already being run by another dispatcher.',
            actualFunctionCalls: [],
            keywordMatches: [],
            keywordMisses: schedule.keywords || [],
            functionCallMatches: [],
            functionCallMisses: schedule.requiredFunctionCalls || [],
            executionTime: 0,
            sessionId: '',
            attempt: 0,
            createdAt: new Date().toISOString(),
          };
        }
        leaseAcquired = leaseOutcome === 'acquired';
        if (leaseAcquired) {
          heartbeatTimer = setInterval(() => {
            void scheduleDb.heartbeatRunInFlight(schedule.scheduleId, leaseRunId);
          }, HEARTBEAT_INTERVAL_MS);
          if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
        }
      } catch (leaseError) {
        // leaseAcquired stays false here — this is NOT swallowed as a tolerable
        // no-lease continuation. The guard immediately below refuses to run this
        // dispatch at all without a durable lease (Greptile: a lease failure must
        // not let a session run untracked).
        console.error(`Failed to set in-flight lease for schedule ${schedule.scheduleId}:`, leaseError);
      }
    }

    // A deferred fire returns cleanly (no exception), so it does NOT leave a stale
    // lease for the reconciler to catch — unlike a crash, nothing will retry it soon
    // on its own. And the dispatch loop already advanced nextRunTime to the FULL next
    // cadence *before* calling into this run (to prevent double-dispatch), so without
    // this, a defer would silently wait a full cycle instead of retrying shortly —
    // worse than the crash case it exists to avoid (Greptile). Mirror the
    // reconciler's own short, bounded backoff so a defer gets another attempt soon,
    // capped by the same requeue limit so a persistently un-resumable schedule still
    // eventually falls back to its normal cadence instead of retrying forever.
    const scheduleRetrySoon = async () => {
      const nextRetryCount = getZeroAssistantRetryCount(schedule) + 1;
      if (nextRetryCount > ZERO_ASSISTANT_MAX_REQUEUES) return;
      try {
        await scheduleDb.updateSchedule(schedule.scheduleId, {
          nextRunTime: new Date(Date.now() + getZeroAssistantRequeueDelayMs(nextRetryCount)).toISOString(),
          zeroAssistantRetryCount: nextRetryCount,
          updatedAt: new Date().toISOString(),
        });
      } catch (retryScheduleError) {
        console.error(`runScheduledChat: failed to schedule a short retry after a no-lease defer for ${schedule.scheduleId}:`, retryScheduleError);
      }
    };

    // Require a durable lease before running ANY non-test scheduled dispatch, not
    // just resume (Greptile). Without this, a lease-establishment failure let a
    // FRESH session get created and run untracked: a kill during that run would be
    // invisible to the reconciler (no lease to find), so the abandoned session's
    // final deliverable would just never arrive, with nothing to auto-heal it.
    // Defer and retry shortly instead of running blind.
    if (!isTest && !leaseAcquired) {
      console.warn(`runScheduledChat: no durable lease for schedule ${schedule.scheduleId}; skipping this dispatch rather than running untracked.`);
      await scheduleRetrySoon();
      return {
        scheduleId: schedule.scheduleId,
        runId: leaseRunId,
        status: 'success' as const,
        passed: false,
        actualResponse: 'Scheduled run deferred (no-lease): could not establish a durable in-flight lease; will retry shortly rather than run untracked.',
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString(),
      };
    }

    // ENG-657: resume path. When the reconciler marked this schedule to resume an
    // abandoned session (it ended on a safe boundary), CONTINUE that session from
    // its last completed step instead of creating a fresh one and re-running the
    // whole task. The marker is consumed unconditionally (at-most-once resume);
    // anything off — session gone, wrong owner, or no longer safely resumable —
    // falls back to a normal fresh run, so this is strictly additive.
    let isResumeRun = false;
    // ENG-657: tool calls the abandoned portion already made, seeded into the
    // resumed run's verification so requiredFunctionCalls counts the whole task.
    let resumePriorToolCalls: Array<{ name: string; error?: any }> = [];
    const pendingResumeSessionId: string | undefined =
      !isTest && typeof schedule.pendingResumeSessionId === 'string' && schedule.pendingResumeSessionId
        ? schedule.pendingResumeSessionId
        : undefined;
    if (pendingResumeSessionId) {
      // A benign "deferred" result for the bow-out paths below. The resume-marker path
      // is resume-OR-BOW-OUT: it must NEVER fall through to a fresh restart, because a
      // restart re-runs the whole task — duplicating the already-completed CRM writes /
      // emails the marker exists to continue past. When we can't resume, we defer:
      // recovery is left to the claim winner or the reconciler. Records no run result
      // (returns before addRunResult) and no sessionId (no email/scoring of a non-run);
      // the in-flight lease is released by the `finally` on return.
      const deferredResumeResult = (reason: string) => ({
        scheduleId: schedule.scheduleId,
        runId: leaseRunId,
        status: 'success' as const, // no error occurred — recovery is simply deferred
        passed: false,
        actualResponse: `Scheduled run deferred (${reason}): resume of the abandoned session is being handled by the claim winner or the reconciler; no duplicate execution was performed.`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString(),
      });

      // scheduleRetrySoon is defined above (shared with the general no-lease bail-out)
      // and a durable lease is already guaranteed by this point — the no-lease case
      // returns before ever reaching pendingResumeSessionId, above.

      // Load + validate BEFORE claiming, so a transient read failure never consumes
      // the marker or triggers a restart — the marker persists and a later fire retries.
      let resumeSession: any;
      let loadThrew = false;
      try {
        resumeSession = await chatbotDb.getChatSession(pendingResumeSessionId);
      } catch (resumeError) {
        loadThrew = true;
        console.error(`runScheduledChat: failed to load resume session ${pendingResumeSessionId}; leaving the marker for a later retry (no restart):`, resumeError);
      }

      if (loadThrew) {
        // Transient load failure: marker left intact for the next fire; do not restart.
        await scheduleRetrySoon();
        return deferredResumeResult('load-error');
      }

      const canResume =
        !!resumeSession &&
        resumeSession.userId === userId &&
        planScheduledRunResume((resumeSession.messages || []) as any).resumable;

      if (!canResume) {
        // Marker present but the session can't be safely resumed now (missing / owner
        // mismatch / no-longer-safe boundary — a rare race, since the reconciler only
        // marks resumable sessions). A retry-soon here would eventually land a fresh
        // restart of the same task, re-running the abandoned session's already-
        // completed side effects — the exact thing this whole resume-or-bow-out path
        // exists to prevent (Greptile). Auto-restart is not a safe recovery for this
        // one; PAUSE the schedule and alert oncall instead, so a human decides rather
        // than an automatic retry silently duplicating real-world side effects.
        //
        // Claim the marker and pause in ONE atomic conditional write (Greptile),
        // not two sequential steps — a separately-claimed-then-retried-pause can
        // split (claim succeeds, every pause write then fails), leaving an ACTIVE
        // schedule with no resume identity that a later fire restarts from scratch.
        // A single atomic write can't partially apply: any failure (lost race or
        // transient) leaves the marker untouched, safe to retry.
        let pauseOutcome: 'paused' | 'lost_claim' | 'error' = 'error';
        for (let attempt = 0; attempt < 3 && pauseOutcome === 'error'; attempt++) {
          pauseOutcome = await scheduleDb.claimAndPauseUnresumable(schedule.scheduleId, pendingResumeSessionId);
        }
        if (pauseOutcome === 'lost_claim') {
          console.warn(`runScheduledChat: lost the claim while marking session ${pendingResumeSessionId} unresumable; another dispatcher owns this schedule's recovery — not pausing.`);
          return deferredResumeResult('not-resumable-unowned');
        }
        if (pauseOutcome === 'error') {
          // Marker is still intact — the atomic write never partially applied — so
          // retrying soon is safe: no duplicate-effect risk, unlike a consumed-but-
          // unpaused marker would carry.
          console.error(`runScheduledChat: failed to claim+pause schedule ${schedule.scheduleId} after 3 attempts; marker left intact for a later retry (no duplicate-effect risk).`);
          await scheduleRetrySoon();
          return deferredResumeResult('not-resumable-pause-failed');
        }
        console.warn(`runScheduledChat: resume marker for session ${pendingResumeSessionId} no longer resumable; paused schedule (no auto-restart, to avoid duplicate side effects) and alerting oncall.`);
        void fileAutoIssue({
          title: `Scheduled Chat auto-paused: ${schedule.scheduleName}`,
          description: `Schedule "${schedule.scheduleName}" had an abandoned run (session ${pendingResumeSessionId}) that the reconciler marked resumable, but it was no longer safely resumable by the time this dispatch ran. Auto-restarting would risk re-running the abandoned session's already-completed side effects (e.g. CRM writes, emails), so the schedule has been paused instead of auto-retried. Review the session and re-enable the schedule manually.`,
          source: 'Scheduled chat (resume)',
          extraLabels: ['Scheduled Chat'],
          notionTags: ['Scheduled Chat'],
          notionContext: {
            'Schedule ID': schedule.scheduleId,
            'User ID': userId,
            'Abandoned Session ID': pendingResumeSessionId,
          },
        })
          .catch(err => console.error('Failed to file auto-pause issue for unresumable abandoned session:', err))
          .then(() => sendAgentModeOncallAlert({
            subject: `Scheduled Chat auto-paused: ${schedule.scheduleName}`,
            message: `Abandoned session ${pendingResumeSessionId} was marked resumable by the reconciler but was no longer safely resumable at dispatch time. Paused the schedule rather than auto-restart (which would risk duplicate side effects). Needs manual review.`,
            sessionId: pendingResumeSessionId,
            context: {
              'Schedule ID': schedule.scheduleId,
              'Schedule Name': schedule.scheduleName,
              'User ID': userId,
              'Abandoned Session ID': pendingResumeSessionId,
            },
          }))
          .catch(err => console.error('Failed to send oncall alert for auto-paused schedule:', err));
        return deferredResumeResult('not-resumable-paused');
      }

      // Attach the resumed session to the lease BEFORE claiming the marker, not after.
      // Closes a race Greptile flagged: a kill landing between claimPendingResume
      // succeeding and the (formerly later) attach call left the lease's sessionId
      // empty, so the reconciler saw an empty-session abandonment and requeued a
      // fresh restart — re-running this session's already-completed side effects.
      // Attaching first means the lease already names the right session no matter
      // when a kill lands after this point — PROVIDED the attach itself lands. If it
      // doesn't (Greptile, round 2), the marker is still intact (not yet claimed), so
      // defer rather than proceed on an unconfirmed lease — a later fire retries.
      if (leaseAcquired) {
        let attached = false;
        try {
          attached = await scheduleDb.attachSessionToRunInFlight(schedule.scheduleId, leaseRunId, pendingResumeSessionId);
        } catch (attachError) {
          console.error(`Failed to attach resume session to in-flight lease for schedule ${schedule.scheduleId}:`, attachError);
        }
        if (!attached) {
          console.warn(`runScheduledChat: could not attach resume session ${pendingResumeSessionId} to lease for schedule ${schedule.scheduleId}; deferring (marker left intact for a later retry).`);
          await scheduleRetrySoon();
          return deferredResumeResult('attach-error');
        }
      }

      // Atomically CLAIM: exactly one dispatcher wins and resumes this session; any
      // concurrent dispatcher loses and bows out (never a parallel resume or a restart).
      let won = false;
      try {
        won = await scheduleDb.claimPendingResume(schedule.scheduleId, pendingResumeSessionId);
      } catch (claimError) {
        console.error(`runScheduledChat: resume claim error for session ${pendingResumeSessionId}; deferring:`, claimError);
        await scheduleRetrySoon();
        return deferredResumeResult('claim-error');
      }
      if (!won) {
        console.warn(`runScheduledChat: lost the resume claim for session ${pendingResumeSessionId} on schedule ${schedule.scheduleId} (another dispatcher is resuming it); deferring — no fresh restart.`);
        // No retry-soon here: the winner is actively resuming this same schedule's
        // session right now — a fast re-fire would just lose the claim again.
        return deferredResumeResult('lost-claim');
      }

      // Won the claim on a validated, resumable session — continue it.
      // NOTE: the reconciler does not append a jobIncomplete placeholder on the
      // resumable path, and buildMarketingContext() drops any assistant message flagged
      // metadata.isErrorMessage (covers both jobIncomplete and isRunFailureNotice), so
      // no run-failure placeholder reaches the model on resume even though the worker
      // reloads the full transcript from the DB.
      isResumeRun = true;
      sessionId = pendingResumeSessionId;
      // ENG-971: a RESUMED session carries the abandoned run's calledFunctions. Without
      // this baseline, that run's publish would be read as THIS run's work — and since
      // a confirmed publish suppresses the zero-output requeue, an unrelated failure
      // here would silently end the schedule's auto-recovery. Resume is exactly the
      // path for runs that did real work first, so this is the common case.
      runStartCalledFunctions = resumeSession.calledFunctions || {};
      // Credit the abandoned portion's tool calls to this run's verification,
      // preferring the executed ledger so a failed prior call keeps its error (ENG-844).
      resumePriorToolCalls = reconstructPriorToolCalls(resumeSession.messages || []);
      console.log(`runScheduledChat: RESUMING abandoned session ${sessionId} for schedule ${schedule.scheduleId} (${schedule.scheduleName}); ${resumePriorToolCalls.length} prior tool call(s) carried into verification`);
    }

    // Create a session for the run (skipped when resuming an existing one).
    if (!isResumeRun) {
      const testSession = await chatbotDb.createChatSession(
        userId,
        undefined,
        "agent",
        pageIdentifier,
        undefined,
        undefined,
        undefined,
        schedule.emailCampaignTaskId,
        'scheduled' // sessionType
      );
      sessionId = testSession.sessionId;
    }

    // Attach the freshly-created session to the lease so the reconciler's recovery
    // annotates the correct session if this run is later abandoned. Best-effort:
    // this is a nicety, not correctness — the reconciler still requeues an abandoned
    // run with an empty sessionId — so a failure here must never abort a healthy run.
    if (leaseAcquired && sessionId) {
      try {
        await scheduleDb.attachSessionToRunInFlight(schedule.scheduleId, leaseRunId, sessionId);
      } catch (attachError) {
        console.error(`Failed to attach session to in-flight lease for schedule ${schedule.scheduleId}:`, attachError);
      }
    }

    // Set the session title to the schedule name
    await chatbotDb.updateSessionTitle(sessionId, sessionTitle);

    // Update the session with the selected model from the schedule.
    // ENG-892: schedule.llmModel is written straight from an admin request body
    // with no allow-list check, and this is an internal db call, so it bypasses
    // the validation on the picker endpoints. Stamping it raw recorded a model
    // that never ran whenever generation fell back — on exactly the scheduled
    // sessions the daily reports analyse. Resolve first so the stored value is
    // what generation will resolve to.
    const defaultModel = await agentModeService.getScheduledChatsDefaultModel();
    const requestedModel = schedule.llmModel || defaultModel;
    const scheduleModelResolution = agentModeService.resolveGenerationModel(requestedModel);
    const modelToUse = scheduleModelResolution.model;
    if (scheduleModelResolution.fellBack) {
      // Fail loud, not partial. The run still completes on the fallback, but the
      // admin's pin is dead and the UI keeps showing the model they chose — the
      // ENG-806 failure mode, where an alias-valued setting sat inert for two
      // months. resolveConfiguredModel alerts for AW-Settings; schedules only
      // console.warn'd. Fire-and-forget so the run never blocks on it.
      void sendAgentModeOncallAlert({
        subject: 'AgentMode: unsupported model pinned on a scheduled chat',
        message:
          `Schedule "${schedule.scheduleName}" (${schedule.scheduleId}) pins model "${requestedModel}", which is ` +
          `not a served model even after legacy-alias resolution. The run fell back to "${modelToUse}", so the ` +
          `pin is inert and every run of this schedule is using a model nobody chose.`,
        context: {
          Schedule: schedule.scheduleId,
          'Pinned Model': requestedModel,
          'Actually Used': modelToUse,
        },
        // One alert per (schedule, bad value) per hour: a daily schedule with a
        // permanently bad pin must not flood oncall.
        dedupeKey: `schedule_model_invalid:${schedule.scheduleId}:${requestedModel}`,
        dedupeWindowMs: 60 * 60 * 1000,
      }).catch((alertError) => {
        console.error('AgentMode: Failed to send unsupported schedule-model alert:', alertError);
      });
    }
    await chatbotDb.updateSessionLlmModel(sessionId, modelToUse);

    // Convert schedule format to runVerifiedChat format
    const expectedKeywords = schedule.keywords || [];
    const functionCallMinCalls = schedule.functionCallMinCalls || {};

    const requiredFunctions = expectedFunctionCalls.map((funcName: string) => ({
      functionName: funcName,
      minCount: functionCallMinCalls[funcName] || 1
    }));

    // On a resume, the original task prompt is already the first message of the
    // session being continued; re-sending it would make the model start over. Send
    // a continuation directive instead so it picks up from the last completed step.
    const resolvedStartingMessage = isResumeRun
      ? SCHEDULED_RUN_RESUME_MESSAGE
      : applyScheduledChatVariableValues(
          schedule.startingMessage,
          schedule.variableValues || {},
          scheduleVariables
        );

    // Extract file attachments from file-type variables
    const fileAttachments = extractFileAttachmentsFromVariables(
      scheduleVariables,
      schedule.variableValues || {}
    ).map(f => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      mimetype: f.mimetype,
    }));

    // Run verified chat
    const result = await runVerifiedChat({
      sessionId,
      userId,
      startingMessage: resolvedStartingMessage,
      keywords: expectedKeywords,
      requiredFunctions,
      maxAttempts: 20,
      attachments: fileAttachments,
      llmModel: schedule.llmModel || defaultModel,
      // ENG-657: on a resume, count the abandoned portion's tool calls in
      // verification so requiredFunctionCalls isn't falsely missed (empty otherwise).
      priorToolCalls: resumePriorToolCalls,
      // Deterministic backstop for multi-entity scheduled runs (PR #1941 follow-up):
      // if the run admits it left work unfinished, auto-continue before finishing.
      completionGate: true,
      // ENG-396: opt-in per-schedule full autonomy — auto-take Emma's recommended
      // option on a blocking question instead of parking (waives the human gate on
      // irreversible decisions; default off).
      fullAutonomy: schedule.fullAutonomy === true,
      // ENG-803: re-read at the moment the marker is evaluated, so the continuation
      // classifier uses the SAME live decision as the prompt builder and the dispatch
      // guard. A snapshot taken here would go stale the moment the owner toggles the
      // setting mid-run (Greptile review #30).
      publishAuthorized: () => resolveLivePublishAuthorized(schedule.scheduleId),
      // ENG-636: a scheduled park IS notifiable — the block below emails the owner
      // and records a `pending_user_input` outcome, so a park reaches a human.
      parkNotifiable: true,
      // ENG-844: forward the injectable clock so the conditional-skip run-date
      // cross-check is deterministic under test (undefined in production).
      now: nowOverride,
      // ENG-844: the owner's weekday cadence is evaluated in the schedule's
      // timezone (falls back to UTC when unset).
      scheduleTimezone: schedule.timezone
    });

    // ENG-396: the run parked on a blocking AskUserQuestion with no human present.
    // It did NOT proceed on a guess. Record a `pending_user_input` outcome and
    // notify the owner so they can make the choice; this is NOT a failure, so we
    // early-return BEFORE the oncall/auto-issue path. `sessionId: ''` reuses the
    // established convention (see error/token paths) so the orchestrator/callers
    // skip their normal result email — the paused email below carries the link.
    if (result.parked && result.pendingUserQuestion) {
      const scheduleUser = await userDb.getUserById(userId);
      const notifyEmails = (schedule.emailNotifications && schedule.emailNotifications.length > 0)
        ? schedule.emailNotifications
        : (scheduleUser?.email ? [scheduleUser.email] : []);
      if (notifyEmails.length > 0) {
        await emailService.sendScheduledChatPausedForInputEmail(
          notifyEmails,
          schedule.scheduleName,
          schedule.scheduleId,
          result.pendingUserQuestion.question,
          sessionId
        );
      } else {
        // Parked but no recipient (no emailNotifications and no account email) — the
        // owner won't be notified. Surface it loudly rather than parking silently.
        console.warn(
          `AgentMode runScheduledChat: schedule ${schedule.scheduleId} parked on a user question but has NO notification recipient — owner will not be told. Session ${sessionId}, question ${result.pendingUserQuestion.questionId}`
        );
      }

      const parkedResult = {
        scheduleId: schedule.scheduleId,
        runId: preGeneratedRunId || require('uuid').v4(),
        status: 'pending_user_input' as const,
        passed: false,
        actualResponse: result.content,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: [],
        functionCallMatches: [],
        functionCallMisses: [],
        functionCallDetails: {},
        executionTime: Date.now() - now.getTime(),
        // Empty on purpose — suppresses the callers' result email (the paused
        // email already notified). The pending question id links back for the UI.
        sessionId: '',
        pendingQuestionId: result.pendingUserQuestion.questionId,
        attempt: result.attempts,
        createdAt: new Date().toISOString(),
      };
      try {
        await scheduleDb.addRunResult(schedule.scheduleId, parkedResult);
      } catch (error) {
        console.error('Error saving parked run result:', error);
      }
      return parkedResult;
    }

    if (!isTest && process.env.NODE_ENV !== 'test') {
      const hasAssistantMessage = await sessionHasAssistantMessage(sessionId);
      if (hasAssistantMessage === false) {
        throw new ZeroAssistantOutputError(
          `Scheduled chat produced zero persisted assistant messages for session ${sessionId}`
        );
      }
    }

    // Generate a 2-3 word summary and update the session title
    try {
      // ENG-803: ground the title suffix in the tools that actually ran, so a run
      // that posted nothing cannot be titled "Replies queued".
      //
      // SUCCEEDED, not merely ATTEMPTED (Greptile review #19). The ledger keeps
      // failed and preflight-rejected calls too, so passing every name through would
      // hand the summarizer a `twitter_manage_post` entry for a call that errored —
      // and it would faithfully title the run "Replies Posted". That is precisely
      // ENG-803's false-success title, re-created by the fix meant to prevent it.
      //
      // A call counts only when it has no top-level `error` (the repo-wide failure
      // marker — see countFailedToolCalls) and its result did not report
      // success:false, which is how preflight rejections come back while still
      // looking like a completed call.
      const succeededToolNames = (result.toolCalls || [])
        .filter(toolCallSucceeded)
        .map((call: any) => call?.name)
        .filter(Boolean);
      const summary = await agentModeService.generateScheduledChatSummary(resolvedStartingMessage, result.content, succeededToolNames);
      if (summary) {
        generatedSummary = summary;
        const summaryTitle = `${sessionTitle} — ${summary}`;
        await chatbotDb.updateSessionTitle(sessionId, summaryTitle);
      }
    } catch (err) {
      console.error('AgentMode: Failed to update session title with summary:', err);
    }

    // Convert result to scheduled chat format
    const actualFunctionCalls = result.toolCalls.map((call: any) => call.name).filter(Boolean);

    // Calculate final function call details
    const finalFunctionCallDetails: { [functionName: string]: { actual: number; required: number } } = {};
    const actualFunctionCallCounts: { [functionName: string]: number } = {};
    actualFunctionCalls.forEach((call: string) => {
      actualFunctionCallCounts[call] = (actualFunctionCallCounts[call] || 0) + 1;
    });

    expectedFunctionCalls.forEach((funcCall: string) => {
      const actualCount = actualFunctionCallCounts[funcCall] || 0;
      const requiredCount = functionCallMinCalls[funcCall] || 1;
      finalFunctionCallDetails[funcCall] = {
        actual: actualCount,
        required: requiredCount
      };
    });

    // ENG-635: a run that met its requirements but still deferred to an absent human
    // (deferredUnresolved) produced no real deliverable — record it as a failure so it
    // is surfaced (auto-issue + oncall) instead of scored as a clean run.
    const runDelivered = result.success && !result.deferredUnresolved;

    const finalResult = {
      scheduleId: schedule.scheduleId,
      runId: preGeneratedRunId || require('uuid').v4(),
      status: (runDelivered ? 'success' : 'failure') as 'success' | 'failure',
      passed: runDelivered,
      actualResponse: result.content,
      actualFunctionCalls: actualFunctionCalls,
      keywordMatches: result.keywordMatches,
      keywordMisses: result.keywordMisses,
      functionCallMatches: result.functionCallMatches,
      functionCallMisses: result.functionCallMisses,
      functionCallDetails: finalFunctionCallDetails,
      executionTime: Date.now() - now.getTime(),
      sessionId: sessionId,
      attempt: result.attempts,
      createdAt: new Date().toISOString(),
      summary: generatedSummary,
      // ENG-844: a legitimate conditional-cadence skip (e.g. a Mon/Wed/Fri
      // schedule running on a non-publishing day) is a SUCCESSFUL run that
      // produced zero write calls BY DESIGN. Persist a distinguishing marker so
      // a skip is not indistinguishable from a real publish in runResults /
      // downstream reporting — a bare success would otherwise hide the waived
      // write-call minimums.
      ...(result.conditionalSkip ? { conditionalSkip: true } : {}),
    };

    // Save the result to database (without actualResponse to save space)
    const resultToStore = { ...finalResult };
    delete (resultToStore as any).actualResponse;
    try {
      await scheduleDb.addRunResult(schedule.scheduleId, resultToStore);
    } catch (error) {
      console.error('Error saving run result:', error);
      // Continue even if saving fails - we still want to return the result
    }

    // Self-improve: when enabled, run a reflection turn in the same session that may
    // rewrite the schedule's prompt so future runs do better. Runs on test runs too so
    // it's easy to try out. Best-effort — never fails the run.
    if (schedule.selfImprove === true) {
      try {
        await runScheduleSelfImprovement({
          schedule,
          sessionId,
          userId,
          llmModel: modelToUse,
        });
      } catch (err) {
        console.error('AgentMode: Self-improve reflection failed:', err);
      }
    }

    // Send oncall alert and Notion ticket if scheduled chat failed validation (not for test runs).
    // Single-writer (ENG-240): file the tracked issue FIRST, THEN alert. The oncall path also files an
    // issue, but by then it dedups onto this one via the shared Schedule/Session idempotency key — so
    // the event yields exactly ONE issue, with the oncall alert landing as an occurrence comment
    // instead of a second, near-identical twin.
    if (!finalResult.passed && !isTest) {
      void fileAutoIssue({
        title: `Scheduled Chat Failed: ${schedule.scheduleName}`,
        description: `Scheduled chat "${schedule.scheduleName}" completed but failed validation.\n\nMissing function calls: ${finalResult.functionCallMisses.join(', ') || 'none'}\nKeyword misses: ${finalResult.keywordMisses.join(', ') || 'none'}`,
        source: 'Scheduled chat (validation)',
        extraLabels: ['Scheduled Chat'],
        notionTags: ['Scheduled Chat'],
        notionContext: {
          'Schedule ID': schedule.scheduleId,
          'User ID': userId,
          'Session ID': sessionId,
          'Attempts': finalResult.attempt,
        }
      })
        .catch(err => console.error('Failed to file scheduled-chat-failure issue:', err))
        .then(() => sendAgentModeOncallAlert({
          subject: `Scheduled Chat Failed: ${schedule.scheduleName}`,
          message: `Scheduled chat "${schedule.scheduleName}" completed but failed validation.\n\nMissing function calls: ${finalResult.functionCallMisses.join(', ') || 'none'}\nKeyword misses: ${finalResult.keywordMisses.join(', ') || 'none'}`,
          sessionId,
          // One alert per (user, schedule, errorClass) per hour — a flapping
          // schedule cannot flood oncall (ENG-145/146 class). Gated so flag
          // off = today's exact behavior.
          ...(isRunStoreEnabled()
            ? { dedupeKey: `scheduled_chat:${userId}:${schedule.scheduleId}:validation_failed`, dedupeWindowMs: 60 * 60 * 1000 }
            : {}),
          context: {
            'Schedule ID': schedule.scheduleId,
            'Schedule Name': schedule.scheduleName,
            'User ID': userId,
            'Attempts': finalResult.attempt,
            'Execution Time (ms)': finalResult.executionTime,
            'Function Call Misses': finalResult.functionCallMisses.join(', ') || 'none',
            'Function Call Matches': finalResult.functionCallMatches.join(', ') || 'none',
            'Keyword Misses': finalResult.keywordMisses.join(', ') || 'none',
            'Timestamp': finalResult.createdAt
          }
        }))
        .catch(err => console.error('Failed to send oncall alert for scheduled chat failure:', err));
    }

    // Also sync Research Reports execution for email campaigns
    try {
      if (schedule.emailCampaignTaskId && finalResult.sessionId) {
        await syncEmailCampaignExecution(userId, finalResult.sessionId, schedule.emailCampaignTaskId);
      }
    } catch (err) {
      console.error('AgentMode: Email campaign execution sync after run error:', err);
    }

    if (!isTest && getZeroAssistantRetryCount(schedule) > 0) {
      try {
        await scheduleDb.updateSchedule(schedule.scheduleId, {
          zeroAssistantRetryCount: 0,
          lastZeroAssistantOutputAt: '',
          lastZeroAssistantOutputSessionId: '',
          updatedAt: new Date().toISOString(),
        });
      } catch (resetError) {
        console.error(`Failed to reset zero-output retry tracking for schedule ${schedule.scheduleId}:`, resetError);
      }
    }

    return finalResult;

  } catch (error) {
    console.error(`Error in runScheduledChat for ${schedule.scheduleName}:`, error);
    console.error('Full error details:', {
      message: error instanceof Error ? error.message : String(error),
      originalMessage: (error as any)?.originalMessage || null,
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Unknown'
    });

    // Save error to session record if session was created
    if (sessionId) {
      // Persist partial token usage from messages accumulated before the error
      if ((error as any)?.partialUsageMessages?.length) {
        try {
          await chatbotDb.addMessagesToSession(sessionId, (error as any).partialUsageMessages);
          console.log(`Scheduled chat: Persisted partial usage from ${(error as any).partialUsageMessages.length} messages for failed session ${sessionId}`);
        } catch (usageErr) {
          console.error('Failed to persist partial usage for scheduled chat:', usageErr);
        }
      }

      try {
        await chatbotDb.updateSessionError(
          sessionId,
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined
        );
      } catch (saveError) {
        console.error('Failed to save error to session:', saveError);
      }
    }

    let zeroAssistantOutput = isZeroAssistantOutputError(error);
    if (!zeroAssistantOutput && sessionId) {
      const hasAssistantMessage = await sessionHasAssistantMessage(sessionId);
      zeroAssistantOutput = hasAssistantMessage === false;
    }

    let zeroAssistantRequeuedAt: string | undefined;
    if (zeroAssistantOutput) {
      // ENG-971: zero assistant output does NOT mean the run did nothing. A publish
      // can land and the process die before the summary — exactly the shape of the
      // session this issue came from, minus the closing turn. Requeuing that run
      // REPUBLISHES it, and unlike the interactive error paths there is no human
      // between the failure and the retry, so correcting the transcript alone would
      // arrive far too late. Read the ledger first; it decides both the message and
      // whether the requeue happens at all. A read failure yields no actions and
      // every existing behaviour is preserved.
      const publishLedgerForRun = sessionId
        ? await loadPublishLedger(sessionId, runStartCalledFunctions)
        : [];
      // A read failure is UNKNOWN, not "nothing happened" (Greptile P1). Restarting
      // the task from scratch on an unknown can repeat a production publish, so an
      // unknown is handled exactly like a confirmed one: never restart, prefer resume.
      const publishLedgerUnknown = publishLedgerForRun === null;
      const publishedActions = publishLedgerForRun
        ? collectConfirmedPublishActions(publishLedgerForRun)
        : [];
      const mayHavePublished = publishedActions.length > 0 || publishLedgerUnknown;

      // Work landed this run, so there are three options and only one is good.
      // A blind requeue restarts from scratch and REPUBLISHES it. Simply not
      // retrying avoids that, but can leave a multi-step run (publish 1 of 5, then
      // die) permanently part-done with nothing surfaced — a quieter, harder-to-
      // diagnose failure than the duplicate it prevents. So prefer RESUME:
      // planScheduledRunResume says yes only when the transcript ends on a settled,
      // balanced boundary, which by construction never re-drives a tool that already
      // ran. The rest of the task finishes; the publish is not repeated.
      const zeroOutputNextRetryCount = getZeroAssistantRetryCount(schedule) + 1;
      let willResumePublishedRun = false;
      if (
        mayHavePublished
        && !isTest
        && sessionId
        && zeroOutputNextRetryCount <= ZERO_ASSISTANT_MAX_REQUEUES
      ) {
        try {
          const priorMessages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
          willResumePublishedRun = planScheduledRunResume(priorMessages as any).resumable;
        } catch (planError) {
          console.error(
            `Zero-output resume-plan check failed for session ${sessionId}; will not retry:`,
            planError
          );
        }
      }

      // Never leave the session silent (ENG-209). Persist a structured
      // "job incomplete" assistant message so the user sees graceful feedback
      // instead of an empty session. Done BEFORE requeue so the failed session
      // is self-explanatory; the requeue (below) runs in a fresh session.
      if (sessionId) {
        // ENG-826: pick the message that matches the ACTUAL failure. A deterministic
        // provider/validation error (e.g. the gemini-3.5-flash union-schema 400) must
        // not be reported as a time/memory-budget overrun with "split into smaller
        // batches" advice that can't help — that mislabels the transcript for anyone
        // debugging it. Budget-shaped failures keep the original guidance.
        const failureClass = classifyZeroAssistantFailure(error);
        // ENG-971: the published-run message is written AFTER the requeue decision
        // (below), because its two variants make opposite promises and only the
        // outcome knows which is true — the resume wording would be a lie if the
        // requeue write then failed. This is the very failure class this issue is
        // about, so the message must never run ahead of the fact.
        const incompleteMessage = mayHavePublished
          ? null
          : zeroAssistantIncompleteMessage(error);
        if (incompleteMessage) try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'assistant',
            content: incompleteMessage,
            timestamp: new Date().toISOString(),
            metadata: {
              timestamp: new Date().toISOString(),
              isErrorMessage: true,
              jobIncomplete: true,
              failureClass,
            },
          });
        } catch (persistError) {
          console.error('Failed to persist job-incomplete message to session:', persistError);
        }
      }

      console.error('Scheduled chat zero-assistant-output dead-man triggered:', {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.scheduleName,
        userId,
        sessionId: sessionId || 'N/A',
        isTest,
        retryCount: getZeroAssistantRetryCount(schedule),
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });

      let publishedRunDidResume = false;
      let publishedRunPaused = false;
      if (mayHavePublished) {
        if (willResumePublishedRun) {
          // Requeue AS A RESUME: same session, continued from its last settled step.
          // Retried, because this single write is what stands between a recoverable
          // blip and having to pause the customer's schedule below.
          const retryAt = new Date(Date.now() + getZeroAssistantRequeueDelayMs(zeroOutputNextRetryCount)).toISOString();
          for (let attempt = 1; attempt <= 3 && !publishedRunDidResume; attempt++) {
            try {
              await scheduleDb.updateSchedule(schedule.scheduleId, {
                status: 'active',
                nextRunTime: retryAt,
                zeroAssistantRetryCount: zeroOutputNextRetryCount,
                lastZeroAssistantOutputAt: new Date().toISOString(),
                lastZeroAssistantOutputSessionId: sessionId || '',
                pendingResumeSessionId: sessionId || '',
                updatedAt: new Date().toISOString(),
              });
              publishedRunDidResume = true;
              zeroAssistantRequeuedAt = retryAt;
              console.error(
                `Scheduled chat ${schedule.scheduleId} produced zero output AFTER confirmed work `
                + `(${publishedActions.join('; ')}); requeued as a RESUME so the rest completes without repeating it.`
              );
            } catch (requeueError) {
              console.error(
                `Failed to requeue-as-resume zero-output scheduled chat ${schedule.scheduleId} `
                + `(attempt ${attempt}/3):`,
                requeueError
              );
            }
          }
        } else {
          // Cannot continue safely and must not restart.
          console.error(
            `Scheduled chat ${schedule.scheduleId} produced zero output AFTER confirmed work `
            + `(${publishedActions.join('; ')}) and is not safely resumable; NOT requeuing.`
          );
        }

        // The run published and is NOT being continued — either it could not be
        // resumed, or the resume marker would not persist. Leaving the schedule
        // ACTIVE means its next ordinary fire starts a fresh session and repeats
        // work that already went out, and an owner email cannot stop a cron: only
        // persisted state can. So pause the schedule. Deliberately a last resort —
        // it stops a customer's recurring workflow — which is why the marker write
        // above is retried first, and why nothing pauses on an ordinary failure.
        if (!publishedRunDidResume && !isTest) {
          zeroAssistantRequeuedAt = undefined;
          // Retried like the marker write above: this is the last durable thing
          // standing between a published run and a repeat, so one unlucky call must
          // not decide it.
          for (let attempt = 1; attempt <= 3 && !publishedRunPaused; attempt++) {
            try {
              await scheduleDb.updateSchedule(schedule.scheduleId, {
                status: 'paused',
                lastZeroAssistantOutputAt: new Date().toISOString(),
                lastZeroAssistantOutputSessionId: sessionId || '',
                updatedAt: new Date().toISOString(),
              });
              publishedRunPaused = true;
              console.error(
                `Scheduled chat ${schedule.scheduleId} PAUSED: it published `
                + `(${publishedActions.join('; ') || 'outcome unreadable'}) and cannot be continued, `
                + `so its next fire would repeat that work.`
              );
            } catch (pauseError) {
              console.error(
                `CRITICAL: failed to pause schedule ${schedule.scheduleId} after a published, `
                + `non-resumable run (attempt ${attempt}/3) — its next fire may repeat completed work:`,
                pauseError
              );
            }
          }
        }

        // Keyed on what ACTUALLY happened, not on which branch we took (Greptile P1).
        // A resume marker that failed to persist leaves the schedule active with no
        // marker, so its next ordinary fire starts a FRESH session and can repeat the
        // publish. That path used to only log. Whenever the run did not actually
        // resume — unresumable transcript OR failed marker write — the work may
        // already have gone out and nothing will continue it, so the owner is told.
        if (!publishedRunDidResume && !isTest) {
          await notifyScheduleOwnerOfFailure(schedule, userId, {
            failedAttempts: zeroOutputNextRetryCount,
            failureClass: classifyZeroAssistantFailure(error),
          });
        }
        // Outcome settled — now the transcript can state it truthfully.
        if (sessionId) {
          try {
            await chatbotDb.addMessageToSession(sessionId, {
              role: 'assistant',
              content: zeroAssistantPublishedMessage(publishedActions, publishedRunDidResume, publishedRunPaused),
              timestamp: new Date().toISOString(),
              metadata: {
                timestamp: new Date().toISOString(),
                isErrorMessage: true,
                jobIncomplete: true,
                failureClass: classifyZeroAssistantFailure(error),
              },
            });
          } catch (persistError) {
            console.error('Failed to persist published-run job-incomplete message:', persistError);
          }
        }
      } else if (!isTest) {
        const nextRetryCount = zeroOutputNextRetryCount;
        if (nextRetryCount <= ZERO_ASSISTANT_MAX_REQUEUES) {
          const retryAt = new Date(Date.now() + getZeroAssistantRequeueDelayMs(nextRetryCount)).toISOString();
          zeroAssistantRequeuedAt = retryAt;

          try {
            await scheduleDb.updateSchedule(schedule.scheduleId, {
              status: 'active',
              nextRunTime: retryAt,
              zeroAssistantRetryCount: nextRetryCount,
              lastZeroAssistantOutputAt: new Date().toISOString(),
              lastZeroAssistantOutputSessionId: sessionId || '',
              updatedAt: new Date().toISOString(),
            });
          } catch (requeueError) {
            console.error(`Failed to requeue zero-output scheduled chat ${schedule.scheduleId}:`, requeueError);
          }
        } else {
          console.error(
            `Scheduled chat ${schedule.scheduleId} exceeded zero-output requeue limit (${ZERO_ASSISTANT_MAX_REQUEUES}); notifying owner.`
          );
          // ENG-826 (#1): the automatic retries are exhausted — the schedule is
          // consistently failing and won't auto-retry until its next slot. Proactively
          // notify the owner instead of only logging (the old behaviour left the owner
          // unaware). Recipients: the schedule's configured notification list, else the
          // owner's account email. Best-effort — a notification failure must never break
          // the run.
          //
          // The alert fires on each exhausted failing run. Past the requeue cap the
          // schedule is NOT requeued, so this is at most once per natural slot while it
          // stays broken — standard "notify while failing" behavior. We deliberately do
          // NOT persist a separate "already alerted" flag for dedup: that write can't be
          // atomic with the email send, so any such flag inevitably diverges from actual
          // delivery (a duplicate alert if the write fails after a send, or a missed alert
          // if the ordering is inverted). No dedup state means no divergence to get wrong.
          await notifyScheduleOwnerOfFailure(schedule, userId, {
            failedAttempts: nextRetryCount,
            failureClass: classifyZeroAssistantFailure(error),
          });
        }
      }
    }

    // Build error result
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorResult = {
      scheduleId: schedule.scheduleId,
      runId: preGeneratedRunId || require('uuid').v4(),
      status: 'failure' as const,
      passed: false,
      actualResponse: `Error during execution: ${errorMessage}`,
      actualFunctionCalls: [],
      keywordMatches: [],
      keywordMisses: schedule.keywords || [],
      functionCallMatches: [],
      functionCallMisses: schedule.requiredFunctionCalls || [],
      executionTime: Date.now() - now.getTime(),
      sessionId: sessionId || '',
      attempt: 0,
      createdAt: new Date().toISOString(),
      ...(zeroAssistantOutput ? {
        zeroAssistantOutput: true,
        ...(zeroAssistantRequeuedAt ? { requeuedAt: zeroAssistantRequeuedAt } : {}),
      } : {}),
    };

    // Save the error result to database (without actualResponse to save space)
    const resultToStore = { ...errorResult };
    delete (resultToStore as any).actualResponse;
    try {
      await scheduleDb.addRunResult(schedule.scheduleId, resultToStore);
    } catch (saveError) {
      console.error('Error saving error run result:', saveError);
      // Continue even if saving fails - we still want to return the result
    }

    // Send oncall alert and Notion ticket for scheduled chat exception (always, including test runs).
    // Single-writer (ENG-240): file the tracked issue FIRST, THEN alert, so the oncall path's own
    // filing dedups onto this issue via the shared Schedule/Session idempotency key. A zero-output run
    // used to trip BOTH filers and land two identical Linear issues <1s apart; now it lands one issue
    // plus an occurrence comment.
    const originalMessage = (error as any)?.originalMessage;
    void fileAutoIssue({
      title: zeroAssistantOutput
        ? `Scheduled Chat Zero Assistant Output: ${schedule.scheduleName}`
        : `Scheduled Chat Error: ${schedule.scheduleName}`,
      description: zeroAssistantOutput
        ? `Scheduled chat "${schedule.scheduleName}" terminated with zero assistant messages.${zeroAssistantRequeuedAt ? ` It was requeued for ${zeroAssistantRequeuedAt}.` : ''}\n\nError: ${errorMessage}${originalMessage ? `\n\nOriginal API error: ${originalMessage}` : ''}`
        : `Scheduled chat "${schedule.scheduleName}" threw an exception during execution.\n\nError: ${errorMessage}${originalMessage ? `\n\nOriginal API error: ${originalMessage}` : ''}`,
      source: 'Scheduled chat (error)',
      extraLabels: ['Scheduled Chat'],
      notionTags: ['Scheduled Chat'],
      notionContext: {
        'Schedule ID': schedule.scheduleId,
        'User ID': userId,
        'Session ID': sessionId || 'N/A',
        'Is Test Run': isTest ? 'Yes' : 'No',
        'Zero Assistant Output': zeroAssistantOutput ? 'Yes' : 'No',
        ...(zeroAssistantRequeuedAt ? { 'Requeued At': zeroAssistantRequeuedAt } : {}),
        'Error Message': errorMessage,
        ...(originalMessage ? { 'Original Error (Bedrock/API)': originalMessage } : {}),
      }
    })
      .catch(err => console.error('Failed to file scheduled-chat-error issue:', err))
      .then(() => sendAgentModeOncallAlert({
        subject: zeroAssistantOutput
          ? `Scheduled Chat Zero Assistant Output: ${schedule.scheduleName}`
          : `Scheduled Chat Error: ${schedule.scheduleName}`,
        message: zeroAssistantOutput
          ? `Scheduled chat "${schedule.scheduleName}" terminated with zero assistant messages.${zeroAssistantRequeuedAt ? ` It was requeued for ${zeroAssistantRequeuedAt}.` : ''}\n\nError: ${errorMessage}`
          : `Scheduled chat "${schedule.scheduleName}" threw an exception during execution.\n\nError: ${errorMessage}`,
        // One alert per (user, schedule, errorClass) per hour (ENG-145/146
        // class). Gated so flag off = today's exact behavior.
        ...(isRunStoreEnabled()
          ? { dedupeKey: `scheduled_chat:${userId}:${schedule.scheduleId}:${zeroAssistantOutput ? 'zero_output' : 'run_error'}`, dedupeWindowMs: 60 * 60 * 1000 }
          : {}),
        sessionId: sessionId || undefined,
        context: {
          'Schedule ID': schedule.scheduleId,
          'Schedule Name': schedule.scheduleName,
          'User ID': userId,
          'Is Test Run': isTest ? 'Yes' : 'No',
          'Zero Assistant Output': zeroAssistantOutput ? 'Yes' : 'No',
          ...(zeroAssistantRequeuedAt ? { 'Requeued At': zeroAssistantRequeuedAt } : {}),
          'Error Message': errorMessage,
          ...(originalMessage ? { 'Original Error (Bedrock/API)': originalMessage } : {}),
          'Error Stack': error instanceof Error ? (error.stack || 'No stack trace') : 'N/A',
          'Execution Time (ms)': errorResult.executionTime,
          'Timestamp': errorResult.createdAt
        }
      }))
      .catch(err => console.error('Failed to send oncall alert for scheduled chat error:', err));

    // Return error result for error reporting
    return errorResult;
  } finally {
    // ENG-324: stop heartbeating and release the lease. Conditional on runId, so
    // if the reconciler already reaped this run (heartbeat went stale), the clear
    // no-ops and the requeue it wrote stands.
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (leaseAcquired) {
      try {
        await scheduleDb.clearRunInFlight(schedule.scheduleId, leaseRunId);
      } catch (clearError) {
        console.error(`Failed to clear in-flight lease for schedule ${schedule.scheduleId}:`, clearError);
      }
    }
  }
}

/**
 * ENG-324: recover a single scheduled run whose owning process died mid-flight.
 * Claims the stale lease atomically (single-winner across instances) and, if we
 * win, requeues the schedule (respecting the zero-output requeue cap), annotates
 * the orphaned session so it isn't silent, and records a failure run result.
 * Returns true only if THIS caller performed the recovery.
 */
export async function recoverAbandonedScheduledRun(schedule: any, lease: any): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const nextRetryCount = getZeroAssistantRetryCount(schedule) + 1;
  // Only reschedule schedules that are still active. A runCount-limited schedule
  // auto-pauses at dispatch, so requeuing it would resurrect a completed-quota
  // schedule; a paused run is still recovered (lease cleared, session annotated,
  // failure recorded) — just not rescheduled.
  const isActive = schedule.status === 'active';
  const overCap = nextRetryCount > ZERO_ASSISTANT_MAX_REQUEUES;
  let willRequeue = isActive && !overCap;
  let noRequeueReason = willRequeue ? '' : (!isActive ? `schedule is ${schedule.status}` : 'over requeue cap');
  let requeuedAt = willRequeue
    ? new Date(Date.now() + getZeroAssistantRequeueDelayMs(nextRetryCount)).toISOString()
    : undefined;

  // ENG-657: decide whether the requeued run should RESUME this session from its
  // last persisted step instead of restarting the task from scratch. Only when the
  // transcript ends on a safe, balanced boundary (planScheduledRunResume) — a run
  // killed mid-tool-execution is NOT resumed (never re-drive a half-applied side
  // effect). Best-effort: any read/plan failure falls back to a fresh restart.
  let resumeSessionId = '';
  // Set when this run published (or may have) and cannot be continued: suppressing
  // the requeue alone leaves the schedule ACTIVE, so its next ORDINARY fire would
  // still restart from scratch and repeat that work. Only pausing prevents it.
  let pauseAfterClaim = false;
  if (willRequeue && lease.sessionId) {
    try {
      const priorMessages = await chatbotDb.getMessagesFromMessagesTable(lease.sessionId);
      if (planScheduledRunResume(priorMessages as any).resumable) {
        resumeSessionId = lease.sessionId;
      }
    } catch (planError) {
      console.error(`recoverAbandonedScheduledRun: resume-plan check failed for session ${lease.sessionId}:`, planError);
    }
  }

  // ENG-971 (Greptile): without a resume marker this requeue RESTARTS the task from
  // scratch, re-driving its side effects. The paths that reach here without one are
  // exactly the dangerous cases — an unresumable transcript, or a plan check that
  // threw — and `claimAbandonedRun` with no resumeSessionId also REMOVES any marker
  // already stored. So restart only when the ledger can be read AND shows nothing
  // published; a confirmed publish or an unreadable ledger stops the restart and
  // tells the owner instead, matching the zero-output path in runScheduledChat.
  if (willRequeue && !resumeSessionId && lease.sessionId) {
    // Scoped to THIS attempt via lease.startedAt. calledFunctions is
    // session-cumulative and a recovered run resumes the abandoned run's session,
    // so reading the counters here would let an EARLIER attempt's publish pause a
    // schedule whose latest attempt published nothing — a live workflow stopped for
    // a run that did nothing wrong. The transcript answers precisely, using state
    // the lease already carries.
    let attemptPublished: string[] = [];
    let transcriptUnreadable = true;
    // Retried for the same reason the ledger read is: an unreadable transcript can
    // PAUSE a live schedule, so one transient failure must not be enough to decide it.
    for (let attempt = 1; attempt <= 3 && transcriptUnreadable; attempt++) {
      try {
        const priorMessages = await chatbotDb.getMessagesFromMessagesTable(lease.sessionId);
        attemptPublished = collectPublishActionsSince(priorMessages as any, lease.startedAt);
        transcriptUnreadable = false;
      } catch (readError) {
        if (attempt === 3) {
          console.error(
            `recoverAbandonedScheduledRun: transcript unreadable for ${lease.sessionId} after 3 attempts:`,
            readError
          );
        }
      }
    }
    const mayHavePublished = transcriptUnreadable || attemptPublished.length > 0;
    if (mayHavePublished) {
      willRequeue = false;
      requeuedAt = undefined;
      noRequeueReason = transcriptUnreadable
        ? 'transcript unreadable — a fresh restart could repeat completed work'
        : `this attempt already ${attemptPublished.join('; ')} — a fresh restart would repeat it`;
      console.error(
        `recoverAbandonedScheduledRun: NOT restarting schedule ${schedule.scheduleId} — ${noRequeueReason}.`
      );
      await notifyScheduleOwnerOfFailure(schedule, schedule.userId, {
        failedAttempts: nextRetryCount,
        failureClass: 'system',
      });
      pauseAfterClaim = true;
    }
  }

  // Atomic single-winner claim. If another instance already reaped this lease the
  // conditional write fails and we return false without touching the session.
  const won = await scheduleDb.claimAbandonedRun(
    schedule.scheduleId,
    lease.runId,
    willRequeue
      ? { nextRunTime: requeuedAt!, retryCount: nextRetryCount, sessionId: lease.sessionId || '', lastAt: nowIso, ...(resumeSessionId ? { resumeSessionId } : {}) }
      : null
  );
  if (!won) return false;

  // Paused only after winning the claim — a lost claim means another instance owns
  // this recovery and must not have the schedule changed underneath it.
  if (pauseAfterClaim) {
    let paused = false;
    for (let attempt = 1; attempt <= 3 && !paused; attempt++) {
      try {
        await scheduleDb.updateSchedule(schedule.scheduleId, {
          status: 'paused',
          updatedAt: new Date().toISOString(),
        });
        paused = true;
        console.error(
          `recoverAbandonedScheduledRun: PAUSED schedule ${schedule.scheduleId} — ${noRequeueReason}.`
        );
      } catch (pauseError) {
        console.error(
          `CRITICAL: failed to pause schedule ${schedule.scheduleId} after an abandoned run that `
          + `may already have published (attempt ${attempt}/3) — its next fire may repeat completed work:`,
          pauseError
        );
      }
    }
  }

  // We own the recovery. Make the orphaned session self-explanatory (best-effort).
  // When the run will RESUME, do NOT append the "job incomplete" placeholder — the
  // session is being continued, not given up on, and the placeholder would read to
  // the model as an assistant turn that already quit. Record a non-terminal note so
  // the state is still visible.
  if (lease.sessionId) {
    try {
      if (resumeSessionId) {
        await chatbotDb.updateSessionError(
          lease.sessionId,
          'Scheduled run interrupted mid-run (instance terminated); queued to resume from the last completed step.'
        );
      } else {
        await chatbotDb.addMessageToSession(lease.sessionId, {
          role: 'assistant',
          // ENG-764: honest cause — the process died, this was not a budget overrun.
          // The jobIncomplete/isErrorMessage markers are unchanged: sessionScoringService
          // and resumePlan both detect this placeholder by metadata, never by its text.
          content: SCHEDULED_RUN_ABANDONED_MESSAGE,
          timestamp: nowIso,
          metadata: { timestamp: nowIso, isErrorMessage: true, jobIncomplete: true },
        });
        await chatbotDb.updateSessionError(
          lease.sessionId,
          'Scheduled run abandoned: the owning process terminated mid-run (recovered by reconciler).'
        );
      }
    } catch (annotateError) {
      console.error(`recoverAbandonedScheduledRun: failed to annotate session ${lease.sessionId}:`, annotateError);
    }
  }

  // Persist a failure run result so the abandonment is visible in the UI, mirroring
  // the shape the in-process catch writes for a caught zero-output run.
  try {
    await scheduleDb.addRunResult(schedule.scheduleId, {
      scheduleId: schedule.scheduleId,
      runId: lease.runId,
      status: 'failure',
      passed: false,
      keywordMatches: [],
      keywordMisses: schedule.keywords || [],
      functionCallMatches: [],
      functionCallMisses: schedule.requiredFunctionCalls || [],
      executionTime: 0,
      sessionId: lease.sessionId || '',
      attempt: 0,
      createdAt: nowIso,
      zeroAssistantOutput: true,
      abandoned: true,
      ...(requeuedAt ? { requeuedAt } : {}),
    });
  } catch (resultError) {
    console.error(`recoverAbandonedScheduledRun: failed to persist run result for ${schedule.scheduleId}:`, resultError);
  }

  console.error('Scheduled chat abandoned-run recovered by reconciler:', {
    scheduleId: schedule.scheduleId,
    scheduleName: schedule.scheduleName,
    sessionId: lease.sessionId || 'N/A',
    deadInstanceId: lease.instanceId,
    heartbeatAt: lease.heartbeatAt,
    requeued: willRequeue,
    requeuedAt: requeuedAt || `N/A (${noRequeueReason})`,
  });

  // Surface to oncall (best-effort, never throws into the sweep).
  void sendAgentModeOncallAlert({
    subject: `Scheduled Chat Abandoned Run Recovered: ${schedule.scheduleName}`,
    message: `A scheduled run for "${schedule.scheduleName}" was abandoned when its process died mid-run and has been ${willRequeue ? `requeued for ${requeuedAt}` : `left failed (${noRequeueReason})`}.`,
    sessionId: lease.sessionId || undefined,
    context: {
      'Schedule ID': schedule.scheduleId,
      'Schedule Name': schedule.scheduleName,
      'User ID': schedule.userId,
      'Session ID': lease.sessionId || 'N/A',
      'Dead Instance': lease.instanceId || 'unknown',
      'Last Heartbeat': lease.heartbeatAt || 'unknown',
      'Requeued': willRequeue ? `Yes (${requeuedAt})` : `No (${noRequeueReason})`,
      'Retry Count': String(nextRetryCount),
    },
  }).catch(err => console.error('Failed to send oncall alert for recovered abandoned run:', err));

  return true;
}

/**
 * ENG-324: sweep active scheduled-chat schedules for in-flight leases whose
 * heartbeat has gone stale (owning process died) and recover each one. Safe to
 * run concurrently on every instance — each recovery is a single-winner claim.
 * `now` is injectable for deterministic tests.
 */
export async function reconcileStaleScheduledRuns(now: number = Date.now()): Promise<{ scanned: number; reconciled: number }> {
  let schedules: any[] = [];
  try {
    schedules = await scheduleDb.getInFlightSchedules();
  } catch (listError) {
    console.error('reconcileStaleScheduledRuns: failed to list in-flight schedules:', listError);
    return { scanned: 0, reconciled: 0 };
  }

  let reconciled = 0;
  for (const schedule of schedules) {
    const lease = schedule?.runInFlight;
    if (!lease || !lease.runId) continue;
    const heartbeatIso = lease.heartbeatAt || lease.startedAt;
    const heartbeatMs = heartbeatIso ? new Date(heartbeatIso).getTime() : NaN;
    // A fresh heartbeat means the run is alive and working (any duration) — skip.
    if (Number.isFinite(heartbeatMs) && now - heartbeatMs <= LEASE_STALE_MS) continue;
    try {
      if (await recoverAbandonedScheduledRun(schedule, lease)) reconciled++;
    } catch (recoverError) {
      console.error(`reconcileStaleScheduledRuns: failed to recover schedule ${schedule.scheduleId}:`, recoverError);
    }
  }

  if (reconciled > 0) {
    console.log(`reconcileStaleScheduledRuns: recovered ${reconciled} abandoned scheduled run(s) of ${schedules.length} in-flight.`);
  }
  return { scanned: schedules.length, reconciled };
}

// Run one reflection turn (a real Emma turn in the same session, with full tool access)
// after a scheduled chat completes. Emma reviews how the run went, and using anything it
// can access, decides whether the schedule's prompt could be improved for future runs.
// This is just another message to Emma — if it decides to improve the prompt, it calls
// the same manage_scheduled_chat tool a user would, which records a revision automatically.
export async function runScheduleSelfImprovement(params: {
  schedule: any;
  sessionId: string;
  userId: string;
  llmModel: string;
}): Promise<void> {
  const { schedule, sessionId, userId, llmModel } = params;

  const reflectionPrompt = [
    'This was an automated scheduled run. Now reflect on it to help FUTURE runs of this same schedule do better.',
    '',
    'Review how this run went. You may use any tools or data you can access (the results of this run, past runs, the account\'s current state, etc.) to find concrete, actionable opportunities to improve.',
    '',
    `Then decide whether this schedule's instruction prompt (its starting_message) should be improved so future runs produce better results. If — and only if — you find a clear improvement, update it now by calling the manage_scheduled_chat tool with action "update" and schedule_id "${schedule.scheduleId}", passing the full improved starting_message.`,
    '',
    'Rules for any improved prompt: keep the same overall goal and any {{variables}} exactly as they are; only refine the wording/instructions to make future runs more reliable. Do not invent new variables. If the current prompt is already good, make no change and simply explain why.',
  ].join('\n');

  await generateSessionResponse(sessionId, reflectionPrompt, userId, llmModel);
}

// Helper function to set up SSE connection
function setupSSEConnectionForSession(sessionId: string, res: Response, req: Request) {
  try {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection message
    res.write(': connected\n\n');

    // Send latest progress if available
    const latestProgress = getLatestProgress(sessionId);
    if (latestProgress) {
      res.write(`data: ${JSON.stringify(latestProgress)}\n\n`);
    }

    // Register callback for progress updates
    const cleanup = registerProgressCallback(sessionId, (progress) => {
      try {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        // Flush the response to ensure it's sent immediately
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch (error) {
        console.error('Error writing SSE data:', error);
        cleanup();
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      cleanup();
      res.end();
    });

    // Keep connection alive with periodic ping
    const pingInterval = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (error) {
        clearInterval(pingInterval);
        cleanup();
        res.end();
      }
    }, 30000); // Every 30 seconds

    // Clean up on error
    req.on('error', (error) => {
      // console.error(`[SSE] Request error for session ${sessionId}:`, error);
      clearInterval(pingInterval);
      cleanup();
      res.end();
    });
  } catch (error) {
    console.error(`[SSE] Error setting up connection for session ${sessionId}:`, error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish progress stream' });
    }
  }
}

function hasActiveProgress(sessionId: string): boolean {
  const latestProgress = getLatestProgress(sessionId);
  if (!latestProgress) return false;
  // 'suggestions' is emitted after 'complete' (post-processing) — treat as done
  return latestProgress.status !== 'complete' && latestProgress.status !== 'suggestions';
}

function markProgressComplete(sessionId: string): void {
  emitProgress(sessionId, { iteration: 0, status: 'complete' });
  progressStore.delete(sessionId);
}

// Helper to update a GTM work item's status in the GTM plan
async function updateGtmWorkItemStatus(
  gtmWorkItem: { planId: string; phaseId: string; workItemId: string },
  status: string
): Promise<void> {
  const dynamoClient = new DynamoDB.DocumentClient({
    region: process.env.AWS_REGION || 'us-west-2',
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    }),
  });
  const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

  const result = await dynamoClient.get({ TableName: TABLE_NAME, Key: { planId: gtmWorkItem.planId } }).promise();
  if (!result.Item) return;

  const phases = result.Item.phases || [];
  const phaseIdx = phases.findIndex((p: any) => p.id === gtmWorkItem.phaseId);
  if (phaseIdx === -1) return;

  const items = phases[phaseIdx].workItems || [];
  const itemIdx = items.findIndex((i: any) => i.id === gtmWorkItem.workItemId);
  if (itemIdx === -1) return;

  items[itemIdx] = { ...items[itemIdx], status };
  phases[phaseIdx] = { ...phases[phaseIdx], workItems: items };

  await dynamoClient.update({
    TableName: TABLE_NAME,
    Key: { planId: gtmWorkItem.planId },
    UpdateExpression: 'SET #phases = :phases, #updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#phases': 'phases', '#updatedAt': 'updatedAt' },
    ExpressionAttributeValues: { ':phases': phases, ':updatedAt': new Date().toISOString() },
  }).promise();

  console.log(`GTM work item ${gtmWorkItem.workItemId}: status updated to ${status}`);
}

// Common function to generate AI response for a session
// Always uses worker process to prevent blocking the main event loop
export async function generateSessionResponse(
  sessionId: string,
  userMessage: string,
  userId: string,
  llmModel: string,
  attachments?: any[],
  isInteractiveShare?: boolean,
  pageContext?: { currentUrl?: string; structuredContext?: string; screenshot?: string },
  isDelegatedAccess?: boolean,
  ishareSenderInfo?: { ip?: string; userAgent?: string },
  // ENG-396: a model-visible directive (from buildAnswerAcknowledgement) appended to
  // THIS turn's LLM content so Emma opens her reply by naming the chosen option.
  // Never stored on the displayed user bubble.
  answerAck?: string,
  // ENG-396: the structured selection stamped on this reply's metadata, so a card can
  // show which option was CLICKED (never inferred from the message text).
  answeredQuestionMeta?: { questionId: string; optionId: string; delegated: boolean }
): Promise<{
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
  workPlan?: any;
  skills?: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[];
  backupModelUsed?: boolean;
  originalModel?: string;
  backupModel?: string;
  // ENG-244: true when the underlying run exhausted its step budget (maxIterations)
  // and was truncated before emitting the final deliverable. The scheduled-run
  // completion gate uses this flag (not response text) to force a synthesis turn.
  truncatedByStepBudget?: boolean;
}> {
  // Clear any stale cancel from a previous request on this session
  clearCancel(sessionId);

  // Get session
  const session = await chatbotDb.getChatSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Check message limit before starting a new turn so in-progress writes (e.g. tool
  // system messages) that pushed the count over the limit don't silently drop the
  // final assistant response. The check is intentionally at turn-start so writes during
  // a turn are never blocked mid-flight.
  const currentMessageCount = (await chatbotDb.getMessagesFromMessagesTable(sessionId)).length;
  if (currentMessageCount >= MAX_MESSAGE_SIZE_PER_SESSION) {
    throw new Error(`SESSION_MESSAGE_LIMIT_EXCEEDED: This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`);
  }

  // Process attachments and include URLs in message content for LLM
  let messageContent = userMessage;
  if (attachments && attachments.length > 0) {
    const attachmentUrls = formatAttachmentUrls(attachments);
    messageContent = `${userMessage}\n\n**Attached Files:**\n${attachmentUrls}`;
  }

  // For emma-sidebar sessions, append current page URL so the LLM knows user context
  if (pageContext?.currentUrl && session.portalType === 'emma-sidebar') {
    messageContent += `\n\n[Current page: ${pageContext.currentUrl}]`;
  }

  // ENG-396: when this turn answers an AskUserQuestion, append a directive (LLM-only)
  // so Emma explicitly names the chosen option in her reply — not just the card footer.
  if (answerAck) {
    messageContent += `\n\n${answerAck}`;
  }

  // Create user message object - store processed content with attachments
  const userMessageObj = {
    role: 'user' as const,
    content: userMessage, // Store original user message, not processed content
    timestamp: new Date().toISOString(),
    metadata: {
      portalType: (session.portalType || 'agent') as 'agent',
      timestamp: new Date().toISOString(),
      attachments: attachments || [],
      ...(pageContext?.currentUrl ? { currentUrl: pageContext.currentUrl } : {}),
      ...(isInteractiveShare ? {
        ishareSender: {
          isAnonymous: true as const,
          ...(ishareSenderInfo?.ip ? { ip: ishareSenderInfo.ip } : {}),
          ...(ishareSenderInfo?.userAgent ? { userAgent: ishareSenderInfo.userAgent } : {}),
        }
      } : {}),
      // ENG-396: structured record of the card selection this reply answered (from a
      // click, not the text). The card reads this to show which option was chosen.
      ...(answeredQuestionMeta ? { askUserQuestionAnswer: answeredQuestionMeta } : {})
    }
  };

  // Check if this is the first user message (excluding system message)
  const userMessages = session.messages?.filter(msg => msg.role === 'user') || [];
  const isFirstMessage = userMessages.length === 0;

  // If this is the first message, add system message with version info first
  if (isFirstMessage) {
    try {
      let systemPrompt: string;

      if (session.portalType === 'emma-sidebar') {
        // Emma sidebar uses the Emma system prompt with page context
        systemPrompt = await getEmmaSystemContext();
        if (pageContext?.currentUrl) {
          systemPrompt += `\n\n[Page Context] The user is currently on the page: ${pageContext.currentUrl}. Help them with tasks relevant to this page.`;
        }
        if (pageContext?.structuredContext) {
          try {
            const parsed = JSON.parse(pageContext.structuredContext);
            const contextParts: string[] = [];
            if (parsed.headings?.length) contextParts.push(`Headings: ${parsed.headings.join(', ')}`);
            if (parsed.buttons?.length) contextParts.push(`Buttons: ${parsed.buttons.join(', ')}`);
            if (parsed.inputs?.length) contextParts.push(`Inputs: ${parsed.inputs.map((i: any) => i.label || i.placeholder).filter(Boolean).join(', ')}`);
            if (contextParts.length) {
              systemPrompt += `\n\n[Page UI Elements]\n${contextParts.join('\n')}`;
            }
            // Include page-specific tool context so Emma knows which tools are relevant
            if (parsed.availableTools?.length) {
              systemPrompt += `\n\n[Available Tools for This Page]\nThe following tools are most relevant to the user's current page: ${parsed.availableTools.join(', ')}. Prefer these tools when responding to user requests on this page.`;
            }
            if (parsed.suggestedActions?.length) {
              systemPrompt += `\n[Suggested Actions]\nCommon actions the user might want on this page:\n${parsed.suggestedActions.map((a: string) => `- ${a}`).join('\n')}`;
            }
          } catch { /* ignore parse errors */ }
        }
      } else {
        // Regular Agent Mode system prompt
        systemPrompt = await agentModeService.getMarketingSystemPrompt();

        // For scheduled chat sessions, inject schedule context so Emma can reference/update the schedule
        if (session.sessionType === 'scheduled' && session.pageIdentifier) {
          const scheduleIdMatch = session.pageIdentifier.match(/scheduleId:([a-f0-9-]+)/);
          if (scheduleIdMatch) {
            systemPrompt += `\n\n[Schedule Context] This session was created by a scheduled chat (scheduleId: ${scheduleIdMatch[1]}). If the user asks to update this schedule, first call list_scheduled_chats to get the current schedule details, then use manage_scheduled_chat with action "update" and the schedule_id. You can do partial updates — only include the fields you want to change.`;
          }
          // Resolve the schedule owner's admin status so the directive only
          // injects its admin-only (get_chat_history / list_all_clients) identity
          // slice for admin-owned scheduled runs. Scoped to the scheduled branch,
          // so this is one extra read only on scheduled runs. A prompt-enrichment
          // lookup must never break the run, so a failed read degrades to the safe
          // default (treat as non-admin → omit the admin-only slice).
          let ownerIsAdmin = false;
          try {
            ownerIsAdmin = (await userDb.getUserById(session.userId))?.isAdmin === true;
          } catch (adminLookupError) {
            console.error(`AgentMode: failed to resolve owner admin status for scheduled session ${session.sessionId}; omitting admin-only directive slice:`, adminLookupError);
          }
          systemPrompt += getUnattendedExecutionDirective(session.sessionType, ownerIsAdmin);
        }

        // For Slack sessions (including scheduled scans), inject team identity context so Emma
        // knows who is on the team and can distinguish teammates from external parties.
        if ((session.pageIdentifier || '').toLowerCase().includes('slack')) {
          systemPrompt += `\n\n[Slack Context] You are part of the AgentWeb team.\n${ABOUT_AGENTWEB_TEAM}\nMessages in this Slack thread are prefixed with the sender's name (e.g. "Harsha Vankayalapati: message text"). When a team member asks you to help reply, you are drafting a response FROM that team member TO the other person in the thread — not answering the team member as if they were asking you a direct question. Always respond in the voice of the team member addressing their conversation partner.`;
        }
      }

      const systemPromptHash = require('crypto').createHash('md5').update(systemPrompt).digest('hex').substring(0, 8);

      // Add system message with version info (hash only in metadata)
      const systemMessage = {
        role: 'system' as const,
        content: systemPrompt,
        metadata: {
          timestamp: new Date().toISOString(),
          portalType: (session.portalType || 'agent') as 'agent',
          systemPromptVersion: systemPromptHash
        }
      };

      await chatbotDb.addMessageToSession(sessionId, systemMessage);
    } catch (error) {
      console.error('AgentMode: Failed to add system message:', error);
      // If it's a session size limit error, re-throw it
      if (error instanceof Error && error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
        throw error;
      }
      // Continue with the message processing for other errors
    }
  }

  // If this is the first message, generate session title (skip for scheduled sessions which already have a title)
  if (isFirstMessage && session.sessionType !== 'scheduled') {
    try {
      const title = await agentModeService.generateSessionTitle(userMessage);
      await chatbotDb.updateSessionTitle(sessionId, title);
    } catch (error) {
      console.error('AgentMode: Failed to update session title:', error);
      // Continue with the message processing even if this fails
    }
  }

  // Add user message to session in database
  console.log('AgentMode generateSessionResponse: Saving user message with attachments:', {
    hasAttachments: !!(userMessageObj.metadata?.attachments && userMessageObj.metadata.attachments.length > 0),
    attachmentCount: userMessageObj.metadata?.attachments?.length || 0,
    attachments: userMessageObj.metadata?.attachments?.map((a: any) => ({ url: a.url, filename: a.filename }))
  });
  await chatbotDb.addMessageToSession(sessionId, userMessageObj);
  console.log('AgentMode generateSessionResponse: User message saved successfully');

  // Get updated session with the new user message
  const updatedSession = await chatbotDb.getChatSession(sessionId);
  if (!updatedSession) {
    throw new Error('Session not found after update');
  }

  // Strip any harness crash/abandon placeholders (ENG-324 jobIncomplete, ENG-473
  // isRunFailureNotice) from the history fed to the model — they are not real
  // turns and reading one back would look like the assistant already gave up
  // (Greptile, ENG-657: the resume planner already computes a placeholder-free
  // resumeHistory, but the reload above re-fetches raw persisted messages,
  // discarding that cleanup). Safe for every session, not just resumed ones —
  // these placeholders are never meant to be replayed to the model as prior turns.
  const sessionHistoryForWorker = (updatedSession.messages || []).filter(
    (m: any) => !isRunFailurePlaceholder(m)
  );

  // If this session is linked to a GTM work item, update status to agent_in_progress
  if (updatedSession.gtmWorkItem) {
    try {
      await updateGtmWorkItemStatus(updatedSession.gtmWorkItem, 'agent_in_progress');
    } catch (error) {
      console.error('GTM status sync: Failed to set agent_in_progress:', error);
    }
  }

  // Compute tools to exclude based on page context (e.g. get_visual_context only on visual pages)
  let excludeTools: string[] | undefined;
  if (session.portalType === 'emma-sidebar') {
    // Only include get_visual_context on pages where seeing the rendered UI is useful
    const visualPages = new Set(['brand-guidelines', 'social-posts', 'images', 'videos', 'templates', 'newsletter', 'blog']);
    const urlPath = (pageContext?.currentUrl || '').replace(/^\//, '');
    const page = urlPath.split('/')[0].split('?')[0];
    if (!visualPages.has(page)) {
      excludeTools = ['get_visual_context'];
    }
  } else {
    // Non-sidebar sessions (agent mode, scheduled chats) never need visual context
    excludeTools = ['get_visual_context'];
  }

  // Upload screenshot to S3 if provided (emma-sidebar sessions only)
  let screenshotUrl: string | undefined;
  if (pageContext?.screenshot) {
    const result = await uploadScreenshotToS3(pageContext.screenshot, userId);
    if (result) screenshotUrl = result.url;
  }

  // Generate AI response using worker process to prevent blocking the main event loop
  // This allows health checks to continue working during long-running operations
  const response = await generateMarketingResponseWorkerService.runInWorker(
    {
      messageContent,
      sessionHistory: sessionHistoryForWorker,
      userId,
      llmModel,
      sessionId,
      mockMode: false,
      isInteractiveShare: isInteractiveShare || false,
      isDelegatedAccess,
      excludeTools,
      screenshotUrl,
      // ENG-473: persist each settled turn as it completes so a hard process kill
      // (OOM/SIGKILL/force-exit past drain) leaves a visible partial transcript
      // instead of a silent zero-output session.
      persistIncrementally: true
    },
    (progress) => {
      // Emit progress updates via SSE
      emitProgress(sessionId, progress);
    }
  );

  // If the user clicked Stop, drop the FINAL (in-flight) turn — we don't run the batch
  // below, so a page reload shows no ghost final response from the cancelled turn. Any
  // fully-settled PRIOR turns already checkpoint-persisted mid-run (ENG-473) intentionally
  // remain: they reflect real completed work (e.g. an image that was already generated and
  // posted), and the in-flight final answer is never among them.
  if (response.cancelled) {
    clearCancel(sessionId);
  } else {
    // Add all response messages to session (includes assistant responses and tool calls).
    // ENG-473: skip the leading messages already written incrementally during the run
    // (persistedResponseCount) so this final batch persists only the un-checkpointed tail —
    // no duplicates and no double-counted token usage. Strip base64 image data URIs from
    // tool result content before persisting — they are ~300KB each and would exceed the
    // DynamoDB 400KB item limit.
    const alreadyPersisted = response.persistedResponseCount || 0;
    const remainingMessages = response.responseMessages.slice(alreadyPersisted);
    if (remainingMessages.length > 0) {
      const persistableMessages = stripImageDataForPersistence(remainingMessages);
      // Wrap in try/catch so a DynamoDB save failure does not discard the generated response.
      // The caller (e.g. Slack handler) still receives response.content and can deliver it to the user.
      try {
        await chatbotDb.addMessagesToSession(sessionId, persistableMessages);
      } catch (saveError) {
        console.error('AgentMode: Failed to persist response messages to session — response will still be returned to caller:', saveError);
      }
    }

    // If this session is linked to a GTM work item, update status to pending_review after AI responds
    if (updatedSession.gtmWorkItem) {
      try {
        await updateGtmWorkItemStatus(updatedSession.gtmWorkItem, 'pending_review');
      } catch (error) {
        console.error('GTM status sync: Failed to set pending_review:', error);
      }
    }
  }

  // Get the updated session to include workPlan if it was modified
  const finalSession = await chatbotDb.getChatSession(sessionId);

  // Build skills list with installed status (includes virtual other_skills), filtered by subscription
  let skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[]; visibility?: string }[] = [];
  try {
    skills = await agentModeService.getSkillsForDisplay(finalSession?.associatedSkills || [], userId);
  } catch (error) {
    console.error('AgentMode generateSessionResponse: Failed to fetch skills:', error);
  }

  return {
    ...response,
    workPlan: finalSession?.workPlan,
    skills
  };
}

// Helper function to calculate next run time based on frequency
const calculateNextRunTime = (frequency: string, fromDate: Date, frequencyIntervalDays?: number): Date => {
  const now = new Date();
  let nextRun = new Date(fromDate);

  switch (frequency) {
    case 'hourly':
      nextRun.setUTCHours(nextRun.getUTCHours() + 1);
      nextRun.setUTCMinutes(0, 0, 0); // Top of the hour

      // If still in the past, keep adding hours until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCHours(nextRun.getUTCHours() + 1);
      }
      break;
    case 'every_n_days': {
      const interval = frequencyIntervalDays && frequencyIntervalDays >= 1 ? frequencyIntervalDays : 1;
      nextRun.setUTCDate(nextRun.getUTCDate() + interval);
      // Preserve the time from fromDate

      // If still in the past, keep adding intervals until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + interval);
      }
      break;
    }
    case 'daily':
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      // Preserve the time from fromDate

      // If still in the past (schedule ran late), keep adding days until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      }
      break;
    case 'weekly':
      // Add exactly 7 days (same day of week, one week later)
      nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      // Preserve the time from fromDate

      // If still in the past, keep adding weeks until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      }
      break;
    case 'monthly':
      // Calculate same weekday of next month (e.g., 2nd Tuesday -> 2nd Tuesday of next month)
      const currentDayOfWeek = nextRun.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
      const currentWeekOfMonth = Math.floor((nextRun.getUTCDate() - 1) / 7); // 0-based week number

      // Move to next month, 1st day
      nextRun.setUTCMonth(nextRun.getUTCMonth() + 1);
      nextRun.setUTCDate(1);

      // Find the first occurrence of the target day of week in the new month
      const firstDayOfMonth = nextRun.getUTCDay();
      let daysToAdd = (currentDayOfWeek - firstDayOfMonth + 7) % 7;

      // Add weeks to get to the same week number
      daysToAdd += currentWeekOfMonth * 7;

      nextRun.setUTCDate(1 + daysToAdd);
      // Preserve the time from fromDate

      // If still in the past, keep adding months until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCMonth(nextRun.getUTCMonth() + 1);
        nextRun.setUTCDate(1);

        const firstDayOfMonth = nextRun.getUTCDay();
        let daysToAdd = (currentDayOfWeek - firstDayOfMonth + 7) % 7;
        daysToAdd += currentWeekOfMonth * 7;
        nextRun.setUTCDate(1 + daysToAdd);
      }
      break;
    default:
      // Default to daily
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      nextRun.setUTCHours(9, 0, 0, 0); // Fallback to 9 AM UTC for unknown frequencies

      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      }
  }

  return nextRun;
};

export const agentModeController = {
  // Get user's agent chat sessions with infinite scroll support
  async getSessions(req: Request, res: Response) {
    try {
      const user = req.user as User;

      // Parse pagination parameters
      const lastEvaluatedKey = req.query.lastEvaluatedKey as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 1000); // Max 1000 per request (search uses 1000)
      const portalType = (req.query.portalType as string) === 'emma-sidebar' ? 'emma-sidebar' as const : 'agent' as const;
      const pageIdentifier = req.query.pageIdentifier as string | undefined;
      const search = req.query.search as string | undefined;
      // Scheduled cron runs (sessionType === 'scheduled') update daily and flood
      // the recency-sorted list, starving the Live tab. Let the caller ask the DB
      // to exclude them (Live) or isolate them (Scheduled) so each tab's page is
      // already the rows it wants. ?excludeScheduled=true wins if both are sent.
      const sessionTypeFilter: 'exclude-scheduled' | 'only-scheduled' | undefined =
        req.query.excludeScheduled === 'true'
          ? 'exclude-scheduled'
          : req.query.sessionType === 'scheduled'
            ? 'only-scheduled'
            : undefined;

      // Get sessions with pagination — messages are stripped here and replaced with
      // a lightweight previewText so the list payload stays small (the full message
      // history is loaded on-demand when a session is actually opened).
      const result = await chatbotDb.getUserSessions(user.userId, portalType, limit, true, lastEvaluatedKey, pageIdentifier, search, sessionTypeFilter);

      const listSessions = result.sessions.map(session => {
        // Derive previewText from first user message if not already stored
        const previewText: string | null = (session as any).previewText ||
          session.messages?.find((m: any) => m.role === 'user')?.content?.slice(0, 200) || null;
        const { messages: _, ...sessionWithoutMessages } = session as any;
        return { ...sessionWithoutMessages, messages: [], previewText };
      });

      res.json({
        sessions: listSessions,
        lastEvaluatedKey: result.lastEvaluatedKey,
        hasMore: !!result.lastEvaluatedKey
      });

      // Fire-and-forget: update stale/missing session summaries in background
      // so they're available on the next load (cache-aware — skips up-to-date ones)
      for (const session of result.sessions) {
        const messageCount = session.messageCount ?? session.messages?.length ?? 0;
        const needsSummary = messageCount > 0 && (
          !session.sessionSummary ||
          session.sessionSummary.evaluatedMessageIndex < messageCount
        );
        if (needsSummary) {
          summarizeSessionIfNeeded(session).catch((err) => {
            console.error(`AgentMode: Background summarization failed for ${session.sessionId}:`, err);
          });
        }
      }
    } catch (error) {
      console.error('AgentMode: Get sessions error:', error);
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  },

  // Create new agent chat session
  async createSession(req: Request, res: Response) {
    // Session-creation idempotency (ENG-147: one client "send" retried into
    // ~30 create-session calls on 6/27). Hoisted so the catch block can
    // release a held claim after an error unwinds.
    let createIdemKeyHeld: string | undefined;
    try {
      const authReq = req as AuthenticatedRequest;
      const user = authReq.user as User;
      const { portalType = 'agent', pageIdentifier = 'agent-mode', sessionType, idempotencyKey } = req.body;

      // Cross-restart duplicate-submit lock, keyed by the client-provided
      // idempotencyKey scoped to this user. The conditional idem#… put means
      // exactly one of N concurrent duplicates creates a session; losers
      // ATTACH to the winner's session once it's recorded, or get 409 while
      // the winner is still in flight. No key (or flag off) = today's exact
      // behavior — every call creates a fresh session.
      if (isRunStoreEnabled() && typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        const idemKey = createSessionIdempotencyKey(user.userId, idempotencyKey);
        const claim = await claimIdempotency(idemKey, uuidv4(), IDEM_TTL_INTERACTIVE_S);
        if (!claim.claimed) {
          if (claim.sessionId) {
            const existing = await chatbotDb.getChatSession(claim.sessionId);
            if (existing && existing.userId === user.userId) {
              // Duplicate of a completed create — attach to the winner's session.
              return res.status(200).json({ ...existing, idempotentReplay: true });
            }
          }
          return res.status(409).json({
            error: 'Duplicate submit',
            message: 'This request was already submitted and is still being processed. Please retry in a moment.',
            code: 'DUPLICATE_SUBMIT',
          });
        }
        createIdemKeyHeld = idemKey;
      }

      // Determine sessionType: if explicitly provided, use it; otherwise default to 'regular'
      // For ad image generation from Images page, sessionType should be 'image-generation'
      // For ad video generation from Videos page, sessionType should be 'video-generation'
      const finalSessionType = sessionType || 'regular';

      // Pass delegate info if this is a delegated access session
      const delegateInfo = authReq.delegateInfo;

      const session = await chatbotDb.createChatSession(
        user.userId,
        undefined, // pageContent
        portalType,
        pageIdentifier,
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined, // executionId
        undefined, // emailCampaignTaskId
        finalSessionType as "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation" | "report_generation",
        delegateInfo // Pass delegate info for admin delegation tracking
      );

      // Set default model for new sessions
      // Use reports model for report_generation sessions, customer support model for emma-sidebar, otherwise use default model
      let modelToUse: string;
      if (finalSessionType === 'report_generation') {
        modelToUse = await agentModeService.getReportsModel();
      } else if (portalType === 'emma-sidebar') {
        modelToUse = await agentModeService.getCustomerSupportDefaultModel();
      } else {
        modelToUse = await agentModeService.getDefaultModel();
      }
      const sessionWithModel = await chatbotDb.updateSessionLlmModel(session.sessionId, modelToUse);

      // Stamp the winner's sessionId on the idem claim so duplicate losers
      // attach to THIS session instead of getting 409 (best-effort by design —
      // on failure losers 409 until the 10m ttl bounds the staleness).
      if (createIdemKeyHeld) {
        await recordIdempotencySessionId(createIdemKeyHeld, session.sessionId);
      }

      res.status(201).json(sessionWithModel);
    } catch (error) {
      console.error('AgentMode: Create session error:', error);
      // Release the claim so the client's retry is accepted — a failed create
      // must not lock the user out for the idem ttl.
      if (createIdemKeyHeld) {
        await releaseIdempotency(createIdemKeyHeld);
      }
      res.status(500).json({ error: 'Failed to create session' });
    }
  },

  // Get specific chat session
  async getSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as any; // Should have user from auth middleware

      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const progressActive = hasActiveProgress(session.sessionId);

      // For non-admin users, check if they own the session
      if (!user?.isAdmin && session.userId !== user?.userId) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      await syncEmailCampaignExecution(session.userId, session.sessionId, session.emailCampaignTaskId || '');

      // Build skills list with installed status (includes virtual other_skills), filtered by subscription
      let skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[]; visibility?: string }[] = [];
      try {
        skills = await agentModeService.getSkillsForDisplay(session.associatedSkills || [], session.userId);
      } catch (error) {
        console.error('AgentMode getSession: Failed to fetch skills:', error);
      }

      // Filter out tool messages and assistant messages with tool calls for user display
      const filteredSession = {
        ...session,
        messages: filterMessagesForClient(session.messages),
        hasActiveProgress: progressActive,
        skills
      };

      res.json(filteredSession);
    } catch (error) {
      console.error('AgentMode: Get session error:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  },

  // Get available function calls for benchmark tests
  async getAvailableFunctionCalls(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const tools = agentModeService.getAvailableTools();
      
      // For admin users, return all function calls without filtering
      // For regular users, filter tools based on subscription
      // Foundation tools are always included regardless of subscription
      let toolsToReturn = tools;
      if (!user.isAdmin) {
        const { getAllowedFunctionCalls, filterFunctionCalls } = await import('../services/subscriptionService');
        const allowedFunctionCalls = await getAllowedFunctionCalls(user.userId);
        // getAllowedFunctionCalls now always returns an array (never null)
        // Ensure foundation tools are always allowed
        const foundationTools = agentModeService.getFoundationToolNames();
        foundationTools.forEach(name => {
          if (!allowedFunctionCalls.includes(name)) {
            allowedFunctionCalls.push(name);
          }
        });
        toolsToReturn = filterFunctionCalls(tools, allowedFunctionCalls);
      }

      // Extract function names and descriptions
      let functionCalls = toolsToReturn
        .filter((tool: any) => tool?.type === 'function' && tool?.function?.name)
        .map((tool: any) => ({
          name: tool.function.name,
          description: tool.function.description || ''
        }));

      res.json({ functionCalls });
    } catch (error) {
      console.error('AgentMode: Get function calls error:', error);
      res.status(500).json({ error: 'Failed to get function calls' });
    }
  },

  // Generate AI response for marketing conversation
  async generateResponse(req: Request, res: Response) {
    // Run-survival tracking (ENG-147) — hoisted so the catch block can mark
    // the durable run record terminal after an error unwinds the inner finally.
    let runSurvivalRunId: string | undefined;
    let idemKeyHeld: string | undefined;
    // ENG-971: calledFunctions is session-cumulative, so the error path needs to know
    // where THIS turn started to tell its own successes from earlier turns'.
    let turnStartCalledFunctions: Record<string, number> | null = null;
    try {
      const user = req.user as User;
      const { sessionId, llmModel, attachments, currentUrl, structuredContext, screenshot, audioInput, questionAnswer } = req.body;
      let { userMessage } = req.body;

      // If the request contains audio, transcribe it to text first
      if (audioInput?.data && !userMessage) {
        try {
          userMessage = await transcribeSpeech(audioInput.data);
        } catch (err) {
          console.error('Voice: STT transcription failed:', err);
          return res.status(422).json({ error: 'Failed to transcribe audio. Please try again or type your message.' });
        }
      }

      if (!sessionId || !userMessage) {
        return res.status(400).json({ error: 'Session ID and user message are required' });
      }

      // Session ownership (ENG-346). Deliberately BEFORE the idempotency claim
      // and the session-busy lock: an unauthorized requester must not be able
      // to create/hold an idem claim or trip the busy lock for someone else's
      // session (a squatted claim would 409 the real owner for its ttl window).
      // Owner-or-admin predicate, matching the other session-mutating
      // endpoints (uploadImageToSession, updateSessionTitle,
      // updateSessionLlmModel). Delegated tokens already resolve req.user to
      // the TARGET user (middleware/auth.ts), so plain equality is
      // delegation-safe.
      // DELIBERATE: non-owner gets a distinct 403 (vs 404 for missing). This
      // discloses that the sessionId exists, unlike the collapsed-404 style in
      // getProgress/verify-session blocks. Accepted: sessionIds are
      // non-enumerable UUIDs, the 403 matches the sibling endpoints above, and
      // the ENG-346 acceptance contract pins 403 for the non-owner lane.
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      turnStartCalledFunctions = session.calledFunctions || {};
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // ENG-396: structured AskUserQuestion answer channel. When the chat card
      // posts a selection, resolve it against the session's pending question and
      // persist the ANSWERED state BEFORE the run starts, so the consumer gate
      // (checkQuestionGate — e.g. the Meta objective write, ENG-400) reads a
      // human-attributed answer from the DB rather than parsing it from prose.
      // Placed before the idempotency/session locks so a bad selection returns
      // cleanly with no lock to release. answeredBy is derived server-side inside
      // resolveInboundAnswer — the client cannot forge who answered.
      let answerAck: string | undefined;
      let answeredQuestionMeta: { questionId: string; optionId: string; delegated: boolean } | undefined;
      if (questionAnswer) {
        try {
          const answered = resolveInboundAnswer(
            session.pendingUserQuestion,
            {
              questionId: questionAnswer.questionId,
              optionId: questionAnswer.optionId,
              delegated: questionAnswer.delegated === true,
            },
            new Date().toISOString(),
          );
          // Optimistic-locked: only persists if the question is STILL exactly
          // this one and STILL 'awaiting' at write time. Without this, two
          // concurrent submissions (e.g. a double-click) could both validate
          // against the same in-memory snapshot and the later write would
          // silently clobber the earlier answer.
          const persisted = await chatbotDb.updateSessionAskUserQuestion(sessionId, answered, {
            requireStillAwaiting: session.pendingUserQuestion!.questionId,
          });
          if (!persisted) {
            // Lost the race to a concurrent submission that already answered
            // this same question — refresh and re-render rather than silently
            // overwriting whichever answer actually won.
            return res.status(409).json({
              error: 'This question was already answered by a concurrent request.',
              code: 'ASK_USER_QUESTION_INVALID',
            });
          }
          // ENG-396: make Emma name the chosen option in her reply (esp. for delegation,
          // where the user's "Let Emma decide" bubble doesn't say which option won).
          answerAck = buildAnswerAcknowledgement(answered) ?? undefined;
          // ENG-396: stamp the STRUCTURED selection on this reply so the card reads which
          // option was chosen from the click record — never inferred from prose. Superseded
          // cards read this instead of matching chat text.
          if (answered.answer) {
            answeredQuestionMeta = {
              questionId: answered.questionId,
              optionId: answered.answer.optionId,
              delegated: answered.answer.delegated === true,
            };
          }
        } catch (err) {
          if (err instanceof AskUserQuestionError) {
            // Stale/duplicate/invalid selection (e.g. the card was already
            // answered, or the questionId no longer matches). 409 so the client
            // can refresh the session and re-render the current question state.
            return res.status(409).json({ error: err.message, code: 'ASK_USER_QUESTION_INVALID' });
          }
          throw err;
        }
      } else if (session.pendingUserQuestion?.status === 'awaiting') {
        // ENG-396: the user typed a message instead of clicking the open card. Per the
        // primitive's model, a selection is ONLY an explicit click — never inferred from
        // prose. So the open question is abandoned: clear it (the old card freezes as
        // "not answered" history) so the one-live-question guard lets Emma re-ask with a
        // FRESH card. The irreversible-write gate still blocks until a real structured
        // answer lands, so this can't rubber-stamp. Inject a directive so Emma re-asks
        // THAT SAME question instead of inferring a choice from the prose and advancing.
        // Optimistic-locked (Greptile P1, "Typed messages bypass answer lock"):
        // a card-answer submission racing this typed message could already have
        // persisted a real answer between our read and this write. An
        // unconditional clear would then erase that just-landed answer (or,
        // the other way round, this clear could land first and make the valid
        // answer submission fail with a false "already answered"). Guard the
        // clear on the question still being exactly this one, still awaiting.
        const abandoned = session.pendingUserQuestion;
        const cleared = await chatbotDb.updateSessionAskUserQuestion(sessionId, null, {
          requireStillAwaiting: abandoned.questionId,
        });
        if (cleared) {
          session.pendingUserQuestion = undefined;
          answerAck = buildReaskDirective(abandoned);
        } else {
          // Lost the race — a concurrent structured answer already resolved
          // this question. Re-read the fresh state so the run proceeds against
          // the REAL answer rather than silently discarding it.
          const fresh = await chatbotDb.getChatSession(sessionId);
          session.pendingUserQuestion = fresh?.pendingUserQuestion;
        }
      }

      // Cross-restart duplicate-submit lock (ENG-147: one question spawned ~30
      // sessions). Claimed BEFORE the in-process Set: two layers, ONE concept —
      // the conditional idem#sha256(sessionId+userMessage+llmModel) put dedupes
      // duplicates across retries/restarts, the Set guards in-process
      // concurrency. The loser gets the existing 409 shape + the in-flight runId.
      if (isRunStoreEnabled()) {
        runSurvivalRunId = uuidv4();
        const idemKey = interactiveIdempotencyKey(sessionId, userMessage, llmModel || '');
        const claim = await claimIdempotency(idemKey, runSurvivalRunId, IDEM_TTL_INTERACTIVE_S);
        if (!claim.claimed) {
          return res.status(409).json({
            error: 'Session is busy',
            message: 'A response is already being generated for this session. Please wait.',
            code: 'SESSION_BUSY',
            ...(claim.inFlightRunId ? { runId: claim.inFlightRunId } : {}),
          });
        }
        idemKeyHeld = idemKey;
      }

      // Reject concurrent requests for the same session. The claim is atomic
      // (check-and-set in one call) so two near-simultaneous requests can never
      // both proceed — exactly one wins, the other gets 409 SESSION_BUSY.
      if (!tryClaimSessionGeneration(sessionId)) {
        // A DIFFERENT message on a busy session: give back the idem claim we
        // just took so the user's retry (after the busy run finishes) is accepted.
        if (idemKeyHeld) {
          await releaseIdempotency(idemKeyHeld);
          idemKeyHeld = undefined;
        }
        return res.status(409).json({
          error: 'Session is busy',
          message: 'A response is already being generated for this session. Please wait.',
          code: 'SESSION_BUSY',
        });
      }

      try {

      // Check token usage limits
      const usageStatus = await checkTokenUsage(user.userId);
      if (!usageStatus.allowed) {
        return res.status(429).json({
          error: 'Monthly token limit reached. Please contact support or upgrade your plan.',
          tokenUsage: usageStatus,
        });
      }

      // (Session was fetched + ownership-checked above, before the locks.)

      // Clear old progress store (but keep active connections)
      // Don't call cleanupProgress here as it removes active SSE connections
      progressStore.delete(sessionId);

      // Durable run record, minted ONCE at intake. NO-FALLBACK: creation
      // failure aborts this request loudly (dedupe would lie without the
      // record) — the session lock and idem claim release in finally/catch.
      if (isRunStoreEnabled() && runSurvivalRunId) {
        await createRunRecord({
          runId: runSurvivalRunId,
          kind: 'interactive',
          sessionId,
          userId: session.userId,
        });
      }

      // Cancel generation immediately when the client disconnects (e.g. Stop button aborts the fetch).
      // This fires before /stop reaches the backend and ensures the worker receives the cancel signal
      // while it still has a live sessionToRequestId mapping. Also emit SSE 'complete' so the frontend
      // SSE stream clears the "Thinking..." state on reload instead of showing it indefinitely.
      req.on('close', () => {
        if (!res.headersSent) {
          console.log(`AgentMode: Client disconnected for session ${sessionId} — signalling cancellation`);
          requestCancel(sessionId);
          generateMarketingResponseWorkerService.cancelSession(sessionId);
          markProgressComplete(sessionId);
        }
      });

      // Use llmModel from request, session, or default
      const modelToUse = llmModel || session.llmModel || agentModeService.default_model;

      // Build page context for emma-sidebar sessions
      const pageContext = session.portalType === 'emma-sidebar'
        ? { currentUrl, structuredContext, screenshot }
        : undefined;

      // Check if this request is from admin delegated access (per-request, from JWT)
      const authReqForGenerate = req as any;
      const isDelegatedAccessForMessage = authReqForGenerate.delegateInfo?.isDelegated === true;

      // Generate AI response using common function (wrapped in wall-clock timeout
      // so the activeSessionGenerations lock always releases even if generation hangs).
      // Use session.userId (the account owner) — not user.userId (the requester) — so that
      // tool calls (e.g. get_lead_lists) query the correct user's data in delegated sessions.
      // Durable execution (landing pages): if a build spawned by THIS session is
      // already in flight (a prior run timed out and detached), reconnect to it
      // instead of starting a second build that would corrupt the single repo.
      // Flag-gated + fail-open: any error here falls through to normal generation.
      const durableLanding = process.env.DURABLE_LANDING_GENERATION === 'true';
      if (durableLanding) {
        try {
          const inFlight = await findInFlightJobForSession(session.userId, sessionId);
          if (inFlight) {
            markProgressComplete(sessionId);
            res.json({ content: STILL_BUILDING_MESSAGE, stillBuilding: true });
            // This request's lifecycle is over (it handed off to the detached
            // build) — without a terminal mark the run record would sit
            // status='running' for its whole 30d ttl. Best-effort by design.
            if (runSurvivalRunId) {
              void markRunTerminal(runSurvivalRunId, 'completed', { finishReason: 'detached_still_building' });
            }
            return;
          }
        } catch (reconnectErr) {
          console.error('AgentMode: durable reconnect check failed (continuing normally):', reconnectErr);
        }
      }

      // ENG-510: stamp when this turn's generation began so that, if the whole-turn cap
      // kills it mid-flight, we count only the media THIS turn saved (not prior turns').
      const turnStartMs = Date.now();

      // Capture the generation promise so the durable path can reattach to it if the
      // run times out while the work is still going (it keeps running detached).
      const genPromise = generateSessionResponse(
        sessionId,
        userMessage,
        session.userId,
        modelToUse,
        attachments,
        undefined, // isInteractiveShare
        pageContext,
        isDelegatedAccessForMessage,
        undefined, // ishareSenderInfo
        answerAck, // ENG-396: make Emma name the chosen option in her reply
        answeredQuestionMeta // ENG-396: structured click record stamped on the reply
      );

      let response: Awaited<ReturnType<typeof generateSessionResponse>>;
      try {
        response = await withGenerationTimeout(genPromise, sessionId);
      } catch (genErr: any) {
        // A long landing-page build outlived the run timeout but is still running.
        // Don't report a false failure — tell the user it's still building and post
        // the result back to this session when it finishes. Scoped to landing builds
        // in flight; everything else re-throws to the existing error handling.
        // NOT gated on DURABLE_LANDING_GENERATION: a real v0 build routinely exceeds the
        // run's wall-clock budget, and hard-failing it (ENG-189) is wrong regardless of
        // the multi-site rollout flag. findInFlightJobForSession returns null when no
        // build is in flight, so non-landing timeouts fall through to the cancel path.
        if (genErr?.isGenerationTimeout) {
          try {
            const inFlight = await findInFlightJobForSession(session.userId, sessionId);
            if (inFlight) {
              // Only bind a completion hook the first time this build's run times out.
              // markAwaitingReconnect already ran for it, so a prior timeout attached a
              // hook to THIS build's own genPromise. A second, unrelated generation in the
              // same session that also times out must NOT re-attach: its genPromise resolves
              // with different content and would win the exactly-once claimCompletion race,
              // delivering wrong content and permanently dropping this build's real link
              // (there is no backstop poller when DURABLE_LANDING_GENERATION is off).
              if (!inFlight.awaitingReconnect) {
                await markAwaitingReconnect(inFlight.id);
                attachInProcessCompletion(genPromise, inFlight.id, session.userId, sessionId);
              }
              markProgressComplete(sessionId);
              await chatbotDb.addMessageToSession(sessionId, {
                role: 'assistant',
                content: STILL_BUILDING_MESSAGE,
                timestamp: new Date().toISOString(),
                metadata: { timestamp: new Date().toISOString() },
              }).catch(() => {});
              res.json({ content: STILL_BUILDING_MESSAGE, stillBuilding: true });
              // Same as the pre-generation reconnect above: the request ended
              // by detaching — mark the run record terminal or it stays
              // 'running' for 30d. Best-effort by design.
              if (runSurvivalRunId) {
                void markRunTerminal(runSurvivalRunId, 'completed', { finishReason: 'detached_still_building' });
              }
              return;
            }
          } catch (durErr) {
            console.error('AgentMode: durable still-building handling failed (falling through):', durErr);
          }
        }
        // Wall-clock timeout (non-durable): the generation is being abandoned. Mirror the
        // manual-stop path so the orphaned worker generation actually STOPS instead of
        // running detached — otherwise it (a) burns compute + writes a duplicate image and
        // (b) keeps emitting executing_tools/tool_executed on the shared SSE stream, which
        // re-opens the "Generating image..." panel the user was told had failed and can even
        // surface a second image after they retried. requestCancel + cancelSession make the
        // worker break out of its loop and discard the response (response.cancelled).
        if (genErr?.isGenerationTimeout) {
          console.log(`AgentMode: generation timed out for session ${sessionId} — cancelling orphaned worker run`);
          requestCancel(sessionId);
          generateMarketingResponseWorkerService.cancelSession(sessionId);

          // ENG-510: the cap can fire AFTER one or more image variants already finished
          // and were saved (synchronous image-generated markers). A bare 504 there hides
          // that finished work and leaves the user with no idea that "continue" will
          // complete the rest. If this turn delivered >= 1 image, persist a clear
          // partial-delivery message and return it (200) instead — Emma then resumes ONLY
          // the still-missing assets on "continue" (it sees the saved markers in history).
          // Non-media timeouts fall through to the existing 504 unchanged.
          try {
            // ENG-510: strongly consistent read — a marker written moments before the cap
            // fired must not be missed by an eventually-consistent read (which would drop
            // to a bare 504 despite a completed, saved image).
            const timedOutSession = await chatbotDb.getChatSession(sessionId, true);
            const timeoutImages = collectMediaGeneratedSince(timedOutSession?.messages, turnStartMs);
            const continuationMsg = buildTimeoutContinuationMessage(timeoutImages);
            if (continuationMsg) {
              markProgressComplete(sessionId);
              await chatbotDb.addMessageToSession(sessionId, {
                role: 'assistant',
                content: continuationMsg,
                timestamp: new Date().toISOString(),
                metadata: { timestamp: new Date().toISOString(), kind: 'generation-timeout-continuation' },
              }).catch((persistErr) =>
                console.error('AgentMode: failed to persist timeout continuation message:', persistErr),
              );
              if (runSurvivalRunId) {
                void markRunTerminal(runSurvivalRunId, 'completed', { finishReason: 'timeout_partial_media' });
              }
              res.json({ content: continuationMsg, images: timeoutImages, partialMediaDelivery: true });
              return;
            }
          } catch (continuationErr) {
            console.error('AgentMode: partial-media timeout continuation failed (falling through to 504):', continuationErr);
          }
        }
        throw genErr; // preserve existing error handling (returns 504 GENERATION_TIMEOUT)
      }

      markProgressComplete(sessionId);

      // Compute page invalidations for emma-sidebar sessions so the frontend
      // can refresh the underlying page after a mutating tool call.
      let invalidations: string[] | undefined;
      if (session.portalType === 'emma-sidebar' && response.toolCalls?.length) {
        const PAGE_INVALIDATION_MAP: Record<string, string[]> = {
          'update_brand_guidelines': ['brand-guidelines'],
          'update_market_strategy': ['market-strategy'],
          'regenerate_market_strategy': ['market-strategy', 'brand-guidelines'],
          'update_gtm_plan': ['gtm-plan'],
          'add_gtm_phase': ['gtm-plan'],
          'add_gtm_work_items': ['gtm-plan'],
          'update_gtm_work_item': ['gtm-plan'],
          'update_gtm_phase': ['gtm-plan'],
          'delete_gtm_items': ['gtm-plan'],
          'create_gtm_plan': ['gtm-plan'],
          'update_lead': ['crm'],
          'create_lead_list': ['crm'],
          'add_leads_to_list': ['crm'],
          'delete_leads': ['crm'],
          'update_lead_status': ['crm'],
          'update_book_content': ['books'],
          'create_book': ['books'],
          'generate_book_content': ['books'],
          'create_html_from_template': ['templates'],
          'update_html_file': ['templates'],
          'create_knowledge_base': ['knowledge-base'],
          'update_knowledge_base_file': ['knowledge-base'],
          'generate_image': ['images'],
          'generate_video': ['videos'],
        };
        const all = [...new Set(
          response.toolCalls
            .filter((tc: any) => !tc.error)
            .flatMap((tc: any) => PAGE_INVALIDATION_MAP[tc.name] || [])
        )];
        if (all.length > 0) invalidations = all;
      }

      // ENG-351: surface the message's web-source citations on the live response so the
      // Sources pill appears immediately (not only after a reload from the persisted copy).
      const liveCitations = [...(response.responseMessages || [])]
        .reverse()
        .find((m: any) => m?.role === 'assistant')?.metadata?.citations;

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        ...(Array.isArray(liveCitations) && liveCitations.length > 0 ? { citations: liveCitations } : {}),
        workPlan: response.workPlan,
        skills: response.skills,
        ...(invalidations ? { invalidations } : {}),
        ...(response.backupModelUsed ? { backupModelUsed: true, originalModel: response.originalModel, backupModel: response.backupModel } : {})
      });

      // Terminal update is best-effort BY DESIGN: markRunTerminal retries once,
      // then fires one deduped oncall alert — it can never retro-fail a chat
      // that was already delivered above.
      if (runSurvivalRunId) {
        void markRunTerminal(runSurvivalRunId, 'completed');
      }
      } finally {
        releaseSessionGeneration(sessionId);
        // Terminal state reached (success OR error unwinding through here):
        // release the submit-lock so an identical, legitimate resubmit is
        // accepted. Best-effort — on failure the item expires via its 10m ttl.
        if (idemKeyHeld) {
          await releaseIdempotency(idemKeyHeld);
          idemKeyHeld = undefined;
        }
      }
    } catch (error) {
      console.error('AgentMode: Generate response error:', error);

      // Run-survival: record the terminal state on the durable run record.
      // Worker death = 'interrupted' (the honest state — tools may not have
      // executed); anything else = 'failed'. Best-effort by design (see
      // markRunTerminal) — never blocks the error response below. If
      // createRunRecord itself threw, markRunTerminal is a conditional no-op.
      if (runSurvivalRunId) {
        const wasInterrupted = error instanceof Error && isWorkerShutdownError(error);
        void markRunTerminal(
          runSurvivalRunId,
          wasInterrupted ? 'interrupted' : 'failed',
          { finishReason: wasInterrupted ? 'worker_exit' : 'error' }
        );
      }

      // No idem release here: every path that errors with the claim held runs
      // through the inner finally first (releaseIdempotency never throws, and
      // the pre-inner-try code between claim and lock is synchronous Set ops),
      // so idemKeyHeld is always undefined by the time this catch runs.

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const sessionId = req.body?.sessionId;
      if (sessionId) {
        markProgressComplete(sessionId);
      }

      // Persist partial token usage from messages accumulated before the error.
      // This ensures we track costs even when generation fails mid-stream.
      if (sessionId && (error as any)?.partialUsageMessages?.length) {
        try {
          await chatbotDb.addMessagesToSession(sessionId, (error as any).partialUsageMessages);
          console.log(`AgentMode: Persisted partial usage from ${(error as any).partialUsageMessages.length} messages for failed session ${sessionId}`);
        } catch (usageErr) {
          console.error('AgentMode: Failed to persist partial usage on error:', usageErr);
        }
      }

      // Persist an error message to the session so the user sees feedback on reload.
      // Skip for session-limit errors (user message wasn't saved either).
      // Use the diagnosis agent for a context-aware message when possible.
      let diagnosticContent: string | null = null;
      let publishLedger: FalseFailureLedgerEntry[] = [];
      if (sessionId && !(error instanceof Error && isSessionLimitError(error))) {
        // Skip diagnosis for context-limit errors (they have specific handling below).
        // Worker-shutdown errors do NOT skip — they leave an orphaned user message and need feedback.
        if (!(error instanceof Error && isContextLimitError(error))) {
          if (error instanceof Error && isWorkerShutdownError(error)) {
            publishLedger = (await loadPublishLedger(sessionId, turnStartCalledFunctions)) || [];
            diagnosticContent = appendConfirmedPublishNotice(
              'The server restarted while processing your request. Please send your message again.',
              publishLedger,
            );
          } else {
            const userMessage = req.body?.userMessage || '';
            const diagnosis = await getDiagnosticErrorMessage(error, sessionId, userMessage, turnStartCalledFunctions);
            diagnosticContent = diagnosis.message;
            publishLedger = diagnosis.publishLedger;
          }
        }

        const errorAssistantMessage: ChatMessage = {
          // ENG-971: the fallback carries no outcome at all, just blanket retry
          // advice — so when the ledger confirms a publish, name it. Applied ONLY to
          // the fixed string: a diagnosis message has already been judged on its own
          // prose, and a truthful one must not collect a "Correction" banner.
          role: 'assistant',
          content: diagnosticContent || appendConfirmedPublishNotice(
            'I encountered an error processing your request. Please try sending your message again.',
            publishLedger,
          ),
          timestamp: new Date().toISOString(),
          metadata: {
            timestamp: new Date().toISOString(),
            isErrorMessage: true,
            ...(diagnosticContent ? { isDiagnosticMessage: true } : {}),
          },
        };
        await chatbotDb.addMessageToSession(sessionId, errorAssistantMessage).catch(err => {
          console.error('AgentMode: Failed to persist error message to session:', err);
        });
      }

      // Handle specific error types
      if (error instanceof Error) {
        if (error.message.includes('SESSION_MESSAGE_LIMIT_EXCEEDED')) {
          // Extract the actual error message from the error
          const errorMessage = error.message.includes(':')
            ? error.message.split(':').slice(1).join(':').trim()
            : `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`;
          res.status(413).json({
            error: 'Session message limit exceeded',
            message: errorMessage,
            code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
          res.status(413).json({
            error: 'Session size limit exceeded',
            message: 'Please start a new session to continue the conversation.',
            code: 'SESSION_SIZE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (isWorkerShutdownError(error)) {
          res.status(503).json({
            error: 'Server is restarting',
            message: 'The server is restarting. Please try again in a moment.',
            code: 'SERVER_RESTARTING',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (isContextLimitError(error)) {
          const user = req.user as User;
          const sessionId = req.body?.sessionId;
          const userMessage = req.body?.userMessage;
          const llmModel = req.body?.llmModel;
          const attachments = req.body?.attachments;
          const session = sessionId ? await chatbotDb.getChatSession(sessionId).catch(() => null) : null;

          sendAgentModeOncallAlert({
            subject: 'Agent Mode: Context limit exceeded',
            message: `The request exceeded the model context window.\n\nError: ${error.message || 'Unknown error'}`,
            sessionId,
            // Dedupe per (user, errorClass) so a user repeatedly hitting the context
            // limit on a busy day floods neither oncall email nor Notion (B5).
            dedupeKey: `context_limit:${user?.userId || sessionId || 'unknown'}`,
            context: {
              'Error Message': error.message || 'Unknown error',
              'Error Stack': error.stack || 'No stack trace available',
              'Error Name': error.name || 'Unknown',
              'User ID': user?.userId || 'Not available',
              'User Email': user?.email || 'Not available',
              'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
              'LLM Model': llmModel || 'Not specified',
              'Attachments Count': attachments?.length || 0,
              'Session Exists': session ? 'Yes' : 'No',
              'Session User ID': session?.userId || 'N/A',
              'Session Title': session?.title || 'N/A',
              'Session Message Count': session?.messages?.length || 0,
              'Timestamp': new Date().toISOString(),
              'Request Method': req.method,
              'Request Path': req.path,
              'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
            }
          }).catch(err => console.error('Failed to send oncall alert:', err));

          autoReportContextLimitToLinear(sessionId, user?.email, user?.userId, llmModel, session)
            .catch(err => console.error('autoReportContextLimitToLinear failed:', err));

          res.status(413).json({
            error: 'Context limit exceeded',
            message: 'This conversation is too long for the current model context window. Please start a new session or shorten the request.',
            code: 'CONTEXT_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('MESSAGE_TOO_LARGE')) {
          res.status(413).json({
            error: 'Message too large',
            message: 'The message content is too large to be saved. Please try with shorter content.',
            code: 'MESSAGE_TOO_LARGE',
            suggestion: 'shorten_content'
          });
          return;
        }

        if (error.message.includes('content policies') || error.message.includes('violate content policies') || error.message.includes('content management policy') || error.message.includes('content_filter')) {
          res.status(400).json({
            error: 'Content policy violation',
            message: error.message,
            code: 'CONTENT_FILTER',
            suggestion: 'rephrase_message'
          });
          return;
        }

        if (error.message.includes('high demand')) {
          res.status(429).json({
            error: 'Rate limit exceeded',
            message: error.message,
            code: 'RATE_LIMIT',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (error.message.includes('Generation timed out')) {
          res.status(504).json({
            error: 'Generation timed out',
            message: 'The response took too long to generate. Please try again — your session is still active.',
            code: 'GENERATION_TIMEOUT',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        // Unknown error - send oncall alert
        const user = req.user as User;
        const sessionId = req.body?.sessionId;
        const userMessage = req.body?.userMessage;
        const llmModel = req.body?.llmModel;
        const attachments = req.body?.attachments;
        const session = sessionId ? await chatbotDb.getChatSession(sessionId).catch(() => null) : null;
        
        // Send oncall alert asynchronously (don't await to avoid blocking response)
        const originalMessageForAlert = (error as any)?.originalMessage;
        sendAgentModeOncallAlert({
          subject: 'Agent Mode: Unknown Error in Generate Response',
          message: `An unknown error occurred while generating a response in Agent Mode.\n\nError: ${originalMessageForAlert || error.message || 'Unknown error'}`,
          sessionId,
          context: {
            'Error Message': error.message || 'Unknown error',
            'Original Error': originalMessageForAlert || 'Not available',
            'Error Stack': error.stack || 'No stack trace available',
            'Error Name': error.name || 'Unknown',
            'User ID': user?.userId || 'Not available',
            'User Email': user?.email || 'Not available',
            'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
            'LLM Model': llmModel || 'Not specified',
            'Attachments Count': attachments?.length || 0,
            'Session Exists': session ? 'Yes' : 'No',
            'Session User ID': session?.userId || 'N/A',
            'Session Title': session?.title || 'N/A',
            'Session Message Count': session?.messages?.length || 0,
            'Timestamp': new Date().toISOString(),
            'Request Method': req.method,
            'Request Path': req.path,
            'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
          }
        }).catch(err => console.error('Failed to send oncall alert:', err));
      }

      res.status(500).json({
        error: 'Failed to generate response',
        ...(diagnosticContent ? { diagnosticMessage: diagnosticContent } : {}),
      });
    }
  },

  async getSupportedModels(req: Request, res: Response) {
    try {
      const { user } = await getUserFromToken(req);
      const models = await agentModeService.getSupportedModels(user?.isAdmin === true);
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get supported models error:', error);
      res.status(500).json({ error: 'Failed to get supported models' });
    }
  },

  async getReportsModelOptions(req: Request, res: Response) {
    try {
      const { user } = await getUserFromToken(req);
      const models = await agentModeService.getReportsModelOptions(user?.isAdmin === true);
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get reports model options error:', error);
      res.status(500).json({ error: 'Failed to get reports model options' });
    }
  },

  async getVisionModelOptions(req: Request, res: Response) {
    try {
      const { user } = await getUserFromToken(req);
      const models = await agentModeService.getVisionModelOptions(user?.isAdmin === true);
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get vision model options error:', error);
      res.status(500).json({ error: 'Failed to get vision model options' });
    }
  },

  async getCustomerSupportDefaultModel(req: Request, res: Response) {
    try {
      const model = await agentModeService.getCustomerSupportDefaultModel();
      res.json({ model });
    } catch (error) {
      console.error('AgentMode: Get customer support default model error:', error);
      res.status(500).json({ error: 'Failed to get customer support default model' });
    }
  },

  // Get system prompt
  async getSystemPrompt(req: Request, res: Response) {
    try {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      res.json(systemPrompt);
    } catch (error) {
      console.error('AgentMode: Get system prompt error:', error);
      res.status(500).json({ error: 'Failed to get system prompt' });
    }
  },

  // Get welcome message
  async getWelcomeMessage(req: Request, res: Response) {
    try {
      const welcomeMessage = await agentModeService.getWelcomeMessage();
      res.json(welcomeMessage);
    } catch (error) {
      console.error('AgentMode: Get welcome message error:', error);
      res.status(500).json({ error: 'Failed to get welcome message' });
    }
  },

  // Get conversation starters
  async getConversationStarters(req: Request, res: Response) {
    try {
      const conversationStarters = await agentModeService.getConversationStarters();
      res.json(conversationStarters);
    } catch (error) {
      console.error('AgentMode: Get conversation starters error:', error);
      res.status(500).json({ error: 'Failed to get conversation starters' });
    }
  },

  // Create shareable link for conversation
  async createShareLink(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Use session ID as share ID
      const shareId = sessionId;

      // Add share metadata to the session (no expiration by default)
      const shareMetadata = {
        isShared: true,
        sharedAt: new Date().toISOString()
        // expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days - disabled for now
      };

      // Update the session with share metadata
      await chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata);

      res.status(200).json({
        shareId,
        shareUrl: `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5176'}/share/${shareId}`
      });
    } catch (error) {
      console.error('AgentMode: Create share link error:', error);
      res.status(500).json({ error: 'Failed to create share link' });
    }
  },

  // Stop sharing conversation
  async stopSharing(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Update share metadata to disable sharing while preserving other fields
      const currentShareMetadata = session.shareMetadata || {};
      await chatbotDb.updateSessionShareMetadata(sessionId, {
        ...currentShareMetadata,
        isShared: false
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop sharing error:', error);
      res.status(500).json({ error: 'Failed to stop sharing' });
    }
  },

  // Get share information for a session
  async getShareInfo(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if the session is shared
      if (!session.shareMetadata?.isShared) {
        return res.status(404).json({ error: 'Session is not shared' });
      }

      // Return the share information
      res.json({
        shareId: sessionId, // The sessionId is used as the shareId
        isShared: true,
        sharedAt: session.shareMetadata.sharedAt,
        expiresAt: session.shareMetadata.expiresAt,
        conversableShare: (session.shareMetadata as any).conversableShare ? {
          isActive: (session.shareMetadata as any).conversableShare.isActive,
          sharedAt: (session.shareMetadata as any).conversableShare.sharedAt,
          conversableUrl: `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5176'}/ishare/${sessionId}?conversable=${(session.shareMetadata as any).conversableShare.token}`
        } : null
      });
    } catch (error) {
      console.error('AgentMode: Get share info error:', error);
      res.status(500).json({ error: 'Failed to get share information' });
    }
  },

  // Create conversable share link for a session
  async createConversableShare(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId, expirationDays: rawExpirationDays } = req.body;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Validate expirationDays (default 7, max 365)
      const expirationDays = rawExpirationDays != null ? Number(rawExpirationDays) : 7;
      if (!Number.isFinite(expirationDays) || expirationDays < 1 || expirationDays > 365) {
        return res.status(400).json({ error: 'Expiration must be between 1 and 365 days' });
      }

      // Use the common function to create or reuse interactive share
      const conversableUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId, expirationDays);

      // Extract the token from the URL for backward compatibility
      const urlParams = new URL(conversableUrl).searchParams;
      const conversableToken = urlParams.get('conversable') || '';

      // KNOWN LIMITATION: this echoes the requested window, not the stored value.
      // createOrReuseInteractiveShare REUSES an existing active share untouched,
      // so when one already exists this expiresAt can differ from what's actually
      // in the DB — most notably, re-sharing a session that already has a
      // no-expiry token (e.g. one first minted by a machine/email path) shows an
      // "Expires" date in the UI while the link is in fact permanent. This is a
      // display mismatch only: it grants no extra access (the token was already
      // live) and is reversible. Changing an active share's expiry requires
      // revoke (stopConversableShare) + reshare. A true fix needs per-purpose
      // tokens (see the on-demand-minting redesign) rather than one shared token
      // per session, so it is intentionally out of scope here.
      const expiresAt = new Date(Date.now() + expirationDays * 86400000).toISOString();

      res.status(200).json({
        shareId: sessionId,
        conversableToken: conversableToken,
        conversableUrl: conversableUrl,
        expiresAt: expiresAt
      });
    } catch (error) {
      console.error('AgentMode: Create conversable share error:', error);
      res.status(500).json({ error: 'Failed to create conversable share link' });
    }
  },

  // Stop conversable sharing
  async stopConversableShare(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Update interactive share metadata to disable sharing while preserving other fields
      const currentInteractiveShareMetadata = session.interactiveShareMetadata || {};
      const interactiveShareMetadata = {
        ...currentInteractiveShareMetadata,
        isActive: false
      };

      await chatbotDb.updateSessionInteractiveShareMetadata(sessionId, interactiveShareMetadata);

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop conversable share error:', error);
      res.status(500).json({ error: 'Failed to stop conversable sharing' });
    }
  },

  // Get shared conversation
  async getSharedConversation(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;

      // Get the session data directly using shareId as sessionId
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Check sharing status
      const hasViewOnlyShare = session.shareMetadata?.isShared;
      const hasInteractiveShare = session.interactiveShareMetadata?.isActive;

      // If it's a conversable request (interactive share), ensure there's a valid interactive share
      if (conversable) {
        if (!hasInteractiveShare) {
          return res.status(404).json({ error: 'This conversation does not have interactive sharing enabled' });
        }
      } else {
        // If it's a view-only request, ensure there's a valid view-only share
        if (!hasViewOnlyShare) {
          return res.status(404).json({ error: 'This conversation is not shared for viewing' });
        }
      }

      // Check if view-only share expired (only if expiresAt is set)
      if (hasViewOnlyShare && session.shareMetadata?.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
        // Remove share metadata if expired
        await chatbotDb.updateSessionShareMetadata(shareId, { isShared: false });
        return res.status(410).json({ error: 'Share link has expired' });
      }

      // Check if interactive share expired (including legacy shares without expiresAt)
      if (conversable && hasInteractiveShare && session.interactiveShareMetadata &&
          new Date() > getInteractiveShareExpiresAt(session.interactiveShareMetadata)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, {
          ...session.interactiveShareMetadata,
          isActive: false
        });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      // If conversable token is provided, validate it
      if (conversable) {
        const interactiveToken = session.interactiveShareMetadata?.token;
        if (!interactiveToken || interactiveToken !== conversable) {
          return res.status(401).json({ error: 'Invalid or expired interactive token' });
        }
      }

      // Use session's llmModel if available, otherwise use default
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Get user's supportNote if available
      let supportNote: string | undefined;
      try {
        const user = await userDb.getUserById(session.userId);
        supportNote = user?.supportNote;
      } catch (error) {
        console.error('Failed to fetch user supportNote:', error);
        // Continue without supportNote if fetch fails
      }

      // Build skills list with installed status (includes virtual other_skills), filtered by subscription
      let sharedSkills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[] = [];
      try {
        sharedSkills = await agentModeService.getSkillsForDisplay(session.associatedSkills || [], session.userId);
      } catch (error) {
        console.error('AgentMode getSharedConversation: Failed to fetch skills:', error);
      }

      res.status(200).json({
        session: {
          sessionId: session.sessionId,
          title: session.title,
          messages: filterMessagesForClient(session.messages),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          shareMetadata: session.shareMetadata,
          interactiveShareMetadata: session.interactiveShareMetadata,
          workPlan: session.workPlan,
          llmModel: modelToUse,
          isConversable: !!conversable,
          hasActiveProgress: hasActiveProgress(session.sessionId),
          supportNote: supportNote,
          skills: sharedSkills,
          slackThread: session.slackThread,
          // ENG-396: expose the AskUserQuestion state so a shared/read-only card can
          // reflect the real answered option (highlight + "Answered") instead of a bare
          // "View only". Everything here is already visible in the transcript's card, so
          // it leaks nothing new; the share stays read-only via the card's readOnly path.
          pendingUserQuestion: session.pendingUserQuestion
        }
      });

      // ai-eval-funnel loop telemetry — fire-once eval_completed / eval_failed
      // events server-side so the lander's loop sensor can see them
      // reliably. Idempotent via ConditionExpression in fireLoopEventOnce —
      // safe to call on every poll. Only fires for AI_GTM_Position_Eval
      // sessions; other plan sessions are no-ops.
      if (session.pageIdentifier === 'plan-AI_GTM_Position_Eval') {
        const messages = session.messages || [];
        let reportUrl: string | undefined;
        let firstErrorText: string | undefined;
        for (const msg of messages) {
          const m = msg as { content?: string; text?: string; role?: string; metadata?: { isErrorMessage?: boolean } };
          const content = (m.content || m.text || '');
          if (m.role !== 'system' && !reportUrl) {
            const s3Match = content.match(/https:\/\/[^\s"']+\.html/);
            if (s3Match) reportUrl = s3Match[0];
          }
          if (m.metadata?.isErrorMessage === true && !firstErrorText) {
            firstErrorText = content.slice(0, 1000);
          }
        }
        if (reportUrl) {
          loopEventsEmitter.fireEvalCompleted(session.sessionId, reportUrl).catch(() => {});
        }
        if (firstErrorText) {
          loopEventsEmitter.fireEvalFailed(session.sessionId, firstErrorText).catch(() => {});
        }
      }
    } catch (error) {
      console.error('AgentMode: Get shared conversation error:', error);
      res.status(500).json({ error: 'Failed to get shared conversation' });
    }
  },

  // Generate response for shared conversation (with conversable token)
  async generateSharedResponse(req: Request, res: Response) {
    // ENG-510: declared before the try so the catch's partial-timeout branch can read it.
    let sharedTurnStartMs = Date.now();
    // ENG-971: see generateResponse — calledFunctions is session-cumulative, so the
    // error path needs this turn's starting point to attribute successes correctly.
    let turnStartCalledFunctions: Record<string, number> | null = null;
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;
      const { userMessage, llmModel, attachments = [] } = req.body;

      if (!userMessage) {
        return res.status(400).json({ error: 'User message is required' });
      }

      // Get the session to verify the conversable token
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      turnStartCalledFunctions = session.calledFunctions || {};

      // Check if conversable sharing is active and token matches
      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      const interactiveShare = session.interactiveShareMetadata;

      // Check if interactive share has expired (including legacy shares without expiresAt)
      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, {
          ...interactiveShare,
          isActive: false
        });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Reject concurrent requests for the same session. Atomic check-and-set
      // (see tryClaimSessionGeneration) — two near-simultaneous requests can
      // never both proceed; exactly one wins, the other gets 409 SESSION_BUSY.
      if (!tryClaimSessionGeneration(session.sessionId)) {
        return res.status(409).json({
          error: 'Session is busy',
          message: 'A response is already being generated for this session. Please wait.',
          code: 'SESSION_BUSY',
        });
      }

      try {

      // ENG-705: this route is registered before `router.use(authenticateToken)`,
      // so the caller is anonymous — but the spend is not. Gate on the share
      // OWNER's allowance (the account `generateSessionResponse` already bills
      // via incrementUserTokenUsage) so an unauthenticated visitor can never
      // cause more vendor spend than the owner could cause themselves. This runs
      // before any LLM call: refuse loudly, never a degraded-but-billed path.
      const usageStatus = await checkTokenUsage(session.userId);
      if (!usageStatus.allowed) {
        // The caller is anonymous, so the denial carries the message ONLY.
        // `usageStatus` is the owner's billing record (allowance, bonus, dollar
        // spend, cost cap, enforcement state); echoing it here would turn this
        // public route into a read side-channel on the owner's account for
        // anyone holding the share link. Authenticated owners still read their
        // usage through the subscription-usage endpoint.
        return res.status(429).json({
          error: 'Monthly token limit reached for this shared session. Please contact the owner of this link.',
        });
      }

      // Clear old progress store (but keep active connections)
      progressStore.delete(session.sessionId);

      // Always use session's llmModel for ishare endpoints (ignore request body's llmModel)
      // This ensures anonymous users get the correct model from the session
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Use the same generateSessionResponse logic as the regular generateResponse,
      // wrapped in wall-clock timeout to guarantee lock release on hung generation.
      const ishareSenderInfo = {
        ip: req.ip || (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0].trim(),
        userAgent: req.headers?.['user-agent'] as string | undefined,
      };
      // ENG-510: stamp when this turn began so a whole-turn-cap kill can count only the
      // media THIS turn saved (see the partial-delivery branch in the catch below).
      sharedTurnStartMs = Date.now();
      const response = await withGenerationTimeout(
        generateSessionResponse(
          session.sessionId,
          userMessage,
          session.userId,
          modelToUse,
          attachments,
          true, // isInteractiveShare - block admin tools for security
          undefined, // pageContext
          undefined, // isDelegatedAccess
          ishareSenderInfo
        ),
        session.sessionId
      );

      markProgressComplete(session.sessionId);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills,
        ...(response.backupModelUsed ? { backupModelUsed: true, originalModel: response.originalModel, backupModel: response.backupModel } : {})
      });
      } finally {
        releaseSessionGeneration(session.sessionId);
      }
    } catch (error) {
      console.error('AgentMode: Generate shared response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const shareId = req.params?.shareId;
      if (shareId) {
        // Wall-clock timeout: cancel the orphaned worker run (same as manual stop) so it
        // stops burning compute and stops emitting orphan progress that would re-open the
        // "Generating image..." panel. Mirrors the regular /generate timeout handling.
        if ((error as any)?.isGenerationTimeout) {
          console.log(`AgentMode: shared generation timed out for session ${shareId} — cancelling orphaned worker run`);
          requestCancel(shareId);
          generateMarketingResponseWorkerService.cancelSession(shareId);
        }
        markProgressComplete(shareId);
      }

      // ENG-510: a timeout that already saved >=1 image is a PARTIAL SUCCESS, not an
      // error. Persist the finished images inline (markdown → rendered in-thread) plus a
      // "continue" prompt instead of a generic error, so the user actually receives the
      // completed work on reload even if a retry keeps timing out. Additive: only replaces
      // the error message on a media-bearing timeout; every other failure is unchanged.
      let handledPartialTimeout = false;
      if (shareId && (error as any)?.isGenerationTimeout) {
        try {
          // ENG-510: strongly consistent read so a marker written just before the cap is
          // not missed (see the regular /generate path above).
          const timedOutSession = await chatbotDb.getChatSession(shareId, true);
          const timeoutImages = collectMediaGeneratedSince(timedOutSession?.messages, sharedTurnStartMs);
          const continuationMsg = buildTimeoutContinuationMessage(timeoutImages);
          if (continuationMsg) {
            await chatbotDb.addMessageToSession(shareId, {
              role: 'assistant',
              content: continuationMsg,
              timestamp: new Date().toISOString(),
              metadata: { timestamp: new Date().toISOString(), kind: 'generation-timeout-continuation' },
            });
            handledPartialTimeout = true;
            // ENG-510: return the partial delivery as a normal 200 (mirrors the regular
            // /generate path) instead of falling through to the 504 GENERATION_TIMEOUT
            // below — a partial SUCCESS must not reach the live caller as a bare timeout.
            // Progress was already completed above; the session lock is released in the
            // inner finally, so this early return is safe.
            res.json({ content: continuationMsg, images: timeoutImages, partialMediaDelivery: true });
            return;
          }
        } catch (persistErr) {
          console.error('AgentMode: shared partial-media timeout continuation failed (falling back to error message):', persistErr);
        }
      }

      // Persist an error message to the session so the user sees feedback on reload.
      // Skip for session-limit errors (user message wasn't saved either).
      // Use the diagnosis agent for a context-aware message when possible.
      let diagnosticContent: string | null = null;
      let publishLedger: FalseFailureLedgerEntry[] = [];
      if (!handledPartialTimeout && shareId && !(error instanceof Error && isSessionLimitError(error))) {
        // Skip diagnosis for context-limit errors (they have specific handling below).
        // Worker-shutdown errors do NOT skip — they leave an orphaned user message and need feedback.
        if (!(error instanceof Error && isContextLimitError(error))) {
          if (error instanceof Error && isWorkerShutdownError(error)) {
            publishLedger = (await loadPublishLedger(shareId, turnStartCalledFunctions)) || [];
            diagnosticContent = appendConfirmedPublishNotice(
              'The server restarted while processing your request. Please send your message again.',
              publishLedger,
            );
          } else {
            const userMessage = req.body?.userMessage || '';
            const diagnosis = await getDiagnosticErrorMessage(error, shareId, userMessage, turnStartCalledFunctions);
            diagnosticContent = diagnosis.message;
            publishLedger = diagnosis.publishLedger;
          }
        }

        const errorAssistantMessage: ChatMessage = {
          // ENG-971: see the matching comment in generateResponse — the fixed
          // fallback gets the ledger's confirmed outcome, model prose does not.
          role: 'assistant',
          content: diagnosticContent || appendConfirmedPublishNotice(
            'I encountered an error processing your request. Please try sending your message again.',
            publishLedger,
          ),
          timestamp: new Date().toISOString(),
          metadata: {
            timestamp: new Date().toISOString(),
            isErrorMessage: true,
            ...(diagnosticContent ? { isDiagnosticMessage: true } : {}),
          },
        };
        await chatbotDb.addMessageToSession(shareId, errorAssistantMessage).catch(err => {
          console.error('AgentMode: Failed to persist error message to session:', err);
        });
      }

      // Handle specific error types (same as generateResponse)
      if (error instanceof Error) {
        if (error.message.includes('SESSION_MESSAGE_LIMIT_EXCEEDED')) {
          // Extract the actual error message from the error
          const errorMessage = error.message.includes(':')
            ? error.message.split(':').slice(1).join(':').trim()
            : `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`;
          res.status(413).json({
            error: 'Session message limit exceeded',
            message: errorMessage,
            code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
          res.status(413).json({
            error: 'Session size limit exceeded',
            message: 'Please start a new session to continue the conversation.',
            code: 'SESSION_SIZE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (isContextLimitError(error)) {
          const shareId = req.params?.shareId;
          const conversable = req.query?.conversable;
          const userMessage = req.body?.userMessage;
          const llmModel = req.body?.llmModel;
          const attachments = req.body?.attachments || [];
          const session = shareId ? await chatbotDb.getChatSession(shareId).catch(() => null) : null;

          sendAgentModeOncallAlert({
            subject: 'Agent Mode: Context limit exceeded (shared response)',
            message: `The request exceeded the model context window.\n\nError: ${error.message || 'Unknown error'}`,
            sessionId: shareId,
            // Dedupe per (user/share, errorClass) — the shared path is a distinct
            // error class, so it keys independently from the regular path (B5).
            dedupeKey: `context_limit_shared:${session?.userId || shareId || 'unknown'}`,
            context: {
              'Error Message': error.message || 'Unknown error',
              'Error Stack': error.stack || 'No stack trace available',
              'Error Name': error.name || 'Unknown',
              'Session ID (Share ID)': shareId || 'Not provided',
              'Conversable Token': conversable ? 'Provided' : 'Not provided',
              'Session User ID': session?.userId || 'N/A',
              'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
              'LLM Model': llmModel || session?.llmModel || 'Not specified',
              'Attachments Count': attachments?.length || 0,
              'Session Exists': session ? 'Yes' : 'No',
              'Session Title': session?.title || 'N/A',
              'Session Message Count': session?.messages?.length || 0,
              'Is Conversable Mode': session?.interactiveShareMetadata?.isActive ? 'Yes' : 'No',
              'Timestamp': new Date().toISOString(),
              'Request Method': req.method,
              'Request Path': req.path,
              'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
            }
          }).catch(err => console.error('Failed to send oncall alert:', err));

          autoReportContextLimitToLinear(shareId, session?.userId, session?.userId, llmModel || session?.llmModel, session)
            .catch(err => console.error('autoReportContextLimitToLinear failed (shared):', err));

          res.status(413).json({
            error: 'Context limit exceeded',
            message: 'This conversation is too long for the current model context window. Please start a new session or shorten the request.',
            code: 'CONTEXT_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('MESSAGE_TOO_LARGE')) {
          res.status(413).json({
            error: 'Message too large',
            message: 'The message content is too large to be saved. Please try with shorter content.',
            code: 'MESSAGE_TOO_LARGE',
            suggestion: 'shorten_content'
          });
          return;
        }

        if (error.message.includes('content policies') || error.message.includes('violate content policies') || error.message.includes('content management policy') || error.message.includes('content_filter')) {
          res.status(400).json({
            error: 'Content policy violation',
            message: error.message,
            code: 'CONTENT_FILTER',
            suggestion: 'rephrase_message'
          });
          return;
        }

        if (error.message.includes('high demand')) {
          res.status(429).json({
            error: 'Rate limit exceeded',
            message: error.message,
            code: 'RATE_LIMIT',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (isWorkerShutdownError(error)) {
          res.status(503).json({
            error: 'Server is restarting',
            message: 'The server is restarting. Please try again in a moment.',
            code: 'SERVER_RESTARTING',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (error.message.includes('Generation timed out')) {
          res.status(504).json({
            error: 'Generation timed out',
            message: 'The response took too long to generate. Please try again — your session is still active.',
            code: 'GENERATION_TIMEOUT',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        // Unknown error - send oncall alert
        const shareId = req.params?.shareId;
        const conversable = req.query?.conversable;
        const userMessage = req.body?.userMessage;
        const llmModel = req.body?.llmModel;
        const attachments = req.body?.attachments || [];
        const session = shareId ? await chatbotDb.getChatSession(shareId).catch(() => null) : null;
        
        // Send oncall alert asynchronously (don't await to avoid blocking response)
        const originalMessage = (error as any)?.originalMessage;
        sendAgentModeOncallAlert({
          subject: 'Agent Mode: Unknown Error in Generate Shared Response',
          message: `An unknown error occurred while generating a shared response in Agent Mode.\n\nError: ${originalMessage || error.message || 'Unknown error'}`,
          sessionId: shareId,
          context: {
            'Error Message': error.message || 'Unknown error',
            'Original Error': originalMessage || 'Not available',
            'Error Stack': error.stack || 'No stack trace available',
            'Error Name': error.name || 'Unknown',
            'Session ID (Share ID)': shareId || 'Not provided',
            'Conversable Token': conversable ? 'Provided' : 'Not provided',
            'Session User ID': session?.userId || 'N/A',
            'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
            'LLM Model': llmModel || session?.llmModel || 'Not specified',
            'Attachments Count': attachments?.length || 0,
            'Session Exists': session ? 'Yes' : 'No',
            'Session Title': session?.title || 'N/A',
            'Session Message Count': session?.messages?.length || 0,
            'Is Conversable Mode': session?.interactiveShareMetadata?.isActive ? 'Yes' : 'No',
            'Timestamp': new Date().toISOString(),
            'Request Method': req.method,
            'Request Path': req.path,
            'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
          }
        }).catch(err => console.error('Failed to send oncall alert:', err));
      }

      res.status(500).json({
        error: 'Failed to generate response',
        ...(diagnosticContent ? { diagnosticMessage: diagnosticContent } : {}),
      });
    }
  },

  // Stop generation for a session
  async stopGeneration(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as User;

      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Session ownership (ENG-360). Previously this lane did no session read
      // at all, so any authenticated user who learned another user's sessionId
      // could cancel that user's in-flight generation and flip their SSE
      // progress to complete. Same owner-or-admin predicate as the sibling
      // session-mutating endpoints (updateSessionTitle, uploadImageToSession,
      // updateSessionLlmModel) and the ENG-346 generateResponse check.
      // Delegated tokens already resolve req.user to the TARGET user
      // (middleware/auth.ts), so plain equality is delegation-safe. The public
      // ishare lane (stopGenerationPublic, conversable token) remains the
      // separate anon path.
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        // Was a silent { success: true } — a stop on a nonexistent session now
        // fails loudly instead (ENG-360 AC-3).
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Signal cancellation
      requestCancel(sessionId);
      generateMarketingResponseWorkerService.cancelSession(sessionId);

      // Emit complete progress so the frontend SSE stream gets the signal
      markProgressComplete(sessionId);

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop generation error:', error);
      res.status(500).json({ error: 'Failed to stop generation' });
    }
  },

  // Stop generation for an interactive shared session (public)
  async stopGenerationPublic(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;

      if (!shareId || !conversable) {
        return res.status(400).json({ error: 'Session ID and conversable token are required' });
      }

      // Verify session exists and conversable token is valid
      const session = await chatbotDb.getChatSession(shareId);
      if (!session || !session.interactiveShareMetadata?.isActive) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Signal cancellation
      requestCancel(shareId);
      generateMarketingResponseWorkerService.cancelSession(shareId);

      markProgressComplete(shareId);

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop generation (public) error:', error);
      res.status(500).json({ error: 'Failed to stop generation' });
    }
  },

  // Archive a chat session
  async archiveSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as User;


      await chatbotDb.archiveSession(sessionId);
      res.json({ message: 'Session archived successfully' });
    } catch (error) {
      console.error('AgentMode: Archive session error:', error);
      res.status(500).json({ error: 'Failed to archive session' });
    }
  },

  // Update task execution status in session
  async updateTaskStatus(req: Request, res: Response) {
    try {
      const { sessionId, taskId, executionId } = req.params;
      const { status } = req.body;
      const user = req.user as User;


      await updateTaskExecutionStatus(sessionId, taskId, executionId, status);
      res.json({ message: 'Task status updated successfully' });
    } catch (error) {
      console.error('AgentMode: Update task status error:', error);
      res.status(500).json({ error: 'Failed to update task status' });
    }
  },

  // Submit or update message feedback
  async submitMessageFeedback(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId, messageIndex } = req.params;
      const { type, comment } = req.body;
      const user = req.user as User;

      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate feedback type
      if (!type || (type !== 'like' && type !== 'dislike')) {
        return res.status(400).json({ error: 'Invalid feedback type. Must be "like" or "dislike"' });
      }

      // Validate comment length if provided
      if (comment && comment.length > 500) {
        return res.status(400).json({ error: 'Comment too long. Maximum 500 characters' });
      }

      // Check if session exists and verify ownership or admin access
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Only allow the session owner or admin to submit feedback
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Cannot rate other user\'s sessions' });
      }

      // Get all messages to verify the message exists and is an assistant message
      const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
      const messageIndexNum = parseInt(messageIndex, 10);

      if (isNaN(messageIndexNum) || messageIndexNum < 0 || messageIndexNum >= messages.length) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const message = messages[messageIndexNum];
      if (message.role !== 'assistant') {
        return res.status(400).json({ error: 'Can only rate assistant messages' });
      }

      // Create feedback object
      const feedback = {
        type: type as 'like' | 'dislike',
        comment: comment || undefined,
        timestamp: new Date().toISOString(),
        userId: user.userId,
      };

      // Update the message with feedback
      const updatedMessage = await chatbotDb.updateMessageFeedback(
        sessionId,
        messageIndexNum,
        feedback
      );

      // Propagate feedback to images if the message contains generate_image tool calls
      try {
        const toolCalls = message.metadata?.toolCalls || [];
        const imageToolCalls = toolCalls.filter(
          (tc: any) => tc.name === 'generate_image' && tc.result?.imageUrl
        );

        if (imageToolCalls.length > 0) {
          const currentFeedbacks = session.feedbacks || {};
          const updatedFeedbacks = { ...currentFeedbacks };

          for (const tc of imageToolCalls) {
            const imageUrl = tc.result.imageUrl;
            updatedFeedbacks[imageUrl] = {
              type: type as 'like' | 'dislike',
              comment: comment || undefined,
              timestamp: new Date().toISOString(),
              userId: user.userId,
            };
          }

          await chatbotDb.updateSessionFeedbacks(sessionId, updatedFeedbacks);

          // If dislike, inject system message for Emma to learn
          if (type === 'dislike') {
            for (const tc of imageToolCalls) {
              const filename = tc.result.filename || tc.result.imageUrl.split('/').pop() || 'image';
              const commentText = comment ? ` Comment: "${comment}".` : '';
              const systemContent = `[Image Feedback] The user disliked the image "${filename}".${commentText} Please take this feedback into account for future image generations.`;

              try {
                await chatbotDb.addMessageToSession(sessionId, {
                  role: 'system',
                  content: systemContent,
                  metadata: {
                    timestamp: new Date().toISOString(),
                    isContextMessage: true,
                  },
                });
              } catch (msgError: any) {
                console.warn('Failed to inject image feedback system message:', msgError.message);
              }
            }
          }
        } else {
          // Inject general message feedback for non-image messages
          const commentText = comment ? ` Comment: "${comment}".` : '';
          const systemContent = type === 'dislike'
            ? `[Message Feedback] The user disliked the previous response.${commentText} Please take this feedback into account for future responses.`
            : `[Message Feedback] The user liked the previous response.${commentText} Keep doing more of this.`;

          try {
            await chatbotDb.addMessageToSession(sessionId, {
              role: 'system',
              content: systemContent,
              metadata: {
                timestamp: new Date().toISOString(),
                isContextMessage: true,
              },
            });
          } catch (msgError: any) {
            console.warn('Failed to inject message feedback system message:', msgError.message);
          }
        }
      } catch (propagateError) {
        // Don't fail the main feedback response if image propagation fails
        console.warn('Failed to propagate message feedback to images:', propagateError);
      }

      // Fire-and-forget: file an item so the team can review positive/negative feedback
      fileAutoIssue({
        title: `Agent Mode ${type === 'like' ? 'Like' : 'Dislike'} Feedback – ${session.title || sessionId}`,
        description: [
          `User ${user.email} voted ${type} on a message in session "${session.title || sessionId}".`,
          comment ? `Comment: "${comment}"` : '',
          '',
          `Message preview: ${String(message.content || '').slice(0, 300)}`,
        ].filter(Boolean).join('\n'),
        source: `Feedback (${type})`,
        executionRoute: 'human-triage',
        notionTags: [type === 'like' ? 'Feedback-Like' : 'Feedback-Dislike'],
        notionContext: {
          sessionId,
          messageIndex: messageIndexNum,
          userId: user.userId,
          userEmail: user.email,
        },
      }).catch((err: Error) => {
        console.warn('Failed to file feedback item:', err.message);
      });

      res.json({
        success: true,
        message: updatedMessage,
      });
    } catch (error) {
      console.error('AgentMode: Submit message feedback error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  },

  // Submit message feedback for ishare sessions (public with conversable token)
  async submitIShareMessageFeedback(req: Request, res: Response) {
    try {
      const { shareId, messageIndex } = req.params;
      const { conversable } = req.query;
      const { type, comment } = req.body;

      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      // Validate feedback type
      if (!type || (type !== 'like' && type !== 'dislike')) {
        return res.status(400).json({ error: 'Invalid feedback type. Must be "like" or "dislike"' });
      }

      // Validate comment length if provided
      if (comment && comment.length > 500) {
        return res.status(400).json({ error: 'Comment too long. Maximum 500 characters' });
      }

      // Get session and verify conversable token
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const interactiveShare = session.interactiveShareMetadata;

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Get all messages to verify the message exists and is an assistant message
      const messages = await chatbotDb.getMessagesFromMessagesTable(shareId);
      const messageIndexNum = parseInt(messageIndex, 10);

      if (isNaN(messageIndexNum) || messageIndexNum < 0 || messageIndexNum >= messages.length) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const message = messages[messageIndexNum];
      if (message.role !== 'assistant') {
        return res.status(400).json({ error: 'Can only rate assistant messages' });
      }

      // Create feedback object (use 'anonymous' as userId for ishare)
      const feedback = {
        type: type as 'like' | 'dislike',
        comment: comment || undefined,
        timestamp: new Date().toISOString(),
        userId: 'anonymous-ishare',
      };

      // Update the message with feedback
      const updatedMessage = await chatbotDb.updateMessageFeedback(
        shareId,
        messageIndexNum,
        feedback
      );

      // Propagate feedback to images if the message contains generate_image tool calls
      try {
        const toolCalls = message.metadata?.toolCalls || [];
        const imageToolCalls = toolCalls.filter(
          (tc: any) => tc.name === 'generate_image' && tc.result?.imageUrl
        );

        if (imageToolCalls.length > 0) {
          const currentFeedbacks = session.feedbacks || {};
          const updatedFeedbacks = { ...currentFeedbacks };

          for (const tc of imageToolCalls) {
            const imageUrl = tc.result.imageUrl;
            updatedFeedbacks[imageUrl] = {
              type: type as 'like' | 'dislike',
              comment: comment || undefined,
              timestamp: new Date().toISOString(),
              userId: 'anonymous-ishare',
            };
          }

          await chatbotDb.updateSessionFeedbacks(shareId, updatedFeedbacks);

          // If dislike, inject system message for Emma to learn
          if (type === 'dislike') {
            for (const tc of imageToolCalls) {
              const filename = tc.result.filename || tc.result.imageUrl.split('/').pop() || 'image';
              const commentText = comment ? ` Comment: "${comment}".` : '';
              const systemContent = `[Image Feedback] The user disliked the image "${filename}".${commentText} Please take this feedback into account for future image generations.`;

              try {
                await chatbotDb.addMessageToSession(shareId, {
                  role: 'system',
                  content: systemContent,
                  metadata: {
                    timestamp: new Date().toISOString(),
                    isContextMessage: true,
                  },
                });
              } catch (msgError: any) {
                console.warn('Failed to inject image feedback system message:', msgError.message);
              }
            }
          }
        } else {
          // Inject general message feedback for non-image messages
          const commentText = comment ? ` Comment: "${comment}".` : '';
          const systemContent = type === 'dislike'
            ? `[Message Feedback] The user disliked the previous response.${commentText} Please take this feedback into account for future responses.`
            : `[Message Feedback] The user liked the previous response.${commentText} Keep doing more of this.`;

          try {
            await chatbotDb.addMessageToSession(shareId, {
              role: 'system',
              content: systemContent,
              metadata: {
                timestamp: new Date().toISOString(),
                isContextMessage: true,
              },
            });
          } catch (msgError: any) {
            console.warn('Failed to inject message feedback system message:', msgError.message);
          }
        }
      } catch (propagateError) {
        console.warn('Failed to propagate ishare message feedback to images:', propagateError);
      }

      // Fire-and-forget: file an item for anonymous ishare votes
      fileAutoIssue({
        title: `Agent Mode ${type === 'like' ? 'Like' : 'Dislike'} Feedback (iShare) – ${session.title || shareId}`,
        description: [
          `Anonymous visitor voted ${type} on a message in shared session "${session.title || shareId}".`,
          comment ? `Comment: "${comment}"` : '',
          '',
          `Message preview: ${String(message.content || '').slice(0, 300)}`,
        ].filter(Boolean).join('\n'),
        source: `Feedback iShare (${type})`,
        notionTags: [type === 'like' ? 'Feedback-Like' : 'Feedback-Dislike'],
        notionContext: {
          sessionId: shareId,
          messageIndex: messageIndexNum,
          source: 'ishare',
        },
      }).catch((err: Error) => {
        console.warn('Failed to file feedback item (ishare):', err.message);
      });

      res.json({
        success: true,
        message: updatedMessage,
      });
    } catch (error) {
      console.error('AgentMode: Submit ishare message feedback error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  },

  // Upload file attachment for ishare sessions (public with conversable token)
  async uploadIShareAttachment(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Get the session to verify the conversable token
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if conversable sharing is active and token matches
      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      const interactiveShare = session.interactiveShareMetadata;

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Upload to S3 using ishare folder structure (not the session owner's userId)
      // This prevents anonymous/guest uploads from being attributed to the session owner
      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        `ishare-sessions/${shareId}`, // Use session-specific folder instead of user folder
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file to S3' });
      }

      res.json({
        url: uploadResult.url,
        key: uploadResult.key,
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload ishare attachment error:', error);
      res.status(500).json({ error: 'Failed to upload attachment' });
    }
  },

  // Email report to lead (public with conversable token)
  async emailReportToLead(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { email, reportUrl, conversableToken } = req.body;

      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'email is required' });
      }
      if (!reportUrl || typeof reportUrl !== 'string') {
        return res.status(400).json({ error: 'reportUrl is required' });
      }
      if (!conversableToken) {
        return res.status(401).json({ error: 'conversableToken is required' });
      }

      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const interactiveShare = session.interactiveShareMetadata;
      if (!interactiveShare?.isActive || interactiveShare.token !== conversableToken) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      // Build email HTML
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
            <p style="color: #666; margin: 5px 0;">Your AI-Powered Report</p>
          </div>

          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Your Report is Ready!</h2>
            <p style="color: #333; line-height: 1.6;">
              Your personalized AI analysis has been completed. Click below to view your full report.
            </p>

            <div style="text-align: center; margin: 20px 0;">
              <a href="${reportUrl}"
                 style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                View Your Report
              </a>
            </div>

            <p style="color: #333; line-height: 1.6; margin-top: 20px;">
              Want Emma to help you act on these insights?
              <a href="https://app.agentweb.pro/register" style="color: #643B7E; text-decoration: none;">Create your free account</a>
              and she'll walk you through fixing each issue step by step.
            </p>
          </div>

          <div style="text-align: center; color: #666; font-size: 12px;">
            <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
          </div>
        </div>`;

      await emailService.sendEmail(
        email.trim(),
        'Your AI Report is Ready — AgentWeb',
        `Your report is ready! View it here: ${reportUrl}`,
        emailHtml
      );

      res.json({ success: true, message: `Report sent to ${email.trim()}` });
    } catch (error) {
      console.error('AgentMode: Email report to lead error:', error);
      res.status(500).json({ error: 'Failed to send report email' });
    }
  },

  // Upload file attachment for Agent Mode
  async uploadAttachment(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Upload to S3 using common utility
      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        user.userId,
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file to S3' });
      }

      res.json({
        url: uploadResult.url,
        key: uploadResult.key,
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload attachment error:', error);
      res.status(500).json({ error: 'Failed to upload attachment' });
    }
  },

  // Upload image directly to Agent Mode session
  async uploadImageToSession(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Validate that it's an image file
      if (!file.mimetype.startsWith('image/')) {
        return res.status(400).json({ error: 'File must be an image' });
      }

      // Verify session exists and belongs to user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Upload to S3 using common utility
      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        user.userId,
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file to S3' });
      }

      // Create a system message with toolCall metadata using upload_image
      // This structure matches what getExecutionsWithAssets expects
      const uploadedImageMessage = {
        role: 'system' as const,
        content: `Image uploaded: ${file.originalname}`,
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'agent' as const,
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              id: uuidv4(),
              name: 'upload_image',
              arguments: {},
              result: {
                success: true,
                imageUrl: uploadResult.url,
                filename: file.originalname,
                message: `✅ Image "${file.originalname}" uploaded successfully!`
              }
            }
          ]
        }
      };

      // Add message to session
      await chatbotDb.addMessageToSession(sessionId, uploadedImageMessage);

      res.json({
        success: true,
        message: 'Image uploaded successfully',
        url: uploadResult.url,
        filename: file.originalname,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload image to session error:', error);
      res.status(500).json({ error: 'Failed to upload image to session' });
    }
  },

  // Upload video directly to Agent Mode session
  async uploadVideoToSession(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Validate that it's a video file
      if (!file.mimetype.startsWith('video/')) {
        return res.status(400).json({ error: 'File must be a video' });
      }

      // Verify session exists and belongs to user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Upload to S3 using common utility
      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        user.userId,
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file to S3' });
      }

      // Create a system message with toolCall metadata using upload_video
      // This structure matches what getExecutionsWithAssets expects
      const uploadedVideoMessage = {
        role: 'system' as const,
        content: `Video uploaded: ${file.originalname}`,
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'agent' as const,
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              id: uuidv4(),
              name: 'upload_video',
              arguments: {},
              result: {
                success: true,
                videoUrl: uploadResult.url,
                filename: file.originalname,
                message: `✅ Video "${file.originalname}" uploaded successfully!`
              }
            }
          ]
        }
      };

      // Add message to session
      await chatbotDb.addMessageToSession(sessionId, uploadedVideoMessage);

      res.json({
        success: true,
        message: 'Video uploaded successfully',
        url: uploadResult.url,
        filename: file.originalname,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload video to session error:', error);
      res.status(500).json({ error: 'Failed to upload video to session' });
    }
  },

  // Create scheduled chat
  async createScheduledChat(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const {
        sessionId,
        scheduleName,
        description,
        startingMessage,
        scheduleFrequency,
        nextRunTime,
        keywords,
        requiredFunctionCalls,
        functionCallMinCalls,
        emailNotifications,
        emailCampaignTaskId,
        llmModel,
        runCount,
        variables,
        variableValues,
        frequencyIntervalDays,
        selfImprove,
        fullAutonomy,
        requirePublishApproval,
        timezone
      } = req.body;

      if (!scheduleName || !startingMessage || !scheduleFrequency) {
        const missing = [
          !scheduleName && 'scheduleName',
          !startingMessage && 'startingMessage',
          !scheduleFrequency && 'scheduleFrequency',
        ].filter(Boolean).join(', ');
        return res.status(400).json({ error: `Missing required fields: ${missing}` });
      }

      // Validate frequencyIntervalDays for every_n_days frequency
      if (scheduleFrequency === 'every_n_days') {
        if (frequencyIntervalDays === undefined || !Number.isInteger(frequencyIntervalDays) || frequencyIntervalDays < 1) {
          return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days' });
        }
      }

      // Validate runCount if provided
      if (runCount !== undefined) {
        if (!Number.isInteger(runCount) || (runCount !== -1 && runCount < 1)) {
          return res.status(400).json({ error: 'runCount must be -1 (unlimited) or a positive integer' });
        }
      }

      // ENG-844: an optional IANA timezone. Persisted so scheduled-run cadence
      // checks (e.g. "publish only Mon/Wed/Fri") are evaluated on the owner's local
      // calendar day rather than UTC. Reject a malformed value loudly rather than
      // silently storing garbage the cadence check would ignore.
      if (timezone !== undefined && !isValidIanaTimeZone(timezone)) {
        return res.status(400).json({ error: 'timezone must be a valid IANA timezone identifier (e.g. America/Los_Angeles)' });
      }

      // If sessionId is provided, verify it exists and belongs to user
      if (sessionId) {
        const session = await chatbotDb.getChatSession(sessionId);
        if (!session || session.userId !== user.userId) {
          return res.status(404).json({ error: 'Session not found' });
        }
      }

      // Create scheduled chat using the existing scheduleDb
      const scheduleId = require('uuid').v4();
      const now = new Date();

      // Use provided nextRunTime or calculate default
      let scheduledNextRunTime: string;
      if (nextRunTime) {
        // Validate the provided nextRunTime
        const providedDate = new Date(nextRunTime);
        if (isNaN(providedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid nextRunTime format' });
        }
        scheduledNextRunTime = providedDate.toISOString();
      } else {
        // Default behavior: calculate next run time (9 AM UTC = 1 AM PST)
        const calculatedTime = calculateNextRunTime(scheduleFrequency, now, frequencyIntervalDays);
        scheduledNextRunTime = calculatedTime.toISOString();
      }

      const scheduledChat: any = {
        scheduleId,
        taskId: sessionId || 'global', // Use sessionId if provided, otherwise 'global'
        userId: user.userId,
        frequency: scheduleFrequency, // Map scheduleFrequency to frequency
        ...(scheduleFrequency === 'every_n_days' && { frequencyIntervalDays }),
        scheduleName,
        description: description || '',
        startingMessage,
        keywords: keywords || [],
        requiredFunctionCalls: requiredFunctionCalls || [],
        functionCallMinCalls: functionCallMinCalls || {},
        emailNotifications: [] as string[],
        dailyDigest: scheduleFrequency === 'hourly' ? (req.body.dailyDigest || false) : false, // Only allow daily digest for hourly schedules
        selfImprove: selfImprove === true, // When on, a reflection turn after each run may improve the prompt
        // ENG-396: when on, a headless run auto-takes Emma's recommended option on a
        // blocking question (incl. immutable) instead of parking — an opt-in waiver
        // of the human gate on irreversible decisions. Default off.
        fullAutonomy: fullAutonomy === true,
        // ENG-803: owner opt-OUT that holds this schedule's runs at the publish step.
        // Default false = publish, which is what scheduled runs have always done, so
        // no existing schedule changes behaviour. Kept distinct from fullAutonomy
        // (consent to decide unaided is a different question from consent to post)
        // and absent from the manage_scheduled_chat MCP allowlist, so only a human
        // can set it.
        requirePublishApproval: requirePublishApproval === true,
        // ENG-844: owner's IANA timezone for cadence evaluation (omitted when the
        // client didn't send one — the cadence check then falls back to UTC).
        ...(isValidIanaTimeZone(timezone) ? { timezone } : {}),
        status: 'active',
        nextRunTime: scheduledNextRunTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        sessionId: sessionId || null, // Store original sessionId for reference (can be null)
        type: 'scheduled_chat', // Distinguish from regular task schedules
        emailCampaignTaskId: emailCampaignTaskId || null,
        llmModel: llmModel || '', // Empty means "use default at runtime"
        runCount: runCount !== undefined ? runCount : -1, // Default to unlimited runs if not specified
        variables: [] as ScheduledChatVariable[],
        variableValues: {} as Record<string, string>,
        variableRequestStatus: 'idle'
      };

      const { variables: normalizedVariables, error: variableError } =
        validateAndBuildScheduledChatVariables(startingMessage, variables);
      if (variableError) {
        return res.status(400).json({ error: variableError });
      }
      const normalizedVariableValues: Record<string, string> = {};
      if (normalizedVariables.length > 0 && variableValues && typeof variableValues === 'object') {
        normalizedVariables.forEach((variable) => {
          const rawValue = (variableValues as Record<string, unknown>)[variable.name];
          if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
            normalizedVariableValues[variable.name] = rawValue.trim();
          }
        });
      }

      // When no email is provided, fall back to the requester's email so LLMs don't need to
      // know this requirement. On delegate access use the admin's email (the person setting
      // up the schedule), not the target account's email.
      // Exception: variables are present and all pre-filled (silent run).
      const authReqForEmail = req as AuthenticatedRequest;
      const fallbackEmail = authReqForEmail.delegateInfo?.isDelegated
        ? authReqForEmail.delegateInfo.adminEmail
        : user.email;
      const allVariablesPrefilled = normalizedVariables.length > 0
        && getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length === 0;
      const normalizedEmails = normalizeEmailList(emailNotifications);
      const shouldUseFallbackEmail = normalizedEmails.length === 0 && !allVariablesPrefilled;
      scheduledChat.emailNotifications = shouldUseFallbackEmail ? [fallbackEmail] : normalizedEmails;
      scheduledChat.variables = normalizedVariables;
      scheduledChat.variableValues = normalizedVariableValues;
      scheduledChat.variableRequestStatus = normalizedVariables.length > 0
        ? (getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length > 0 ? 'pending' : 'provided')
        : 'idle';
      if (Object.keys(normalizedVariableValues).length > 0) {
        scheduledChat.variableValuesUpdatedAt = now.toISOString();
      }

      await scheduleDb.createSchedule(scheduledChat);

      res.status(201).json({
        scheduleId,
        message: 'Scheduled chat created successfully',
        nextRunTime: scheduledNextRunTime
      });
    } catch (error) {
      console.error('AgentMode: Create scheduled chat error:', error);
      res.status(500).json({ error: 'Failed to create scheduled chat' });
    }
  },

  // Get user's scheduled chats
  async getScheduledChats(req: Request, res: Response) {
    try {
      const user = req.user as User;

      // Get all schedules for the user and filter for scheduled chats
      const schedules = await scheduleDb.getSchedulesByUserId(user.userId);
      const scheduledChats = schedules?.filter(schedule =>
        schedule.type === 'scheduled_chat'
      ) || [];

      // Sort by creation time descending (newest first)
      scheduledChats.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });

      // Exclude runResults to keep response size manageable (run history is
      // available via the dedicated GET /scheduled-chats/:id/test-history endpoint),
      // but first derive a compact runHealth summary (ENG-826 #4) so the list can
      // flag consecutive failures on the card without fetching full history.
      const scheduledChatsWithHealth = scheduledChats.map(({ runResults, ...rest }: any) => ({
        ...rest,
        runHealth: computeScheduleRunHealth(runResults),
      }));

      res.json(scheduledChatsWithHealth);
    } catch (error) {
      console.error('AgentMode: Get scheduled chats error:', error);
      res.status(500).json({ error: 'Failed to get scheduled chats' });
    }
  },

  // Update scheduled chat
  async updateScheduledChat(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;
      const {
        scheduleName,
        description,
        startingMessage,
        scheduleFrequency,
        nextRunTime,
        keywords,
        requiredFunctionCalls,
        functionCallMinCalls,
        emailNotifications,
        dailyDigest,
        emailCampaignTaskId,
        llmModel,
        runCount,
        variables,
        variableValues,
        frequencyIntervalDays,
        selfImprove,
        fullAutonomy,
        requirePublishApproval,
        timezone
      } = req.body;

      // Verify schedule exists and belongs to user (before validation so we can merge)
      const existingSchedule = await scheduleDb.getScheduleById(scheduleId);
      if (!existingSchedule || existingSchedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      // Support partial updates: fall back to existing values for missing required fields
      const effectiveScheduleName = scheduleName || existingSchedule.scheduleName;
      const effectiveStartingMessage = startingMessage !== undefined ? startingMessage : existingSchedule.startingMessage;
      const effectiveScheduleFrequency = scheduleFrequency || existingSchedule.frequency;

      if (!effectiveScheduleName || !effectiveStartingMessage || !effectiveScheduleFrequency) {
        const missing = [
          !effectiveScheduleName && 'scheduleName',
          !effectiveStartingMessage && 'startingMessage',
          !effectiveScheduleFrequency && 'scheduleFrequency',
        ].filter(Boolean).join(', ');
        return res.status(400).json({ error: `Missing required fields: ${missing}` });
      }

      // Validate frequencyIntervalDays for every_n_days frequency
      const effectiveFrequencyIntervalDays = frequencyIntervalDays !== undefined ? frequencyIntervalDays : existingSchedule.frequencyIntervalDays;
      if (effectiveScheduleFrequency === 'every_n_days') {
        if (effectiveFrequencyIntervalDays === undefined || !Number.isInteger(effectiveFrequencyIntervalDays) || effectiveFrequencyIntervalDays < 1) {
          return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days' });
        }
      }

      // Validate runCount if provided
      if (runCount !== undefined) {
        if (!Number.isInteger(runCount) || (runCount !== -1 && runCount < 1)) {
          return res.status(400).json({ error: 'runCount must be -1 (unlimited) or a positive integer' });
        }
      }

      // ENG-844: validate an optional IANA timezone update (persisted for cadence).
      if (timezone !== undefined && !isValidIanaTimeZone(timezone)) {
        return res.status(400).json({ error: 'timezone must be a valid IANA timezone identifier (e.g. America/Los_Angeles)' });
      }

      const now = new Date();

      // Determine nextRunTime: use provided value or keep existing
      let scheduledNextRunTime = existingSchedule.nextRunTime;
      let shouldUpdateNextRunTime = false;
      if (nextRunTime) {
        const providedDate = new Date(nextRunTime);
        if (isNaN(providedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid nextRunTime format' });
        }
        scheduledNextRunTime = providedDate.toISOString();
        shouldUpdateNextRunTime = true;
      }

      // Update the schedule (merge with existing values for partial updates)
      const updates: any = {
        scheduleName: effectiveScheduleName,
        description: description !== undefined ? description : (existingSchedule.description || ''),
        startingMessage: effectiveStartingMessage,
        frequency: effectiveScheduleFrequency,
        ...(effectiveScheduleFrequency === 'every_n_days' && { frequencyIntervalDays: effectiveFrequencyIntervalDays }),
        keywords: keywords !== undefined ? keywords : (existingSchedule.keywords || []),
        requiredFunctionCalls: requiredFunctionCalls !== undefined ? requiredFunctionCalls : (existingSchedule.requiredFunctionCalls || []),
        functionCallMinCalls: functionCallMinCalls !== undefined ? functionCallMinCalls : (existingSchedule.functionCallMinCalls || {}),
        emailNotifications: normalizeEmailList(emailNotifications !== undefined ? emailNotifications : (existingSchedule.emailNotifications || [])),
        dailyDigest: effectiveScheduleFrequency === 'hourly' ? (dailyDigest !== undefined ? dailyDigest : (existingSchedule.dailyDigest || false)) : false,
        selfImprove: selfImprove !== undefined ? (selfImprove === true) : ((existingSchedule as any).selfImprove || false),
        // ENG-396: opt-in full autonomy (auto-take on blocking questions). Partial-update safe.
        fullAutonomy: fullAutonomy !== undefined ? (fullAutonomy === true) : ((existingSchedule as any).fullAutonomy || false),
        // ENG-803: owner opt-out from unattended publishing. Partial-update safe — an
        // update that omits the field must never silently set or clear it.
        requirePublishApproval: requirePublishApproval !== undefined
          ? (requirePublishApproval === true)
          : ((existingSchedule as any).requirePublishApproval || false),
        updatedAt: now.toISOString(),
        emailCampaignTaskId: emailCampaignTaskId !== undefined ? emailCampaignTaskId : (existingSchedule.emailCampaignTaskId || null),
        llmModel: llmModel !== undefined ? llmModel : (existingSchedule.llmModel || ''),
        // ENG-844: update the owner's timezone when a valid one is supplied; keep
        // the existing value otherwise (partial-update safe).
        ...(isValidIanaTimeZone(timezone)
          ? { timezone }
          : ((existingSchedule as any).timezone ? { timezone: (existingSchedule as any).timezone } : {})),
      };

      // Whenever the prompt actually changes, snapshot the PREVIOUS prompt into the
      // revision history so it can be reverted. This applies to every update path —
      // manual edits, Emma's manage_scheduled_chat tool, and self-improve. Keep the
      // most recent SCHEDULE_PROMPT_REVISION_LIMIT revisions only.
      const previousStartingMessage = existingSchedule.startingMessage || '';
      if (effectiveStartingMessage !== previousStartingMessage) {
        const existingRevisions = Array.isArray((existingSchedule as any).promptRevisions)
          ? (existingSchedule as any).promptRevisions as Array<{ startingMessage: string; updatedAt: string }>
          : [];
        const nextRevisions = [
          ...existingRevisions,
          { startingMessage: previousStartingMessage, updatedAt: now.toISOString() },
        ];
        updates.promptRevisions = nextRevisions.slice(-SCHEDULE_PROMPT_REVISION_LIMIT);
      }

      const { variables: normalizedVariables, error: variableError } =
        validateAndBuildScheduledChatVariables(effectiveStartingMessage, variables, existingSchedule.variables || []);
      if (variableError) {
        return res.status(400).json({ error: variableError });
      }
      const effectiveEmailNotifications = normalizeEmailList(
        emailNotifications !== undefined ? emailNotifications : (existingSchedule.emailNotifications || [])
      );
      updates.variables = normalizedVariables;

      // Preserve existing values for unchanged variables unless explicitly overwritten
      const existingValues = (existingSchedule.variableValues && typeof existingSchedule.variableValues === 'object')
        ? existingSchedule.variableValues as Record<string, string>
        : {};
      const normalizedVariableValues: Record<string, string> = {};

      normalizedVariables.forEach((variable) => {
        const incomingValue = variableValues && typeof variableValues === 'object'
          ? (variableValues as Record<string, unknown>)[variable.name]
          : undefined;

        if (typeof incomingValue === 'string') {
          const trimmed = incomingValue.trim();
          if (trimmed.length > 0) {
            normalizedVariableValues[variable.name] = trimmed;
          }
          return;
        }

        const existingValue = existingValues[variable.name];
        if (typeof existingValue === 'string' && existingValue.trim().length > 0) {
          normalizedVariableValues[variable.name] = existingValue.trim();
        }
      });

      // At least one email notification is always required for scheduled chats
      if (effectiveEmailNotifications.length === 0) {
        return res.status(400).json({ error: 'At least one email notification is required for scheduled chats' });
      }

      const allUpdateVariablesPrefilled = normalizedVariables.length > 0
        && getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length === 0;

      updates.variableValues = normalizedVariableValues;
      updates.variableRequestStatus = normalizedVariables.length > 0
        ? (getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length > 0 ? 'pending' : 'provided')
        : 'idle';
      if (Object.keys(normalizedVariableValues).length > 0) {
        updates.variableValuesUpdatedAt = now.toISOString();
      }

      // Re-saving with all values pre-filled means the schedule should use permanent defaults,
      // not the email request flow. Reset the flow state so subsequent runs don't wait for email.
      if (allUpdateVariablesPrefilled) {
        updates.variableRequestSentAt = '';
        updates.variableRequestAccessTokenHash = '';
        updates.variableRequestAccessTokenExpiresAt = '';
        updates.variableRequestAccessTokenConsumedAt = '';
      }

      // Only include nextRunTime in updates if it was explicitly provided
      if (shouldUpdateNextRunTime) {
        updates.nextRunTime = scheduledNextRunTime;
      }

      // Only include runCount in updates if it was explicitly provided
      if (runCount !== undefined) {
        updates.runCount = runCount;
      }

      await scheduleDb.updateSchedule(scheduleId, updates);

      res.json({
        message: 'Scheduled chat updated successfully',
        nextRunTime: scheduledNextRunTime
      });
    } catch (error) {
      console.error('AgentMode: Update scheduled chat error:', error);
      res.status(500).json({ error: 'Failed to update scheduled chat' });
    }
  },

  // Submit variable values for a scheduled chat
  async submitScheduledChatVariables(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;
      const { variableValues, triggerRun } = req.body as { variableValues?: Record<string, string>; triggerRun?: boolean };

      if (!variableValues || typeof variableValues !== 'object') {
        return res.status(400).json({ error: 'variableValues object is required' });
      }

      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      if (variables.length === 0) {
        return res.status(400).json({ error: 'This scheduled chat has no variables' });
      }

      const sanitizedValues: Record<string, string> = {};
      variables.forEach((variable) => {
        const rawValue = variableValues[variable.name];
        if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
          sanitizedValues[variable.name] = rawValue.trim();
        }
      });

      const missingVariableNames = getMissingScheduledChatVariableNames(variables, sanitizedValues);
      const nowIso = new Date().toISOString();

      await scheduleDb.updateSchedule(scheduleId, {
        variableValues: sanitizedValues,
        variableRequestStatus: missingVariableNames.length > 0 ? 'pending' : 'provided',
        variableValuesUpdatedAt: nowIso,
        variableRequestAccessTokenConsumedAt: nowIso,
        updatedAt: nowIso,
      });

      if (missingVariableNames.length === 0 && triggerRun !== false) {
        const scheduleToRun: any = {
          ...schedule,
          variableValues: sanitizedValues,
          variableRequestStatus: 'provided',
          variableValuesUpdatedAt: nowIso
        };

        // Track with the graceful-shutdown drain so a deploy/SIGTERM waits for
        // this in-flight run (incl. its requeue/persist catch) instead of
        // abandoning it mid-flight (ENG-324).
        trackScheduledRun(runScheduledChat(scheduleToRun, user.userId, false).then(async (result) => {
          if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
            try {
              await scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
                variableValues: {},
                variableRequestStatus: 'pending',
                updatedAt: new Date().toISOString()
              });
            } catch (clearError) {
              console.error(`Error clearing variable values after manual trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
            }
          }

          if (result.sessionId) {
            try {
              const emailNotifications = scheduleToRun.emailNotifications || [];
              if (emailNotifications.length > 0) {
                await emailService.sendScheduledChatResultEmail(
                  emailNotifications,
                  scheduleToRun.scheduleName,
                  result,
                  scheduleToRun.scheduleId,
                  result.summary
                );
              }
            } catch (emailError) {
              console.error('Error sending scheduled chat result email after manual trigger:', emailError);
            }
          }
        }).catch(async (runError) => {
          if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
            await scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
              variableValues: {},
              variableRequestStatus: 'pending',
              updatedAt: new Date().toISOString()
            }).catch((clearError) => {
              console.error(`Error clearing variable values after failed manual trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
            });
          }
          console.error(`Error triggering scheduled chat after variable submission for ${scheduleToRun.scheduleName}:`, runError);
        }));
      }

      res.json({
        message: missingVariableNames.length === 0
          ? (triggerRun === false
              ? 'Variable values saved.'
              : 'Variable values saved. Scheduled chat run started.')
          : 'Variable values saved, but some required variables are still missing.',
        missingVariables: missingVariableNames
      });
    } catch (error) {
      console.error('AgentMode: Submit scheduled chat variables error:', error);
      res.status(500).json({ error: 'Failed to submit scheduled chat variables' });
    }
  },

  // Public endpoint: view required variables by one-time access token (no login required)
  async getScheduledChatVariablesByAccessToken(req: Request, res: Response) {
    try {
      const { accessToken } = req.params;
      if (!accessToken || typeof accessToken !== 'string') {
        return res.status(400).json({ error: 'Access token is required' });
      }

      const tokenHash = hashScheduledChatVariableAccessToken(accessToken);
      const schedule = await scheduleDb.getScheduledChatByVariableAccessTokenHash(tokenHash);
      if (!schedule) {
        return res.status(404).json({ error: 'Invalid or expired variable request link' });
      }

      const nowMs = Date.now();
      const expiresAtMs = schedule.variableRequestAccessTokenExpiresAt
        ? new Date(schedule.variableRequestAccessTokenExpiresAt).getTime()
        : NaN;
      const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs < nowMs;
      if (isExpired) {
        return res.status(410).json({ error: 'This variable request link has expired' });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      const isCompleted = Boolean(schedule.variableRequestAccessTokenConsumedAt)
        || schedule.variableRequestStatus === 'provided';

      return res.json({
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.scheduleName || 'Scheduled Chat',
        variables,
        status: isCompleted ? 'completed' : 'pending',
        submittedAt: schedule.variableRequestAccessTokenConsumedAt || null,
        expiresAt: schedule.variableRequestAccessTokenExpiresAt || null,
      });
    } catch (error) {
      console.error('AgentMode: Get scheduled chat variables by access token error:', error);
      return res.status(500).json({ error: 'Failed to load variable request' });
    }
  },

  // Public endpoint: submit variables by one-time access token (no login required)
  async submitScheduledChatVariablesByAccessToken(req: Request, res: Response) {
    try {
      const { accessToken } = req.params;
      const { variableValues } = req.body as { variableValues?: Record<string, string> };

      if (!accessToken || typeof accessToken !== 'string') {
        return res.status(400).json({ error: 'Access token is required' });
      }
      if (!variableValues || typeof variableValues !== 'object') {
        return res.status(400).json({ error: 'variableValues object is required' });
      }

      const tokenHash = hashScheduledChatVariableAccessToken(accessToken);
      const schedule = await scheduleDb.getScheduledChatByVariableAccessTokenHash(tokenHash);
      if (!schedule) {
        return res.status(404).json({ error: 'Invalid or expired variable request link' });
      }

      const nowIso = new Date().toISOString();
      const expiresAtMs = schedule.variableRequestAccessTokenExpiresAt
        ? new Date(schedule.variableRequestAccessTokenExpiresAt).getTime()
        : NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
        return res.status(410).json({ error: 'This variable request link has expired' });
      }

      if (schedule.variableRequestAccessTokenConsumedAt) {
        return res.status(409).json({
          error: 'This variable request link has already been used',
          status: 'completed',
          submittedAt: schedule.variableRequestAccessTokenConsumedAt
        });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      if (variables.length === 0) {
        return res.status(400).json({ error: 'This scheduled chat has no variables' });
      }

      const sanitizedValues: Record<string, string> = {};
      variables.forEach((variable) => {
        const rawValue = variableValues[variable.name];
        if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
          sanitizedValues[variable.name] = rawValue.trim();
        }
      });

      const missingVariableNames = getMissingScheduledChatVariableNames(variables, sanitizedValues);
      if (missingVariableNames.length > 0) {
        return res.status(400).json({
          error: 'Missing values for required variables',
          missingVariables: missingVariableNames
        });
      }

      await scheduleDb.updateSchedule(schedule.scheduleId, {
        variableValues: sanitizedValues,
        variableRequestStatus: 'provided',
        variableValuesUpdatedAt: nowIso,
        variableRequestAccessTokenConsumedAt: nowIso,
        updatedAt: nowIso,
      });

      const scheduleToRun: any = {
        ...schedule,
        variableValues: sanitizedValues,
        variableRequestStatus: 'provided',
        variableValuesUpdatedAt: nowIso
      };

      // Track with the graceful-shutdown drain so a deploy/SIGTERM waits for
      // this in-flight run (incl. its requeue/persist catch) instead of
      // abandoning it mid-flight (ENG-324).
      trackScheduledRun(runScheduledChat(scheduleToRun, schedule.userId, false).then(async (result) => {
        if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
          try {
            await scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
              variableValues: {},
              variableRequestStatus: 'pending',
              updatedAt: new Date().toISOString()
            });
          } catch (clearError) {
            console.error(`Error clearing variable values after public trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
          }
        }

        if (result.sessionId) {
          try {
            const emailNotifications = scheduleToRun.emailNotifications || [];
            if (emailNotifications.length > 0) {
              await emailService.sendScheduledChatResultEmail(
                emailNotifications,
                scheduleToRun.scheduleName,
                result,
                scheduleToRun.scheduleId,
                result.summary
              );
            }
          } catch (emailError) {
            console.error('Error sending scheduled chat result email after public variable submit:', emailError);
          }
        }
      }).catch(async (runError) => {
        if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
          await scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
            variableValues: {},
            variableRequestStatus: 'pending',
            updatedAt: new Date().toISOString()
          }).catch((clearError) => {
            console.error(`Error clearing variable values after failed public trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
          });
        }
        console.error(`Error triggering scheduled chat after public variable submission for ${scheduleToRun.scheduleName}:`, runError);
      }));

      return res.json({
        message: 'Variable values submitted successfully. Scheduled chat run started.',
        status: 'completed',
        submittedAt: nowIso
      });
    } catch (error) {
      console.error('AgentMode: Submit scheduled chat variables by access token error:', error);
      return res.status(500).json({ error: 'Failed to submit variable values' });
    }
  },

  // Public endpoint: upload a file for a file-type variable (no login required, access token validates)
  async uploadScheduledChatVariableFile(req: Request, res: Response) {
    try {
      const { accessToken } = req.params;
      if (!accessToken || typeof accessToken !== 'string') {
        return res.status(400).json({ error: 'Access token is required' });
      }

      const tokenHash = hashScheduledChatVariableAccessToken(accessToken);
      const schedule = await scheduleDb.getScheduledChatByVariableAccessTokenHash(tokenHash);
      if (!schedule) {
        return res.status(404).json({ error: 'Invalid or expired variable request link' });
      }

      const expiresAtMs = schedule.variableRequestAccessTokenExpiresAt
        ? new Date(schedule.variableRequestAccessTokenExpiresAt).getTime()
        : NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
        return res.status(410).json({ error: 'This variable request link has expired' });
      }

      if (schedule.variableRequestAccessTokenConsumedAt) {
        return res.status(409).json({ error: 'This variable request link has already been used' });
      }

      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        schedule.userId,
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file' });
      }

      return res.json({
        url: uploadResult.url,
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
      });
    } catch (error) {
      console.error('AgentMode: Public variable file upload error:', error);
      return res.status(500).json({ error: 'Failed to upload file' });
    }
  },

  async testScheduledChat(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;

      // Verify schedule exists and belongs to user
      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      const variableValues = (schedule.variableValues && typeof schedule.variableValues === 'object')
        ? schedule.variableValues as Record<string, string>
        : {};
      const missingVariables = getMissingScheduledChatVariableNames(variables, variableValues);
      if (variables.length > 0 && missingVariables.length > 0) {
        return res.status(400).json({
          error: 'Missing variable values for scheduled chat',
          missingVariables
        });
      }

      // Generate runId upfront so the agent can poll for this specific result
      const runId = require('uuid').v4();
      const { sendNotificationEmail } = req.body || {};

      // Fire-and-forget: run in background so the HTTP request doesn't time out
      // for complex tasks that take many minutes (e.g. scraping 13+ web pages).
      // The agent should poll get_scheduled_chat_test_history to see the result.
      const backgroundRun = async () => {
        const result = await runScheduledChat(schedule, user.userId, true, runId);

        if (sendNotificationEmail && result.sessionId) {
          try {
            const emailNotifications = schedule.emailNotifications || [];
            if (emailNotifications.length > 0) {
              await emailService.sendScheduledChatResultEmail(
                emailNotifications,
                schedule.scheduleName,
                result,
                schedule.scheduleId,
                result.summary
              );
            }
          } catch (emailError) {
            console.error('AgentMode: Failed to send test notification email:', emailError);
          }
        }
      };
      backgroundRun().catch(err => {
        console.error('AgentMode: Background test run error:', err);
        const { reportUIError } = require('../utils/errorReporter');
        reportUIError({
          operation: 'schedule-manual-run',
          errorMessage: err?.message || String(err),
          userId: user.userId,
          context: {
            'Schedule ID': scheduleId,
            'Schedule Name': schedule.scheduleName || 'unknown',
            'Run ID': runId,
          },
        }).catch((reportErr: Error) => console.error('errorReporter failed:', reportErr));
      });

      res.json({
        runId,
        status: 'pending',
        message: 'Test run started in background. Poll get_scheduled_chat_test_history to check results.'
      });

    } catch (error) {
      console.error('AgentMode: Test scheduled chat error:', error);
      res.status(500).json({ error: 'Failed to test scheduled chat' });
    }
  },

  async toggleScheduledChatStatus(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;
      const { status } = req.body;

      if (!status || !['active', 'paused'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be "active" or "paused"' });
      }

      // Verify schedule exists and belongs to user
      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      // Update the schedule status
      await scheduleDb.updateSchedule(scheduleId, {
        status,
        updatedAt: new Date().toISOString()
      });

      res.json({ message: `Scheduled chat ${status === 'active' ? 'enabled' : 'paused'} successfully` });

    } catch (error) {
      console.error('AgentMode: Toggle scheduled chat status error:', error);
      res.status(500).json({ error: 'Failed to toggle scheduled chat status' });
    }
  },

  async deleteScheduledChat(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;

      // Verify schedule exists and belongs to user
      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      // Delete the schedule
      await scheduleDb.deleteSchedule(scheduleId);

      res.json({ message: 'Scheduled chat deleted successfully' });
    } catch (error) {
      console.error('AgentMode: Delete scheduled chat error:', error);
      res.status(500).json({ error: 'Failed to delete scheduled chat' });
    }
  },

  async getScheduledChatTestHistory(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;

      // Verify schedule exists and belongs to user
      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      // Get test history
      const testHistory = await scheduleDb.getRunResults(scheduleId);

      // ENG-446: hand every consumer the canonical marketing-action list the run
      // itself selected — same ids, same order, empty for legacy runs that carry
      // none. Consumers render this; they never re-rank or regenerate it.
      // Arrays are excluded deliberately: spreading one into an object literal
      // would silently turn it into {0: …, 1: …}. A malformed entry passes
      // through untouched rather than being corrupted into a wrong answer.
      const historyWithActions = (testHistory || []).map((run: any) =>
        run !== null && typeof run === 'object' && !Array.isArray(run)
          ? normalizeMarketingActions(run)
          : run
      );

      res.json(historyWithActions);
    } catch (error) {
      console.error('AgentMode: Get test history error:', error);
      res.status(500).json({ error: 'Failed to get test history' });
    }
  },

  async sendScheduledChatTestEmail(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId, runId } = req.params as { scheduleId: string; runId: string };
      const { toEmail } = req.body as { toEmail: string };

      if (!toEmail) {
        return res.status(400).json({ error: 'toEmail is required' });
      }

      // Verify schedule exists and belongs to user
      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      // Load test history and find the record
      const testHistory = await scheduleDb.getRunResults(scheduleId);
      const record = (testHistory || []).find((r: any) => r.runId === runId);
      if (!record) {
        return res.status(404).json({ error: 'Test record not found' });
      }

      // Check if this is an hourly schedule with daily digest enabled
      if (schedule.frequency === 'hourly' && schedule.dailyDigest) {
        // For hourly schedules with daily digest, send a daily digest email
        // Get all run results for the same date as the selected test entry
        const selectedResultDate = new Date(record.createdAt);
        const startOfDay = new Date(Date.UTC(selectedResultDate.getUTCFullYear(), selectedResultDate.getUTCMonth(), selectedResultDate.getUTCDate()));
        const endOfDay = new Date(Date.UTC(selectedResultDate.getUTCFullYear(), selectedResultDate.getUTCMonth(), selectedResultDate.getUTCDate() + 1));

        const sameDayResultsRaw = testHistory.filter((result: any) => {
          const resultDate = new Date(result.createdAt);
          return resultDate >= startOfDay && resultDate < endOfDay;
        });

        // Reconstruct actualResponse for results that don't have it (only needed for email)
        const sameDayResults = await Promise.all(
          sameDayResultsRaw.map(async (result: any) => {
            if (!result.actualResponse && result.sessionId) {
              const actualResponse = await getActualResponseFromSession(result.sessionId);
              return { ...result, actualResponse };
            }
            return result;
          })
        );

        if (sameDayResults.length > 0) {
          // Send daily digest email for the specific date
          await emailService.sendDailyDigestEmail(
            [toEmail],
            schedule.scheduleName,
            sameDayResults,
            schedule.scheduleId,
            selectedResultDate
          );

          const dateStr = selectedResultDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });

          res.json({
            success: true,
            message: `Daily digest email sent with all results from ${dateStr}`,
            resultCount: sameDayResults.length,
            date: dateStr
          });
          return;
        }
      }

      // For non-hourly schedules or hourly without daily digest, send individual email
      // Reconstruct actualResponse from session if missing
      let actualResponse = record.actualResponse || record.response || '';
      if ((!actualResponse || actualResponse.trim().length === 0) && record.sessionId) {
        actualResponse = await getActualResponseFromSession(record.sessionId);
      }
      
      // Build a result object compatible with emailService
      const resultForEmail = {
        passed: !!record.passed,
        actualResponse: actualResponse || 'Response not available. View the conversation to see the full response.',
        keywordMatches: record.keywordMatches || [],
        keywordMisses: record.keywordMisses || [],
        functionCallMatches: record.functionCallMatches || [],
        functionCallMisses: record.functionCallMisses || [],
        executionTime: record.executionTime || 0,
        sessionId: record.sessionId,
        attempt: record.attempt || 1,
        createdAt: record.createdAt || new Date().toISOString(),
      };

      const runSummary: string | undefined = record.summary;

      await emailService.sendScheduledChatResultEmail(
        [toEmail],
        schedule.scheduleName,
        resultForEmail,
        schedule.scheduleId,
        runSummary
      );

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Send scheduled chat test email error:', error);
      res.status(500).json({ error: 'Failed to send test email' });
    }
  },

  async runScheduledChats(req: Request, res: Response) {
    // Reject immediately when this instance is draining — the agent-engine will
    // retry in 5 seconds and the ALB will route that call to the new instance.
    if (!isCronEnabled()) {
      return res.status(503).json({ message: 'Instance draining — retry on new instance' });
    }

    try {
      // Get all scheduled chats that are ready to run
      const scheduledChats = await scheduleDb.getSchedulesReadyToRun();

      if (scheduledChats.length === 0) {
        return res.json({
          message: 'No scheduled chats ready to run',
          processed: 0,
          results: []
        });
      }

      // Get max concurrent runs from environment (default 5)
      const maxConcurrentRuns = process.env.MAX_CONCURRENT_RUNS ? parseInt(process.env.MAX_CONCURRENT_RUNS) : 5;

      // Track concurrent runs
      let currentConcurrentRuns = 0;
      const results = [];

      for (const schedule of scheduledChats) {
        try {
          const now = new Date();
          const scheduleVariables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
          const scheduleVariableValues = (schedule.variableValues && typeof schedule.variableValues === 'object')
            ? schedule.variableValues as Record<string, string>
            : {};
          const missingVariableNames = getMissingScheduledChatVariableNames(scheduleVariables, scheduleVariableValues);
          const hasAllVariableValues = missingVariableNames.length === 0;
          const hasVariableRequestSentAt = typeof schedule.variableRequestSentAt === 'string' && schedule.variableRequestSentAt.length > 0;
          const hasVariableValuesUpdatedAt = typeof schedule.variableValuesUpdatedAt === 'string' && schedule.variableValuesUpdatedAt.length > 0;
          const hasLastRunTime = typeof schedule.lastRunTime === 'string' && schedule.lastRunTime.length > 0;
          const variableRequestSentAtMs = hasVariableRequestSentAt ? new Date(schedule.variableRequestSentAt).getTime() : NaN;
          const variableValuesUpdatedAtMs = hasVariableValuesUpdatedAt ? new Date(schedule.variableValuesUpdatedAt).getTime() : NaN;
          const lastRunTimeMs = hasLastRunTime ? new Date(schedule.lastRunTime).getTime() : NaN;
          const valuesProvidedAfterLatestRequest = Number.isFinite(variableRequestSentAtMs)
            && Number.isFinite(variableValuesUpdatedAtMs)
            && variableValuesUpdatedAtMs >= variableRequestSentAtMs;
          const valuesProvidedAfterLastRun = !Number.isFinite(lastRunTimeMs)
            || (Number.isFinite(variableValuesUpdatedAtMs) && variableValuesUpdatedAtMs > lastRunTimeMs);
          // Pre-filled defaults (no email request ever sent) are valid for all runs.
          // variableValuesUpdatedAt guards against legacy records missing timestamps.
          const prefilledWithoutRequest = !hasVariableRequestSentAt && hasVariableValuesUpdatedAt;
          const isVariableRequestSatisfied = schedule.variableRequestStatus === 'provided'
            && hasAllVariableValues
            && (prefilledWithoutRequest || (valuesProvidedAfterLatestRequest && valuesProvidedAfterLastRun));

          // Calculate next run based on the current nextRunTime to preserve the scheduled time
          const currentNextRun = new Date(schedule.nextRunTime);
          const nextRunTime = calculateNextRunTime(schedule.frequency, currentNextRun, schedule.frequencyIntervalDays);

          if (scheduleVariables.length > 0 && !isVariableRequestSatisfied) {
            const requestedVariableNames = missingVariableNames.length > 0
              ? missingVariableNames
              : scheduleVariables.map(variable => variable.name);
            const variableAccessToken = crypto.randomBytes(32).toString('hex');
            const variableAccessTokenHash = hashScheduledChatVariableAccessToken(variableAccessToken);
            const variableAccessTokenExpiresAtDate = new Date(nextRunTime.getTime() - (30 * 60 * 1000));
            const variableAccessTokenExpiresAt = variableAccessTokenExpiresAtDate.toISOString();
            const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
            const variableInputUrl = `${customerFrontendUrl}/scheduled-chat/variables/${variableAccessToken}`;

            // Advance next run immediately. This run window is now waiting for variable submission.
            await scheduleDb.updateScheduleAfterRun(
              schedule.scheduleId,
              now.toISOString(),
              nextRunTime.toISOString(),
              true
            );

            await scheduleDb.updateSchedule(schedule.scheduleId, {
              updatedAt: now.toISOString(),
              variableRequestStatus: 'pending',
              variableRequestSentAt: now.toISOString(),
              variableRequestAccessTokenHash: variableAccessTokenHash,
              variableRequestAccessTokenExpiresAt: variableAccessTokenExpiresAt,
              variableRequestAccessTokenConsumedAt: ''
            });

            try {
              const user = await userDb.getUserById(schedule.userId);
              const emailNotifications = schedule.emailNotifications || [];
              const recipients = emailNotifications.length > 0 ? emailNotifications : (user?.email ? [user.email] : []);

              if (recipients.length > 0) {
                await emailService.sendScheduledChatVariableRequestEmail(
                  recipients,
                  schedule.scheduleName,
                  schedule.scheduleId,
                  scheduleVariables.filter(variable => requestedVariableNames.includes(variable.name)),
                  variableInputUrl,
                  variableAccessTokenExpiresAt
                );
              } else {
                console.log(`No recipients configured for variable request on schedule ${schedule.scheduleName}`);
              }
            } catch (error) {
              console.error(`Error sending variable request email for schedule ${schedule.scheduleName}:`, error);
            }

            results.push({
              scheduleId: schedule.scheduleId,
              scheduleName: schedule.scheduleName,
              status: 'waiting_for_variables',
              nextRunTime: nextRunTime.toISOString(),
              variableRequestExpiresAt: variableAccessTokenExpiresAt,
              missingVariables: requestedVariableNames
            });

            continue;
          }

          // Check if we've reached the concurrent run limit
          if (currentConcurrentRuns >= maxConcurrentRuns) {
            // Delay the run for half an hour
            const delayedRunTime = new Date(now);
            delayedRunTime.setMinutes(delayedRunTime.getMinutes() + 30);

            // Update the schedule with delayed run time
            // Don't decrement runCount since this run hasn't actually happened
            await scheduleDb.updateScheduleAfterRun(
              schedule.scheduleId,
              schedule.lastRunTime || now.toISOString(),
              delayedRunTime.toISOString(),
              false // Don't decrement runCount for delayed runs
            );

            console.log(`Delayed scheduled chat ${schedule.scheduleName} for 30 minutes due to concurrent run limit (${maxConcurrentRuns})`);

            results.push({
              scheduleId: schedule.scheduleId,
              scheduleName: schedule.scheduleName,
              status: 'delayed',
              nextRunTime: delayedRunTime.toISOString(),
              reason: `Delayed due to concurrent run limit (${maxConcurrentRuns})`
            });

            continue;
          }

          // Update the schedule with next run time FIRST (synchronously)
          // This prevents agent-engine from repeatedly calling the same schedule

          // Decrement runCount and auto-pause if it reaches 0
          // Note: Both successful and failed runs count toward the run limit
          await scheduleDb.updateScheduleAfterRun(
            schedule.scheduleId,
            now.toISOString(),
            nextRunTime.toISOString(),
            true // Decrement runCount (default behavior)
          );

          // Increment concurrent run counter
          currentConcurrentRuns++;

          // Only clear variable values if the user submitted them via the email link
          // (token consumed). Config-time defaults and admin-updated values persist forever.
          const accessTokenWasConsumed = typeof schedule.variableRequestAccessTokenConsumedAt === 'string' && schedule.variableRequestAccessTokenConsumedAt.length > 0;
          const shouldClearVariablesAfterRun = hasVariableRequestSentAt && accessTokenWasConsumed;

          // Start the scheduled chat run asynchronously (don't await).
          // Track with the graceful-shutdown drain so a deploy/SIGTERM waits for
          // this in-flight run (incl. its requeue/persist catch) instead of
          // abandoning it mid-flight — which left the session with only a kickoff
          // message, no assistant output, and no run result (ENG-324).
          trackScheduledRun(runScheduledChat(schedule, schedule.userId, false).then(async (result) => {
            // Decrement concurrent run counter when done
            currentConcurrentRuns--;
            if (scheduleVariables.length > 0 && shouldClearVariablesAfterRun) {
              try {
                await scheduleDb.updateSchedule(schedule.scheduleId, {
                  variableValues: {},
                  variableRequestStatus: 'pending',
                  updatedAt: new Date().toISOString()
                });
              } catch (error) {
                console.error(`Error clearing variable values for schedule ${schedule.scheduleName}:`, error);
              }
            }

            // Send email notification with the result (only if it actually ran, not if it was blocked)
            // If result.sessionId is empty, it means the run was blocked due to subscription restrictions
            if (result.sessionId) {
              try {
                // Only send emails if email notifications are specified
                const emailNotifications = schedule.emailNotifications || [];
                if (emailNotifications.length > 0) {
                  // Check if this is an hourly schedule with daily digest enabled
                  if (schedule.frequency === 'hourly' && schedule.dailyDigest) {
                    // Check if this is the last run of the day
                    const now = new Date();
                    const nextRunTime = calculateNextRunTime('hourly', now);
                    const isLastRunOfDay = isLastRunOfDayForHourlySchedule(now, nextRunTime);

                    if (isLastRunOfDay) {
                      // Send daily digest instead of individual email
                      await sendDailyDigestEmail(schedule, emailNotifications);
                    }
                    // For hourly schedules with daily digest, don't send individual emails
                    // Only send the daily digest on the last run of the day
                  } else {
                    // Send individual email as usual for non-hourly schedules or hourly without daily digest
                    await emailService.sendScheduledChatResultEmail(
                      emailNotifications,
                      schedule.scheduleName,
                      result,
                      schedule.scheduleId,
                      result.summary
                    );
                  }
                } else {
                  console.log(`No email notifications configured for schedule ${schedule.scheduleName}, skipping email send`);
                }
              } catch (error) {
                console.error('Error sending scheduled chat result email:', error);
                // Don't throw error - email failure shouldn't break the scheduled chat execution
              }
            }
            // If result.sessionId is empty, the error email was already sent in runScheduledChat
          }).catch(async (error) => {
            // Decrement concurrent run counter on error
            currentConcurrentRuns--;

            if (scheduleVariables.length > 0 && shouldClearVariablesAfterRun) {
              scheduleDb.updateSchedule(schedule.scheduleId, {
                variableValues: {},
                variableRequestStatus: 'pending',
                updatedAt: new Date().toISOString()
              }).catch((updateError) => {
                console.error(`Error clearing variable values after failed run for schedule ${schedule.scheduleName}:`, updateError);
              });
            }

            console.error(`Error running scheduled chat ${schedule.scheduleName}:`, error);
            // Log the full error details for debugging
            console.error('Full error details:', {
              message: error.message,
              stack: error.stack,
              name: error.name
            });

            // Save failure run result to database so it's visible in the UI
            const errorResult = {
              scheduleId: schedule.scheduleId,
              runId: require('uuid').v4(),
              status: 'failure' as const,
              passed: false,
              actualResponse: `Scheduled chat runtime error: ${error.message || 'Unknown error'}`,
              actualFunctionCalls: [],
              keywordMatches: [],
              keywordMisses: [],
              functionCallMatches: [],
              functionCallMisses: [],
              executionTime: 0,
              sessionId: '',
              attempt: 0,
              createdAt: new Date().toISOString()
            };

            await scheduleDb.addRunResult(schedule.scheduleId, errorResult).catch((saveError) => {
              console.error(`Error saving failure run result for schedule ${schedule.scheduleName}:`, saveError);
            });

            // Send oncall alert for unhandled scheduled chat error (safety net)
            await sendAgentModeOncallAlert({
              subject: `Scheduled Chat Unhandled Error: ${schedule.scheduleName}`,
              message: `Scheduled chat "${schedule.scheduleName}" failed with an unhandled error in the fire-and-forget handler.\n\nError: ${error.message || 'Unknown error'}`,
              context: {
                'Schedule ID': schedule.scheduleId,
                'Schedule Name': schedule.scheduleName,
                'User ID': schedule.userId,
                'Error Message': error.message || 'Unknown error',
                'Error Stack': error.stack || 'No stack trace',
                'Timestamp': new Date().toISOString()
              }
            }).catch(err => console.error('Failed to send oncall alert for unhandled scheduled chat error:', err));

            // Send error notification email
            const emailNotifications = schedule.emailNotifications || [];
            if (emailNotifications.length > 0) {
              await import('../services/emailService').then(({ emailService }) => {
                return emailService.sendScheduledChatResultEmail(
                  emailNotifications,
                  schedule.scheduleName,
                  errorResult,
                  schedule.scheduleId
                ).catch((emailError) => {
                  console.error(`Error sending failure email for schedule ${schedule.scheduleName}:`, emailError);
                });
              }).catch((importError) => {
                console.error('Error importing emailService:', importError);
              });
            }
          }));

          results.push({
            scheduleId: schedule.scheduleId,
            scheduleName: schedule.scheduleName,
            status: 'started',
            nextRunTime: nextRunTime.toISOString()
          });

        } catch (error) {
          console.error(`Error processing schedule ${schedule.scheduleName}:`, error);

          results.push({
            scheduleId: schedule.scheduleId,
            scheduleName: schedule.scheduleName,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      res.json({
        message: `Processed ${scheduledChats.length} scheduled chats`,
        processed: scheduledChats.length,
        results: results
      });

    } catch (error) {
      console.error('AgentMode: Run scheduled chats error:', error);
      res.status(500).json({ error: 'Failed to run scheduled chats' });
    }
  },

  // Get session for conversable access
  async getConversableSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const session = (req as any).conversableSession;

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Use session's llmModel if available, otherwise use default
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      res.json({
        sessionId: session.sessionId,
        title: session.title,
        messages: filterMessagesForClient(session.messages),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        workPlan: session.workPlan,
        llmModel: modelToUse,
        isConversable: true
      });
    } catch (error) {
      console.error('AgentMode: Get conversable session error:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  },

  // Generate response for conversable session
  async generateConversableResponse(req: Request, res: Response) {
    try {
      const { userMessage, attachments } = req.body;
      const session = (req as any).conversableSession;

      if (!userMessage) {
        return res.status(400).json({ error: 'User message is required' });
      }

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Use session's llmModel if available, otherwise use default
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Cancel generation immediately when the client disconnects
      req.on('close', () => {
        if (!res.headersSent) {
          console.log(`AgentMode: Client disconnected for conversable session ${session.sessionId} — signalling cancellation`);
          requestCancel(session.sessionId);
          generateMarketingResponseWorkerService.cancelSession(session.sessionId);
        }
      });

      // Generate AI response using the same function as regular users
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId, // Use the original session owner's userId
        modelToUse,
        attachments
      );

      markProgressComplete(session.sessionId);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills,
        ...(response.backupModelUsed ? { backupModelUsed: true, originalModel: response.originalModel, backupModel: response.backupModel } : {})
      });
    } catch (error) {
      console.error('AgentMode: Generate conversable response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const convSessionId = req.params?.shareId;
      if (convSessionId) {
        markProgressComplete(convSessionId);
      }

      // Handle specific error types (same as generateResponse)
      if (error instanceof Error) {
        if (error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
          res.status(413).json({
            error: 'Session size limit exceeded',
            message: 'Please start a new session to continue the conversation.',
            code: 'SESSION_SIZE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('MESSAGE_TOO_LARGE')) {
          res.status(413).json({
            error: 'Message too large',
            message: 'The message content is too large to be saved. Please try with shorter content.',
            code: 'MESSAGE_TOO_LARGE',
            suggestion: 'shorten_content'
          });
          return;
        }

        if (error.message.includes('content policies') || error.message.includes('violate content policies') || error.message.includes('content management policy') || error.message.includes('content_filter')) {
          res.status(400).json({
            error: 'Content policy violation',
            message: error.message,
            code: 'CONTENT_FILTER',
            suggestion: 'rephrase_message'
          });
          return;
        }

        if (error.message.includes('high demand')) {
          res.status(429).json({
            error: 'Rate limit exceeded',
            message: error.message,
            code: 'RATE_LIMIT',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (isWorkerShutdownError(error)) {
          res.status(503).json({
            error: 'Server is restarting',
            message: 'The server is restarting. Please try again in a moment.',
            code: 'SERVER_RESTARTING',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (error.message.includes('Generation timed out')) {
          res.status(504).json({
            error: 'Generation timed out',
            message: 'The response took too long to generate. Please try again — your session is still active.',
            code: 'GENERATION_TIMEOUT',
            suggestion: 'wait_and_retry'
          });
          return;
        }
      }

      res.status(500).json({ error: 'Failed to generate response' });
    }
  },

  // Get all predefined work plans (public + user's own private, deduped by title) — reads from AW-WorkPlans table
  async getAllPredefinedWorkPlans(req: Request, res: Response) {
    try {
      const publicPlans = await workPlanService.getPublicPlansForAgentMode();

      // If user is authenticated, include their own private plans + org members' private plans
      let userPrivatePlans: any[] = [];
      const result = await getUserFromToken(req);
      if (result.user) {
        const user = await userDb.getUserById(result.user.userId);
        const [ownPlans, orgPlans] = await Promise.all([
          workPlanService.getWorkPlansByOwner(result.user.userId),
          user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
        ]);
        const seen = new Set<string>();
        for (const p of [...ownPlans, ...orgPlans]) {
          if (p.visibility === 'private' && !seen.has(p.planId)) {
            seen.add(p.planId);
            userPrivatePlans.push(p);
          }
        }
      }

      // Map to legacy shape expected by customer portal (uses 'id' not 'planId')
      const mapPlan = (p: any) => ({
        id: p.planId,
        title: p.title,
        description: p.description,
        welcomeMessage: p.welcomeMessage,
        autocomplete: p.autocomplete || false,
        requireLogin: p.requireLogin || false,
        showLoginSignup: p.showLoginSignup || 'after_plan_completed',
        showInAgentMode: p.showInAgentMode !== false,
        defaultModel: p.defaultModel,
        category: p.category,
        steps: p.steps,
        visibility: p.visibility,
        thumbnail_url: p.thumbnail_url,
        thumbnail_alt_text: p.thumbnail_alt_text,
      });

      // Put private plans first, then public — deduplicate by title so user's
      // private plan takes priority over a system/public plan with the same title
      const allPlans = [...userPrivatePlans.map(mapPlan), ...publicPlans.map(mapPlan)];
      const seen = new Set<string>();
      const deduped = allPlans.filter(p => {
        const key = p.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      res.json(deduped);
    } catch (error) {
      console.error('AgentMode: Get all predefined work plans error:', error);
      res.status(500).json({ error: 'Failed to get all predefined work plans' });
    }
  },

  // Get predefined work plan by title (public + user's private) — reads from AW-WorkPlans table
  async getPredefinedWorkPlan(req: Request, res: Response) {
    try {
      const { planTitle } = req.params;

      if (!planTitle) {
        return res.status(400).json({ error: 'Plan title is required' });
      }

      // Load system + public plans from AW-WorkPlans table
      const [systemPlans, publicPlans] = await Promise.all([
        workPlanService.getWorkPlansByVisibility('system'),
        workPlanService.getWorkPlansByVisibility('public'),
      ]);
      // Put user's private plans FIRST so they take priority over system/public plans with same title
      const result = await getUserFromToken(req);
      const allPlans: any[] = [];
      if (result.user) {
        const user = await userDb.getUserById(result.user.userId);
        const [ownPlans, orgPlans] = await Promise.all([
          workPlanService.getWorkPlansByOwner(result.user.userId),
          user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
        ]);
        const seen = new Set<string>();
        for (const p of [...ownPlans, ...orgPlans]) {
          if (p.visibility === 'private' && !seen.has(p.planId)) {
            seen.add(p.planId);
            allPlans.push(p);
          }
        }
      }
      allPlans.push(...systemPlans, ...publicPlans);

      // Find work plan with matching title (case-insensitive) — private plans checked first
      const workPlan = allPlans.find((wp) =>
        wp.title && wp.title.toLowerCase() === planTitle.toLowerCase()
      );

      if (!workPlan) {
        return res.status(404).json({ error: `Work plan "${planTitle}" not found` });
      }

      // Enforce ownership/org-membership for private plans
      if (workPlan.visibility === 'private' && !result.user) {
        return res.status(403).json({ error: 'Not authorized to view this private work plan' });
      }

      res.json({
        id: workPlan.planId,
        title: workPlan.title,
        description: workPlan.description,
        welcomeMessage: workPlan.welcomeMessage,
        autocomplete: workPlan.autocomplete || false,
        requireLogin: workPlan.requireLogin || false,
        showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
        showInAgentMode: workPlan.showInAgentMode !== false,
        defaultModel: workPlan.defaultModel,
        steps: workPlan.steps,
        visibility: workPlan.visibility,
      });
    } catch (error) {
      console.error('AgentMode: Get predefined work plan error:', error);
      res.status(500).json({ error: 'Failed to get predefined work plan' });
    }
  },

  // Create session with predefined work plan (public) — reads from AW-WorkPlans table
  async createSessionWithPlan(req: Request, res: Response) {
    try {
      const { planTitle } = req.params;
      const { startingMessage } = req.body || {};

      if (!planTitle) {
        return res.status(400).json({ error: 'Plan title is required' });
      }

      // Check if user is authenticated (optional - route is public)
      const result = await getUserFromToken(req);
      const userId = result.user ? result.user.userId : `anon_${uuidv4()}`;

      // Load system + public plans from AW-WorkPlans table
      const [systemPlans, publicPlans] = await Promise.all([
        workPlanService.getWorkPlansByVisibility('system'),
        workPlanService.getWorkPlansByVisibility('public'),
      ]);
      // Put user's private plans FIRST so they take priority over system/public plans with same title
      const allPlans: any[] = [];
      if (result.user) {
        const user = await userDb.getUserById(result.user.userId);
        const [ownPlans, orgPlans] = await Promise.all([
          workPlanService.getWorkPlansByOwner(result.user.userId),
          user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
        ]);
        const seen = new Set<string>();
        for (const p of [...ownPlans, ...orgPlans]) {
          if (p.visibility === 'private' && !seen.has(p.planId)) {
            seen.add(p.planId);
            allPlans.push(p);
          }
        }
      }
      allPlans.push(...systemPlans, ...publicPlans);

      // Find work plan with matching title (case-insensitive) — private plans checked first
      const predefinedPlan = allPlans.find((wp) =>
        wp.title && wp.title.toLowerCase() === planTitle.toLowerCase()
      );

      if (!predefinedPlan) {
        return res.status(404).json({ error: `Work plan "${planTitle}" not found` });
      }

      // Enforce ownership/org-membership for private plans.
      // allPlans already only includes private plans belonging to the user or their org,
      // so a plan found in allPlans is already authorized. Only block unauthenticated users.
      if (predefinedPlan.visibility === 'private' && !result.user) {
        return res.status(403).json({ error: 'Not authorized to use this private work plan' });
      }

      // Create session with userId (authenticated or anonymous)
      const session = await chatbotDb.createChatSession(
        userId,
        undefined, // pageContent
        'agent', // portalType
        `plan-${planTitle}`, // pageIdentifier
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined, // executionId
        undefined, // emailCampaignTaskId
        'predefined-work-plan' // sessionType
      );

      // Convert predefined plan to session work plan format
      const workPlan = {
        title: predefinedPlan.title,
        steps: predefinedPlan.steps.map((step: any) => ({
          stepCount: step.stepCount,
          title: step.title,
          description: step.description,
          // Carry the user-facing instructions through to the session so
          // <HorizontalPlanProgress> can render them in the expanded-step
          // panel. Without this, the field set in the partner-portal
          // editor never reaches the customer portal.
          ...(step.userInstructions !== undefined && { userInstructions: step.userInstructions }),
          status: 'pending' as const,
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: step.requiredFunctionCalls,
          skillIds: step.skillIds
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Create work plan in session (include welcome message and autocomplete if defined)
      const workPlanWithWelcome = {
        ...workPlan,
        welcomeMessage: predefinedPlan.welcomeMessage?.trim() || undefined,
        autocomplete: predefinedPlan.autocomplete || false,
        showLoginSignup: predefinedPlan.showLoginSignup || 'after_plan_completed',
        requireLogin: predefinedPlan.requireLogin || false
      };
      await chatbotDb.updateSessionWorkPlan(session.sessionId, workPlanWithWelcome);

      // Auto-install ALL skills from ALL work plan steps upfront.
      // Skills need to be available from the start because tool filtering is computed
      // at the beginning of each message — installing mid-conversation (on step completion)
      // doesn't take effect until the next message, causing tools to be unavailable.
      // The work plan's requiredFunctionCalls still enforce step ordering.
      const allSkillIds = new Set<string>();
      for (const step of predefinedPlan.steps) {
        if (step.skillIds?.length) {
          step.skillIds.forEach((id: string) => allSkillIds.add(id));
        }
      }
      if (allSkillIds.size > 0) {
        try {
          await chatbotDb.addAssociatedSkills(session.sessionId, Array.from(allSkillIds));
          console.log(`AgentMode: Auto-installed all plan skills for "${predefinedPlan.title}": ${Array.from(allSkillIds).join(', ')}`);
        } catch (skillErr) {
          console.error('AgentMode: Error auto-installing plan skills:', skillErr);
        }
      }

      // Set default model for new sessions
      // Use work plan's default model if specified, otherwise use global default
      let selectedModel = predefinedPlan.defaultModel;

      // Validate work plan's default model
      if (selectedModel) {
        const supportedModels = await agentModeService.getSupportedModels();
        if (!supportedModels.includes(selectedModel)) {
          console.warn(`AgentMode: Work plan default model "${selectedModel}" not supported, using global default`);
          selectedModel = undefined;
        } else {
          console.log(`AgentMode: Using work plan default model: ${selectedModel}`);
        }
      }

      // Fall back to global default if no valid work plan model
      if (!selectedModel) {
        selectedModel = await agentModeService.getDefaultModel();
      }

      await chatbotDb.updateSessionLlmModel(session.sessionId, selectedModel);

      // Enable interactive sharing for the session
      const conversableToken = crypto.randomBytes(32).toString('hex');
      const interactiveShareMetadata = {
        isActive: true,
        token: conversableToken,
        sharedAt: new Date().toISOString()
      };
      await chatbotDb.updateSessionInteractiveShareMetadata(session.sessionId, interactiveShareMetadata);

      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const redirectUrl = `${customerFrontendUrl}/plan/${encodeURIComponent(planTitle)}/${session.sessionId}?conversable=${conversableToken}`;

      res.json({
        sessionId: session.sessionId,
        redirectUrl,
        workPlan: workPlanWithWelcome,
        conversableToken,
        userId: session.userId
      });

      // ai-eval-funnel loop telemetry — fire eval_started server-side so the
      // loop's sensor sees the start regardless of frontend telemetry state.
      // Idempotent via ConditionExpression — safe on retries.
      if (planTitle === 'AI_GTM_Position_Eval') {
        loopEventsEmitter.fireEvalStarted(session.sessionId).catch(() => {});
      }

      // Fire-and-forget: send starting message after response is returned
      if (startingMessage && typeof startingMessage === 'string' && startingMessage.trim()) {
        const trimmedMessage = startingMessage.trim();
        const sessionId = session.sessionId;

        console.log(`AgentMode: Fire-and-forget starting for session ${sessionId}, model=${selectedModel}`);
        generateSessionResponse(sessionId, trimmedMessage, userId, selectedModel)
          .then(() => {
            progressStore.delete(sessionId);
            console.log(`AgentMode: Fire-and-forget completed successfully for session ${sessionId}`);
          })
          .catch(async (firstErr: any) => {
            console.warn(`AgentMode: First attempt failed for session ${sessionId}: ${firstErr?.message}`);

            // Persist a tagged "first attempt failed" record IMMEDIATELY so the
            // closed-loop sensor (which queries for metadata.isErrorMessage = true)
            // sees the failure even when the retry rescues the session.
            // Without this, retries silently mask LLM/Bedrock/Playwright failures —
            // the lander loop reported 0 logged failures over 30 days despite
            // known agent crashes, because the retry path here always overwrote
            // the first-attempt failure with a successful response.
            //
            // Uses role='system' so the user doesn't see this in their chat UI
            // (filterMessagesForClient strips system messages on read). The sensor
            // path queries the raw messages array, so it still sees the tag.
            try {
              // Pack debug info (errorName/code/httpStatus) into the content
              // since the ChatMessage metadata type is strict — we don't want
              // to widen the type just to thread these fields through.
              const debugCtx = JSON.stringify({
                firstAttemptOnly: true,
                errorName: firstErr?.name,
                errorCode: firstErr?.code,
                httpStatus: firstErr?.status ?? firstErr?.$metadata?.httpStatusCode,
              });
              const firstAttemptErrorMessage: ChatMessage = {
                role: 'system',
                content: `[telemetry] First-attempt agent failure (retry will follow): ${(firstErr?.message ?? String(firstErr)).slice(0, 500)} | ctx: ${debugCtx}`,
                timestamp: new Date().toISOString(),
                metadata: {
                  timestamp: new Date().toISOString(),
                  isErrorMessage: true,
                },
              };
              await chatbotDb.addMessageToSession(sessionId, firstAttemptErrorMessage);
            } catch (saveErr) {
              console.error('AgentMode: Failed to save first-attempt-failure telemetry record', sessionId, saveErr);
            }

            // Restart the worker before retrying — the current worker may be unresponsive
            try {
              await generateMarketingResponseWorkerService.restartWorker();
            } catch (restartErr) {
              console.error(`AgentMode: Worker restart failed for session ${sessionId}:`, restartErr);
            }

            await new Promise(resolve => setTimeout(resolve, 3000));

            let retryErrCaught: any = null;
            try {
              console.log(`AgentMode: Retrying fire-and-forget for session ${sessionId}`);
              await generateSessionResponse(sessionId, trimmedMessage, userId, selectedModel);
              progressStore.delete(sessionId);
              console.log(`AgentMode: Retry succeeded for session ${sessionId}`);
              return; // Retry succeeded — done. The first-attempt-failure telemetry record
                      // we wrote above stays in the session as a "rescued by retry" marker.
            } catch (retryErr: any) {
              retryErrCaught = retryErr;
              console.error(`AgentMode: Retry also failed for session ${sessionId}: ${retryErr?.message}`);
            }

            // Both attempts failed — persist user-visible error message and alert.
            // The earlier telemetry record (firstAttemptOnly: true) plus this user-
            // visible message together give the sensor two markers for terminal
            // failures and one marker for retry-rescued failures.

            // Also fire eval_failed to the lander loop's anon-event table, so the
            // loop's policy DSL can see this terminal failure regardless of
            // the chat-session message-scan path.
            if (planTitle === 'AI_GTM_Position_Eval') {
              loopEventsEmitter
                .fireEvalFailed(
                  sessionId,
                  `first: ${(firstErr?.message ?? 'unknown').slice(0, 200)} | retry: ${(retryErrCaught?.message ?? 'unknown').slice(0, 200)}`,
                )
                .catch(() => {});
            }

            // Persist error message to session so the user sees something went wrong
            try {
              const errorMessage: ChatMessage = {
                role: 'assistant',
                content: 'I encountered an error while processing your request. Please try sending your message again or start a new session.',
                timestamp: new Date().toISOString(),
                metadata: {
                  timestamp: new Date().toISOString(),
                  isErrorMessage: true
                }
              };
              await chatbotDb.addMessageToSession(sessionId, errorMessage);
            } catch (saveErr) {
              console.error('AgentMode: Failed to save error message to session', sessionId, saveErr);
            }

            // Emit progress complete so the frontend stops showing the loading state and refreshes
            markProgressComplete(sessionId);

            // Send oncall alert so the team is notified
            sendAgentModeOncallAlert({
              subject: `Work Plan Session Failed: ${sessionId}`,
              message: `A predefined work plan session failed after retry.\n\nFirst error: ${firstErr?.message || 'Unknown'}\n\nRetry error: (see above)`,
              sessionId,
              context: {
                'Session ID': sessionId,
                'User ID': userId,
                'Plan Title': workPlanWithWelcome?.title || 'Unknown',
                'LLM Model': selectedModel,
                'Error Message': firstErr?.message || 'Unknown error',
                'Error Stack': firstErr?.stack || 'No stack trace',
                'Timestamp': new Date().toISOString()
              }
            }).catch(alertErr => console.error('Failed to send oncall alert for work plan session error:', alertErr));
          });
      }
    } catch (error) {
      console.error('AgentMode: Create session with plan error:', error);
      res.status(500).json({ error: 'Failed to create session with plan' });
    }
  },

  // SSE endpoint for progress updates (authenticated)
  async getProgress(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as User;

      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      // Verify session exists and user has access
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Under delegation (`req.delegateInfo.isDelegated`), `req.user.userId` is
      // the TARGET customer per middleware/auth.ts — so owner-matching against
      // `user.userId` already covers the "admin viewing target's sessions"
      // case. But an admin-created session (owned by the admin's own userId)
      // shown in the admin's UI while they're delegated gets a false-positive
      // 403 otherwise — which is why the prod UI sat in a 403 polling loop
      // during impersonation (see nginx log, 2026-04-23 23:52 UTC). Allow
      // the delegated admin to read their own admin-owned sessions too.
      const delegateInfo = req.delegateInfo;
      const isOwner = session.userId === user.userId;
      const isDelegatedAdminOwnSession =
        delegateInfo?.isDelegated &&
        session.userId === delegateInfo.adminUserId;
      if (!isOwner && !isDelegatedAdminOwnSession) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Set up SSE connection - inline the logic since we can't use 'this' in object literal
      setupSSEConnectionForSession(sessionId, res, req);
    } catch (error) {
      console.error('AgentMode: SSE progress error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish progress stream' });
      }
    }
  },

  // SSE endpoint for progress updates (public, with conversable token)
  async getProgressPublic(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;

      if (!shareId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      // Verify session exists and conversable token is valid
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const interactiveShare = session.interactiveShareMetadata;

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Set up SSE connection - inline the logic since we can't use 'this' in object literal
      setupSSEConnectionForSession(shareId, res, req);
    } catch (error) {
      console.error('AgentMode: SSE progress error (public):', error);
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish progress stream' });
      }
    }
  },


  // Transfer session from anonymous user to authenticated user
  async transferSession(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user;

      // Get the session to verify it exists and check if it's anonymous
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if the session belongs to an anonymous user
      if (!session.userId.startsWith('anon_')) {
        return res.status(400).json({ error: 'Session is not anonymous' });
      }

      // Update the session userId to the authenticated user's ID
      await chatbotDb.updateSessionUserId(sessionId, user.userId);

      res.json({
        message: 'Session transferred successfully',
        sessionId,
        userId: user.userId
      });
    } catch (error) {
      console.error('AgentMode: Transfer session error:', error);
      res.status(500).json({ error: 'Failed to transfer session' });
    }
  },

  // Verified generate - ensures required functions are called minimum number of times
  async verifiedGenerate(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId, startingMessage, requiredFunctions, keywords, attachments, maxAttempts: maxAttemptsParam } = req.body;
      
      // Log attachments for debugging
      console.log('AgentMode verifiedGenerate: Received attachments:', attachments?.length || 0, attachments);

      // Validate required fields
      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      if (!startingMessage || !startingMessage.trim()) {
        return res.status(400).json({ error: 'Starting message is required' });
      }

      if (requiredFunctions !== undefined && !Array.isArray(requiredFunctions)) {
        return res.status(400).json({ error: 'Required functions must be an array when provided' });
      }

      const requiredFunctionsArray = Array.isArray(requiredFunctions) ? requiredFunctions : [];

      // Validate requiredFunctions format: [{ functionName: string, minCount: number }]
      for (const reqFunc of requiredFunctionsArray) {
        if (!reqFunc.functionName || typeof reqFunc.functionName !== 'string') {
          return res.status(400).json({ error: 'Each required function must have a functionName (string)' });
        }
        if (typeof reqFunc.minCount !== 'number' || reqFunc.minCount < 1) {
          return res.status(400).json({ error: 'Each required function must have a minCount (number >= 1)' });
        }
      }

      // Get session and verify ownership
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId) {
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      // Track if client disconnected (user navigated away)
      let clientDisconnected = false;
      req.on('close', () => {
        clientDisconnected = true;
        console.log('AgentMode: Client disconnected, but continuing verified generation...');
      });

      // Run verified chat
      // Ensure attachments is always an array
      const attachmentsArray = Array.isArray(attachments) ? attachments : [];
      console.log('AgentMode verifiedGenerate: Passing attachments to runVerifiedChat:', attachmentsArray.length, attachmentsArray);
      const result = await runVerifiedChat({
        sessionId,
        userId: user.userId,
        startingMessage: startingMessage.trim(),
        keywords: keywords || [],
        requiredFunctions: requiredFunctionsArray,
        maxAttempts: maxAttemptsParam || 5,
        attachments: attachmentsArray,
        // ENG-636: interactive endpoint — the user's live session renders the
        // pendingUserQuestion card, so a park reaches a human who can answer.
        parkNotifiable: true
      });

      // If client disconnected, don't try to send response
      // The results are already saved to the session
      if (clientDisconnected) {
        console.log('AgentMode: Client disconnected before response could be sent, but verified generation completed');
        return;
      }

      res.status(200).json({
        success: result.success,
        message: result.success
          ? `All required functions were called successfully.`
          : `Some required functions were not called enough times after ${result.attempts} attempt${result.attempts !== 1 ? 's' : ''}.`,
        content: result.content,
        toolCalls: result.toolCalls,
        keywordMatches: result.keywordMatches,
        keywordMisses: result.keywordMisses,
        functionCallMatches: result.functionCallMatches,
        functionCallMisses: result.functionCallMisses,
        functionStatus: result.functionStatus,
        attempts: result.attempts,
        workPlanCompleted: result.workPlanCompleted,
        sessionId: sessionId
      });
    } catch (error: any) {
      console.error('AgentMode: Verified generate error:', error);
      const sessionId = req.body?.sessionId;
      const user = req.user as User;
      const isSessionLimit = isSessionLimitError(error);

      try {
        await sendAgentModeOncallAlert({
          subject: isSessionLimit
            ? 'Agent Mode Verified Generate: Session limit exceeded'
            : 'Agent Mode Verified Generate: Failed',
          message: isSessionLimit
            ? `Verified generation failed because the session reached its limit.\n\nSession: ${sessionId || 'unknown'}\nUser: ${user?.userId || 'unknown'}`
            : `Verified generation failed.\n\nSession: ${sessionId || 'unknown'}\nUser: ${user?.userId || 'unknown'}`,
          sessionId,
          context: {
            'User ID': user?.userId || 'unknown',
            'Error': error.message || String(error),
            'Starting Message': req.body?.startingMessage || 'N/A',
            'Required Functions': JSON.stringify(req.body?.requiredFunctions || []),
            'Keywords': JSON.stringify(req.body?.keywords || [])
          }
        });
      } catch (alertError) {
        console.error('❌ Error sending oncall alert:', alertError);
      }
      res.status(500).json({
        error: 'Failed to perform verified generation',
        message: error.message || 'Unknown error'
      });
    }
  },

  // Update session LLM model (for authenticated users)
  async updateSessionLlmModel(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const { llmModel } = req.body;
      const user = req.user;

      if (!llmModel) {
        return res.status(400).json({ error: 'llmModel is required' });
      }

      // ENG-892: the picker used to persist whatever string arrived, so ids that
      // are not served at all (e.g. 'claude-sonnet-4-5') were stored and later
      // reported as the model a session ran on. Accept only what generation would
      // accept — `fellBack` is true exactly when the id is not in the allow-list
      // after legacy-alias resolution — and store the canonical id so the field
      // stays comparable to the per-message `llm` provenance.
      const resolution = agentModeService.resolveGenerationModel(llmModel);
      if (resolution.fellBack) {
        return res.status(400).json({
          error: `Unsupported model '${llmModel}'. Choose a model returned by the supported-models endpoint.`,
        });
      }
      const canonicalModel = resolution.model;

      // Block non-admins from using opus models
      if (canonicalModel.includes('opus') && !user.isAdmin) {
        return res.status(403).json({ error: 'Opus models are not available for your account' });
      }

      // Get the session to verify ownership
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user owns the session (or is admin)
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Update the session's llmModel
      const updatedSession = await chatbotDb.updateSessionLlmModel(sessionId, canonicalModel);

      res.json({ llmModel: updatedSession.llmModel });
    } catch (error) {
      console.error('AgentMode: Update session LLM model error:', error);
      res.status(500).json({ error: 'Failed to update session LLM model' });
    }
  },

  // Update session LLM model for shared conversation (with conversable token)
  async updateSharedSessionLlmModel(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;
      const { llmModel } = req.body;

      if (!llmModel) {
        return res.status(400).json({ error: 'llmModel is required' });
      }

      // ENG-892: same allow-list guard as the authenticated picker. This path
      // matters more, not less — an interactive-share viewer writes to the
      // owner's real session, so an unserved id here mislabels someone else's
      // session.
      const resolution = agentModeService.resolveGenerationModel(llmModel);
      if (resolution.fellBack) {
        return res.status(400).json({
          error: `Unsupported model '${llmModel}'. Choose a model returned by the supported-models endpoint.`,
        });
      }
      const canonicalModel = resolution.model;

      // Shared sessions are non-admin; block opus models
      if (canonicalModel.includes('opus')) {
        return res.status(403).json({ error: 'Opus models are not available for shared sessions' });
      }

      // Get the session to verify the conversable token
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if conversable sharing is active and token matches
      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      const interactiveShare = session.interactiveShareMetadata;

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Update the session's llmModel
      const updatedSession = await chatbotDb.updateSessionLlmModel(shareId, canonicalModel);

      res.json({ llmModel: updatedSession.llmModel });
    } catch (error) {
      console.error('AgentMode: Update shared session LLM model error:', error);
      res.status(500).json({ error: 'Failed to update session LLM model' });
    }
  },

  // Update session title
  async updateSessionTitle(req: AuthenticatedRequest, res: Response) {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { sessionId } = req.params;
      const { title } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
      }

      // Get the session to verify ownership
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user owns the session (or is admin)
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Update the session title
      const updatedSession = await chatbotDb.updateSessionTitle(sessionId, title.trim());

      res.json({ title: updatedSession.title });
    } catch (error) {
      console.error('AgentMode: Update session title error:', error);
      res.status(500).json({ error: 'Failed to update session title' });
    }
  },

  async getShareOgMetadata(req: Request, res: Response) {
    try {
      const { shareId } = req.params;

      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Must have view-only or interactive sharing enabled
      const hasViewOnlyShare = session.shareMetadata?.isShared;
      const hasInteractiveShare = session.interactiveShareMetadata?.isActive;
      if (!hasViewOnlyShare && !hasInteractiveShare) {
        return res.status(404).json({ error: 'This conversation is not shared' });
      }

      // Check if view-only share expired
      if (hasViewOnlyShare && session.shareMetadata?.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
        return res.status(410).json({ error: 'Share link has expired' });
      }

      // Check if interactive share expired
      if (!hasViewOnlyShare && hasInteractiveShare && session.interactiveShareMetadata &&
          new Date() > getInteractiveShareExpiresAt(session.interactiveShareMetadata)) {
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      const title = session.title || 'AgentWeb Conversation';

      // Extract first user message for description
      let description = 'View this conversation on AgentWeb';
      if (Array.isArray(session.messages)) {
        const firstUserMessage = session.messages.find(
          (m: any) => m && m.role === 'user' && typeof m.content === 'string'
        );
        if (firstUserMessage) {
          const content = firstUserMessage.content.trim();
          description = content.length > 160 ? content.substring(0, 157) + '...' : content;
        }
      }

      res.json({ title, description });
    } catch (error) {
      console.error('AgentMode: Get share OG metadata error:', error);
      res.status(500).json({ error: 'Failed to get share metadata' });
    }
  },

  // GET /api/agent-mode/foundation-tools
  getFoundationTools: async (req: Request, res: Response) => {
    try {
      const toolNames = [...agentModeService.getFoundationToolNames()];
      const defaults = [...AgentModeService.DEFAULT_FOUNDATION_TOOLS];
      const adminToolNames = agentModeService.getAdminToolNames();
      res.json({ toolNames, defaults, adminToolNames });
    } catch (error) {
      console.error('AgentMode: Get foundation tools error:', error);
      res.status(500).json({ error: 'Failed to get foundation tools' });
    }
  },

  // PUT /api/agent-mode/foundation-tools
  updateFoundationTools: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { toolNames } = req.body;
      if (!Array.isArray(toolNames)) {
        return res.status(400).json({ error: 'toolNames must be an array of strings' });
      }
      if (!toolNames.every((t: unknown) => typeof t === 'string' && t.length > 0)) {
        return res.status(400).json({ error: 'Each tool name must be a non-empty string' });
      }

      const updatedBy = req.user?.email || 'admin';
      const updated = await agentModeService.updateFoundationTools(toolNames, updatedBy);
      res.json({ toolNames: updated });
    } catch (error) {
      console.error('AgentMode: Update foundation tools error:', error);
      res.status(500).json({ error: 'Failed to update foundation tools' });
    }
  },

  // ─── Schedule Templates ──────────────────────────────────────────────────

  // POST /api/agent-mode/schedule-templates
  createScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const {
        name, description, category, visibility,
        startingMessage, variables, keywords,
        requiredFunctionCalls, functionCallMinCalls,
        suggestedFrequency, frequencyIntervalDays,
        emailNotifications, dailyDigest, llmModel,
      } = req.body;

      if (!name || !startingMessage) {
        return res.status(400).json({ error: 'name and startingMessage are required' });
      }

      if (suggestedFrequency === 'every_n_days' && (frequencyIntervalDays === undefined || !Number.isInteger(frequencyIntervalDays) || frequencyIntervalDays < 1)) {
        return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer when suggestedFrequency is every_n_days' });
      }

      // Extract variables from message
      const variableRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
      const messageVarNames = new Set<string>();
      let match;
      while ((match = variableRegex.exec(startingMessage)) !== null) {
        messageVarNames.add(match[1]);
      }

      // Build normalized variables list
      const inputVars = Array.isArray(variables) ? variables : [];
      const normalizedVariables = Array.from(messageVarNames).map(varName => {
        const existing = inputVars.find((v: any) => v.name === varName);
        return {
          name: varName,
          description: existing?.description || '',
          type: existing?.type || 'text',
        };
      });

      const templateId = uuidv4();
      const now = new Date().toISOString();

      const template = {
        templateId,
        createdBy: user.userId,
        name,
        description: description || '',
        category: category || 'General',
        visibility: 'private' as const,
        startingMessage,
        variables: normalizedVariables,
        keywords: keywords || [],
        requiredFunctionCalls: requiredFunctionCalls || [],
        functionCallMinCalls: functionCallMinCalls || {},
        suggestedFrequency: suggestedFrequency || 'daily',
        ...(suggestedFrequency === 'every_n_days' && { frequencyIntervalDays }),
        emailNotifications: emailNotifications || [],
        dailyDigest: dailyDigest || false,
        llmModel: llmModel || '',
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      await scheduleTemplateDb.createTemplate(template);

      res.status(201).json({
        templateId,
        message: 'Schedule template created successfully',
      });
    } catch (error) {
      console.error('AgentMode: Create schedule template error:', error);
      res.status(500).json({ error: 'Failed to create schedule template' });
    }
  },

  // GET /api/agent-mode/schedule-templates
  getScheduleTemplates: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;

      // Get user's own templates + all system/public templates
      const [userTemplates, systemTemplates, publicTemplates] = await Promise.all([
        scheduleTemplateDb.getTemplatesByCreator(user.userId),
        scheduleTemplateDb.getTemplatesByVisibility('system'),
        scheduleTemplateDb.getTemplatesByVisibility('public'),
      ]);

      // Merge: system + public + user's own templates, deduplicated
      const sharedTemplates = [...(systemTemplates || []), ...(publicTemplates || [])];
      const sharedIds = new Set(sharedTemplates.map((t: any) => t.templateId));
      const privateTemplates = (userTemplates || []).filter((t: any) => !sharedIds.has(t.templateId));
      const all = [...sharedTemplates, ...privateTemplates];

      // Sort newest first
      all.sort((a: any, b: any) => {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });

      res.json(all);
    } catch (error) {
      console.error('AgentMode: Get schedule templates error:', error);
      res.status(500).json({ error: 'Failed to get schedule templates' });
    }
  },

  // GET /api/agent-mode/schedule-templates/:templateId
  getScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const template = await scheduleTemplateDb.getTemplateById(templateId);
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      // Allow access if system/public visibility or owned by user
      const isPubliclyVisible = template.visibility === 'system' || template.visibility === 'public';
      if (!isPubliclyVisible && template.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found' });
      }

      res.json(template);
    } catch (error) {
      console.error('AgentMode: Get schedule template error:', error);
      res.status(500).json({ error: 'Failed to get schedule template' });
    }
  },

  // PUT /api/agent-mode/schedule-templates/:templateId
  updateScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const existing = await scheduleTemplateDb.getTemplateById(templateId);
      if (!existing || existing.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found or not owned by you' });
      }

      const {
        name, description, category, visibility,
        startingMessage, variables, keywords,
        requiredFunctionCalls, functionCallMinCalls,
        suggestedFrequency, frequencyIntervalDays,
        emailNotifications, dailyDigest, llmModel,
      } = req.body;

      const updates: any = { updatedAt: new Date().toISOString() };

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (category !== undefined) updates.category = category;
      if (visibility !== undefined) updates.visibility = visibility;
      if (keywords !== undefined) updates.keywords = keywords;
      if (requiredFunctionCalls !== undefined) updates.requiredFunctionCalls = requiredFunctionCalls;
      if (functionCallMinCalls !== undefined) updates.functionCallMinCalls = functionCallMinCalls;
      if (suggestedFrequency !== undefined) updates.suggestedFrequency = suggestedFrequency;
      if (frequencyIntervalDays !== undefined) updates.frequencyIntervalDays = frequencyIntervalDays;
      if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
      if (dailyDigest !== undefined) updates.dailyDigest = dailyDigest;
      if (llmModel !== undefined) updates.llmModel = llmModel;

      if (startingMessage !== undefined) {
        updates.startingMessage = startingMessage;

        // Re-extract variables from updated message
        const variableRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
        const messageVarNames = new Set<string>();
        let match;
        while ((match = variableRegex.exec(startingMessage)) !== null) {
          messageVarNames.add(match[1]);
        }
        const inputVars = Array.isArray(variables) ? variables : (existing.variables || []);
        updates.variables = Array.from(messageVarNames).map(varName => {
          const existingVar = inputVars.find((v: any) => v.name === varName);
          return { name: varName, description: existingVar?.description || '', type: existingVar?.type || 'text' };
        });
      } else if (variables !== undefined) {
        updates.variables = variables;
      }

      await scheduleTemplateDb.updateTemplate(templateId, updates);

      res.json({ message: 'Schedule template updated successfully' });
    } catch (error) {
      console.error('AgentMode: Update schedule template error:', error);
      res.status(500).json({ error: 'Failed to update schedule template' });
    }
  },

  // DELETE /api/agent-mode/schedule-templates/:templateId
  deleteScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const existing = await scheduleTemplateDb.getTemplateById(templateId);
      if (!existing || existing.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found or not owned by you' });
      }

      await scheduleTemplateDb.deleteTemplate(templateId);

      res.json({ message: 'Schedule template deleted successfully' });
    } catch (error) {
      console.error('AgentMode: Delete schedule template error:', error);
      res.status(500).json({ error: 'Failed to delete schedule template' });
    }
  },

  // POST /api/agent-mode/schedule-templates/:templateId/use
  createScheduleFromTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;
      const {
        scheduleName, nextRunTime, scheduleFrequency,
        frequencyIntervalDays: overrideInterval,
        emailNotifications: overrideEmails,
        variableValues, runCount, llmModel: overrideModel,
      } = req.body;

      const template = await scheduleTemplateDb.getTemplateById(templateId);
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      const isPubliclyVisible = template.visibility === 'system' || template.visibility === 'public';
      if (!isPubliclyVisible && template.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const frequency = scheduleFrequency || template.suggestedFrequency || 'daily';
      const interval = overrideInterval || template.frequencyIntervalDays;

      if (frequency === 'every_n_days' && (!interval || !Number.isInteger(interval) || interval < 1)) {
        return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer for every_n_days frequency' });
      }

      const now = new Date();
      let scheduledNextRunTime: string;
      if (nextRunTime) {
        const providedDate = new Date(nextRunTime);
        if (isNaN(providedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid nextRunTime format' });
        }
        scheduledNextRunTime = providedDate.toISOString();
      } else {
        scheduledNextRunTime = calculateNextRunTime(frequency, now, interval).toISOString();
      }

      // Build normalized variable values from template variables
      const normalizedVariableValues: Record<string, string> = {};
      const templateVars: any[] = template.variables || [];
      if (templateVars.length > 0 && variableValues && typeof variableValues === 'object') {
        templateVars.forEach((v: any) => {
          const rawValue = (variableValues as Record<string, unknown>)[v.name];
          if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
            normalizedVariableValues[v.name] = rawValue.trim();
          }
        });
      }

      const missingVars = templateVars.filter((v: any) => !normalizedVariableValues[v.name]);

      const overrideEmailsList = normalizeEmailList(overrideEmails);
      const baseEmails = overrideEmailsList.length > 0
        ? overrideEmailsList
        : normalizeEmailList(template.emailNotifications);
      const emails = (templateVars.length > 0 && missingVars.length > 0 && baseEmails.length === 0)
        ? [user.email]
        : baseEmails;

      const scheduleId = uuidv4();
      const scheduledChat: any = {
        scheduleId,
        taskId: 'global',
        userId: user.userId,
        frequency,
        ...(frequency === 'every_n_days' && { frequencyIntervalDays: interval }),
        scheduleName: scheduleName || template.name,
        description: template.description || '',
        startingMessage: template.startingMessage,
        keywords: template.keywords || [],
        requiredFunctionCalls: template.requiredFunctionCalls || [],
        functionCallMinCalls: template.functionCallMinCalls || {},
        emailNotifications: emails,
        dailyDigest: frequency === 'hourly' ? (template.dailyDigest || false) : false,
        status: 'active',
        nextRunTime: scheduledNextRunTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        sessionId: null,
        type: 'scheduled_chat',
        llmModel: overrideModel || template.llmModel || '',
        runCount: runCount !== undefined ? runCount : -1,
        variables: templateVars,
        variableValues: normalizedVariableValues,
        variableRequestStatus: missingVars.length > 0 ? 'pending' : (templateVars.length > 0 ? 'provided' : 'idle'),
      };

      await scheduleDb.createSchedule(scheduledChat);

      // Increment template usage count
      await scheduleTemplateDb.incrementUsageCount(templateId);

      res.status(201).json({
        scheduleId,
        message: 'Scheduled chat created from template successfully',
        nextRunTime: scheduledNextRunTime,
        templateId,
      });
    } catch (error) {
      console.error('AgentMode: Create schedule from template error:', error);
      res.status(500).json({ error: 'Failed to create schedule from template' });
    }
  },

  // POST /api/agent-mode/schedule-templates/:templateId/submit-for-review
  submitTemplateForReview: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const template = await scheduleTemplateDb.getTemplateById(templateId);
      if (!template || template.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found or not owned by you' });
      }
      if (template.visibility !== 'private') {
        return res.status(400).json({ error: 'Only private templates can be submitted for review' });
      }

      await scheduleTemplateDb.updateTemplate(templateId, {
        visibility: 'pending_review',
        reviewFeedback: '',
        updatedAt: new Date().toISOString(),
      });

      res.json({ message: 'Template submitted for review successfully' });
    } catch (error) {
      console.error('AgentMode: Submit template for review error:', error);
      res.status(500).json({ error: 'Failed to submit template for review' });
    }
  },
};
