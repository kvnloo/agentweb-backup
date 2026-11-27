import OpenAI from "openai";
import { currentRunFunding } from "./funding/runFunding";
import { embedText } from "../utils/embeddings";
import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { getReleases } from "../controllers/release";
import { fetchMintlifyDocsContent, chunkDocsContent } from "./docsKnowledgeSource";
import { getUserReleaseNotes } from "../controllers/docsController";
import { Request, Response } from "express";
import { Storage } from '@google-cloud/storage';
// ENG-1277: type-only. `SearchServiceClient` (the value) is required lazily
// inside searchPlatformKnowledgeBase() below — that function is the only
// caller, and `@google-cloud/discoveryengine` pulls in ~379 transitive
// modules that every jest worker previously paid on `require()` of this file
// regardless of whether a test ever calls it. `EngineServiceClient` was
// imported but never referenced anywhere in this file or its tests'
// production paths (only in mock factories, which don't need the real
// export to exist) — dropped rather than carried into the lazy form.
import type { protos } from '@google-cloud/discoveryengine';
import { taskDb, userDb } from '../services/db';
import { isEvaluationUser } from './evaluationPolicy';
import { getGCSPPrivateKey, getSecret } from '../utils/secretsManager';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { AgentModeService, agentModeService as agentModeServiceSingleton } from './agentModeService';
import { AGENT_MODE_SYSTEM_PROMPT, EMMA_SIDEBAR_ADDENDUM, getScheduledSessionOverride } from '../docs/agentModeSystemPrompt';
import { Citation, CitationRegistry, WEB_SEARCH_TOOL_NAMES, buildCitationIndexBlock } from '../utils/citations';
import { MAX_PERSISTED_MESSAGE_BYTES, shrinkMessageForPersistence } from '../utils/messageSizeGuard';
import { uploadFileToS3, uploadScreenshotToS3 } from '../utils/s3Utils';
import { scanMessagesForAssets } from '../utils/scanMessagesForAssets';
import { withKeyedMutex } from '../utils/keyedMutex';
import { computeCostMicroUsd } from './usageRecorderService';
import type { CacheWriteByTtl } from '../utils/llmPricing';
import { approvalDb } from './approvalDb';
import { PendingUserQuestion } from './agentMode/core/askUserQuestion';
import { PendingApprovalDeck, type ApprovalDeckAnswer, type ApprovalDeckItem } from './agentMode/core/approvalDeck';
import { WorkPlanInputRequest } from './agentMode/core/workPlanInputRequest';
import { WorkflowRunState } from './agentMode/core/workflow';
import { assertSequentialStepCounts } from './workPlanSteps';
import { carryConcealedActiveRun, concealActiveRun, type ActiveRun } from './agentMode/sessionActiveRunGuard';
// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Max serialized message size for DynamoDB persistence (400KB item limit).
// Safety net in addMessagesToMessagesTable; primary truncation happens in agentModeService.
export const MAX_MESSAGE_CONTENT_SIZE = MAX_PERSISTED_MESSAGE_BYTES;

// Tool calls that require repair for empty results (MCP PR #433 bug)
const REPAIRABLE_TOOL_CALLS = [
  'generate_image',
  'generate_video'
];

/** AW-ChatSessions table name (the ENG-110 active-run guard writes to it without going through ChatbotDB). */
export const CHAT_SESSIONS_TABLE_NAME = `${TABLE_PREFIX}AW-ChatSessions`;

// Make sure we have a DynamoDB instance
export const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Interface for message feedback
export interface MessageFeedback {
  type: 'like' | 'dislike';           // User's rating
  comment?: string;                    // Optional text feedback
  timestamp: string;                   // ISO timestamp when feedback given
  userId: string;                      // User who gave feedback
}

// Interface for chat messages
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string; // Add direct timestamp field
  llm?: string; // LLM model used for this message (for assistant messages)
  // ENG-669 PR-C: set when `llm` was chosen by the AgentWeb Model router: the user's selection ('agentweb-model'), the
  // table rule that picked `llm`, and the table version ("AgentWeb Model · via <llm>").
  llmSelected?: string;
  llmRoutingReason?: string;
  llmRoutingTableVersion?: string;
  name?: string; // For tool messages
  tool_call_id?: string; // For tool messages
  tool_calls?: any[]; // For assistant messages with tool calls
  messageIndex?: number; // Index of message in the database (included when loading from DB)
  clientId?: string; // ENG-1495: client-generated id, present only on messages the frontend created optimistically before a server round-trip (echoed back so it can key the same message stably across the refresh that resolves messageIndex)
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  metadata?: {
    currentUrl?: string;
    pageContentLength?: number;
    knowledgeBaseChunks?: number;
    pageChunks?: number;
    relevantChunks?: {
      count: number;
      sources: string[];
    };
    timestamp: string;
    portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar";
    pageIdentifier?: string;
    isContextMessage?: boolean;
    toolCalls?: Array<{
      id: string;
      name: string;
      arguments: any;
      result?: any;
      error?: string;
    }>;
    attachments?: Array<{
      url: string;
      filename: string;
      size: number;
      mimetype: string;
      uploadedAt: string;
    }>;
    feedback?: MessageFeedback;        // NEW: Feedback data
    isErrorMessage?: boolean;           // True when message is an auto-persisted error
    jobIncomplete?: boolean;            // True on the structured "job incomplete" message for zero-output scheduled runs (ENG-209)
    failureClass?: 'budget' | 'transient' | 'system'; // Which zero-output fallback was shown: 'budget' (size/timeout, "split into smaller batches"), 'transient' (rate limit / 5xx / timeout — recovers on retry), or 'system' (deterministic provider/validation error, e.g. the ENG-826 gemini schema 400) — so the misleading-cause bug is diagnosable from the transcript
    isRunFailureNotice?: boolean;       // True on the "please retry" placeholder surfaceFailedRun() leaves for a turn-less crashed run (ENG-473); a run-failure placeholder like jobIncomplete, not a genuine assistant turn
    isDiagnosticMessage?: boolean;      // True when error message was generated by the diagnosis agent
    stopped?: boolean;                  // True when generation was stopped by user
    ishareSender?: {                    // Present on user messages submitted via ishare links
      isAnonymous: true;
      ip?: string;
      userAgent?: string;
    };
    kind?: string;                      // Stable marker for system messages (e.g. 'image-generated')
    imageFilename?: string;             // Filename when kind === 'image-generated'
    imageUrl?: string;                  // ENG-510: image URL on the immediate marker so a completed image survives a whole-turn-cap kill
    crmEvidence?: { tools: string[]; numbers: number[]; truncated?: true }; // ENG-2263: numbers (never text) this turn's CRM tools returned, so a continuation can check its totals
    citations?: Citation[];             // ENG-351: de-duplicated web sources this message consulted (ChatGPT-style Sources UI)
    // ENG-112: provenance of a branched chat. Stamped ONLY on row 0 (the stored system prompt, which
    // is never sent to the model) of a session created by "Branch from here". Free-form metadata, not a
    // session field: see services/agentMode/chatBranching.ts.
    branchOrigin?: {
      sourceSessionId: string;
      sourceTitle?: string;
      sourceMessageIndex: number;       // RAW row index in the source session
      branchedAt: string;
    };
    // ENG-113: saved "Compare models" alternatives (the unchosen answers), stamped on the chosen assistant row by
    // /compare/select when AW-Settings `compare_save_alternatives` is 'true'. Free-form metadata, owner-approved
    // additive key (no schema/index/table change). Owner views only: stripped from every non-owner serializer and
    // never part of any LLM context. See services/agentMode/compareSaveAlternatives.ts.
    compareId?: string;
    compareAlternatives?: Array<{ model: string; name: string; provider: string; content: string; latencyMs: number }>;
    compareAlternativesOmitted?: 'size';
    /** ENG-113: set on the copied row of a branch created with "Branch with this answer". */
    branchedFromAlternative?: { model: string };
    /** Approval deck halt: the deck id and its items; the reply message carries approvalDeckAnswer. */
    pendingApprovalDeckId?: string;
    approvalDeckItems?: ApprovalDeckItem[];
    approvalDeckAnswer?: { deckId: string; answers: ApprovalDeckAnswer[] };
    mediaBudgetDeferred?: boolean;      // ENG-1239: set on the tool-role deferral marker AND on the whole-turn-timeout partial-delivery message that reports it, so an unresolved media-batch pause is detectable from the tail of session history alone
  };
}

// ENG-738: a RESEARCH_LOOKUP_TOOLS call (perform_deep_research, you_search_web,
// google_search_web, you_search_news, linkedin_outreach) that timed out and was
// never retried to success. See AgentModeService.detectOpenResearchRequestChanges
// / buildOpenResearchRequestReminder and chatbotDb.recordOpenResearchRequests.
export interface OpenResearchRequest {
  tool: string;
  topic: string;
  failedAt: string; // ISO timestamp
  errorSummary: string;
}

export interface BranchedFrom {
  sessionId: string;
  rootSessionId: string;
  messageIndex: number;
  branchedAt: string;
}

/** The slim projection of a session returned by getBranchFamilySessions. */
export interface BranchFamilyMember {
  sessionId: string;
  title?: string;
  llmModel?: string;
  messageCount: number;
  updatedAt: string;
  createdAt: string;
  branchedFrom?: BranchedFrom;
}

// Interface for chat sessions
export interface ChatSession {
  sessionId: string;
  userId: string;
  adminListPartition?: string;
  title?: string; // Session title for display
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pageContent?: string; // Full page content for storage
  contextChunks?: ContextChunk[]; // Chunked context for RAG
  portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar"; // Added portalType to session
  pageIdentifier?: string; // Added pageIdentifier for page-specific sessions
  archived?: boolean; // Archive status for soft deletion
  /**
   * ENG-112 (owner-approved additive optional attribute): set ONLY on a chat created by "Branch from here".
   * `sessionId` = the immediate source, `rootSessionId` = the first chat of the family (a branch of a branch
   * keeps the original root), `messageIndex` = the raw fork index sent to the branch endpoint. Owner-only:
   * never serialised on share / conversable / MCP views. No GSI, no backfill; rollback = stop writing/reading.
   */
  branchedFrom?: BranchedFrom;
  /**
   * ENG-110 (owner-approved additive optional attribute): the interactive /generate run currently live on this
   * session, with a heartbeat, so another backend instance (Immutable deploy overlap) can see it. Written only by
   * the active-run guard (sessionActiveRunGuard.ts) behind the `session_active_run_guard_enabled` switch. No GSI,
   * no backfill; rollback = switch off, leftovers go stale harmlessly. NEVER serialised: every ChatbotDB read
   * hides it (non-enumerable) and the owner/MCP views omit it.
   */
  activeRun?: ActiveRun;
  selectedStartupId?: string; // Selected startup profile for context
  workflowId?: string; // Added workflowId for agent mode sessions
  executionId?: string; // Added executionId for agent mode sessions
  emailCampaignTaskId?: string; // Added emailCampaignTaskId for email campaign integration
  shareMetadata?: {
    isShared: boolean;
    sharedAt?: string;
    expiresAt?: string;
  };
  interactiveShareMetadata?: {
    isActive: boolean;
    token?: string;
    sharedAt?: string;
    expiresAt?: string;
    // ENG-3170: the owner's choice on this link: may a visitor run sensitive actions (see utils/interactiveShare). Absent on links made
    // before the setting existed; every link minted since carries an explicit boolean.
    allowSensitiveActions?: boolean;
  };
  workPlan?: {
    title: string;
    steps: Array<{
      stepCount: number; // Step number starting from 1
      title: string;
      description?: string;
      status: 'pending' | 'completed' | 'skipped';
      completedAt?: string;
      // ENG-1188 (Greptile): set alongside completedAt for 'completed' AND ALSO for
      // 'skipped' -- unlike completedAt, this exists purely so setWorkPlanStatus's
      // asset-count gate has a real "this step left pending" marker for a skipped
      // step to scope a later step's asset count against, instead of silently
      // falling through to counting the whole session. Internal bookkeeping only;
      // never rendered (PlanProgress/HorizontalPlanProgress key off completedAt +
      // status === 'completed', which reusing completedAt here would have broken).
      resolvedAt?: string;
      notes?: string;
      requiredFunctionCalls?: string[]; // Required function names that must be called before marking complete
      skillIds?: string[]; // Skill IDs to auto-install when this step becomes active
      // Expected number of media assets (images/videos) this step must produce before
      // it may be marked completed. When set, setWorkPlanStatus blocks completion until
      // the session has produced at least this many assets — preventing a multi-image
      // step (e.g. "Generate 3 Images Per Hook — 18 total") from being marked done with
      // only a fraction generated (the xCures incident). Unset = no asset-count gate.
      expectedAssetCount?: number;
      // ENG-1331: which tool name(s) count toward expectedAssetCount, when a step's
      // deliverable spans multiple asset-producing tools that aren't interchangeable
      // (see synthesisResidue.ts's countProducedAssets for the full rationale). Unset
      // = the gate falls back to the max succeeded count across every known
      // asset-producing tool.
      expectedAssetCountTools?: string[];
      /** ENG-2378: this step's explicit model (canonical registry id), copied from the template at launch. */
      model?: string;
      /**
       * ENG-669: who chose `model`, recorded WITH it and moved with it: 'system' = an admin-authored plan's pin (stamped at
       * launch), 'user' = a user-authored plan's pin or a user's pick adopted after the step's own model became
       * unavailable. Absent on steps written before this change (see legacyPlanPinSource).
       */
      modelSource?: 'user' | 'system';
      inputRequest?: import('./agentMode/core/workPlanInputRequest').WorkPlanInputRequestInput;
    }>;
    createdAt: string;
    updatedAt: string;
    // ENG-2378 (only written for plans whose steps carry a model): the plan's default pin and the model the session
    // had before the plan started (what a step WITHOUT a model falls back to), and the model the engine last stamped
    // (so a user's explicit pick during the plan can be told apart when the plan ends).
    planDefaultModel?: string;
    launchModel?: string;
    /** ENG-669: who chose `launchModel` (the session's llmModelSource when the plan started). */
    launchModelSource?: 'user' | 'system';
    /** ENG-669: who chose `planDefaultModel` (stamped at launch from the plan's author). */
    planDefaultModelSource?: 'user' | 'system';
    /**
     * ENG-669: who authored this plan, recorded at launch: 'system' = an admin-authored template (its pins are
     * AgentWeb's choice and are exempt from the tier model allowlist), 'user' = a user-authored one.
     */
    planAuthor?: 'user' | 'system';
    engineModel?: string;
    // The model the USER explicitly picked during the plan (a resumed step adopts it, or a model-less step runs on it):
    // the end-of-plan restore never replaces it.
    pickedModel?: string;
    welcomeMessage?: string; // Custom welcome message for this work plan
    autocomplete?: boolean; // When true, Emma MUST complete each step before responding to the user
    // ENG-1472: the predefined WorkPlan template (AW-WorkPlans planId) this
    // session's work plan was instantiated from, when it was launched from a
    // template (launch_predefined_work_plan, the public plan-session route, or
    // the recommend-then-accept flow). Absent for plans created ad hoc via
    // create_work_plan. Used for accept-endpoint idempotency and to chain into
    // a completed template's author-approved "next plan" suggestions.
    templatePlanId?: string;
    // ENG-1811: a session-lifetime, stepCount-agnostic ledger of required
    // function names that were removed from some step via modify_work_plan's
    // removeStepCounts while genuinely unresolved (never succeeded). Populated
    // by modifyWorkPlan whenever it removes a step; enforced by
    // setWorkPlanStatusAttempt, which refuses to let a batch resolve the LAST
    // remaining pending step(s) (finish the plan) while any entry here still
    // hasn't succeeded -- regardless of whether the removed step's number, or
    // any step at all, ever mentions that function again. This closes a real,
    // live-observed gap: the per-step requiredFunctionCalls protection
    // (mergeRequiredFunctionCalls) only guards a step whose OWN declared list
    // is being edited; removing the step entirely (optionally re-adding a
    // differently-scoped replacement, in the same modify_work_plan call or a
    // later, separate one) bypassed it completely, since neither the merge
    // logic nor any later "add new step" branch has a way to know the
    // function was ever required at all once its owning step is gone. Cleared
    // entries are removed once their function succeeds; the whole field is
    // naturally reset on a genuinely new plan (createWorkPlan/
    // applyPredefinedWorkPlan replace workPlan wholesale, never carrying this
    // field forward from the prior plan).
    pendingRequiredFunctionCalls?: string[];
  };
  contextLimitReported?: boolean; // True once a context-limit issue report has been auto-filed
  // ENG-1635/1644 PR2: dead going forward — updateSessionAskUserQuestion (the
  // only writer) is deleted, and the pre-migration stale records were drained
  // (eng1635-null-stale-pending-user-questions.ts). Left declared, not
  // removed, only because agentMode/workflowRunner.ts's resolveStepParameters
  // still reads it to gate a WorkflowStepDefinition's requiredParameters —
  // confirmed that mechanism's only real caller (createCampaignStep.ts's
  // buildCreateCampaignStep, ENG-397's demonstrative example) is itself never
  // invoked anywhere in production, so this is safe dead weight, not a live
  // regression risk. Out of scope for this pass to also touch workflowRunner.ts.
  pendingUserQuestion?: PendingUserQuestion;
  // See pendingUserQuestion above — same PR2 status (dead writer, kept only
  // for workflowRunner.ts's still-live but practically-unreachable read).
  answeredQuestions?: Record<string, PendingUserQuestion>;
  // One channel-neutral information request emitted by the current work-plan
  // step. It carries typed values rather than an option selection; the write
  // guard makes it and pendingApprovalDeck mutually exclusive while either is
  // awaiting (2-way, ENG-1635/1644 PR2 — pendingUserQuestion dropped out of
  // this cross-slot guard once nothing could populate it anymore).
  pendingWorkPlanInput?: WorkPlanInputRequest;
  // ENG-1635/1644: the compound multi-item approval deck Emma is currently
  // blocked on (if any) — see agentMode/core/approvalDeck.ts's file header.
  // The other live human-interrupt slot alongside pendingWorkPlanInput;
  // updateSessionApprovalDeck's guard and updateSessionWorkPlanInputRequest's
  // guard cross-check each other so at most one is ever 'awaiting' at once.
  pendingApprovalDeck?: PendingApprovalDeck;
  // ENG-1642: canonical digests (computeMetaWriteManifestDigest) of manifest-
  // approved Meta writes already executed confirmation-free in this session.
  // A digest present here has been consumed — the SAME write may not execute
  // again without a fresh confirmation. Map value is the consumption
  // timestamp (kept, not just a boolean, purely for audit/debugging).
  consumedMetaWriteManifestDigests?: Record<string, string>;
  // ENG-1635/1644 follow-up: tracks a per-target consecutive-failure streak for
  // a Meta write, purely so the failure history can be surfaced on the NEXT
  // approval card for the same target — found live, a write that failed 3x in
  // a row got silently re-proposed identically each time with zero explanation,
  // because nothing surfaced the failure independent of the model's own prose.
  // Deliberately NOT used to block or gate dispatch (an earlier version did —
  // reverted live, since blocking by target identity alone can silently refuse
  // a genuinely corrected, would-succeed attempt too, which is worse than the
  // bug it was fixing). `signature` identifies the TARGET (entity_type+action+
  // account/campaign/ad_set/ad id), not exact params, so a genuinely corrected
  // retry (different params, same target) still counts toward the same streak
  // for warning purposes — never for permission. Cleared to null the moment a
  // write against the same signature succeeds.
  lastFailedMetaWrite?: { signature: string; error: string; count: number; at: string } | null;
  // ENG-1635/1644 PR2: durable record of a Meta campaign objective already
  // confirmed by the user's own words (or a prior answered card), keyed by
  // the objectiveKind correlator resolveCampaignObjectiveGate computes
  // (account+name+budget+categories) — lets a same-turn write-gate retry, or
  // a later campaign in the same session, find it already settled without
  // re-deriving it. Deliberately a plain map field (mirrors
  // lastFailedMetaWrite/consumedMetaWriteManifestDigests above), NOT the
  // deck/message-history mechanism: this record is never shown to the user
  // as a card (the objective was already stated in their own words, no card
  // was needed), and synthesizing a fake halt+answer message pair into the
  // real chat transcript would risk it actually rendering. Written only by
  // persistExplicitObjectiveConfirmation — not a general-purpose setter.
  objectiveConfirmations?: Record<string, {
    objective: string;
    answeredBy: 'user' | 'delegation';
    at: string;
    quote?: string;
  }>;
  // ENG-1974: workplan recommendations the user explicitly declined via "Keep
  // chatting" this session, keyed by recommendationId (the deterministic
  // sha256(sessionId:planId) hash recommendPredefinedWorkPlan already
  // computes — see agentModeService.ts). A map, not a single slot like
  // pendingUserQuestion, because a decline isn't blocking the way an
  // unanswered question is, and a single slot would let declining a SECOND
  // plan silently erase protection for the first. Consulted by
  // applyPredefinedWorkPlan's decline gate and by the dynamic work-plan
  // context builder so Emma sees the real fact before her own read of the
  // conversation forms, instead of self-launching a plan the user already
  // passed on.
  declinedWorkPlanRecommendations?: Record<string, { planId: string; planTitle: string; declinedAt: string }>;
  // ENG-397: the structured, typed workflow run in flight for this session
  // (if any). Each mutating step's checkpoint (entity IDs + verified
  // end-state) is persisted here so a killed-and-restarted session resumes
  // from the last VERIFIED step instead of re-deriving state from chat prose
  // / re-creating entities. Distinct from `workPlan` (a narrative to-do
  // list) — see agentMode/core/workflow.ts file header.
  workflowRun?: WorkflowRunState;
  calledFunctions?: Record<string, number>; // Track count of each function call made in this session
  calledFunctionsVersion?: number; // Optimistic-lock counter guarding calledFunctions read-modify-write races
  failedFunctions?: Record<string, number>; // Track count of each failed function call in this session
  // ENG-738: RESEARCH_LOOKUP_TOOLS calls that timed out and were never retried
  // to success — kept so a later turn doesn't silently drop (or misremember)
  // a request the user is still owed once the conversation moves on to
  // something else. Capped/FIFO by chatbotDb.recordOpenResearchRequests and
  // age-filtered at read time by AgentModeService.buildOpenResearchRequestReminder.
  openResearchRequests?: OpenResearchRequest[];
  favorites?: Record<string, boolean>; // Track favorited assets by URL (key: assetUrl, value: true if favorited)
  archives?: Record<string, boolean>; // Track archived assets by URL (key: assetUrl, value: true if archived)
  feedbacks?: Record<string, MessageFeedback>; // Track image feedback by URL (key: imageUrl, value: feedback)
  publishStatuses?: Record<string, string>; // Track publish status by asset URL (key: assetUrl, value: 'draft' | 'published')
  sessionType?: "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation" | "report_generation" | "result-endpoint" | "emma-email" | "meeting-intake"; // Type of session based on how it was created
  // ENG-827: the publish authorization this scheduled run was ADMITTED under, stamped
  // before the first turn. A run keeps the permissions it started with: the dispatch
  // guard intersects this with live schedule state, so consent granted after a run
  // began cannot reach into it. Written only for runs admitted as authorized —
  // absent means "not authorized to publish", the fail-closed default.
  publishAdmission?: {
    authorized: boolean;
    tools: string[];
    recordedAt: string;
  };
  /** H-VOICE: session-scoped Voice Card from draft → approved edit observations. */
  sessionVoiceProfile?: import('./voiceProfileService').SessionVoiceProfile;
  emailMetadata?: {
    senderEmail?: string;
    lastInboundEmailId?: string;
    lastOutboundEmailId?: string;
  }; // Email metadata for emma-email sessions
  resultEndpointMetadata?: {
    resultName: string;
    resultTitle?: string;
    leadEmail?: string;
    leadId?: string;
    externalSessionId?: string;
    reviewerEmail: string;
    skipReview?: boolean;
    outputFormat: 'html' | 'image' | 'video';
    args: Record<string, string>;
    contentUrl?: string;
    contentHtml?: string;
    contentSubject?: string;
    sendHistory?: Array<{
      assetUrl: string;
      recipientEmail: string;
      customMessage?: string;
      sentAt: string;
    }>;
  };
  slackThread?: {
    channel: string;
    threadTs: string;
  }; // Slack thread association for in-thread Q&A
  llmModel?: string; // Selected LLM model for this session
  /**
   * ENG-669: who chose `llmModel`. 'user' = a person picked it (picker, request, a user-authored pin);
   * 'system' = AgentWeb stamped it (a configured default, an admin-authored plan pin, a task-type model).
   * Additive and optional: absent on older sessions (see storedModelSource for how those are read).
   * The tier model allowlist checks a user's choice; a system stamp is AgentWeb's choice and is exempt.
   */
  llmModelSource?: 'user' | 'system';
  llmUsagePolicyDecision?: {
    requestedModel: string | null;
    effectiveModel: string | null;
    backupModel: string | null;
    backupSource: 'user' | 'system' | null;
    modelSelection: 'honored' | 'corrected' | 'defaulted' | 'blocked';
    modelSelectionReason: string;
    usageMode: 'full_choice' | 'optimized' | 'paused';
    usagePolicyVersion: string | null;
    // ENG-669 PR-C: present when the selection was the AgentWeb Model (`requestedModel`): the router's provenance for
    // the concrete `effectiveModel` that ran. The session's llmModel keeps the selection.
    routedVia?: 'agentweb-model';
    routingReason?: string;
    tableVersion?: string;
    recordedAt: string;
  };
  delegateInfo?: {
    adminUserId: string;
    adminEmail: string;
    isDelegated: boolean;
  }; // Delegate access info when admin is acting on behalf of a user
  associatedSkills?: string[]; // List of skill IDs associated for this session
  // Incremental asset cache for fast Images/Videos/Reports page loading
  assetCache?: {
    images: Array<{ url: string; filename: string; generatedAt: string }>;
    videos: Array<{ url: string; filename: string; generatedAt: string }>;
    htmlReports: Array<{ url: string; filename: string; generatedAt: string; searchableText?: string; reportType?: 'creative' | 'research' | 'performance' }>;
  };
  assetScanIndex?: number;   // messageIndex up to which we've scanned (exclusive)
  messageCount?: number;      // total messages in AW-ChatMessages for this session
  satisfactionScore?: {
    score: number;              // 1-5 (1=unsatisfied, 5=very satisfied)
    reason: string;             // LLM-generated explanation
    evaluatedAt: string;        // ISO timestamp
    evaluatedMessageIndex: number; // messageIndex up to which we evaluated
    adminOverride?: boolean;    // When true, auto-scoring skips this session
    dimensions?: {
      goalCompletion: number;   // 1-5: did the assistant accomplish what was asked?
      dataAccuracy: number;     // 1-5: plausible/consistent data, no hallucinations?
      outputQuality: number;    // 1-5: well-structured, specific, actionable output?
      // ENG-1312: optional — a session scored before this shipped, or by a
      // stale custom judge prompt, simply omits these.
      concision?: number;               // 0-5: did reply length match the question/instruction?
      instructionCompliance?: number;   // 0-5: explicit instruction followed on first attempt?
      unnecessaryPermissionRequest?: boolean; // asked to confirm a safe (read-only/draft/test) action?
    };
    // ENG-929: the judge saw a shortened transcript (a very long run exceeded the
    // scoring context budget). The score is real but formed on partial context —
    // labelled rather than withheld, since withholding is what silently dropped
    // the longest sessions from satisfaction reporting.
    transcriptTruncated?: boolean;
  };
  judgeScores?: Record<string, {  // keyed by judge ID
    score: number;
    reason: string;
    evaluatedAt: string;
    evaluatedMessageIndex: number;
    judgeName: string;
    dimensions?: {
      goalCompletion: number;
      dataAccuracy: number;
      outputQuality: number;
      // ENG-1312: see satisfactionScore.dimensions above.
      concision?: number;
      instructionCompliance?: number;
      unnecessaryPermissionRequest?: boolean;
      // ENG-2189: binary criteria from the outcome rubric (shadow judge) only.
      arguedWithInstruction?: boolean;
      escalatedWhenNotRequired?: boolean;
      failedToEscalate?: boolean;
    };
    // ENG-2138: written by a shadow judge (sampled, never the primary score), with its model.
    shadow?: boolean;
    model?: string;
    // ENG-2138: first 12 hex chars of sha256(judge.systemPrompt); shadow scores only.
    promptVersion?: string;
  }>;
  // Scores retracted because the session turned out to be outside the
  // satisfaction cohort (zero-task — ENG-830). The original score is MOVED here
  // rather than deleted: consumers see an unscored session (which is the point),
  // but the retraction stays fully reversible and auditable.
  retractedSatisfactionScore?: ChatSession["satisfactionScore"] & { retractedAt?: string };
  retractedJudgeScores?: Record<string, NonNullable<ChatSession["judgeScores"]>[string] & { retractedAt?: string }>;
  sessionSummary?: {
    summary: string;        // LLM-generated summary of what was achieved
    evaluatedAt: string;    // ISO timestamp
    evaluatedMessageIndex: number; // messageCount at time of evaluation (for cache invalidation)
  };
  gtmWorkItem?: {
    planId: string;
    phaseId: string;
    workItemId: string;
  };
  // Incremental token usage and cost tracking for the session
  totalTokens?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  totalCost?: number; // Total estimated cost in USD
}

// Interface for context chunks
export interface ContextChunk {
  id: string;
  content: string;
  metadata: {
    source: string;
    taskId?: string;
    fileName?: string;
  };
}

// Helper function to split content into chunks
function splitIntoChunks(content: string): ContextChunk[] {
  // Clean the content first
  const cleanContent = extractContent(content);

  const chunks: ContextChunk[] = [];
  let chunkId = 0;

  // Split into paragraphs first
  const paragraphs = cleanContent.split(/\n+/);
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed chunk size
    if ((currentChunk + "\n" + paragraph).length > 2000) {
      // If current chunk is not empty, save it
      if (currentChunk.trim()) {
        chunks.push({
          id: `chunk-${chunkId++}`,
          content: currentChunk.trim(),
          metadata: { source: "page-content" },
        });
      }

      // If paragraph itself is too long, split it into sentences
      if (paragraph.length > 2000) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        let sentenceChunk = "";

        for (const sentence of sentences) {
          if ((sentenceChunk + sentence).length > 2000) {
            if (sentenceChunk.trim()) {
              chunks.push({
                id: `chunk-${chunkId++}`,
                content: sentenceChunk.trim(),
                metadata: { source: "page-content" },
              });
            }
            // If single sentence is too long, split by words
            if (sentence.length > 2000) {
              const words = sentence.split(/\s+/);
              let wordChunk = "";

              for (const word of words) {
                if ((wordChunk + " " + word).length > 2000) {
                  if (wordChunk.trim()) {
                    chunks.push({
                      id: `chunk-${chunkId++}`,
                      content: wordChunk.trim(),
                      metadata: { source: "page-content" },
                    });
                  }
                  wordChunk = word;
                } else {
                  wordChunk += " " + word;
                }
              }
              // Add remaining words if any
              if (wordChunk.trim()) {
                sentenceChunk = wordChunk;
              }
            } else {
              sentenceChunk = sentence;
            }
          } else {
            sentenceChunk += " " + sentence;
          }
        }
        // Add remaining sentences if any
        if (sentenceChunk.trim()) {
          currentChunk = sentenceChunk;
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? "\n" : "") + paragraph;
    }
  }

  // Add the last chunk if not empty
  if (currentChunk.trim()) {
    chunks.push({
      id: `chunk-${chunkId++}`,
      content: currentChunk.trim(),
      metadata: { source: "page-content" },
    });
  }

  return chunks;
}

// Helper function to find most relevant chunks for a query
async function findRelevantChunks(
  query: string,
  chunks: ContextChunk[],
  maxChunks: number = 3
): Promise<ContextChunk[]> {
  if (chunks.length === 0) return [];

  try {
    const meterCtx = { userId: currentRunFunding()?.ownerUserId, feature: 'embeddings' };
    const queryEmbedding = await embedText(query, meterCtx);
    if (!queryEmbedding) return keywordBasedChunkRetrieval(query, chunks, maxChunks);

    const chunkEmbeddings = await Promise.all(
      chunks.map(async (chunk) => {
        const embedding = await embedText(chunk.content, meterCtx);
        if (!embedding) throw new Error('Chunk embedding unavailable');
        return { chunk, embedding };
      })
    );

    // Calculate cosine similarity for each chunk
    const scoredChunks = chunkEmbeddings.map(({ chunk, embedding }) => {
      const similarity = calculateCosineSimilarity(queryEmbedding, embedding);
      return { chunk, similarity };
    });

    // Sort by similarity score and take top N
    scoredChunks.sort((a, b) => b.similarity - a.similarity);
    return scoredChunks.slice(0, maxChunks).map((item) => item.chunk);
  } catch (error) {
    console.error("Error finding relevant chunks:", error);

    // Fallback to basic keyword matching if embeddings fail
    return keywordBasedChunkRetrieval(query, chunks, maxChunks);
  }
}

// Simple cosine similarity calculation
function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Fallback keyword-based retrieval when embeddings are unavailable
function keywordBasedChunkRetrieval(
  query: string,
  chunks: ContextChunk[],
  maxChunks: number = 3
): ContextChunk[] {
  // Extract keywords from query
  const keywords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 3);

  if (keywords.length === 0) {
    // If no keywords, return first few chunks
    return chunks.slice(0, maxChunks);
  }

  // Score chunks by keyword matches
  const scoredChunks = chunks.map((chunk) => {
    const content = chunk.content.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
      // Count occurrences of keyword in chunk
      const regex = new RegExp(`\\b${keyword}\\b`, "g");
      const matches = content.match(regex);
      if (matches) {
        score += matches.length;
      }
    }

    return { chunk, score };
  });

  // Sort by score and take top N
  scoredChunks.sort((a, b) => b.score - a.score);
  return scoredChunks.slice(0, maxChunks).map((item) => item.chunk);
}

/**
 * Persisted audit of a Google Ads pre-flight tracking check (ENG-335), stored on
 * the chat/run record so a launch's measurement status is durable and auditable.
 */
/** ENG-941 — Meta counterpart of GoogleAdsMeasurementCheckRecord below. */
export interface MetaMeasurementCheckRecord {
  accountId: string;
  campaignId?: string;
  /**
   * Kept in step with `metaLaunchGate.ts`'s declaration of the same name — structural typing
   * means a field added there and not here still persists (DynamoDB is schemaless), so the
   * compiler will NOT catch the drift. It went missing once already, when the gate started
   * recording which ad a block was about.
   */
  adId?: string;
  creativeId?: string;
  action: string;
  outcome: 'passed' | 'blocked' | 'overridden';
  /** Per-destination check results (url + status + detected pixels). */
  urlResults: Array<{ url: string; status: string; mechanisms: string[]; error?: string }>;
  checkedAt: string;
}

export interface GoogleAdsMeasurementCheckRecord {
  customerId: string;
  campaignResourceName: string;
  action: string;
  /**
   * Overall outcome of the gate for this launch attempt.
   *
   * `passed_with_warning` (ENG-1358) is deliberately distinct from `passed`: the launch
   * was permitted, but the page carried only a GTM container or a GA4 property and no
   * Google Ads conversion tag. Collapsing the two would make the audit trail claim the
   * conversion path was verified when all we verified was that some Google tag exists.
   */
  outcome: 'passed' | 'passed_with_warning' | 'blocked' | 'overridden';
  /** Per-URL check results (url + status + detected mechanisms). */
  urlResults: Array<{ url: string; status: string; mechanisms: string[]; error?: string }>;
  checkedAt: string;
}

export class ChatbotDB {
  private tableName: string;
  private messagesTableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-ChatSessions`;
    this.messagesTableName = `${TABLE_PREFIX}AW-ChatMessages`;
  }

  async createChatSession(
    userId: string,
    pageContent?: string,
    portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar",
    pageIdentifier?: string,
    selectedStartupId?: string,
    workflowId?: string,
    executionId?: string,
    emailCampaignTaskId?: string,
    sessionType?: "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation" | "report_generation" | "result-endpoint" | "emma-email" | "meeting-intake",
    delegateInfo?: { adminUserId: string; adminEmail: string; isDelegated: boolean },
    initialState?: Partial<Pick<ChatSession, "llmModel" | "llmModelSource" | "associatedSkills" | "messages" | "archived" | "branchedFrom">>
  ): Promise<ChatSession> {
    const sessionId = uuidv4();
    const timestamp = new Date().toISOString();

    const selectedSystemMessage =
      portalType === "customer" ? getEmmaSystemContext() :
      portalType === "genius" ? geniusSystemMessage :
      portalType === "agent" ? null : // Agent Mode uses its own system prompt
      partnerSystemMessage;

    const chatSession: ChatSession = {
      sessionId,
      userId,
      title: 'New Chat Session', // Default title that will be updated after first message
      messages: selectedSystemMessage ? [
        {
          role: "system",
          content: selectedSystemMessage,
          metadata: {
            timestamp,
            knowledgeBaseChunks: knowledgeBase.length,
            portalType,
            pageIdentifier,
          },
        },
      ] : [],
      createdAt: timestamp,
      updatedAt: timestamp,
      adminListPartition: "all",
      portalType,
      pageIdentifier,
      selectedStartupId,
      workflowId,
      executionId,
      emailCampaignTaskId,
      sessionType: sessionType || "regular", // Default to regular if not specified
      delegateInfo, // Store delegate access info if provided
      ...(portalType === "agent" ? { associatedSkills: [] } : {}), // Initialize for agent sessions so skill enforcement applies
      ...initialState,
    };

    if (pageContent) {
      // Limit page content to first 100KB to stay under DynamoDB's 400KB limit
      const MAX_PAGE_CONTENT = 100000;
      chatSession.pageContent = pageContent.length > MAX_PAGE_CONTENT 
        ? pageContent.substring(0, MAX_PAGE_CONTENT) 
        : pageContent;

      // Create chunks but limit their total size
      const chunks = splitIntoChunks(chatSession.pageContent);
      let totalChunkSize = 0;
      const MAX_CHUNKS_SIZE = 100000; // 100KB for chunks
      chatSession.contextChunks = chunks.filter(chunk => {
        totalChunkSize += chunk.content.length;
        return totalChunkSize <= MAX_CHUNKS_SIZE;
      });

      // Add a more specific system message if pageContent and pageIdentifier are present
      chatSession.messages.push({
        role: "system",
        content: `Context initialized for page: ${
          pageIdentifier || "current page"
        }. Use relevant information from the page content.`,
        metadata: {
          timestamp,
          pageContentLength: chatSession.pageContent.length,
          knowledgeBaseChunks: knowledgeBase.length,
          portalType,
          pageIdentifier,
        },
      });
    }

    const params = {
      TableName: this.tableName,
      Item: chatSession,
    };

    try {
      await dynamodb.put(params).promise();
    } catch (error) {
      console.error("Error creating chat session:", error);
      throw error;
    }

    // Update lastActiveAt on the user — only for real user sessions, not admin delegate access
    // and not sandbox (eval_) principals, whose take-home sessions are not customer engagement (ENG-1907).
    // Fire-and-forget: don't fail session creation if this update fails.
    if (!delegateInfo?.isDelegated && !isEvaluationUser(userId)) {
      userDb.updateUser(userId, { lastActiveAt: timestamp }).catch((err) => {
        console.error(`Failed to update lastActiveAt for user ${userId}:`, err);
      });

      // CRM signal (B2): log an engagement.emma_session event on AW-ContactEvents.
      // Fire-and-forget, errors swallowed inside onEmmaSessionStart.
      void (async () => {
        try {
          const user = await userDb.getUserById(userId);
          const email = user?.email;
          if (!email) return;
          const { onEmmaSessionStart } = await import('./crmSignalHooks');
          await onEmmaSessionStart({
            sessionId,
            userId,
            email,
            portalType: portalType || null,
            sessionType: sessionType || 'regular',
            pageIdentifier: pageIdentifier || null,
            createdAt: timestamp,
          });
        } catch (err) {
          console.error('[chatbotService.createChatSession] CRM signal failed:', err);
        }
      })();
    }

    return chatSession;
  }

  /**
   * Bound a message to the per-item persistence budget.
   *
   * Check serialized item size in UTF-8 BYTES — covers both string content and
   * content-block arrays. DynamoDB's hard limit is 400KB per item; we use 350KB as a
   * safety margin. Bytes, not `.length`: JSON.stringify leaves non-ASCII literal, so
   * a CJK/emoji-heavy message is far bigger encoded than its character count.
   *
   * ENG-946: bound the WHOLE item, not just `content`. The final assistant turn of a
   * long run carries the run's tool-call ledger on `metadata.toolCalls`, which is
   * routinely 20x the answer — truncating `content` shed nothing, the item stayed
   * over 400KB, batchWrite threw, and the report was lost from the transcript while
   * the run still reported success. shrinkMessageForPersistence sheds the ledger
   * first and the answer last, and guarantees the item fits.
   *
   * ENG-1048: this lives here, rather than inline in one writer, because EVERY path
   * that writes a message item is subject to the same ceiling. ENG-946 guarded only
   * the append path, so the session→table migration, the repair pass and the
   * single-message update still wrote raw messages and still threw on an oversized one.
   *
   * Returns the ORIGINAL reference when the message already fits.
   */
  private fitMessageForPersistence(message: any, label: string): any {
    const serializedLen = Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8');
    const safeMessage = shrinkMessageForPersistence(message, MAX_MESSAGE_CONTENT_SIZE);
    if (safeMessage !== message) {
      console.warn(`${label} has oversized serialized size (${serializedLen} bytes), truncating to ${Buffer.byteLength(JSON.stringify(safeMessage) ?? '', 'utf8')} bytes`);
    }
    return safeMessage;
  }

  // Add messages to AW-ChatMessages table
  private async addMessagesToMessagesTable(sessionId: string, messages: ChatMessage[], startIndex: number): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    try {
      // Write messages in batches (DynamoDB batch write limit is 25 items)
      const batchSize = 25;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const writeRequests = batch.map((message, index) => {
          const safeMessage = this.fitMessageForPersistence(
            message,
            `Message ${startIndex + i + index} for session ${sessionId}`,
          );
          return {
            PutRequest: {
              Item: {
                sessionId,
                messageIndex: startIndex + i + index,
                message: safeMessage,
              },
            },
          };
        });

        let unprocessed: any = writeRequests;
        let retries = 0;
        const maxRetries = 3;

        while (unprocessed.length > 0 && retries <= maxRetries) {
          const params = {
            RequestItems: {
              [this.messagesTableName]: unprocessed,
            },
          };

          const result = await dynamodb.batchWrite(params).promise();
          unprocessed = result.UnprocessedItems?.[this.messagesTableName] || [];

          if (unprocessed.length > 0) {
            retries++;
            if (retries <= maxRetries) {
              // Exponential backoff before retry
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retries)));
            } else {
              console.error(`Failed to write ${unprocessed.length} messages after ${maxRetries} retries for session ${sessionId}`);
            }
          }
        }
      }
    } catch (error) {
      // If table doesn't exist yet, log and continue (table will be created later)
      if ((error as any).code === 'ResourceNotFoundException') {
        console.log(`ChatMessages table not found, skipping write for session ${sessionId}`);
        return;
      }
      console.error(`Error adding messages to messages table for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Atomically increment messageCount on the session record and update updatedAt.
   * updatedAt is ONLY updated here so it reflects the true last-message time,
   * not background metadata changes (scoring, title edits, share link access, etc.).
   */
  private async incrementMessageCount(sessionId: string, count: number): Promise<void> {
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'ADD messageCount :count SET updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':count': count,
          ':updatedAt': new Date().toISOString(),
        },
      }).promise();
    } catch (error) {
      // Non-critical: log but don't fail the message write
      console.error(`Error incrementing messageCount for session ${sessionId}:`, error);
    }
  }

  /**
   * Atomically increment totalTokens and totalCost on the session record.
   * Extracts usage from messages that have a usage field.
   */
  async incrementTokenUsage(sessionId: string, messages: ChatMessage[]): Promise<void> {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cost = 0;
    for (const msg of messages) {
      if (msg.usage) {
        promptTokens += msg.usage.prompt_tokens || 0;
        completionTokens += msg.usage.completion_tokens || 0;
        totalTokens += msg.usage.total_tokens || 0;
        cost += msg.usage.estimated_cost || 0;
      }
    }
    if (totalTokens === 0) return;

    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: `
          ADD totalCost :cost,
              #tt.prompt_tokens :pt,
              #tt.completion_tokens :ct,
              #tt.total_tokens :tot
        `,
        ExpressionAttributeNames: {
          '#tt': 'totalTokens',
        },
        ExpressionAttributeValues: {
          ':cost': cost,
          ':pt': promptTokens,
          ':ct': completionTokens,
          ':tot': totalTokens,
        },
      }).promise();
    } catch (error) {
      // If totalTokens map doesn't exist yet, initialize it
      if ((error as any).code === 'ValidationException') {
        try {
          await dynamodb.update({
            TableName: this.tableName,
            Key: { sessionId },
            UpdateExpression: 'SET totalTokens = :tokens, totalCost = if_not_exists(totalCost, :zero) + :cost',
            ExpressionAttributeValues: {
              ':tokens': {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
              },
              ':cost': cost,
              ':zero': 0,
            },
          }).promise();
        } catch (initError) {
          console.error(`Error initializing token usage for session ${sessionId}:`, initError);
        }
      } else {
        console.error(`Error incrementing token usage for session ${sessionId}:`, error);
      }
    }
  }

  /**
   * Atomically add a tool-generated cost to the session's totalCost and toolCosts breakdown map.
   * Used when tools make their own LLM/API calls (e.g. LLMService, image gen, video gen).
   *
   * Two DynamoDB calls are required: DynamoDB cannot initialize a map and increment a nested key
   * in a single expression — SET processes before ADD within a request, so the map is guaranteed
   * to exist when the nested ADD runs.
   */
  async addToolCostToSession(sessionId: string, cost: number, toolName: string): Promise<void> {
    if (cost <= 0) return;
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'SET toolCosts = if_not_exists(toolCosts, :emptyMap) ADD totalCost :cost',
        ExpressionAttributeValues: { ':emptyMap': {}, ':cost': cost },
      }).promise();
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'ADD toolCosts.#tool :cost',
        ExpressionAttributeNames: { '#tool': toolName },
        ExpressionAttributeValues: { ':cost': cost },
      }).promise();
    } catch (error) {
      console.error(`Error adding tool cost to session ${sessionId}:`, error);
    }
  }

  /**
   * Append a Google Ads pre-flight tracking check to the session's run record
   * (ENG-335). This is the durable audit trail so a launch decision — passed,
   * blocked, or explicitly overridden — and its per-URL measurement status can
   * never be silently hidden (e.g. by a later "0 conversions" report). Best-effort:
   * a persistence failure must never break the launch flow itself.
   */
  async recordGoogleAdsMeasurementCheck(
    sessionId: string,
    record: GoogleAdsMeasurementCheckRecord
  ): Promise<void> {
    if (!sessionId) return;
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression:
          'SET googleAdsMeasurementChecks = list_append(if_not_exists(googleAdsMeasurementChecks, :empty), :rec), updatedAt = :now',
        ExpressionAttributeValues: {
          ':empty': [],
          ':rec': [record],
          ':now': new Date().toISOString(),
        },
      }).promise();
    } catch (error) {
      console.error(`Error recording Google Ads measurement check for session ${sessionId}:`, error);
    }
  }

  /**
   * Append a Meta pre-flight tracking check to the session's run record (ENG-941).
   * Same audit contract as recordGoogleAdsMeasurementCheck above: a launch decision —
   * passed, blocked, or explicitly overridden — and its per-destination measurement
   * status must survive, so a later "0 conversions" report can say the campaign was
   * never measurable instead of presenting a bare zero. Best-effort by design: a
   * persistence failure must never break the launch flow.
   */
  async recordMetaMeasurementCheck(
    sessionId: string,
    record: MetaMeasurementCheckRecord
  ): Promise<void> {
    if (!sessionId) return;
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression:
          'SET metaMeasurementChecks = list_append(if_not_exists(metaMeasurementChecks, :empty), :rec), updatedAt = :now',
        ExpressionAttributeValues: {
          ':empty': [],
          ':rec': [record],
          ':now': new Date().toISOString(),
        },
      }).promise();
    } catch (error) {
      console.error(`Error recording Meta measurement check for session ${sessionId}:`, error);
    }
  }

  async addMessageToSession(
    sessionId: string,
    message: ChatMessage
  ): Promise<ChatSession> {
    // ENG-510: the count-then-write below is a read-modify-write. Serialize it per session
    // so concurrent appends (e.g. parallel image-variant markers in one turn) can't read
    // the same count and Put to the same messageIndex, overwriting each other. Keyed by
    // session; different sessions still run concurrently. Shares the key with
    // addMessagesToSession so a mid-turn marker and the end-of-turn batch can't collide.
    return withKeyedMutex(`chat-append:${sessionId}`, async () => {
      // Check if session exists
      const currentSession = await this.getChatSession(sessionId);
      if (!currentSession) {
        throw new Error('Session not found');
      }

      // Get current message count from AW-ChatMessages
      const currentMessages = await this.getMessagesFromMessagesTable(sessionId);
      const currentMessageCount = currentMessages.length;

      const messageIndex = currentMessageCount;

      // Add message to AW-ChatMessages table
      await this.addMessagesToMessagesTable(sessionId, [message], messageIndex);

      // Atomically increment messageCount on the session record for asset cache tracking
      await this.incrementMessageCount(sessionId, 1);

      // Incrementally update token usage on the session
      await this.incrementTokenUsage(sessionId, [message]);

      // ENG-1134: NO per-user quota charge here. Persisting a message is not a
      // spend event — the LLM call that produced it already charged the counter
      // and wrote the ledger row at its metering chokepoint. Charging again here
      // double-billed every agent-mode turn (measured at exactly 2.000x cost).
      //
      // It also hid itself: `usage.total_tokens` is prompt+completion only, while
      // the real charge includes cache tokens (~73% of traffic), so the token
      // totals stayed plausible while the dollars silently doubled. And it wrote
      // no ledger row, breaking ENG-200's rule that nothing is deducted without
      // also being recorded. Charge where you record: at the call site.

      // ENG-1495: stamp messageIndex onto the returned message rather than the raw
      // reference -- this is the same id getMessagesFromMessagesTable would produce on
      // a fresh read, just computed once here instead of thrown away and re-derived
      // later. Lets callers (the /generate response, the session-message-appended
      // socket event) echo a stable id synchronously instead of only after a refetch.
      return {
        ...currentSession,
        messages: [...currentMessages, { ...message, messageIndex }],
      };
    });
  }

  async addMessagesToSession(
    sessionId: string,
    messages: ChatMessage[]
  ): Promise<ChatSession> {
    if (messages.length === 0) {
      return (await this.getChatSession(sessionId))!;
    }

    // ENG-510: serialize the read-modify-write per session (same key as
    // addMessageToSession) so a batched append can't race a concurrent marker append and
    // collide on messageIndex. See withKeyedMutex for the full rationale.
    return withKeyedMutex(`chat-append:${sessionId}`, async () => {
      // Check if session exists
      const currentSession = await this.getChatSession(sessionId);
      if (!currentSession) {
        throw new Error('Session not found');
      }

      // Get current message count from AW-ChatMessages
      const currentMessages = await this.getMessagesFromMessagesTable(sessionId);
      const currentMessageCount = currentMessages.length;

      const messageIndex = currentMessageCount;

      // Add messages to AW-ChatMessages table
      await this.addMessagesToMessagesTable(sessionId, messages, messageIndex);

      // Atomically increment messageCount on the session record for asset cache tracking
      await this.incrementMessageCount(sessionId, messages.length);

      // Incrementally update token usage on the session
      await this.incrementTokenUsage(sessionId, messages);

      // ENG-1134: no per-user quota charge here either — same reasoning as the
      // single-message path above. The batch variant double-charged identically.

      // ENG-1495: same reasoning as addMessageToSession above -- stamp messageIndex on
      // each returned message instead of the raw reference.
      return {
        ...currentSession,
        messages: [
          ...currentMessages,
          ...messages.map((m, i) => ({ ...m, messageIndex: messageIndex + i })),
        ],
      };
    });
  }

  // Update message feedback in AW-ChatMessages table
  async updateMessageFeedback(
    sessionId: string,
    messageIndex: number,
    feedback: MessageFeedback
  ): Promise<ChatMessage> {
    // Get the current message
    const params = {
      TableName: this.messagesTableName,
      Key: {
        sessionId,
        messageIndex,
      },
    };

    try {
      const result = await dynamodb.get(params).promise();
      if (!result.Item) {
        throw new Error('Message not found');
      }

      const currentMessage = result.Item.message as ChatMessage;

      // Update the message with feedback
      const updatedMessage: ChatMessage = {
        ...currentMessage,
        metadata: {
          ...currentMessage.metadata,
          timestamp: currentMessage.metadata?.timestamp || new Date().toISOString(),
          feedback,
        },
      };

      // Update the message in the table
      const updateParams = {
        TableName: this.messagesTableName,
        Key: {
          sessionId,
          messageIndex,
        },
        UpdateExpression: 'SET #message = :message',
        ExpressionAttributeNames: {
          '#message': 'message',
        },
        ExpressionAttributeValues: {
          // ENG-1048: adding feedback grows an item that may already sit at the ceiling.
          ':message': this.fitMessageForPersistence(
            updatedMessage,
            `Message ${messageIndex} feedback for session ${sessionId}`,
          ),
        },
        ReturnValues: 'ALL_NEW',
      };

      const updateResult = await dynamodb.update(updateParams).promise();
      return updateResult.Attributes?.message as ChatMessage;
    } catch (error) {
      console.error('Error updating message feedback:', error);
      throw error;
    }
  }

  // Get message count from AW-ChatMessages table (optimized for list views)
  private async getMessageCountFromMessagesTable(sessionId: string): Promise<number> {
    const params = {
      TableName: this.messagesTableName,
      KeyConditionExpression: "sessionId = :sessionId",
      ExpressionAttributeValues: {
        ":sessionId": sessionId,
      },
      Select: "COUNT",
    };

    try {
      // Paginate through all results (DynamoDB returns max 1MB per query, even for COUNT)
      let totalCount = 0;
      let lastKey: any = undefined;
      do {
        const result = await dynamodb.query({
          ...params,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {})
        } as any).promise();
        totalCount += result.Count || 0;
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
      return totalCount;
    } catch (error) {
      // If table doesn't exist yet, return 0
      if ((error as any).code === 'ResourceNotFoundException') {
        console.log(`ChatMessages table not found, returning 0 message count`);
        return 0;
      }
      console.error("Error getting message count from messages table:", error);
      throw error;
    }
  }

  // Get the first user message text for history list preview (lightweight — Limit:10)
  private async getSessionPreview(sessionId: string): Promise<string | null> {
    try {
      const result = await dynamodb.query({
        TableName: this.messagesTableName,
        KeyConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeValues: { ':sessionId': sessionId },
        ScanIndexForward: true,
        Limit: 20,
      }).promise();
      const firstUser = (result.Items || []).find((item: any) => item.message?.role === 'user');
      return firstUser ? (firstUser.message.content as string) || null : null;
    } catch {
      return null;
    }
  }

  /**
   * ENG-1819: the most recent REAL (not server-injected) user message's content, via a
   * bounded, reverse-sorted, paginated query — not a full `getChatSession` hydration. Used
   * by the work-plan auto-continuation stop-check, which needs to know whether the user's
   * last actual instruction asked to stop, without paying the cost of the full message-table
   * read/migration `getChatSession` performs (same reasoning as `getSessionPreview` and
   * `getChatSessionRecord` above). `sessionId`(HASH)+`messageIndex`(RANGE) makes
   * `ScanIndexForward: false` a direct, correct reverse-index read, not a scan.
   *
   * Excludes two known server-authored `role: 'user'` kinds, both INDISTINGUISHABLE from a
   * real user turn by role alone:
   *   - `metadata.kind === 'auto-continuation'` — the injected continuation directive itself
   *     (AUTO_WORK_PLAN_CONTINUATION_MESSAGE); without this, a stale "stop" verdict from an
   *     earlier round would keep re-triggering forever.
   *   - `metadata.autoDelegatedAnswer === true` — the runVerifiedChat auto-take breadcrumb
   *     ("[Full autonomy] Proceed with..."), persisted with no `kind` field at all
   *     (agentModeController.ts's resolveAwaitingUserQuestion). Missing this would let an
   *     auto-answered question mask a real earlier "stop" behind it.
   *
   * Paginated rather than a single fixed `Limit`: one response turn persists ONE row PER
   * TOOL CALL (agentModeController.ts's response-message persistence), so a single
   * tool-call-heavy autocomplete round — exactly this feature's own primary case — can
   * exhaust a small fixed limit before ever reaching the real user turn underneath it.
   * Still bounded (MAX_PAGES caps total read cost) rather than the unbounded
   * getMessagesFromMessagesTable paginate-everything approach.
   */
  async getMostRecentRealUserMessage(sessionId: string, consistentRead = false): Promise<{ content: string; timestamp?: string } | null> {
    const PAGE_SIZE = 25;
    const MAX_PAGES = 4;
    try {
      let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await dynamodb.query({
          TableName: this.messagesTableName,
          KeyConditionExpression: 'sessionId = :sessionId',
          ExpressionAttributeValues: { ':sessionId': sessionId },
          ScanIndexForward: false,
          Limit: PAGE_SIZE,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
          ...(consistentRead ? { ConsistentRead: true } : {}),
        }).promise();
        const realUser = (result.Items || []).find((item: any) =>
          item.message?.role === 'user'
          && item.message?.metadata?.kind !== 'auto-continuation'
          && item.message?.metadata?.autoDelegatedAnswer !== true
        );
        if (realUser?.message?.content) {
          return { content: realUser.message.content as string, timestamp: realUser.message?.metadata?.timestamp };
        }
        lastKey = result.LastEvaluatedKey as AWS.DynamoDB.DocumentClient.Key | undefined;
        if (!lastKey) break;
      }
      return null;
    } catch (error) {
      console.error(`ChatbotDB: getMostRecentRealUserMessage failed for session ${sessionId}:`, error);
      return null;
    }
  }

  // Get messages from AW-ChatMessages table
  async getMessagesFromMessagesTable(sessionId: string, consistentRead = false): Promise<ChatMessage[]> {
    const params = {
      TableName: this.messagesTableName,
      KeyConditionExpression: "sessionId = :sessionId",
      ExpressionAttributeValues: {
        ":sessionId": sessionId,
      },
      ScanIndexForward: true, // Sort by messageIndex ascending
      // ENG-510: default reads are eventually consistent — a caller that must see a marker
      // written moments earlier (e.g. the whole-turn-timeout recovery collecting the images
      // that just completed) can opt into a strongly consistent read so a fresh append is
      // never missed.
      ...(consistentRead ? { ConsistentRead: true } : {}),
    };

    try {
      // Paginate through all results (DynamoDB returns max 1MB per query)
      let allItems: any[] = [];
      let lastKey: any = undefined;
      do {
        const result = await dynamodb.query({
          ...params,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {})
        }).promise();
        if (result.Items) {
          allItems.push(...result.Items);
        }
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);

      if (allItems.length === 0) {
        return [];
      }
      // Extract messages and check if repair is needed in ONE pass (items already sorted asc by messageIndex)
      let shouldRepair = false;
      const messages = allItems.map((item) => {
          const msg = item.message;

          // Check if this message has broken tool results (during the same map iteration)
          // Only check repairable tool types to avoid unnecessary processing
          // Must match the detection logic in repairBrokenToolResults
          if (!shouldRepair && msg.role === 'assistant' && msg.metadata?.toolCalls) {
            shouldRepair = msg.metadata.toolCalls.some((tc: any) =>
              REPAIRABLE_TOOL_CALLS.includes(tc.name) &&
              (!tc.result || Object.keys(tc.result).length === 0 ||
               (!tc.result.imageUrl && !tc.result.videoUrl && tc.result.success === undefined))
            );
          }

          return {
            ...(msg as ChatMessage),
            messageIndex: item.messageIndex
          };
        });

      // Only repair if needed (no cost if messages are fine)
      if (shouldRepair) {
        await this.repairBrokenToolResults(sessionId, messages);
      }

      return messages;
    } catch (error) {
      // If table doesn't exist yet, return empty array
      if ((error as any).code === 'ResourceNotFoundException') {
        console.log(`ChatMessages table not found, returning empty messages`);
        return [];
      }
      console.error("Error getting messages from messages table:", error);
      throw error;
    }
  }

  /**
   * Lightweight method to get message statistics for a session without fetching full message content.
   * Uses ProjectionExpression to minimize read capacity and skips repair logic.
   * Tool call success/failure is determined from role='tool' messages:
   *   - Failed tool calls have content starting with "⚠️ Tool Error:"
   *   - All other tool messages are counted as successful
   */
  async getMessageStats(sessionId: string): Promise<{
    totalMessages: number;
    messagesByRole: Record<string, number>;
    messagesWithAttachments: number;
    messagesWithToolCalls: number;
    successfulToolCalls: number;
    failedToolCalls: number;
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    messagesWithTokenData: number;
  }> {
    const params = {
      TableName: this.messagesTableName,
      KeyConditionExpression: "sessionId = :sessionId",
      ExpressionAttributeValues: {
        ":sessionId": sessionId,
      },
      ProjectionExpression: "message.#r, message.#c, message.metadata.attachments, message.tool_calls, message.#u",
      ExpressionAttributeNames: {
        "#r": "role",
        "#c": "content",
        "#u": "usage",
      },
    };

    // Paginate through all results (DynamoDB returns max 1MB per query)
    let items: any[] = [];
    let lastKey: any = undefined;
    do {
      const result = await dynamodb.query({
        ...params,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {})
      }).promise();
      if (result.Items) {
        items.push(...result.Items);
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    const stats = {
      totalMessages: items.length,
      messagesByRole: { user: 0, assistant: 0, system: 0, tool: 0 } as Record<string, number>,
      messagesWithAttachments: 0,
      messagesWithToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      messagesWithTokenData: 0,
    };

    for (const item of items) {
      const msg = item.message;
      if (!msg) continue;

      const role = msg.role || "unknown";
      if (stats.messagesByRole[role] !== undefined) {
        stats.messagesByRole[role]++;
      }

      if (msg.metadata?.attachments && msg.metadata.attachments.length > 0) {
        stats.messagesWithAttachments++;
      }

      // Count tool calls from role='tool' messages (each one represents an executed tool call)
      if (role === 'tool') {
        stats.messagesWithToolCalls++;
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.startsWith('⚠️ Tool Error:') || content.includes('"success":false') || content.includes('"success": false')) {
          stats.failedToolCalls++;
        } else {
          stats.successfulToolCalls++;
        }
      }

      if (msg.usage) {
        stats.totalTokens += msg.usage.total_tokens || 0;
        stats.totalPromptTokens += msg.usage.prompt_tokens || 0;
        stats.totalCompletionTokens += msg.usage.completion_tokens || 0;
        stats.messagesWithTokenData++;
      }
    }

    return stats;
  }

  // Migrate messages from session record to AW-ChatMessages table
  private async migrateMessagesToMessagesTable(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (!messages || messages.length === 0) {
      return;
    }

    try {
      // Write messages in batches (DynamoDB batch write limit is 25 items)
      const batchSize = 25;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const writeRequests = batch.map((message, index) => ({
          PutRequest: {
            Item: {
              sessionId,
              messageIndex: i + index,
              // ENG-1048: same 400KB ceiling as the append path.
              message: this.fitMessageForPersistence(
                message,
                `Migrated message ${i + index} for session ${sessionId}`,
              ),
            },
          },
        }));

        const params = {
          RequestItems: {
            [this.messagesTableName]: writeRequests,
          },
        };

        await dynamodb.batchWrite(params).promise();
      }
      console.log(`Migrated ${messages.length} messages from session ${sessionId} to AW-ChatMessages`);

      // Set messageCount so asset cache tracking works correctly for migrated sessions
      await this.incrementMessageCount(sessionId, messages.length);
    } catch (error) {
      // If table doesn't exist yet, log and continue (table will be created later)
      if ((error as any).code === 'ResourceNotFoundException') {
        console.log(`ChatMessages table not found, skipping migration for session ${sessionId}`);
        return;
      }
      console.error(`Error migrating messages for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Repair broken tool results (from MCP PR #433 bug)
   * Assumes broken results have already been detected - updates the database to fix permanently
   */
  private async repairBrokenToolResults(sessionId: string, messages: ChatMessage[]): Promise<void> {
    console.log(`🔧 Repairing tool results for session ${sessionId}...`);

    // First, build a map of tool_call_id -> tool_name from assistant messages (only for repairable tools)
    const repairableToolCallIds = new Set<string>();
    messages.forEach((msg: any) => {
      if (msg.role === 'assistant' && msg.metadata?.toolCalls) {
        msg.metadata.toolCalls.forEach((tc: any) => {
          if (REPAIRABLE_TOOL_CALLS.includes(tc.name) && tc.id) {
            repairableToolCallIds.add(tc.id);
          }
        });
      }
    });

    // Build map of tool message content by tool_call_id (ONLY for repairable tools)
    // Extract URLs directly from content (HTML or text) instead of parsing JSON
    const toolMessageMap = new Map<string, string>();
    messages.forEach((message: any) => {
      if (message.role === 'tool' && message.tool_call_id && message.content) {
        // Skip tool messages that don't correspond to repairable tools
        if (!repairableToolCallIds.has(message.tool_call_id)) {
          return;
        }

        let contentStr = message.content;

        // If content is not a string, try to extract it
        if (typeof contentStr !== 'string') {
          if (contentStr.content && typeof contentStr.content === 'string') {
            contentStr = contentStr.content;
          } else {
            contentStr = JSON.stringify(contentStr);
          }
        }

        // Extract URL from content (supports both JSON strings and HTML)
        // Look for image/video URLs (S3, GCS, or other hosting)
        const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
        const matches = contentStr.match(urlRegex);

        if (matches && matches.length > 0) {
          // Use the first URL found
          toolMessageMap.set(message.tool_call_id, matches[0]);
        }
      }
    });

    // Track which messages need updating
    const messagesToUpdate: Array<{ messageIndex: number; message: ChatMessage }> = [];

    // Count broken tool calls (must match isEmpty logic below)
    let brokenToolCallCount = 0;
    messages.forEach((msg: any) => {
      if (msg.role === 'assistant' && msg.metadata?.toolCalls) {
        msg.metadata.toolCalls.forEach((tc: any) => {
          if (REPAIRABLE_TOOL_CALLS.includes(tc.name) &&
              (!tc.result || Object.keys(tc.result).length === 0 ||
               (!tc.result.imageUrl && !tc.result.videoUrl && tc.result.success === undefined))) {
            brokenToolCallCount++;
          }
        });
      }
    });
    console.log(`  Found ${brokenToolCallCount} broken tool call(s) to repair`);

    // Process each message and recover empty tool results
    messages.forEach((message: any, index: number) => {
      if (!message.metadata?.toolCalls || message.metadata.toolCalls.length === 0) {
        return;
      }

      let hasChanges = false;
      const updatedToolCalls = message.metadata.toolCalls.map((toolCall: any) => {
        // Skip tool calls that aren't in the repairable list
        if (!REPAIRABLE_TOOL_CALLS.includes(toolCall.name)) {
          return toolCall;
        }

        // Check if result is empty or missing imageUrl/videoUrl (must match detection logic)
        // Don't repair tool calls with success=false (they genuinely failed)
        const isEmpty = !toolCall.result ||
          Object.keys(toolCall.result).length === 0 ||
          (!toolCall.result.imageUrl && !toolCall.result.videoUrl && toolCall.result.success === undefined);

        if (isEmpty) {
          if (!toolCall.id || !toolMessageMap.has(toolCall.id)) {
            return toolCall;
          }

          const extractedUrl = toolMessageMap.get(toolCall.id);
          if (!extractedUrl) {
            return toolCall;
          }

          // Build minimal result with extracted URL
          const minimalResult: any = { success: true };

          if (toolCall.name === 'generate_image') {
            minimalResult.imageUrl = extractedUrl;
            // Extract filename from URL
            const urlParts = extractedUrl.split('/');
            minimalResult.filename = urlParts[urlParts.length - 1];
          } else if (toolCall.name === 'generate_video') {
            minimalResult.videoUrl = extractedUrl;
            // Extract filename from URL
            const urlParts = extractedUrl.split('/');
            minimalResult.filename = urlParts[urlParts.length - 1];
          } else {
            // This shouldn't happen since we filter by REPAIRABLE_TOOL_CALLS, but log just in case
            console.log(`  ⚠️  Tool type in whitelist but not handled: ${toolCall.name} (${toolCall.id})`);
            return toolCall;
          }

          hasChanges = true;
          return { ...toolCall, result: minimalResult };
        }

        return toolCall;
      });

      if (hasChanges) {
        // Update the message in place
        message.metadata.toolCalls = updatedToolCalls;

        // Track this message for database update (only if messageIndex is valid)
        if (message.messageIndex === undefined || message.messageIndex === null) {
          return;
        }

        const { messageIndex: _, ...messageWithoutIndex } = message;
        messagesToUpdate.push({
          messageIndex: message.messageIndex,
          message: messageWithoutIndex as ChatMessage
        });
      }
    });

    // Update the database with fixed messages (batch write)
    if (messagesToUpdate.length > 0) {
      // Deduplicate by messageIndex (keep the last occurrence)
      const dedupMap = new Map<number, { messageIndex: number; message: ChatMessage }>();
      messagesToUpdate.forEach(item => {
        dedupMap.set(item.messageIndex, item);
      });
      const deduplicatedMessages = Array.from(dedupMap.values());

      await this.updateMessagesInDatabase(sessionId, deduplicatedMessages);
      console.log(`  ✅ Repaired and saved ${deduplicatedMessages.length} message(s)`);
    }
  }

  /**
   * Update specific messages in the database (batch write)
   */
  private async updateMessagesInDatabase(
    sessionId: string,
    messages: Array<{ messageIndex: number; message: ChatMessage }>
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    // Batch write in chunks of 25 (DynamoDB limit)
    const batchSize = 25;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);

      const writeRequests = batch.map(({ messageIndex, message }) => ({
        PutRequest: {
          Item: {
            sessionId,
            messageIndex,
            // ENG-1048: a repaired message is subject to the same 400KB ceiling —
            // without this the repair pass throws on exactly the messages it exists to fix.
            message: this.fitMessageForPersistence(
              message,
              `Repaired message ${messageIndex} for session ${sessionId}`,
            )
          }
        }
      }));

      await dynamodb.batchWrite({
        RequestItems: {
          [this.messagesTableName]: writeRequests
        }
      }).promise();
    }
  }

  /**
   * Recover tool call results from tool messages when result is empty
   * This fixes the issue introduced in PR #433 (MCP implementation) where tool results
   * are stored in a nested format {content: ..., raw: ...} instead of directly
   * @deprecated Use repairBrokenToolResults instead (which also updates the database)
   */
  private recoverToolResultsFromMessages(messages: ChatMessage[]): ChatMessage[] {
    // Build a map of tool message content by tool_call_id
    const toolMessageMap = new Map<string, any>();

    messages.forEach((message: any) => {
      if (message.role === 'tool' && message.tool_call_id && message.content) {
        try {
          let toolResult = typeof message.content === 'string'
            ? JSON.parse(message.content)
            : message.content;

          // Handle nested structure from MCP: {content: "stringified JSON", raw: {...}}
          if (toolResult.content && typeof toolResult.content === 'string') {
            try {
              toolResult = JSON.parse(toolResult.content);
            } catch {
              // If parsing inner content fails, keep the outer result
            }
          }

          toolMessageMap.set(message.tool_call_id, toolResult);
        } catch {
          // If parsing fails, skip this tool message
        }
      }
    });

    // Process messages and recover empty tool results
    return messages.map((message: any) => {
      if (!message.metadata?.toolCalls || message.metadata.toolCalls.length === 0) {
        return message;
      }

      const updatedToolCalls = message.metadata.toolCalls.map((toolCall: any) => {
        // Check if result is empty or missing imageUrl/videoUrl
        // Don't repair tool calls with success=false (they genuinely failed)
        const isEmpty = !toolCall.result ||
          Object.keys(toolCall.result).length === 0 ||
          (!toolCall.result.imageUrl && !toolCall.result.videoUrl && toolCall.result.success === undefined);

        if (isEmpty && toolCall.id && toolMessageMap.has(toolCall.id)) {
          const toolResult = toolMessageMap.get(toolCall.id);

          // Extract only URL data to keep it minimal
          const minimalResult: any = {};

          if (toolCall.name === 'generate_image' || toolCall.name === 'upload_image') {
            if (toolResult.imageUrl) {
              minimalResult.success = toolResult.success !== false;
              minimalResult.imageUrl = toolResult.imageUrl;
              minimalResult.filename = toolResult.filename;
            }
          } else if (toolCall.name === 'generate_video' || toolCall.name === 'upload_video') {
            if (toolResult.videoUrl) {
              minimalResult.success = toolResult.success !== false;
              minimalResult.videoUrl = toolResult.videoUrl;
              minimalResult.filename = toolResult.filename;
            }
          }

          if (Object.keys(minimalResult).length > 0) {
            console.log(`Recovered empty tool result for ${toolCall.name} (${toolCall.id})`);
            return { ...toolCall, result: minimalResult };
          }
        }

        return toolCall;
      });

      return {
        ...message,
        metadata: {
          ...message.metadata,
          toolCalls: updatedToolCalls
        }
      };
    });
  }

  /**
   * Load the raw chat session record — ownership and metadata only — without
   * hydrating the message history or running the legacy message migration that
   * `getChatSession` performs.
   *
   * Use this for authorization checks (ENG-521): resolving the owner of a
   * caller-supplied sessionId must not cause that session's message table to be
   * read or migrated before the caller has been proven to own it.
   *
   * NOTE: `messages` on the returned record is the raw stored value (usually
   * absent for non-legacy sessions). Callers that need the real conversation
   * must use `getChatSession`.
   */
  async getChatSessionRecord(sessionId: string, consistentRead = false): Promise<ChatSession | null> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      ...(consistentRead ? { ConsistentRead: true } : {}),
    };

    try {
      const result = await dynamodb.get(params).promise();
      return concealActiveRun(result.Item as ChatSession) || null;
    } catch (error) {
      console.error("Error getting chat session record:", error);
      throw error;
    }
  }

  async getChatSession(sessionId: string, consistentRead = false): Promise<ChatSession | null> {
    const session = await this.getChatSessionRecord(sessionId, consistentRead);

    if (!session) {
      return null;
    }

    try {
      // Check if messages exist in AW-ChatMessages
      let messages = await this.getMessagesFromMessagesTable(sessionId, consistentRead);

      // If no messages in AW-ChatMessages but messages exist in session record, migrate them
      if (messages.length === 0 && session.messages && session.messages.length > 0) {
        console.log(`Migrating ${session.messages.length} messages from session record to AW-ChatMessages for session ${sessionId}`);
        await this.migrateMessagesToMessagesTable(sessionId, session.messages);
        messages = session.messages; // Use the migrated messages
      }

      // Remove messages from session object and replace with messages from messages table
      // This ensures we always return the correct format from the messages table
      const { messages: _, ...sessionWithoutMessages } = session;
      // activeRun is hidden (non-enumerable) on the record, so the spread drops it: carry it over, still hidden.
      const normalizedSession = carryConcealedActiveRun(session, {
        ...sessionWithoutMessages,
        messages,
      });

      // Normalize associatedSkills to string[] (handles DynamoDB Set wrapper)
      // Legacy sessions (pre-skills) have no associatedSkills field — preserve undefined
      // so downstream code can distinguish them from new sessions with associatedSkills: [].
      if (normalizedSession.associatedSkills && !Array.isArray(normalizedSession.associatedSkills)) {
        // DynamoDB Set wrapper: { values: [...], type: 'String' }
        if (typeof normalizedSession.associatedSkills === 'object' && 'values' in (normalizedSession.associatedSkills as any)) {
          normalizedSession.associatedSkills = (normalizedSession.associatedSkills as any).values;
        } else {
          normalizedSession.associatedSkills = Array.from(normalizedSession.associatedSkills as any);
        }
      }

      return normalizedSession as ChatSession;
    } catch (error) {
      console.error("Error getting chat session:", error);
      throw error;
    }
  }

  async addAssociatedSkills(sessionId: string, skillIds: string[]): Promise<void> {
    if (!skillIds || !skillIds.length) return;

    // Read-merge-write: read current skills, deduplicate, write back as a List.
    // Uses SET (not ADD/list_append) to handle both List and legacy Set attribute types.
    try {
      const session = await this.getChatSession(sessionId);
      const current: string[] = Array.isArray(session?.associatedSkills) ? session!.associatedSkills : [];
      const currentSet = new Set(current);
      const newSkills = skillIds.filter(id => !currentSet.has(id));
      if (newSkills.length === 0) return;

      const merged = [...current, ...newSkills];

      const params = {
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: "SET associatedSkills = :skills",
        ExpressionAttributeValues: {
          ":skills": merged,
        },
      };

      await dynamodb.update(params).promise();
    } catch (error) {
      console.error(`Error adding associated skills for session ${sessionId}:`, error);
      throw error;
    }
  }

  async getUserSessions(
    userId: string,
    portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar",
    limit?: number,
    sortDescending: boolean = true,
    lastEvaluatedKey?: string,
    pageIdentifier?: string,
    searchTerm?: string,
    sessionTypeFilter?: 'exclude-scheduled' | 'only-scheduled'
  ): Promise<{ sessions: ChatSession[], lastEvaluatedKey?: any }> {
    console.log(
      `Getting chat sessions for user: ${userId} from table: ${this.tableName}, portalType: ${portalType || 'all'}, limit: ${limit || 'unlimited'}${searchTerm ? `, search: "${searchTerm}"` : ''}`
    );

    const params: any = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };

    // Build filter expression
    const filterParts: string[] = [];
    if (portalType) {
      filterParts.push('portalType = :portalType');
      params.ExpressionAttributeValues[':portalType'] = portalType;
    }
    if (pageIdentifier) {
      filterParts.push('pageIdentifier = :pageIdentifier');
      params.ExpressionAttributeValues[':pageIdentifier'] = pageIdentifier;
    }
    if (searchTerm) {
      filterParts.push('(contains(#title, :searchTerm) OR contains(sessionSummary.#summary, :searchTerm))');
      params.ExpressionAttributeNames = { '#title': 'title', '#summary': 'summary' };
      params.ExpressionAttributeValues[':searchTerm'] = searchTerm;
    }
    if (sessionTypeFilter === 'exclude-scheduled') {
      // Live tab: drop scheduled cron runs so they don't flood the recency-
      // sorted page and starve interactive chats. attribute_not_exists keeps
      // legacy sessions written before sessionType existed (they're non-scheduled).
      filterParts.push('(attribute_not_exists(sessionType) OR sessionType <> :scheduledSessionType)');
      params.ExpressionAttributeValues[':scheduledSessionType'] = 'scheduled';
    } else if (sessionTypeFilter === 'only-scheduled') {
      // Scheduled tab: isolate scheduled cron runs.
      filterParts.push('sessionType = :scheduledSessionType');
      params.ExpressionAttributeValues[':scheduledSessionType'] = 'scheduled';
    }
    if (filterParts.length > 0) {
      params.FilterExpression = filterParts.join(' AND ');
    }

    // Add limit if specified
    if (limit) {
      params.Limit = limit;
    }

    // Add scan index forward for sorting (false = descending, true = ascending)
    // Note: DynamoDB UserIdIndex doesn't support sorting by updatedAt, so we'll sort in memory
    params.ScanIndexForward = false; // Always get in consistent order

    try {
      // Paginate internally until we have enough filtered results.
      // DynamoDB's Limit caps items *scanned*, not items *returned* after
      // FilterExpression is applied, so a single query may return far fewer
      // results than requested when many items are filtered out.
      const collected: ChatSession[] = [];
      let paginationKey: any = undefined;
      if (lastEvaluatedKey) {
        try {
          paginationKey = JSON.parse(lastEvaluatedKey);
        } catch (error) {
          console.error("Invalid lastEvaluatedKey format:", error);
          throw new Error("Invalid pagination key");
        }
      }

      const targetCount = limit || 200; // sensible upper bound when no limit set

      do {
        if (paginationKey) {
          params.ExclusiveStartKey = paginationKey;
        }
        const result = await dynamodb.query(params).promise();
        const items = ((result.Items as ChatSession[]) || []).map(concealActiveRun);
        collected.push(...items);
        paginationKey = result.LastEvaluatedKey;
      } while (paginationKey && collected.length < targetCount);

      let sessions = collected;

      console.log(
        `Found ${sessions.length} chat sessions for user: ${userId}`
      );

      // Filter out archived sessions
      sessions = sessions.filter(session => !session.archived);
      
      console.log(
        `Found ${sessions.length} non-archived chat sessions for user: ${userId}`
      );

      // Sort by updatedAt in memory (DynamoDB UserIdIndex doesn't support updatedAt sorting)
      if (sortDescending) {
        sessions = sessions.sort((a, b) => 
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      } else {
        sessions = sessions.sort((a, b) => 
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
        );
      }

      // Fetch messages from messages table for each session
      // This ensures message counts are accurate since messages are now stored separately
      const sessionsWithMessages = await Promise.all(
        sessions.map(async (session) => {
          try {
            // Get messages from AW-ChatMessages table
            let messages = await this.getMessagesFromMessagesTable(session.sessionId);

            // If no messages in AW-ChatMessages but messages exist in session record, migrate them
            if (messages.length === 0 && session.messages && session.messages.length > 0) {
              console.log(`Migrating ${session.messages.length} messages from session record to AW-ChatMessages for session ${session.sessionId}`);
              await this.migrateMessagesToMessagesTable(session.sessionId, session.messages);
              messages = session.messages; // Use the migrated messages
            }

            // Remove messages from session object and replace with messages from messages table
            const { messages: _, ...sessionWithoutMessages } = session;
            return {
              ...sessionWithoutMessages,
              messages,
            };
          } catch (error) {
            console.error(`Error fetching messages for session ${session.sessionId}:`, error);
            // If there's an error, return session with empty messages array
            const { messages: _, ...sessionWithoutMessages } = session;
            return {
              ...sessionWithoutMessages,
              messages: [],
            };
          }
        })
      );

      console.log(
        `Returning ${sessionsWithMessages.length} sorted chat sessions with messages for user: ${userId}`
      );

      return {
        sessions: sessionsWithMessages,
        lastEvaluatedKey: paginationKey
      };
    } catch (error) {
      console.error("Error getting user chat sessions:", error);
      throw error;
    }
  }

  /**
   * Get Emma (customer-portal) sessions for a user.
   * Filters server-side by pageIdentifier so Agent Mode sessions are excluded.
   * Returns lean session objects (no full message fetch) suitable for the history panel.
   */
  async getEmmaSessions(userId: string, limit: number = 20, pageId: string = 'customer-portal'): Promise<ChatSession[]> {
    const params: any = {
      TableName: this.tableName,
      IndexName: 'UserIdIndex',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'pageIdentifier = :pageIdentifier AND portalType <> :agentType AND (attribute_not_exists(archived) OR archived = :false)',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':pageIdentifier': pageId,
        ':agentType': 'agent',
        ':false': false,
      },
      ScanIndexForward: false,
    };

    const collected: ChatSession[] = [];
    let lastEvaluatedKey: any = undefined;

    // Paginate until we have enough results (DynamoDB Limit is scan limit, not result limit)
    do {
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      const result = await dynamodb.query(params).promise();
      const items = ((result.Items as ChatSession[]) || []).map(concealActiveRun);
      collected.push(...items);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey && collected.length < limit);

    // Sort by updatedAt descending and take top N
    const topSessions = collected
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);

    // Fetch first user message preview for each session in parallel
    const sessionsWithPreview = await Promise.all(
      topSessions.map(async (session) => {
        const previewText = await this.getSessionPreview(session.sessionId);
        return { ...session, previewText };
      })
    );

    return sessionsWithPreview;
  }

  /**
   * ENG-112: the NON-ARCHIVED branches of one chat family for one owner.
   *
   * Cost: ONE query over the existing UserIdIndex (no scan, no new GSI). DynamoDB bills a GSI query by the
   * items it reads, not by what survives the projection, so this reads the owner's whole index once, in
   * 1 MB pages; a typical user has <1000 sessions (a handful of pages). `maxPages` bounds the worst case and
   * `truncated` is exact: true only if a further matching branch exists beyond `maxBranches`, or `maxPages` stopped the walk with index left. The walk is newest-first, so a capped walk drops the OLDEST sessions.
   * The root session itself is NOT returned here (the caller already loads it).
   */
  async getBranchFamilySessions(
    userId: string,
    rootSessionId: string,
    opts: { maxBranches?: number; maxPages?: number } = {},
  ): Promise<{ branches: BranchFamilyMember[]; truncated: boolean }> {
    const maxBranches = opts.maxBranches ?? 49;
    const maxPages = opts.maxPages ?? 20;
    const branches: BranchFamilyMember[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await dynamodb.query({
        TableName: this.tableName,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ScanIndexForward: false, // newest first (like getUserSessions): a capped walk must keep the branches just made
        ExpressionAttributeValues: { ":userId": userId },
        ExpressionAttributeNames: { "#title": "title", "#archived": "archived" },
        ProjectionExpression: "sessionId, userId, #title, llmModel, messageCount, updatedAt, createdAt, branchedFrom, #archived",
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }).promise();
      for (const item of (result.Items ?? []) as Array<ChatSession>) {
        if (item.userId !== userId) continue; // defence in depth: never another owner's row
        if (item.archived) continue; // includes a branch still being copied (born archived)
        if (item.branchedFrom?.rootSessionId !== rootSessionId || item.sessionId === rootSessionId) continue;
        branches.push({
          sessionId: item.sessionId,
          title: item.title,
          llmModel: item.llmModel,
          messageCount: item.messageCount ?? 0,
          updatedAt: item.updatedAt,
          createdAt: item.createdAt,
          branchedFrom: item.branchedFrom,
        });
      }
      // One match beyond the cap proves there is more; otherwise keep walking until the index is exhausted.
      if (branches.length > maxBranches) return { branches: branches.slice(0, maxBranches), truncated: true };
      lastKey = result.LastEvaluatedKey;
      if (!lastKey) return { branches, truncated: false };
    }
    return { branches, truncated: true }; // page cap hit with LastEvaluatedKey still pending
  }

  /**
   * Explicit ratings (`feedbacks`) on sessions updated since `sinceIso`, for the account-health
   * classifier (ENG-2143). Reads only the `feedbacks` attribute. Returns null when the read would
   * exceed `maxPages`, so a heavy account reads as "not read" rather than as a partial answer.
   */
  async getRecentSessionFeedback(userId: string, sinceIso: string, maxPages = 5): Promise<MessageFeedback[] | null> {
    const ratings: MessageFeedback[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await dynamodb.query({
        TableName: this.tableName,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId AND updatedAt >= :since",
        ExpressionAttributeValues: { ":userId": userId, ":since": sinceIso },
        ProjectionExpression: "feedbacks",
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }).promise();
      for (const item of result.Items ?? []) {
        ratings.push(...Object.values((item.feedbacks ?? {}) as Record<string, MessageFeedback>));
      }
      lastKey = result.LastEvaluatedKey;
      if (!lastKey) return ratings;
    }
    return null;
  }

  /**
   * Get sessions metadata only (no messages loaded).
   * Used by getExecutionsWithAssets for fast asset loading via cache.
   */
  async getSessionsWithoutMessages(
    userId: string,
    portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar"
  ): Promise<ChatSession[]> {
    const params: any = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };

    if (portalType) {
      params.FilterExpression = 'portalType = :portalType';
      params.ExpressionAttributeValues[':portalType'] = portalType;
    }

    try {
      let allItems: ChatSession[] = [];
      let lastEvaluatedKey: any = undefined;

      do {
        if (lastEvaluatedKey) {
          params.ExclusiveStartKey = lastEvaluatedKey;
        }
        const result = await dynamodb.query(params).promise();
        allItems = allItems.concat(((result.Items as ChatSession[]) || []).map(concealActiveRun));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      // Filter out archived sessions
      let sessions = allItems.filter(session => !session.archived);

      // Return sessions with empty messages array (metadata only)
      return sessions.map(session => {
        const { messages: _, ...sessionWithoutMessages } = session;
        return {
          ...sessionWithoutMessages,
          messages: [],
        } as ChatSession;
      });
    } catch (error) {
      console.error("Error getting sessions without messages:", error);
      throw error;
    }
  }

  /**
   * Search assets (images, videos, HTML reports) across all agent mode sessions for a user.
   * Returns assets grouped by type with sessionId and session title for context.
   */
  async searchUserAssets(
    userId: string,
    type?: 'images' | 'videos' | 'htmlReports' | 'all',
    query?: string,
    favoritesOnly?: boolean,
    approvedOnly?: boolean
  ): Promise<Array<{
    url: string;
    filename: string;
    generatedAt: string;
    assetType: 'image' | 'video' | 'htmlReport';
    sessionId: string;
    sessionTitle: string;
    isFavorited: boolean;
    approvalStatus?: string;
  }>> {
    const sessions = await this.getSessionsWithoutMessages(userId, 'agent');
    const results: Array<{
      url: string;
      filename: string;
      generatedAt: string;
      assetType: 'image' | 'video' | 'htmlReport';
      sessionId: string;
      sessionTitle: string;
      isFavorited: boolean;
    }> = [];

    const assetTypeFilter = type === 'all' || !type ? null : type;
    const lowerQuery = query?.toLowerCase();

    for (const session of sessions) {
      if (session.archived) continue;

      // For sessions without a populated asset cache, scan messages inline so
      // S3-saved files (e.g. HTML reports from save_file) are discoverable.
      let cache = session.assetCache;
      if (!cache) {
        try {
          const messages = await this.getMessagesFromMessagesTable(session.sessionId);
          cache = scanMessagesForAssets(messages, session);
        } catch {
          continue;
        }
      }

      const sessionId = session.sessionId;
      const sessionTitle = session.title || 'Untitled session';
      const favorites = session.favorites ?? {};

      const pushAssets = (
        assets: Array<{ url: string; filename: string; generatedAt: string }>,
        assetType: 'image' | 'video' | 'htmlReport'
      ) => {
        for (const asset of assets) {
          if (lowerQuery && !asset.filename.toLowerCase().includes(lowerQuery) && !asset.url.toLowerCase().includes(lowerQuery)) continue;
          const isFavorited = !!favorites[asset.url];
          if (favoritesOnly && !isFavorited) continue;
          results.push({ ...asset, assetType, sessionId, sessionTitle, isFavorited });
        }
      };

      if (!assetTypeFilter || assetTypeFilter === 'images') pushAssets(cache.images ?? [], 'image');
      if (!assetTypeFilter || assetTypeFilter === 'videos') pushAssets(cache.videos ?? [], 'video');
      if (!assetTypeFilter || assetTypeFilter === 'htmlReports') pushAssets(cache.htmlReports ?? [], 'htmlReport');
    }

    // Sort newest first
    results.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

    if (!approvedOnly) {
      return results;
    }

    // Fetch approval statuses and filter to approved-only
    const assetUrls = results.map(r => r.url);
    const approvals = await approvalDb.getApprovalsByAssetUrls(assetUrls);
    const approvalMap = new Map(approvals.map(a => [a.assetUrl, a.status]));

    return results
      .map(r => ({ ...r, approvalStatus: approvalMap.get(r.url) }))
      .filter(r => r.approvalStatus === 'approved');
  }

  /**
   * Get messages starting from a given messageIndex (inclusive).
   * Used for delta scanning when asset cache needs updating.
   */
  async getMessagesFromIndex(sessionId: string, fromIndex: number): Promise<ChatMessage[]> {
    const params = {
      TableName: this.messagesTableName,
      KeyConditionExpression: "sessionId = :sessionId AND messageIndex >= :fromIndex",
      ExpressionAttributeValues: {
        ":sessionId": sessionId,
        ":fromIndex": fromIndex,
      },
      ScanIndexForward: true,
    };

    try {
      let allItems: any[] = [];
      let lastKey: any = undefined;
      do {
        const result = await dynamodb.query({
          ...params,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {})
        }).promise();
        if (result.Items) {
          allItems.push(...result.Items);
        }
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);

      return allItems.map((item) => ({
        ...(item.message as ChatMessage),
        messageIndex: item.messageIndex,
      }));
    } catch (error) {
      if ((error as any).code === 'ResourceNotFoundException') {
        return [];
      }
      console.error(`Error getting messages from index ${fromIndex} for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Update the asset cache on a session record.
   */
  async updateAssetCache(
    sessionId: string,
    assetCache: ChatSession['assetCache'],
    assetScanIndex: number
  ): Promise<void> {
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'SET assetCache = :cache, assetScanIndex = :scanIndex',
        ExpressionAttributeValues: {
          ':cache': assetCache,
          ':scanIndex': assetScanIndex,
        },
      }).promise();
    } catch (error) {
      // Non-critical: log but don't fail the request
      console.error(`Error updating asset cache for session ${sessionId}:`, error);
    }
  }

  /**
   * Persist searchableText values for specific htmlReport entries in a session's assetCache.
   * Uses a list_append / update approach: patches only the matching entries by URL.
   * Called after enrichHtmlReportsWithSearchableText to avoid repeated S3 fetches.
   */
  async persistSearchableTexts(
    sessionId: string,
    updates: Array<{ url: string; searchableText: string }>
  ): Promise<void> {
    if (updates.length === 0) return;

    try {
      // Fetch current assetCache, patch the matching entries, write back
      const result = await dynamodb.get({
        TableName: this.tableName,
        Key: { sessionId },
        ProjectionExpression: 'assetCache, assetScanIndex',
      }).promise();

      const item = result.Item as any;
      if (!item || !item.assetCache) return;

      const cache = item.assetCache as ChatSession['assetCache'];
      if (!cache) return;

      const updateMap = new Map(updates.map(u => [u.url, u.searchableText]));
      let changed = false;

      for (const report of cache.htmlReports || []) {
        const text = updateMap.get(report.url);
        if (text && !report.searchableText) {
          report.searchableText = text;
          changed = true;
        }
      }

      if (!changed) return;

      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'SET assetCache = :cache',
        ExpressionAttributeValues: { ':cache': cache },
      }).promise();
    } catch (error) {
      console.error(`Error persisting searchableTexts for session ${sessionId}:`, error);
    }
  }

  /**
   * Persist reportType values for specific htmlReport entries in a session's assetCache.
   */
  async persistReportTypes(
    sessionId: string,
    updates: Array<{ url: string; reportType: 'creative' | 'research' | 'performance' }>,
    force = false
  ): Promise<void> {
    if (updates.length === 0) return;
    try {
      const result = await dynamodb.get({
        TableName: this.tableName,
        Key: { sessionId },
        ProjectionExpression: 'assetCache',
      }).promise();

      const item = result.Item as any;
      if (!item?.assetCache) return;

      const cache = item.assetCache as ChatSession['assetCache'];
      if (!cache) return;

      const updateMap = new Map(updates.map(u => [u.url, u.reportType]));
      let changed = false;

      for (const report of cache.htmlReports || []) {
        const type = updateMap.get(report.url);
        if (type && (force || !report.reportType)) {
          report.reportType = type;
          changed = true;
        }
      }

      if (!changed) return;

      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'SET assetCache = :cache',
        ExpressionAttributeValues: { ':cache': cache },
      }).promise();
    } catch (error) {
      console.error(`Error persisting reportTypes for session ${sessionId}:`, error);
    }
  }

  /**
   * Remove cached searchableText for a specific URL across all agent sessions for a user.
   * Called after saveHtmlContent overwrites an HTML file in-place at the same URL.
   */
  async clearSearchableTextByUrl(userId: string, url: string): Promise<void> {
    try {
      const sessions = await this.getSessionsWithoutMessages(userId, 'agent');
      await Promise.all(sessions.map(async (session) => {
        if (!session.assetCache) return;
        const reports = session.assetCache.htmlReports || [];
        const match = reports.find(r => r.url === url);
        if (!match || !match.searchableText) return;

        delete match.searchableText;
        await dynamodb.update({
          TableName: this.tableName,
          Key: { sessionId: session.sessionId },
          UpdateExpression: 'SET assetCache = :cache',
          ExpressionAttributeValues: { ':cache': session.assetCache },
        }).promise();
      }));
    } catch (error) {
      console.error(`Error clearing searchableText for url ${url}:`, error);
    }
  }

  async getUserSessionCount(userId: string, portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar"): Promise<number> {
    console.log(
      `Getting session count for user: ${userId} from table: ${this.tableName}, portalType: ${portalType || 'all'}`
    );

    const params: any = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      Select: "COUNT",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };

    // Add portal type filter if specified
    if (portalType) {
      params.FilterExpression = 'portalType = :portalType';
      params.ExpressionAttributeValues[':portalType'] = portalType;
    }

    try {
      const result = await dynamodb.query(params).promise();
      let sessions = (result.Items as ChatSession[]) || [];
      
      // Filter out archived sessions for accurate count
      sessions = sessions.filter(session => !session.archived);
      const count = sessions.length;
      
      console.log(
        `Found ${count} non-archived chat sessions for user: ${userId}`
      );
      return count;
    } catch (error) {
      console.error("Error getting user session count:", error);
      throw error;
    }
  }

  // Get archived sessions for admin management
  async getArchivedSessions(userId?: string, portalType?: "customer" | "partner" | "genius" | "agent" | "emma-sidebar"): Promise<ChatSession[]> {
    console.log(
      `Getting archived sessions from table: ${this.tableName}, userId: ${userId || 'all'}, portalType: ${portalType || 'all'}`
    );

    const params: any = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      FilterExpression: "archived = :archived",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":archived": true,
      },
    };

    // Add portal type filter if specified
    if (portalType) {
      params.FilterExpression += " AND portalType = :portalType";
      params.ExpressionAttributeValues[':portalType'] = portalType;
    }

    try {
      const result = await dynamodb.query(params).promise();
      const sessions = ((result.Items as ChatSession[]) || []).map(concealActiveRun);
      
      console.log(
        `Found ${sessions.length} archived chat sessions`
      );
      return sessions;
    } catch (error) {
      console.error("Error getting archived chat sessions:", error);
      throw error;
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET archived = :archived, adminListPartition = :adminListPartition",
      // ENG-2644: never upsert a ghost row for an unknown id.
      ConditionExpression: "attribute_exists(sessionId)",
      ExpressionAttributeValues: {
        ":archived": true,
        ":adminListPartition": "all",
      },
    };

    try {
      await dynamodb.update(params).promise();
    } catch (error) {
      console.error("Error archiving chat session:", error);
      throw error;
    }
  }

  /**
   * ENG-112: inverse of archiveSession. REMOVES the `archived` attribute (an ordinary session never has
   * one: every reader treats absent as live, `!session.archived` and `attribute_not_exists(archived) OR
   * archived = :false`), so a revealed branch carries no stored shape an ordinary session lacks.
   * Conditional on the row existing: an update on a deleted id would otherwise upsert a ghost row;
   * that case rejects with `code: 'ConditionalCheckFailedException'`. Used only by chat branching.
   */
  async unarchiveSession(sessionId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET adminListPartition = :adminListPartition REMOVE archived",
      ConditionExpression: "attribute_exists(sessionId)",
      ExpressionAttributeValues: {
        ":adminListPartition": "all",
      },
    };

    try {
      await dynamodb.update(params).promise();
    } catch (error) {
      console.error("Error unarchiving chat session:", error);
      throw error;
    }
  }

  /**
   * ENG-112 (self-heal of legacy branches): set `branchedFrom` on a session that has none, for its owner only.
   * One conditional write: the row must exist, belong to `ownerUserId` and carry no `branchedFrom` yet, so a
   * concurrent open is idempotent and an existing value is never overwritten. Touches nothing else (not
   * `updatedAt`: healing must not reorder the sidebar). Returns false when the condition refused the write.
   */
  async setBranchedFromIfAbsent(sessionId: string, ownerUserId: string, branchedFrom: BranchedFrom): Promise<boolean> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: "SET branchedFrom = :branchedFrom",
      ConditionExpression: "attribute_exists(sessionId) AND userId = :ownerUserId AND attribute_not_exists(branchedFrom)",
      ExpressionAttributeValues: {
        ":branchedFrom": branchedFrom,
        ":ownerUserId": ownerUserId,
      },
    };

    try {
      await dynamodb.update(params).promise();
      return true;
    } catch (error) {
      if ((error as { code?: string })?.code === "ConditionalCheckFailedException") return false;
      console.error("Error setting branchedFrom:", error);
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
    };

    try {
      await dynamodb.delete(params).promise();
    } catch (error) {
      console.error("Error deleting chat session:", error);
      throw error;
    }
  }

  async updatePageContext(
    sessionId: string,
    pageContent: string
  ): Promise<ChatSession> {
    // Create chunks for the new content
    const contextChunks = splitIntoChunks(pageContent);
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET pageContent = :pageContent, contextChunks = :contextChunks, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":pageContent": pageContent,
        ":contextChunks": contextChunks,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();

      // Add a system message to indicate content change with metadata
      await this.addMessageToSession(sessionId, {
        role: "system",
        content: `The user has navigated to a different page within the AgentWeb platform.`,
        metadata: {
          timestamp,
          pageContentLength: pageContent.length,
          knowledgeBaseChunks: knowledgeBase.length,
        },
      });

      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating page content:", error);
      throw error;
    }
  }

  async updateSessionSlackThread(
    sessionId: string,
    slackThread: { channel: string; threadTs: string }
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET slackThread = :slackThread",
      ExpressionAttributeValues: {
        ":slackThread": slackThread,
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session slackThread:", error);
      throw error;
    }
  }

  async updateSessionTitle(
    sessionId: string,
    title: string
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET title = :title, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":title": title,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session title:", error);
      throw error;
    }
  }

  /**
   * ENG-1332: guarded by default against clobbering an admin override. The
   * caller (scoreSessionIfNeeded) already skips adminOverride rows using the
   * session it read, but that read happens once before scoring — a concurrent
   * admin override written in between is a TOCTOU race the in-process check
   * can't catch. Pass `allowOverride: true` only for an explicit human
   * override write (the admin PUT route), which must be allowed to replace
   * anything, including a prior override.
   */
  async updateSessionSatisfactionScore(
    sessionId: string,
    satisfactionScore: ChatSession["satisfactionScore"],
    options?: { allowOverride?: boolean }
  ): Promise<ChatSession | null> {
    const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET satisfactionScore = :score",
      ExpressionAttributeValues: {
        ":score": satisfactionScore,
      },
      ReturnValues: "ALL_NEW",
    };

    if (!options?.allowOverride) {
      params.ConditionExpression = "attribute_not_exists(satisfactionScore.adminOverride)";
    }

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      // Lost the race: an admin override landed on this row after it was read
      // for scoring, so there is nothing to persist. Not an error — the row
      // still holds the human's score.
      if (!options?.allowOverride && this.isConditionalCheckFailure(error)) return null;
      console.error("Error updating session satisfaction score:", error);
      throw error;
    }
  }

  /**
   * Retract a previously persisted satisfaction score by ARCHIVING it.
   *
   * Used when a session is re-examined and turns out to be outside the
   * satisfaction cohort altogether (e.g. a zero-task session scored before that
   * exclusion existed — ENG-830). Scoring skips such sessions, so without an
   * explicit retraction the stale score would linger forever and keep inflating
   * the ≤3 cohort.
   *
   * The score is MOVED to `retractedSatisfactionScore` in the same atomic
   * update, never dropped. Consumers read `satisfactionScore` and correctly see
   * an unscored session, while the original stays recoverable — so a bulk
   * retraction that turns out to be wrong can be undone from the archive
   * instead of being an irreversible data loss.
   *
   * The write is a COMPARE-AND-SWAP against the score the caller actually read.
   * A sweep reads the session, decides it is out of the cohort, and only then
   * writes; an admin override or a fresh re-score can land in between, and an
   * unconditional REMOVE would destroy it. Losing that race is a no-op, not an
   * error — whoever wrote last owns the row, and the next sweep re-reads it.
   */
  async clearSessionSatisfactionScore(
    sessionId: string,
    previous: NonNullable<ChatSession["satisfactionScore"]>
  ): Promise<boolean> {
    const pin = this.pinTo("satisfactionScore", previous.evaluatedAt);
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: "SET retractedSatisfactionScore = :prev REMOVE satisfactionScore",
          // An admin override is human judgement and is never retracted, even
          // if it were written after the read that selected this snapshot.
          ConditionExpression: `${pin.expression} AND attribute_not_exists(satisfactionScore.adminOverride)`,
          ExpressionAttributeValues: {
            ":prev": { ...previous, retractedAt: new Date().toISOString() },
            ...pin.values(previous),
          },
        })
        .promise();
      return true;
    } catch (error) {
      // Lost the race: the row still holds a score, so the caller must keep its
      // in-memory copy rather than reporting the session as unscored.
      if (this.isConditionalCheckFailure(error)) return false;
      console.error("Error clearing session satisfaction score:", error);
      throw error;
    }
  }

  /**
   * The compare-and-swap pin for a retraction: what must still be true of the
   * persisted score for it to be the one the caller read.
   *
   * `evaluatedAt` is stamped fresh by every writer, so it identifies a specific
   * score. Without it — a legacy row — the only honest pin is the score object
   * itself: `attribute_exists` would survive a replacement write and let the
   * retraction archive the wrong score.
   */
  private pinTo(path: string, evaluatedAt?: string) {
    return evaluatedAt
      ? {
          expression: `${path}.evaluatedAt = :prevEvaluatedAt`,
          values: (_previous: any) => ({ ":prevEvaluatedAt": evaluatedAt }),
        }
      : {
          expression: `${path} = :prevSnapshot`,
          values: (previous: any) => ({ ":prevSnapshot": previous }),
        };
  }

  /**
   * A retraction whose ConditionExpression failed: the row moved on between the
   * read and the write, so there is nothing to retract. Distinct from a real
   * persistence failure, which must still surface.
   */
  private isConditionalCheckFailure(error: any): boolean {
    return (
      error?.code === "ConditionalCheckFailedException" ||
      error?.name === "ConditionalCheckFailedException"
    );
  }

  /** Judge-score counterpart of clearSessionSatisfactionScore (same archive semantics). */
  async clearSessionJudgeScore(
    sessionId: string,
    judgeId: string,
    previous: NonNullable<ChatSession["judgeScores"]>[string]
  ): Promise<boolean> {
    const names = { "#js": "judgeScores", "#rjs": "retractedJudgeScores", "#jid": judgeId };
    try {
      const archived = { ...previous, retractedAt: new Date().toISOString() };
      // Same compare-and-swap as clearSessionSatisfactionScore: only retract the
      // judge score this caller actually read, never a replacement written since.
      const { expression: condition, values } = this.pinTo("#js.#jid", previous.evaluatedAt);
      const pin = values(previous);
      try {
        await dynamodb
          .update({
            TableName: this.tableName,
            Key: { sessionId },
            UpdateExpression: "SET #rjs.#jid = :prev REMOVE #js.#jid",
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: { ":prev": archived, ...pin },
          })
          .promise();
      } catch (error: any) {
        // retractedJudgeScores map does not exist yet — create it, same pattern
        // as updateSessionJudgeScore. A lost race is not a missing map: rethrow
        // it so the outer catch can treat it as the no-op it is.
        if (this.isConditionalCheckFailure(error)) throw error;
        if (error.code !== "ValidationException") throw error;
        try {
          await dynamodb
            .update({
              TableName: this.tableName,
              Key: { sessionId },
              UpdateExpression: "SET #rjs = :map REMOVE #js.#jid",
              // Whole-map assignment, so it may only run while there is no map:
              // two first-time retractions can race into this branch together,
              // and without the guard the loser would erase the winner's archive.
              ConditionExpression: `attribute_not_exists(#rjs) AND ${condition}`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ":map": { [judgeId]: archived }, ...pin },
            })
            .promise();
        } catch (fallbackError: any) {
          if (!this.isConditionalCheckFailure(fallbackError)) throw fallbackError;
          // The map exists now (someone created it first), so the per-key write
          // works. If instead the judge score itself moved, this retry fails its
          // condition too and the outer catch reports the no-op.
          await dynamodb
            .update({
              TableName: this.tableName,
              Key: { sessionId },
              UpdateExpression: "SET #rjs.#jid = :prev REMOVE #js.#jid",
              ConditionExpression: condition,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ":prev": archived, ...pin },
            })
            .promise();
        }
      }
      return true;
    } catch (error) {
      if (this.isConditionalCheckFailure(error)) return false;
      console.error("Error clearing session judge score:", error);
      throw error;
    }
  }

  async updateSessionSummary(
    sessionId: string,
    sessionSummary: NonNullable<ChatSession["sessionSummary"]>
  ): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: "SET sessionSummary = :summary",
      ExpressionAttributeValues: {
        ":summary": sessionSummary,
      },
    };
    try {
      await dynamodb.update(params).promise();
    } catch (error) {
      console.error("Error updating session summary:", error);
      throw error;
    }
  }

  async updateSessionJudgeScore(
    sessionId: string,
    judgeId: string,
    judgeScore: NonNullable<ChatSession["judgeScores"]>[string]
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: "SET #js.#jid = :score",
      ExpressionAttributeNames: {
        "#js": "judgeScores",
        "#jid": judgeId,
      },
      ExpressionAttributeValues: {
        ":score": judgeScore,
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error: any) {
      // If judgeScores map doesn't exist yet, initialize it
      if (error.code === "ValidationException") {
        const initParams = {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: "SET judgeScores = :scores",
          ExpressionAttributeValues: {
            ":scores": { [judgeId]: judgeScore },
          },
          ReturnValues: "ALL_NEW",
        };
        const result = await dynamodb.update(initParams).promise();
        return result.Attributes as ChatSession;
      }
      console.error("Error updating session judge score:", error);
      throw error;
    }
  }

  async updateSessionPortalType(
    sessionId: string,
    portalType: "customer" | "partner" | "genius" | "agent" | "emma-sidebar"
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
      sessionId,
      },
      UpdateExpression: "SET portalType = :portalType, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":portalType": portalType,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session portal type:", error);
      throw error;
    }
  }

  async updateSessionStartupSelection(
    sessionId: string,
    selectedStartupId: string
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET selectedStartupId = :selectedStartupId, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":selectedStartupId": selectedStartupId,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session startup selection:", error);
      throw error;
    }
  }

  async updateSessionShareMetadata(
    sessionId: string,
    shareMetadata: { isShared: boolean; sharedAt?: string; expiresAt?: string }
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET shareMetadata = :shareMetadata, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":shareMetadata": shareMetadata,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session share metadata:", error);
      throw error;
    }
  }

  /**
   * Reassign a session to `newUserId`. With `expectedUserId`, the write only lands while the session
   * is still owned by that id (ENG-2653: an anonymous session moves to the account that proved it, and
   * a concurrent transfer cannot overwrite the winner); null means that condition failed.
   */
  async updateSessionUserId(
    sessionId: string,
    newUserId: string,
    expectedUserId?: string
  ): Promise<ChatSession | null> {
    // First, get the session to verify it exists
    const session = await this.getChatSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Update the userId
    const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET userId = :userId, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":userId": newUserId,
        ":adminListPartition": "all",
        ...(expectedUserId !== undefined ? { ":expectedUserId": expectedUserId } : {}),
      },
      ...(expectedUserId !== undefined ? { ConditionExpression: "userId = :expectedUserId" } : {}),
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      if (expectedUserId !== undefined && this.isConditionalCheckFailure(error)) return null;
      console.error("Error updating session userId:", error);
      throw error;
    }
  }

  async updateSessionInteractiveShareMetadata(
    sessionId: string,
    interactiveShareMetadata: { isActive: boolean; token?: string; sharedAt?: string; expiresAt?: string; allowSensitiveActions?: boolean }
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET interactiveShareMetadata = :interactiveShareMetadata, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":interactiveShareMetadata": interactiveShareMetadata,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session interactive share metadata:", error);
      throw error;
    }
  }

  /**
   * ENG-3170: set ONLY the owner's sensitive-actions choice on the link that is already there. Attribute level, not the whole map:
   * `updateSessionInteractiveShareMetadata` writes back whatever copy its caller read, so a caller holding a copy read a moment ago
   * (an email or alert that is only reusing the link) could write the previous choice back over the owner's change. The condition
   * keeps this from creating a half-made link on a session that has none.
   */
  async setInteractiveShareAllowSensitiveActions(sessionId: string, allowSensitiveActions: boolean): Promise<void> {
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: "SET interactiveShareMetadata.allowSensitiveActions = :allow",
        ConditionExpression: "attribute_exists(interactiveShareMetadata.#token)",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":allow": allowSensitiveActions },
      }).promise();
    } catch (error) {
      console.error("Error setting the sensitive-actions choice on the interactive share:", error);
      throw error;
    }
  }

  /** ENG-3170: remove ONLY the expiry from the existing link (attribute level, for the same reason as above). */
  async removeInteractiveShareExpiry(sessionId: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: "REMOVE interactiveShareMetadata.expiresAt",
        // ...and not off a link the owner turned on FULL CONTROL a moment ago (the caller decided from a copy that may be stale)
        ConditionExpression: "attribute_exists(interactiveShareMetadata.#token) AND (attribute_not_exists(interactiveShareMetadata.allowSensitiveActions) OR interactiveShareMetadata.allowSensitiveActions <> :on)",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":on": true },
      }).promise();
    } catch (error) {
      console.error("Error removing the expiry from the interactive share:", error);
      throw error;
    }
  }

  async updateSessionResultEndpointMetadata(
    sessionId: string,
    resultEndpointMetadata: {
      resultName: string;
      resultTitle?: string;
      leadEmail?: string;
      leadId?: string;
      externalSessionId?: string;
      reviewerEmail: string;
      skipReview?: boolean;
      outputFormat: 'html' | 'image' | 'video';
      args: Record<string, string>;
      contentUrl?: string;
      contentHtml?: string;
      contentSubject?: string;
      sendHistory?: Array<{
        assetUrl: string;
        recipientEmail: string;
        customMessage?: string;
        sentAt: string;
      }>;
    }
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: "SET resultEndpointMetadata = :resultEndpointMetadata, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":resultEndpointMetadata": resultEndpointMetadata,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session result endpoint metadata:", error);
      throw error;
    }
  }

  /**
   * ENG-1642: atomically claim a manifest-granted Meta write digest for
   * confirmation-free execution, at most once. A digest already present in
   * `consumedMetaWriteManifestDigests` means that exact write already ran
   * under this manifest — the caller must fall back to a normal confirmation
   * rather than executing again. Uses a single conditional DynamoDB update
   * (attribute_not_exists on the specific map key) so two concurrent
   * requests carrying the same digest cannot both win the claim — mirrors
   * the claimPreviewToken conditional-put pattern in
   * metaAudienceCampaignTokenStore.ts. Returns true only if THIS call
   * claimed it.
   */
  async claimMetaWriteManifestDigest(sessionId: string, digest: string): Promise<boolean> {
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression:
            'SET consumedMetaWriteManifestDigests.#digest = :consumedAt',
          // attribute_exists(sessionId) is REQUIRED, not optional belt-and-
          // braces (mirrors the identical guard on the workflowRun writer
          // above): the attribute_not_exists(...) checks alone are satisfied
          // identically whether the map/key is merely absent on an existing
          // row or the whole session item doesn't exist at all — DynamoDB's
          // conditional UpdateItem creates the item if missing. Without this,
          // a session deleted before/during this claim would silently upsert
          // a partial ChatSession row and let a retry return true, granting a
          // confirmation-free Meta write on a session that no longer exists.
          ConditionExpression:
            'attribute_exists(sessionId) AND (attribute_not_exists(consumedMetaWriteManifestDigests) OR attribute_not_exists(consumedMetaWriteManifestDigests.#digest))',
          ExpressionAttributeNames: { '#digest': digest },
          ExpressionAttributeValues: { ':consumedAt': new Date().toISOString() },
        })
        .promise();
      return true;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      // A DynamoDB map SET against a session with no existing
      // `consumedMetaWriteManifestDigests` attribute at all fails differently
      // ("document path does not exist") rather than the map-key condition
      // above — initialize the map on first use, then retry the claim once.
      // Guarded the same way: only initialize on a session that still exists.
      if (error?.code === 'ValidationException') {
        try {
          await dynamodb
            .update({
              TableName: this.tableName,
              Key: { sessionId },
              UpdateExpression:
                'SET consumedMetaWriteManifestDigests = if_not_exists(consumedMetaWriteManifestDigests, :empty)',
              ConditionExpression: 'attribute_exists(sessionId)',
              ExpressionAttributeValues: { ':empty': {} },
            })
            .promise();
        } catch (initError: any) {
          if (initError?.code === 'ConditionalCheckFailedException') return false;
          throw initError;
        }
        return this.claimMetaWriteManifestDigestRetry(sessionId, digest);
      }
      console.error('Error claiming Meta write manifest digest:', error);
      throw error;
    }
  }

  /** Single retry after map initialization — never recurses further. */
  private async claimMetaWriteManifestDigestRetry(sessionId: string, digest: string): Promise<boolean> {
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET consumedMetaWriteManifestDigests.#digest = :consumedAt',
          ConditionExpression: 'attribute_not_exists(consumedMetaWriteManifestDigests.#digest)',
          ExpressionAttributeNames: { '#digest': digest },
          ExpressionAttributeValues: { ':consumedAt': new Date().toISOString() },
        })
        .promise();
      return true;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      console.error('Error claiming Meta write manifest digest (retry):', error);
      throw error;
    }
  }

  /**
   * ENG-1974: record that the user declined a workplan recommendation via
   * "Keep chatting". Unlike claimMetaWriteManifestDigest, this is an
   * UNCONDITIONAL overwrite — re-declining the same recommendationId (e.g. a
   * retried request after a dropped response) is harmless and idempotent,
   * not an exactly-once claim like a Meta write. Same "SET the map key, and
   * on ValidationException init the map then retry once" shape as
   * claimMetaWriteManifestDigest because a fresh session's
   * declinedWorkPlanRecommendations attribute doesn't exist yet either.
   */
  async recordDeclinedWorkPlanRecommendation(
    sessionId: string,
    recommendationId: string,
    entry: { planId: string; planTitle: string; declinedAt: string },
  ): Promise<boolean> {
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET declinedWorkPlanRecommendations.#id = :entry',
          ConditionExpression: 'attribute_exists(sessionId)',
          ExpressionAttributeNames: { '#id': recommendationId },
          ExpressionAttributeValues: { ':entry': entry },
        })
        .promise();
      return true;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      if (error?.code === 'ValidationException') {
        try {
          await dynamodb
            .update({
              TableName: this.tableName,
              Key: { sessionId },
              UpdateExpression:
                'SET declinedWorkPlanRecommendations = if_not_exists(declinedWorkPlanRecommendations, :empty)',
              ConditionExpression: 'attribute_exists(sessionId)',
              ExpressionAttributeValues: { ':empty': {} },
            })
            .promise();
        } catch (initError: any) {
          if (initError?.code === 'ConditionalCheckFailedException') return false;
          throw initError;
        }
        return this.recordDeclinedWorkPlanRecommendationRetry(sessionId, recommendationId, entry);
      }
      console.error('Error recording declined work plan recommendation:', error);
      throw error;
    }
  }

  /** Single retry after map initialization — never recurses further. */
  private async recordDeclinedWorkPlanRecommendationRetry(
    sessionId: string,
    recommendationId: string,
    entry: { planId: string; planTitle: string; declinedAt: string },
  ): Promise<boolean> {
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET declinedWorkPlanRecommendations.#id = :entry',
          ConditionExpression: 'attribute_exists(sessionId)',
          ExpressionAttributeNames: { '#id': recommendationId },
          ExpressionAttributeValues: { ':entry': entry },
        })
        .promise();
      return true;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      console.error('Error recording declined work plan recommendation (retry):', error);
      throw error;
    }
  }

  /**
   * Persist the typed information a work-plan step is waiting for. The same
   * request is rendered as a chat card in the portal or as MCP elicitation;
   * persisting the channel-neutral form lets a reconnect resume safely.
   *
   * There is one human-input interruption at a time across both structured
   * interaction types. A second request must wait instead of racing to steal
   * the user's answer slot.
   */
  async updateSessionWorkPlanInputRequest(
    sessionId: string,
    pendingWorkPlanInput: WorkPlanInputRequest | null,
    opts?: { failIfAwaitingExists?: boolean; requireStillAwaiting?: string },
  ): Promise<ChatSession | null> {
    const guard = opts?.failIfAwaitingExists === true && pendingWorkPlanInput !== null;
    const requireStillAwaiting =
      typeof opts?.requireStillAwaiting === 'string' ? opts.requireStillAwaiting : undefined;

    const params: any = pendingWorkPlanInput
      ? {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET pendingWorkPlanInput = :pendingWorkPlanInput, adminListPartition = :adminListPartition',
          ExpressionAttributeValues: {
            ':pendingWorkPlanInput': pendingWorkPlanInput,
            ':adminListPartition': 'all',
          },
          ReturnValues: 'ALL_NEW',
        }
      : {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'REMOVE pendingWorkPlanInput',
          ReturnValues: 'ALL_NEW',
        };

    if (guard) {
      // ENG-1635/1644 PR2: collapsed from 3-way to 2-way — pendingUserQuestion
      // is no longer a live slot anything can populate (updateSessionAskUserQuestion
      // is deleted), so cross-checking it here would always be vacuously true.
      params.ConditionExpression = '(attribute_not_exists(pendingWorkPlanInput) OR pendingWorkPlanInput.#inputStatus <> :awaitingStatus) AND (attribute_not_exists(pendingApprovalDeck) OR pendingApprovalDeck.#deckStatus <> :awaitingStatus)';
      params.ExpressionAttributeNames = { '#inputStatus': 'status', '#deckStatus': 'status' };
      params.ExpressionAttributeValues[':awaitingStatus'] = 'awaiting';
    } else if (requireStillAwaiting) {
      params.ConditionExpression = 'pendingWorkPlanInput.requestId = :requestId AND pendingWorkPlanInput.#inputStatus = :awaitingStatus';
      params.ExpressionAttributeNames = { '#inputStatus': 'status' };
      params.ExpressionAttributeValues = {
        ...(params.ExpressionAttributeValues || {}),
        ':requestId': requireStillAwaiting,
        ':awaitingStatus': 'awaiting',
      };
    }

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      if ((guard || requireStillAwaiting) && (error as any)?.code === 'ConditionalCheckFailedException') {
        return null;
      }
      console.error('Error updating session work-plan input request:', error);
      throw error;
    }
  }

  /**
   * ENG-1635/1644: persist (or clear) the session's pending approval deck.
   * Unlike the two guards above, the deck has a 3-state lifecycle
   * (building -> awaiting -> answered), so its guards compose rather than
   * branch exclusively — pass any combination that applies to a given call
   * and the clauses AND together:
   *  - failIfAwaitingExists: the cross-slot guard (gap 6; collapsed from 3-way
   *    to 2-way, PR2) — refuses the write while pendingApprovalDeck OR
   *    pendingWorkPlanInput is already 'awaiting'. Used when FINALIZING a
   *    deck (building -> awaiting) — a deck still 'building' is not yet
   *    blocking anyone, so plain create/append calls never need this.
   *  - requireStillBuilding: optimistic-locked on the deck still being
   *    exactly this deckId and still 'building' — used by append (refuses a
   *    stale append after the deck was already finalized/cleared) and
   *    combined with failIfAwaitingExists for finalize (refuses a stale
   *    finalize of a deck that was already finalized or cleared out from
   *    under it).
   *  - requireStillAwaiting: optimistic-locked on the deck still being
   *    exactly this deckId and still 'awaiting' — used when persisting
   *    answers or clearing an abandoned deck, same shape as the other two
   *    updateSession* methods' identically-named option.
   */
  async updateSessionApprovalDeck(
    sessionId: string,
    pendingApprovalDeck: PendingApprovalDeck | null,
    opts?: { failIfAwaitingExists?: boolean; requireStillBuilding?: string; requireStillAwaiting?: string },
  ): Promise<ChatSession | null> {
    const crossSlotGuard = opts?.failIfAwaitingExists === true && pendingApprovalDeck !== null;
    const requireStillBuilding =
      typeof opts?.requireStillBuilding === 'string' ? opts.requireStillBuilding : undefined;
    const requireStillAwaiting =
      typeof opts?.requireStillAwaiting === 'string' ? opts.requireStillAwaiting : undefined;
    const anyGuard = crossSlotGuard || requireStillBuilding !== undefined || requireStillAwaiting !== undefined;

    const params: any = pendingApprovalDeck
      ? {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET pendingApprovalDeck = :pendingApprovalDeck, adminListPartition = :adminListPartition',
          ExpressionAttributeValues: {
            ':pendingApprovalDeck': pendingApprovalDeck,
            ':adminListPartition': 'all',
          },
          ReturnValues: 'ALL_NEW',
        }
      : {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'REMOVE pendingApprovalDeck',
          ReturnValues: 'ALL_NEW',
        };

    const clauses: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, any> = params.ExpressionAttributeValues || {};

    if (crossSlotGuard) {
      // ENG-1635/1644 PR2: collapsed from 3-way to 2-way — pendingUserQuestion
      // is no longer a live slot anything can populate.
      clauses.push('(attribute_not_exists(pendingApprovalDeck) OR pendingApprovalDeck.#dStatus <> :awaitingStatus)');
      clauses.push('(attribute_not_exists(pendingWorkPlanInput) OR pendingWorkPlanInput.#iStatus <> :awaitingStatus)');
      names['#dStatus'] = 'status';
      names['#iStatus'] = 'status';
      values[':awaitingStatus'] = 'awaiting';
    }
    if (requireStillBuilding) {
      clauses.push('pendingApprovalDeck.deckId = :requireBuildingDeckId');
      clauses.push('pendingApprovalDeck.#dStatus = :buildingStatus');
      names['#dStatus'] = 'status';
      values[':requireBuildingDeckId'] = requireStillBuilding;
      values[':buildingStatus'] = 'building';
    }
    if (requireStillAwaiting) {
      clauses.push('pendingApprovalDeck.deckId = :requireAwaitingDeckId');
      clauses.push('pendingApprovalDeck.#dStatus = :requireAwaitingStatus');
      names['#dStatus'] = 'status';
      values[':requireAwaitingDeckId'] = requireStillAwaiting;
      values[':requireAwaitingStatus'] = 'awaiting';
    }
    if (clauses.length > 0) {
      params.ConditionExpression = clauses.join(' AND ');
      params.ExpressionAttributeNames = names;
      params.ExpressionAttributeValues = values;
    }

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      if (anyGuard && (error as any)?.code === 'ConditionalCheckFailedException') {
        return null;
      }
      console.error('Error updating session approval deck:', error);
      throw error;
    }
  }

  /**
   * ENG-1635/1644 follow-up: persist (or clear) the retry-backstop counter for a
   * repeatedly-failing Meta write. Unconditional (no guard/condition) — this is
   * advisory bookkeeping for a UX backstop, not a security invariant, so a lost
   * race under last-write-wins is an acceptable tradeoff against the complexity
   * a real lock would add here.
   */
  async updateSessionLastFailedMetaWrite(
    sessionId: string,
    value: { signature: string; error: string; count: number; at: string } | null,
  ): Promise<ChatSession | null> {
    const params: any = value
      ? {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET lastFailedMetaWrite = :lastFailedMetaWrite',
          ExpressionAttributeValues: { ':lastFailedMetaWrite': value },
          ReturnValues: 'ALL_NEW',
        }
      : {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'REMOVE lastFailedMetaWrite',
          ReturnValues: 'ALL_NEW',
        };
    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error('Error updating session lastFailedMetaWrite:', error);
      throw error;
    }
  }

  /**
   * ENG-1635/1644 PR2: persist one entry in objectiveConfirmations, keyed by
   * objectiveKind. Unconditional SET (no attribute_not_exists guard, unlike
   * claimMetaWriteManifestDigest's at-most-once claim below) — two racing
   * legitimate human confirmations of the same objective are both valid, so
   * last-write-wins is a non-issue here, same reasoning
   * updateSessionLastFailedMetaWrite already relies on. Mirrors
   * claimMetaWriteManifestDigest's two-step "SET map.key, on
   * ValidationException init the map then retry" shape for a session with
   * no existing objectiveConfirmations map at all.
   */
  async updateSessionObjectiveConfirmation(
    sessionId: string,
    objectiveKind: string,
    value: { objective: string; answeredBy: 'user' | 'delegation'; at: string; quote?: string },
  ): Promise<void> {
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET objectiveConfirmations.#kind = :value',
          ExpressionAttributeNames: { '#kind': objectiveKind },
          ExpressionAttributeValues: { ':value': value },
        })
        .promise();
    } catch (error: any) {
      if (error?.code === 'ValidationException') {
        await dynamodb
          .update({
            TableName: this.tableName,
            Key: { sessionId },
            UpdateExpression: 'SET objectiveConfirmations = if_not_exists(objectiveConfirmations, :empty)',
            ExpressionAttributeValues: { ':empty': {} },
          })
          .promise();
        await dynamodb
          .update({
            TableName: this.tableName,
            Key: { sessionId },
            UpdateExpression: 'SET objectiveConfirmations.#kind = :value',
            ExpressionAttributeNames: { '#kind': objectiveKind },
            ExpressionAttributeValues: { ':value': value },
          })
          .promise();
        return;
      }
      console.error('Error updating session objectiveConfirmations:', error);
      throw error;
    }
  }

  /**
   * ENG-397: persist (or clear) the session's workflow run. Two guard modes,
   * mirroring updateSessionAskUserQuestion/updateSessionWorkPlanInputRequest:
   *  - failIfActiveExists: used by startWorkflow — refuses to start a new run
   *    while an existing one is still 'in_progress'/'blocked_on_parameter'
   *    (one active workflow run per session, matching the one-question/
   *    one-input-request invariants elsewhere on ChatSession).
   *  - requireVersion: used by every step-transition write — optimistic lock
   *    on WorkflowRunState.version. Caller passes the PRE-transition version;
   *    the condition checks the STORED version still matches before the new
   *    (already version+1'd) run overwrites it. Loses the race -> null, and
   *    the caller must re-read + recompute rather than trust its local object.
   */
  async updateSessionWorkflowRun(
    sessionId: string,
    workflowRun: WorkflowRunState | null,
    opts?: { failIfActiveExists?: boolean; requireVersion?: number },
  ): Promise<ChatSession | null> {
    const guard = opts?.failIfActiveExists === true && workflowRun !== null;
    const requireVersion = typeof opts?.requireVersion === 'number' ? opts.requireVersion : undefined;

    const params: any = workflowRun
      ? {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET workflowRun = :workflowRun, adminListPartition = :adminListPartition',
          ExpressionAttributeValues: { ':workflowRun': workflowRun, ':adminListPartition': 'all' },
          ReturnValues: 'ALL_NEW',
        }
      : {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: 'REMOVE workflowRun',
          ReturnValues: 'ALL_NEW',
        };

    if (guard) {
      // attribute_exists(sessionId) is REQUIRED here, not optional belt-and-
      // braces: attribute_not_exists(workflowRun) is satisfied identically
      // whether the field is merely absent on an existing row or the whole
      // session item doesn't exist at all — DynamoDB's conditional UpdateItem
      // creates the item if missing. Without this, a session deleted between
      // the caller's existence check and this write (or a caller that never
      // checked) would silently upsert a partial ChatSession row instead of
      // failing the guard.
      params.ConditionExpression =
        'attribute_exists(sessionId) AND (attribute_not_exists(workflowRun) OR workflowRun.#wStatus IN (:completedStatus, :failedStatus))';
      params.ExpressionAttributeNames = { '#wStatus': 'status' };
      params.ExpressionAttributeValues[':completedStatus'] = 'completed';
      params.ExpressionAttributeValues[':failedStatus'] = 'failed';
    } else if (requireVersion !== undefined) {
      params.ConditionExpression = 'workflowRun.runId = :requireRunId AND workflowRun.version = :requireVersion';
      params.ExpressionAttributeValues = {
        ...(params.ExpressionAttributeValues || {}),
        ':requireRunId': workflowRun?.runId,
        ':requireVersion': requireVersion,
      };
    }

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      if ((guard || requireVersion !== undefined) && (error as any)?.code === 'ConditionalCheckFailedException') {
        return null;
      }
      console.error('Error updating session workflow run:', error);
      throw error;
    }
  }

  async updateSessionWorkPlan(
    sessionId: string,
    workPlan: {
      title: string;
      steps: Array<{
        stepCount: number;
        title: string;
        description?: string;
        /** User-facing guidance shown when the customer expands this
         *  step in the customer-portal plan view. Surfaced through to
         *  DynamoDB so <HorizontalPlanProgress> can render it. */
        userInstructions?: string;
        status: 'pending' | 'completed' | 'skipped';
        completedAt?: string;
        /** ENG-1188: see the matching field on the read-side workPlan type above. */
        resolvedAt?: string;
        notes?: string;
        requiredFunctionCalls?: string[];
        skillIds?: string[];
        expectedAssetCount?: number;
        /** ENG-1331: see the matching field on the read-side workPlan type above. */
        expectedAssetCountTools?: string[];
        /** ENG-2378: see the matching field on the read-side workPlan type above. */
        model?: string;
        modelSource?: 'user' | 'system';
        inputRequest?: import('./agentMode/core/workPlanInputRequest').WorkPlanInputRequestInput;
      }>;
      createdAt: string;
      updatedAt: string;
      welcomeMessage?: string;
      autocomplete?: boolean;
      /** ENG-2378: see the matching fields on the read-side workPlan type above. */
      planDefaultModel?: string;
      launchModel?: string;
      launchModelSource?: 'user' | 'system';
      planDefaultModelSource?: 'user' | 'system';
      planAuthor?: 'user' | 'system';
      engineModel?: string;
      pickedModel?: string;
      /** ENG-1472: see the matching field on the read-side workPlan type above. */
      templatePlanId?: string;
      /** ENG-1811: see the matching field on the read-side workPlan type above. */
      pendingRequiredFunctionCalls?: string[];
    }
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    // Validate stepCount - must be sequential starting from 1 (index+1)
    assertSequentialStepCounts(workPlan.steps);

    const validatedWorkPlan = {
      ...workPlan,
      updatedAt: timestamp
    };

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET workPlan = :workPlan, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":workPlan": validatedWorkPlan,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session work plan:", error);
      throw error;
    }
  }

  async updateSessionGtmWorkItem(
    sessionId: string,
    gtmWorkItem: { planId: string; phaseId: string; workItemId: string }
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET gtmWorkItem = :gtmWorkItem, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":gtmWorkItem": gtmWorkItem,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session GTM work item:", error);
      throw error;
    }
  }

  async updateSessionLlmModel(
    sessionId: string,
    llmModel: string,
    policyDecision?: NonNullable<ChatSession['llmUsagePolicyDecision']>,
    // ENG-669: who chose this model (see ChatSession.llmModelSource). Like the decision, a stored source describes
    // the model it was written with, so a write without one REMOVES it rather than leaving a stale claim.
    source?: NonNullable<ChatSession['llmModelSource']>,
  ): Promise<ChatSession> {
    // A stored llmUsagePolicyDecision describes the specific model it was recorded
    // for. Changing llmModel without a fresh decision to match (task-type model
    // overrides, admin/plan model swaps, the picker PATCH endpoint) would otherwise
    // leave the OLD decision in place, now silently mismatched — e.g. llmModel
    // reporting "gemini-3.8-flash" while llmUsagePolicyDecision still claims
    // "openrouter/deepseek/deepseek-v4-flash" was "honored", even though every
    // actual turn ran on the latter. REMOVE it here so a session record can never
    // pair a decision with a model it doesn't describe; the next real turn through
    // resolveEffectiveModelForUser re-stamps a correct, matching pair anyway.
    const sets = ["llmModel = :llmModel"];
    const removes: string[] = [];
    if (policyDecision) sets.push("llmUsagePolicyDecision = :policyDecision");
    else removes.push("llmUsagePolicyDecision");
    if (source) sets.push("llmModelSource = :llmModelSource");
    else removes.push("llmModelSource");
    sets.push("adminListPartition = :adminListPartition");
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
      ExpressionAttributeValues: {
        ":llmModel": llmModel,
        ...(policyDecision ? { ":policyDecision": policyDecision } : {}),
        ...(source ? { ":llmModelSource": source } : {}),
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session LLM model:", error);
      throw error;
    }
  }

  /**
   * ENG-903: undo a plan-launch model write, but only if the session still holds the model
   * that launch wrote. A plain conditional UpdateItem on EXISTING attributes (no schema
   * change). If a user changed the model after the launch's write, the condition fails and
   * their choice is left alone (resolves false). A session that had NO explicit model gets
   * `REMOVE llmModel`, returning it to exactly its prior state instead of a stored default.
   * Resolves true when restored; rethrows any other failure.
   */
  async restoreSessionLlmModelIfUnchanged(
    sessionId: string,
    expectedModel: string,
    previous: {
      llmModel?: string;
      llmUsagePolicyDecision?: NonNullable<ChatSession['llmUsagePolicyDecision']>;
      llmModelSource?: ChatSession['llmModelSource'];
    },
  ): Promise<boolean> {
    const sets: string[] = [];
    const removes: string[] = [];
    const values: Record<string, any> = { ":planModel": expectedModel };
    if (previous.llmModel) {
      sets.push("llmModel = :prevModel");
      values[":prevModel"] = previous.llmModel;
    } else {
      removes.push("llmModel");
    }
    if (previous.llmUsagePolicyDecision) {
      sets.push("llmUsagePolicyDecision = :prevDecision");
      values[":prevDecision"] = previous.llmUsagePolicyDecision;
    } else {
      removes.push("llmUsagePolicyDecision");
    }
    if (previous.llmModelSource) {
      sets.push("llmModelSource = :prevSource");
      values[":prevSource"] = previous.llmModelSource;
    } else {
      removes.push("llmModelSource");
    }
    sets.push("adminListPartition = :adminListPartition");
    values[":adminListPartition"] = "all";
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
      ConditionExpression: "llmModel = :planModel",
      ExpressionAttributeValues: values,
    };
    try {
      await dynamodb.update(params).promise();
      return true;
    } catch (error: any) {
      if (error?.code === "ConditionalCheckFailedException" || error?.name === "ConditionalCheckFailedException") {
        return false;
      }
      console.error("Error restoring session LLM model:", error);
      throw error;
    }
  }

  /**
   * ENG-827: stamp the publish authorization a scheduled run was admitted under.
   *
   * The dispatch-time consent guard re-reads the SCHEDULE so a revocation bites
   * immediately, but a re-read alone is only half an answer: it would also let a
   * grant made while the run is in flight widen it, and publish content that was
   * generated by a run explicitly admitted as draft-only. Persisting the admitted
   * scope here gives the guard the other half to intersect against, so live state
   * can only ever narrow this run's rights.
   *
   * Throws on failure — the caller must downgrade the run to draft-only rather
   * than proceed with a permission it could not record.
   */
  async updateSessionPublishAdmission(
    sessionId: string,
    admission: { authorized: boolean; tools: string[] }
  ): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET publishAdmission = :publishAdmission, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":publishAdmission": {
          authorized: admission.authorized === true,
          tools: Array.isArray(admission.tools) ? admission.tools : [],
          recordedAt: new Date().toISOString(),
        },
        ":adminListPartition": "all",
      },
    };

    await dynamodb.update(params).promise();
  }

  /**
   * H-VOICE: persist session-scoped Voice Card metadata on AW-ChatSessions.
   * Schema extension per RFC H-VOICE (Harsha P0 epic #4) — requires Harsha sign-off
   * before upstream merge per CLAUDE.md persistent-data policy.
   */
  async updateSessionVoiceProfile(
    sessionId: string,
    profile: import('./voiceProfileService').SessionVoiceProfile,
  ): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: 'SET sessionVoiceProfile = :sessionVoiceProfile, adminListPartition = :adminListPartition',
      ExpressionAttributeValues: {
        ':sessionVoiceProfile': profile,
        ':adminListPartition': 'all',
      },
    };

    await dynamodb.update(params).promise();
  }

  async updateSessionError(
    sessionId: string,
    error: string,
    errorStack?: string
  ): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET #error = :error, #errorStack = :errorStack, adminListPartition = :adminListPartition",
      ExpressionAttributeNames: {
        "#error": "error",
        "#errorStack": "errorStack",
      },
      ExpressionAttributeValues: {
        ":error": error,
        ":errorStack": errorStack || null,
        ":adminListPartition": "all",
      },
    };

    try {
      await dynamodb.update(params).promise();
    } catch (updateError) {
      console.error("Error updating session error:", updateError);
      // Don't throw - we don't want error logging to fail the entire operation
    }
  }

  async updateSessionContextLimitReported(sessionId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: 'SET contextLimitReported = :val',
      ExpressionAttributeValues: { ':val': true },
    };
    try {
      await dynamodb.update(params).promise();
    } catch (updateError) {
      console.error('Error setting contextLimitReported flag:', updateError);
    }
  }

  async updateSessionFeedbacks(
    sessionId: string,
    feedbacks: Record<string, MessageFeedback>
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET feedbacks = :feedbacks, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":feedbacks": feedbacks,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session feedbacks:", error);
      throw error;
    }
  }

  async updateSessionPublishStatuses(
    sessionId: string,
    publishStatuses: Record<string, string>
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: "SET publishStatuses = :publishStatuses",
      ExpressionAttributeValues: {
        ":publishStatuses": publishStatuses,
      },
      ReturnValues: "ALL_NEW" as const,
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session publish statuses:", error);
      throw error;
    }
  }

  async updateSessionEmailMetadata(
    sessionId: string,
    metadata: {
      senderEmail?: string;
      lastInboundEmailId?: string;
      lastOutboundEmailId?: string;
    }
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET emailMetadata = :emailMetadata, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":emailMetadata": metadata,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session email metadata:", error);
      throw error;
    }
  }

  /**
   * ENG-1698 hardening: calledFunctions previously had multiple independent
   * read-modify-write writers (increment per tool-dispatch batch, reset on new
   * plan, decrement on step completion/skip) with no concurrency guard, so a
   * writer computing its new value from a stale read could silently undo a
   * concurrent writer's change (e.g. a reset landing between another request's
   * read and write resurrects the exact stale credit the reset just cleared).
   * This helper closes that gap with optimistic locking on `calledFunctionsVersion`:
   * every writer re-reads fresh state and recomputes its mutation on conflict
   * instead of blindly overwriting.
   */
  async mutateCalledFunctions(
    sessionId: string,
    mutate: (current: Record<string, number>) => Record<string, number>,
    maxAttempts = 5
  ): Promise<ChatSession> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Record-only read: this loop only needs calledFunctions/calledFunctionsVersion,
      // so avoid getChatSession's AW-ChatMessages query (and possible one-time
      // migration write) on every retry attempt.
      const session = await this.getChatSessionRecord(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const currentVersion = session.calledFunctionsVersion || 0;
      const nextCounts = mutate(session.calledFunctions || {});

      const params = {
        TableName: this.tableName,
        Key: {
          sessionId,
        },
        UpdateExpression:
          "SET calledFunctions = :calledFunctions, calledFunctionsVersion = :nextVersion, adminListPartition = :adminListPartition",
        ConditionExpression:
          "attribute_not_exists(calledFunctionsVersion) OR calledFunctionsVersion = :currentVersion",
        ExpressionAttributeValues: {
          ":calledFunctions": nextCounts,
          ":nextVersion": currentVersion + 1,
          ":currentVersion": currentVersion,
          ":adminListPartition": "all",
        },
        ReturnValues: "ALL_NEW",
      };

      try {
        const result = await dynamodb.update(params).promise();
        return result.Attributes as ChatSession;
      } catch (error: any) {
        if (error?.code === "ConditionalCheckFailedException" && attempt < maxAttempts - 1) {
          // Jittered backoff so multiple writers that just conflicted don't
          // immediately retry in lockstep and re-collide.
          const backoffMs = 20 * Math.pow(2, attempt) + Math.random() * 20;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        console.error("Error mutating called functions:", error);
        throw error;
      }
    }
    throw new Error(`mutateCalledFunctions: exhausted retries for session ${sessionId}`);
  }

  async incrementCalledFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    return this.mutateCalledFunctions(sessionId, (current) => {
      const updatedCounts = { ...current };
      for (const [functionName, count] of Object.entries(functionCounts)) {
        updatedCounts[functionName] = (updatedCounts[functionName] || 0) + count;
      }
      return updatedCounts;
    });
  }

  async incrementFailedFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    // Get current session to retrieve existing failedFunctions
    const session = await this.getChatSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Merge the new counts with existing counts
    const currentCounts = session.failedFunctions || {};
    const updatedCounts = { ...currentCounts };

    for (const [functionName, count] of Object.entries(functionCounts)) {
      updatedCounts[functionName] = (updatedCounts[functionName] || 0) + count;
    }

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET failedFunctions = :failedFunctions, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":failedFunctions": updatedCounts,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error incrementing failed functions:", error);
      throw error;
    }
  }

  // ENG-738: cap so a very long-lived session (the incident session ran 534
  // messages / ~2M tokens over two days) can't grow this list unboundedly —
  // FIFO eviction of the oldest entries once the cap is exceeded.
  private static readonly MAX_OPEN_RESEARCH_REQUESTS = 5;

  /**
   * Add newly-timed-out research/lookup requests and clear ones that were
   * just resolved by a later successful call of the same tool (ENG-738).
   * Uses getChatSessionRecord (metadata only) rather than getChatSession —
   * this field never depends on message history, so there's no reason to pay
   * for hydrating it on every timeout.
   */
  async recordOpenResearchRequests(
    sessionId: string,
    additions: OpenResearchRequest[],
    resolvedTools: string[]
  ): Promise<void> {
    if (additions.length === 0 && resolvedTools.length === 0) return;

    const record = await this.getChatSessionRecord(sessionId);
    if (!record) return; // session gone — nothing to track

    const resolvedSet = new Set(resolvedTools);
    const additionTools = new Set(additions.map((a) => a.tool));
    // A fresh failure for a tool supersedes any earlier open entry for that
    // tool (avoid nagging about the same tool with a stale topic), and a
    // resolution clears it outright.
    let updated = (record.openResearchRequests || []).filter(
      (r) => !resolvedSet.has(r.tool) && !additionTools.has(r.tool)
    );
    updated = [...updated, ...additions].slice(-ChatbotDB.MAX_OPEN_RESEARCH_REQUESTS);

    const params = {
      TableName: this.tableName,
      Key: { sessionId },
      UpdateExpression: "SET openResearchRequests = :openResearchRequests",
      ExpressionAttributeValues: {
        ":openResearchRequests": updated,
      },
    };

    try {
      await dynamodb.update(params).promise();
    } catch (error) {
      console.error("Error recording open research requests:", error);
      throw error;
    }
  }

  async decrementCalledFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    return this.mutateCalledFunctions(sessionId, (current) => {
      const updatedCounts = { ...current };
      for (const [functionName, count] of Object.entries(functionCounts)) {
        updatedCounts[functionName] = (updatedCounts[functionName] || 0) - count;
      }
      return updatedCounts;
    });
  }

  /**
   * ENG-1698: clamped decrement used when a step's required-call credit is
   * consumed (completed) or released (skipped without over-penalizing a later
   * step). Applies against a fresh read via mutateCalledFunctions rather than
   * a value the caller precomputed from a possibly-stale baseline.
   */
  async decrementCalledFunctionsClamped(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    return this.mutateCalledFunctions(sessionId, (current) => {
      const updatedCounts = { ...current };
      for (const [functionName, count] of Object.entries(functionCounts)) {
        const currentCount = updatedCounts[functionName] || 0;
        updatedCounts[functionName] = Math.max(0, currentCount - count);
      }
      return updatedCounts;
    });
  }

  async updateCalledFunctions(
    sessionId: string,
    calledFunctions: Record<string, number>
  ): Promise<ChatSession> {
    return this.mutateCalledFunctions(sessionId, () => calledFunctions);
  }

  // Common function to create or reuse interactive share for a session
  /**
   * Create (or reuse an existing active) interactive share for a session.
   *
   * `expirationDays` is only honored when a caller explicitly opts into a timed
   * expiry — currently just the human "share" dialog (createConversableShare),
   * which surfaces the 1–365 day dropdown. Machine-generated shares
   * (scheduled-chat, slack, email/CRM, alerts, revisions, result endpoints)
   * call this with no argument and must NOT get an expiry: they are
   * notification/report links a recipient may open days later, and the old
   * 7-day default silently 410'd thousands of them a week after creation.
   * Omitting `expiresAt` leaves the share governed solely by `isActive`
   * (see getInteractiveShareExpiresAt).
   *
   * No-expiry callers also strip an expiry off a reused token (one share/token
   * per session, first-writer-wins): if an admin review link (45d) or a legacy
   * 7d link was minted first, a later external send clears its `expiresAt` so the
   * mailed/posted link can never expire.
   */
  async createOrReuseInteractiveShare(
    sessionId: string,
    expirationDays?: number | null,
    options?: { allowSensitiveActions?: boolean },
  ): Promise<string> {
    try {
      // First, get the current session to check if it already has an interactive share
      const session = await this.getChatSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Treat only a positive expirationDays as a timed expiry. null/undefined
      // means "no expiry"; 0 or negative is also coerced to no-expiry rather than
      // minting an already-/instantly-expired link (which would silently 410 — the
      // exact outage this whole fix exists to prevent) if a future caller ever
      // wires a falsy value through.
      const hasTimedExpiry = expirationDays != null && expirationDays > 0;

      // ENG-3170: a link whose owner turned on FULL CONTROL keeps the expiry the owner chose (see below), so once that date has passed it is dead
      // and must not be handed out again by an alert, an email or a Slack post. It is treated as absent: the code below makes a new link
      // (off, unless the caller says otherwise). Any other expired-but-active link is, as before, made permanent by a no-expiry caller.
      // (An expiry that cannot be read counts as expired, as it does for the liveness check the visitor routes use.)
      const isExpiredFullControl = (share: { allowSensitiveActions?: unknown; expiresAt?: unknown } | undefined) =>
        share?.allowSensitiveActions === true && !!share.expiresAt && !(Date.parse(String(share.expiresAt)) > Date.now());
      let expiredFullControl = isExpiredFullControl(session.interactiveShareMetadata);
      if (expiredFullControl) {
        // The copy read above is eventually consistent, and the owner may have made a new link a moment ago (new token, new expiry). Before the link
        // is replaced, ask again with a consistent read: if the owner's new link is there, that is the link, and it is reused as it stands.
        try {
          const fresh = await this.getChatSessionRecord(sessionId, true);
          if (fresh?.interactiveShareMetadata) {
            session.interactiveShareMetadata = fresh.interactiveShareMetadata;
            expiredFullControl = isExpiredFullControl(fresh.interactiveShareMetadata);
          }
        } catch (refreshError) {
          console.error(`Error re-reading the interactive share for session ${sessionId} before replacing an expired link:`, refreshError);
        }
      }

      // Check if there's already an active interactive share
      if (session.interactiveShareMetadata?.isActive && session.interactiveShareMetadata?.token && !expiredFullControl) {
        // If this caller wants no timed expiry but the stored token carries one —
        // e.g. an admin review link (45d) or a legacy 7d link — strip it. Links
        // shared out via email/slack/oncall must never expire regardless of who
        // minted the token first.
        // ENG-3170: not off a link whose owner explicitly turned on FULL CONTROL. The owner chose that expiry for that power (the dialog shows it),
        // and an alert or email that merely reuses the link must not turn "full control for 7 days" into "full control for ever". Such a
        // mailed link stops working at the owner's chosen date, as any link the owner made with an expiry does.
        if (!hasTimedExpiry && session.interactiveShareMetadata.expiresAt && session.interactiveShareMetadata.allowSensitiveActions !== true) {
          // Best-effort: a failed strip must not lose the working ishare link
          // (the outer catch would otherwise downgrade it to a login-required
          // /agent-mode URL). Worst case the link keeps its existing expiry and
          // a later send strips it.
          try {
            // ENG-3170: attribute level, so nothing else on the link (the owner's sensitive-actions choice above all) is written back
            // from this copy, which may be a moment old.
            await this.removeInteractiveShareExpiry(sessionId);
          } catch (stripError) {
            console.error(`Error stripping expiry from reused interactive share for session ${sessionId}:`, stripError);
          }
        }
        // ENG-3170: an EXPLICIT choice (only the owner's share dialog passes one) is applied to the link that is already there, because
        // there is one token per session and "reuse untouched" would otherwise drop the owner's choice. Callers that pass no choice
        // (emails, Slack posts, alerts) never touch the setting, so sending a report can not switch an owner's "on" back to "off".
        // A failed write is not caught here: it goes to the catch below (the login-URL fallback, no share link), and the route that made
        // the choice re-reads the stored value before it answers.
        // The write is unconditional: `session` is an eventually consistent copy, and "it already says that" could be a stale reading.
        if (typeof options?.allowSensitiveActions === 'boolean') {
          await this.setInteractiveShareAllowSensitiveActions(sessionId, options.allowSensitiveActions);
        }
        const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
        return `${customerFrontendUrl}/ishare/${sessionId}?conversable=${session.interactiveShareMetadata.token}`;
      }

      // Create a new interactive share
      const crypto = require('crypto');
      const conversableToken = crypto.randomBytes(32).toString('hex');

      // Only write expiresAt when the caller explicitly requested a timed expiry.
      // ENG-3170: every new link stores an explicit choice. Off unless the caller (the owner's share dialog) says so, so a link that is
      // mailed, posted to Slack or raised in an alert never carries sensitive actions.
      const interactiveShareMetadata: { isActive: boolean; token: string; sharedAt: string; expiresAt?: string; allowSensitiveActions: boolean } = {
        isActive: true,
        token: conversableToken,
        sharedAt: new Date().toISOString(),
        allowSensitiveActions: options?.allowSensitiveActions === true,
      };
      if (hasTimedExpiry) {
        interactiveShareMetadata.expiresAt = new Date(Date.now() + (expirationDays as number) * 86400000).toISOString();
      }

      await this.updateSessionInteractiveShareMetadata(sessionId, interactiveShareMetadata);
      
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      return `${customerFrontendUrl}/ishare/${sessionId}?conversable=${conversableToken}`;
      
    } catch (error) {
      console.error(`Error creating or reusing interactive share for session ${sessionId}:`, error);
      // Fall back to regular agent-mode URL if share creation fails
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      return `${customerFrontendUrl}/agent-mode/${sessionId}`;
    }
  }

  async getAllSessions(): Promise<ChatSession[]> {
    let allSessions: ChatSession[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined =
      undefined;

    do {
      const params: AWS.DynamoDB.DocumentClient.ScanInput = {
        TableName: this.tableName,
        ExclusiveStartKey: lastEvaluatedKey,
        // Consider if a smaller limit per scan iteration is better for performance/memory
        // Limit: 1000 // Optional: Limit items per scan call, but loop will get all
      };

      try {
        const result = await dynamodb.scan(params).promise();
        if (result.Items) {
          allSessions = allSessions.concat((result.Items as ChatSession[]).map(concealActiveRun));
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } catch (error) {
        console.error("Error getting all chat sessions during scan:", error);
        throw error; // Or handle more gracefully
      }
    } while (lastEvaluatedKey);

    return allSessions;
  }

  async getRecentSessionsPage(
    limit: number,
    lastEvaluatedKey?: AWS.DynamoDB.DocumentClient.Key,
    timeRange?: { startTime: string; endTime: string }
  ): Promise<{
    sessions: ChatSession[];
    lastEvaluatedKey?: AWS.DynamoDB.DocumentClient.Key;
    // ENG-1332 (Greptile): the gap query's page cap can stop before reaching a
    // qualifying late-touched session, silently understating the requested
    // range. This says so, rather than leaving the caller to trust an
    // unqualified count.
    gapQueryTruncated?: boolean;
  }> {
    const expressionValues: Record<string, any> = {
      ":adminListPartition": "all",
    };

    let keyCondition = "adminListPartition = :adminListPartition";
    if (timeRange) {
      keyCondition += " AND updatedAt BETWEEN :start AND :end";
      expressionValues[":start"] = timeRange.startTime;
      expressionValues[":end"] = timeRange.endTime;
    }

    // When a time range is specified, fetch ALL sessions in the range by paginating
    // through DynamoDB pages. The BETWEEN condition already bounds the result set,
    // and downstream filtering (e.g. removing empty sessions) can significantly
    // reduce the count — so a single page with Limit may miss older sessions.
    if (timeRange) {
      const accumulated: ChatSession[] = [];
      let currentKey = lastEvaluatedKey;

      try {
        do {
          const params: AWS.DynamoDB.DocumentClient.QueryInput = {
            TableName: this.tableName,
            IndexName: "AdminUpdatedAtIndex",
            KeyConditionExpression: keyCondition,
            ExpressionAttributeValues: expressionValues,
            ScanIndexForward: false,
          };
          if (currentKey) {
            params.ExclusiveStartKey = currentKey;
          }

          const result = await dynamodb.query(params).promise();
          accumulated.push(...((result.Items as ChatSession[]) || []).map(concealActiveRun));
          currentKey = result.LastEvaluatedKey;
        } while (currentKey);

        // ENG-1332 follow-up: the query above is keyed on updatedAt, so a session
        // created inside the window but last touched AFTER timeRange.endTime (e.g.
        // its final message landed a few seconds past the window boundary, or this
        // window is being re-queried well after it closed) is invisible to it even
        // though it belongs in the requested range. Close that gap with a second
        // query over [endTime, now] — only sessions genuinely created in range are
        // kept from it, so it can't pull in unrelated later activity. DynamoDB
        // KeyConditionExpression allows only one condition per key, so BETWEEN
        // (inclusive both ends) is the only compound-range operator available;
        // BETWEEN is inclusive on both ends, so a session with updatedAt exactly
        // at endTime legitimately matches both this query and the primary one —
        // dedupe by sessionId against what the primary query already returned
        // (comparing the updatedAt strings directly is not reliable: DynamoDB
        // always stores full-millisecond ISO timestamps, but a caller-supplied
        // endTime without milliseconds, e.g. "...T14:00:00Z", would never
        // string-equal the stored value even though they name the same instant).
        // Skipped entirely when endTime is already at/after "now" (the common
        // daily-report case, where nothing can have updatedAt in the future), so
        // this adds no cost to the case the fix already handles.
        //
        // [endTime, now] is unbounded in principle (a stale/old window re-queried
        // much later can span months of unrelated activity), so this loop stops
        // once enough in-range sessions have been found to fill `limit` — the
        // final slice below never returns more than `limit` in-range sessions
        // anyway, so scanning further pages can't change the response, only add
        // cost.
        //
        // The `inRangeCount < limit` stop condition alone isn't enough: a
        // sparse stale range (few or no sessions actually created in it) can
        // never reach `limit` no matter how many pages are scanned, so it would
        // still walk every page through "now" one at a time. A hard page cap
        // bounds that case too — past this many pages, further scanning trades
        // an unbounded amount of latency for a small chance of catching one
        // more late-touched session, so this stops and logs instead.
        const nowIso = new Date().toISOString();
        let gapQueryTruncated = false;
        if (timeRange.endTime < nowIso) {
          const primarySessionIds = new Set(accumulated.map((s) => s.sessionId));
          let inRangeCount = accumulated.filter(
            (s) => s.createdAt && s.createdAt >= timeRange.startTime && s.createdAt <= timeRange.endTime
          ).length;
          const lateExpressionValues: Record<string, any> = {
            ":adminListPartition": "all",
            ":end": timeRange.endTime,
            ":now": nowIso,
          };
          const lateKeyCondition =
            "adminListPartition = :adminListPartition AND updatedAt BETWEEN :end AND :now";
          const MAX_GAP_QUERY_PAGES = 20;
          let lateKey: AWS.DynamoDB.DocumentClient.Key | undefined;
          let pageCount = 0;
          do {
            const lateParams: AWS.DynamoDB.DocumentClient.QueryInput = {
              TableName: this.tableName,
              IndexName: "AdminUpdatedAtIndex",
              KeyConditionExpression: lateKeyCondition,
              ExpressionAttributeValues: lateExpressionValues,
              ScanIndexForward: false,
            };
            if (lateKey) {
              lateParams.ExclusiveStartKey = lateKey;
            }

            const lateResult = await dynamodb.query(lateParams).promise();
            pageCount++;
            for (const session of ((lateResult.Items as ChatSession[]) || []).map(concealActiveRun)) {
              if (primarySessionIds.has(session.sessionId)) continue; // already covered by the primary query
              const createdAt = session.createdAt;
              if (createdAt && createdAt >= timeRange.startTime && createdAt <= timeRange.endTime) {
                accumulated.push(session);
                inRangeCount++;
              }
            }
            lateKey = lateResult.LastEvaluatedKey;
          } while (lateKey && inRangeCount < limit && pageCount < MAX_GAP_QUERY_PAGES);

          if (lateKey && pageCount >= MAX_GAP_QUERY_PAGES) {
            gapQueryTruncated = true;
            console.warn(
              `[chatbotService] getRecentSessionsPage: gap query hit its ${MAX_GAP_QUERY_PAGES}-page cap scanning [${timeRange.endTime}, ${nowIso}] for a sparse range — some late-touched in-range sessions past this point may be missing from this page`
            );
          }
        }

        // ENG-1332: the query above orders by updatedAt, not createdAt — a
        // historical session touched (but not created) during this window sorts
        // by that touch, and can outrank a session genuinely created in the
        // window if the touch is more recent. Re-prioritize before truncating:
        // sessions actually created within the requested range come first
        // (newest first), so the `limit` slice and any budget-bound consumer
        // (e.g. the sync scoring backfill) exhaust in-range coverage before
        // spending anything on out-of-range history.
        const inRange: ChatSession[] = [];
        const outOfRange: ChatSession[] = [];
        for (const session of accumulated) {
          const createdAt = session.createdAt;
          if (createdAt && createdAt >= timeRange.startTime && createdAt <= timeRange.endTime) {
            inRange.push(session);
          } else {
            outOfRange.push(session);
          }
        }
        inRange.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

        return {
          sessions: [...inRange, ...outOfRange].slice(0, limit),
          lastEvaluatedKey: undefined,
          gapQueryTruncated,
        };
      } catch (error) {
        console.error("Error getting chat sessions by time range:", error);
        throw error;
      }
    }

    // No time range: paginate until we have `limit` sessions or no more pages.
    // Each DynamoDB query page is capped at DYNAMO_PAGE_SIZE to stay within
    // response-size limits; we issue more pages if needed to honour large limits.
    const DYNAMO_PAGE_SIZE = 100;
    const accumulated: ChatSession[] = [];
    let currentKey = lastEvaluatedKey;

    try {
      do {
        const remaining = limit - accumulated.length;
        const params: AWS.DynamoDB.DocumentClient.QueryInput = {
          TableName: this.tableName,
          IndexName: "AdminUpdatedAtIndex",
          KeyConditionExpression: keyCondition,
          ExpressionAttributeValues: expressionValues,
          Limit: Math.min(DYNAMO_PAGE_SIZE, remaining),
          ScanIndexForward: false,
        };
        if (currentKey) {
          params.ExclusiveStartKey = currentKey;
        }

        const result = await dynamodb.query(params).promise();
        accumulated.push(...((result.Items as ChatSession[]) || []).map(concealActiveRun));
        currentKey = result.LastEvaluatedKey;
      } while (currentKey && accumulated.length < limit);

      return {
        sessions: accumulated.slice(0, limit),
        lastEvaluatedKey: currentKey,
      };
    } catch (error) {
      console.error("Error getting recent chat sessions:", error);
      throw error;
    }
  }

  async updateMessageInSession(sessionId: string, messageIndex: number, updatedMessage: ChatMessage): Promise<void> {
    try {
      // First get the current session
      const currentSession = await this.getChatSession(sessionId);
      if (!currentSession) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Check if message index is valid
      if (messageIndex < 0 || messageIndex >= currentSession.messages.length) {
        throw new Error(`Message index ${messageIndex} is out of bounds for session ${sessionId}`);
      }

      // Update the message in AW-ChatMessages table
      const params = {
        TableName: this.messagesTableName,
        Key: {
          sessionId,
          messageIndex,
        },
        UpdateExpression: "SET message = :message",
        ExpressionAttributeValues: {
          // ENG-1048: same 400KB ceiling as every other message write.
          ":message": this.fitMessageForPersistence(
            updatedMessage,
            `Message ${messageIndex} for session ${sessionId}`,
          ),
        },
      };

      try {
        await dynamodb.update(params).promise();
      } catch (error) {
        // If table doesn't exist yet, log and continue
        if ((error as any).code === 'ResourceNotFoundException') {
          console.log(`ChatMessages table not found, skipping message update for session ${sessionId}`);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error("Error updating message in session:", error);
      throw error;
    }
  }
}

// Initialize database
export const chatbotDb = new ChatbotDB();

// Helper function to extract content from HTML
function extractContent(html: string): string {
  // Remove script and style tags
  const cleanHtml = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // Extract text content from main content area
  const mainContent =
    cleanHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] || cleanHtml;

  // Convert HTML to text
  return mainContent
    .replace(/<[^>]+>/g, " ") // Remove HTML tags
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

// Initialize knowledge base
let knowledgeBase: ContextChunk[] = [];

// Function to print knowledge base content
function printKnowledgeBase(): void {
  if (knowledgeBase.length === 0) {
    console.log("Knowledge base is empty");
    return;
  }

  console.log("\n=== Knowledge Base Content ===");
  knowledgeBase.forEach((chunk, index) => {
    console.log(`\nChunk ${index + 1} (${chunk.id}):`);
    console.log("Source:", chunk.metadata?.source || "unknown");
    console.log("Content length:", chunk.content.length);
    console.log("Content preview:", chunk.content.substring(0, 200) + "...");
  });
  console.log("\n============================\n");
}

// Load and cache content from backend API controllers directly
export async function loadKnowledgeBase(): Promise<void> {
  const endpoints = [
    { controller: getReleases, source: "release" },
    { controller: getUserReleaseNotes, source: "user-release" },
  ];

  const chunks: ContextChunk[] = [];
  let chunkId = 0;

  // Load product docs from Mintlify (docs.agentweb.pro) — the canonical docs
  // source. Replaces the retired Notion user-guide shadow copy (ENG-163).
  try {
    const docsContent = await fetchMintlifyDocsContent();
    chunks.push(...chunkDocsContent(docsContent, "guide"));
  } catch (error) {
    console.error("Error loading Mintlify docs for knowledge base:", error);
  }

  for (const endpoint of endpoints) {
    try {
      // Create a mock request and response to capture the controller output
      interface MockResponse {
        status: (code: number) => MockResponse;
        json: (data: any) => MockResponse;
        data: {
          success: boolean;
          data: any;
        } | null;
      }

      const mockResponse: MockResponse = {
        status: function (code: number) {
          return this;
        },
        json: function (data: any) {
          this.data = data;
          return this;
        },
        data: null,
      };

      // Call the controller function directly
      await endpoint.controller(
        {} as Request,
        mockResponse as unknown as Response
      );

      if (
        mockResponse.data &&
        mockResponse.data.success &&
        mockResponse.data.data
      ) {
        let content = "";

        if (endpoint.source === "user-release") {
          for (const release of mockResponse.data.data) {
            content += `Release Date: ${release.date}\n`;
            for (const change of release.changes) {
              content += `${change}\n`;
            }
            content += "\n";
          }
        } else if (endpoint.source === "release") {
          for (const release of mockResponse.data.data) {
            content += `Release Date: ${release.date}\n`;
            for (const change of release.changes) {
              content += `${change}\n`;
            }
            content += "\n";
          }
        }

        if (content) {
          // Split content into smaller chunks (max 2000 chars per chunk)
          const textChunks = content.match(/[^\.!\?]+[\.!\?]+/g) || [content];
          let currentChunk = "";

          for (const sentence of textChunks) {
            if ((currentChunk + sentence).length > 2000) {
              if (currentChunk) {
                chunks.push({
                  id: `chunk-${endpoint.source}-${chunkId++}`,
                  content: currentChunk.trim(),
                  metadata: { source: endpoint.source },
                });
              }
              currentChunk = sentence;
            } else {
              currentChunk += " " + sentence;
            }
          }

          // Add the last chunk if not empty
          if (currentChunk.trim()) {
            chunks.push({
              id: `chunk-${endpoint.source}-${chunkId++}`,
              content: currentChunk.trim(),
              metadata: { source: endpoint.source },
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error processing ${endpoint.source}:`, error);
    }
  }

  knowledgeBase = chunks;
  console.log(`Loaded ${chunks.length} knowledge chunks from controllers`);
  //printKnowledgeBase();
}

// Load knowledge base on startup and refresh periodically.
//
// Skipped under test. This is module-load network I/O, so merely IMPORTING any
// route that transitively reaches this file fires a real fetch at the docs
// corpus — which is what trips org.test.ts's "no route here has any business
// touching the network" assertion (ENG-1112) even though nothing in that suite
// asks for docs. The hourly timer has the same problem in reverse: it keeps a
// handle open after a suite finishes, which is where "Cannot log after tests are
// done" and the non-graceful worker exits come from. Production behaviour is
// unchanged; the one test that needs the knowledge base calls
// loadKnowledgeBase() itself.
if (process.env.NODE_ENV !== "test") {
  loadKnowledgeBase().catch((error) => {
    console.error("Error loading knowledge base:", error);
  });

  // Refresh knowledge base every hour
  setInterval(() => {
    loadKnowledgeBase().catch((error) => {
      console.error("Error refreshing knowledge base:", error);
    });
  }, 60 * 60 * 1000);
}

const partnerSystemMessage = `You are a helpful customer support assistant for AgentWeb, a powerful web automation platform that allows users to create and manage web-based tasks using natural language instructions. 

Today's date is ${new Date().toISOString().split("T")[0]}.

I will provide you with relevant information from our documentation (Partner Guide, API Docs, Release Notes) to help answer questions. Please use this information when responding to user queries.

Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <pre> for code blocks (max width 360px)
- <a href="url" target="_blank"> for links
- <table> for structured data (max width 360px)

Important formatting rules:
1. Use minimal spacing - no extra blank lines
2. Keep lists compact with minimal spacing
3. Use single line breaks between list items
4. Keep responses concise and well-structured
5. Always include target="_blank" for links
6. Use proper HTML5 semantic elements
7. The chat window has a fixed width of 384px. Format your responses to fit within this constraint

Example of good formatting:
<p>To create a task in AgentWeb, follow these steps:</p>
<ul>
<li>Go to the <strong>Tasks</strong> page in AgentWeb</li>
<li>Click the <strong>New Task</strong> button</li>
<li>Enter your task instructions in plain English</li>
<li>Adjust settings as needed</li>
<li>Click <strong>Create</strong> to save</li>
</ul>

Be helpful, concise, and accurate. If you don't know the answer, suggest the user contact support.`;

// Org-role context for Emma, one variant per role.
//
// This replaces a single member-only addendum that (a) asserted "there is only 1
// owner per organization; co-owner roles do not exist on this platform", which
// ENG-954 made false, (b) claimed only the owner can edit Brand Guidelines and
// Market Strategy, which the per-feature `editors[]` grant has been able to
// delegate for months, and (c) was gated on `orgRole === "member"`, so an admin
// received no org context at all — the role most likely to be asked permission
// questions got the least information.
const ORG_OWNER_ADDENDUM = `

## Organization membership — the current user is an owner

The current user is an **owner** of their organization. Be accurate about what that means:

- An organization can have **multiple owners and multiple admins**. Owners can promote another member to admin or owner, and can demote them again.
- **Owners** can do everything: manage members and roles, edit all org settings and shared content, manage billing, and delete the organization.
- An organization must always keep at least one owner. The last owner cannot be removed, demoted, or leave until another owner is promoted.
- To hand over an organization, promote someone else to owner first, then leave. There is no separate "transfer ownership" step.`;

const ORG_ADMIN_ADDENDUM = `

## Organization membership — the current user is an admin

The current user is an **admin** of their organization, not an owner. Be accurate about what admins can and cannot do:

- **Admins can** invite and remove members, change org settings, manage shared content across the organization, and promote members to admin.
- **Admins cannot** delete the organization, and cannot grant or revoke the owner role — only an owner can do that.
- An organization can have multiple owners and multiple admins.

If the user wants to do something reserved to owners, explain which owner action is needed rather than implying the capability does not exist.`;

const ORG_MEMBER_ADDENDUM = `

## Organization membership — the current user is a member

The current user is a **member** of an organization, not an owner or admin. Be accurate about what members can and cannot do:

- Members can use all platform features for their own work — tasks, schedules, marketing hub, social posts, SEO, CRM — and can see whatever the organization has chosen to share.
- Members **cannot** manage the organization: inviting or removing people, changing org settings, and changing anyone's role are reserved to owners and admins.
- Brand Guidelines and Market Strategy are read-only for members **unless** an owner or admin has added them as an editor for that area. The same is true for the organization's knowledge base, templates and landing pages.
- Organizations can have multiple owners and multiple admins. If the user needs broader access, the thing to ask an owner or admin for is to be made an editor, an admin, or an owner — whichever matches what they are trying to do.`;

function orgRoleAddendum(orgRole?: string): string {
  if (orgRole === "owner") return ORG_OWNER_ADDENDUM;
  if (orgRole === "admin") return ORG_ADMIN_ADDENDUM;
  if (orgRole === "member") return ORG_MEMBER_ADDENDUM;
  return "";
}

// Emma sidebar system prompt = Agent Mode prompt + sidebar-specific addendum.
// Both are code-controlled in backend/src/docs/agentModeSystemPrompt.ts.
// To update: edit that file and open a PR.
export function getEmmaSystemContext(sessionType?: string, orgRole?: string): string {
  // main refactored the member-addendum ternary into orgRoleAddendum(); ENG-803 only
  // added the comment below. Both sides kept.
  const memberAddendum = orgRoleAddendum(orgRole);
  // ENG-803: `sessionType` can be 'scheduled' here — a user may open a
  // schedule-created session in the sidebar and keep chatting in it — but this turn
  // is ATTENDED. getScheduledSessionOverride's publish argument is therefore left
  // undefined ON PURPOSE, which emits the base override and the truthful-reporting
  // rules WITHOUT the unattended publish mandate or the PUBLISH AUTHORIZATION block.
  // Passing a resolved decision here would be wrong in both directions: `true` would
  // order a live publish past the owner's opt-out (Greptile review #18), and `false`
  // would assert an approval gate this session may not actually be under. A human is
  // present, so the ordinary approval flow applies.
  return `${AGENT_MODE_SYSTEM_PROMPT}\n\nToday's date is ${new Date().toISOString().split("T")[0]}.\n${EMMA_SIDEBAR_ADDENDUM}${getScheduledSessionOverride(sessionType)}${memberAddendum}`;
}

// Exported for backwards-compatibility with existing tests — no-op since there is no longer a cache.
export function __resetEmmaSystemContextCache(): void {}

let emmaToolsLoaded = false;

const geniusSystemMessage = `You are Growth Genius, a specialized AI growth marketing assistant for AgentWeb's Growth Genius Chat. You help entrepreneurs, startups, and businesses with growth strategies, marketing tactics, and business development.

Your expertise areas include:
- Startup growth strategies and user acquisition
- Marketing campaign planning and optimization
- Business model development and validation
- Customer retention and engagement tactics
- Market research and competitive analysis
- Growth hacking and viral marketing techniques

Today's date is ${new Date().toISOString().split("T")[0]}.

I will provide you with relevant information from our knowledge base to help answer questions. Please use this information when responding to user queries.

Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <pre> for code blocks (max width 360px)
- <a href="url" target="_blank"> for links
- <table> for structured data (max width 360px)

Important formatting rules:
1. Use minimal spacing - no extra blank lines
2. Keep lists compact with minimal spacing
3. Use single line breaks between list items
4. Keep responses concise and well-structured
5. Always include target="_blank" for links
6. Use proper HTML5 semantic elements
7. The chat window has a fixed width of 384px. Format your responses to fit within this constraint

Be helpful, concise, and accurate. Focus on actionable growth marketing advice. If you don't know the answer, suggest the user contact support.`;


// Helper function to calculate token cost
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  model: string,
  // ENG-1134: cache tokens were omitted entirely, so this under-reported Emma's
  // cost by the cache share — the bulk of a cached conversation. It no longer
  // drives billing (that moved to the call-site meter), but it still drives the
  // per-session cost the admin UI shows, and a display that disagrees with the
  // ledger is how the last three metering tickets started.
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  // ENG-893 splits cache writes by the TTL Bedrock actually applied: 1.25x input
  // at 5 minutes, 2x at one hour. Dropping it prices every write at the 5-minute
  // rate, so an Emma-on-Claude session with 1h writes shows a cost materially
  // below the ledger figure for the same call — the display/ledger disagreement
  // this whole ticket exists to eliminate.
  cacheWriteByTtl?: CacheWriteByTtl
): number {
  // Price from the single source of truth (llmPricing via computeCostMicroUsd)
  // so chatbot cost stays consistent with the shadow usage book and ENG-207
  // normalization. This replaced a stale hardcoded per-1K table whose gpt-4o
  // prompt rate was 10x the published list price ($25/1M vs $2.50/1M), which
  // silently overcharged Emma chatbot usage. Unknown models → 0 (unchanged).
  return (
    computeCostMicroUsd(
      model,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteByTtl
    ) / 1_000_000
  );
}

// Helper function to log token usage
function logTokenUsage(
  response: OpenAI.Chat.ChatCompletion,
  context: string = "",
  pricingModel: string = response.model
) {
  const usage = response.usage;
  if (!usage) return;

  const u: any = usage;
  const cost = calculateCost(
    usage.prompt_tokens,
    usage.completion_tokens,
    pricingModel,
    u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0,
    u.cache_creation_input_tokens || 0,
    u.cache_creation_by_ttl
  );

  console.log(
    `[Token Usage] Model: ${pricingModel} | Prompt: ${
      usage.prompt_tokens
    } | Completion: ${usage.completion_tokens} | Total: ${
      usage.total_tokens
    } | Cost: ${cost > 0 ? "$" + cost.toFixed(6) : "N/A"}${
      context ? ` | Context: ${context}` : ""
    }`
  );

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    estimated_cost: cost,
    // ENG-1222: without these, a session's spend has no per-model attribution
    // basis (apiTools.ts reads msg.usage.cache_*_input_tokens) and reports as
    // 'selection-only' with cacheTokens/costByModel null even though real spend
    // happened — the exact telemetry fingerprint that hid the P0 fabrication bug.
    cache_read_input_tokens: u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  };
}

// Function to search knowledge base
export async function searchKnowledgeBase(query: string, maxResults: number = 5): Promise<ContextChunk[]> {
  try {
    // Use the existing findRelevantChunks function to search through the knowledge base
    const relevantChunks = await findRelevantChunks(query, knowledgeBase, maxResults);
    return relevantChunks;
  } catch (error) {
    console.error("[searchKnowledgeBase] Error:", error);
    throw error;
  }
}

// ENG-1222 follow-up: the Vertex AI Discovery Engine calls below have no
// timeout of their own and can hang indefinitely — observed directly in a
// live environment, where a single call blocked an entire chat turn for
// several minutes. Every chatbotService.ts turn goes through this function
// (not just skill sessions), so an unbounded hang here stalls the whole
// generateChatResponse call. Mirrors the same pattern already used
// independently in v0Service.ts / linkedInOutreachService.ts / etc. — a
// shared utility would be a separate, larger cleanup, not bundled in here.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e: any = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      e.code = 'KNOWLEDGE_BASE_SEARCH_TIMEOUT';
      reject(e);
    }, ms);
    // Don't keep the event loop alive solely for this guard timer.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
const KNOWLEDGE_BASE_SEARCH_TIMEOUT_MS = 10_000;

// Function to search platform-wide knowledge base using Vertex AI Search
export async function searchPlatformKnowledgeBase(query: string, maxResults: number = 10, userId?: string): Promise<ContextChunk[]> {
  try {
    // An empty/whitespace query matches everything in Vertex — return nothing instead.
    if (!query || !query.trim()) {
      return [];
    }

    // Initialize the Search Service clients
    // ENG-1277: lazy load — see the import comment above for why.
    const { SearchServiceClient, protos } = await import('@google-cloud/discoveryengine');
    const privateKey = await getGCSPPrivateKey();

    const publicClient = new SearchServiceClient({
      apiEndpoint: process.env.VERTEX_AI_LOCATION === 'global' 
        ? 'discoveryengine.googleapis.com'
        : `${process.env.VERTEX_AI_LOCATION}-discoveryengine.googleapis.com`,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey
      }
    });

    const privateClient = new SearchServiceClient({
      apiEndpoint: process.env.VERTEX_AI_LOCATION_PRIVATE === 'global'
        ? 'discoveryengine.googleapis.com'
        : `${process.env.VERTEX_AI_LOCATION_PRIVATE}-discoveryengine.googleapis.com`,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey
      }
    });

    // Build the serving config paths for both public and private knowledge bases
    const publicServingConfig = `projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/${process.env.VERTEX_AI_LOCATION}/collections/default_collection/engines/${process.env.VERTEX_AI_SEARCH_APP_ID}/servingConfigs/default_config`;
    const privateServingConfig = `projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/${process.env.VERTEX_AI_LOCATION_PRIVATE}/collections/default_collection/engines/${process.env.VERTEX_AI_SEARCH_APP_ID_PRIVATE}/servingConfigs/default_config`;

    // Create the search request with proper types
    const searchRequest: protos.google.cloud.discoveryengine.v1.ISearchRequest = {
      query,
      // Bound the number of documents returned per bucket. Without this Vertex defaults to
      // 10 docs, and with maxExtractiveSegmentCount segments each the result set balloons.
      pageSize: maxResults,
      contentSearchSpec: {
        extractiveContentSpec: {
          maxExtractiveSegmentCount: maxResults
        }
      },
      queryExpansionSpec: {
        condition: protos.google.cloud.discoveryengine.v1.SearchRequest.QueryExpansionSpec.Condition.AUTO
      },
      spellCorrectionSpec: {
        mode: protos.google.cloud.discoveryengine.v1.SearchRequest.SpellCorrectionSpec.Mode.AUTO
      }
    };

    // Search both knowledge bases in parallel. The outer withTimeout guard only
    // abandons the *promise* on the caller's side — without also passing
    // CallOptions.timeout, the underlying RPCs stay in flight past the 10s
    // deadline, holding the socket and retry budget open.
    const [publicResults, privateResults] = await withTimeout(
      Promise.all([
        publicClient.search({ ...searchRequest, servingConfig: publicServingConfig }, { timeout: KNOWLEDGE_BASE_SEARCH_TIMEOUT_MS }),
        privateClient.search({ ...searchRequest, servingConfig: privateServingConfig }, { timeout: KNOWLEDGE_BASE_SEARCH_TIMEOUT_MS })
      ]),
      KNOWLEDGE_BASE_SEARCH_TIMEOUT_MS,
      'searchPlatformKnowledgeBase',
    );

    const results: ContextChunk[] = [];

    // Process public results
    for (const result of publicResults[0]) {
      const structData = result.document?.derivedStructData;
      if (!structData?.fields?.extractive_segments?.listValue?.values) {
        continue;
      }

      // Extract fileName from the link if available
      const link = structData.fields?.link?.stringValue;
      const fileName = link ? link.split('/').pop() : undefined;

      for (const segment of structData.fields.extractive_segments.listValue.values) {
        if (!segment.structValue?.fields?.content?.stringValue) {
          continue;
        }

        const content = segment.structValue.fields.content.stringValue;
        results.push({
          id: `kb-public-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          // ENG-1057: cap here, at the shared source, so every consumer of
          // this function is protected uniformly instead of relying on each
          // one to remember to truncate independently (which is exactly how
          // one uncapped path crashed the backend with ERR_STRING_TOO_LONG).
          content: content.length > 5000 ? content.substring(0, 5000) + '\n\n[Content truncated]' : content,
          metadata: {
            source: 'public-knowledge-base',
            ...(fileName && { fileName })
          }
        });
      }
    }

    // Process private results
    for (const result of privateResults[0]) {
      const structData = result.document?.derivedStructData;
      if (!structData?.fields?.extractive_segments?.listValue?.values) {
        continue;
      }

      // Extract taskId and fileName from the link
      const link = structData.fields?.link?.stringValue;
      if (!link) continue;

      // Extract taskId from the link path (e.g., gs://bucket/tasks/1740437136262/knowledge-base.txt)
      const taskIdMatch = link.match(/\/tasks\/(\d+)\//);
      if (!taskIdMatch) continue;

      const taskId = taskIdMatch[1];
      const fileName = link.split('/').pop();
      
      // Check if task belongs to current user
      try {
        const task = await taskDb.getTaskById(taskId);
        if (!task || task.userId !== userId) {
          console.log(`Skipping task ${taskId} - not owned by user ${userId}`);
          continue;
        }
      } catch (error) {
        console.error(`Error checking task ownership for ${taskId}:`, error);
        continue;
      }

      for (const segment of structData.fields.extractive_segments.listValue.values) {
        if (!segment.structValue?.fields?.content?.stringValue) {
          continue;
        }

        const content = segment.structValue.fields.content.stringValue;
        results.push({
          id: `kb-private-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          // ENG-1057: same cap as the public branch above.
          content: content.length > 5000 ? content.substring(0, 5000) + '\n\n[Content truncated]' : content,
          metadata: {
            source: 'private-knowledge-base',
            taskId: taskId,
            ...(fileName && { fileName })
          }
        });
      }
    }

    return results;
  } catch (error) {
    console.error("[searchPlatformKnowledgeBase] Error:", error);
    throw error;
  }
}

function trimToolMessagesForContext(
  messages: any[],
  recentToPreserve: number = 3,
  maxToolContentLength: number = 8000,
  maxHistoricalTools: number = 20
): any[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIndices.push(i);
  }
  const preserveSet = new Set(toolIndices.slice(-recentToPreserve));
  const historicalIndices = toolIndices.slice(0, toolIndices.length - recentToPreserve);
  const dropSet = historicalIndices.length > maxHistoricalTools
    ? new Set(historicalIndices.slice(0, historicalIndices.length - maxHistoricalTools))
    : new Set<number>();

  return messages
    .filter((_, idx) => !dropSet.has(idx))
    .map((msg) => {
      if (msg.role === 'tool' && !preserveSet.has(messages.indexOf(msg)) && typeof msg.content === 'string' && msg.content.length > maxToolContentLength) {
        return { ...msg, content: msg.content.slice(0, maxToolContentLength) + '\n[truncated]' };
      }
      return msg;
    });
}

export interface ChatResponseOptions {
  currentUrl?: string;
  pageContent?: string;
  portalType?: "customer" | "partner";
  userId?: string;
  structuredContext?: string;
  screenshot?: string;
  model?: string;
  socketId?: string;
  onToolStart?: (toolName: string) => void;
  /** True when the current message is from an admin via delegated access. Admin tools should be available. */
  isDelegatedAdmin?: boolean;
  /** Email of the admin when isDelegatedAdmin is true. */
  adminEmail?: string;
  /** Organization role of the current user ("owner" | "member"). Used to inject accurate org-permission context into Emma's system prompt. */
  orgRole?: string;
}

// Update generateChatResponse to use platform knowledge base when needed
export async function generateChatResponse(
  sessionId: string,
  userMessage: string,
  options: ChatResponseOptions = {}
): Promise<string | { content: string; toolCalls?: any[]; invalidations?: string[] }> {
  const {
    currentUrl,
    pageContent,
    portalType = "partner",
    userId,
    structuredContext,
    screenshot,
    model,
    socketId,
    onToolStart,
    isDelegatedAdmin,
    adminEmail,
    orgRole,
  } = options;
  try {
    const timestamp = new Date().toISOString();

    // Upload screenshot to S3 if provided
    let uploadedScreenshotUrl: string | undefined = screenshot?.startsWith('data:image') ? undefined : screenshot;
    let attachments: any[] | undefined;

    if (screenshot && screenshot.startsWith('data:image')) {
      const result = await uploadScreenshotToS3(screenshot, userId || 'anonymous');
      if (result) {
        uploadedScreenshotUrl = result.url;
        attachments = [{ ...result.attachment, uploadedAt: timestamp }];
      }
    }

    // Add user message to session with metadata
    const userMessageMetadata: any = {
      currentUrl,
      pageContentLength: pageContent?.length,
      knowledgeBaseChunks: knowledgeBase.length,
      pageChunks: pageContent ? splitIntoChunks(pageContent).length : 0,
      timestamp,
      portalType,
    };
    if (attachments) {
      userMessageMetadata.attachments = attachments;
    }

    await chatbotDb.addMessageToSession(sessionId, {
      role: "user",
      content: userMessage,
      metadata: userMessageMetadata,
    });

    // Get updated session with history
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      throw new Error("Chat session not found");
    }

    // ENG-1222: resolve skill/admin tool access ONCE, through agent-mode's own
    // buildSkillContext, shared below by both the system prompt (skill
    // systemPrompt injection) and tool binding — this is the single source of
    // truth for "which tools + skill-context text does this session get",
    // replacing two independently hand-rolled, silently-drifting copies of the
    // same policy. Also picks up subscription-tier skill gating and
    // __other_skills__ support that this path never had.
    const sessionHasInstalledSkills = Array.isArray(session.associatedSkills) && session.associatedSkills.length > 0;
    const sessionSkillIds = Array.isArray(session.associatedSkills) ? session.associatedSkills : [];
    const skillToolGateOpen = portalType === 'customer' || (portalType as string) === 'emma-sidebar' || !!isDelegatedAdmin || sessionHasInstalledSkills;
    // ENG-1852 follow-up: use the module's own exported singleton, not a fresh
    // instance. A `new AgentModeService()` here ran a full initialize()
    // (registerTools over ~264 tools + initializeMcp + ensureBuiltInSkills +
    // downstream singleton bootstrap) on EVERY message this gate is open for,
    // purely to throw the instance away at end of turn — and, because
    // startFileCacheCleanup() sets an un-unref'd interval whose closure retains
    // `this`, each discarded instance stayed reachable for the process lifetime.
    // It was also the last remaining second construction site in backend/src,
    // which is the exact shape that made ENG-1852 (two live instances, one with an
    // empty registry, either able to answer a call) possible in the worker.
    //
    // Imported at top level, not lazily. An earlier version of this change used
    // `await import('./agentModeService')` on the claim that it avoided
    // constructing the singleton as a side effect of loading this module. That
    // claim was false: line 25's `AgentModeService` class import is a VALUE import
    // of the same module, so the module body — including its
    // `export const agentModeService = new AgentModeService()` — already runs at
    // load. The compiled output confirms it (`require("./agentModeService")` at
    // top level). The lazy form bought nothing and cost a dynamic require per
    // message. The existing circular edge with agentModeService.ts is unchanged
    // and safe: compiled CJS resolves the binding at USE time, long after both
    // modules finish loading.
    //
    // initialize() is idempotent for the expensive registration pass and still
    // re-reads foundation tools on every call — see agentModeService.ts.
    const agentModeService = agentModeServiceSingleton;
    let skillContext: { allowedToolNames: Set<string>; installedSkillContextMsg: string } = { allowedToolNames: new Set<string>(), installedSkillContextMsg: '' };
    // Exposed for the ENG-1222 hard gate below, so it can tell "subscription
    // correctly doesn't include this skill" apart from "tool resolution failed".
    let userAllowedSkillIdsForGate: string[] = [];
    // getSkillsByIds/getPublishedSkills/getAllowedSkills can all reject (e.g. a
    // transient DynamoDB error) — without tracking that separately from "resolved
    // to an empty allowlist", the hard gate below would misreport a backend
    // failure as "this skill isn't in your plan" to a paying customer whose
    // subscription was never actually checked.
    let skillAllowlistResolved = false;
    if (skillToolGateOpen) {
      try {
        await agentModeService.initialize();
        const { skillService } = await import('./skillService');
        // buildSkillContext only ever consults publishedSkills/userAllowedSkillIds
        // when the session itself has skill IDs to resolve or gate (regular skills,
        // or the __other_skills__ virtual ID) — a plain skill-less customer/admin
        // turn never uses either. Skipping them here avoids a subscription-tier
        // lookup plus a full Dev-AW-Skills table scan on every single Emma message,
        // not just the ones that actually have a skill installed.
        if (sessionSkillIds.length > 0) {
          const { getAllowedSkills, getPublicAllowedSkills } = await import('./subscriptionService');
          const [associatedSkills, publishedSkills, userAllowedSkillIds] = await Promise.all([
            skillService.getSkillsByIds(sessionSkillIds),
            skillService.getPublishedSkills(),
            // ENG-1222: userId is optional on this function (anonymous/public
            // callers exist) — route those through the same public-allowlist path
            // subscriptionService already defines, instead of letting getAllowedSkills
            // throw on an undefined id and silently falling back to zero tools below.
            userId ? getAllowedSkills(userId) : getPublicAllowedSkills(),
          ]);
          // ENG-1978: getAllowedSkills now returns null when the tier could not be resolved,
          // where it previously returned ["*"] (grant everything). Route that into the catch
          // below so `skillAllowlistResolved` stays false — the hard gate then reports a
          // configuration problem rather than claiming the customer's plan excludes the skill.
          // Emma already failed closed on a *thrown* lookup; this keeps the two identical.
          if (userAllowedSkillIds === null) {
            throw new Error('subscription entitlement unresolved');
          }
          userAllowedSkillIdsForGate = userAllowedSkillIds;
          // Set only after buildSkillContext itself succeeds — if it throws, the
          // catch block below must still see skillAllowlistResolved === false, or
          // the hard gate would misreport a context-construction bug as "your
          // subscription doesn't include this skill".
          skillContext = agentModeService.buildSkillContext(associatedSkills, userAllowedSkillIds, publishedSkills, sessionSkillIds, !!isDelegatedAdmin);
          skillAllowlistResolved = true;
        } else {
          skillContext = agentModeService.buildSkillContext([], [], [], [], !!isDelegatedAdmin);
        }
      } catch (skillContextErr) {
        console.error('[generateChatResponse] Error resolving skill/tool context:', skillContextErr);
      }
    }

    // Get messages for OpenAI
    // Always inject the current system prompt fresh (ignoring the stale stored version)
    // so that DynamoDB overrides and prompt updates take effect immediately for all sessions.
    const freshSystemPrompt = portalType === "customer" ? getEmmaSystemContext(session.sessionType, orgRole) : null;
    const combinedSystemPrompt = [freshSystemPrompt, skillContext.installedSkillContextMsg || null].filter(Boolean).join('\n\n') || null;
    const messages = [...session.messages];
    if (combinedSystemPrompt) {
      const firstSystemIdx = messages.findIndex((m) => m.role === "system");
      if (firstSystemIdx >= 0) {
        messages[firstSystemIdx] = { ...messages[firstSystemIdx], content: combinedSystemPrompt };
      } else {
        messages.unshift({ role: "system", content: combinedSystemPrompt, metadata: { timestamp: new Date().toISOString() } });
      }
    }

    // Support vision: if screenshot provided, modify last user message for visual analysis
    if (uploadedScreenshotUrl) {
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
      if (lastUserIdx >= 0) {
        (messages[lastUserIdx] as any).content = [
          { type: 'text', text: `${messages[lastUserIdx].content}\n\n[Page screenshot captured. URL: ${uploadedScreenshotUrl}]` },
          { type: 'image_url', image_url: { url: uploadedScreenshotUrl, detail: 'low' } }
        ];
      }
    }

    let contextInfo = "";

    let activeKnowledgeBase: ContextChunk[];
    let combinedChunks: ContextChunk[];
    let pageChunksCount = 0;
    let pageChunksResult: ContextChunk[] = [];

    // Calculate page chunks if pageContent exists, regardless of portal type
    if (pageContent) {
      pageChunksResult = splitIntoChunks(pageContent);
      pageChunksCount = pageChunksResult.length;
    }

    if (portalType === "customer") {
      activeKnowledgeBase = knowledgeBase.filter(
        (chunk) =>
          chunk.metadata.source === "user-release"
      );
      // Combine user-release chunks with page chunks
      combinedChunks = [...pageChunksResult, ...activeKnowledgeBase];
    } else {
      // Partner portal (or default)
      activeKnowledgeBase = knowledgeBase.filter(
        (chunk) =>
          chunk.metadata.source === "guide" ||
          chunk.metadata.source === "release" ||
          chunk.metadata.source === "api"
      );
      // Combine partner KB chunks with page chunks
      combinedChunks = [...pageChunksResult, ...activeKnowledgeBase];
    }

    // RAG: Search knowledge base and retrieve relevant chunks
    let retrievalErrorOccurred = false;
    let relevantChunksInfo: { count: number; sources: string[] } | undefined;
    try {
      // First try the local knowledge base
      const relevantChunks = await searchKnowledgeBase(userMessage);
      relevantChunksInfo = {
        count: relevantChunks.length,
        sources: relevantChunks.map((c) => c.metadata.source),
      };

      if (relevantChunks.length > 0) {
        contextInfo = relevantChunks
          .map((chunk) => `${chunk.content} (Source: ${chunk.metadata.source})`)
          .join("\n\n");
      }

      // Always try platform-wide KB and append results
      const platformChunks = await searchPlatformKnowledgeBase(userMessage, 10, userId);
      if (platformChunks.length > 0) {
        const platformContext = platformChunks
          .map((chunk) => `${chunk.content} (Source: ${chunk.metadata.source})`)
          .join("\n\n");
        
        // Append platform context to existing context
        contextInfo = contextInfo 
          ? `${contextInfo}\n\n${platformContext}`
          : platformContext;

        // Update relevantChunksInfo to include both sources
        relevantChunksInfo = {
          count: relevantChunks.length + platformChunks.length,
          sources: [...new Set([...relevantChunks, ...platformChunks].map((c) => c.metadata.source))],
        };
      }

      // Find the index of the last user message
      const lastUserMsgIndex = messages
        .map((m) => m.role)
        .lastIndexOf("user");

      // Append structured page context (buttons, inputs, headings) if provided
      if (structuredContext) {
        contextInfo = contextInfo
          ? `${contextInfo}\n\n--- Current Page UI Elements ---\n${structuredContext}`
          : `--- Current Page UI Elements ---\n${structuredContext}`;
      }

      // Insert the context right before the user's message if we have any
      if (contextInfo && lastUserMsgIndex > 0) {
        messages.splice(lastUserMsgIndex, 0, {
          role: "system",
          content: `Here is relevant information from our knowledge base:\n\n${contextInfo}`,
          metadata: {
            timestamp,
            relevantChunks: relevantChunksInfo,
          },
        });
      }
    } catch (error) {
      console.error(
        "[generateChatResponse] Error in knowledge base search:",
        error
      );
      retrievalErrorOccurred = true;
    }

    // Inject the session's active work plan so Emma sees and follows it while chatting,
    // mirroring agent mode. Without this, Emma can create/modify a plan but is blind to an
    // existing one — she won't continue it or update step statuses. Insert right before the
    // final user message so it reads as the most recent context.
    if (session.workPlan) {
      // Emma stays on current production behavior: pass includeResumeGuidance=false so
      // none of the agent-mode image-resume hardening (progression / multi-intent /
      // completion guard / asset-awareness / hands-off autocomplete wording) is emitted.
      // The reported bug was agent-mode-only, so Emma needs no change here.
      const workPlanMessages = AgentModeService.buildWorkPlanContextMessages(session.workPlan, undefined, false, session.calledFunctions);
      if (workPlanMessages.length > 0) {
        const lastUserMsgIndex = messages.map((m) => m.role).lastIndexOf("user");
        const insertAt = lastUserMsgIndex >= 0 ? lastUserMsgIndex : messages.length;
        messages.splice(insertAt, 0, ...workPlanMessages.map((m) => ({
          ...m,
          metadata: { timestamp },
        })));
      }
    }

    // Initialize tool support for Emma (customer portal, or admin users on any portal)
    let toolDefinitions: any[] = [];

    if (skillToolGateOpen) {
      try {
        // Base tools: agent-mode's resolved skill/admin/foundation tool names
        // (computed once above, shared with the system prompt) + Emma-specific extras.
        // Only include customer-specific tools when on the customer portal or emma-sidebar
        const isCustomerContext = (portalType as string) === 'customer' || (portalType as string) === 'emma-sidebar';
        const toolsToInclude = new Set<string>(skillContext.allowedToolNames);
        if (isCustomerContext) {
          [
            'read_page_source',
            'enrich_leads_preview', 'enrich_leads_execute',
            'save_browser_cookies', 'load_browser_cookies', 'clear_browser_cookies',
            'search_user_guide',
            'report_product_issues',
            'get_temp_email', 'check_temp_inbox',
            'get_test_account', 'save_test_account', 'list_test_accounts',
          ].forEach((t) => toolsToInclude.add(t));
        }

        if (isCustomerContext) {
          // Page-aware tool injection based on the current page URL
          const urlPath = (currentUrl || '').replace(/^\//, '');
          const page = urlPath.split('/')[0].split('?')[0];
          const urlParams = new URLSearchParams(urlPath.includes('?') ? urlPath.split('?')[1] : '');
          const tab = urlParams.get('tab') || '';
          const pageKey = tab ? `${page}?tab=${tab}` : page;
          const pageToolMap: Record<string, string[]> = {
            'brand-guidelines': ['read_brand_guidelines', 'update_brand_guidelines', 'get_visual_context'],
            'market-strategy':  ['read_market_strategy', 'update_market_strategy'],
            'gtm-plan':         ['list_gtm_plans', 'read_gtm_plan', 'create_gtm_plan', 'update_gtm_plan', 'add_gtm_phase', 'add_gtm_work_items', 'update_gtm_work_item', 'update_gtm_phase', 'delete_gtm_items', 'get_gtm_common_items', 'add_gtm_common_items', 'send_gtm_status_report'],
            'crm':              ['get_lead_lists', 'create_lead_list', 'add_leads_to_list', 'get_leads', 'search_leads', 'get_lead_details', 'update_lead', 'delete_leads', 'update_lead_list', 'delete_lead_list', 'update_lead_status', 'get_lead_list_statuses', 'configure_lead_statuses', 'get_lead_engagements', 'add_lead_engagement', 'delete_lead_engagement', 'send_email_to_lead', 'update_email_draft_for_lead'],
            'social-posts':     ['list_connected_accounts', 'list_connected_account_posts', 'load_connected_account_metrics', 'post_on_connected_account', 'comment_on_linkedin_post', 'react_to_linkedin_post', 'create_social_media_posts', 'get_visual_context'],
            'paid-social':      ['list_connected_accounts', 'list_meta_ads_campaigns', 'get_meta_ads_metrics'],
            'images':           ['generate_image', 'describe_image', 'get_visual_context'],
            'videos':           ['generate_video', 'describe_video', 'get_visual_context'],
            'knowledge-base':   ['search_knowledge_base', 'list_knowledge_base_files', 'read_knowledge_base_files', 'read_file_content', 'create_knowledge_base', 'update_knowledge_base_file', 'attach_knowledge_base_files'],
            'templates':        ['list_html_templates', 'create_html_from_template', 'update_html_file', 'get_visual_context'],
            'books':            ['list_books', 'get_book_details', 'get_book_content', 'update_book_content', 'generate_book_content', 'create_book', 'create_book_outline', 'add_characters'],
            'research-reports': ['perform_deep_research', 'you_search_web'],
            'tasks':            ['list_task_templates', 'create_task_from_template', 'create_task_from_prompt'],
            'newsletter':       ['create_social_media_posts', 'list_html_templates', 'create_html_from_template', 'update_html_file', 'get_visual_context'],
            'seo':              ['get_seo_metrics', 'get_website_analytics', 'get_ga4_key_events', 'get_clarity_metrics'],
            'blog':             ['create_blog_article', 'publish_blog_article', 'list_cms_categories', 'repair_blog_article', 'get_visual_context'],
            'agent-mode?tab=scheduled': ['list_scheduled_chats', 'manage_scheduled_chat', 'test_scheduled_chat', 'get_scheduled_chat_test_history', 'submit_scheduled_chat_variables'],
          };
          if (pageToolMap[pageKey]) {
            pageToolMap[pageKey].forEach(t => toolsToInclude.add(t));
          }
        }

        if (!emmaToolsLoaded) {
          await import('../emma/tools');
          await import('../emma/tempEmailTools');
          await import('../emma/testAccountTools');
          await import('../emma/localAgentTools');
          emmaToolsLoaded = true;
        }
        const { mcpToolRegistry } = await import('../mcp/server/registry');
        const { emmaToolRegistry } = await import('../emma/registry');

        // Expand the tool set with the active work plan's required function calls.
        // Predefined templates declare the tools each step needs via
        // requiredFunctionCalls (not skillIds), and Agent Mode runs them as legacy
        // sessions where every tool is available. Emma has no such fallback, so
        // without this a plan step whose required tool isn't a foundation/page tool
        // (e.g. generate_landing_page, create_html_file) could never be completed.
        // Scope: only sessions actually running a plan, and only that plan's tools.
        if (Array.isArray(session.workPlan?.steps)) {
          for (const step of session.workPlan!.steps) {
            if (Array.isArray(step.requiredFunctionCalls)) {
              step.requiredFunctionCalls.forEach((fn: string) => toolsToInclude.add(fn));
            }
          }
        }

        for (const toolName of toolsToInclude) {
          // First try emmaToolRegistry (Emma-specific tools), then fall back to mcpToolRegistry
          const emmaHandler = emmaToolRegistry.getTool(toolName);
          const toolHandler = emmaHandler || mcpToolRegistry.getTool(toolName);
          if (toolHandler) {
            // Convert MCP definition to OpenAI format
            const mcpDef = toolHandler.definition;
            toolDefinitions.push({
              type: "function",
              function: {
                name: mcpDef.name,
                description: mcpDef.description,
                parameters: mcpDef.inputSchema
              }
            });
          }
        }

        console.log(`[generateChatResponse] Loaded ${toolDefinitions.length} tools for Emma`);
      } catch (error) {
        console.error('[generateChatResponse] Error loading tools:', error);
        // Continue without tools if loading fails
      }
    }

    // ENG-1222 hard gate: a skill session (session.associatedSkills non-empty)
    // expects its skill's tools to be available, so resolving to zero tools here
    // is a binding/configuration failure (e.g. an unregistered tool name, or a
    // skill with no toolNames declared), not a legitimate "no tools needed" turn.
    // Fail explicitly instead of letting the model free-text an answer it has no
    // real capability to back up — this is the failure mode that produced the P0
    // ("I don't have the capability to..." for a session that actually did).
    // toolDefinitions also carries customer/page/work-plan tools unrelated to the
    // installed skill (e.g. a CRM-page turn on a customer session), so a nonzero
    // toolDefinitions.length doesn't prove the skill's own tools bound. Gate on
    // the subset that actually came from the skill (+ virtual-skill) resolution
    // instead — excluding FOUNDATION_TOOLS and the delegated-admin tool set,
    // since buildSkillContext unions both into allowedToolNames unconditionally
    // (foundation tools for every session, admin tools for any delegated admin),
    // so a single registered tool from either would otherwise mask the exact
    // "this skill's own tools failed to bind" failure the gate exists to catch.
    const adminToolNames = new Set(agentModeService.getAdminToolNames());
    const skillOnlyToolNames = new Set(
      [...skillContext.allowedToolNames].filter((name) => !AgentModeService.FOUNDATION_TOOLS.has(name) && !adminToolNames.has(name)),
    );
    const skillToolDefinitions = toolDefinitions.filter((t: any) => skillOnlyToolNames.has(t.function.name));
    if (sessionHasInstalledSkills && skillToolDefinitions.length === 0) {
      // ENG-1222: subscription-tier gating (now enforced here via buildSkillContext,
      // where before this path ignored it) correctly excludes a skill's tools when
      // the caller's plan doesn't include it — that isn't a bug to apologize for or
      // ask the user to retry. Tell them the real reason instead of the generic
      // "configuration issue" message, which would be actively misleading here.
      const isWildcardAllowed = userAllowedSkillIdsForGate.includes('*');
      // skillAllowlistResolved guards this: an unresolved allowlist (the
      // Promise.all above rejected) must never be classified as "subscription
      // doesn't include this skill" — that's only a real conclusion once the
      // allowlist was actually fetched.
      const isSubscriptionGated = skillAllowlistResolved && !isWildcardAllowed && sessionSkillIds.length > 0
        && sessionSkillIds.every((id) => !userAllowedSkillIdsForGate.includes(id));
      console.error('[generateChatResponse] ENG-1222 hard gate: skill session resolved to zero tools', {
        sessionId,
        associatedSkills: session.associatedSkills,
        isSubscriptionGated,
      });
      const hardGateMessage = isSubscriptionGated
        ? "This skill isn't included in your current plan, so I don't have access to its tools right now. You may need to upgrade your subscription, or contact support if you believe this is a mistake."
        : "I wasn't able to load the tools this task needs right now — that looks like a configuration issue on our side rather than something you did wrong. Please try again in a moment, and let us know if it keeps happening.";
      await chatbotDb.addMessageToSession(sessionId, {
        role: "assistant",
        content: hardGateMessage,
        metadata: { timestamp, portalType },
      });
      return hardGateMessage;
    }

    // ENG-1222 runtime assertion: if the user's message names one of the tools
    // that IS available this turn (e.g. "call list_connected_accounts") and the
    // model's first response makes zero tool calls, don't accept that as final —
    // nudge once and give it a real chance to actually call the tool before
    // falling back to whatever it says (still subject to the fabrication guard
    // below either way).
    const availableToolNames = toolDefinitions.map((t: any) => t.function.name);
    const userNamedAvailableTool = availableToolNames.some((name: string) => {
      if (!userMessage.includes(name)) return false;
      // Exclude meta-questions ABOUT the tool ("what does X do?", "how does X
      // work?", "explain X") from counting as a request to invoke it — a naive
      // substring match would otherwise retry a question the model already
      // answered correctly without calling anything.
      const isMetaQuestionAboutTool = new RegExp(
        `\\b(?:what (?:does|is)|how does|explain|describe|tell me about)\\b[^.!?]*${name}`,
        'i',
      ).test(userMessage);
      return !isMetaQuestionAboutTool;
    });
    let retriedForMissingToolCall = false;

    // Iterative tool execution loop (follows Agent Mode pattern)
    const startMemory = process.memoryUsage();
    const startTime = Date.now();
    const iterationTimings: { iteration: number; llmDurationMs: number; toolNames: string[] }[] = [];
    let iteration = 0;
    const MAX_ITERATIONS = 10;
    const toolCalls: any[] = []; // Track tool calls for response
    // ENG-351: accumulate the web sources this sidebar response consults, so the
    // Sources UI works on the Emma sidebar too (same registry as Agent Mode).
    const citationRegistry = new CitationRegistry();
    let finalAssistantMessage = '';
    let finalUsageData: any = null;

    // One logical model and one shared execution boundary for every Emma portal.
    // callLLM owns provider transport, retries/fallback, and exactly-once metering;
    // the sidebar owns only conversation/tool behavior.
    const activeModel = model || session.llmModel || await agentModeService.getDefaultModel();
    const isEmmaInteractive = portalType === 'customer';

    while (iteration < MAX_ITERATIONS) {
      console.log(`[generateChatResponse] Iteration ${iteration + 1}`);

      // Trim large old tool results to prevent context window overflow
      const trimmedMessages = trimToolMessagesForContext(messages);

      // Generate through the shared runtime gateway (with tools if available).
      const llmStartMs = Date.now();
      const response = await agentModeService.callLLM(
        activeModel,
        trimmedMessages.map(({ role, content, name, tool_call_id, tool_calls }: any) => {
          const message: any = { role, content };
          if (role === 'tool' && tool_call_id) {
            message.tool_call_id = tool_call_id;
          }
          if (role === 'assistant' && tool_calls) {
            message.tool_calls = tool_calls;
          }
          if (name) {
            message.name = name;
          }
          return message;
        }),
        {
          ...(toolDefinitions.length > 0 ? { tools: toolDefinitions, tool_choice: 'auto' as const } : {}),
          ...(isEmmaInteractive ? { taskClass: 'interactive_chat' as const } : {}),
          humanPaced: true,
          usageContext: { userId, sessionId, feature: 'chat' },
        },
      );

      const llmDurationMs = Date.now() - llmStartMs;
      const responseMessage = response.choices[0]?.message;
      if (!responseMessage) {
        throw new Error("No response from LLM");
      }

      // Log token usage for this iteration
      logTokenUsage(
        response,
        `Iteration ${iteration + 1}${contextInfo ? `, used ${contextInfo.length} chars of context` : ''}`,
        activeModel,
      );

      // Add assistant message to messages array (for next iteration)
      const assistantMsg: any = {
        role: 'assistant',
        content: responseMessage.content || ''
      };
      if (responseMessage.tool_calls) {
        assistantMsg.tool_calls = responseMessage.tool_calls;
      }
      messages.push(assistantMsg);

      // Check if LLM wants to call tools
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        // toolCalls.length === 0 restricts the retry to "nothing real has executed
        // yet this turn" — once a tool has actually run, a later toolless response
        // is the model synthesizing its final answer from real results, not denying
        // or fabricating, and must not be treated as another missed tool call.
        if (userNamedAvailableTool && !retriedForMissingToolCall && toolCalls.length === 0) {
          retriedForMissingToolCall = true;
          console.warn('[generateChatResponse] ENG-1222 retry: user named an available tool but the model made zero tool calls this turn', {
            sessionId,
            availableToolNames,
          });
          iterationTimings.push({ iteration: iteration + 1, llmDurationMs, toolNames: [] });
          messages.push({
            role: 'user',
            content: `Reminder: you have real tools available (${availableToolNames.join(', ')}) for this request — call the tool now instead of describing or simulating what it would return.`,
          });
          iteration++;
          continue;
        }
        // No tool calls - we're done
        iterationTimings.push({ iteration: iteration + 1, llmDurationMs, toolNames: [] });
        finalAssistantMessage = responseMessage.content || "I apologize, but I was unable to generate a response.";
        finalUsageData = logTokenUsage(response, "Final response", activeModel);
        break;
      }

      console.log(`[generateChatResponse] Executing ${responseMessage.tool_calls.length} tool calls`);

      for (const toolCall of responseMessage.tool_calls) {
        let functionArgs: any;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
          console.log(`[generateChatResponse] Executing tool: ${toolCall.function.name}`, functionArgs);
          onToolStart?.(toolCall.function.name);
          const extraContext: Record<string, any> = {};
          if (socketId) extraContext.socketId = socketId;
          if (isDelegatedAdmin) extraContext.isDelegatedAdmin = true;
          if (isDelegatedAdmin && adminEmail) extraContext.adminEmail = adminEmail;
          // ENG-2072: this is the Emma-sidebar chat turn — a real person is
          // present (see the ENG-803 comment above in getEmmaSystemContext),
          // so never let createWorkPlan/modifyWorkPlan/applyPredefinedWorkPlan
          // fall back to session.sessionType==='scheduled' and force hands-off
          // work-plan autocomplete on an attended turn.
          extraContext.isUnattendedRun = false;
          const result = await agentModeService.executeTool(activeModel, toolCall.function.name, functionArgs, userId!, sessionId, false, Object.keys(extraContext).length ? extraContext : undefined);
          console.log(`[generateChatResponse] Tool ${toolCall.function.name} executed successfully`);
          // ENG-351: harvest web-search sources into the citation registry.
          let citationBatch: Citation[] = [];
          if (WEB_SEARCH_TOOL_NAMES.has(toolCall.function.name)) {
            citationBatch = citationRegistry.registerSearchResults((result as any)?.results);
          }
          toolCalls.push({ id: toolCall.id, name: toolCall.function.name, arguments: functionArgs, result });
          let toolContent = typeof result === 'string' ? result : JSON.stringify(result);
          // ENG-351 Phase 2: prepend the {{cite:N}} id→source map so the sidebar model cites inline.
          if (citationBatch.length > 0) {
            toolContent = buildCitationIndexBlock(citationBatch) + toolContent;
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.function.name, content: toolContent, metadata: { timestamp: new Date().toISOString() } });
        } catch (error) {
          console.error(`[generateChatResponse] Tool execution error for ${toolCall.function.name}:`, error);
          toolCalls.push({ id: toolCall.id, name: toolCall.function.name, arguments: functionArgs || toolCall.function.arguments, error: error instanceof Error ? error.message : 'Unknown error' });
          const errorContent = JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.function.name, content: errorContent, metadata: { timestamp: new Date().toISOString() } });
        }
      }

      const toolNamesList = responseMessage.tool_calls.map((tc: any) => tc.function.name);
      iterationTimings.push({ iteration: iteration + 1, llmDurationMs, toolNames: toolNamesList });
      iteration++;
    }

    // Safety check: if we hit max iterations, ensure we have a response
    if (iteration >= MAX_ITERATIONS && !finalAssistantMessage) {
      finalAssistantMessage = "I apologize, but I reached the maximum number of iterations. Please try again with a simpler request.";
      console.warn(`[generateChatResponse] Hit MAX_ITERATIONS (${MAX_ITERATIONS})`);
    }

    // ENG-1222: a turn that made zero real tool calls must never present its own
    // prose as if it were actual/real tool-derived data — this is exactly the P0
    // fabrication pattern (an invented Google Ads account presented as "the
    // ACTUAL returned rows"). toolCalls.length === 0 is ground truth for whether
    // anything really executed. The phrase match alone over-fires on innocent
    // text like "based on your actual account settings" (no tool-result claim at
    // all) — genuine fabrication also presents something ID/list-shaped to look
    // authentic, so require both signals together to cut that false-positive rate
    // without weakening the check against the actual incident pattern.
    const CLAIMS_REAL_TOOL_OUTPUT = /\bactual(?:ly)?\s+(?:returned|return|results?|rows?|data|account\s+(?:names?|ids?))\b|\breal\s+(?:api|account|customer)\s+data\b/i;
    const LOOKS_LIKE_TOOL_SHAPED_DATA = /\d{3,}|(?:^|\n)\s*[-*•]\s|(?:^|\n)\s*\d+[.)]\s/;
    // An honest refusal ("I can't reach your actual data, but here's how to
    // check it yourself:" followed by a bulleted list) satisfies both patterns
    // above on a zero-tool turn. Scoped to a denial word immediately followed by
    // an access verb, not any negation within reach of "actual" — "I don't know
    // why, but here are the actual returned rows" is genuine fabrication and
    // must still be caught, so a bare "don't"/"can't" elsewhere in the sentence
    // doesn't exempt it.
    const DENIES_REAL_TOOL_ACCESS = /\b(?:can(?:'|’)?t|cannot|don(?:'|’)?t|unable to|without)\s+(?:access(?:ing)?|reach(?:ing)?|retriev(?:e|ing)|get(?:ting)?|provid(?:e|ing)|check(?:ing)?|pull(?:ing)?|fetch(?:ing)?|see(?:ing)?)\b[^.!?]{0,30}\bactual\b/i;
    // A turn where every tool call threw still pushes those failures into
    // toolCalls (see the catch block above), so toolCalls.length alone isn't
    // "something really executed" — it must have at least one call that didn't
    // error and didn't report an explicit { success: false } result.
    const isFailedToolResult = (result: any): boolean => {
      // Tool results aren't always objects — some handlers return a JSON string
      // (see toolContent above). A string result with success:false must count
      // as a failure too, or a serialized error slips past the `.success`
      // property check (undefined on a string, so `!== false` is trivially true).
      const parsed = typeof result === 'string'
        ? (() => { try { return JSON.parse(result); } catch { return undefined; } })()
        : result;
      return parsed?.success === false;
    };
    const hasSuccessfulToolCall = toolCalls.some((tc) => !tc.error && !isFailedToolResult(tc.result));
    if (
      !hasSuccessfulToolCall
      && CLAIMS_REAL_TOOL_OUTPUT.test(finalAssistantMessage)
      && LOOKS_LIKE_TOOL_SHAPED_DATA.test(finalAssistantMessage)
      && !DENIES_REAL_TOOL_ACCESS.test(finalAssistantMessage)
    ) {
      console.error('[generateChatResponse] Blocked a zero-tool-call response claiming real tool-derived data', { sessionId, portalType });
      finalAssistantMessage = "I wasn't able to actually run the tools needed to get real data for this, so I don't have genuine results to share. Please try again, and let us know if this keeps happening.";
    }

    // Calculate memory usage delta and current state
    const endMemory = process.memoryUsage();
    const endTime = Date.now();
    const memoryUsage = {
      heapUsedDeltaMB: Number(((endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024).toFixed(2)),
      heapTotalDeltaMB: Number(((endMemory.heapTotal - startMemory.heapTotal) / 1024 / 1024).toFixed(2)),
      rssDeltaMB: Number(((endMemory.rss - startMemory.rss) / 1024 / 1024).toFixed(2)),
      currentHeapUsedMB: Number((endMemory.heapUsed / 1024 / 1024).toFixed(2)),
      currentHeapTotalMB: Number((endMemory.heapTotal / 1024 / 1024).toFixed(2)),
      currentRssMB: Number((endMemory.rss / 1024 / 1024).toFixed(2)),
      durationMs: endTime - startTime
    };

    // Save all new messages to session
    const assistantMessageMetadata = {
      currentUrl,
      pageContentLength: pageContent?.length,
      knowledgeBaseChunks: activeKnowledgeBase.length,
      pageChunks: pageChunksCount,
      relevantChunks: relevantChunksInfo,
      timestamp,
      portalType,
      iterationTimings,
      memoryUsage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined, // Include tool calls if any
      citations: citationRegistry.size > 0 ? citationRegistry.list() : undefined // ENG-351: web sources for the Sources UI
    };

    // Add final assistant message
    await chatbotDb.addMessageToSession(sessionId, {
      role: "assistant",
      content: finalAssistantMessage,
      // ENG-1222: stamp the model that actually generated this turn so
      // apiTools.ts's per-session attribution (attributionBasis/generationModels/
      // costByModel) reads 'transcript' instead of falling back to
      // 'selection-only' — without this, spend/model telemetry for every Emma
      // turn is invisible to the tool-binding-failure fingerprint the P0 relied on.
      llm: activeModel,
      usage: finalUsageData,
      metadata: assistantMessageMetadata,
    });

    // Compute page invalidations from successful tool calls
    const PAGE_INVALIDATION_MAP: Record<string, string[]> = {
      'update_brand_guidelines': ['brand-guidelines'],
      'update_market_strategy': ['market-strategy'],
      'regenerate_market_strategy': ['market-strategy', 'brand-guidelines'],
      'update_gtm_plan': ['gtm-plan'],
      'add_gtm_phase': ['gtm-plan'],
      'add_gtm_work_items': ['gtm-plan'],
      'update_gtm_work_item': ['gtm-plan'],
      'create_gtm_plan': ['gtm-plan'],
      'update_lead': ['crm'],
      'create_lead_list': ['crm'],
      'update_book_content': ['books'],
      'create_book': ['books'],
      'create_html_from_template': ['templates'],
      'update_html_file': ['templates'],
      'create_knowledge_base': ['knowledge-base'],
      'update_knowledge_base_file': ['knowledge-base'],
    };

    const allInvalidations = [...new Set(
      toolCalls
        .filter((tc) => !tc.error)
        .flatMap((tc) => PAGE_INVALIDATION_MAP[tc.name] || [])
    )];

    // Return response object (like Agent Mode, not just string)
    if (toolCalls.length > 0) {
      return {
        content: finalAssistantMessage,
        toolCalls: toolCalls,
        ...(allInvalidations.length > 0 ? { invalidations: allInvalidations } : {})
      };
    } else {
      // For backward compatibility with partner portal
      return finalAssistantMessage;
    }
  } catch (error) {
    console.error("[generateChatResponse] Error:", error);
    throw error;
  }
}

// Update task execution status in chat session
export async function updateTaskExecutionStatus(
  sessionId: string,
  taskId: string,
  executionId: string,
  newStatus: string
): Promise<void> {
  try {
    console.log(`Updating task execution status for session ${sessionId}, task ${taskId}, execution ${executionId} to ${newStatus}`);
    
    // Get the current session
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Find the message index with the task execution and update it
    let messageIndexToUpdate: number | null = null;
    let updatedMessage: ChatMessage | null = null;

    for (let i = 0; i < session.messages.length; i++) {
      const message = session.messages[i];
      if (message.metadata?.toolCalls) {
        const hasMatchingToolCall = message.metadata.toolCalls.some((toolCall: any) => {
          return toolCall.result && 
                 toolCall.result.taskId === taskId && 
                 toolCall.result.executionId === executionId;
        });

        if (hasMatchingToolCall) {
          const updatedToolCalls = message.metadata.toolCalls.map((toolCall: any) => {
            if (toolCall.result && 
                toolCall.result.taskId === taskId && 
                toolCall.result.executionId === executionId) {
              return {
                ...toolCall,
                result: {
                  ...toolCall.result,
                  status: newStatus
                }
              };
            }
            return toolCall;
          });

          updatedMessage = {
            ...message,
            metadata: {
              ...message.metadata,
              toolCalls: updatedToolCalls
            }
          };
          messageIndexToUpdate = i;
          break;
        }
      }
    }

    // Update the message in AW-ChatMessages if found
    if (messageIndexToUpdate !== null && updatedMessage) {
      await chatbotDb.updateMessageInSession(sessionId, messageIndexToUpdate, updatedMessage);
      console.log(`Successfully updated task execution status for session ${sessionId} at message index ${messageIndexToUpdate}`);
    } else {
      console.log(`No matching message found for task ${taskId}, execution ${executionId} in session ${sessionId}`);
    }
  } catch (error) {
    console.error('Error updating task execution status:', error);
    throw error;
  }
}
