import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { S3 } from "aws-sdk";
import { Task } from "../types/task";
import { paginatedQuery, paginatedScan, paginatedCount } from "../utils/dynamoPagination";
import { buildLeadCrmFields, buildLeadAttributionFields, computeNameCompanyKey } from "../utils/leadSchema";
import { mergeCustomFields, sanitizeCustomFields } from "../utils/customFieldsGuard";
import { encryptPassword, decryptPassword } from "../utils/crypto";
import type { AttributionTouch } from "../types/attribution";
import { contactEventsDb, normalizeContactId } from "./contactEventsDb";
import { onUserSignup } from "./crmSignalHooks";
import { normalizeLinkedInUrl } from "./enrichmentGroups";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// For debugging

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const CHAT_SESSIONS_TABLE = `${TABLE_PREFIX}AW-ChatSessions`;

// Initialize S3 client
const s3 = new S3();

// Helper function to handle DynamoDB errors
const handleDynamoDbError = (error: any, operation: string) => {
  console.error(`DynamoDB ${operation} error:`, error);
  if (error.code === "CredentialsError") {
    throw new Error(
      "AWS credentials are invalid or missing. Please check your .env file"
    );
  }
  throw error;
};

/**
 * De-duplicate LinkedIn message events.
 *
 * When a user sends a LinkedIn message from the CRM, the send endpoint writes a
 * synthetic event (eventId `linkedin_sent_<ts>_<leadId>`, senderId = accountId)
 * for instant UI feedback. The periodic message sync later re-imports the SAME
 * message from Unipile keyed on the message's stable provider_id (eventId
 * `linkedin_msg_<provider_id>`). The two have different eventIds, so without
 * this the same outbound message appears (and counts) twice.
 *
 * Strategy: prefer the synced `linkedin_msg_*` event (it has the real provider
 * id and timestamp). Drop a synthetic `linkedin_sent_*` SENT event when a synced
 * SENT event with the same normalized text exists for the lead. Matching on text
 * (not timestamp) is robust because send-time and sync-time timestamps differ.
 */
const dedupeLinkedInMessageEvents = <T extends { eventId?: string; eventType?: string; data?: any; eventData?: any }>(
  events: T[],
): T[] => {
  const norm = (e: any): string => {
    const data = e?.data ?? e?.eventData ?? {};
    return String(data?.text ?? '').trim().toLowerCase();
  };
  const isSent = (e: any) => String(e?.eventType || '').toLowerCase().includes('sent');
  const isSynced = (e: any) => String(e?.eventId || '').startsWith('linkedin_msg_');
  const isSynthetic = (e: any) => String(e?.eventId || '').startsWith('linkedin_sent_');

  // Texts that already have a synced SENT event.
  const syncedSentText = new Set<string>();
  for (const e of events) {
    if (isSynced(e) && isSent(e)) {
      const t = norm(e);
      if (t) syncedSentText.add(t);
    }
  }
  if (syncedSentText.size === 0) return events;

  return events.filter((e) => {
    if (isSynthetic(e) && isSent(e)) {
      const t = norm(e);
      if (t && syncedSentText.has(t)) return false; // drop the synthetic duplicate
    }
    return true;
  });
};

const ENGAGED_EVENT_KEYWORDS = ["clicked", "replied", "received"];

const engagementMatchesKeyword = (engagement: any): boolean => {
  const eventType = String(engagement?.eventType || "").toLowerCase();
  const eventData = String(JSON.stringify(engagement?.eventData || {})).toLowerCase();
  return ENGAGED_EVENT_KEYWORDS.some(
    (keyword) => eventType.includes(keyword) || eventData.includes(keyword)
  );
};

// Ensure the User interface is exported
export interface User {
  userId: string;
  email: string;
  password: string;
  isOAuthUser: boolean;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginTime?: string;
  lastActiveAt?: string; // Updated when user creates a chat session (non-delegated); more accurate than lastLoginTime for DAU/WAU/MAU
  signupSource?: "password" | "oauth" | "waitlist" | "admin" | string; // How the account was created. Set at signup; do not mutate.
  funnelStatus?: string | null; // Admin-owned business funnel status for triage/prioritization.
  supportNote?: string;
  roles?: ("partner" | "customer" | "free" | "contractor")[];
  displayName?: string;
  stripe_customer_id?: string;
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  resendDomainId?: string; // Resend domain ID for domain verification
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
  slackChannel?: string; // @deprecated — use slackChannels. Kept for backward-compat reads.
  slackChannels?: string[]; // Slack channels configured for this user (agent tools are restricted to these)
  slackSuggestedRepliesDisabled?: boolean; // When true, suppress Slack suggested-reply (slack-triggered) sessions/emails for this user. Absent/false = enabled (default).
  slackShipNotifyDisabled?: boolean; // When true, suppress the Slack ping when an item this user reported ships (shipNotifyService). Absent/false = enabled (default).
  secrets?: Record<string, string>; // Encrypted per-user secrets (key → encrypted value)
  seoDomains?: string[]; // SEO domains to track (e.g., ["example.com", "subdomain.example.com"])
  googleAnalyticsPropertyId?: string; // DEPRECATED: Google Analytics Property ID (numeric, e.g., 123456789) - use googleAnalyticsProperties instead
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>; // Array of GA4 properties with labels
  gaFilteredDomains?: string[]; // Domains to exclude from Google Analytics (e.g., ["app.example.com", "admin.example.com"])
  clarityProjectId?: string; // DEPRECATED: Microsoft Clarity Project ID (e.g., ul13e4f7fe) - use clarityProjects instead
  clarityProjects?: Array<{ projectId: string; label: string }>; // Array of Clarity projects with labels
  productDomain?: string; // Product site domain for feature usage tracking (e.g., "app.example.com")
  funnelConfig?: {
    stages: Array<{
      name: string;
      eventName: string; // GA4 event name (e.g., "page_view", "button_click", "purchase")
      filterExpression?: string; // GA4 filter (e.g., "pagePath=~/pricing")
      color: string;
    }>;
  }; // User journey funnel configuration for SEO analytics
  googleDriveFolders?: Array<{ folderId: string; name: string }>; // Google Drive shared folder IDs
  cmsType?: "Basehub" | "Webflow" | "WordPress"; // CMS Type for blog publishing
  companyName?: string;
  slackConnectStatus?: "disabled" | "skipped" | "created" | "failed";
  slackConnectChannelId?: string;
  slackConnectInvitedAt?: string;
  slackConnectAttemptedAt?: string;
  slackConnectInviteEmail?: string;
  slackConnectInviteId?: string;
  slackConnectError?: string | null;
  memoryEnabled?: boolean; // Whether Emma's long-term memory is enabled (default: true)
  useCaseCategories?: string[];
  emmaHelpInterests?: string[]; // Onboarding multi-select: what user wants Emma to help with (e.g., "brand", "paid_ads", "founder_led_sales")
  emmaHelpInterestsSetAt?: string; // ISO timestamp when the user first saved their interests
  fathomOnboardingIngestions?: Array<Record<string, unknown>>; // Review-first Fathom sales/prospect-call onboarding context ledger
  fathomDraftAccount?: boolean; // System-created disabled account from Harsha-owned Fathom onboarding automation.
  fathomDraftStatus?: "needs_review" | "approved" | "discarded" | string;
  fathomReviewOwnerUserId?: string;
  fathomSourceRecordingId?: string;
  fathomSourceRecordingUrl?: string;
  fathomSourceContactEmail?: string;
  fathomSourceContactName?: string;
  fathomSourceWebsite?: string;
  /**
   * Onboarding event log — appended to by POST /api/onboarding/events. Used
   * by the Lifecycle Drip Phase 1 feature to derive `onboardingStage`. Each
   * entry is the event name, server-side timestamp, and optional payload.
   * Capped to the last 50 events to keep the User record bounded; older
   * events are dropped FIFO.
   */
  onboardingEvents?: Array<{
    event: string;
    ts: string;
    data?: Record<string, unknown>;
  }>;
  /**
   * Derived onboarding stage, recomputed from `onboardingEvents` every time
   * a new event is recorded. Not stored as source-of-truth — rebuildable
   * from the event log via `deriveOnboardingStage` (utils/onboardingStage).
   * Persisted so Dynamo queries can filter by stage without replaying the log.
   */
  onboardingStage?: string;
  /**
   * Lifecycle Drip — Phase 4. When `true`, the drip executor MUST NOT send
   * this user any drip campaign email, regardless of segment match. Set by
   * the per-user unsubscribe flow (future: `POST /api/drip/unsubscribe`).
   */
  dripUnsubscribed?: boolean;
  onboardingProgress?: Record<string, boolean>; // Checklist step completion state (stepId → true)
  onboardingDismissed?: boolean; // Whether the user has dismissed the onboarding checklist
  /**
   * Onboarding v2 Phase 1 — brand build async status.
   * Set to 'building' when the onboarding flow kicks off brand extraction,
   * flipped to 'ready' when `brandGuidelines` is next written, or 'failed'
   * on timeout/error. The UI renders a status pill based on this value so
   * latency-hiding question screens (Phase 2) can proceed in parallel.
   */
  brandBuildStatus?: "building" | "ready" | "failed";
  /** ISO timestamp when the async brand build was kicked off. */
  brandBuildStartedAt?: string;
  /** ISO timestamp when the build terminated (ready or failed). */
  brandBuildCompletedAt?: string;
  /** Wall-clock duration in ms from start to completion. Used for p50/p99 metrics. */
  brandBuildDurationMs?: number;
  /** Error message if `brandBuildStatus === 'failed'`. Surfaced to the graceful-fallback UI. */
  brandBuildError?: string;
  /**
   * Onboarding v2 Phase 4 — ad creative generation async status.
   * Separate state machine from brandBuildStatus because the two runs are
   * concurrent during Phase 3→4 transition and have different timeout
   * budgets. See `backend/src/services/adGenStatusService.ts`.
   */
  adGenStatus?: "generating" | "ready" | "failed";
  /** ISO timestamp when ad-gen was kicked off. */
  adGenStartedAt?: string;
  /** ISO timestamp when ad-gen terminated (ready or failed). */
  adGenCompletedAt?: string;
  /** Wall-clock duration in ms. Used for p50/p99 metrics. */
  adGenDurationMs?: number;
  /** Error message if `adGenStatus === 'failed'`. */
  adGenError?: string;
  /**
   * Persisted ad variants from the last successful generation. Rendered by
   * the Phase 4 reveal UI. Array is capped at MAX_AD_VARIANTS (3) and each
   * field is length-bounded — see `sanitizeAdVariants` for the contract.
   */
  adGenVariants?: Array<{
    id: string;
    headline: string;
    primaryText: string;
    cta: string;
    imageUrl?: string;
  }>;
  /**
   * Onboarding Epic — per-step state machines.
   *
   * Five concurrent state machines that each track one async step the
   * onboarding flow can fire (ICP, competitor, creative direction, ad
   * image, ad copy). The legacy single-axis `adGenStatus` mixed image +
   * copy in one machine; this Epic splits each axis so a single failure
   * doesn't block the others, and each screen can drive the step it hides
   * without guessing what's already in flight.
   *
   * Each axis has the same shape (status / startedAt / completedAt /
   * durationMs / error / result), tracked in its own pure state-machine
   * module under `services/{axis}StatusService.ts` and exposed via
   * `routes/onboardingSteps.ts`. Result types are loose `unknown[]`-ish
   * structures so the LLM-output boundary can tighten them without
   * churning persistence types every prompt iteration.
   *
   * State values: idle | running | ready | failed.
   *   idle      — never started OR explicit reset
   *   running   — async work in flight
   *   ready     — terminal: result populated
   *   failed    — terminal: error populated
   *
   * See:
   *   - icpStatusService.ts        (5 personas)
   *   - competitorStatusService.ts (per-icp targeting briefs)
   *   - creativeDirStatusService.ts (concepts + copy angles + archetypes)
   *   - adImageStatusService.ts    (3 image variants)
   *   - adCopyStatusService.ts     (3 copy variants with variety tags)
   */
  // ── ICP axis ──
  icpStatus?: "idle" | "running" | "ready" | "failed";
  icpStartedAt?: string;
  icpCompletedAt?: string;
  icpDurationMs?: number;
  icpError?: string;
  icpResult?: Array<{
    name: string;
    pain: string;
    desire: string;
    objection: string;
    meta_targeting_brief: string;
  }>;
  // ── Competitor axis ──
  competitorStatus?: "idle" | "running" | "ready" | "failed";
  competitorStartedAt?: string;
  competitorCompletedAt?: string;
  competitorDurationMs?: number;
  competitorError?: string;
  competitorResult?: {
    per_icp: Array<{
      icp_id: string;
      competitor_names: string[];
      offer_angles: string[];
      meta_targeting_brief: string;
    }>;
  };
  // ── Creative direction axis ──
  creativeDirStatus?: "idle" | "running" | "ready" | "failed";
  creativeDirStartedAt?: string;
  creativeDirCompletedAt?: string;
  creativeDirDurationMs?: number;
  creativeDirError?: string;
  creativeDirResult?: {
    concepts: string[];
    copy_angles: string[];
    format_archetypes: string[];
  };
  // ── Ad image axis ──
  adImageStatus?: "idle" | "running" | "ready" | "failed";
  adImageStartedAt?: string;
  adImageCompletedAt?: string;
  adImageDurationMs?: number;
  adImageError?: string;
  adImageResult?: {
    variants: Array<{
      id: string;
      imageUrl: string;
      prompt: string;
    }>;
  };
  // ── Ad copy axis ──
  adCopyStatus?: "idle" | "running" | "ready" | "failed";
  adCopyStartedAt?: string;
  adCopyCompletedAt?: string;
  adCopyDurationMs?: number;
  adCopyError?: string;
  adCopyResult?: {
    variants: Array<{
      id: string;
      headline: string;
      primaryText: string;
      cta: string;
      variety: string;
    }>;
  };
  // ── Ad variant ratings (Phase 4 "Ads Tinder" swipe UI) ──
  // Append-only log of like/reject decisions per variant. Capped at 50.
  // Used by the LLM regen prompts to bias future variants away from
  // rejected directions. See `adVariantRatingService.ts`.
  adVariantsRated?: Array<{
    variantId: string;
    rating: "like" | "reject";
    ratedAt: string;
  }>;
  /**
   * How new landing pages are organized when the agent doesn't target a specific
   * site. `unified` (default): add the page to the user's existing site as a route
   * — cheap (no new repo/project, shares the subdomain). `separate`: each new
   * campaign gets its OWN site/subdomain — more costly (a fresh v0 generation +
   * repo + project). Cost-safe default is `unified`; users who want distinct
   * campaign URLs (e.g. Empathia) opt into `separate`. The agent can still override
   * per request. Only consulted when DURABLE_LANDING_GENERATION is on.
   */
  landingSiteMode?: "unified" | "separate";
  brandGuidelines?: {
    brandData: {
      brandName: string;
      tagline: string;
      domain?: string;
      primaryColor: string;
      primaryColorEnd: string;
      secondaryColor: string;
      fontFamily: string;
      toneOfVoice: string;
      keyMessages: string[];
      brandValues: string[];
      targetAudience: string;
      brandPersonality: string;
      isGradient: boolean;
      founders: Array<{
        name: string;
        jobTitle: string;
        styleTone: string;
        signaturePosts: string;
      }>;
    };
    attachments: Array<{
      type: string;
      url: string;
      key: string;
      filename: string;
    }>;
    createdAt: string;
    updatedAt: string;
  };
  marketStrategy?: {
    businessOverview: string;
    competitors: Array<{
      name: string;
      description: string;
    }>;
    icp: Array<{
      title: string;
      description: string;
      valueProposition: string;
      buyerPersonas: string[];
    }>;
    createdAt: string;
    updatedAt: string;
  };
  startupProfiles?: Array<{
    id: string;
    companyName: string;
    industry: string;
    companySize: string;
    targetMarket: string;
    currentChallenges: string;
    goals: string;
    createdAt: string;
    updatedAt: string;
  }>;
  /**
   * Onboarding v2 — value proposition the user committed to on the
   * BrandReview gate screen (between dataGathering and adReveal).
   * Stored separately from `marketStrategy.icp[].valueProposition` because
   * it represents the brand-level value prop, not a per-ICP one.
   */
  valueProp?: string;
  introductionEmailSent?: string; // ISO date when the team introduction email was sent
  resetPasswordToken?: string;
  resetPasswordExpires?: string;
  /**
   * Monotonic session generation counter. Embedded as `sv` in every issued JWT.
   * Incremented on any successful password change (authenticated change-password
   * or reset-via-token) so that all previously-issued tokens — i.e. sessions on
   * other devices — are rejected by the auth middleware. Absent = 0.
   */
  sessionVersion?: number;
  /**
   * Set when the account is created with a system-generated initial password
   * (e.g. admin creating a user from the waitlist). The user MUST set their own
   * password before this timestamp; the initial secret cannot become a
   * long-term password. Login is rejected once `Date.now()` passes this value
   * (see the login controller). Set to `null` to clear it when the user sets
   * their own password (updateUser only persists `null`, it skips `undefined`).
   */
  tempPasswordExpires?: string | null;
  /**
   * True while the account still holds its system-generated initial password.
   * Surfaced to the frontend (via /login and /me) so it can force an immediate
   * password change. Cleared when the user sets their own password.
   */
  mustChangePassword?: boolean;
  subscriptionType?: string | null; // Subscription type for customer-portal users (defaults to "Free")
  tokenUsage?: {
    month: string;        // "YYYY-MM" format for current tracking month
    totalTokens: number;  // cumulative tokens used this month
    totalCost: number;    // cumulative cost in USD this month
    resetDate: string;    // ISO date of next monthly reset
  };
  tokenUsageHistory?: Array<{
    month: string;       // "YYYY-MM" format
    totalTokens: number;
    totalCost: number;
  }>;                    // Up to 24 past months of usage, oldest first
  tokenAllowanceBonus?: number; // One-time bonus tokens granted by admin (resets on monthly reset)
  extraCostUsage?: {
    month: string;      // "YYYY-MM" format for current tracking month
    totalCost: number;  // cumulative extra API cost in USD this month (enrichment, image gen, etc.)
    breakdown: Record<string, number>; // cost by source key (e.g. { enrichment: 4.5, image_gen: 1.2 })
    resetDate: string;  // ISO date of next monthly reset
  };
  extraCostUsageHistory?: Array<{
    month: string;
    totalCost: number;
    breakdown: Record<string, number>;
  }>;                   // Up to 24 past months, oldest first
  stripe_subscription_id?: string; // Stripe subscription ID
  subscription_status?: string; // Stripe subscription status: active, trialing, past_due, canceled, canceling
  current_period_end?: string; // ISO date of current billing period end
  has_payment_method?: boolean; // Whether customer has a payment method on file in Stripe
  subscription_amount?: number; // Most recent invoice amount paid, in cents (e.g. 4900 = $49.00)
  /**
   * Active Stripe coupon/discount applied to the subscription (e.g., 90% off for 6 months).
   * Synced from subscription.discount on all webhook and reconcile paths.
   * Set to null when the discount is removed from the subscription.
   */
  activeOffer?: {
    couponId: string;
    couponName: string | null;
    percentOff: number | null;
    amountOff: number | null; // in cents
    duration: 'forever' | 'once' | 'repeating';
    durationInMonths: number | null; // only set when duration = 'repeating'
    endsAt: string | null; // ISO date when the discount expires (from subscription.discount.end)
  } | null;
  /**
   * A scheduled subscription change queued in Stripe (e.g., scheduled downgrade
   * from Pro to Starter that takes effect at period_end). Cached here from
   * subscription_schedules so the UI can surface it without hitting Stripe on
   * every /auth/me. Cleared when: (a) the schedule fires (webhook → schedule.completed),
   * (b) the user explicitly cancels it via /api/stripe/cancel-scheduled-downgrade,
   * or (c) the schedule is released/canceled for any other reason (webhook).
   */
  scheduledChange?: {
    stripeScheduleId: string;
    toPriceId: string;
    toTier: string; // e.g., "Starter"
    effectiveAt: string; // ISO 8601
  } | null;
  /**
   * Stripe Connect OAuth — customer-authorized read-only access to their own
   * Stripe account. Used to enrich CRM contacts with the customer's live
   * billing data (not AgentWeb's platform billing).
   *
   * Tokens are encrypted at rest via utils/stripeConnectCrypto.encryptConnectToken.
   * Never log or return the encrypted values to the client.
   */
  stripeConnectedAccountId?: string; // acct_xxx of the connected Stripe account
  stripeConnectedAt?: string; // ISO datetime when OAuth was completed
  stripeConnectAccessToken?: string; // AES-256-GCM encrypted
  stripeConnectRefreshToken?: string; // AES-256-GCM encrypted
  stripeConnectScope?: string; // Granted scope, expected: "read_only"
  stripeConnectMode?: 'live' | 'test'; // Which Stripe mode the connection was made in
  connected_accounts?: Array<{
    platform: 'linkedin' | 'facebook'
    | 'meta' | 'twitter' | 'instagram' | 'hubspot' | 'attio' | 'fathom' | 'gmail' | 'outlook' | 'youtube' | 'clickup';
    account_id: string;
    account_name: string;
    config: {
      account_type: 'personal' | 'company_page';
      profile_id?: string;
      page_id?: string;
      organization_id?: string;
      access_token: string;
      refresh_token?: string;
      token_expires_at: number;
      scopes: string[];
    };
    /** Per-account automated engagement settings (inline on the account) */
    engagementSettings?: {
      // POST ENGAGEMENT — OWNER ROLE
      /** Allow others to engage on my posts */
      enablePostDiscovery: boolean;
      /** Which actions this account's posts can receive from other engagers */
      preferredActions: ('like' | 'comment')[];
      /** Incoming cap: max likes this account's posts can receive per post */
      maxLikesPerPost: number;
      /** Incoming cap: max comments this account's posts can receive per post */
      maxCommentsPerPost: number;
      /** Spread engagements randomly within this window (minutes) */
      engagementWindowMinutes: number;

      // POST ENGAGEMENT — ENGAGER ROLE
      /** Allow this account to engage on others' posts */
      enableAsPostEngager: boolean;

      // COMMENT ENGAGEMENT — OWNER ROLE
      /** Allow others to engage on comments on my posts */
      enableCommentDiscovery: boolean;
      /** Which actions others can take on comments on my posts */
      commentPreferredActions: ('like' | 'reply')[];
      /** Max likes each comment on my posts can receive */
      maxCommentLikesPerPost: number;
      /** Max replies each comment on my posts can receive */
      maxCommentRepliesPerPost: number;
      /** Spread comment engagements randomly within this window (minutes) */
      commentEngagementWindowMinutes: number;

      /** Personality/tone for auto-generated comments and replies */
      personality?: {
        /** Selected preset tones (e.g. "funny", "visionary") */
        presets: string[];
        /** Free-text custom personality description */
        custom?: string;
      };
    };
    /** When true, org members can see and use this account. Default: false (private). */
    sharedWithOrg?: boolean;
    created_at: string;
    updated_at: string;
  }>;
  allowedPages?: string[];
  allowedSkills?: string[];
  orgId?: string;
  orgRole?: "owner" | "member";
  // Set when an org owner invites this email; cleared when invite is accepted or cancelled.
  // Used to redirect users straight to accept-invite instead of onboarding.
  // null is used by updateUser to explicitly remove the field from DynamoDB.
  pendingOrgInvite?: { orgId: string; inviteToken: string } | null;
  /**
   * Attribution — forward-compatible with a future UserTouches timeline table.
   * firstTouch is set once at signup and never mutated; lastTouch refreshes on
   * each login where the client sends new attribution data.
   * Top-level utmSource / utmMedium are denormalized from firstTouch for cheap
   * channel-attribution queries without scanning the blob.
   */
  firstTouch?: import("../types/attribution").AttributionTouch;
  lastTouch?: import("../types/attribution").AttributionTouch;
  utmSource?: string;
  utmMedium?: string;
  /**
   * Saved CRM views — user's customized filter+sort combinations applied
   * to the /crm dashboard tabs. Built-in presets are injected by the
   * savedViews route and NOT persisted here (isPreset views are returned
   * from code, never written). Only user-saved views are stored.
   * See `backend/src/routes/crm.ts` saved-views endpoints.
   */
  savedViews?: Array<{
    viewId: string;
    name: string;
    scope: 'inbox' | 'working' | 'paying' | 'all';
    filters?: Record<string, any>;
    sort?: string;
    isPreset?: false; // user-saved views are never preset
    createdAt: string;
  }>;
  /**
   * Eager DAG onboarding pipeline — Phase 2.
   *
   * Replaces the per-axis status fields (icpStatus / competitorStatus /
   * creativeDirStatus / adImageStatus / adCopyStatus) with a unified
   * record per pipeline step. Each step carries an `inputsHash` for
   * dedup, a `generation` counter for cancel-and-replace concurrency,
   * and a `provenance` field so user-authored data is never overwritten
   * by anticipated runs.
   *
   * Read by `OnboardingPipelineOrchestrator.reconcile()` (services/
   * onboardingPipelineOrchestrator.ts). Writes are gated on the
   * `useEagerPipeline` field below + the env-level
   * `EAGER_ONBOARDING_PIPELINE_ENABLED` flag — when both are off, this
   * field is never read or written and the legacy per-axis status
   * machinery owns onboarding state.
   *
   * Sub-task 2 of the Eager DAG epic refactors the existing
   * `onboardingXService` files to delegate to the orchestrator rather
   * than cross-call each other. Sub-task 3 wires the FE polling hooks
   * to read `steps` instead of the per-axis status fields. This
   * sub-task (1) only adds the schema + the orchestrator service.
   */
  steps?: {
    brandDna?: import("./onboardingPipelineOrchestrator").StepRecord<unknown>;
    icp?: import("./onboardingPipelineOrchestrator").StepRecord<unknown>;
    competitor?: import("./onboardingPipelineOrchestrator").StepRecord<unknown>;
    creativeDir?: import("./onboardingPipelineOrchestrator").StepRecord<unknown>;
    adImage?: import("./onboardingPipelineOrchestrator").StepRecord<unknown>;
    adCopy?: import("./onboardingPipelineOrchestrator").StepRecord<unknown>;
  };
  /**
   * Per-user opt-in for the eager DAG onboarding pipeline. When `true`,
   * `OnboardingPipelineOrchestrator.reconcile()` runs even if the
   * env-level `EAGER_ONBOARDING_PIPELINE_ENABLED` flag is off. Lets us
   * roll the orchestrator out per-user before flipping it globally.
   * Default `undefined` / falsy = legacy per-axis status flow.
   */
  useEagerPipeline?: boolean;
  /** Admin-written retention note for this client. Written via POST /api/client-health/:clientId/notes. */
  clientHealthNote?: string;
}

export interface Organization {
  orgId: string;
  name: string;
  ownerUserId: string;
  brandGuidelines?: User["brandGuidelines"];
  marketStrategy?: User["marketStrategy"];
  startupProfiles?: User["startupProfiles"];
  connected_accounts?: User["connected_accounts"];
  seoDomains?: string[];
  cmsType?: "Basehub" | "Webflow" | "WordPress";
  emailDomain?: string;
  fromName?: string;
  slackChannel?: string;
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId?: string; // Explicit primary GA4 property (must be one of googleAnalyticsProperties)
  gaFilteredDomains?: string[]; // Domains to exclude from Google Analytics
  clarityProjects?: Array<{ projectId: string; label: string }>; // Microsoft Clarity projects
  productDomain?: string; // Product site domain for feature usage tracking
  /**
   * Migration marker. Absent → analytics config has never been written to this
   * Organization record; resolveAnalyticsConfig() falls back to the owner's user
   * record. "migrated" → set by the migration script. "self" → set by a
   * self-service or admin save. When present, the Org record is authoritative
   * (including empty arrays).
   */
  analyticsConfigSource?: "migrated" | "self";
  googleDriveFolders?: Array<{ folderId: string; name: string }>;
  pendingInvites?: Array<{
    email: string;
    inviteToken: string;
    invitedAt: string;
    invitedBy: string;
  }>;
  /**
   * Owner opt-in: when true, new signups whose email domain matches
   * autoJoinDomain create a pendingDomainJoinRequest and email the owner for
   * approval, instead of requiring an explicit invite. autoJoinDomain is
   * always derived server-side from the owner's own email domain — never
   * client-supplied — so an owner can't claim a domain they don't belong to.
   */
  autoJoinEnabled?: boolean;
  autoJoinDomain?: string;
  pendingDomainJoinRequests?: Array<{
    userId: string;
    email: string;
    requestedAt: string;
    requestToken: string;
  }>;
  maxMembers: number;
  /**
   * Denormalized, atomically-maintained member count — used ONLY as a fast
   * capacity gate at join time (via a DynamoDB transaction pairing the
   * increment with the joining user's write), never for display. Display
   * always uses the live GSI-backed member list (getOrgMembers), which can
   * never drift. Absent on orgs created before this field existed — every
   * live path (join/leave) fails closed on a missing value rather than
   * seeding it, since a live count can race with concurrent writes. Only
   * scripts/backfill-org-member-count.ts is allowed to initialize this field.
   */
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
  shareSettings?: OrgShareSettings;
  /**
   * Admin-controlled: when true, org members inherit the org owner's analytics
   * configuration (GA4 properties, gaFilteredDomains, productDomain, seoDomains,
   * clarityProjects). Set only by the platform admin via
   * PATCH /api/admin/orgs/:orgId/analytics-sharing. Default: undefined/false.
   */
  shareAnalyticsWithOrg?: boolean;
  secrets?: Record<string, string>; // Encrypted per-org secrets (key → encrypted value)
  orgMemoryEnabled?: boolean; // Whether org-wide Emma memory is enabled (default: true)
}

export interface OrgShareSettings {
  knowledgeBase: { enabled: boolean; editors: string[] };
  htmlTemplates: { enabled: boolean; editors: string[] };
  landingPages: { enabled: boolean; editors: string[] };
  workPlans: { enabled: boolean; editors: string[] };
  skills: { enabled: boolean; editors: string[] };
  analytics: { enabled: boolean; editors: string[] };
  // Always shared with org—only editors are configurable, enabled is implicit
  brandGuidelines: { editors: string[] };
  marketingStrategy: { editors: string[] };
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: "pending" | "answered";
  timestamp: number;
}

interface TaskAttachment {
  url: string;
  key: string;
  filename: string;
  uploadedAt: string;
}

interface TaskTemplate {
  templateId: string;
  userId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[];
  nameParameter: string | null;
  isInteractive: boolean;
  isDeepResearch: boolean;
  isComplexTask?: boolean;
  extractPageContent?: boolean;
  outputAsJson?: boolean;
  outputAsHtml?: boolean;
  emailFriendlyHtml?: boolean;
  repairImageEmbedding?: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
  category?: string;
  selectedLLMs?: string[];
  useSharedBrowser?: boolean;
  turnOffHeadless?: boolean;
  useKnowledgeBase?: boolean;
  updateKnowledgeBase?: boolean;
  updateLeadList?: boolean;
  createVideo?: boolean;
  requireApproval?: boolean;
  slackChannel?: string;
  isAgenticDevMode?: boolean;
}

interface UserWithCounts extends User {
  taskCount: number;
  workflowCount: number;
  chatSessionCount?: number;
}

/**
 * Registration/premium status for a single email, as returned by
 * userDb.getRegistrationStatusByEmails. One entry per input email (registered
 * or not) so callers (the funnel report, the get_registration_status agent
 * tool) can join the result back onto a list of CRM lead emails.
 */
export interface RegistrationStatus {
  email: string;
  /** True iff a (non-deleted) AW-Users record exists for this email. */
  registered: boolean;
  /** True iff the user's subscription is active or trialing. */
  isPremium: boolean;
  userId?: string;
  createdAt?: string;
  subscriptionType?: string | null;
  subscriptionStatus?: string;
  /**
   * Live count of the user's (non-archived) chat sessions. Only populated when
   * the caller passes { includeChatSessionCount: true } — it costs one COUNT
   * query per registered user, so it's opt-in. Lets the funnel report compute
   * the "Usage/Active" stage from this single join instead of scraping the admin
   * page or reading a customFields copy. Absent for unregistered emails.
   */
  chatSessionCount?: number;
}

export class UserDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName: string;

  constructor() {
    this.docClient = dynamodb;
    this.tableName = `${TABLE_PREFIX}AW-Users`;
  }

  private handleError(error: any, operation: string) {
    console.error(`DynamoDB ${operation} error:`, error);
    if (error.code === "ValidationException") {
      throw new Error(`Validation error during ${operation}: ${error.message}`);
    } else if (error.code === "ResourceNotFoundException") {
      throw new Error(`Table not found during ${operation}: ${error.message}`);
    } else if (error.code === "AccessDeniedException") {
      throw new Error(`Access denied during ${operation}: ${error.message}`);
    } else {
      throw new Error(`Error during ${operation}: ${error.message}`);
    }
  }

  private async getChatSessionCount(userId: string): Promise<number> {
    let totalCount = 0;
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined =
      undefined;

    do {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: CHAT_SESSIONS_TABLE,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        Select: "COUNT",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":archivedFalse": false,
        },
        FilterExpression:
          "(attribute_not_exists(archived) OR archived = :archivedFalse)",
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await this.docClient.query(params).promise();
      totalCount += result.Count || 0;
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return totalCount;
  }

  async getUserChatSessions(userId: string, days: number = 30): Promise<Array<{
    sessionId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    portalType?: string;
    sessionType?: string;
    delegateInfo?: { adminUserId: string; adminEmail: string; isDelegated: boolean };
  }>> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const results: Array<{
      sessionId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      portalType?: string;
      sessionType?: string;
      delegateInfo?: { adminUserId: string; adminEmail: string; isDelegated: boolean };
    }> = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined = undefined;

    do {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: CHAT_SESSIONS_TABLE,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId AND updatedAt >= :since",
        ProjectionExpression: "sessionId, title, createdAt, updatedAt, portalType, sessionType, delegateInfo",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":since": since,
          ":archivedFalse": false,
        },
        FilterExpression: "(attribute_not_exists(archived) OR archived = :archivedFalse)",
        ScanIndexForward: false,
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await this.docClient.query(params).promise();
      for (const item of result.Items || []) {
        results.push({
          sessionId: item.sessionId,
          title: item.title || "Untitled Session",
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          portalType: item.portalType,
          sessionType: item.sessionType,
          delegateInfo: item.delegateInfo,
        });
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Sort by updatedAt descending (most recent first)
    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return results;
  }

  async createUser(
    email: string,
    userId: string,
    password: string,
    isOAuthUser: boolean = false,
    isAdmin: boolean = false,
    roles: ("partner" | "customer" | "free")[] = ["partner"],
    displayName?: string,
    googleId?: string,
    stripe_customer_id?: string,
    companyName?: string,
    useCaseCategories?: string[],
    attribution?: import("../types/attribution").AttributionTouch
  ): Promise<User | undefined> {
    const itemToCreate: any = {
      userId,
      email: email.toLowerCase(),
      password,
      isOAuthUser,
      isAdmin,
      isActive: true,
      createdAt: new Date().toISOString(),
      roles,
    };

    if (displayName) {
      itemToCreate.displayName = displayName;
    }
    if (googleId) {
      itemToCreate.googleId = googleId;
    }
    if (stripe_customer_id) {
      itemToCreate.stripe_customer_id = stripe_customer_id;
    }
    if (companyName) {
      itemToCreate.companyName = companyName;
    }
    if (useCaseCategories && useCaseCategories.length > 0) {
      itemToCreate.useCaseCategories = useCaseCategories;
    }

    const params = {
      TableName: this.tableName,
      Item: itemToCreate,
      ConditionExpression: "attribute_not_exists(email)",
    };

    try {
      await this.docClient.put(params).promise();
      // Fire-and-forget CRM signal (B2). Never awaited — signup latency must not
      // depend on AW-ContactEvents. Errors are swallowed inside onUserSignup.
      void onUserSignup({
        userId,
        email: itemToCreate.email,
        displayName,
        companyName,
        isOAuthUser,
        createdAt: itemToCreate.createdAt,
        ...(attribution && { attribution }),
      });
      return params.Item as User;
    } catch (error) {
      handleDynamoDbError(error, "createUser");
      return undefined;
    }
  }

  async createFathomDraftUser(input: {
    email: string;
    userId: string;
    displayName?: string;
    companyName?: string;
    reviewOwnerUserId: string;
    sourceRecordingId: string;
    sourceRecordingUrl?: string;
    sourceContactEmail?: string;
    sourceContactName?: string;
    sourceWebsite?: string;
  }): Promise<User | undefined> {
    const now = new Date().toISOString();
    const normalizedEmail = input.email.toLowerCase();
    const itemToCreate: any = {
      userId: input.userId,
      email: normalizedEmail,
      password: "!disabled-fathom-draft-account!",
      isOAuthUser: false,
      isAdmin: false,
      isActive: false,
      createdAt: now,
      roles: ["customer"],
      signupSource: "fathom_auto_onboarding_draft",
      fathomDraftAccount: true,
      fathomDraftStatus: "needs_review",
      fathomReviewOwnerUserId: input.reviewOwnerUserId,
      fathomSourceRecordingId: input.sourceRecordingId,
      emailDomain: normalizedEmail.split("@")[1] || "agentweb.internal",
      memoryEnabled: true,
    };

    if (input.displayName) itemToCreate.displayName = input.displayName;
    if (input.companyName) itemToCreate.companyName = input.companyName;
    if (input.sourceRecordingUrl) itemToCreate.fathomSourceRecordingUrl = input.sourceRecordingUrl;
    if (input.sourceContactEmail) itemToCreate.fathomSourceContactEmail = input.sourceContactEmail.toLowerCase();
    if (input.sourceContactName) itemToCreate.fathomSourceContactName = input.sourceContactName;
    if (input.sourceWebsite) itemToCreate.fathomSourceWebsite = input.sourceWebsite;

    const params = {
      TableName: this.tableName,
      Item: itemToCreate,
      ConditionExpression: "attribute_not_exists(email)",
    };

    try {
      await this.docClient.put(params).promise();
      return params.Item as User;
    } catch (error) {
      handleDynamoDbError(error, "createFathomDraftUser");
      return undefined;
    }
  }

  async getUserByEmail(email: string) {
    const params = {
      TableName: this.tableName,
      IndexName: "EmailIndex",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": email.toLowerCase(),
      },
    };

    const result = await this.docClient.query(params).promise();
    const item = result.Items?.[0];
    if (item?.userId?.startsWith("deleted_")) return undefined;
    return item;
  }

  /**
   * Strong-consistent read of the User record by email. Email is the base
   * table's primary key, so a GetItem with ConsistentRead bypasses GSI
   * propagation lag entirely.
   *
   * Use this on the hot path of any route that reads user state IMMEDIATELY
   * after an updateUser elsewhere in the same request flow (or the
   * fire-and-forget background trigger that follows it). The legacy
   * `getUserById` reads via UserIdIndex GSI, which is eventually consistent
   * and can return pre-update rows for ~100-1000ms after a write — long
   * enough to break onboarding status polling (see the 2026-04-27 Maya
   * regen-spinner-stuck investigation).
   */
  async getUserByEmailConsistent(email: string) {
    const result = await this.docClient
      .get({
        TableName: this.tableName,
        Key: { email: email.toLowerCase() },
        ConsistentRead: true,
      })
      .promise();
    const item = result.Item;
    if (item?.userId?.startsWith("deleted_")) return undefined;
    return item;
  }

  async getUserById(userId: string) {
    try {
      const params = {
        TableName: this.tableName,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      };

      const result = await this.docClient.query(params).promise();
      const item = result.Items?.[0];
      if (item?.userId?.startsWith("deleted_")) return undefined;
      return item;
    } catch (error) {
      console.error("Error in getUserById:", error);
      throw error;
    }
  }

  async getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | null> {
    try {
      const params = {
        TableName: this.tableName,
        FilterExpression: "stripe_customer_id = :scid AND NOT begins_with(userId, :tombstone)",
        ExpressionAttributeValues: {
          ":scid": stripeCustomerId,
          ":tombstone": "deleted_",
        },
      };

      // Note: This is a full table scan — consider adding a GSI on stripe_customer_id at scale
      const result = await this.docClient.scan(params).promise();
      if (result.Items && result.Items.length > 1) {
        console.warn(`getUserByStripeCustomerId: found ${result.Items.length} users with stripe_customer_id=${stripeCustomerId} — expected 1. Using first match.`);
      }
      return (result.Items?.[0] as User) || null;
    } catch (error) {
      console.error("Error in getUserByStripeCustomerId:", error);
      throw error;
    }
  }

  async getUserByStripeConnectedAccountId(connectedAccountId: string): Promise<User | null> {
    try {
      const params = {
        TableName: this.tableName,
        FilterExpression: "stripeConnectedAccountId = :cid AND NOT begins_with(userId, :tombstone)",
        ExpressionAttributeValues: {
          ":cid": connectedAccountId,
          ":tombstone": "deleted_",
        },
      };
      // Full table scan — small user base today, add a GSI if this becomes hot.
      const result = await this.docClient.scan(params).promise();
      if (result.Items && result.Items.length > 1) {
        console.warn(
          `getUserByStripeConnectedAccountId: found ${result.Items.length} users with stripeConnectedAccountId=${connectedAccountId} — expected 1. Using first match.`
        );
      }
      return (result.Items?.[0] as User) || null;
    } catch (error) {
      console.error("Error in getUserByStripeConnectedAccountId:", error);
      throw error;
    }
  }

  async getUsersByEmailDomain(emailDomain: string): Promise<User[]> {
    try {
      const normalizedDomain = emailDomain.trim().toLowerCase();
      const results: User[] = [];
      let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;

      do {
        const params: AWS.DynamoDB.DocumentClient.ScanInput = {
          TableName: this.tableName,
          FilterExpression: 'emailDomain = :emailDomain AND NOT begins_with(userId, :tombstone)',
          ExpressionAttributeValues: {
            ':emailDomain': normalizedDomain,
            ':tombstone': 'deleted_',
          },
          ExclusiveStartKey: lastEvaluatedKey,
        };

        const result = await this.docClient.scan(params).promise();
        results.push(...((result.Items || []) as User[]));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return results;
    } catch (error) {
      console.error("Error in getUsersByEmailDomain:", error);
      throw error;
    }
  }

  // Throwaway / disposable email provider domains. Bot signups use these
  // because they don't require real inbox access. List sourced from the
  // common disposable-domain blocklists (mailinator, guerrillamail, etc.).
  // Keep alphabetised. Add to the list as new providers surface in the data.
  private static THROWAWAY_DOMAINS = new Set([
    "10minutemail.com",
    "dispostable.com",
    "fakeinbox.com",
    "guerrillamail.com",
    "guerrillamail.info",
    "guerrillamail.net",
    "guerrillamail.org",
    "mailinator.com",
    "mailnesia.com",
    "maildrop.cc",
    "mintemail.com",
    "mohmal.com",
    "sharklasers.com",
    "spambox.us",
    "tempmail.com",
    "temp-mail.org",
    "throwawaymail.com",
    "trashmail.com",
    "yopmail.com",
  ]);

  static isBotLikeEmail(email: string): boolean {
    if (!email) return false;
    const [local, domain] = email.split("@");
    if (!domain) return false;
    const lcLocal = local.toLowerCase();
    const lcDomain = domain.toLowerCase();
    // Disposable / throwaway provider domains
    if (UserDB.THROWAWAY_DOMAINS.has(lcDomain)) return true;
    // Gmail dot-trick bots: 3+ dots in the local part
    if (lcDomain === "gmail.com" && (lcLocal.match(/\./g) || []).length >= 3) return true;
    // Gmail plus-addressing bots: typical pattern is 2+ plus segments,
    // e.g., real.name+spam+bot@gmail.com. Single plus tags are legit
    // (Gmail filtering), so only flag when there's more than one.
    if (lcDomain === "gmail.com" && (lcLocal.match(/\+/g) || []).length >= 2) return true;
    // Internal test/smoke accounts
    const testDomains = ["test.com", "onb.com", "example.com", "example.org"];
    if (testDomains.includes(lcDomain)) return true;
    const ownDomain = "agentweb.pro";
    if (lcDomain === ownDomain && /^(test|smoketest|attrtest|qa|bot)/.test(lcLocal)) return true;
    if (lcDomain === `updates.${ownDomain}`) return true;
    // Heuristic: random-looking local part. ≥16 chars AND no vowel = almost
    // certainly script-generated. Real people pick pronounceable handles.
    if (lcLocal.length >= 16 && !/[aeiouy]/.test(lcLocal)) return true;
    return false;
  }

  async getAllUsers(hideBotLike = false): Promise<UserWithCounts[]> {
    try {
      const allItems: any[] = [];
      let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        const params: AWS.DynamoDB.DocumentClient.ScanInput = {
          TableName: this.tableName,
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        };
        const result = await this.docClient.scan(params).promise();
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      const users = allItems.filter(
        (u) =>
          !u.userId?.startsWith("deleted_") &&
          (!hideBotLike || !UserDB.isBotLikeEmail(u.email))
      );

      // Get task and workflow counts for each user
      const usersWithCounts = await Promise.all(
        users.map(async (user) => {
          const [taskCount, workflowCount, chatSessionCount] =
            await Promise.all([
              taskDb.getUserTaskCount(user.userId),
              workflowDb.getUserWorkflowCount(user.userId),
              this.getChatSessionCount(user.userId),
            ]);

          return {
            ...user,
            taskCount,
            workflowCount,
            chatSessionCount,
          } as UserWithCounts;
        })
      );

      return usersWithCounts;
    } catch (error) {
      console.error("Error in getAllUsers:", error);
      throw error;
    }
  }

  /**
   * Scan with a server-side filter expression. Returns raw items (no counts).
   */
  async scanWithFilter(
    filterExpression: string,
    expressionAttributeValues: Record<string, any>,
  ): Promise<any[]> {
    const combinedFilter = `NOT begins_with(userId, :_tombstone_prefix) AND (${filterExpression})`;
    const combinedValues = { ...expressionAttributeValues, ':_tombstone_prefix': 'deleted_' };
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression: combinedFilter,
        ExpressionAttributeValues: combinedValues,
      })
      .promise();
    return result.Items || [];
  }

  async getUserAnalytics(startDate: string, endDate: string) {
    try {
      const params = {
        TableName: this.tableName,
      };

      const result = await this.docClient.scan(params).promise();
      const users = result.Items || [];

      // Convert dates to ISO strings for proper comparison
      const startDateISO = new Date(startDate).toISOString();
      const endDateISO = new Date(endDate).toISOString();

      const newUsers = users.filter((u) => {
        if (!u.createdAt) return false;
        const userCreatedAt = new Date(u.createdAt).toISOString();
        return userCreatedAt >= startDateISO && userCreatedAt <= endDateISO;
      });

      const oauthUsers = users.filter((u) => u.isOAuthUser === true);
      const newOauthUsers = oauthUsers.filter((u) => {
        if (!u.createdAt) return false;
        const userCreatedAt = new Date(u.createdAt).toISOString();
        return userCreatedAt >= startDateISO && userCreatedAt <= endDateISO;
      });

      const adminUsers = users.filter((u) => u.isAdmin === true);

      const analytics = {
        totalUsers: users.length,
        newUsers: newUsers.length,
        oauthUsers: oauthUsers.length,
        newOauthUsers: newOauthUsers.length,
        adminUsers: adminUsers.length,
      };

      return analytics;
    } catch (error) {
      console.error("Error in getUserAnalytics:", error);
      throw error;
    }
  }

  // Helper function to scan all items with pagination
  async scanAllItems(tableName: string) {
    const items: any[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const params: any = {
        TableName: tableName,
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await this.docClient.scan(params).promise();
      items.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return items;
  }

  async reactivateUser(userId: string) {
    return this.setUserActiveStatus(userId, true);
  }

  async deactivateUser(userId: string) {
    return this.setUserActiveStatus(userId, false);
  }

  private async setUserActiveStatus(userId: string, isActive: boolean) {
    try {
      const user = await this.getUserById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const params = {
        TableName: this.tableName,
        Key: { email: user.email },
        UpdateExpression: "set isActive = :isActive",
        ExpressionAttributeValues: { ":isActive": isActive },
        ReturnValues: "ALL_NEW",
      };

      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      this.handleError(error, isActive ? "reactivateUser" : "deactivateUser");
    }
  }

  /**
   * Set the user's landing-site mode WRITE-ONCE. "single page" = unified, "multi
   * page" = separate. Once chosen it cannot be switched — switching would require
   * physically re-homing deployed pages across repos/projects/domains (broken
   * URLs + SEO loss), so it's a deliberate migration, not a toggle. Returns the
   * effective (locked) mode: the existing one if already set, else the new one.
   */
  async setLandingSiteMode(
    userId: string,
    mode: "unified" | "separate"
  ): Promise<"unified" | "separate"> {
    const user = await this.getUserById(userId);
    if (!user || !user.email) throw new Error(`User with ID '${userId}' not found.`);
    if (user.landingSiteMode === "unified" || user.landingSiteMode === "separate") {
      return user.landingSiteMode; // already locked — immutable
    }
    try {
      await this.docClient
        .update({
          TableName: this.tableName,
          Key: { email: user.email },
          UpdateExpression: "SET landingSiteMode = :m",
          ConditionExpression: "attribute_not_exists(landingSiteMode)",
          ExpressionAttributeValues: { ":m": mode },
        })
        .promise();
      return mode;
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException") {
        // A concurrent request locked it first — return whatever is now stored.
        const fresh = await this.getUserById(userId);
        return (fresh?.landingSiteMode as "unified" | "separate") || mode;
      }
      throw err;
    }
  }

  async updateUser(userId: string, updates: Partial<User>) {
    // First, get the user by userId to ensure they exist and to get their email
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      // This will be caught by the generic error handler, but good to be explicit
      throw new Error(`User with ID '${userId}' not found or has no email.`);
    }

    // Filter out keys that are part of the key or should not be updated directly
    const {
      userId: _,
      email: __,
      createdAt: ____,
      ...updatableFields
    } = updates;

    if (Object.keys(updatableFields).length === 0) {
      return user; // Return the fetched user object if no updates are needed
    }

    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    Object.entries(updatableFields).forEach(([key, value]) => {
      if (value === undefined) return;
      expressionAttributeNames[`#${key}`] = key;
      if (value === null) {
        // DynamoDB rejects SET-ing a GSI key attribute (e.g. orgId on
        // OrgIdIndex) to NULL — it must be REMOVEd instead. Applying this to
        // every null (not just GSI keys) keeps the semantics consistent and
        // matches the REMOVE-on-null pattern already used in updateLead.
        removeExpressions.push(`#${key}`);
      } else {
        setExpressions.push(`#${key} = :${key}`);
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    if (setExpressions.length === 0 && removeExpressions.length === 0) {
      return user;
    }

    const updateExpressionParts: string[] = [];
    if (setExpressions.length > 0) updateExpressionParts.push(`SET ${setExpressions.join(", ")}`);
    if (removeExpressions.length > 0) updateExpressionParts.push(`REMOVE ${removeExpressions.join(", ")}`);

    const params: any = {
      TableName: this.tableName,
      Key: { email: user.email }, // Use email as the primary key
      UpdateExpression: updateExpressionParts.join(" "),
      ExpressionAttributeNames: expressionAttributeNames,
      ReturnValues: "ALL_NEW",
    };
    // DynamoDB rejects an empty ExpressionAttributeValues map (e.g. when every
    // update is a REMOVE-on-null with no SET clauses at all).
    if (Object.keys(expressionAttributeValues).length > 0) {
      params.ExpressionAttributeValues = expressionAttributeValues;
    }

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes as User;
    } catch (error) {
      handleDynamoDbError(error, "updateUser");
      throw error; // Re-throw after logging
    }
  }

  /**
   * Atomically assigns a user to an org AND enforces the member cap in a
   * single DynamoDB transaction — a plain read-then-write (check orgId /
   * check member count, then separately write) has two distinct TOCTOU
   * races: (1) two concurrent approvals for the SAME user from different
   * orgs can both pass the "not already in an org" read-check before either
   * write lands, and (2) two concurrent approvals for DIFFERENT users on
   * the SAME org can both pass the "under capacity" read-check when only
   * one slot remains, overshooting maxMembers. TransactWriteItems ties the
   * org's memberCount increment (conditioned on staying under maxMembers)
   * and the user's orgId write (conditioned on not already having one) into
   * one all-or-nothing operation, closing both races at once.
   *
   * memberCount is denormalized purely for this atomic check — it is never
   * used for display (see the field's doc comment on Organization). Orgs
   * created before this field existed are backfilled by
   * scripts/backfill-org-member-count.ts, but if a join lands on one before
   * that runs, this function computes the org's real current count as the
   * seed value (never a bare 0 default — see below) so the counter starts
   * accurate on first use instead of silently discarding real membership.
   */
  async joinOrgWithCapacityCheck(
    userId: string,
    orgId: string,
    orgRole: "member" | "owner",
    maxMembers: number
  ): Promise<"joined" | "org_full" | "already_in_org" | "not_migrated"> {
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      throw new Error(`User with ID '${userId}' not found or has no email.`);
    }

    // Fail closed if memberCount is missing — never seed it from a live
    // count here. A live path guessing at the "real" count and initializing
    // the counter from it is exactly what produced several subtle races
    // (GSI eventual-consistency staleness, double-accounting against a
    // concurrent departure/join). The reviewed backfill migration
    // (scripts/backfill-org-member-count.ts) is the only thing allowed to
    // initialize memberCount; every live path just requires it to already
    // exist and be under cap.
    try {
      await this.docClient
        .transactWrite({
          TransactItems: [
            {
              Update: {
                TableName: ORGS_TABLE,
                Key: { orgId },
                UpdateExpression: "SET memberCount = memberCount + :one",
                ConditionExpression: "attribute_exists(memberCount) AND memberCount < :maxMembers",
                ExpressionAttributeValues: { ":one": 1, ":maxMembers": maxMembers },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { email: user.email },
                UpdateExpression: "SET orgId = :orgId, orgRole = :orgRole REMOVE pendingOrgInvite",
                ConditionExpression: "attribute_not_exists(orgId)",
                ExpressionAttributeValues: { ":orgId": orgId, ":orgRole": orgRole },
              },
            },
          ],
        })
        .promise();
      return "joined";
    } catch (error: any) {
      if (error.code === "TransactionCanceledException") {
        const reasons: Array<{ Code?: string }> = error.CancellationReasons || [];
        if (reasons[0]?.Code === "ConditionalCheckFailed") {
          // Ambiguous by design between "org is full" and "org hasn't been
          // backfilled yet" — both fail the same condition. Distinguish by
          // checking which one it actually is, since the caller needs a
          // different message for each.
          const orgSnapshot = await this.docClient.get({ TableName: ORGS_TABLE, Key: { orgId } }).promise();
          return orgSnapshot.Item?.memberCount === undefined ? "not_migrated" : "org_full";
        }
        if (reasons[1]?.Code === "ConditionalCheckFailed") return "already_in_org";
        // Unrecognized cancellation shape — treat conservatively as a
        // capacity/assignment conflict rather than surfacing a 500.
        return "already_in_org";
      }
      handleDynamoDbError(error, "joinOrgWithCapacityCheck");
      throw error;
    }
  }

  /**
   * Atomically increment a user's sessionVersion, invalidating all tokens issued
   * with the prior value. Used after a password change so that every other active
   * session (other devices) is logged out. Returns the new sessionVersion.
   *
   * Uses a DynamoDB SET ... if_not_exists expression so records that predate the
   * field (sessionVersion absent) are treated as 0 and bumped to 1.
   */
  async incrementSessionVersion(userId: string): Promise<number> {
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      throw new Error(`User with ID '${userId}' not found or has no email.`);
    }

    const params = {
      TableName: this.tableName,
      Key: { email: user.email },
      UpdateExpression: "SET #sv = if_not_exists(#sv, :zero) + :one",
      ExpressionAttributeNames: { "#sv": "sessionVersion" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    };

    try {
      const result = await this.docClient.update(params).promise();
      return (result.Attributes as { sessionVersion: number }).sessionVersion;
    } catch (error) {
      handleDynamoDbError(error, "incrementSessionVersion");
      throw error;
    }
  }

  async incrementTokenUsageForMonth(
    userId: string,
    month: string,
    tokens: number,
    cost: number,
    resetDate: string
  ): Promise<User | null> {
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      throw new Error(`User with ID '${userId}' not found or has no email.`);
    }

    const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
      TableName: this.tableName,
      Key: { email: user.email },
      UpdateExpression:
        "SET #tokenUsage.#month = :month, " +
        "#tokenUsage.#totalTokens = if_not_exists(#tokenUsage.#totalTokens, :zero) + :tokens, " +
        "#tokenUsage.#totalCost = if_not_exists(#tokenUsage.#totalCost, :zero) + :cost, " +
        "#tokenUsage.#resetDate = if_not_exists(#tokenUsage.#resetDate, :resetDate)",
      ConditionExpression: "#userId = :userId AND #tokenUsage.#month = :month",
      ExpressionAttributeNames: {
        "#userId": "userId",
        "#tokenUsage": "tokenUsage",
        "#month": "month",
        "#totalTokens": "totalTokens",
        "#totalCost": "totalCost",
        "#resetDate": "resetDate",
      },
      ExpressionAttributeValues: {
        ":userId": userId,
        ":month": month,
        ":tokens": tokens,
        ":cost": cost,
        ":zero": 0,
        ":resetDate": resetDate,
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await this.docClient.update(params).promise();
      return (result.Attributes as User) || null;
    } catch (error: any) {
      if (error?.code === "ConditionalCheckFailedException") {
        return null;
      }
      handleDynamoDbError(error, "incrementTokenUsageForMonth");
      throw error;
    }
  }

  async deleteUserById(
    userId: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      // First, get the user by userId to retrieve their email (the primary key)
      const user = await this.getUserById(userId);
      if (!user || !user.email) {
        // This case should ideally not happen if userId is valid and user has an email
        return { success: false, message: "User not found or email missing." };
      }

      // Prevent deletion of admin users as a safeguard, mirroring route logic
      if (user.isAdmin) {
        return {
          success: false,
          message: "Admin users cannot be deleted through this method.",
        };
      }

      const params = {
        TableName: this.tableName,
        Key: {
          email: user.email, // Use email as the primary key for deletion
        },
      };

      await this.docClient.delete(params).promise();
      return { success: true };
    } catch (error: any) {
      console.error(`Error deleting user ${userId}:`, error);
      // It might be better to use this.handleError if it's adapted to return or set a structured error
      return {
        success: false,
        message: error.message || `Failed to delete user ${userId}.`,
      };
    }
  }

  async updateUserEmail(
    userId: string,
    newEmail: string
  ): Promise<{ success: boolean; user?: User; message?: string }> {
    const normalizedNew = newEmail.toLowerCase().trim();

    // Get current user
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      return { success: false, message: "User not found." };
    }

    // Check new email not already taken
    const existing = await this.getUserByEmail(normalizedNew);
    if (existing) {
      return { success: false, message: "Email is already in use by another account." };
    }

    // Write new item with updated email (same userId and all other fields)
    const newItem = { ...user, email: normalizedNew };
    await this.docClient
      .put({ TableName: this.tableName, Item: newItem })
      .promise();

    // Tombstone the old item: update its userId to "deleted_<userId>" and clear org membership
    // so the stale record doesn't appear in org member listings.
    await this.docClient
      .update({
        TableName: this.tableName,
        Key: { email: user.email },
        UpdateExpression: "SET userId = :tombstone REMOVE orgId, orgRole",
        ExpressionAttributeValues: { ":tombstone": `deleted_${userId}` },
      })
      .promise();

    return { success: true, user: newItem as User };
  }

  async getUserByResetToken(resetToken: string): Promise<User | null> {
    try {
      // The users table exceeds one 1MB scan page, so a single scan only sees
      // the first page. Paginate via LastEvaluatedKey until the token is found
      // or every page is exhausted — otherwise valid resets for users beyond
      // page 1 falsely report "Invalid or expired reset token".
      let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        const result = await this.docClient
          .scan({
            TableName: this.tableName,
            FilterExpression: "resetPasswordToken = :token AND NOT begins_with(userId, :tombstone)",
            ExpressionAttributeValues: {
              ":token": resetToken,
              ":tombstone": "deleted_",
            },
            ExclusiveStartKey: lastEvaluatedKey,
          })
          .promise();

        if (result.Items && result.Items.length > 0) {
          return result.Items[0] as User;
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return null;
    } catch (error) {
      this.handleError(error, "getUserByResetToken");
      return null;
    }
  }

  /**
   * Batch-resolve registration + premium status for a list of emails.
   *
   * Email is the AW-Users table's HASH primary key, so a BatchGetItem keyed on
   * { email } is an exact, strongly-targeted lookup (no GSI propagation lag,
   * no scan). Used to join CRM lead emails against real user accounts for the
   * funnel report and the get_registration_status agent tool — without
   * duplicating user data onto lead records.
   *
   * Returns one entry per UNIQUE input email (lowercased/trimmed). Emails with
   * no matching user — or matching only a soft-deleted (deleted_*) tombstone —
   * come back as { registered: false, isPremium: false }. Premium = the user's
   * subscription_status is "active" or "trialing".
   */
  async getRegistrationStatusByEmails(
    emails: string[],
    options?: { includeChatSessionCount?: boolean },
  ): Promise<RegistrationStatus[]> {
    // Normalize, drop blanks, de-duplicate (preserve first-seen order).
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of emails ?? []) {
      const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!email || seen.has(email)) continue;
      seen.add(email);
      normalized.push(email);
    }
    if (normalized.length === 0) return [];

    // DynamoDB BatchGetItem caps at 100 keys per call; match batchGetLeads's
    // conservative 25 for small payloads and retry headroom.
    const BATCH_SIZE = 25;
    const foundByEmail = new Map<string, any>();

    for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
      const batch = normalized.slice(i, i + BATCH_SIZE);
      const params = {
        RequestItems: {
          [this.tableName]: {
            Keys: batch.map((email) => ({ email })),
          },
        },
      };
      const result = await this.docClient.batchGet(params).promise();
      const items = (result.Responses?.[this.tableName] as any[]) || [];
      for (const item of items) {
        if (item?.email) foundByEmail.set(String(item.email).toLowerCase(), item);
      }
    }

    const results: RegistrationStatus[] = normalized.map((email) => {
      const user = foundByEmail.get(email);
      // A tombstoned account (userId begins with "deleted_") is treated as
      // unregistered — it's a former user, not an active signup.
      if (!user || (typeof user.userId === "string" && user.userId.startsWith("deleted_"))) {
        return { email, registered: false, isPremium: false };
      }
      const subscriptionStatus: string | undefined = user.subscription_status;
      const isPremium =
        subscriptionStatus === "active" || subscriptionStatus === "trialing";
      return {
        email,
        registered: true,
        userId: user.userId,
        createdAt: user.createdAt,
        subscriptionType: user.subscriptionType ?? undefined,
        subscriptionStatus,
        isPremium,
      };
    });

    // Opt-in: attach a live chat-session count for each registered user so the
    // funnel report can compute its Usage/Active stage from this one join. One
    // COUNT query per registered user, so it's gated behind the flag and run in
    // small concurrent chunks to avoid a burst on large cohorts.
    if (options?.includeChatSessionCount) {
      const registered = results.filter((r) => r.registered && r.userId);
      const CHUNK = 10;
      for (let i = 0; i < registered.length; i += CHUNK) {
        const chunk = registered.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(async (r) => {
            try {
              r.chatSessionCount = await this.getChatSessionCount(r.userId as string);
            } catch (err: any) {
              // A single user's COUNT query failing must not sink the whole
              // batch — leave this user's chatSessionCount undefined (unknown)
              // and let every other lead's status through.
              console.error(
                `getRegistrationStatusByEmails: chatSessionCount failed for ${r.userId}: ${err?.message}`,
              );
            }
          }),
        );
      }
    }

    return results;
  }

  /**
   * Remove orgId and orgRole from a user record (used when removing a member
   * from an org, or a member leaving on their own). Also best-effort
   * decrements the org's denormalized memberCount (see Organization.memberCount)
   * so it stays accurate for the atomic capacity check at join time.
   *
   * The user-clear is conditioned on orgId still matching what was just
   * read — this is what prevents a double-decrement when two concurrent
   * calls target the same membership (e.g. an owner-initiated remove racing
   * a self-initiated leave): only whichever call's conditioned REMOVE
   * actually wins decrements the counter; the loser's condition fails
   * (orgId is already gone) and it correctly skips decrementing, since the
   * winner already accounted for the one real departure.
   *
   * The decrement is intentionally NOT in the same transaction as the
   * membership clear, and intentionally non-fatal: leaving an org must never
   * fail because of a counter-bookkeeping issue (missing/stale memberCount
   * on an org predating this field, a rare inconsistency, etc.) — that
   * failure mode would be worse than a temporarily-stale count, which only
   * risks blocking one future join until reconciled, never overflow.
   */
  async clearOrgMembership(userId: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      throw new Error(`User with ID '${userId}' not found or has no email.`);
    }
    const orgId = user.orgId;
    if (!orgId) return; // Already cleared, e.g. by a concurrent call — nothing to do.

    try {
      await this.docClient
        .update({
          TableName: this.tableName,
          Key: { email: user.email },
          UpdateExpression: "REMOVE orgId, orgRole",
          ConditionExpression: "orgId = :orgId",
          ExpressionAttributeValues: { ":orgId": orgId },
        })
        .promise();
    } catch (error: any) {
      if (error.code === "ConditionalCheckFailedException") {
        // A concurrent call already cleared (or changed) this membership —
        // it already performed the decrement, so skip ours to avoid double-
        // counting one real departure as two.
        return;
      }
      throw error;
    }

    // Fail closed: if memberCount isn't set yet, skip the decrement entirely
    // rather than seeding it here. Only the reviewed backfill migration
    // (scripts/backfill-org-member-count.ts) is allowed to initialize this
    // field — a live path guessing at the "real" count via OrgIdIndex (a
    // GSI, eventually consistent relative to the write we just made) is
    // exactly what produced the earlier staleness bug. Skipping is safe:
    // once the org is backfilled, decrements apply normally; until then,
    // there's nothing to decrement from.
    try {
      await this.docClient
        .update({
          TableName: ORGS_TABLE,
          Key: { orgId },
          UpdateExpression: "SET memberCount = memberCount - :one",
          ConditionExpression: "attribute_exists(memberCount) AND memberCount > :zero",
          ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
        })
        .promise();
    } catch (error: any) {
      if (error.code === "ConditionalCheckFailedException") return; // Not backfilled yet, or already 0 — nothing to do.
      console.error(`Failed to decrement memberCount for org ${orgId} (non-fatal):`, error);
    }
  }
}

// Initialize and export userDb instance
export const userDb = new UserDB();

export const taskDb = {
  async createTask(task: {
    taskId: string;
    userId: string;
    name: string;
    prompt: string;
    status: string;
    createdAt: string;
    isInteractive?: boolean;
    isDeepResearch?: boolean;
    isComplexTask?: boolean;
    extractPageContent?: boolean;
    validateOutput?: boolean;
    outputAsJson?: boolean;
    outputAsHtml?: boolean;
    isAgenticDevMode?: boolean;
    emailNotification?: boolean;
    attachments?: TaskAttachment[];
    category?: string;
    description?: string;
    llmName?: string | null;
    templateId?: string;
    selectedLLMs?: string[];
    useSharedBrowser?: boolean;
    turnOffHeadless?: boolean;
    createVideo?: boolean;
    videoModel?: string;
    imageModel?: string;
    requireApproval?: boolean;
    slackChannel?: string;
    emailSender?: string;
    fromName?: string;
    useKnowledgeBase?: boolean;
    updateKnowledgeBase?: boolean;
    knowledgeBaseType?: 'public' | 'private';
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Item: task,
      };

      await dynamodb.put(params).promise();
      return task;
    } catch (error) {
      handleDynamoDbError(error, "createTask");
    }
  },

  async getAllTasks() {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        ProjectionExpression:
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en, #i, #dr, attachments, #llm, #ct, #epc, #vo, #oaj, #oah, #adm, category, description, templateId, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, knowledgeBase, knowledgeBaseSize, knowledgeBaseType, knowledgeBaseFiles, knowledgeBaseUpdatedAt, createVideo, videoModel, imageModel, requireApproval, slackChannel, emailSender, fromName",
        ExpressionAttributeNames: {
          "#n": "name",
          "#s": "status",
          "#e": "error",
          "#sum": "summary",
          "#en": "emailNotification",
          "#i": "isInteractive",
          "#dr": "isDeepResearch",
          "#llm": "llmName",
          "#ct": "isComplexTask",
          "#epc": "extractPageContent",
          "#vo": "validateOutput",
          "#oaj": "outputAsJson",
          "#oah": "outputAsHtml",
          "#adm": "isAgenticDevMode",
        },
      };

      let allItems: any[] = [];
      let lastEvaluatedKey: any = undefined;

      do {
        const result = await dynamodb
          .scan({
            ...params,
            ExclusiveStartKey: lastEvaluatedKey,
          })
          .promise();

        if (result.Items) {
          allItems = allItems.concat(result.Items);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getAllTasks");
    }
  },

  async getTaskSchedules(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getTaskSchedules");
    }
  },

  async getUserTaskCount(userId: string): Promise<number> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        IndexName: "UserTasksIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        Select: "COUNT",
      };

      return await paginatedCount(dynamodb, params);
    } catch (error) {
      console.error("Error getting task count:", error);
      return 0;
    }
  },

  async getTasksByUserId(userId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        IndexName: "UserTasksIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        ProjectionExpression:
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #epc, #vo, #oaj, #oah, emailFriendlyHtml, repairImageEmbedding, #adm, category, description, templateId, knowledgeBase, knowledgeBaseSize, knowledgeBaseType, knowledgeBaseUpdatedAt, knowledgeBaseFiles, createVideo, videoModel, imageModel, requireApproval, slackChannel, sendHtmlReportOnly",
        ExpressionAttributeNames: {
          "#n": "name",
          "#s": "status",
          "#e": "error",
          "#sum": "summary",
          "#epc": "extractPageContent",
          "#vo": "validateOutput",
          "#oaj": "outputAsJson",
          "#oah": "outputAsHtml",
          "#adm": "isAgenticDevMode",
        },
      };

      // Paginate through all results (DynamoDB returns max 1MB per query)
      let tasks: any[] = [];
      let lastEvaluatedKey: any = undefined;
      do {
        const result = await dynamodb.query({
          ...params,
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }).promise();
        tasks.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      // Get latest execution, schedules and subscribers for each task
      const tasksWithDetails = await Promise.all(
        tasks.map(async (task) => {
          const [executions, schedules, subscribers] = await Promise.all([
            this.getTaskExecutions(task.taskId),
            this.getTaskSchedules(task.taskId),
            subscriberDb.getTaskSubscribers(task.taskId),
          ]);

          // Filter out archived executions and get the latest one
          const nonArchivedExecutions =
            executions?.filter((exec) => !exec.archived) || [];
          const latestExecution =
            nonArchivedExecutions.length > 0 ? nonArchivedExecutions[0] : null;

          return {
            ...task,
            latestExecution,
            scheduleCount: schedules ? schedules.length : 0,
            subscriberCount: subscribers ? subscribers.length : 0,
          };
        })
      );

      return tasksWithDetails;
    } catch (error) {
      handleDynamoDbError(error, "getTasksByUserId");
    }
  },

  async getTaskById(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Key: {
          taskId,
        },
        ProjectionExpression:
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en, #i, #dr, attachments, #llm, #ct, #epc, #vo, #oaj, #oah, emailFriendlyHtml, repairImageEmbedding, htmlFormatInstructions, #adm, category, description, templateId, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, updateLeadList, createVideo, videoModel, imageModel, leadListIdentifier, knowledgeBase, knowledgeBaseSize, knowledgeBaseType, knowledgeBaseFiles, knowledgeBaseUpdatedAt, requireApproval, slackChannel, sendHtmlReportOnly, emailSender, fromName",
        ExpressionAttributeNames: {
          "#n": "name",
          "#s": "status",
          "#e": "error",
          "#sum": "summary",
          "#en": "emailNotification",
          "#i": "isInteractive",
          "#dr": "isDeepResearch",
          "#llm": "llmName",
          "#ct": "isComplexTask",
          "#epc": "extractPageContent",
          "#vo": "validateOutput",
          "#oaj": "outputAsJson",
          "#oah": "outputAsHtml",
          "#adm": "isAgenticDevMode",
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getTaskById");
    }
  },

  async updateTask(
    taskId: string,
    updates: Partial<{
      name: string;
      prompt: string;
      status: string;
      error: string;
      summary: string;
      emailNotification: boolean;
      isInteractive: boolean;
      isDeepResearch: boolean;
      isComplexTask: boolean;
      extractPageContent: boolean;
      validateOutput: boolean;
      outputAsJson: boolean;
      outputAsHtml: boolean;
      isAgenticDevMode: boolean;
      llmName: string | null;
      attachments: TaskAttachment[];
      selectedLLMs?: string[];
      useSharedBrowser?: boolean;
      turnOffHeadless?: boolean;
      knowledgeBase?: string;
      knowledgeBaseSize?: number;
      knowledgeBaseType?: "public" | "private";
      knowledgeBaseFiles?: Array<{
        filename: string;
        size: number;
        url: string;
        key: string;
        uploadedAt: string;
      }>;
      useKnowledgeBase?: boolean;
      updateKnowledgeBase?: boolean;
      updateLeadList?: boolean;
      createVideo?: boolean;
      videoModel?: string;
      imageModel?: string;
      leadListIdentifier?: string | null;
      knowledgeBaseUpdatedAt?: string;
      requireApproval?: boolean;
      slackChannel?: string;
      sendHtmlReportOnly?: boolean;
      emailSender?: string;
      fromName?: string;
      htmlTemplateFilename?: string | null;
    }>
  ) {
    try {
      const setClauses: string[] = [];
      const removeClauses: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (value === null) {
          // Attribute to be removed
          removeClauses.push(`#${key}`);
          expressionAttributeNames[`#${key}`] = key;
        } else if (value !== undefined) {
          // Attribute to be set/updated
          setClauses.push(`#${key} = :${key}`);
          expressionAttributeNames[`#${key}`] = key;
          // DynamoDB handles arrays and objects automatically, but ensure proper serialization
          expressionAttributeValues[`:${key}`] = value;

          // Log knowledgeBaseFiles updates for debugging
          if (key === 'knowledgeBaseFiles') {
          }
        }
      });

      if (setClauses.length === 0 && removeClauses.length === 0) {
        console.warn(
          `[db.ts] updateTask called for taskId ${taskId} with no effective update operations. Returning current task attributes.`
        );
        // Optionally, you might want to fetch and return the current task if no updates are made.
        const currentTaskAttributes = await this.getTaskById(taskId);
        return currentTaskAttributes;
      }

      let updateExpression = "";
      if (setClauses.length > 0) {
        updateExpression += `SET ${setClauses.join(", ")}`;
      }
      if (removeClauses.length > 0) {
        if (updateExpression.length > 0) {
          updateExpression += " "; // Add space if SET clauses exist
        }
        updateExpression += `REMOVE ${removeClauses.join(", ")}`;
      }

      const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Key: { taskId },
        UpdateExpression: updateExpression,
        ReturnValues: "ALL_NEW",
      };

      if (Object.keys(expressionAttributeNames).length > 0) {
        params.ExpressionAttributeNames = expressionAttributeNames;
      }

      // ExpressionAttributeValues should only be added if there are value placeholders (i.e., if setClauses is not empty)
      // This also means expressionAttributeValues will not be empty if setClauses is not empty.
      if (Object.keys(expressionAttributeValues).length > 0) {
        params.ExpressionAttributeValues = expressionAttributeValues;
      }

      const result = await dynamodb.update(params).promise();

      return result.Attributes;
    } catch (error) {
      console.error(`[db.ts] Error in updateTask for taskId ${taskId}:`, error);
      handleDynamoDbError(error, "updateTask");
    }
  },

  async deleteTask(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Key: {
          taskId,
        },
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "deleteTask");
    }
  },

  async createTaskExecution(execution: {
    executionId: string;
    taskId: string;
    userId: string;
    run_user_id?: string;
    status: string;
    startTime: string;
    workflowExecutionId?: string;
    prompt?: string;
    feedback?: string;
    revision_prompt?: string;
    original_image_url?: string;
    original_execution_id?: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Item: execution,
      };

      await dynamodb.put(params).promise();
      return execution;
    } catch (error) {
      handleDynamoDbError(error, "createTaskExecution");
    }
  },

  async getTaskExecutionById(executionId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: {
          executionId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getTaskExecutionById");
    }
  },

  async updateTaskExecution(
    executionId: string,
    updates: Partial<{
      status: string;
      error: string;
      result: string;
      completedAt: string;
      feedback: "accepted" | "rejected" | null;
      userInteractions: UserInteraction[];
      shareToken: string;
      knowledge_base_updated_at: string;
      result_files: Array<{
        url: string;
        filename: string;
        token: string;
        is_html?: boolean;
        is_favorited?: boolean;
      }>;
    }>
  ) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (value === null) {
          updateExpressions.push(`REMOVE #${key}`);
          expressionAttributeNames[`#${key}`] = key;
        } else {
          updateExpressions.push(`SET #${key} = :${key}`);
          expressionAttributeNames[`#${key}`] = key;
          expressionAttributeValues[`:${key}`] = value;
        }
      });

      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: {
          executionId,
        },
        UpdateExpression: updateExpressions.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ...(Object.keys(expressionAttributeValues).length > 0 && {
          ExpressionAttributeValues: expressionAttributeValues,
        }),
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateTaskExecution");
    }
  },

  async updateTaskExecutionResultFiles(
    executionId: string,
    resultFiles: Array<{ url: string; filename: string; token: string; is_html?: boolean; searchableText?: string; [key: string]: any }>
  ) {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: { executionId },
        UpdateExpression: 'SET result_files = :files',
        ExpressionAttributeValues: { ':files': resultFiles },
      }).promise();
    } catch (error) {
      console.error(`Error updating result_files for execution ${executionId}:`, error);
    }
  },

  async getPendingTaskExecutions() {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        IndexName: "StatusCreatedAtIndex",
        KeyConditionExpression: "#status = :status",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "pending",
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getPendingTaskExecutions");
    }
  },

  async getTaskExecutions(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
        ScanIndexForward: false, // Get latest executions first
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getTaskExecutions");
    }
  },

  async getAllTaskExecutionsByUserId(userId: string) {
    try {
      const allItems: any[] = [];
      let lastEvaluatedKey: any = undefined;

      do {
        const params: any = {
          TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
          IndexName: "UserIdIndex",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: {
            ":userId": userId,
          },
          ScanIndexForward: false, // Get latest executions first
          ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
        };

        const result = await dynamodb.query(params).promise();
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getAllTaskExecutionsByUserId");
    }
  },

  async getTaskAnalytics(startDate: string, endDate: string) {
    try {
      // Convert dates to ISO strings for proper comparison
      const startDateISO = new Date(startDate).toISOString();
      const endDateISO = new Date(endDate).toISOString();

      // Get all data with pagination (parallel)
      const [tasks, executions, schedules, templates, configs, workflows, workflowExecutions] = await Promise.all([
        this.scanAllItems(`${TABLE_PREFIX}AW-Tasks`),
        this.scanAllItems(`${TABLE_PREFIX}AW-TaskExecutions`),
        this.scanAllItems(`${TABLE_PREFIX}AW-TaskSchedules`),
        this.scanAllItems(`${TABLE_PREFIX}AW-TaskTemplates`),
        this.scanAllItems(`${TABLE_PREFIX}AW-Configs`),
        this.scanAllItems(`${TABLE_PREFIX}AW-Workflows`),
        this.scanAllItems(`${TABLE_PREFIX}AW-WorkflowExecutions`),
      ]);

      // Helper function to check if date is within range
      const isDateInRange = (dateStr: string) => {
        if (!dateStr) return false;
        const date = new Date(dateStr).toISOString();
        return date >= startDateISO && date <= endDateISO;
      };

      const newTasks = tasks.filter((t) => isDateInRange(t.createdAt));
      const newExecutions = executions.filter((e) => isDateInRange(e.startTime));
      const newScheduledTasks = schedules.filter((s) => isDateInRange(s.createdAt));
      const newTemplates = templates.filter((t) => isDateInRange(t.createdAt));
      const newWebsiteConfigs = configs.filter(
        (c) => !c.isApiConfig && isDateInRange(c.createdAt)
      );
      const newApiConfigs = configs.filter(
        (c) => c.isApiConfig === true && isDateInRange(c.createdAt)
      );
      const newWorkflows = workflows.filter((w) => isDateInRange(w.createdAt));
      const newWorkflowExecutions = workflowExecutions.filter((e) => isDateInRange(e.startTime));

      const analytics = {
        totalTasks: tasks.length,
        newTasks: newTasks.length,
        totalExecutions: executions.length,
        successfulExecutions: executions.filter((e) => e.status === "completed").length,
        failedExecutions: executions.filter((e) => e.status === "failed").length,
        newExecutions: newExecutions.length,
        scheduledTasks: schedules.length,
        newScheduledTasks: newScheduledTasks.length,
        templates: templates.length,
        newTemplates: newTemplates.length,
        websiteConfigs: configs.filter((c) => !c.isApiConfig).length,
        newWebsiteConfigs: newWebsiteConfigs.length,
        apiConfigs: configs.filter((c) => c.isApiConfig === true).length,
        newApiConfigs: newApiConfigs.length,
        sharedConfigs: configs.filter((c) => c.sharedBy || c.sharedConfigIds).length,
        totalWorkflows: workflows.length,
        newWorkflows: newWorkflows.length,
        workflowExecutions: workflowExecutions.length,
        newWorkflowExecutions: newWorkflowExecutions.length,
        successfulWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "success" || e.status === "completed"
        ).length,
        failedWorkflowExecutions: workflowExecutions.filter((e) => e.status === "failed").length,
        pendingWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "pending" || e.status === "running"
        ).length,
        workflowExecutionStatusBreakdown: Object.entries(
          workflowExecutions.reduce<Record<string, number>>((acc, exec) => {
            acc[exec.status || "unknown"] = (acc[exec.status || "unknown"] || 0) + 1;
            return acc;
          }, {})
        ),
        averageExecutionTime: (() => {
          const completedExecutions = executions.filter((e) => e.status === "completed" && e.completedAt);
          if (completedExecutions.length === 0) return null;

          const totalTime = completedExecutions.reduce((acc, e) => {
            return acc + (new Date(e.completedAt!).getTime() - new Date(e.startTime).getTime());
          }, 0);

          return totalTime / completedExecutions.length;
        })(),
      };

      return analytics;
    } catch (error) {
      console.error("Error in getTaskAnalytics:", error);
      throw error;
    }
  },

  // Helper function to scan all items with pagination
  async scanAllItems(tableName: string) {
    const items: any[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const params: any = {
        TableName: tableName,
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.scan(params).promise();
      items.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return items;
  },

  async addAttachment(
    taskId: string,
    file: {
      originalname: string;
      buffer: Buffer;
      mimetype: string;
    }
  ) {
    try {
      // Get current task to check attachment count
      const task = await this.getTaskById(taskId);
      if (!task) throw new Error("Task not found");

      // Check attachment limit
      const currentAttachments = task.attachments || [];
      if (currentAttachments.length >= 10) {
        throw new Error("Maximum number of attachments (10) reached");
      }

      // Generate a random token (32 characters)
      const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const key = `tasks/${taskId}/attachments/${Date.now()}-${randomToken}-${file.originalname
        }`;

      // Upload to S3 without ACL setting
      await s3
        .putObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
        .promise();

      // Generate regular S3 URL
      const url = `https://${process.env.AWS_S3_BUCKET || "agentweb-user-files"
        }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

      // Update task with attachment URL
      const attachments = [
        ...currentAttachments,
        {
          url,
          key,
          filename: file.originalname,
          uploadedAt: new Date().toISOString(),
        },
      ];

      await this.updateTask(taskId, { attachments });

      return { url, key, filename: file.originalname };
    } catch (error) {
      if (error instanceof Error) {
        throw error; // Re-throw the attachment limit error
      }
      handleDynamoDbError(error, "addAttachment");
    }
  },

  async deleteAttachment(taskId: string, key: string) {
    try {
      // Delete from S3
      await s3
        .deleteObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: key,
        })
        .promise();

      // Update task to remove attachment
      const task = await this.getTaskById(taskId);
      if (!task) throw new Error("Task not found");

      const attachments = (task.attachments || []).filter(
        (a: TaskAttachment) => a.key !== key
      );
      await this.updateTask(taskId, { attachments });
    } catch (error) {
      handleDynamoDbError(error, "deleteAttachment");
    }
  },

  async updateTaskOwner(taskId: string, newOwnerId: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Tasks`,
      Key: {
        taskId,
      },
      UpdateExpression: "set userId = :userId",
      ExpressionAttributeValues: {
        ":userId": newOwnerId,
      },
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes;
  },

  async updateTaskExecutionOwnership(taskId: string, newOwnerId: string) {
    try {
      // Get all executions for this task
      const executions = await this.getTaskExecutions(taskId);

      if (!executions || executions.length === 0) {
        return;
      }

      // Update each execution's userId
      const updatePromises = executions.map(async (execution) => {
        const params = {
          TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
          Key: {
            executionId: execution.executionId,
          },
          UpdateExpression: "set userId = :userId",
          ExpressionAttributeValues: {
            ":userId": newOwnerId,
          },
        };

        return dynamodb.update(params).promise();
      });

      await Promise.all(updatePromises);
    } catch (error) {
      console.error('Error updating task execution ownership:', error);
      throw error;
    }
  },

  async archiveExecution(taskId: string, executionId: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
      Key: {
        executionId,
      },
      UpdateExpression: "SET archived = :archived, archivedAt = :archivedAt",
      ExpressionAttributeValues: {
        ":archived": true,
        ":archivedAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes;
  },

  async unarchiveExecution(taskId: string, executionId: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
      Key: {
        executionId,
      },
      UpdateExpression: "REMOVE archived, archivedAt",
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes;
  },

  async killTaskExecution(executionId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: {
          executionId,
        },
        UpdateExpression: "SET killRequested = :killRequested",
        ExpressionAttributeValues: {
          ":killRequested": new Date().toISOString(),
        },
        ReturnValues: "UPDATED_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "killTaskExecution");
    }
  },

  async getAvailableTasks(userId: string) {
    try {
      const tasks = await this.getTasksByUserId(userId);
      if (!tasks) return [];
      return tasks.filter((task: any) => task.status === "active");
    } catch (error) {
      handleDynamoDbError(error, "getAvailableTasks");
      return [];
    }
  },

  async getTasksWithKnowledgeBase(userId: string) {
    try {
      // Get all tasks for the user
      const tasks = await this.getTasksByUserId(userId);

      if (!tasks || tasks.length === 0) {
        return [];
      }

      // Filter tasks with non-empty knowledge base (either main content OR files)
      // Also include tasks that have a knowledgeBase URL set even if size=0
      // (size can be incorrectly 0 due to a race condition or update failure)
      const tasksWithKnowledgeBase = tasks.filter((task: any) => {
        const size = typeof task.knowledgeBaseSize === 'string'
          ? parseInt(task.knowledgeBaseSize)
          : task.knowledgeBaseSize || 0;
        const hasKnowledgeBaseUrl = !!task.knowledgeBase;
        const hasFiles = task.knowledgeBaseFiles && task.knowledgeBaseFiles.length > 0;
        return size > 0 || hasKnowledgeBaseUrl || hasFiles;
      });

      // Map to return standardized fields
      const knowledgeBaseTasks = tasksWithKnowledgeBase.map((task: any) => {
        const size = typeof task.knowledgeBaseSize === 'string'
          ? parseInt(task.knowledgeBaseSize)
          : task.knowledgeBaseSize || 0;

        return {
          taskId: task.taskId,
          name: task.name,
          knowledgeBaseSize: size,
          knowledgeBaseType: task.knowledgeBaseType || 'private',
          knowledgeBaseFiles: task.knowledgeBaseFiles || [],
          knowledgeBaseUpdatedAt: task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt,
          // Include additional fields that might be useful
          updatedAt: task.updatedAt || task.createdAt,
          createdAt: task.createdAt
        };
      });

      // Sort by last updated (most recent first)
      knowledgeBaseTasks.sort((a, b) => {
        const dateA = a.knowledgeBaseUpdatedAt
          ? new Date(a.knowledgeBaseUpdatedAt).getTime()
          : 0;
        const dateB = b.knowledgeBaseUpdatedAt
          ? new Date(b.knowledgeBaseUpdatedAt).getTime()
          : 0;
        return dateB - dateA;
      });

      return knowledgeBaseTasks;
    } catch (error) {
      handleDynamoDbError(error, "getTasksWithKnowledgeBase");
      return [];
    }
  },

  async getAllPublicKnowledgeBaseTasks() {
    try {
      // Query using the KnowledgeBaseTypeIndex GSI for efficient retrieval
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        IndexName: 'KnowledgeBaseTypeIndex',
        KeyConditionExpression: 'knowledgeBaseType = :publicType',
        FilterExpression: 'knowledgeBaseSize > :zero',
        ExpressionAttributeValues: {
          ':publicType': 'public',
          ':zero': 0
        },
        ScanIndexForward: false // Sort by knowledgeBaseUpdatedAt descending (most recent first)
      };

      const items = await paginatedQuery(dynamodb, params);

      if (items.length === 0) {
        return [];
      }

      // Map to return standardized fields
      const knowledgeBaseTasks = items.map((task: any) => {
        const size = typeof task.knowledgeBaseSize === 'string'
          ? parseInt(task.knowledgeBaseSize)
          : task.knowledgeBaseSize || 0;

        return {
          taskId: task.taskId,
          userId: task.userId,
          name: task.name,
          knowledgeBaseSize: size,
          knowledgeBaseType: 'public',
          knowledgeBaseFiles: task.knowledgeBaseFiles || [],
          knowledgeBaseUpdatedAt: task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt,
          knowledgeBase: task.knowledgeBase,
          updatedAt: task.updatedAt || task.createdAt,
          createdAt: task.createdAt
        };
      });

      // Results are already sorted by knowledgeBaseUpdatedAt descending due to ScanIndexForward: false
      return knowledgeBaseTasks;
    } catch (error) {
      handleDynamoDbError(error, "getAllPublicKnowledgeBaseTasks");
      return [];
    }
  },
};

export const waitlistDb = {
  async add(entry: { email: string; joinedAt: string }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Item: entry,
      };

      await dynamodb.put(params).promise();
      return entry;
    } catch (error) {
      handleDynamoDbError(error, "addToWaitlist");
    }
  },

  async getByEmail(email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Key: {
          email,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getWaitlistByEmail");
    }
  },

  async list(lastEvaluatedKey?: any) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Limit: 50,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      };

      const result = await dynamodb.scan(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey,
      };
    } catch (error) {
      console.error("Error listing waitlist:", error);
      throw error;
    }
  },
};

export const scheduleDb = {
  async createSchedule(schedule: {
    scheduleId: string;
    taskId: string;
    userId: string;
    frequency: string; // 'daily', 'weekly', 'monthly', 'every_n_days', or cron expression
    frequencyIntervalDays?: number; // Required when frequency is 'every_n_days' (>= 1)
    nextRunTime: string;
    status: string; // 'active' or 'inactive'
    createdAt: string;
    lastRunTime?: string;
    timezone?: string;
    // Additional fields for scheduled chats
    scheduleName?: string;
    description?: string;
    startingMessage?: string;
    keywords?: string[];
    requiredFunctionCalls?: string[];
    functionCallMinCalls?: { [functionName: string]: number };
    emailNotifications?: string[];
    dailyDigest?: boolean;
    updatedAt?: string;
    sessionId?: string | null;
    type?: string;
    emailCampaignTaskId?: string;
    runCount?: number; // -1 for unlimited, positive integer for limited runs
    variables?: Array<{ name: string; description?: string }>;
    variableValues?: { [variableName: string]: string };
    variableRequestStatus?: 'idle' | 'pending' | 'provided';
    variableRequestSentAt?: string;
    variableValuesUpdatedAt?: string;
    variableRequestAccessTokenHash?: string;
    variableRequestAccessTokenExpiresAt?: string;
    variableRequestAccessTokenConsumedAt?: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Item: schedule,
      };

      await dynamodb.put(params).promise();
      return schedule;
    } catch (error) {
      handleDynamoDbError(error, "createSchedule");
    }
  },

  async getSchedulesByTaskId(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getSchedulesByTaskId");
    }
  },

  async getScheduleById(scheduleId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getScheduleById");
    }
  },

  async updateSchedule(
    scheduleId: string,
    updates: Partial<{
      frequency: string;
      frequencyIntervalDays: number;
      nextRunTime: string;
      status: string;
      lastRunTime: string;
      timezone: string;
      scheduleName: string;
      description: string;
      startingMessage: string;
      keywords: string[];
      requiredFunctionCalls: string[];
      functionCallMinCalls: { [functionName: string]: number };
      emailNotifications: string[];
      dailyDigest: boolean;
      selfImprove: boolean;
      // ENG-396: opt-in full autonomy — headless runs auto-take Emma's recommended
      // option on a blocking question instead of parking (waives the human gate on
      // irreversible decisions). Default off.
      fullAutonomy?: boolean;
      promptRevisions: Array<{ startingMessage: string; updatedAt: string }>;
      updatedAt: string;
      emailCampaignTaskId: string;
      runCount: number;
      variables: Array<{ name: string; description?: string }>;
      variableValues: { [variableName: string]: string };
      variableRequestStatus: 'idle' | 'pending' | 'provided';
      variableRequestSentAt: string;
      variableValuesUpdatedAt: string;
      variableRequestAccessTokenHash: string;
      variableRequestAccessTokenExpiresAt: string;
      variableRequestAccessTokenConsumedAt: string;
      zeroAssistantRetryCount: number;
      lastZeroAssistantOutputAt: string;
      lastZeroAssistantOutputSessionId: string;
    }>
  ) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSchedule");
    }
  },

  async addRunResult(scheduleId: string, runResult: any) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
        UpdateExpression: 'SET #runResults = list_append(if_not_exists(#runResults, :emptyList), :runResult), #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#runResults': 'runResults',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':runResult': [runResult],
          ':emptyList': [],
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "addRunResult");
      throw error;
    }
  },

  async getRunResults(scheduleId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item?.runResults || [];
    } catch (error) {
      handleDynamoDbError(error, "getRunResults");
      return [];
    }
  },

  async getSchedulesReadyToRun() {
    try {
      const now = new Date().toISOString();
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: 'StatusStartTimeIndex',
        KeyConditionExpression: '#status = :status AND #nextRunTime <= :now',
        FilterExpression: '#type = :type',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#nextRunTime': 'nextRunTime',
          '#type': 'type',
        },
        ExpressionAttributeValues: {
          ':status': 'active',
          ':now': now,
          ':type': 'scheduled_chat',
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getSchedulesReadyToRun");
      return [];
    }
  },

  // ENG-324: durable in-flight lease for scheduled-chat runs. A run that is
  // killed mid-flight (deploy SIGTERM past the drain ceiling, SIGKILL, OOM) can
  // never persist its own failure/requeue from the in-process catch, leaving the
  // session at messageCount=2 with no run result. These helpers stamp a lease on
  // dispatch, heartbeat it while the run is alive, and let a surviving instance
  // reconcile (requeue) any lease whose heartbeat has gone stale.
  async setRunInFlight(
    scheduleId: string,
    lease: { runId: string; sessionId: string; startedAt: string; instanceId: string }
  ): Promise<void> {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
        UpdateExpression: 'SET runInFlight = :lease',
        ExpressionAttributeValues: {
          ':lease': { ...lease, heartbeatAt: lease.startedAt },
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'setRunInFlight');
    }
  },

  // Attach the run's session id to an existing in-flight lease. ENG-479: the lease
  // is now stamped BEFORE the session exists (so a hard-kill in the session-creation
  // window is still reconciler-visible), which means it initially carries no
  // sessionId; this fills it in once createChatSession returns, so the reconciler's
  // recovery can annotate the right session. Conditional on runId (like the
  // heartbeat) so it can never resurrect a lease a reconciler already reaped or a
  // newer run replaced. Best-effort: a failed condition just means the lease moved on.
  async attachSessionToRunInFlight(scheduleId: string, runId: string, sessionId: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
        UpdateExpression: 'SET runInFlight.sessionId = :sid',
        ConditionExpression: 'runInFlight.runId = :runId',
        ExpressionAttributeValues: { ':sid': sessionId, ':runId': runId },
      }).promise();
    } catch (error: any) {
      if (error?.code !== 'ConditionalCheckFailedException') {
        console.error('DynamoDB attachSessionToRunInFlight error:', error);
      }
    }
  },

  // Refresh the lease's heartbeat. Conditional on the runId so a heartbeat can
  // never resurrect a lease that a reconciler already reaped (or a newer run
  // replaced). A failed condition means "someone else owns this now" — swallow.
  async heartbeatRunInFlight(scheduleId: string, runId: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
        UpdateExpression: 'SET runInFlight.heartbeatAt = :now',
        ConditionExpression: 'runInFlight.runId = :runId',
        ExpressionAttributeValues: { ':now': new Date().toISOString(), ':runId': runId },
      }).promise();
    } catch (error: any) {
      // Best-effort, fired from a timer via `void` — never rethrow (that would be
      // an unhandled rejection). A stale condition just means the lease moved on.
      if (error?.code !== 'ConditionalCheckFailedException') {
        console.error('DynamoDB heartbeatRunInFlight error:', error);
      }
    }
  },

  // Clear the lease when the run settles normally. Conditional on runId so a
  // run that finishes right after being reaped doesn't wipe the reconciler's
  // requeue. Returns true when this call cleared the lease.
  async clearRunInFlight(scheduleId: string, runId: string): Promise<boolean> {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
        UpdateExpression: 'REMOVE runInFlight',
        ConditionExpression: 'runInFlight.runId = :runId',
        ExpressionAttributeValues: { ':runId': runId },
      }).promise();
      return true;
    } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') return false;
      handleDynamoDbError(error, 'clearRunInFlight');
      return false;
    }
  },

  // Scheduled-chat schedules that currently hold an in-flight lease. Sparse by
  // nature — most schedules have no runInFlight. We sweep BOTH 'active' and
  // 'paused' partitions of StatusStartTimeIndex: a runCount-limited schedule
  // auto-pauses at dispatch (before its final run sets a lease), so an abandoned
  // run on a paused schedule would otherwise never be reaped. Volume is low;
  // promote to a dedicated sparse GSI if the schedule count ever grows large.
  async getInFlightSchedules(): Promise<any[]> {
    try {
      const statuses = ['active', 'paused'];
      const results = await Promise.all(statuses.map(status =>
        paginatedQuery(dynamodb, {
          TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
          IndexName: 'StatusStartTimeIndex',
          KeyConditionExpression: '#status = :status',
          FilterExpression: '#type = :type AND attribute_exists(runInFlight)',
          ExpressionAttributeNames: { '#status': 'status', '#type': 'type' },
          ExpressionAttributeValues: { ':status': status, ':type': 'scheduled_chat' },
        })
      ));
      return results.flat();
    } catch (error) {
      // Best-effort reconciler input: a transient list failure just skips this
      // sweep (the next one retries), so log and return empty rather than throw.
      console.error('DynamoDB getInFlightSchedules error:', error);
      return [];
    }
  },

  // Single-winner claim of an abandoned run: atomically REMOVE the stale lease
  // and (optionally) requeue the schedule, conditional on the runId still
  // matching. Exactly one reconciler across all instances wins; the rest get
  // ConditionalCheckFailed and return false (no-op). When `requeue` is null the
  // run has exceeded the requeue cap — the lease is cleared but not rescheduled.
  async claimAbandonedRun(
    scheduleId: string,
    runId: string,
    requeue: { nextRunTime: string; retryCount: number; sessionId: string; lastAt: string } | null
  ): Promise<boolean> {
    const nowIso = new Date().toISOString();
    try {
      if (requeue) {
        await dynamodb.update({
          TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
          Key: { scheduleId },
          UpdateExpression:
            'SET #status = :active, nextRunTime = :nextRunTime, zeroAssistantRetryCount = :n, ' +
            'lastZeroAssistantOutputAt = :lastAt, lastZeroAssistantOutputSessionId = :sid, updatedAt = :now REMOVE runInFlight',
          ConditionExpression: 'runInFlight.runId = :runId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': 'active',
            ':nextRunTime': requeue.nextRunTime,
            ':n': requeue.retryCount,
            ':lastAt': requeue.lastAt,
            ':sid': requeue.sessionId,
            ':now': nowIso,
            ':runId': runId,
          },
        }).promise();
      } else {
        await dynamodb.update({
          TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
          Key: { scheduleId },
          UpdateExpression: 'SET updatedAt = :now REMOVE runInFlight',
          ConditionExpression: 'runInFlight.runId = :runId',
          ExpressionAttributeValues: { ':now': nowIso, ':runId': runId },
        }).promise();
      }
      return true;
    } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') return false;
      handleDynamoDbError(error, 'claimAbandonedRun');
      return false;
    }
  },

  async getSocialEngagementActionsUpTo(windowEnd: string): Promise<any[]> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: 'StatusStartTimeIndex',
        KeyConditionExpression: '#status = :status AND #nextRunTime <= :windowEnd',
        FilterExpression: '#type = :type',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#nextRunTime': 'nextRunTime',
          '#type': 'type',
        },
        ExpressionAttributeValues: {
          ':status': 'active',
          ':windowEnd': windowEnd,
          ':type': 'social_engagement_action',
        },
      };
      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getSocialEngagementActionsUpTo');
      return [];
    }
  },

  async claimAction(scheduleId: string, instanceId: string): Promise<boolean> {
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
        UpdateExpression: 'SET claimedAt = :now, claimedBy = :instanceId',
        ConditionExpression: 'attribute_not_exists(claimedAt) OR claimedAt <= :staleThreshold',
        ExpressionAttributeValues: {
          ':now': new Date().toISOString(),
          ':instanceId': instanceId,
          ':staleThreshold': staleThreshold,
        },
      }).promise();
      return true;
    } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') return false;
      handleDynamoDbError(error, 'claimAction');
      return false;
    }
  },

  async updateScheduleAfterRun(scheduleId: string, lastRunTime: string, nextRunTime: string, decrementRunCount: boolean = true) {
    try {
      // First, get the current schedule to check runCount
      const getParams = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
      };
      const currentSchedule = await dynamodb.get(getParams).promise();
      const runCount = currentSchedule.Item?.runCount;

      // Determine if we should pause the schedule
      // When runCount is 1, after decrementing it will be 0, so we should pause
      const shouldPause = decrementRunCount && runCount !== undefined && runCount !== -1 && runCount === 1;

      // Build update expression dynamically
      const updateParts: string[] = [
        '#lastRunTime = :lastRunTime',
        '#nextRunTime = :nextRunTime',
        '#updatedAt = :updatedAt',
      ];
      const attributeNames: { [key: string]: string } = {
        '#lastRunTime': 'lastRunTime',
        '#nextRunTime': 'nextRunTime',
        '#updatedAt': 'updatedAt',
      };
      const attributeValues: { [key: string]: any } = {
        ':lastRunTime': lastRunTime,
        ':nextRunTime': nextRunTime,
        ':updatedAt': new Date().toISOString(),
      };

      // Handle runCount decrement
      if (decrementRunCount && runCount !== undefined && runCount !== -1) {
        updateParts.push('#runCount = #runCount - :one');
        attributeNames['#runCount'] = 'runCount';
        attributeValues[':one'] = 1;
      }

      // Auto-pause if runCount reaches 0
      if (shouldPause) {
        updateParts.push('#status = :paused');
        attributeNames['#status'] = 'status';
        attributeValues[':paused'] = 'paused';
      }

      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: { scheduleId },
        UpdateExpression: `SET ${updateParts.join(', ')} REMOVE claimedAt, claimedBy`,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: attributeValues,
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateScheduleAfterRun");
      throw error;
    }
  },

  async getScheduledChatByVariableAccessTokenHash(variableRequestAccessTokenHash: string) {
    try {
      let lastEvaluatedKey: any | undefined;

      do {
        const params: any = {
          TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
          FilterExpression: '#type = :type AND #tokenHash = :tokenHash',
          ExpressionAttributeNames: {
            '#type': 'type',
            '#tokenHash': 'variableRequestAccessTokenHash',
          },
          ExpressionAttributeValues: {
            ':type': 'scheduled_chat',
            ':tokenHash': variableRequestAccessTokenHash,
          },
          ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
        };

        const result = await dynamodb.scan(params).promise();
        if (result.Items && result.Items.length > 0) {
          return result.Items[0];
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return null;
    } catch (error) {
      handleDynamoDbError(error, "getScheduledChatByVariableAccessTokenHash");
      return null;
    }
  },

  async deleteSchedule(scheduleId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "deleteSchedule");
    }
  },

  async getPendingSchedules() {
    try {
      const now = new Date().toISOString();
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "StatusNextRunTimeIndex",
        KeyConditionExpression: "#status = :status AND #nextRunTime <= :now",
        ExpressionAttributeNames: {
          "#status": "status",
          "#nextRunTime": "nextRunTime",
        },
        ExpressionAttributeValues: {
          ":status": "active",
          ":now": now,
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getPendingSchedules");
    }
  },

  async getSchedulesByUserId(userId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getSchedulesByUserId");
    }
  },
};

export const subscriberDb = {
  async addSubscriber(taskId: string, email: string) {
    try {
      // Check if subscriber already exists
      const existingSubscriber = await this.getTaskSubscriberByEmail(taskId, email);

      if (existingSubscriber) {
        // Email already exists - throw error regardless of subscription status
        throw new Error(`Email ${email} is already in the subscriber list for this task`);
      }

      // Add new subscriber only if they don't exist at all
      const subscribedAt = new Date().toISOString();
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Item: {
          taskId,
          email,
          subscribedAt,
          unsubscribed: false,
        },
      };

      await dynamodb.put(params).promise();
      return { taskId, email, subscribedAt, unsubscribed: false };
    } catch (error: any) {
      handleDynamoDbError(error, "addSubscriber");
    }
  },

  async removeSubscriber(taskId: string, email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId,
          email,
        },
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "removeSubscriber");
    }
  },

  async softUnsubscribe(taskId: string, email: string, feedback?: string) {
    try {
      const updateExpression = feedback
        ? "SET unsubscribed = :unsubscribed, unsubscribedAt = :unsubscribedAt, feedback = :feedback"
        : "SET unsubscribed = :unsubscribed, unsubscribedAt = :unsubscribedAt";

      const expressionAttributeValues: any = {
        ":unsubscribed": true,
        ":unsubscribedAt": new Date().toISOString(),
      };

      if (feedback) {
        expressionAttributeValues[":feedback"] = feedback;
      }

      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId,
          email,
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "softUnsubscribe");
    }
  },

  async resubscribe(taskId: string, email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId,
          email,
        },
        UpdateExpression: "SET unsubscribed = :unsubscribed, resubscribedAt = :resubscribedAt, feedback = :feedback",
        ExpressionAttributeValues: {
          ":unsubscribed": false,
          ":resubscribedAt": new Date().toISOString(),
          ":feedback": null,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "resubscribe");
    }
  },

  async getTaskSubscribers(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        KeyConditionExpression: "taskId = :taskId",
        FilterExpression: "attribute_not_exists(unsubscribed) OR unsubscribed = :unsubscribed",
        ExpressionAttributeValues: {
          ":taskId": taskId,
          ":unsubscribed": false,
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getTaskSubscribers");
    }
  },

  async getAllTaskSubscribers(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
      };

      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getAllTaskSubscribers");
    }
  },

  async getTaskSubscriberByEmail(taskId: string, email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item || null;
    } catch (error) {
      handleDynamoDbError(error, "getTaskSubscriberByEmail");
    }
  },

  async updateSubscriberDetails(taskId: string, email: string, feedback: string, customFields: { [key: string]: string }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET feedback = :feedback, customFields = :customFields",
        ExpressionAttributeValues: {
          ":feedback": feedback,
          ":customFields": customFields,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSubscriberDetails");
    }
  },

  async updateSubscriberCustomFields(taskId: string, email: string, customFields: { [key: string]: string }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET customFields = :customFields",
        ExpressionAttributeValues: {
          ":customFields": customFields,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSubscriberCustomFields");
    }
  },

  async addEmailHistory(taskId: string, email: string, emailHistory: {
    sentAt: string;
    subject: string;
    status: 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed';
    taskExecutionId?: string;
    htmlContentUrl?: string;
    senderType: 'SMTP' | 'resend';
    emailId?: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET emailHistory = list_append(if_not_exists(emailHistory, :empty_list), :newEmail)",
        ExpressionAttributeValues: {
          ":empty_list": [],
          ":newEmail": [emailHistory],
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "addEmailHistory");
    }
  },

  async updateEmailStatus(taskId: string, email: string, emailId: string, status: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed') {
    try {
      // First get the current subscriber record
      const subscribers = await this.getTaskSubscribers(taskId);
      const subscriber = subscribers?.find(sub => sub.email === email);
      if (!subscriber || !subscriber.emailHistory) {
        return null;
      }

      // Update the specific email history entry
      const updatedHistory = subscriber.emailHistory.map((emailHistory: any) =>
        emailHistory.id === emailId ? { ...emailHistory, status } : emailHistory
      );

      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET emailHistory = :updatedHistory",
        ExpressionAttributeValues: {
          ":updatedHistory": updatedHistory,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateEmailStatus");
    }
  },

  async batchAddSubscribers(taskId: string, subscribers: Array<{ email: string; customFields: { [key: string]: string } }>) {
    try {
      const results = {
        successCount: 0,
        errorCount: 0,
        errors: [] as string[]
      };

      // Deduplicate subscribers by email (case-insensitive)
      const uniqueSubscribers = new Map<string, { email: string; customFields: { [key: string]: string } }>();
      subscribers.forEach((subscriber, index) => {
        const emailLower = subscriber.email.toLowerCase();
        if (uniqueSubscribers.has(emailLower)) {
          results.errorCount++;
          results.errors.push(`Row ${index + 1}: Duplicate email "${subscriber.email}" found in upload data`);
        } else {
          uniqueSubscribers.set(emailLower, subscriber);
        }
      });

      // Get existing subscribers to check for duplicates
      const existingSubscribers = await this.getAllTaskSubscribers(taskId);
      const existingEmails = new Set((existingSubscribers || []).map(sub => sub.email.toLowerCase()));

      // Filter out existing subscribers
      const newSubscribers: Array<{ email: string; customFields: { [key: string]: string } }> = [];
      uniqueSubscribers.forEach((subscriber, emailLower) => {
        if (existingEmails.has(emailLower)) {
          results.errorCount++;
          results.errors.push(`Email "${subscriber.email}" already exists in subscriber list`);
        } else {
          newSubscribers.push(subscriber);
        }
      });

      // Process new subscribers in batches of 25 (DynamoDB batch write limit)
      const batchSize = 25;
      for (let i = 0; i < newSubscribers.length; i += batchSize) {
        const batch = newSubscribers.slice(i, i + batchSize);

        const writeRequests = batch.map(subscriber => ({
          PutRequest: {
            Item: {
              taskId: taskId,
              email: subscriber.email,
              subscribedAt: new Date().toISOString(),
              customFields: subscriber.customFields || {}
            }
          }
        }));

        try {
          const params = {
            RequestItems: {
              [`${TABLE_PREFIX}AW-Subscribers`]: writeRequests
            }
          };

          await dynamodb.batchWrite(params).promise();
          results.successCount += batch.length;
        } catch (batchError: any) {
          // Handle individual item errors
          if (batchError.code === 'ValidationException' || batchError.code === 'ConditionalCheckFailedException') {
            batch.forEach((subscriber, index) => {
              results.errorCount++;
              results.errors.push(`Row ${i + index + 1}: ${subscriber.email} - ${batchError.message}`);
            });
          } else {
            // If it's a different error, mark all items in this batch as failed
            batch.forEach((subscriber, index) => {
              results.errorCount++;
              results.errors.push(`Row ${i + index + 1}: ${subscriber.email} - Batch write failed`);
            });
          }
        }
      }

      return results;
    } catch (error: any) {
      handleDynamoDbError(error, "batchAddSubscribers");
      return {
        successCount: 0,
        errorCount: subscribers.length,
        errors: [`Batch upload failed: ${error.message}`]
      };
    }
  },
};

// Add minimal workflow methods for counting
export const workflowDb = {
  async getUserWorkflowCount(userId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Workflows`,
        IndexName: "UserWorkflowsIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        Select: "COUNT",
      };

      return await paginatedCount(dynamodb, params);
    } catch (error) {
      console.error("Error getting workflow count:", error);
      return 0;
    }
  },
};

class TaskTemplateDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName: string;

  constructor() {
    this.docClient = dynamodb;
    this.tableName = `${TABLE_PREFIX}AW-TaskTemplates`;
  }

  async createTemplate(template: TaskTemplate) {
    const params = {
      TableName: this.tableName,
      Item: template,
    };

    try {
      await this.docClient.put(params).promise();
      return template;
    } catch (error) {
      handleDynamoDbError(error, "createTemplate");
      throw error;
    }
  }

  async getTemplatesByUserId(userId: string) {
    const params = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };

    try {
      return await paginatedQuery<TaskTemplate>(this.docClient, params);
    } catch (error) {
      handleDynamoDbError(error, "getTemplatesByUserId");
      throw error;
    }
  }

  async getAllTemplates() {
    const params = {
      TableName: this.tableName,
    };

    try {
      return await paginatedScan<TaskTemplate>(this.docClient, params);
    } catch (error) {
      handleDynamoDbError(error, "getAllTemplates");
      throw error;
    }
  }

  async getPublishedTemplates() {
    const params = {
      TableName: this.tableName,
      FilterExpression: "published = :published",
      ExpressionAttributeValues: {
        ":published": true,
      },
    };

    try {
      return await paginatedScan<TaskTemplate>(this.docClient, params);
    } catch (error) {
      handleDynamoDbError(error, "getPublishedTemplates");
      throw error;
    }
  }

  async getTemplateById(templateId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        templateId,
      },
    };

    try {
      const result = await this.docClient.get(params).promise();
      return result.Item as TaskTemplate;
    } catch (error) {
      handleDynamoDbError(error, "getTemplateById");
      throw error;
    }
  }

  async updateTemplate(
    templateId: string,
    updates: Partial<Omit<TaskTemplate, "templateId" | "userId" | "createdAt">>
  ) {
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    // Always update the updatedAt timestamp
    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        templateId,
      },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes as TaskTemplate;
    } catch (error) {
      handleDynamoDbError(error, "updateTemplate");
      throw error;
    }
  }

  async deleteTemplate(templateId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        templateId,
      },
    };

    try {
      await this.docClient.delete(params).promise();
      return { success: true };
    } catch (error) {
      handleDynamoDbError(error, "deleteTemplate");
      throw error;
    }
  }
}

export const taskTemplateDb = new TaskTemplateDB();

// Benchmark Tests Database
class BenchmarkTestDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName: string;

  constructor() {
    this.docClient = new AWS.DynamoDB.DocumentClient();
    this.tableName = `${TABLE_PREFIX}AW-BenchmarkTests`;
  }

  async createBenchmarkTest(benchmarkTest: any) {
    const params = {
      TableName: this.tableName,
      Item: {
        ...benchmarkTest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };

    try {
      await this.docClient.put(params).promise();
      return benchmarkTest;
    } catch (error) {
      handleDynamoDbError(error, "createBenchmarkTest");
      throw error;
    }
  }

  async getBenchmarkTest(testId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
    };

    try {
      const result = await this.docClient.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getBenchmarkTest");
      throw error;
    }
  }

  async getBenchmarkTestsByCreator(createdBy: string, limit: number = 50) {
    const allItems: any[] = [];
    let lastEvaluatedKey: any = undefined;

    try {
      do {
        const params: any = {
          TableName: this.tableName,
          IndexName: "CreatedByIndex",
          KeyConditionExpression: "createdBy = :createdBy",
          ExpressionAttributeValues: {
            ":createdBy": createdBy,
          },
          ScanIndexForward: false, // Sort by createdAt descending
          Limit: limit,
        };

        if (lastEvaluatedKey) {
          params.ExclusiveStartKey = lastEvaluatedKey;
        }

        const result = await this.docClient.query(params).promise();

        if (result.Items && result.Items.length > 0) {
          allItems.push(...result.Items);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getBenchmarkTestsByCreator");
      throw error;
    }
  }

  async getAllBenchmarkTests(limit: number = 100) {
    const allItems: any[] = [];
    let lastEvaluatedKey: any = undefined;

    try {
      do {
        const params: any = {
          TableName: this.tableName,
          Limit: limit,
        };

        if (lastEvaluatedKey) {
          params.ExclusiveStartKey = lastEvaluatedKey;
        }

        const result = await this.docClient.scan(params).promise();

        if (result.Items && result.Items.length > 0) {
          allItems.push(...result.Items);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getAllBenchmarkTests");
      throw error;
    }
  }

  async updateBenchmarkTest(testId: string, updates: any) {
    const updateExpression = [];
    const expressionAttributeNames: any = {};
    const expressionAttributeValues: any = {};

    // Build dynamic update expression
    Object.keys(updates).forEach((key, index) => {
      if (key !== 'testId') { // Don't update the key
        updateExpression.push(`#${key} = :val${index}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:val${index}`] = updates[key];
      }
    });

    updateExpression.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateBenchmarkTest");
      throw error;
    }
  }

  async deleteBenchmarkTest(testId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
    };

    try {
      await this.docClient.delete(params).promise();
      return { success: true };
    } catch (error) {
      handleDynamoDbError(error, "deleteBenchmarkTest");
      throw error;
    }
  }

  async incrementRunCount(testId: string, success: boolean) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
      UpdateExpression: 'ADD runCount :inc, #successCount :successInc, #failureCount :failureInc SET #lastRunAt = :lastRunAt, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#successCount': 'successCount',
        '#failureCount': 'failureCount',
        '#lastRunAt': 'lastRunAt',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':inc': 1,
        ':successInc': success ? 1 : 0,
        ':failureInc': success ? 0 : 1,
        ':lastRunAt': new Date().toISOString(),
        ':updatedAt': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "incrementRunCount");
      throw error;
    }
  }

  /**
   * Trim large fields from a test result to keep DynamoDB item size manageable.
   * Truncates actualResponse and removes responseMessages (full conversation).
   */
  private trimTestResult(result: any): any {
    const MAX_RESPONSE_LENGTH = 2000;
    const trimmed = { ...result };
    if (typeof trimmed.actualResponse === 'string' && trimmed.actualResponse.length > MAX_RESPONSE_LENGTH) {
      trimmed.actualResponse = trimmed.actualResponse.slice(0, MAX_RESPONSE_LENGTH) + '... [truncated]';
    }
    // responseMessages contains the full LLM conversation and is very large — drop it from stored history
    delete trimmed.responseMessages;
    return trimmed;
  }

  async addTestResult(testId: string, testResult: any) {
    const trimmedResult = this.trimTestResult(testResult);

    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
      UpdateExpression: 'SET #testHistory = list_append(if_not_exists(#testHistory, :emptyList), :testResult), #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#testHistory': 'testHistory',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':testResult': [trimmedResult],
        ':emptyList': [],
        ':updatedAt': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error: any) {
      // Handle DynamoDB item size limit error
      if (error.code === 'ValidationException' && error.message?.includes('exceeded the maximum allowed size')) {

        try {
          // Get the current test to access testHistory
          const currentTest = await this.getBenchmarkTest(testId);
          if (!currentTest) {
            throw new Error('Test not found');
          }

          const testHistory = currentTest.testHistory || [];

          // Check if we have any history to work with
          if (testHistory.length === 0) {
            throw new Error('Item size limit exceeded but no test history to remove');
          }

          // Keep only the last 5 records and trim each one
          const updatedHistory = testHistory.slice(-5).map((r: any) => this.trimTestResult(r));


          // Use a direct update to replace the entire testHistory array with trimmed new result included
          updatedHistory.push(trimmedResult);

          const cleanupParams = {
            TableName: this.tableName,
            Key: {
              testId,
            },
            UpdateExpression: 'SET #testHistory = :updatedHistory, #updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#testHistory': 'testHistory',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':updatedHistory': updatedHistory,
              ':updatedAt': new Date().toISOString(),
            },
            ReturnValues: 'ALL_NEW',
          };

          const retryResult = await this.docClient.update(cleanupParams).promise();
          return retryResult.Attributes;
        } catch (cleanupError) {
          console.error('Error cleaning up test history:', cleanupError);
          throw new Error(`Failed to add test result and cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`);
        }
      }

      handleDynamoDbError(error, "addTestResult");
      throw error;
    }
  }
}

export const benchmarkTestDb = new BenchmarkTestDB();

// CRM Database Service
export const crmDb = {
  // Lead List operations
  async createLeadList(
    userId: string,
    name: string,
    description?: string,
    alertEvents?: string[],
    listSenderId?: string | null,
    autoDraftEnabled?: boolean,
    autoDraftInstruction?: string,
    autoSendEnabled?: boolean,
    statusConfig?: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>,
    listType?: 'sales' | 'customers',
    isSystemManaged?: boolean
  ) {
    try {
      const listId = `list_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const normalizedAlertEvents = Array.isArray(alertEvents)
        ? alertEvents
        : ['email.received'];

      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Item: {
          listId,
          userId,
          name,
          description: description || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          leadCount: 0,
          fieldNames: [], // Initialize with empty array
          displayFields: ['email', 'firstName', 'lastName', 'company', 'phone', 'title', 'linkedin', 'companyLinkedin', 'notes'], // Default visible fields
          sortConfig: null,
          alertEvents: normalizedAlertEvents,
          listSenderId: listSenderId ?? null,
          publicAccessEnabled: false, // Default: public access disabled
          autoDraftEnabled: autoDraftEnabled === true, // Default: auto draft disabled
          autoDraftInstruction: typeof autoDraftInstruction === 'string' ? autoDraftInstruction.trim() : '',
          autoSendEnabled: autoSendEnabled === true, // Default: auto send disabled
          engagedOnly: false,
          statusConfig: statusConfig || (listType === 'customers' ? [
            { value: 'onboarding', label: 'Onboarding', color: 'blue', type: 'active' },
            { value: 'active', label: 'Active', color: 'green', type: 'active' },
            { value: 'at_risk', label: 'At Risk', color: 'yellow', type: 'active' },
            { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
          ] : [
            { value: 'new', label: 'New', color: 'gray', type: 'active' },
            { value: 'contacted', label: 'Contacted', color: 'blue', type: 'active' },
            { value: 'qualified', label: 'Qualified', color: 'indigo', type: 'active' },
            { value: 'proposal_sent', label: 'Proposal Sent', color: 'purple', type: 'active' },
            { value: 'negotiating', label: 'Negotiating', color: 'yellow', type: 'active' },
            { value: 'won', label: 'Won', color: 'green', type: 'won' },
            { value: 'lost', label: 'Lost', color: 'red', type: 'lost' },
            { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
          ]),
          ...(listType ? { listType } : {}),
          ...(isSystemManaged ? { isSystemManaged: true } : {}),
        },
      };

      await dynamodb.put(params).promise();
      return params.Item;
    } catch (error) {
      handleDynamoDbError(error, "createLeadList");
      throw error;
    }
  },

  async getLeadListsByUserId(userId: string) {
    try {
      const items: any[] = [];
      let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;

      do {
        const params: AWS.DynamoDB.DocumentClient.QueryInput = {
          TableName: `${TABLE_PREFIX}AW-LeadLists`,
          IndexName: 'userId-index', // Assuming GSI on userId
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
          },
          ExclusiveStartKey: lastEvaluatedKey,
        };

        const result = await dynamodb.query(params).promise();
        items.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      // mergeFieldNames uses list_append (atomic, non-idempotent), which
      // can leave duplicate entries when concurrent appenders race or when
      // the same key is written across many leads. Dedupe + sort on read
      // so /api/crm/lists (and the Configure Display Fields dialog it
      // powers) never surfaces duplicates. Mirrors getLeadListById's
      // behavior for the multi-list query path.
      for (const item of items) {
        if (Array.isArray(item.fieldNames)) {
          item.fieldNames = Array.from(new Set(item.fieldNames as string[])).sort();
        }
      }
      return items;
    } catch (error: any) {
      // If index doesn't exist, use scan with filter
      if (error.code === 'ResourceNotFoundException' || error.message?.includes('index')) {
        const items: any[] = [];
        let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;

        do {
          const params: AWS.DynamoDB.DocumentClient.ScanInput = {
            TableName: `${TABLE_PREFIX}AW-LeadLists`,
            FilterExpression: 'userId = :userId',
            ExpressionAttributeValues: {
              ':userId': userId,
            },
            ExclusiveStartKey: lastEvaluatedKey,
          };
          const result = await dynamodb.scan(params).promise();
          items.push(...(result.Items || []));
          lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        for (const item of items) {
          if (Array.isArray(item.fieldNames)) {
            item.fieldNames = Array.from(new Set(item.fieldNames as string[])).sort();
          }
        }
        return items;
      }
      handleDynamoDbError(error, "getLeadListsByUserId");
      throw error;
    }
  },

  async getAllLeadLists() {
    const items: any[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await dynamodb.scan({
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        ProjectionExpression: 'listId, #n, userId',
        ExpressionAttributeNames: { '#n': 'name' },
        ExclusiveStartKey: lastEvaluatedKey,
      }).promise();
      items.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return items;
  },

  // Returns true if userId owns the list OR is an org member of the same org as the list owner.
  async canOrgMemberAccessList(userId: string, list: { userId?: string } | Record<string, any>): Promise<boolean> {
    if (list.userId === userId) return true;
    const [user, owner] = await Promise.all([
      userDb.getUserById(userId),
      userDb.getUserById(list.userId),
    ]);
    return !!(user?.orgId && owner?.orgId && user.orgId === owner.orgId);
  },

  // Org-aware version: returns the user's own lists plus all org members' lists.
  async getLeadListsForUser(userId: string) {
    const ownLists = await this.getLeadListsByUserId(userId);
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return ownLists;
    const members = await orgDb.getOrgMembers(user.orgId);
    const memberListArrays = await Promise.all(
      members
        .filter((m) => m.userId !== userId)
        .map((m) => this.getLeadListsByUserId(m.userId))
    );
    return [...(ownLists || []), ...memberListArrays.flat().filter(Boolean)];
  },

  async getLeadListById(listId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
      };

      const result = await dynamodb.get(params).promise();
      const item = result.Item || null;
      // mergeFieldNames now writes via atomic list_append, which can leave
      // duplicates in storage when concurrent appenders race. Dedupe + sort
      // on read so all consumers see a clean unique set.
      if (item && Array.isArray(item.fieldNames)) {
        item.fieldNames = Array.from(new Set(item.fieldNames as string[])).sort();
      }
      return item;
    } catch (error) {
      handleDynamoDbError(error, "getLeadListById");
      throw error;
    }
  },

  async updateLeadList(
    listId: string,
    updates: {
      name?: string;
      description?: string;
      displayFields?: string[];
      sortConfig?: { column: string; direction: 'asc' | 'desc' } | null;
      alertEvents?: string[];
      alertCcEmails?: string[];
      listSenderId?: string | null;
      linkedInAccountId?: string | null;
      publicAccessEnabled?: boolean;
      autoDraftEnabled?: boolean;
      autoDraftInstruction?: string;
      autoSendEnabled?: boolean;
      icpsOnly?: boolean;
      engagedOnly?: boolean;
      csvExportHistory?: any[];
      statusConfig?: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>;
      listType?: 'sales' | 'customers';
      syncConfig?: {
        platform: 'hubspot' | 'attio';
        accountId: string;
        direction: 'push' | 'pull' | 'bidirectional';
        lastSyncedAt?: string;
        syncCursor?: string;
        externalListId?: string;      // ID of the list in HubSpot/Attio
        externalPeopleListId?: string; // Attio people list ID
        externalCompaniesListId?: string; // Attio companies list ID
      } | null;
      /** Persisted user-field-name → canonical FIELD_GROUPS field-name map.
       * Populated lazily by the enrichment alias resolver — once we map
       * 'funding_round' → 'funding_stage' for a list, never re-prompt the LLM. */
      fieldCanonicalMap?: Record<string, string>;
      /** LLM-curated clusters of ungrouped fields with their per-cluster search
       * template. Each cluster behaves like an ad-hoc canonical group: one
       * search query covers multiple related ungrouped fields. Populated by
       * enrichmentClusterService at suggest/execute time. */
      ungroupedClusters?: Array<{ fields: string[]; searchTemplate: string }>;
      /** Per-list enrich.so field config — gates which fields the reverse-lookup
       * specialists write to a lead. See enrichmentFieldConfig.ts. */
      enrichmentFieldConfig?: Record<string, boolean>;
      /** Last successful CSV-import column-mapping for this list. Restored as
       * the default mapping in the import wizard so repeat imports of the same
       * template are one-click. Shape: csvHeader → standard field, "skip", or
       * { customField } / { splitFullName }. */
      lastImportMapping?: Record<string, any>;
    }
  ) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeValues: any = {};
      const expressionAttributeNames: Record<string, string> = {};

      if (updates.name !== undefined) {
        expressionAttributeNames['#name'] = 'name';
        updateExpressions.push('#name = :name');
        expressionAttributeValues[':name'] = updates.name;
      }

      if (updates.description !== undefined) {
        expressionAttributeNames['#description'] = 'description';
        updateExpressions.push('#description = :description');
        expressionAttributeValues[':description'] = updates.description;
      }

      if (updates.displayFields !== undefined) {
        expressionAttributeNames['#displayFields'] = 'displayFields';
        updateExpressions.push('#displayFields = :displayFields');
        expressionAttributeValues[':displayFields'] = updates.displayFields;
      }

      if (updates.sortConfig !== undefined) {
        expressionAttributeNames['#sortConfig'] = 'sortConfig';
        updateExpressions.push('#sortConfig = :sortConfig');
        expressionAttributeValues[':sortConfig'] = updates.sortConfig;
      }

      if (updates.alertEvents !== undefined) {
        expressionAttributeNames['#alertEvents'] = 'alertEvents';
        updateExpressions.push('#alertEvents = :alertEvents');
        expressionAttributeValues[':alertEvents'] = updates.alertEvents;
      }

      if (updates.alertCcEmails !== undefined) {
        expressionAttributeNames['#alertCcEmails'] = 'alertCcEmails';
        updateExpressions.push('#alertCcEmails = :alertCcEmails');
        expressionAttributeValues[':alertCcEmails'] = updates.alertCcEmails;
      }

      if (updates.listSenderId !== undefined) {
        expressionAttributeNames['#listSenderId'] = 'listSenderId';
        updateExpressions.push('#listSenderId = :listSenderId');
        expressionAttributeValues[':listSenderId'] = updates.listSenderId;
      }

      if (updates.linkedInAccountId !== undefined) {
        expressionAttributeNames['#linkedInAccountId'] = 'linkedInAccountId';
        updateExpressions.push('#linkedInAccountId = :linkedInAccountId');
        expressionAttributeValues[':linkedInAccountId'] = updates.linkedInAccountId;
      }

      if (updates.publicAccessEnabled !== undefined) {
        expressionAttributeNames['#publicAccessEnabled'] = 'publicAccessEnabled';
        updateExpressions.push('#publicAccessEnabled = :publicAccessEnabled');
        expressionAttributeValues[':publicAccessEnabled'] = updates.publicAccessEnabled;
      }

      if (updates.autoDraftEnabled !== undefined) {
        expressionAttributeNames['#autoDraftEnabled'] = 'autoDraftEnabled';
        updateExpressions.push('#autoDraftEnabled = :autoDraftEnabled');
        expressionAttributeValues[':autoDraftEnabled'] = updates.autoDraftEnabled;
      }

      if (updates.autoDraftInstruction !== undefined) {
        expressionAttributeNames['#autoDraftInstruction'] = 'autoDraftInstruction';
        updateExpressions.push('#autoDraftInstruction = :autoDraftInstruction');
        expressionAttributeValues[':autoDraftInstruction'] = updates.autoDraftInstruction;
      }

      if (updates.autoSendEnabled !== undefined) {
        expressionAttributeNames['#autoSendEnabled'] = 'autoSendEnabled';
        updateExpressions.push('#autoSendEnabled = :autoSendEnabled');
        expressionAttributeValues[':autoSendEnabled'] = updates.autoSendEnabled;
      }

      if (updates.icpsOnly !== undefined) {
        expressionAttributeNames['#icpsOnly'] = 'icpsOnly';
        updateExpressions.push('#icpsOnly = :icpsOnly');
        expressionAttributeValues[':icpsOnly'] = updates.icpsOnly;
      }

      if (updates.engagedOnly !== undefined) {
        expressionAttributeNames['#engagedOnly'] = 'engagedOnly';
        updateExpressions.push('#engagedOnly = :engagedOnly');
        expressionAttributeValues[':engagedOnly'] = updates.engagedOnly;
      }

      if (updates.csvExportHistory !== undefined) {
        expressionAttributeNames['#csvExportHistory'] = 'csvExportHistory';
        updateExpressions.push('#csvExportHistory = :csvExportHistory');
        expressionAttributeValues[':csvExportHistory'] = updates.csvExportHistory;
      }

      if (updates.lastImportMapping !== undefined) {
        expressionAttributeNames['#lastImportMapping'] = 'lastImportMapping';
        updateExpressions.push('#lastImportMapping = :lastImportMapping');
        expressionAttributeValues[':lastImportMapping'] = updates.lastImportMapping;
      }

      if (updates.statusConfig !== undefined) {
        expressionAttributeNames['#statusConfig'] = 'statusConfig';
        updateExpressions.push('#statusConfig = :statusConfig');
        expressionAttributeValues[':statusConfig'] = updates.statusConfig;
      }

      if (updates.listType !== undefined) {
        expressionAttributeNames['#listType'] = 'listType';
        updateExpressions.push('#listType = :listType');
        expressionAttributeValues[':listType'] = updates.listType;
      }

      if (updates.syncConfig !== undefined) {
        expressionAttributeNames['#syncConfig'] = 'syncConfig';
        updateExpressions.push('#syncConfig = :syncConfig');
        expressionAttributeValues[':syncConfig'] = updates.syncConfig;
      }

      if (updates.fieldCanonicalMap !== undefined) {
        expressionAttributeNames['#fieldCanonicalMap'] = 'fieldCanonicalMap';
        updateExpressions.push('#fieldCanonicalMap = :fieldCanonicalMap');
        expressionAttributeValues[':fieldCanonicalMap'] = updates.fieldCanonicalMap;
      }

      if (updates.ungroupedClusters !== undefined) {
        expressionAttributeNames['#ungroupedClusters'] = 'ungroupedClusters';
        updateExpressions.push('#ungroupedClusters = :ungroupedClusters');
        expressionAttributeValues[':ungroupedClusters'] = updates.ungroupedClusters;
      }

      if (updates.enrichmentFieldConfig !== undefined) {
        expressionAttributeNames['#enrichmentFieldConfig'] = 'enrichmentFieldConfig';
        updateExpressions.push('#enrichmentFieldConfig = :enrichmentFieldConfig');
        expressionAttributeValues[':enrichmentFieldConfig'] = updates.enrichmentFieldConfig;
      }

      if (updateExpressions.length === 0) {
        return await this.getLeadListById(listId);
      }

      expressionAttributeNames['#updatedAt'] = 'updatedAt';
      updateExpressions.push('#updatedAt = :updatedAt');
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();

      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateLeadList");
      throw error;
    }
  },


  /**
   * Writes or removes a single provider's CRM sync config on the lead list item.
   *
   * Stored as: externalCrmSyncConfigs: { hubspot: {...}, attio: {...} }
   *
   * Uses if_not_exists so the parent map is initialised automatically if absent.
   * Pass config=null to REMOVE the provider key without touching the other provider.
   */
  async setLeadListCrmSyncConfig(
    listId: string,
    provider: string,
    config: Record<string, any> | null
  ): Promise<void> {
    try {
      let params: any;

      if (config !== null) {
        // Read the current map, merge the provider key in JS, write the whole map back.
        // This avoids the DynamoDB limitation where SET map.key fails when the parent
        // map doesn't yet exist on the item (if_not_exists + nested path evaluated
        // simultaneously against the original item state, not sequentially).
        const current = await dynamodb.get({
          TableName: `${TABLE_PREFIX}AW-LeadLists`,
          Key: { listId },
          ProjectionExpression: '#ecs',
          ExpressionAttributeNames: { '#ecs': 'externalCrmSyncConfigs' },
        }).promise();
        const existingMap = (current.Item?.externalCrmSyncConfigs as Record<string, any>) ?? {};
        const mergedMap = { ...existingMap, [provider]: config };

        params = {
          TableName: `${TABLE_PREFIX}AW-LeadLists`,
          Key: { listId },
          UpdateExpression: 'SET #ecs = :mergedMap, #updatedAt = :now',
          ExpressionAttributeNames: {
            '#ecs': 'externalCrmSyncConfigs',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':mergedMap': mergedMap,
            ':now': new Date().toISOString(),
          },
        };
      } else {
        params = {
          TableName: `${TABLE_PREFIX}AW-LeadLists`,
          Key: { listId },
          UpdateExpression: 'REMOVE #ecs.#provider SET #updatedAt = :now',
          ExpressionAttributeNames: {
            '#ecs': 'externalCrmSyncConfigs',
            '#provider': provider,
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':now': new Date().toISOString(),
          },
        };
      }

      await dynamodb.update(params).promise();
    } catch (error: any) {
      // If removing a nested key from a map that doesn't exist yet, DynamoDB throws
      // ValidationException. Treat it as a no-op — the config is already absent.
      if (config === null && error?.code === 'ValidationException') return;
      handleDynamoDbError(error, 'setLeadListCrmSyncConfig');
      throw error;
    }
  },

  /**
   * v3.1 enrichment config — `enrichmentConfig` attribute on AW-LeadLists.
   * Per-list scoped. Returns null when no config has ever been saved (callers
   * should fall back to a default built from the list's field schema).
   */
  async getEnrichmentConfig(listId: string): Promise<any | null> {
    try {
      const result = await dynamodb.get({
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: { listId },
        ProjectionExpression: 'enrichmentConfig',
      }).promise();
      return result.Item?.enrichmentConfig ?? null;
    } catch (error) {
      handleDynamoDbError(error, 'getEnrichmentConfig');
      throw error;
    }
  },

  async setEnrichmentConfig(listId: string, config: any): Promise<void> {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: { listId },
        UpdateExpression: 'SET enrichmentConfig = :c, #updatedAt = :now',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: {
          ':c': config,
          ':now': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(listId)',
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'setEnrichmentConfig');
      throw error;
    }
  },

  /**
   * Persists the Unipile search cursor for a given (listId, criteriaHash) so
   * the next find-leads top-up loop with the same filters resumes where the
   * previous one stopped instead of re-paginating from page 1.
   *
   * Stored as: searchCursors: { [criteriaHash]: { cursor, lastUsedAt } }.
   * Pass cursor=null to clear an entry (e.g. after exhausting results).
   * LRU-evicts to MAX_SEARCH_CURSORS entries by lastUsedAt to keep the list
   * item from growing unbounded across many distinct search-criteria sets.
   */
  async setLeadListSearchCursor(
    listId: string,
    criteriaHash: string,
    cursor: string | null
  ): Promise<void> {
    const MAX_SEARCH_CURSORS = 10;
    try {
      const current = await dynamodb.get({
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: { listId },
        ProjectionExpression: '#sc',
        ExpressionAttributeNames: { '#sc': 'searchCursors' },
      }).promise();
      const existingMap = (current.Item?.searchCursors as Record<string, { cursor: string; lastUsedAt: string }>) ?? {};

      const nextMap: Record<string, { cursor: string; lastUsedAt: string }> = { ...existingMap };
      if (cursor === null) {
        delete nextMap[criteriaHash];
      } else {
        nextMap[criteriaHash] = { cursor, lastUsedAt: new Date().toISOString() };
      }

      const entries = Object.entries(nextMap);
      if (entries.length > MAX_SEARCH_CURSORS) {
        // LRU eviction: drop oldest by lastUsedAt until at cap.
        entries.sort((a, b) => (a[1].lastUsedAt || '').localeCompare(b[1].lastUsedAt || ''));
        const trimmed = entries.slice(entries.length - MAX_SEARCH_CURSORS);
        for (const key of Object.keys(nextMap)) delete nextMap[key];
        for (const [k, v] of trimmed) nextMap[k] = v;
      }

      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: { listId },
        UpdateExpression: 'SET #sc = :map, #updatedAt = :now',
        ExpressionAttributeNames: {
          '#sc': 'searchCursors',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':map': nextMap,
          ':now': new Date().toISOString(),
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'setLeadListSearchCursor');
      throw error;
    }
  },

  async deleteLeadList(listId: string) {
    try {
      // First, delete all leads in this list
      // Fetch all leads to delete (paginate through them)
      const allLeads: any[] = [];
      let lastKey = undefined;
      do {
        const result = await this.getLeadsByListId(listId, 100, lastKey);
        allLeads.push(...result.items);
        lastKey = result.lastEvaluatedKey;
      } while (lastKey);

      if (allLeads.length > 0) {
        const batchSize = 25;
        for (let i = 0; i < allLeads.length; i += batchSize) {
          const batch = allLeads.slice(i, i + batchSize);
          const deleteRequests = batch.map(lead => ({
            DeleteRequest: {
              Key: {
                listId: lead.listId,
                leadId: lead.leadId,
              },
            },
          }));

          const params = {
            RequestItems: {
              [`${TABLE_PREFIX}AW-Leads`]: deleteRequests,
            },
          };

          await dynamodb.batchWrite(params).promise();
        }
      }

      // Then delete the list
      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
      };

      await dynamodb.delete(params).promise();
      return { success: true };
    } catch (error) {
      handleDynamoDbError(error, "deleteLeadList");
      throw error;
    }
  },

  async incrementLeadCount(listId: string, increment: number = 1) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
        UpdateExpression: 'ADD leadCount :inc SET updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':inc': increment,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "incrementLeadCount");
      throw error;
    }
  },

  async updateFieldNames(listId: string, fieldNames: string[]) {
    try {
      // Get unique field names and sort them
      const uniqueFieldNames = Array.from(new Set(fieldNames)).sort();

      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
        UpdateExpression: 'SET fieldNames = :fieldNames, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':fieldNames': uniqueFieldNames,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateFieldNames");
      throw error;
    }
  },

  async mergeFieldNames(listId: string, newFields: Set<string> | string[]): Promise<void> {
    // Atomic append via DDB list_append — no read-modify-write. Two concurrent
    // post-job calls on the same list can no longer lose updates. Storage may
    // contain transient duplicates under high concurrency; getLeadListById
    // dedupes + sorts on read so consumers see a clean unique set.
    const incoming = Array.from(newFields instanceof Set ? newFields : new Set(newFields));
    if (incoming.length === 0) return;
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: { listId },
        UpdateExpression:
          'SET fieldNames = list_append(if_not_exists(fieldNames, :empty), :incoming), updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':empty': [],
          ':incoming': incoming,
          ':updatedAt': new Date().toISOString(),
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'mergeFieldNames');
      throw error;
    }
  },

  async updateSearchQueryTemplates(
    listId: string,
    templates: Record<string, string>,
    sourcesPerField?: Record<string, string[]>,
    enrichmentInstruction?: string,
    enrichmentOutputFields?: string[],
    webSearchTemplate?: string,
    linkedinSearchTemplate?: string,
    enrichSources?: string[],
    fieldDescriptions?: Record<string, string>,
  ) {
    try {
      const expressionParts = ['searchQueryTemplates = :templates', 'updatedAt = :updatedAt'];
      const expressionAttributeValues: any = {
        ':templates': templates,
        ':updatedAt': new Date().toISOString(),
      };

      if (sourcesPerField !== undefined) {
        expressionParts.push('sourcesPerField = :sourcesPerField');
        expressionAttributeValues[':sourcesPerField'] = sourcesPerField;
      }

      if (enrichmentInstruction !== undefined) {
        expressionParts.push('enrichmentInstruction = :instruction');
        expressionAttributeValues[':instruction'] = enrichmentInstruction;
      }

      if (enrichmentOutputFields !== undefined) {
        expressionParts.push('enrichmentOutputFields = :outputFields');
        expressionAttributeValues[':outputFields'] = enrichmentOutputFields;
      }

      if (webSearchTemplate !== undefined) {
        expressionParts.push('webSearchTemplate = :webSearchTemplate');
        expressionAttributeValues[':webSearchTemplate'] = webSearchTemplate;
      }

      if (linkedinSearchTemplate !== undefined) {
        expressionParts.push('linkedinSearchTemplate = :linkedinSearchTemplate');
        expressionAttributeValues[':linkedinSearchTemplate'] = linkedinSearchTemplate;
      }

      if (enrichSources !== undefined) {
        expressionParts.push('enrichSources = :enrichSources');
        expressionAttributeValues[':enrichSources'] = enrichSources;
      }

      if (fieldDescriptions !== undefined) {
        expressionParts.push('fieldDescriptions = :fieldDescriptions');
        expressionAttributeValues[':fieldDescriptions'] = fieldDescriptions;
      }

      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: { listId },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSearchQueryTemplates");
      throw error;
    }
  },

  // Lead operations
  async createLead(listId: string, leadData: {
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    company?: string;
    title?: string;
    notes?: string;
    linkedin?: string;
    companyLinkedin?: string;
    customFields?: Record<string, any>;
    selectedSenderId?: string | null;
    status?: string | null;
    dealValue?: number | null;
    dealCurrency?: string;
    contactStatus?: 'active' | 'do-not-contact' | 'unsubscribed';
    contactStatusReason?: 'opted-out' | 'bounced' | 'complained' | 'requested-removal' | 'admin-flagged' | 'compliance' | 'other';
    contactStatusNote?: string;
    contactStatusUpdatedBy?: string;
    // CRM Unification v1 extensions (A1)
    domain?: string;
    accountOwnerUserId?: string;
    pocEmails?: string[];
    priority?: 'Low' | 'Medium' | 'High';
    expectedClose?: string;
    closedDate?: string;
    heatScore?: number;
    healthScore?: number;
    lifecycle?: 'unknown' | 'inbox' | 'signed_up' | 'in_deal' | 'trialing' | 'paying' | 'at_risk' | 'churned';
    role?: 'KDM' | 'Champion' | 'Blocker' | 'Influencer' | 'Other';
    isPrimary?: boolean;
    dealIds?: string[];
    tenantId?: string;
    syncMetadata?: Record<string, any>;
    // Attribution fields (mirror User schema — see types/attribution.ts)
    firstTouch?: AttributionTouch;
    lastTouch?: AttributionTouch;
    utmSource?: string;
    utmMedium?: string;
    // CRM-history Tier 0: list-owner denormalized onto the lead for audit
    // metadata. Lookup GSIs partition on email/linkedin/nameCompanyKey, not
    // userId, so userId is not load-bearing for retrieval — only audit.
    userId?: string;
  }) {
    try {
      const leadId = `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Check for duplicate email if email is provided
      if (leadData.email && leadData.email.trim()) {
        const existingLead = await this.getLeadByEmail(listId, leadData.email.trim().toLowerCase());
        if (existingLead) {
          throw new Error(`Lead with email "${leadData.email}" already exists in this list`);
        }
      }

      const emailValue = leadData.email?.trim().toLowerCase();
      const linkedinValue = leadData.linkedin?.trim();
      const item: any = {
        listId,
        leadId,
        firstName: leadData.firstName || '',
        lastName: leadData.lastName || '',
        phone: leadData.phone || '',
        company: leadData.company || '',
        title: leadData.title || '',
        notes: leadData.notes || '',
        companyLinkedin: leadData.companyLinkedin?.trim() || '',
        customFields: sanitizeCustomFields(leadData.customFields, { source: 'db.createLead', listId }),
        engagements: [],
        isICP: 0,
        isEngaged: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (emailValue) {
        item.email = emailValue;
      }
      // Keep linkedin sparse so LinkedinLookupIndex GSI only indexes leads
      // with a real value (empty-string HASH keys are wasteful in the GSI).
      if (linkedinValue) {
        item.linkedin = linkedinValue;
      }
      // Derive the list-owner's userId for CRM-history Tier 0 audit metadata.
      // Caller may override (e.g., backfill / admin tooling); otherwise it
      // matches the parent list's userId, guaranteeing lead.userId never
      // desyncs from list.userId.
      let ownerUserId: string | undefined = leadData.userId;
      if (!ownerUserId) {
        try {
          const list = await this.getLeadListById(listId) as any;
          if (list?.userId) ownerUserId = String(list.userId);
        } catch {
          // List-fetch failures here are non-fatal — userId stays undefined
          // and the backfill script can repair it later.
        }
      }
      if (ownerUserId) {
        item.userId = ownerUserId;
      }
      const nameCompanyKey = computeNameCompanyKey(
        leadData.firstName, leadData.lastName, leadData.company,
      );
      if (nameCompanyKey) {
        item.nameCompanyKey = nameCompanyKey;
      }
      if (leadData.selectedSenderId) {
        item.selectedSenderId = leadData.selectedSenderId;
      }
      if (leadData.status) {
        item.status = leadData.status;
      }
      if (leadData.dealValue != null) {
        item.dealValue = leadData.dealValue;
      }
      if (leadData.dealCurrency) {
        item.dealCurrency = leadData.dealCurrency;
      }
      if (leadData.contactStatus) {
        item.contactStatus = leadData.contactStatus;
        if (leadData.contactStatusReason) {
          item.contactStatusReason = leadData.contactStatusReason;
        }
        if (leadData.contactStatusNote) {
          item.contactStatusNote = leadData.contactStatusNote;
        }
        item.contactStatusUpdatedAt = new Date().toISOString();
        item.contactStatusUpdatedBy = leadData.contactStatusUpdatedBy || 'system';
      }
      if (leadData.syncMetadata && Object.keys(leadData.syncMetadata).length > 0) {
        item.syncMetadata = leadData.syncMetadata;
      }

      // CRM Unification v1 extensions (A1): domain (derived), lifecycle (defaulted
      // to 'inbox' when email present), heatScore/healthScore, priority, role,
      // isPrimary, dealIds[], accountOwnerUserId, expectedClose, closedDate.
      const crmFields = buildLeadCrmFields(emailValue, {
        domain: leadData.domain,
        accountOwnerUserId: leadData.accountOwnerUserId,
        pocEmails: leadData.pocEmails,
        priority: leadData.priority,
        expectedClose: leadData.expectedClose,
        closedDate: leadData.closedDate,
        heatScore: leadData.heatScore,
        healthScore: leadData.healthScore,
        lifecycle: leadData.lifecycle,
        role: leadData.role,
        isPrimary: leadData.isPrimary,
        dealIds: leadData.dealIds,
        tenantId: leadData.tenantId,
      });
      Object.assign(item, crmFields);

      // Attribution fields (Lead UTM — mirrors User schema). firstTouch is
      // stamped on creation and never mutated; lastTouch is refreshed on each
      // touch. utmSource / utmMedium are denormalized from firstTouch for
      // cheap channel-attribution filter queries.
      const attributionFields = buildLeadAttributionFields({
        firstTouch: leadData.firstTouch,
        // On a brand-new Lead, if only firstTouch is supplied, treat it as
        // lastTouch too — same contract as the User registration path in
        // controllers/auth.ts.
        lastTouch: leadData.lastTouch || leadData.firstTouch,
        utmSource: leadData.utmSource,
        utmMedium: leadData.utmMedium,
      });
      Object.assign(item, attributionFields);

      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Item: item,
      };

      await dynamodb.put(params).promise();

      // Extract field names from lead data
      const fieldNames: string[] = [];
      const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'companyLinkedin', 'status', 'dealValue', 'dealCurrency'];
      standardFields.forEach(field => {
        if (leadData[field as keyof typeof leadData] && String(leadData[field as keyof typeof leadData]).trim()) {
          fieldNames.push(field);
        }
      });
      if (leadData.customFields) {
        Object.keys(leadData.customFields).forEach(key => {
          if (leadData.customFields![key] && String(leadData.customFields![key]).trim()) {
            fieldNames.push(key);
          }
        });
      }

      // Update field names in list
      if (fieldNames.length > 0) {
        const list = await this.getLeadListById(listId);
        const existingFieldNames = (list?.fieldNames as string[]) || [];
        const allFieldNames = [...existingFieldNames, ...fieldNames];
        await this.updateFieldNames(listId, allFieldNames);
      }

      // Increment lead count
      await this.incrementLeadCount(listId, 1);

      // Attribution event — fire once per Lead when any attribution signal is
      // captured. Dedupe via sourceRecordId (`attribution:lead:{leadId}`) so
      // retries on the same lead create a single row.
      if (leadData.firstTouch) {
        const contactId = emailValue || `nocontact:${leadId}`;
        try {
          await contactEventsDb.logEvent({
            contactId: normalizeContactId(contactId),
            source: 'lead_form',
            eventType: 'attribution.first_touch',
            sourceRecordId: `attribution:lead:${leadId}`,
            payload: {
              leadId,
              listId,
              firstTouch: leadData.firstTouch,
              // Denormalized for cheap dashboard queries — same shape the
              // User signup event emits.
              utmSource: leadData.firstTouch.utm?.source,
              utmMedium: leadData.firstTouch.utm?.medium,
              utmCampaign: leadData.firstTouch.utm?.campaign,
              referrer: leadData.firstTouch.referrer,
              landingUrl: leadData.firstTouch.landingUrl,
            },
            ...(leadData.tenantId ? { tenantId: leadData.tenantId } : {}),
          });
        } catch (eventErr) {
          // Never fail lead creation on an event-log write error — the lead
          // row has already been persisted above. Log and continue.
          console.error('[createLead] attribution.first_touch logEvent failed:', eventErr);
        }
      }

      return params.Item;
    } catch (error) {
      handleDynamoDbError(error, "createLead");
      throw error;
    }
  },

  async getLeadsByListId(listId: string, limit?: number, lastEvaluatedKey?: any) {
    try {
      const params: any = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        KeyConditionExpression: 'listId = :listId',
        ExpressionAttributeValues: {
          ':listId': listId,
        },
        ScanIndexForward: false, // newest leadId (timestamp-prefixed) first
      };

      if (limit !== undefined && limit > 0) {
        params.Limit = limit;
      }

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
        hasMore: !!result.LastEvaluatedKey,
      };
    } catch (error) {
      handleDynamoDbError(error, "getLeadsByListId");
      throw error;
    }
  },

  // Loads ALL leads for a list, following DynamoDB pagination. Use this anywhere a
  // complete list is required (enrollment, coverage counts) — getLeadsByListId
  // returns only a single ~1MB page.
  async getAllLeadsByListId(listId: string) {
    const all: any[] = [];
    let lastKey: any = undefined;
    do {
      const result = await this.getLeadsByListId(listId, 100, lastKey);
      all.push(...result.items);
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);
    return all;
  },

  async getLeadsByICPFlag(listId: string, isICP: 0 | 1, limit?: number, lastEvaluatedKey?: any) {
    try {
      const params: any = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'listId-isICP-index',
        KeyConditionExpression: 'listId = :listId AND isICP = :isICP',
        ExpressionAttributeValues: {
          ':listId': listId,
          ':isICP': isICP,
        },
      };

      if (limit !== undefined && limit > 0) {
        params.Limit = limit;
      }
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
        hasMore: !!result.LastEvaluatedKey,
      };
    } catch (error) {
      handleDynamoDbError(error, "getLeadsByICPFlag");
      throw error;
    }
  },

  async getLeadsByEngagedFlag(listId: string, isEngaged: 0 | 1, limit?: number, lastEvaluatedKey?: any) {
    try {
      const params: any = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'listId-isEngaged-index',
        KeyConditionExpression: 'listId = :listId AND isEngaged = :isEngaged',
        ExpressionAttributeValues: {
          ':listId': listId,
          ':isEngaged': isEngaged,
        },
      };

      if (limit !== undefined && limit > 0) {
        params.Limit = limit;
      }
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
        hasMore: !!result.LastEvaluatedKey,
      };
    } catch (error) {
      handleDynamoDbError(error, "getLeadsByEngagedFlag");
      throw error;
    }
  },

  async getLeadsByStatus(listId: string, status: string, limit?: number, lastEvaluatedKey?: any) {
    try {
      const params: any = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'listId-status-index',
        KeyConditionExpression: 'listId = :listId AND #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':listId': listId,
          ':status': status,
        },
      };

      if (limit !== undefined && limit > 0) {
        params.Limit = limit;
      }
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
        hasMore: !!result.LastEvaluatedKey,
      };
    } catch (error) {
      handleDynamoDbError(error, "getLeadsByStatus");
      throw error;
    }
  },

  async getLeadById(listId: string, leadId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Key: {
          listId,
          leadId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item || null;
    } catch (error) {
      handleDynamoDbError(error, "getLeadById");
      throw error;
    }
  },

  /**
   * Cross-tenant lookup by email — backs CRM-history Tier 0. Queries the
   * EmailLookupIndex GSI globally (no userId filter) so a sibling lead
   * enriched on ANY user's list is returned. Sort key `updatedAt` means
   * `ScanIndexForward: false` gives the freshest match first.
   */
  async findLeadsByEmail(email: string) {
    const value = (email ?? '').trim().toLowerCase();
    if (!value) return [];
    try {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'EmailLookupIndex',
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: { ':email': value },
        ScanIndexForward: false,
        Limit: 10,
      }).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'findLeadsByEmail');
      throw error;
    }
  },

  async findLeadsByLinkedin(linkedin: string) {
    const value = (linkedin ?? '').trim();
    if (!value) return [];
    try {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'LinkedinLookupIndex',
        KeyConditionExpression: 'linkedin = :linkedin',
        ExpressionAttributeValues: { ':linkedin': value },
        ScanIndexForward: false,
        Limit: 10,
      }).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'findLeadsByLinkedin');
      throw error;
    }
  },

  async findLeadsByNameCompany(firstName: string, lastName: string, company: string) {
    const key = computeNameCompanyKey(firstName, lastName, company);
    if (!key) return [];
    try {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'NameCompanyLookupIndex',
        KeyConditionExpression: 'nameCompanyKey = :nameCompanyKey',
        ExpressionAttributeValues: { ':nameCompanyKey': key },
        ScanIndexForward: false,
        Limit: 10,
      }).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'findLeadsByNameCompany');
      throw error;
    }
  },

  async batchGetLeads(listId: string, leadIds: string[]) {
    if (leadIds.length === 0) return [];

    // DynamoDB BatchGetItem caps at 100 keys per call; matching approvalDb's
    // conservative 25 keeps payloads small and leaves headroom for retries.
    const BATCH_SIZE = 25;
    const results: any[] = [];
    const tableName = `${TABLE_PREFIX}AW-Leads`;

    for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
      const batch = leadIds.slice(i, i + BATCH_SIZE);
      const params = {
        RequestItems: {
          [tableName]: {
            Keys: batch.map(leadId => ({ listId, leadId })),
          },
        },
      };

      try {
        const result = await dynamodb.batchGet(params).promise();
        const batchItems = (result.Responses?.[tableName] as any[]) || [];
        results.push(...batchItems);
      } catch (error) {
        handleDynamoDbError(error, "batchGetLeads");
        throw error;
      }
    }

    return results;
  },

  async getLeadByEmail(listId: string, email: string) {
    try {
      // Use email-index GSI to query by listId and email
      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        IndexName: 'email-index',
        KeyConditionExpression: 'listId = :listId AND email = :email',
        ExpressionAttributeValues: {
          ':listId': listId,
          ':email': email.toLowerCase().trim(),
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items && result.Items.length > 0 ? result.Items[0] : null;
    } catch (error) {
      handleDynamoDbError(error, "getLeadByEmail");
      throw error;
    }
  },

  async getLeadByHubSpotContactId(listId: string, contactId: string) {
    try {
      const params: any = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        KeyConditionExpression: 'listId = :listId',
        FilterExpression: 'syncMetadata.hubspot_contact_id = :contactId',
        ExpressionAttributeValues: {
          ':listId': listId,
          ':contactId': contactId,
        },
      };
      const result = await dynamodb.query(params).promise();
      return result.Items?.[0] ?? null;
    } catch (error) {
      handleDynamoDbError(error, "getLeadByHubSpotContactId");
      throw error;
    }
  },

  async updateLead(listId: string, leadId: string, updates: {
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    company?: string;
    title?: string;
    notes?: string;
    linkedin?: string;
    companyLinkedin?: string;
    customFields?: Record<string, any>;
    selectedSenderId?: string | null;
    emailDraftFormat?: 'text' | 'html';
    emailDraft?: {
      subject: string;
      htmlContent?: string;
      textContent?: string;
      createdAt: string;
      updatedAt: string;
      sessionId?: string;
    } | null;
    messageDraft?: {
      content: string;
      createdAt: string;
      updatedAt: string;
      sessionId?: string;
    } | null;
    icpMatch?: {
      isMatch: boolean;
      score: number;
      reason: string;
      matchedAt: string;
    } | null;
    lastAutoSendAt?: string | null;
    status?: string | null;
    dealValue?: number | null;
    dealCurrency?: string;
    unsubscribedFromGroupEmail?: boolean;
    unsubscribedFromGroupEmailAt?: string;
    contactStatus?: 'active' | 'do-not-contact' | 'unsubscribed' | null;
    contactStatusReason?: 'opted-out' | 'bounced' | 'complained' | 'requested-removal' | 'admin-flagged' | 'compliance' | 'other' | null;
    contactStatusNote?: string | null;
    contactStatusUpdatedAt?: string;
    contactStatusUpdatedBy?: string;
    accountOwnerUserId?: string | null;
    pocEmails?: string[] | null;
    syncMetadata?: Record<string, any>;
    /**
     * Lead UTM attribution (mirrors the User schema, see utils/leadSchema.ts).
     * firstTouch is immutable once stamped; lastTouch is refreshed on any repeat
     * touch (e.g. the public webhook merge path). utmSource / utmMedium are
     * denormalized from firstTouch for cheap channel-attribution filter queries.
     */
    firstTouch?: AttributionTouch;
    lastTouch?: AttributionTouch;
    utmSource?: string;
    utmMedium?: string;
    /** Enrichment metadata sidecar — keyed by field name (custom or standard). See utils/enrichedFieldValue.ts. */
    enrichmentMetadata?: Record<string, any>;
    /** ISO timestamp set when a LinkedIn connection invite is manually sent from the CRM. */
    linkedInInviteSentAt?: string | null;
    /** CRM-internal bookkeeping (findReason, freshUntil, scheduledRunAt,
     *  icpSource). Sidecar map distinct from customFields so it does NOT
     *  leak into CSV exports, email-template variables, or the
     *  lead-filter UI as a user-authored column. Pass `null` to clear. */
    system?: Record<string, any> | null;
    /** Skip the per-call fieldNames update on AW-LeadLists. Use when the caller
     *  will do a single consolidated updateFieldNames after bulk writes (avoids
     *  read-modify-write races under parallel workers). */
    skipFieldNamesUpdate?: boolean;
  }) {
    try {
      const setExpressions: string[] = [];
      const removeExpressions: string[] = [];
      const expressionAttributeValues: any = {};
      const expressionAttributeNames: Record<string, string> = {};

      // Read the existing row once up-front. Used for two purposes:
      //   1. Self-heal legacy empty-string GSI key attributes (see below).
      //   2. Merge values for the nameCompanyKey recompute block further down,
      //      so we don't do a second getLeadById call.
      // Empty-string HASH keys are invalid on the three sparse cross-tenant
      // lookup GSIs (EmailLookupIndex, LinkedinLookupIndex,
      // NameCompanyLookupIndex). Any updateLead call SETs updatedAt (the
      // range key on all three), which forces DDB to re-project the GSI
      // entry; if the row carries email/linkedin/nameCompanyKey as "" from
      // before the sparse-index guards landed, the update fails with
      // ValidationException. Queue a REMOVE for each offending attribute
      // here so the same UpdateExpression cleans the row in-place.
      const existingLeadForGuard: any = await this.getLeadById(listId, leadId);

      // CRM extension: accountOwnerUserId. Supports null => REMOVE.
      if (updates.accountOwnerUserId !== undefined) {
        if (updates.accountOwnerUserId === null || updates.accountOwnerUserId === '') {
          removeExpressions.push('accountOwnerUserId');
        } else {
          setExpressions.push('accountOwnerUserId = :accountOwnerUserId');
          expressionAttributeValues[':accountOwnerUserId'] = String(updates.accountOwnerUserId);
        }
      }

      // CRM extension: pocEmails. Supports null/empty => REMOVE.
      if (updates.pocEmails !== undefined) {
        if (updates.pocEmails === null || updates.pocEmails.length === 0) {
          removeExpressions.push('pocEmails');
        } else {
          setExpressions.push('pocEmails = :pocEmails');
          expressionAttributeValues[':pocEmails'] = updates.pocEmails;
        }
      }

      if (updates.email !== undefined) {
        const emailValue = (updates.email ?? '').trim().toLowerCase();
        if (emailValue) {
          // Only set email if it's not empty (GSI key cannot be empty string)
          setExpressions.push('email = :email');
          expressionAttributeValues[':email'] = emailValue;
        } else {
          // Remove email attribute if it's being set to empty/null
          removeExpressions.push('email');
        }
      }

      if (updates.firstName !== undefined) {
        if (updates.firstName) {
          setExpressions.push('firstName = :firstName');
          expressionAttributeValues[':firstName'] = updates.firstName;
        } else {
          removeExpressions.push('firstName');
        }
      }

      if (updates.lastName !== undefined) {
        if (updates.lastName) {
          setExpressions.push('lastName = :lastName');
          expressionAttributeValues[':lastName'] = updates.lastName;
        } else {
          removeExpressions.push('lastName');
        }
      }

      if (updates.phone !== undefined) {
        if (updates.phone) {
          setExpressions.push('phone = :phone');
          expressionAttributeValues[':phone'] = updates.phone;
        } else {
          removeExpressions.push('phone');
        }
      }

      if (updates.company !== undefined) {
        if (updates.company) {
          setExpressions.push('company = :company');
          expressionAttributeValues[':company'] = updates.company;
        } else {
          removeExpressions.push('company');
        }
      }

      if (updates.title !== undefined) {
        if (updates.title) {
          setExpressions.push('title = :title');
          expressionAttributeValues[':title'] = updates.title;
        } else {
          removeExpressions.push('title');
        }
      }

      if (updates.notes !== undefined) {
        if (updates.notes) {
          setExpressions.push('notes = :notes');
          expressionAttributeValues[':notes'] = updates.notes;
        } else {
          removeExpressions.push('notes');
        }
      }

      if (updates.linkedin !== undefined) {
        const trimmedLinkedin = (updates.linkedin ?? '').trim();
        if (trimmedLinkedin) {
          setExpressions.push('linkedin = :linkedin');
          expressionAttributeValues[':linkedin'] = trimmedLinkedin;
        } else {
          // Keep LinkedinLookupIndex sparse — empty/null values must not appear.
          removeExpressions.push('linkedin');
        }
      }

      // Recompute nameCompanyKey when any of firstName/lastName/company is in
      // the update payload. Requires a read-before-write to merge the values
      // we DIDN'T touch (so a partial update doesn't blank-out the key just
      // because not every field was provided). Reuses existingLeadForGuard.
      const nameCompanyTouched =
        updates.firstName !== undefined ||
        updates.lastName !== undefined ||
        updates.company !== undefined;
      if (nameCompanyTouched) {
        const current = existingLeadForGuard as any;
        const mergedFirst = updates.firstName !== undefined ? (updates.firstName ?? '') : (current?.firstName || '');
        const mergedLast = updates.lastName !== undefined ? (updates.lastName ?? '') : (current?.lastName || '');
        const mergedCompany = updates.company !== undefined ? (updates.company ?? '') : (current?.company || '');
        const nck = computeNameCompanyKey(mergedFirst, mergedLast, mergedCompany);
        if (nck) {
          setExpressions.push('nameCompanyKey = :nameCompanyKey');
          expressionAttributeValues[':nameCompanyKey'] = nck;
        } else {
          removeExpressions.push('nameCompanyKey');
        }
      }

      if (updates.companyLinkedin !== undefined) {
        const trimmedCompanyLinkedin = (updates.companyLinkedin ?? '').trim();
        if (trimmedCompanyLinkedin) {
          setExpressions.push('companyLinkedin = :companyLinkedin');
          expressionAttributeValues[':companyLinkedin'] = trimmedCompanyLinkedin;
        } else {
          removeExpressions.push('companyLinkedin');
        }
      }

      if (updates.linkedInInviteSentAt !== undefined) {
        if (updates.linkedInInviteSentAt === null) {
          removeExpressions.push('linkedInInviteSentAt');
        } else {
          setExpressions.push('linkedInInviteSentAt = :linkedInInviteSentAt');
          expressionAttributeValues[':linkedInInviteSentAt'] = updates.linkedInInviteSentAt;
        }
      }

      if (updates.customFields !== undefined) {
        setExpressions.push('customFields = :customFields');
        expressionAttributeValues[':customFields'] = sanitizeCustomFields(
          updates.customFields,
          { source: 'db.updateLead', listId, leadId },
        );
      }

      if (updates.enrichmentMetadata !== undefined) {
        setExpressions.push('enrichmentMetadata = :enrichmentMetadata');
        expressionAttributeValues[':enrichmentMetadata'] = updates.enrichmentMetadata;
      }

      if (updates.system !== undefined) {
        if (updates.system === null) {
          removeExpressions.push('#system');
          expressionAttributeNames['#system'] = 'system';
        } else {
          setExpressions.push('#system = :system');
          expressionAttributeNames['#system'] = 'system';
          expressionAttributeValues[':system'] = updates.system;
        }
      }

      if (updates.selectedSenderId !== undefined) {
        if (updates.selectedSenderId === null) {
          // Remove selectedSenderId attribute
          removeExpressions.push('selectedSenderId');
        } else {
          setExpressions.push('selectedSenderId = :selectedSenderId');
          expressionAttributeValues[':selectedSenderId'] = updates.selectedSenderId;
        }
      }

      if (updates.emailDraftFormat !== undefined) {
        setExpressions.push('emailDraftFormat = :emailDraftFormat');
        expressionAttributeValues[':emailDraftFormat'] = updates.emailDraftFormat;
      }

      if (updates.emailDraft !== undefined) {
        if (updates.emailDraft === null) {
          // Remove emailDraft attribute
          removeExpressions.push('emailDraft');
        } else {
          setExpressions.push('emailDraft = :emailDraft');
          expressionAttributeValues[':emailDraft'] = updates.emailDraft;
        }
      }

      if (updates.messageDraft !== undefined) {
        if (updates.messageDraft === null) {
          // Remove messageDraft attribute
          removeExpressions.push('messageDraft');
        } else {
          setExpressions.push('messageDraft = :messageDraft');
          expressionAttributeValues[':messageDraft'] = updates.messageDraft;
        }
      }

      if (updates.icpMatch !== undefined) {
        if (updates.icpMatch === null) {
          // Remove icpMatch attribute
          removeExpressions.push('icpMatch');
          setExpressions.push('isICP = :isICP');
          expressionAttributeValues[':isICP'] = 0;
        } else {
          setExpressions.push('icpMatch = :icpMatch');
          expressionAttributeValues[':icpMatch'] = updates.icpMatch;
          setExpressions.push('isICP = :isICP');
          expressionAttributeValues[':isICP'] = updates.icpMatch.isMatch === true ? 1 : 0;
        }
      }

      if (updates.lastAutoSendAt !== undefined) {
        if (updates.lastAutoSendAt === null) {
          removeExpressions.push('lastAutoSendAt');
        } else {
          setExpressions.push('lastAutoSendAt = :lastAutoSendAt');
          expressionAttributeValues[':lastAutoSendAt'] = updates.lastAutoSendAt;
        }
      }

      if (updates.status !== undefined) {
        if (updates.status === null) {
          removeExpressions.push('#status');
          expressionAttributeNames['#status'] = 'status';
        } else {
          setExpressions.push('#status = :status');
          expressionAttributeNames['#status'] = 'status';
          expressionAttributeValues[':status'] = updates.status;
        }
      }

      if (updates.dealValue !== undefined) {
        if (updates.dealValue === null) {
          removeExpressions.push('#dealValue');
          expressionAttributeNames['#dealValue'] = 'dealValue';
        } else {
          setExpressions.push('#dealValue = :dealValue');
          expressionAttributeNames['#dealValue'] = 'dealValue';
          expressionAttributeValues[':dealValue'] = updates.dealValue;
        }
      }

      if (updates.dealCurrency !== undefined) {
        setExpressions.push('dealCurrency = :dealCurrency');
        expressionAttributeValues[':dealCurrency'] = updates.dealCurrency;
      }

      if (updates.unsubscribedFromGroupEmail !== undefined) {
        setExpressions.push('unsubscribedFromGroupEmail = :unsubGE');
        expressionAttributeValues[':unsubGE'] = updates.unsubscribedFromGroupEmail;
      }

      if (updates.unsubscribedFromGroupEmailAt !== undefined) {
        setExpressions.push('unsubscribedFromGroupEmailAt = :unsubGEAt');
        expressionAttributeValues[':unsubGEAt'] = updates.unsubscribedFromGroupEmailAt;
      }

      if (updates.contactStatus !== undefined) {
        if (updates.contactStatus === null) {
          removeExpressions.push('contactStatus');
          removeExpressions.push('contactStatusReason');
          removeExpressions.push('contactStatusNote');
          removeExpressions.push('contactStatusUpdatedAt');
          removeExpressions.push('contactStatusUpdatedBy');
        } else {
          setExpressions.push('contactStatus = :contactStatus');
          expressionAttributeValues[':contactStatus'] = updates.contactStatus;
          setExpressions.push('contactStatusUpdatedAt = :csUpdatedAt');
          expressionAttributeValues[':csUpdatedAt'] = updates.contactStatusUpdatedAt || new Date().toISOString();
          if (updates.contactStatusUpdatedBy) {
            setExpressions.push('contactStatusUpdatedBy = :csUpdatedBy');
            expressionAttributeValues[':csUpdatedBy'] = updates.contactStatusUpdatedBy;
          }
        }
      }

      if (updates.contactStatusReason !== undefined) {
        if (updates.contactStatusReason === null) {
          removeExpressions.push('contactStatusReason');
        } else {
          setExpressions.push('contactStatusReason = :csReason');
          expressionAttributeValues[':csReason'] = updates.contactStatusReason;
        }
      }

      if (updates.contactStatusNote !== undefined) {
        if (updates.contactStatusNote === null) {
          removeExpressions.push('contactStatusNote');
        } else {
          setExpressions.push('contactStatusNote = :csNote');
          expressionAttributeValues[':csNote'] = updates.contactStatusNote;
        }
      }

      if (updates.syncMetadata !== undefined) {
        setExpressions.push('syncMetadata = :syncMetadata');
        expressionAttributeValues[':syncMetadata'] = updates.syncMetadata;
      }

      // Lead UTM attribution. firstTouch is immutable once stamped, but the
      // public webhook merge path backfills it when a lead predates attribution
      // and refreshes lastTouch on every repeat touch. utmSource / utmMedium
      // are denormalized strings. Callers enforce the immutability contract
      // (only-if-absent backfill for firstTouch/utm denorm); this layer just
      // persists whatever the caller passes.
      if (updates.firstTouch !== undefined) {
        setExpressions.push('firstTouch = :firstTouch');
        expressionAttributeValues[':firstTouch'] = updates.firstTouch;
      }
      if (updates.lastTouch !== undefined) {
        setExpressions.push('lastTouch = :lastTouch');
        expressionAttributeValues[':lastTouch'] = updates.lastTouch;
      }
      if (updates.utmSource !== undefined) {
        setExpressions.push('utmSource = :utmSource');
        expressionAttributeValues[':utmSource'] = updates.utmSource;
      }
      if (updates.utmMedium !== undefined) {
        setExpressions.push('utmMedium = :utmMedium');
        expressionAttributeValues[':utmMedium'] = updates.utmMedium;
      }

      // Always update updatedAt
      setExpressions.push('updatedAt = :updatedAt');
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();

      // Self-heal legacy empty-string GSI key attributes. Must run AFTER all
      // the field-specific SET/REMOVE blocks above so we can tell whether the
      // caller is already touching the attribute (SET wins; never emit both
      // SET and REMOVE for the same name in one UpdateExpression).
      if (existingLeadForGuard) {
        const gsiKeyFields: Array<'email' | 'linkedin' | 'nameCompanyKey'> = [
          'email',
          'linkedin',
          'nameCompanyKey',
        ];
        const placeholderByField: Record<string, string> = {
          email: ':email',
          linkedin: ':linkedin',
          nameCompanyKey: ':nameCompanyKey',
        };
        for (const field of gsiKeyFields) {
          const current = (existingLeadForGuard as any)[field];
          if (typeof current !== 'string' || current !== '') continue;
          const alreadySet = expressionAttributeValues[placeholderByField[field]] !== undefined;
          const alreadyRemoved = removeExpressions.includes(field);
          if (alreadySet || alreadyRemoved) continue;
          removeExpressions.push(field);
        }
      }

      if (setExpressions.length === 0 && removeExpressions.length === 0) {
        return existingLeadForGuard;
      }

      // Build UpdateExpression with proper SET and REMOVE clauses
      const updateExpressionParts: string[] = [];
      if (setExpressions.length > 0) {
        updateExpressionParts.push(`SET ${setExpressions.join(', ')}`);
      }
      if (removeExpressions.length > 0) {
        updateExpressionParts.push(`REMOVE ${removeExpressions.join(', ')}`);
      }

      const params: any = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Key: {
          listId,
          leadId,
        },
        UpdateExpression: updateExpressionParts.join(' '),
        ExpressionAttributeValues: Object.keys(expressionAttributeValues).length > 0 ? expressionAttributeValues : undefined,
        ReturnValues: 'ALL_NEW' as const,
      };
      if (Object.keys(expressionAttributeNames).length > 0) {
        params.ExpressionAttributeNames = expressionAttributeNames;
      }

      const result = await dynamodb.update(params).promise();

      // Extract field names from updates
      const fieldNames: string[] = [];
      const internalFields = ['leadId', 'listId', 'createdAt', 'updatedAt', 'lastInteractionAt', 'syncMetadata', 'enrichmentData', 'enrichmentMetadata', 'scores', 'selectedSenderId', 'customFields', 'isICP', 'isEngaged', 'engagements', 'system'];

      // Top level fields
      Object.keys(updates).forEach(key => {
        if (!internalFields.includes(key) && (updates as any)[key] !== undefined && (updates as any)[key] !== null && String((updates as any)[key]).trim() !== '') {
          fieldNames.push(key);
        }
      });
      // customFields explicitly
      if (updates.customFields) {
        Object.keys(updates.customFields).forEach(key => {
          if (updates.customFields![key] && String(updates.customFields![key]).trim()) {
            fieldNames.push(key);
          }
        });
      }

      // Update field names in list (skip when caller handles consolidated write)
      if (fieldNames.length > 0 && !updates.skipFieldNamesUpdate) {
        const list = await this.getLeadListById(listId);
        const existingFieldNames = (list?.fieldNames as string[]) || [];
        const allFieldNames = [...existingFieldNames, ...fieldNames];
        await this.updateFieldNames(listId, allFieldNames);
      }

      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateLead");
      throw error;
    }
  },

  async deleteLead(listId: string, leadId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Key: {
          listId,
          leadId,
        },
      };

      await dynamodb.delete(params).promise();

      // Decrement lead count
      await this.incrementLeadCount(listId, -1);

      return { success: true };
    } catch (error) {
      handleDynamoDbError(error, "deleteLead");
      throw error;
    }
  },

  async batchCreateLeads(listId: string, leads: Array<{
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    company?: string;
    title?: string;
    notes?: string;
    linkedin?: string;
    companyLinkedin?: string;
    customFields?: Record<string, any>;
    status?: string | null;
    dealValue?: number | null;
    dealCurrency?: string;
    syncMetadata?: Record<string, any>;
    /** CRM-internal bookkeeping for the find-leads / scheduled-search /
     *  ICP-sourcing flows (findReason, freshUntil, scheduledRunAt,
     *  icpSource). Sidecar map distinct from customFields so it does NOT
     *  leak into CSV exports, email-template variables, or the
     *  lead-filter UI. */
    system?: Record<string, any>;
  }>) {
    try {
      const results = {
        successCount: 0,
        newCount: 0,
        mergedCount: 0,
        errorCount: 0,
        errors: [] as string[],
        // IDs of newly created leads (excludes merged updates). Used by callers
        // that need to act on freshly-imported leads — e.g., the CSV importer
        // queues these for enrich.so email validation when the user opts in.
        created: [] as Array<{ leadId: string; email?: string }>,
      };

      // Get existing leads to check for duplicates by email
      // Note: We need to fetch all existing leads, so we'll paginate through them
      const allExistingLeads: any[] = [];
      let lastKey = undefined;
      do {
        const result = await this.getLeadsByListId(listId, 100, lastKey);
        allExistingLeads.push(...result.items);
        lastKey = result.lastEvaluatedKey;
      } while (lastKey);

      // Build dedup maps keyed by both email AND normalized LinkedIn URL.
      // Same person can appear with no email but a LinkedIn URL (typical for
      // Unipile-sourced leads), or vice versa — both axes must dedup or
      // imports inflate the list with duplicates.
      const existingLeadsByEmail = new Map<string, any>();
      const existingLeadsByLinkedIn = new Map<string, any>();
      allExistingLeads.forEach(lead => {
        if (lead.email && lead.email.trim()) {
          existingLeadsByEmail.set(lead.email.trim().toLowerCase(), lead);
        }
        const liKey = normalizeLinkedInUrl(lead.linkedin);
        if (liKey) existingLeadsByLinkedIn.set(liKey, lead);
      });

      // Separate leads into new leads and leads to update
      const newLeads: typeof leads = [];
      const leadsToUpdate: Array<{ existingLead: any; newData: typeof leads[0] }> = [];

      // Deduplicate leads within the upload by email AND by normalized LinkedIn URL.
      const uniqueLeads = new Map<string, typeof leads[0]>();
      const seenLinkedIn = new Set<string>();
      leads.forEach((lead, index) => {
        const emailKey = lead.email?.trim().toLowerCase() || `__no_email_${index + 1}__`;
        const liKey = normalizeLinkedInUrl(lead.linkedin);

        if (lead.email && lead.email.trim()) {
          if (uniqueLeads.has(emailKey)) {
            results.errorCount++;
            results.errors.push(`Row ${index + 1}: Duplicate email "${lead.email}" found in upload data`);
            return;
          }

          // Check against existing leads — if exists, mark for update instead of error
          const existingLead = existingLeadsByEmail.get(emailKey);
          if (existingLead) {
            leadsToUpdate.push({ existingLead, newData: lead });
            return;
          }
        }

        // LinkedIn URL dedup — covers the case where email is missing or
        // both leads share a URL even if their emails differ.
        if (liKey) {
          // Within-batch dedup: skip if we've already seen this normalized URL.
          if (seenLinkedIn.has(liKey)) {
            results.errorCount++;
            results.errors.push(`Row ${index + 1}: Duplicate LinkedIn URL "${lead.linkedin}" found in upload data`);
            return;
          }
          // Existing-list dedup: same URL → merge into existing lead.
          const existingByLi = existingLeadsByLinkedIn.get(liKey);
          if (existingByLi) {
            leadsToUpdate.push({ existingLead: existingByLi, newData: lead });
            seenLinkedIn.add(liKey);
            return;
          }
          seenLinkedIn.add(liKey);
        }

        uniqueLeads.set(emailKey, lead);
      });

      // Add unique new leads
      uniqueLeads.forEach((lead) => {
        newLeads.push(lead);
      });

      // Process new leads in batches of 25 (DynamoDB batch write limit)
      const batchSize = 25;
      for (let i = 0; i < newLeads.length; i += batchSize) {
        const batch = newLeads.slice(i, i + batchSize);

        const batchCreated: Array<{ leadId: string; email?: string }> = [];
        const writeRequests = batch.map(lead => {
          const leadId = `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const emailValue = lead.email?.trim().toLowerCase();
          batchCreated.push({ leadId, email: emailValue });

          const item: any = {
            listId,
            leadId,
            firstName: lead.firstName || '',
            lastName: lead.lastName || '',
            phone: lead.phone || '',
            company: lead.company || '',
            title: lead.title || '',
            notes: lead.notes || '',
            companyLinkedin: lead.companyLinkedin?.trim() || '',
            customFields: sanitizeCustomFields(lead.customFields, { source: 'db.batchCreateLeads.newLead', listId, leadId }),
            syncMetadata: lead.syncMetadata || {},
            engagements: [], // Initialize with empty array
            isICP: 0,
            isEngaged: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          // Only include email/linkedin if non-empty — GSI key cannot be empty string
          if (emailValue) {
            item.email = emailValue;
          }
          // Store LinkedIn URL in canonical form so future dedup reads match
          // regardless of the source's formatting (Unipile, CSV upload, manual entry).
          const linkedinValue = normalizeLinkedInUrl(lead.linkedin);
          if (linkedinValue) {
            item.linkedin = linkedinValue;
          }
          if (lead.status) {
            item.status = lead.status;
          }
          if (lead.dealValue != null) {
            item.dealValue = lead.dealValue;
          }
          if (lead.dealCurrency) {
            item.dealCurrency = lead.dealCurrency;
          }
          if (lead.system && Object.keys(lead.system).length > 0) {
            item.system = lead.system;
          }
          const nameCompanyKey = computeNameCompanyKey(lead.firstName, lead.lastName, lead.company);
          if (nameCompanyKey) {
            item.nameCompanyKey = nameCompanyKey;
          }

          return {
            PutRequest: {
              Item: item,
            },
          };
        });

        try {
          const params = {
            RequestItems: {
              [`${TABLE_PREFIX}AW-Leads`]: writeRequests,
            },
          };

          await dynamodb.batchWrite(params).promise();
          results.successCount += batch.length;
          results.newCount += batch.length;
          // Promote batch IDs into the global created list only after the write
          // succeeds — keeps results.created in sync with what's actually persisted.
          results.created.push(...batchCreated);
        } catch (batchError: any) {
          batch.forEach((lead, index) => {
            results.errorCount++;
            results.errors.push(`Row ${i + index + 1}: ${lead.email || 'Unknown'} - ${batchError.message}`);
          });
        }
      }

      // Extract all field names from imported leads (both new and updated)
      const allFieldNames: string[] = [];
      const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'companyLinkedin', 'status', 'dealValue', 'dealCurrency'];

      const internalFields = ['leadId', 'listId', 'createdAt', 'updatedAt', 'lastInteractionAt', 'syncMetadata', 'enrichmentData', 'enrichmentMetadata', 'scores', 'selectedSenderId', 'customFields', 'isICP', 'isEngaged', 'engagements', 'system'];

      // Extract from new leads
      newLeads.forEach(lead => {
        // Top level fields
        Object.keys(lead).forEach(key => {
          if (!internalFields.includes(key) && (lead as any)[key] !== undefined && (lead as any)[key] !== null && String((lead as any)[key]).trim() !== '') {
            allFieldNames.push(key);
          }
        });
        // customFields explicitly
        if (lead.customFields) {
          Object.keys(lead.customFields).forEach(key => {
            if (lead.customFields![key] && String(lead.customFields![key]).trim()) {
              allFieldNames.push(key);
            }
          });
        }
      });

      // Extract from leads being updated
      leadsToUpdate.forEach(({ newData }) => {
        // Top level fields
        Object.keys(newData).forEach(key => {
          if (!internalFields.includes(key) && (newData as any)[key] !== undefined && (newData as any)[key] !== null && String((newData as any)[key]).trim() !== '') {
            allFieldNames.push(key);
          }
        });
        // customFields explicitly
        if (newData.customFields) {
          Object.keys(newData.customFields).forEach(key => {
            if (newData.customFields![key] && String(newData.customFields![key]).trim()) {
              allFieldNames.push(key);
            }
          });
        }
      });

      // Update field names in list
      if (allFieldNames.length > 0) {
        const list = await this.getLeadListById(listId);
        const existingFieldNames = (list?.fieldNames as string[]) || [];
        const combinedFieldNames = [...existingFieldNames, ...allFieldNames];
        await this.updateFieldNames(listId, combinedFieldNames);
      }

      // Process leads to update (merge existing leads with new data)
      for (const { existingLead, newData } of leadsToUpdate) {
        try {
          // Helper to normalize values for comparison
          const normalize = (value: any): string => {
            if (value === null || value === undefined) return '';
            return String(value).trim();
          };

          // Build update object - only include fields that have values in newData
          const updates: any = {};
          let changed = false;

          // Define standard string fields that should be trimmed and compared
          const standardStringFields: (keyof typeof newData)[] = [
            'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'companyLinkedin', 'dealCurrency'
          ];

          for (const field of standardStringFields) {
            const incomingVal = newData[field];
            if (incomingVal !== undefined && typeof incomingVal === 'string' && incomingVal.trim() !== '') {
              const newValue = incomingVal.trim();
              const existingValue = normalize(existingLead[field as string]);
              if (existingValue !== newValue) {
                updates[field as string] = newValue;
                changed = true;
              }
            }
          }

          // Internal sync fields (stored in syncMetadata)
          const internalSyncFields = ['syncMetadata'];
          for (const field of internalSyncFields) {
            const incomingVal = (newData as any)[field];
            if (incomingVal !== undefined && incomingVal !== null) {
              const existingVal = existingLead[field] || {};
              // Merging syncMetadata to avoid overwriting existing provider IDs with new ones
              const mergedMetadata = { ...existingVal, ...incomingVal };
              if (JSON.stringify(existingVal) !== JSON.stringify(mergedMetadata)) {
                updates[field] = mergedMetadata;
                changed = true;
              }
            }
          }

          // Define standard literal fields that don't need trimming (can be numbers, booleans, or specific enums)
          const standardLiteralFields: (keyof typeof newData)[] = ['status', 'dealValue'];

          for (const field of standardLiteralFields) {
            const incomingVal = newData[field];
            if (incomingVal !== undefined && incomingVal !== null) {
              if (existingLead[field as string] !== incomingVal) {
                updates[field as string] = incomingVal;
                changed = true;
              }
            }
          }

          // Check customFields - only if newData has customFields
          if (newData.customFields !== undefined) {
            const existingCustomFields = existingLead.customFields || {};
            const newCustomFields = newData.customFields || {};

            // Normalize function for consistent comparison (sort keys, trim strings, handle null/undefined/empty consistently)
            const normalizeCustomFields = (fields: Record<string, any>): Record<string, any> => {
              if (!fields || typeof fields !== 'object') return {};
              const normalized: Record<string, any> = {};
              Object.keys(fields).sort().forEach(key => {
                const value = fields[key];
                // Only include non-null, non-undefined values
                if (value !== null && value !== undefined) {
                  // Convert to string and trim, or keep as-is if not a string
                  normalized[key] = typeof value === 'string' ? value.trim() : value;
                }
              });
              return normalized;
            };

            // Normalize existing and new separately
            const existingNormalized = normalizeCustomFields(existingCustomFields);
            const newNormalized = normalizeCustomFields(newCustomFields);

            // Merge normalized versions
            const mergedNormalized = {
              ...existingNormalized,
              ...newNormalized,
            };

            // Compare normalized existing with normalized merged result
            const existingStr = JSON.stringify(existingNormalized);
            const mergedStr = JSON.stringify(mergedNormalized);

            // Only update if the merged result is different from existing
            if (existingStr !== mergedStr) {
              // Use the actual merged customFields (not normalized) for the update
              const mergedCustomFields = mergeCustomFields(
                existingCustomFields,
                newCustomFields,
                { source: 'db.batchCreateLeads.merge', listId, leadId: existingLead.leadId },
              );
              updates.customFields = mergedCustomFields;
              changed = true;
            }
          }

          // Only update if there are changes
          if (changed) {
            await this.updateLead(listId, existingLead.leadId, updates);
            results.successCount++;
            results.mergedCount++;
          }
          // If no changes, skip the update (don't count as merged)
        } catch (updateError: any) {
          results.errorCount++;
          results.errors.push(`Row: Email "${newData.email}" - Failed to update: ${updateError.message}`);
        }
      }

      // Update lead count (only for new leads, updates don't change count)
      if (newLeads.length > 0) {
        await this.incrementLeadCount(listId, newLeads.length);
      }

      return results;
    } catch (error: any) {
      handleDynamoDbError(error, "batchCreateLeads");
      return {
        successCount: 0,
        newCount: 0,
        mergedCount: 0,
        errorCount: leads.length,
        errors: [`Batch upload failed: ${error.message}`],
        created: [] as Array<{ leadId: string; email?: string }>,
      };
    }
  },

  async getLeadEngagementCount(listId: string, leadId: string, userId: string): Promise<{ total: number; last7Days: number; totalAllMessages: number }> {
    try {
      // Get the lead
      const lead = await this.getLeadById(listId, leadId);
      if (!lead) {
        return { total: 0, last7Days: 0, totalAllMessages: 0 };
      }

      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      let totalCount = 0; // Total SENT messages by user
      let last7DaysCount = 0;
      let totalAllMessagesCount = 0; // Total ALL messages (sent + received)

      // Count manual engagements
      const manualEngagements = (lead.engagements as Array<{ eventType: string; eventData: any; createdAt: string }>) || [];

      // Filter for only SENT events (eventType contains "sent")
      const sentManualEngagements = manualEngagements.filter((eng) => eng.eventType && eng.eventType.toLowerCase().includes('sent'));
      totalCount += sentManualEngagements.length;
      totalAllMessagesCount += manualEngagements.length;

      // Count manual sent engagements in last 7 days
      sentManualEngagements.forEach((eng) => {
        const createdAt = new Date(eng.createdAt);
        if (createdAt >= sevenDaysAgo) {
          last7DaysCount++;
        }
      });

      // Count email events if user has email domain configured
      const user = await userDb.getUserById(userId);
      if (user && user.emailDomain) {
        const emailEventsDb = require('./emailEventsDb').emailEventsDb;
        const leadEmail = lead.email?.toLowerCase();

        if (leadEmail) {
          // Use optimized query with composite GSI (EmailDomainLeadEmailIndex)
          const filteredEvents = await emailEventsDb.getEventsByEmailDomainAndLeadEmail(user.emailDomain, leadEmail);

          // Filter for only SENT events (eventType contains "sent")
          const sentEvents = filteredEvents.filter((event: any) => event.eventType && event.eventType.toLowerCase().includes('sent'));
          totalCount += sentEvents.length;
          totalAllMessagesCount += filteredEvents.length;

          // Count email sent events in last 7 days
          sentEvents.forEach((event: any) => {
            const createdAt = new Date(event.createdAt);
            if (createdAt >= sevenDaysAgo) {
              last7DaysCount++;
            }
          });
        }
      }

      // Count LinkedIn message events
      const leadLinkedIn = lead.linkedin?.toLowerCase();
      if (leadLinkedIn) {
        const emailEventsDb = require('./emailEventsDb').emailEventsDb;
        const linkedInEventsRaw = await emailEventsDb.getEventsByEmailDomainAndLeadEmail(`linkedin-${listId}`, leadLinkedIn);
        // Drop synthetic send-time events the sync later re-imported so a single
        // sent message isn't double-counted.
        const linkedInEvents = dedupeLinkedInMessageEvents(linkedInEventsRaw);

        // Filter for only SENT messages (eventType contains "sent")
        const sentMessages = linkedInEvents.filter((event: any) => event.eventType && event.eventType.toLowerCase().includes('sent'));
        totalCount += sentMessages.length;

        // Count ALL messages (sent + received) for totalAllMessagesCount
        totalAllMessagesCount += linkedInEvents.length;

        // Count LinkedIn sent messages in last 7 days
        sentMessages.forEach((event: any) => {
          const createdAt = new Date(event.createdAt);
          if (createdAt >= sevenDaysAgo) {
            last7DaysCount++;
          }
        });
      }

      return {
        total: totalCount, // Messages SENT by user
        totalAllMessages: totalAllMessagesCount, // ALL messages (sent + received)
        last7Days: last7DaysCount
      };
    } catch (error) {
      console.error('Error counting lead engagements:', error);
      return { total: 0, last7Days: 0, totalAllMessages: 0 }; // Return 0 on error to avoid breaking the UI
    }
  },

  async getLeadEngagements(listId: string, leadId: string, userId: string) {
    try {
      // Get the lead
      const lead = await this.getLeadById(listId, leadId);
      if (!lead) {
        throw new Error('Lead not found');
      }

      // Get user to get emailDomain (optional for LinkedIn events)
      const user = await userDb.getUserById(userId);

      // Get email events from AW-EmailEvents filtered by domain and lead email
      const emailEventsDb = require('./emailEventsDb').emailEventsDb;
      const leadEmail = lead.email?.toLowerCase();
      const leadLinkedIn = lead.linkedin?.toLowerCase();

      // Use optimized query with composite GSI (EmailDomainLeadEmailIndex)
      // Query by email only if user has emailDomain configured
      const emailEvents = (leadEmail && user?.emailDomain)
        ? await emailEventsDb.getEventsByEmailDomainAndLeadEmail(user.emailDomain, leadEmail)
        : [];

      // Always get LinkedIn message events for this lead (stored with LinkedIn URL as leadEmail)
      // This should work even if user doesn't have emailDomain configured for regular emails
      const linkedInEventsRaw = leadLinkedIn
        ? await emailEventsDb.getEventsByEmailDomainAndLeadEmail(`linkedin-${listId}`, leadLinkedIn)
        : [];
      // Drop synthetic send-time events that the sync later re-imported (avoids
      // the same outbound message showing twice in the activity timeline).
      const linkedInEvents = dedupeLinkedInMessageEvents(linkedInEventsRaw);

      const filteredEvents = [...emailEvents, ...linkedInEvents];

      // Transform email events to engagement format
      // For email.received events, fetch the email content
      const emailEngagements = await Promise.all(
        filteredEvents.map(async (event: any) => {
          const baseEngagement = {
            eventType: event.eventType,
            eventData: event.data,
            createdAt: event.createdAt,
            source: 'email' as const, // Mark as email event
          };

          // For all email events, pass through pre-stored emailContent (e.g. sent emails)
          if (event.emailContent && event.eventType !== 'email.received' && event.eventType !== 'email.delivered') {
            return { ...baseEngagement, emailContent: event.emailContent };
          }

          // For email.received and email.delivered events, fetch the email content
          if ((event.eventType === 'email.received' || event.eventType === 'email.delivered') && (event.emailContent || event.data?.email_id)) {
            // If already stored, return immediately
            if (event.emailContent && !event.data?.email_id) {
              return { ...baseEngagement, emailContent: event.emailContent };
            }
            try {
              let emailContent: { html?: string; text?: string; headers?: Record<string, string> } | null = null;

              // Check if email content is already cached in the event record
              if (event.emailContent) {
                return {
                  ...baseEngagement,
                  emailContent: event.emailContent, // Use cached content from event record
                };
              }

              // Fetch from Resend if not cached
              const resendService = require('./resendService').resendService;

              if (event.eventType === 'email.received') {
                emailContent = await resendService.getReceivedEmailContent(event.data.email_id);
              } else if (event.eventType === 'email.delivered') {
                emailContent = await resendService.getDeliveredEmailContent(event.data.email_id);
              }

              if (emailContent) {
                // Store in event record for caching (truncated to 10k if needed)
                try {
                  const emailEventsDb = require('./emailEventsDb').emailEventsDb;
                  await emailEventsDb.updateEmailEventContent(event.eventId, emailContent);
                } catch (updateError) {
                  console.error(`Failed to update email event content for ${event.data.email_id}:`, updateError);
                  // Continue even if update fails
                }

                // Truncate for response if needed (same logic as in updateEmailEventContent)
                const truncatedContent = {
                  html: emailContent.html && emailContent.html.length > 10000
                    ? emailContent.html.substring(0, 10000) + '... [truncated]'
                    : emailContent.html,
                  text: emailContent.text && emailContent.text.length > 10000
                    ? emailContent.text.substring(0, 10000) + '... [truncated]'
                    : emailContent.text,
                  headers: emailContent.headers
                };

                return {
                  ...baseEngagement,
                  emailContent: truncatedContent, // Add html, text, and headers
                };
              }
            } catch (error) {
              console.error(`Failed to fetch email content for ${event.data.email_id}:`, error);
              // Continue without email content if fetch fails
            }
          }

          return baseEngagement;
        })
      );

      // Get lead engagements
      const leadEngagements = ((lead.engagements as Array<{ eventId?: string; eventType: string; eventData: any; createdAt: string }>) || []).map((eng: any) => ({
        ...eng,
        source: 'manual', // Mark as manual engagement
        // eventId is already included in eng if it exists
      }));

      // Combine and sort by createdAt (newest first)
      const allEngagements = [...emailEngagements, ...leadEngagements].sort((a, b) => {
        const dateA = new Date(a.createdAt).getTime();
        const dateB = new Date(b.createdAt).getTime();
        return dateB - dateA; // Descending order
      });

      return {
        engagements: allEngagements,
      };
    } catch (error) {
      handleDynamoDbError(error, "getLeadEngagements");
      throw error;
    }
  },

  async updateLeadLinkedInSyncAt(listId: string, leadId: string, syncAt: string): Promise<void> {
    const TABLE_NAME = `${TABLE_PREFIX}AW-Leads`;
    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { listId, leadId },
      UpdateExpression: 'SET linkedinMessageSyncAt = :syncAt, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':syncAt': syncAt,
        ':updatedAt': new Date().toISOString(),
      },
    }).promise();
  },

  /**
   * Onboarding v2 dual-write helper — mirror per-User onboarding analytics
   * onto the matching Lead row. The user-facing route (onboardingEvents.ts)
   * writes to the User record first, then fire-and-forget calls this to
   * keep the Lead in sync so Fangfang / Emma can see the full flow on the
   * Lead detail page.
   *
   * Writes three top-level attributes on the Lead:
   *   - onboardingEvents: OnboardingEvent[] (full log mirror)
   *   - onboardingStage: OnboardingStage
   *   - onboardingDeviationCount: int
   *
   * Overwrites atomically — this is a pure projection of User state.
   * Task: https://www.notion.so/34c09247c951812cbc90f09aa68fc5d3
   */
  async updateLeadOnboardingAnalytics(
    listId: string,
    leadId: string,
    analytics: {
      onboardingEvents: unknown[];
      onboardingStage: string;
      onboardingDeviationCount: number;
    },
  ): Promise<void> {
    const TABLE_NAME = `${TABLE_PREFIX}AW-Leads`;
    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { listId, leadId },
      UpdateExpression:
        'SET onboardingEvents = :events, onboardingStage = :stage, onboardingDeviationCount = :dc, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':events': analytics.onboardingEvents,
        ':stage': analytics.onboardingStage,
        ':dc': analytics.onboardingDeviationCount,
        ':updatedAt': new Date().toISOString(),
      },
    }).promise();
  },

  async addLeadEngagement(listId: string, leadId: string, engagement: {
    eventType: string;
    eventData: any;
    createdAt: string;
  }) {
    try {
      // Get the lead first to ensure it exists
      const lead = await this.getLeadById(listId, leadId);
      if (!lead) {
        throw new Error('Lead not found');
      }

      // Generate a unique eventId for this engagement
      const eventId = `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Add eventId to the engagement
      const engagementWithId = {
        ...engagement,
        eventId,
      };

      // Get existing engagements or initialize empty array
      const existingEngagements = (lead.engagements as Array<{ eventId?: string; eventType: string; eventData: any; createdAt: string }>) || [];

      // Add the new engagement
      const updatedEngagements = [...existingEngagements, engagementWithId];
      const isEngaged = updatedEngagements.some(engagementMatchesKeyword) ? 1 : 0;

      // Update the lead with the new engagements array
      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Key: {
          listId,
          leadId,
        },
        UpdateExpression: 'SET engagements = :engagements, isEngaged = :isEngaged, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':engagements': updatedEngagements,
          ':isEngaged': isEngaged,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "addLeadEngagement");
      throw error;
    }
  },

  async updateLeadEngagement(listId: string, leadId: string, eventId: string, engagement: {
    eventType: string;
    eventData: any;
    createdAt: string;
  }) {
    try {
      // Get the lead first to ensure it exists
      const lead = await this.getLeadById(listId, leadId);
      if (!lead) {
        throw new Error('Lead not found');
      }

      // Get existing engagements or initialize empty array
      const existingEngagements = (lead.engagements as Array<{ eventId?: string; eventType: string; eventData: any; createdAt: string }>) || [];

      // Find the engagement by eventId
      const engagementIndex = existingEngagements.findIndex((eng) => eng.eventId === eventId);

      if (engagementIndex === -1) {
        throw new Error('Engagement not found');
      }

      // Update the engagement while preserving the eventId
      const updatedEngagements = [...existingEngagements];
      updatedEngagements[engagementIndex] = {
        ...engagement,
        eventId, // Preserve the original eventId
      };
      const isEngaged = updatedEngagements.some(engagementMatchesKeyword) ? 1 : 0;

      // Update the lead with the updated engagements array
      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Key: {
          listId,
          leadId,
        },
        UpdateExpression: 'SET engagements = :engagements, isEngaged = :isEngaged, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':engagements': updatedEngagements,
          ':isEngaged': isEngaged,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateLeadEngagement");
      throw error;
    }
  },

  async deleteLeadEngagement(listId: string, leadId: string, eventId: string) {
    try {
      // Get the lead first to ensure it exists
      const lead = await this.getLeadById(listId, leadId);
      if (!lead) {
        throw new Error('Lead not found');
      }

      // Get existing engagements or initialize empty array
      const existingEngagements = (lead.engagements as Array<{ eventId?: string; eventType: string; eventData: any; createdAt: string }>) || [];

      // Find and remove the matching engagement by eventId
      const updatedEngagements = existingEngagements.filter((eng) => eng.eventId !== eventId);
      const isEngaged = updatedEngagements.some(engagementMatchesKeyword) ? 1 : 0;

      // Check if we actually removed something
      if (updatedEngagements.length === existingEngagements.length) {
        throw new Error('Engagement not found');
      }

      // Update the lead with the updated engagements array
      const params = {
        TableName: `${TABLE_PREFIX}AW-Leads`,
        Key: {
          listId,
          leadId,
        },
        UpdateExpression: 'SET engagements = :engagements, isEngaged = :isEngaged, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':engagements': updatedEngagements,
          ':isEngaged': isEngaged,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "deleteLeadEngagement");
      throw error;
    }
  },

  // API Key operations for lead forwarding
  async generateApiKeyForLeadList(listId: string) {
    try {
      // Generate a secure API key
      const crypto = require('crypto');
      const apiKey = `aw_${crypto.randomBytes(32).toString('hex')}`;

      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
        UpdateExpression: 'SET apiKey = :apiKey, apiKeyCreatedAt = :createdAt, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':apiKey': apiKey,
          ':createdAt': new Date().toISOString(),
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "generateApiKeyForLeadList");
      throw error;
    }
  },

  async getLeadListByApiKey(apiKey: string) {
    try {
      // We need to scan the table since apiKey is not a key
      // In production, consider creating a GSI on apiKey for better performance
      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        FilterExpression: 'apiKey = :apiKey',
        ExpressionAttributeValues: {
          ':apiKey': apiKey,
        },
      };

      const result = await dynamodb.scan(params).promise();
      return result.Items && result.Items.length > 0 ? result.Items[0] : null;
    } catch (error) {
      handleDynamoDbError(error, "getLeadListByApiKey");
      throw error;
    }
  },

  async deleteApiKeyForLeadList(listId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-LeadLists`,
        Key: {
          listId,
        },
        UpdateExpression: 'REMOVE apiKey, apiKeyCreatedAt SET updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "deleteApiKeyForLeadList");
      throw error;
    }
  },

  // ─── Enrichment History ───────────────────────────────────────────

  async createEnrichmentSnapshotItem(item: {
    jobId: string;
    leadId: string;
    previousStandardFields: Record<string, string | null>;
    previousCustomFields: Record<string, string | null>;
    previousEnrichmentMetadata: Record<string, any>;
    fieldsEnriched: Array<{ field: string; provider: string; fromCache: boolean }>;
    expiresAt: number;
  }): Promise<void> {
    try {
      await dynamodb.put({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        Item: {
          jobId: item.jobId,
          leadId: item.leadId,
          previousStandardFields: item.previousStandardFields,
          previousCustomFields: item.previousCustomFields,
          previousEnrichmentMetadata: item.previousEnrichmentMetadata,
          fieldsEnriched: item.fieldsEnriched,
          expiresAt: item.expiresAt,
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'createEnrichmentSnapshotItem');
      throw error;
    }
  },

  async createEnrichmentJobMeta(meta: {
    jobId: string;
    listId: string;
    userId: string;
    outputFields: string[];
    createdAt: string;
    status: 'completed' | 'undone';
    expiresAt: number;
    processedCount: number;
    failedCount?: number;
    skippedCount?: number;
    /** Lead IDs attempted in this run. Used for cross-run unique-lead dedup. Omitted when run exceeds 5000 leads. */
    attemptedLeadIds?: string[];
    /** True when attemptedLeadIds was omitted due to run size — dedup stats unavailable for this job. */
    leadsDeduplicationUnavailable?: boolean;
    /** Lead IDs skipped in this run. Used for cross-run unique skipped dedup. Omitted when skipped count exceeds 5000. */
    skippedLeadIds?: string[];
    /** True when skippedLeadIds was omitted due to size. */
    skippedDeduplicationUnavailable?: boolean;
    /** Aggregate counts per failure step (search/linkedin/llm/update). Item #11. */
    failureBreakdown?: { searchWebFailed: number; linkedinFailed: number; llmOrParseFailed: number; updateFailed: number };
    /** Per-lead failure records (capped to ~50 to keep row size bounded). Item #11. */
    failures?: Array<{ leadId: string; email?: string; step: string; message: string }>;
    /** Per-provider live vs cached counts across all leads in this run. */
    sourceBreakdown?: {
      apollo:    { live: number; cached: number };
      unipile:   { live: number; cached: number };
      enrichSo:  { live: number; cached: number };
      webSearch: { live: number; cached: number };
      sibling:   { live: number; cached: number };
      llm:       { live: number; cached: number };
    };
  }): Promise<void> {
    try {
      const item: any = {
        jobId: meta.jobId,
        leadId: '_meta',
        jobType: 'meta',
        listId: meta.listId,
        userId: meta.userId,
        outputFields: meta.outputFields,
        createdAt: meta.createdAt,
        status: meta.status,
        expiresAt: meta.expiresAt,
        processedCount: meta.processedCount,
      };
      if (meta.failedCount !== undefined) item.failedCount = meta.failedCount;
      if (meta.skippedCount !== undefined) item.skippedCount = meta.skippedCount;
      if (meta.attemptedLeadIds && meta.attemptedLeadIds.length > 0) item.attemptedLeadIds = meta.attemptedLeadIds;
      if (meta.leadsDeduplicationUnavailable) item.leadsDeduplicationUnavailable = true;
      if (meta.skippedLeadIds && meta.skippedLeadIds.length > 0) item.skippedLeadIds = meta.skippedLeadIds;
      if (meta.skippedDeduplicationUnavailable) item.skippedDeduplicationUnavailable = true;
      if (meta.failureBreakdown) item.failureBreakdown = meta.failureBreakdown;
      if (meta.failures && meta.failures.length > 0) {
        // Cap to 50 entries to stay well under DynamoDB's 400KB row limit
        item.failures = meta.failures.slice(0, 50);
      }
      if (meta.sourceBreakdown) item.sourceBreakdown = meta.sourceBreakdown;
      await dynamodb.put({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        Item: item,
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'createEnrichmentJobMeta');
      throw error;
    }
  },

  async updateEnrichmentJobStatus(jobId: string, status: 'completed' | 'undone'): Promise<void> {
    try {
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        Key: { jobId, leadId: '_meta' },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'updateEnrichmentJobStatus');
      throw error;
    }
  },

  async batchGetListNames(listIds: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(listIds)].filter(Boolean);
    if (!unique.length) return {};
    const CHUNK = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(chunk =>
      dynamodb.batchGet({
        RequestItems: {
          [`${TABLE_PREFIX}AW-LeadLists`]: {
            Keys: chunk.map(id => ({ listId: id })),
            ProjectionExpression: 'listId, #n',
            ExpressionAttributeNames: { '#n': 'name' },
          },
        },
      }).promise().then(r => r.Responses?.[`${TABLE_PREFIX}AW-LeadLists`] || [])
    ));
    return Object.fromEntries(results.flat().map((item: any) => [item.listId, item.name]));
  },

  parseEnrichmentNextToken(token: string): AWS.DynamoDB.DocumentClient.Key {
    try {
      return JSON.parse(Buffer.from(token, 'base64').toString());
    } catch {
      const err: any = new Error('Invalid pagination token');
      err.statusCode = 400;
      throw err;
    }
  },

  async getEnrichmentJobsByUserId(
    userId: string,
    startDate?: string,
    endDate?: string,
    pageSize = 50,
    nextToken?: string,
  ): Promise<{ jobs: any[]; nextToken?: string }> {
    try {
      const keyExpr = startDate && endDate
        ? 'userId = :userId AND createdAt BETWEEN :start AND :end'
        : 'userId = :userId';
      const exprValues: Record<string, string> = { ':userId': userId };
      if (startDate && endDate) {
        exprValues[':start'] = startDate;
        exprValues[':end'] = endDate;
      }
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        IndexName: 'userId-createdAt-index',
        KeyConditionExpression: keyExpr,
        ExpressionAttributeValues: exprValues,
        ScanIndexForward: false,
        Limit: pageSize,
        ...(nextToken ? { ExclusiveStartKey: this.parseEnrichmentNextToken(nextToken) } : {}),
      }).promise();
      const jobs = (result.Items || []).filter((item: any) => item.leadId === '_meta');
      const listNames = await this.batchGetListNames(jobs.map((j: any) => j.listId));
      const filtered = jobs.filter((j: any) => listNames[j.listId]).map((j: any) => ({ ...j, listName: listNames[j.listId] }));
      const newNextToken = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined;
      return { jobs: filtered, nextToken: newNextToken };
    } catch (error) {
      handleDynamoDbError(error, 'getEnrichmentJobsByUserId');
      throw error;
    }
  },

  // NOTE: forward-only — jobType='meta' is only written on rows created after this
  // attribute was introduced. The jobType-createdAt-index GSI is sparse, so pre-deploy
  // _meta rows are invisible to this query. No backfill was done because old rows lack
  // sourceBreakdown/processedCount aggregates and would show empty stats anyway.
  async getRecentEnrichmentJobs(
    startDate?: string,
    endDate?: string,
    pageSize = 50,
    nextToken?: string,
  ): Promise<{ jobs: any[]; nextToken?: string }> {
    try {
      const keyExpr = startDate && endDate
        ? 'jobType = :jobType AND createdAt BETWEEN :start AND :end'
        : 'jobType = :jobType';
      const exprValues: Record<string, string> = { ':jobType': 'meta' };
      if (startDate && endDate) {
        exprValues[':start'] = startDate;
        exprValues[':end'] = endDate;
      }
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        IndexName: 'jobType-createdAt-index',
        KeyConditionExpression: keyExpr,
        ExpressionAttributeValues: exprValues,
        ScanIndexForward: false,
        Limit: pageSize,
        ...(nextToken ? { ExclusiveStartKey: this.parseEnrichmentNextToken(nextToken) } : {}),
      }).promise();
      const jobs = result.Items || [];
      const listNames = await this.batchGetListNames(jobs.map((j: any) => j.listId));
      const filtered = jobs.filter((j: any) => listNames[j.listId]).map((j: any) => ({ ...j, listName: listNames[j.listId] }));
      const newNextToken = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined;
      return { jobs: filtered, nextToken: newNextToken };
    } catch (error) {
      handleDynamoDbError(error, 'getRecentEnrichmentJobs');
      throw error;
    }
  },

  async getEnrichmentJobsByListId(
    listId: string,
    startDate?: string,
    endDate?: string,
    pageSize = 20,
    nextToken?: string,
  ): Promise<{ jobs: any[]; nextToken?: string }> {
    try {
      const keyExpr = startDate && endDate
        ? 'listId = :listId AND createdAt BETWEEN :start AND :end'
        : 'listId = :listId';
      const exprValues: Record<string, string> = { ':listId': listId };
      if (startDate && endDate) {
        exprValues[':start'] = startDate;
        exprValues[':end'] = endDate;
      }
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        IndexName: 'listId-createdAt-index',
        KeyConditionExpression: keyExpr,
        ExpressionAttributeValues: exprValues,
        ScanIndexForward: false,
        Limit: pageSize,
        ...(nextToken ? { ExclusiveStartKey: this.parseEnrichmentNextToken(nextToken) } : {}),
      }).promise();
      const jobs = (result.Items || []).filter((item: any) => item.leadId === '_meta');
      const newNextToken = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined;
      return { jobs, nextToken: newNextToken };
    } catch (error) {
      handleDynamoDbError(error, 'getEnrichmentJobsByListId');
      throw error;
    }
  },

  async getEnrichmentJobMeta(jobId: string): Promise<any | null> {
    try {
      const result = await dynamodb.get({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        Key: { jobId, leadId: '_meta' },
      }).promise();
      return result.Item ?? null;
    } catch (error) {
      handleDynamoDbError(error, 'getEnrichmentJobMeta');
      throw error;
    }
  },

  async getEnrichmentSnapshotsByJobId(jobId: string, limit = 200): Promise<any[]> {
    try {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: { ':jobId': jobId },
        Limit: limit + 1, // +1 to account for the _meta row
      }).promise();
      return (result.Items || []).filter((item: any) => item.leadId !== '_meta').slice(0, limit);
    } catch (error) {
      handleDynamoDbError(error, 'getEnrichmentSnapshotsByJobId');
      throw error;
    }
  },

  // ─── Enrichment Raw Cache ─────────────────────────────────────────────

  async getEnrichmentCacheItem(canonicalId: string, fieldGroup: string): Promise<any | null> {
    try {
      const result = await dynamodb.get({
        TableName: `${TABLE_PREFIX}AW-EnrichmentRawCache`,
        Key: { canonicalId, fieldGroup },
      }).promise();
      return result.Item ?? null;
    } catch (error) {
      handleDynamoDbError(error, 'getEnrichmentCacheItem');
      throw error;
    }
  },

  async putEnrichmentCacheItem(item: {
    canonicalId: string;
    fieldGroup: string;
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    rawData: any;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
    fetchedAt: string;
    expiresAt: number;
    // Required discriminator. Forces every caller to declare which producer
    // owns this row, so a future caller cannot silently mislabel an enrich.so
    // row as a field-group row (or vice versa). Note: this used to be optional
    // with a 'field_group' default — review C1 flagged that as fragile.
    cacheType: 'field_group' | 'enrichso' | 'unipile' | 'unipile_company' | 'unipile_search_param' | 'apollo';
    // Marks a cached payload with no usable signal — written with a short
    // negative TTL so it doesn't lock a lead out of re-enrichment. (WS4)
    negative?: boolean;
  }, opts?: { force?: boolean }): Promise<void> {
    try {
      // `force: true` is set by callers that explicitly asked for a fresh API
      // hit (forceRefresh=true). Without dropping the ConditionExpression,
      // those callers would burn API credits but the existing non-expired
      // row would silently win and stay stale.
      const params: any = {
        TableName: `${TABLE_PREFIX}AW-EnrichmentRawCache`,
        Item: item,
      };
      if (!opts?.force) {
        // Only insert if item doesn't exist OR is already expired.
        // Prevents race when multiple clients simultaneously miss the same cache entry.
        params.ConditionExpression = 'attribute_not_exists(canonicalId) OR expiresAt < :now';
        params.ExpressionAttributeValues = { ':now': Math.floor(Date.now() / 1000) };
      }
      await dynamodb.put(params).promise();
    } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') return;  // another worker won the race
      handleDynamoDbError(error, 'putEnrichmentCacheItem');
      throw error;
    }
  },

  /**
   * Targeted write for the email-validation result that avoids clobbering
   * concurrent customFields edits.
   *
   * The standard `updateLead({customFields: {...}})` path does a full SET on
   * `customFields`, so a read-modify-write race against a parallel user edit
   * can lose the user's change. This uses DDB document-path syntax to update
   * only the two leaf keys, which DDB applies atomically without touching
   * sibling keys.
   *
   * Cold-start fallback: if `enrichmentMetadata` doesn't exist on the lead
   * yet (it's lazily created), the path SET fails with ValidationException.
   * We then bootstrap the parent map and retry.
   */
  async setLeadEmailValidation(
    listId: string,
    leadId: string,
    validation: Record<string, any>,
    metadata: Record<string, any>,
  ): Promise<void> {
    const tableName = `${TABLE_PREFIX}AW-Leads`;
    const params: any = {
      TableName: tableName,
      Key: { listId, leadId },
      UpdateExpression:
        'SET customFields.email_validation = :v, ' +
        'enrichmentMetadata.email_validation = :m, ' +
        'updatedAt = :ts',
      ExpressionAttributeValues: {
        ':v': validation,
        ':m': metadata,
        ':ts': new Date().toISOString(),
      },
      // Don't auto-create the lead if it disappeared between create and validation.
      ConditionExpression: 'attribute_exists(leadId)',
    };
    try {
      await dynamodb.update(params).promise();
      return;
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return;  // lead deleted
      // ValidationException fires when `enrichmentMetadata` doesn't exist as a map.
      if (err.code !== 'ValidationException') {
        handleDynamoDbError(err, 'setLeadEmailValidation');
        throw err;
      }
    }
    // Bootstrap missing parent maps, then retry.
    try {
      await dynamodb.update({
        TableName: tableName,
        Key: { listId, leadId },
        UpdateExpression:
          'SET customFields = if_not_exists(customFields, :emptyMap), ' +
          'enrichmentMetadata = if_not_exists(enrichmentMetadata, :emptyMap)',
        ExpressionAttributeValues: { ':emptyMap': {} },
        ConditionExpression: 'attribute_exists(leadId)',
      }).promise();
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return;
      handleDynamoDbError(err, 'setLeadEmailValidation:bootstrap');
      throw err;
    }
    try {
      await dynamodb.update(params).promise();
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return;
      handleDynamoDbError(err, 'setLeadEmailValidation:retry');
      throw err;
    }
  },

  /**
   * Conditional email-fill used by the Apollo waterfall webhook (and any other
   * path where a parallel writer might have filled the email between the read
   * and the write). The condition `attribute_not_exists(email)` ensures we
   * never overwrite an email that landed via Tier 1/2/4 in the meantime.
   *
   * Returns:
   *   { written: true }  — the conditional update applied
   *   { written: false } — the lead already has an email (no overwrite)
   */
  async setLeadEmailIfMissing(
    listId: string,
    leadId: string,
    email: string,
    enrichmentEmailMeta: Record<string, any>,
  ): Promise<{ written: boolean }> {
    const tableName = `${TABLE_PREFIX}AW-Leads`;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return { written: false };

    const params: any = {
      TableName: tableName,
      Key: { listId, leadId },
      UpdateExpression:
        'SET email = :email, ' +
        'enrichmentMetadata.email = :meta, ' +
        'updatedAt = :ts',
      ExpressionAttributeValues: {
        ':email': normalizedEmail,
        ':meta': enrichmentEmailMeta,
        ':ts': new Date().toISOString(),
      },
      // Two guards:
      //   1. attribute_exists(leadId) — don't auto-create a deleted lead
      //   2. attribute_not_exists(email) — TOCTOU protection against parallel fills
      ConditionExpression: 'attribute_exists(leadId) AND attribute_not_exists(email)',
    };
    try {
      await dynamodb.update(params).promise();
      return { written: true };
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return { written: false };
      // ValidationException → enrichmentMetadata map doesn't exist yet.
      if (err.code !== 'ValidationException') {
        handleDynamoDbError(err, 'setLeadEmailIfMissing');
        throw err;
      }
    }
    // Bootstrap missing parent map, then retry.
    try {
      await dynamodb.update({
        TableName: tableName,
        Key: { listId, leadId },
        UpdateExpression: 'SET enrichmentMetadata = if_not_exists(enrichmentMetadata, :emptyMap)',
        ExpressionAttributeValues: { ':emptyMap': {} },
        ConditionExpression: 'attribute_exists(leadId)',
      }).promise();
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return { written: false };
      handleDynamoDbError(err, 'setLeadEmailIfMissing:bootstrap');
      throw err;
    }
    try {
      await dynamodb.update(params).promise();
      return { written: true };
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return { written: false };
      handleDynamoDbError(err, 'setLeadEmailIfMissing:retry');
      throw err;
    }
  },

  /**
   * Atomic targeted write for bulk enrichment background jobs.
   *
   * Writes top-level scalar fields, enrichmentMetadata sub-keys, and
   * customFields sub-keys in a single DDB UpdateExpression so concurrent
   * jobs writing different keys never clobber each other (unlike the full-map
   * SET that updateLead uses for enrichmentMetadata/customFields).
   *
   * Step 1 bootstraps missing parent maps with if_not_exists so document-path
   * SETs in step 2 never hit ValidationException on cold leads.
   */
  async setLeadFields(
    listId: string,
    leadId: string,
    options: {
      topLevel?: Record<string, string>;
      enrichmentMetadata?: Record<string, any>;
      customFields?: Record<string, string>;
      removeEnrichmentMetadataKeys?: string[];
      removeCustomFieldKeys?: string[];
      /** When true, all SET clauses use if_not_exists() — atomically skips any
       *  field already present in the DB. Use for bulk enrichment paths that
       *  must never overwrite user-entered or concurrently-written data. */
      ifNotExists?: boolean;
    },
  ): Promise<void> {
    const tableName = `${TABLE_PREFIX}AW-Leads`;
    const key = { listId, leadId };
    const safeCustomFields = options.customFields === undefined
      ? undefined
      : sanitizeCustomFields(options.customFields, { source: 'db.setLeadFields', listId, leadId });
    const hasMetaKeys = Object.keys(options.enrichmentMetadata ?? {}).length > 0;
    const hasCustomKeys = Object.keys(safeCustomFields ?? {}).length > 0;
    const hasTopLevel = Object.keys(options.topLevel ?? {}).length > 0;
    const hasRemoveMeta = (options.removeEnrichmentMetadataKeys ?? []).length > 0;
    const hasRemoveCustom = (options.removeCustomFieldKeys ?? []).length > 0;
    if (!hasTopLevel && !hasMetaKeys && !hasCustomKeys && !hasRemoveMeta && !hasRemoveCustom) return;

    // Step 1: ensure parent maps exist so document-path SETs/REMOVEs don't throw.
    // REMOVE on a nested path (e.g. customFields.key) also requires the parent
    // map to exist — bootstrap whenever we touch either map at all.
    if (hasMetaKeys || hasCustomKeys || hasRemoveMeta || hasRemoveCustom) {
      try {
        await dynamodb.update({
          TableName: tableName,
          Key: key,
          UpdateExpression:
            'SET customFields = if_not_exists(customFields, :emptyMap), ' +
            'enrichmentMetadata = if_not_exists(enrichmentMetadata, :emptyMap)',
          ExpressionAttributeValues: { ':emptyMap': {} },
          ConditionExpression: 'attribute_exists(leadId)',
        }).promise();
      } catch (err: any) {
        if (err.code === 'ConditionalCheckFailedException') return;
        handleDynamoDbError(err, 'setLeadFields:bootstrap');
        throw err;
      }
    }

    // Step 2: build one combined expression — top-level, enrichmentMetadata
    // sub-keys, and customFields sub-keys all in a single DDB round-trip.
    const setClauses: string[] = ['updatedAt = :ts'];
    const removeClauses: string[] = [];
    const attrNames: Record<string, string> = {};
    const attrValues: Record<string, any> = { ':ts': new Date().toISOString() };

    const ine = options.ifNotExists ?? false;
    const topLevelChangesNameOrCompany =
      options.topLevel && (
        'firstName' in options.topLevel ||
        'lastName' in options.topLevel ||
        'company' in options.topLevel
      );
    for (const [k, v] of Object.entries(options.topLevel ?? {})) {
      attrValues[`:tl_${k}`] = v;
      setClauses.push(ine ? `${k} = if_not_exists(${k}, :tl_${k})` : `${k} = :tl_${k}`);
    }

    // Recompute nameCompanyKey when firstName/lastName/company is in topLevel.
    // With ifNotExists=true the actual top-level SET is skipped for any field
    // the lead already has — we mirror that here: when the lead has an existing
    // value for a field, the merged key uses the EXISTING value, not the
    // proposed one. This keeps the key in sync with the actual stored values.
    if (topLevelChangesNameOrCompany) {
      const current = await this.getLeadById(listId, leadId) as any;
      const tl = options.topLevel!;
      const pickField = (field: 'firstName' | 'lastName' | 'company'): string => {
        const proposedVal = field in tl ? String(tl[field] ?? '') : '';
        const existingVal = current?.[field] ? String(current[field]) : '';
        if (ine) return existingVal || proposedVal;
        return field in tl ? proposedVal : existingVal;
      };
      const nck = computeNameCompanyKey(pickField('firstName'), pickField('lastName'), pickField('company'));
      if (nck) {
        attrValues[':nck'] = nck;
        setClauses.push(ine ? `nameCompanyKey = if_not_exists(nameCompanyKey, :nck)` : `nameCompanyKey = :nck`);
      } else {
        removeClauses.push('nameCompanyKey');
      }
    }

    let idx = 0;
    for (const [k, v] of Object.entries(options.enrichmentMetadata ?? {})) {
      attrNames[`#em${idx}`] = k;
      attrValues[`:em${idx}`] = v;
      setClauses.push(ine
        ? `enrichmentMetadata.#em${idx} = if_not_exists(enrichmentMetadata.#em${idx}, :em${idx})`
        : `enrichmentMetadata.#em${idx} = :em${idx}`);
      idx++;
    }

    idx = 0;
    for (const [k, v] of Object.entries(safeCustomFields ?? {})) {
      attrNames[`#cf${idx}`] = k;
      attrValues[`:cf${idx}`] = v;
      setClauses.push(ine
        ? `customFields.#cf${idx} = if_not_exists(customFields.#cf${idx}, :cf${idx})`
        : `customFields.#cf${idx} = :cf${idx}`);
      idx++;
    }

    let rmIdx = 0;
    for (const k of options.removeEnrichmentMetadataKeys ?? []) {
      attrNames[`#rmem${rmIdx}`] = k;
      removeClauses.push(`enrichmentMetadata.#rmem${rmIdx}`);
      rmIdx++;
    }

    rmIdx = 0;
    for (const k of options.removeCustomFieldKeys ?? []) {
      attrNames[`#rmcf${rmIdx}`] = k;
      removeClauses.push(`customFields.#rmcf${rmIdx}`);
      rmIdx++;
    }

    let updateExpr = 'SET ' + setClauses.join(', ');
    if (removeClauses.length > 0) updateExpr += ' REMOVE ' + removeClauses.join(', ');

    const params: any = {
      TableName: tableName,
      Key: key,
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: attrValues,
      ConditionExpression: 'attribute_exists(leadId)',
    };
    if (Object.keys(attrNames).length > 0) params.ExpressionAttributeNames = attrNames;

    try {
      await dynamodb.update(params).promise();
    } catch (err: any) {
      if (err.code === 'ConditionalCheckFailedException') return;
      handleDynamoDbError(err, 'setLeadFields');
      throw err;
    }

    // Keep the parent list's fieldNames in sync. Without this, enrichment
    // writes customFields.X on the lead, the Configure Display Fields dialog
    // (which reads list.fieldNames) doesn't see X, and the user thinks the
    // enriched field "disappeared."
    //
    // We only call mergeFieldNames for TRULY-NEW keys — appending a key that
    // already exists with DDB's list_append leaves a duplicate behind. Each
    // per-lead enrichment otherwise spam-appends the same shared key (e.g.
    // "website") once per lead, leaving N copies after a list-wide run.
    // Read-then-conditional-write does have a small race window (two
    // concurrent writers seeing the same "missing" key both append once),
    // but getLeadListById dedupes on read so the UI never shows the dup.
    if (hasCustomKeys) {
      try {
        const newKeys = Object.keys(options.customFields!);
        const list = await this.getLeadListById(listId);
        const existing = new Set((list?.fieldNames as string[] | undefined) ?? []);
        const trulyNew = newKeys.filter(k => !existing.has(k));
        if (trulyNew.length > 0) {
          await this.mergeFieldNames(listId, trulyNew);
        }
      } catch (err) {
        // Field-name sync is best-effort — the lead write already succeeded.
        // Logging keeps the failure visible without failing the caller.
        // eslint-disable-next-line no-console
        console.warn('[setLeadFields] fieldNames sync failed:', (err as Error).message);
      }
    }
  },

  async deleteEnrichmentCacheByEntityKey(entityKey: string): Promise<void> {
    try {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-EnrichmentRawCache`,
        IndexName: 'entityKey-fieldGroup-index',
        KeyConditionExpression: 'entityKey = :ek',
        ExpressionAttributeValues: { ':ek': entityKey },
      }).promise();

      for (const item of result.Items ?? []) {
        await dynamodb.delete({
          TableName: `${TABLE_PREFIX}AW-EnrichmentRawCache`,
          Key: { canonicalId: item.canonicalId, fieldGroup: item.fieldGroup },
        }).promise();
      }
    } catch (error) {
      handleDynamoDbError(error, 'deleteEnrichmentCacheByEntityKey');
      throw error;
    }
  },
};

// ─── Account Memory ───────────────────────────────────────────────

const VALID_MEMORY_CATEGORIES = ['preference', 'history', 'insight', 'workflow'] as const;
type MemoryCategory = typeof VALID_MEMORY_CATEGORIES[number];

const ACCOUNT_MEMORY_TABLE = `${TABLE_PREFIX}AW-AccountMemory`;
const ORG_MEMORY_TABLE = `${TABLE_PREFIX}AW-OrgMemory`;

// Browser Cookies table
const BROWSER_COOKIES_TABLE = `${TABLE_PREFIX}AW-BrowserCookies`;

export const browserCookieDb = {
  async saveCookies(userId: string, cookies: any[]): Promise<void> {
    const now = new Date().toISOString();
    try {
      await dynamodb.put({
        TableName: BROWSER_COOKIES_TABLE,
        Item: {
          userId,
          domain: '__all__',
          cookies,
          updatedAt: now,
          createdAt: now,
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'saveBrowserCookies');
      throw error;
    }
  },

  async getCookies(userId: string): Promise<any[] | null> {
    try {
      const result = await dynamodb.get({
        TableName: BROWSER_COOKIES_TABLE,
        Key: { userId, domain: '__all__' },
      }).promise();
      return result.Item?.cookies || null;
    } catch (error) {
      handleDynamoDbError(error, 'getBrowserCookies');
      throw error;
    }
  },

  async deleteAllCookies(userId: string): Promise<void> {
    try {
      await dynamodb.delete({
        TableName: BROWSER_COOKIES_TABLE,
        Key: { userId, domain: '__all__' },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'deleteAllBrowserCookies');
      throw error;
    }
  },

  /**
   * Save a manually-imported (e.g. pasted from DevTools) cookie set for a specific
   * domain, distinct from the auto-persisted '__all__' blob. Caller is responsible
   * for normalizing `domain` (lowercase) before calling. Encrypted at rest — unlike
   * the auto-persisted blob, this is a user-supplied, already-authenticated bearer
   * credential.
   */
  async saveDomainCookies(userId: string, domain: string, cookies: any[]): Promise<void> {
    const now = new Date().toISOString();
    // Cookies from one parseCookieHeader() call all share the same synthetic expiry,
    // but take the earliest present (defensive, e.g. if callers ever mix sources) as
    // the honest floor: once ANY cookie in the set is past this, injection is a no-op
    // anyway, so surface/exclude the whole entry rather than silently keep using it.
    const expirySeconds = cookies
      .map((c) => c.expires)
      .filter((e): e is number => typeof e === 'number');
    const expiresAt = expirySeconds.length > 0
      ? new Date(Math.min(...expirySeconds) * 1000).toISOString()
      : undefined;

    try {
      await dynamodb.put({
        TableName: BROWSER_COOKIES_TABLE,
        Item: {
          userId,
          domain,
          encryptedCookies: encryptPassword(JSON.stringify(cookies), userId),
          cookieCount: cookies.length,
          ...(expiresAt ? { expiresAt } : {}),
          updatedAt: now,
          createdAt: now,
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'saveDomainBrowserCookies');
      throw error;
    }
  },

  /** List manually-imported cookie domains for a user — metadata only, never the encrypted values. */
  async listDomainCookies(userId: string): Promise<Array<{ domain: string; cookieCount: number; createdAt: string; expiresAt?: string; lastFailedAt?: string }>> {
    try {
      const items = await paginatedQuery(dynamodb, {
        TableName: BROWSER_COOKIES_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      });

      return items
        .filter((item) => item.domain !== '__all__')
        .map((item) => ({
          domain: item.domain,
          cookieCount: item.cookieCount ?? 0,
          createdAt: item.createdAt,
          ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
          ...(item.lastFailedAt ? { lastFailedAt: item.lastFailedAt } : {}),
        }));
    } catch (error) {
      handleDynamoDbError(error, 'listDomainBrowserCookies');
      throw error;
    }
  },

  /**
   * Records that a manually-imported session for a domain failed to authenticate
   * mid-task (e.g. the site still showed a signin page after load_browser_cookies
   * injected it — the session died server-side before its synthetic expiresAt
   * floor was reached). Called by Emma's mark_browser_session_failed tool so the
   * failure is visible in Settings on the user's next visit instead of silently
   * recurring on every future run. A fresh re-import (saveDomainCookies) fully
   * overwrites the item, clearing this automatically.
   *
   * Best-effort: this is an observability signal, not a critical write. If the
   * domain was deleted out from under it (condition fails) or the update
   * otherwise errors, it's logged and swallowed rather than thrown — a failed
   * "mark as failed" call must never break the automation task that reported it.
   */
  async markDomainCookiesFailed(userId: string, domain: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: BROWSER_COOKIES_TABLE,
        Key: { userId, domain },
        ConditionExpression: 'attribute_exists(userId)',
        UpdateExpression: 'SET lastFailedAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }).promise();
    } catch (error) {
      console.warn(`Failed to mark browser cookies as failed for domain "${domain}" (userId: ${userId}):`, error);
    }
  },

  async deleteDomainCookies(userId: string, domain: string): Promise<void> {
    try {
      await dynamodb.delete({
        TableName: BROWSER_COOKIES_TABLE,
        Key: { userId, domain },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'deleteDomainBrowserCookies');
      throw error;
    }
  },

  /**
   * Combined cookie set for browser-automation injection: the auto-persisted
   * '__all__' blob followed by every manually-imported per-domain entry. Order
   * matters — per-domain (deliberately human-provided) cookies are appended AFTER
   * '__all__' so they take precedence for the same site when Playwright's
   * addCookies dedups by name/domain/path (empirically verified: last entry in
   * the array wins). A per-domain entry past its `expiresAt` floor is skipped —
   * injecting it would be a guaranteed no-op, so don't waste the attempt. A
   * corrupted/undecryptable entry is likewise logged and skipped rather than
   * failing the whole load.
   *
   * Defense in depth: the read path changed from a single get() to a query()
   * to support per-domain entries, but the overwhelming majority of users
   * have never touched that feature. If the query itself fails outright
   * (throttling, a bug in this new path, etc.), fall back to the old,
   * narrower get()-based read for '__all__' — the one nearly every user's
   * automation actually depends on — rather than failing their whole task
   * because of a code path they never opted into. If THAT also fails, the
   * error is a real, visible infra problem and is allowed to propagate
   * rather than being swallowed as a silent "no cookies saved".
   */
  async getAllCookiesForUser(userId: string): Promise<any[]> {
    try {
      const items = await paginatedQuery(dynamodb, {
        TableName: BROWSER_COOKIES_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      });

      const allItem = items.find((item) => item.domain === '__all__');
      const combined: any[] = [...(allItem?.cookies || [])];
      const now = Date.now();

      for (const item of items) {
        if (item.domain === '__all__') continue;

        if (item.expiresAt && new Date(item.expiresAt).getTime() <= now) {
          console.warn(`Skipping expired manually-imported browser cookies for domain "${item.domain}" (userId: ${userId}, expiresAt: ${item.expiresAt})`);
          continue;
        }

        try {
          const { password: cookiesJson } = decryptPassword(item.encryptedCookies);
          combined.push(...JSON.parse(cookiesJson));
        } catch (error) {
          console.error(`Failed to decrypt/parse browser cookies for domain "${item.domain}" (userId: ${userId}):`, error);
        }
      }

      return combined;
    } catch (queryError) {
      console.warn(`getAllCookiesForUser query failed for userId ${userId}, falling back to get()-based getCookies:`, queryError);
      try {
        const fallbackCookies = await browserCookieDb.getCookies(userId);
        return fallbackCookies || [];
      } catch (fallbackError) {
        handleDynamoDbError(fallbackError, 'getAllBrowserCookiesForUser');
        throw fallbackError;
      }
    }
  },
};

export const accountMemoryDb = {
  async addMemory(
    userId: string,
    category: string,
    content: string,
    sourceSessionId?: string,
    embedding?: number[]
  ) {
    if (!VALID_MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
      throw new Error(`Invalid category: ${category}. Must be one of: ${VALID_MEMORY_CATEGORIES.join(', ')}`);
    }
    if (!content || content.trim().length === 0) {
      throw new Error('Content is required');
    }
    if (content.length > 2000) {
      throw new Error('Content must be 2000 characters or less');
    }

    const { ulid } = await import('ulid');
    const now = new Date().toISOString();
    const item: Record<string, any> = {
      userId,
      memoryId: ulid(),
      category,
      content: content.trim(),
      createdAt: now,
      updatedAt: now,
    };
    if (sourceSessionId) {
      item.sourceSessionId = sourceSessionId;
    }
    // Persisted so memory can later be retrieved by semantic relevance, not just recency.
    if (embedding && embedding.length > 0) {
      item.embedding = embedding;
    }

    try {
      await dynamodb.put({ TableName: ACCOUNT_MEMORY_TABLE, Item: item }).promise();
      return item;
    } catch (error) {
      handleDynamoDbError(error, 'addMemory');
      throw error;
    }
  },

  async getUserMemories(userId: string, category?: string, limit?: number) {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = category
        ? {
          TableName: ACCOUNT_MEMORY_TABLE,
          IndexName: 'UserIdCategoryIndex',
          KeyConditionExpression: 'userId = :userId AND category = :category',
          ExpressionAttributeValues: { ':userId': userId, ':category': category },
          ...(limit ? { Limit: limit } : {}),
        }
        : {
          TableName: ACCOUNT_MEMORY_TABLE,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
          ...(limit ? { Limit: limit } : {}),
        };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getUserMemories');
      throw error;
    }
  },

  async getRecentMemories(userId: string, limit: number = 20) {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: ACCOUNT_MEMORY_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false,
        Limit: limit,
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getRecentMemories');
      throw error;
    }
  },

  // Backfill an embedding onto an existing memory (e.g. one written before embeddings
  // existed), so relevance retrieval pays the embedding cost at most once per memory.
  async setMemoryEmbedding(userId: string, memoryId: string, embedding: number[]) {
    try {
      await dynamodb.update({
        TableName: ACCOUNT_MEMORY_TABLE,
        Key: { userId, memoryId },
        UpdateExpression: 'SET embedding = :e',
        ExpressionAttributeValues: { ':e': embedding },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'setMemoryEmbedding');
      throw error;
    }
  },

  async updateMemory(
    userId: string,
    memoryId: string,
    updates: { content?: string; category?: string }
  ) {
    if (updates.category && !VALID_MEMORY_CATEGORIES.includes(updates.category as MemoryCategory)) {
      throw new Error(`Invalid category: ${updates.category}. Must be one of: ${VALID_MEMORY_CATEGORIES.join(', ')}`);
    }
    if (updates.content !== undefined && updates.content.trim().length === 0) {
      throw new Error('Content cannot be empty');
    }
    if (updates.content !== undefined && updates.content.length > 2000) {
      throw new Error('Content must be 2000 characters or less');
    }

    const expressions: string[] = ['#updatedAt = :updatedAt'];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };

    if (updates.content !== undefined) {
      expressions.push('#content = :content');
      names['#content'] = 'content';
      values[':content'] = updates.content.trim();
    }
    if (updates.category) {
      expressions.push('#category = :category');
      names['#category'] = 'category';
      values[':category'] = updates.category;
    }

    try {
      const result = await dynamodb.update({
        TableName: ACCOUNT_MEMORY_TABLE,
        Key: { userId, memoryId },
        UpdateExpression: `SET ${expressions.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, 'updateMemory');
      throw error;
    }
  },

  async deleteMemory(userId: string, memoryId: string) {
    try {
      await dynamodb.delete({
        TableName: ACCOUNT_MEMORY_TABLE,
        Key: { userId, memoryId },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'deleteMemory');
      throw error;
    }
  },
};

// ─── Org Memory ───────────────────────────────────────────────

export const orgMemoryDb = {
  async addMemory(
    orgId: string,
    category: string,
    content: string,
    sourceUserId?: string,
    embedding?: number[]
  ) {
    if (!VALID_MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
      throw new Error(`Invalid category: ${category}. Must be one of: ${VALID_MEMORY_CATEGORIES.join(', ')}`);
    }
    if (!content || content.trim().length === 0) {
      throw new Error('Content is required');
    }
    if (content.length > 2000) {
      throw new Error('Content must be 2000 characters or less');
    }

    const { ulid } = await import('ulid');
    const now = new Date().toISOString();
    const item: Record<string, any> = {
      orgId,
      memoryId: ulid(),
      category,
      content: content.trim(),
      createdAt: now,
      updatedAt: now,
    };
    if (sourceUserId) {
      item.sourceUserId = sourceUserId;
    }
    // Persisted so org memory can later be retrieved by semantic relevance, not just recency.
    if (embedding && embedding.length > 0) {
      item.embedding = embedding;
    }

    try {
      await dynamodb.put({ TableName: ORG_MEMORY_TABLE, Item: item }).promise();
      return item;
    } catch (error) {
      handleDynamoDbError(error, 'addOrgMemory');
      throw error;
    }
  },

  async getOrgMemories(orgId: string, category?: string, limit?: number) {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = category
        ? {
          TableName: ORG_MEMORY_TABLE,
          IndexName: 'OrgIdCategoryIndex',
          KeyConditionExpression: 'orgId = :orgId AND category = :category',
          ExpressionAttributeValues: { ':orgId': orgId, ':category': category },
          ...(limit ? { Limit: limit } : {}),
        }
        : {
          TableName: ORG_MEMORY_TABLE,
          KeyConditionExpression: 'orgId = :orgId',
          ExpressionAttributeValues: { ':orgId': orgId },
          ...(limit ? { Limit: limit } : {}),
        };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getOrgMemories');
      throw error;
    }
  },

  async getRecentOrgMemories(orgId: string, limit: number = 20) {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: ORG_MEMORY_TABLE,
        KeyConditionExpression: 'orgId = :orgId',
        ExpressionAttributeValues: { ':orgId': orgId },
        ScanIndexForward: false,
        Limit: limit,
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getRecentOrgMemories');
      throw error;
    }
  },

  // Backfill an embedding onto an existing org memory (see accountMemoryDb.setMemoryEmbedding).
  async setMemoryEmbedding(orgId: string, memoryId: string, embedding: number[]) {
    try {
      await dynamodb.update({
        TableName: ORG_MEMORY_TABLE,
        Key: { orgId, memoryId },
        UpdateExpression: 'SET embedding = :e',
        ExpressionAttributeValues: { ':e': embedding },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'setMemoryEmbedding');
      throw error;
    }
  },

  async updateMemory(
    orgId: string,
    memoryId: string,
    updates: { content?: string; category?: string }
  ) {
    if (updates.category && !VALID_MEMORY_CATEGORIES.includes(updates.category as MemoryCategory)) {
      throw new Error(`Invalid category: ${updates.category}. Must be one of: ${VALID_MEMORY_CATEGORIES.join(', ')}`);
    }
    if (updates.content !== undefined && updates.content.trim().length === 0) {
      throw new Error('Content cannot be empty');
    }
    if (updates.content !== undefined && updates.content.length > 2000) {
      throw new Error('Content must be 2000 characters or less');
    }

    const expressions: string[] = ['#updatedAt = :updatedAt'];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };

    if (updates.content !== undefined) {
      expressions.push('#content = :content');
      names['#content'] = 'content';
      values[':content'] = updates.content.trim();
    }
    if (updates.category) {
      expressions.push('#category = :category');
      names['#category'] = 'category';
      values[':category'] = updates.category;
    }

    try {
      const result = await dynamodb.update({
        TableName: ORG_MEMORY_TABLE,
        Key: { orgId, memoryId },
        UpdateExpression: `SET ${expressions.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, 'updateOrgMemory');
      throw error;
    }
  },

  async deleteMemory(orgId: string, memoryId: string) {
    try {
      await dynamodb.delete({
        TableName: ORG_MEMORY_TABLE,
        Key: { orgId, memoryId },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'deleteOrgMemory');
      throw error;
    }
  },
};

const SOCIAL_ENGAGEMENT_MAX_RETRIES = 3;

export const socialEngagementTrackingDb = {
  async recordEngagement(tracker: {
    userId: string;
    postId: string;
    commentId?: string;        // comment URN for auto-reply actions; undefined for post engagement
    platform: string;
    ownerAccountId: string;
    engagingAccountId: string;
    actionType: string;
    scheduleId: string;
    status: 'queued' | 'completed' | 'failed';
    executedAt?: string;
    generatedText?: string;    // generated comment or reply text
    reactionType?: string;     // LLM-selected reaction type
  }): Promise<boolean> {
    try {
      const dedupId = tracker.commentId || tracker.postId;
      // Legacy compound types keep the old key format (no action suffix) for backward compat.
      // New atomic types include the action type so like and reply can coexist on the same comment.
      const isLegacyCompound = tracker.actionType === 'like_and_reply_comment' || tracker.actionType === 'comment_and_like';
      const key = isLegacyCompound
        ? `${dedupId}#${tracker.engagingAccountId}`
        : `${dedupId}#${tracker.engagingAccountId}#${tracker.actionType}`;

      if (tracker.status === 'failed') {
        // Use UPDATE + ADD to atomically increment failCount instead of overwriting it
        const setFields: string[] = [
          '#status = :status', '#platform = :platform',
          'ownerAccountId = :ownerAccountId', 'actionType = :actionType', 'scheduleId = :scheduleId',
        ];
        const exprValues: Record<string, any> = {
          ':status': 'failed',
          ':platform': tracker.platform,
          ':ownerAccountId': tracker.ownerAccountId,
          ':actionType': tracker.actionType,
          ':scheduleId': tracker.scheduleId,
          ':one': 1,
        };
        if (tracker.executedAt) { setFields.push('executedAt = :executedAt'); exprValues[':executedAt'] = tracker.executedAt; }
        if (tracker.generatedText) { setFields.push('generatedText = :generatedText'); exprValues[':generatedText'] = tracker.generatedText; }
        if (tracker.reactionType) { setFields.push('reactionType = :reactionType'); exprValues[':reactionType'] = tracker.reactionType; }

        await dynamodb.update({
          TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
          Key: { userId: tracker.userId, postId_engagingAccountId: key },
          UpdateExpression: `SET ${setFields.join(', ')} ADD failCount :one`,
          ExpressionAttributeNames: { '#status': 'status', '#platform': 'platform' },
          ExpressionAttributeValues: exprValues,
        }).promise();
      } else if (tracker.status === 'queued') {
        // Use conditional UPDATE so failCount is preserved across retries (a plain PUT
        // would reset failCount to 0, breaking the 3-retry cap), and so concurrent
        // scanner instances on multiple EB hosts cannot both claim the same slot.
        //
        // Condition: only write if the item doesn't exist yet (first scheduling) OR if
        // it's a retryable failed item (status=failed AND failCount < maxRetries).
        // If another instance already wrote a queued/completed record, return false so
        // the caller skips schedule creation — preventing duplicate replies.
        const executedAt = tracker.executedAt ?? new Date().toISOString();
        const setFields = [
          '#status = :status', '#platform = :platform',
          'ownerAccountId = :ownerAccountId', 'actionType = :actionType',
          'scheduleId = :scheduleId', 'createdAt = :createdAt', 'executedAt = :executedAt',
        ];
        const exprValues: Record<string, any> = {
          ':status': 'queued',
          ':platform': tracker.platform,
          ':ownerAccountId': tracker.ownerAccountId,
          ':actionType': tracker.actionType,
          ':scheduleId': tracker.scheduleId,
          ':createdAt': new Date().toISOString(),
          ':executedAt': executedAt,
          ':failed': 'failed',
          ':maxRetries': SOCIAL_ENGAGEMENT_MAX_RETRIES,
        };
        if (tracker.commentId) { setFields.push('commentId = :commentId'); exprValues[':commentId'] = tracker.commentId; }
        if (tracker.postId) { setFields.push('postId = :postId'); exprValues[':postId'] = tracker.postId; }
        try {
          await dynamodb.update({
            TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
            Key: { userId: tracker.userId, postId_engagingAccountId: key },
            UpdateExpression: `SET ${setFields.join(', ')}`,
            ConditionExpression: 'attribute_not_exists(postId_engagingAccountId) OR (#status = :failed AND failCount < :maxRetries)',
            ExpressionAttributeNames: { '#status': 'status', '#platform': 'platform' },
            ExpressionAttributeValues: exprValues,
          }).promise();
        } catch (condErr: any) {
          if (condErr.code === 'ConditionalCheckFailedException') {
            // Item already exists as queued/completed (or max retries reached) —
            // another instance claimed it first. Caller should skip schedule creation.
            return false;
          }
          throw condErr;
        }
      } else {
        // completed — plain PUT resets failCount intentionally on success
        await dynamodb.put({
          TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
          Item: { ...tracker, postId_engagingAccountId: key, createdAt: new Date().toISOString() },
        }).promise();
      }

      return true;
    } catch (error) {
      handleDynamoDbError(error, "recordEngagement");
      throw error;
    }
  },

  async hasEngaged(userId: string, postId: string, engagingAccountId: string, actionType?: string): Promise<boolean> {
    try {
      // For new atomic action types, check both the action-specific key (new format) and
      // the legacy compound key (old format) so existing records still block reschedules.
      const isLegacyCompound = !actionType || actionType === 'like_and_reply_comment' || actionType === 'comment_and_like';
      const keysToCheck = isLegacyCompound
        ? [`${postId}#${engagingAccountId}`]
        : [`${postId}#${engagingAccountId}#${actionType}`, `${postId}#${engagingAccountId}`];

      for (const key of keysToCheck) {
        const result = await dynamodb.query({
          TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
          KeyConditionExpression: "userId = :userId AND postId_engagingAccountId = :postId_engagingAccountId",
          // Block if already queued/completed, or if max retries reached
          FilterExpression: "#status IN (:queued, :completed) OR failCount >= :maxRetries",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":userId": userId,
            ":postId_engagingAccountId": key,
            ":queued": "queued",
            ":completed": "completed",
            ":maxRetries": SOCIAL_ENGAGEMENT_MAX_RETRIES,
          }
        }).promise();
        if (result.Items && result.Items.length > 0) return true;
      }
      return false;
    } catch (error) {
      // Fail safe: assume already engaged on error to prevent duplicate scheduling
      handleDynamoDbError(error, "hasEngaged");
      return true;
    }
  },

  async deleteEngagement(params: {
    userId: string;
    postId: string;
    commentId?: string;
    engagingAccountId: string;
    actionType: string;
  }) {
    try {
      const dedupId = params.commentId || params.postId;
      const isLegacyCompound = params.actionType === 'like_and_reply_comment' || params.actionType === 'comment_and_like';
      const key = isLegacyCompound
        ? `${dedupId}#${params.engagingAccountId}`
        : `${dedupId}#${params.engagingAccountId}#${params.actionType}`;

      await dynamodb.delete({
        TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
        Key: { userId: params.userId, postId_engagingAccountId: key },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, "deleteEngagement");
      throw error;
    }
  },

  // Query all engagement activity for a specific account (account-wise view)
  async getEngagementsByAccount(engagingAccountId: string, options: { from?: string; to?: string } = {}): Promise<any[]> {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
        IndexName: 'EngagingAccountIndex',
        KeyConditionExpression: 'engagingAccountId = :engagingAccountId' + (options.from ? ' AND executedAt >= :from' : ''),
        ExpressionAttributeValues: {
          ':engagingAccountId': engagingAccountId,
          ...(options.from && { ':from': options.from }),
        },
      };

      if (options.to) {
        params.KeyConditionExpression = 'engagingAccountId = :engagingAccountId AND executedAt BETWEEN :from AND :to';
        params.ExpressionAttributeValues![':from'] = options.from || '0';
        params.ExpressionAttributeValues![':to'] = options.to;
      }

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getEngagementsByAccount');
      throw error;
    }
  },

  // Query all accounts that engaged with a specific post (post-wise view).
  // userId is required to scope results to the requesting user and prevent cross-user data leakage.
  async getEngagementsByPost(postId: string, options: { from?: string; to?: string; userId: string }): Promise<any[]> {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
        IndexName: 'PostEngagementIndex',
        KeyConditionExpression: 'postId = :postId' + (options.from ? ' AND executedAt >= :from' : ''),
        FilterExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':postId': postId,
          ':userId': options.userId,
          ...(options.from && { ':from': options.from }),
        },
      };

      if (options.to) {
        params.KeyConditionExpression = 'postId = :postId AND executedAt BETWEEN :from AND :to';
        params.ExpressionAttributeValues![':from'] = options.from || '0';
        params.ExpressionAttributeValues![':to'] = options.to;
      }

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getEngagementsByPost');
      throw error;
    }
  },

  // Count comment like/reply actions already scheduled or completed for a post by a specific account.
  // Used to enforce per-post lifetime caps on comment engagement.
  async getCommentEngagementCountsForPost(postId: string, engagingAccountId: string): Promise<{ likedCount: number; repliedCount: number }> {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
        IndexName: 'PostEngagementIndex',
        KeyConditionExpression: 'postId = :postId',
        FilterExpression: 'engagingAccountId = :accountId AND attribute_exists(commentId)',
        ExpressionAttributeValues: {
          ':postId': postId,
          ':accountId': engagingAccountId,
        },
      };

      const result = await dynamodb.query(params).promise();
      const items = result.Items || [];

      const likedCount = items.filter((i: any) =>
        i.actionType === 'like_comment' || i.actionType === 'like_and_reply_comment'
      ).length;
      const repliedCount = items.filter((i: any) =>
        i.actionType === 'reply_comment' || i.actionType === 'like_and_reply_comment'
      ).length;

      return { likedCount, repliedCount };
    } catch (error) {
      handleDynamoDbError(error, 'getCommentEngagementCountsForPost');
      throw error;
    }
  },

  // Fetch the most recent N generated comment/reply texts for an account.
  // Used to inject comment history into LLM prompts to prevent repetitive outputs.
  async getRecentGeneratedTexts(engagingAccountId: string, limit: number = 10): Promise<string[]> {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
        IndexName: 'EngagingAccountIndex',
        KeyConditionExpression: 'engagingAccountId = :engagingAccountId',
        FilterExpression: 'attribute_exists(generatedText) AND #status = :completed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':engagingAccountId': engagingAccountId,
          ':completed': 'completed',
        },
        ScanIndexForward: false,
        Limit: limit * 3, // over-fetch to account for items without generatedText filtered out
      };

      const result = await dynamodb.query(params).promise();
      const texts = (result.Items || [])
        .map((i: any) => i.generatedText as string)
        .filter(Boolean)
        .slice(0, limit);
      return texts;
    } catch (error) {
      console.warn('[socialEngagementTrackingDb] getRecentGeneratedTexts failed, skipping history:', error);
      return [];
    }
  },
};

// ==================== Organization DB Operations ====================

const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;
const ORG_MAX_MEMBERS = 5;

export const orgDb = {
  async createOrg(org: Organization): Promise<Organization> {
    const params = {
      TableName: ORGS_TABLE,
      Item: org,
      ConditionExpression: "attribute_not_exists(orgId)",
    };
    await dynamodb.put(params).promise();
    return org;
  },

  async getOrgById(orgId: string): Promise<Organization | null> {
    const params = {
      TableName: ORGS_TABLE,
      Key: { orgId },
    };
    const result = await dynamodb.get(params).promise();
    return (result.Item as Organization) || null;
  },

  async updateOrg(orgId: string, updates: Partial<Organization>): Promise<Organization> {
    const { orgId: _, createdAt: __, ...updatableFields } = updates;

    if (Object.keys(updatableFields).length === 0) {
      const org = await this.getOrgById(orgId);
      if (!org) throw new Error(`Organization ${orgId} not found`);
      return org;
    }

    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.entries(updatableFields).forEach(([key, value]) => {
      if (value === undefined) return;
      expressionAttributeNames[`#${key}`] = key;
      if (value === null) {
        // Same REMOVE-on-null convention as userDb.updateUser — needed to
        // actually clear a GSI-keyed attribute like autoJoinDomain, since
        // DynamoDB rejects SET-ing a GSI key to NULL.
        removeExpressions.push(`#${key}`);
      } else {
        setExpressions.push(`#${key} = :${key}`);
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    if (setExpressions.length === 0 && removeExpressions.length === 0) {
      const org = await this.getOrgById(orgId);
      if (!org) throw new Error(`Organization ${orgId} not found`);
      return org;
    }

    // Always update updatedAt
    setExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const updateExpressionParts: string[] = [];
    updateExpressionParts.push(`SET ${setExpressions.join(", ")}`);
    if (removeExpressions.length > 0) updateExpressionParts.push(`REMOVE ${removeExpressions.join(", ")}`);

    const params = {
      TableName: ORGS_TABLE,
      Key: { orgId },
      UpdateExpression: updateExpressionParts.join(" "),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW" as const,
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes as Organization;
  },

  async deleteOrg(orgId: string): Promise<void> {
    await dynamodb.delete({ TableName: ORGS_TABLE, Key: { orgId } }).promise();
  },

  async getOrgMembers(orgId: string): Promise<User[]> {
    const allItems: User[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "OrgIdIndex",
        KeyConditionExpression: "orgId = :orgId",
        FilterExpression: "NOT begins_with(userId, :tombstone)",
        ExpressionAttributeValues: { ":orgId": orgId, ":tombstone": "deleted_" },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }).promise();
      for (const item of result.Items || []) {
        if (typeof item.userId === "string" && !item.userId.startsWith("deleted_")) {
          allItems.push(item as User);
        }
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return allItems;
  },

  async getOrgMemberCount(orgId: string): Promise<number> {
    let total = 0;
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await dynamodb.query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "OrgIdIndex",
        KeyConditionExpression: "orgId = :orgId",
        FilterExpression: "NOT begins_with(userId, :tombstone)",
        ExpressionAttributeValues: { ":orgId": orgId, ":tombstone": "deleted_" },
        Select: "COUNT",
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }).promise();
      total += result.Count || 0;
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return total;
  },

  // Find the first org that has a pending invite for the given email.
  // Used at registration time to stamp pendingOrgInvite on a brand-new account.
  async getOrgWithPendingInviteForEmail(email: string): Promise<Organization | null> {
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    const normalizedEmail = email.toLowerCase();
    do {
      const result = await dynamodb.scan({
        TableName: ORGS_TABLE,
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }).promise();
      const match = (result.Items as Organization[] || []).find(
        (org) => (org.pendingInvites || []).some((inv) => inv.email === normalizedEmail)
      );
      if (match) return match;
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return null;
  },

  // Find all orgs with auto-join enabled for the given email domain (indexed
  // query via AutoJoinDomainIndex, not a scan — this runs on every signup).
  // Used at registration time to create pending domain-join requests.
  async getOrgsWithAutoJoinDomain(domain: string): Promise<Organization[]> {
    const allItems: Organization[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await dynamodb.query({
        TableName: ORGS_TABLE,
        IndexName: "AutoJoinDomainIndex",
        KeyConditionExpression: "autoJoinDomain = :domain",
        FilterExpression: "autoJoinEnabled = :enabled",
        ExpressionAttributeValues: { ":domain": domain, ":enabled": true },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }).promise();
      allItems.push(...((result.Items as Organization[]) || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return allItems;
  },

  // Atomically appends a domain-join request via DynamoDB's list_append,
  // rather than reading pendingDomainJoinRequests then SET-ing the whole
  // array back (a read-modify-write that loses concurrent appends/removals
  // to the same org — flagged in review). Two signups matching the same org
  // at the same instant now both land correctly instead of one clobbering
  // the other's read-modify-write.
  async addPendingDomainJoinRequest(
    orgId: string,
    request: { userId: string; email: string; requestedAt: string; requestToken: string }
  ): Promise<void> {
    await dynamodb
      .update({
        TableName: ORGS_TABLE,
        Key: { orgId },
        UpdateExpression:
          "SET pendingDomainJoinRequests = list_append(if_not_exists(pendingDomainJoinRequests, :empty), :new), updatedAt = :now",
        ExpressionAttributeValues: {
          ":empty": [],
          ":new": [request],
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  },

  // Atomically removes a domain-join request by token (approve/reject),
  // via optimistic-concurrency retry rather than the read-filter-then-SET-
  // whole-array pattern this replaced — that pattern silently dropped a
  // concurrently-appended request (a new signup landing via
  // addPendingDomainJoinRequest while an owner was mid-approve on this same
  // org) or let two concurrent owner actions overwrite each other and
  // resurrect an already-processed request (flagged in review). Each retry
  // re-reads the org fresh and re-filters, conditioned on updatedAt not
  // having changed since that read; on a conflict it just retries against
  // the new state. Returns false if the token isn't found (already removed,
  // or never existed) — never throws for that case.
  async removeDomainJoinRequest(orgId: string, requestToken: string): Promise<boolean> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await dynamodb.get({ TableName: ORGS_TABLE, Key: { orgId } }).promise();
      const org = result.Item as Organization | undefined;
      if (!org) return false;

      const pending = org.pendingDomainJoinRequests || [];
      const updated = pending.filter((r) => r.requestToken !== requestToken);
      if (updated.length === pending.length) return false; // Not found.

      try {
        await dynamodb
          .update({
            TableName: ORGS_TABLE,
            Key: { orgId },
            UpdateExpression: "SET pendingDomainJoinRequests = :updated, updatedAt = :now",
            ConditionExpression: "updatedAt = :expectedUpdatedAt",
            ExpressionAttributeValues: {
              ":updated": updated,
              ":now": new Date().toISOString(),
              ":expectedUpdatedAt": org.updatedAt,
            },
          })
          .promise();
        return true;
      } catch (error: any) {
        if (error.code === "ConditionalCheckFailedException") {
          continue; // Org changed concurrently — re-read and retry.
        }
        throw error;
      }
    }
    throw new Error(`removeDomainJoinRequest: exceeded ${MAX_ATTEMPTS} retry attempts for org ${orgId}`);
  },

  async updateShareSettings(orgId: string, settings: OrgShareSettings): Promise<void> {
    await dynamodb.update({
      TableName: ORGS_TABLE,
      Key: { orgId },
      UpdateExpression: "SET shareSettings = :s, updatedAt = :u",
      ExpressionAttributeValues: {
        ":s": settings,
        ":u": new Date().toISOString(),
      },
    }).promise();
  },

  async pruneEditorListsForUser(orgId: string, removedUserId: string): Promise<void> {
    const got = await dynamodb.get({
      TableName: ORGS_TABLE,
      Key: { orgId },
    }).promise();
    const org = got.Item as Organization | undefined;
    if (!org?.shareSettings) return;
    const ss = org.shareSettings;
    const strip = (arr: string[]) => arr.filter((uid) => uid !== removedUserId);
    const next: OrgShareSettings = {
      knowledgeBase:     { ...ss.knowledgeBase,     editors: strip(ss.knowledgeBase.editors) },
      htmlTemplates:     { ...ss.htmlTemplates,     editors: strip(ss.htmlTemplates.editors) },
      landingPages:      { ...ss.landingPages,      editors: strip(ss.landingPages.editors) },
      workPlans:         { ...ss.workPlans,         editors: strip(ss.workPlans.editors) },
      skills:            { ...ss.skills,            editors: strip(ss.skills.editors) },
      analytics:         { ...(ss.analytics ?? { enabled: false, editors: [] }), editors: strip((ss.analytics?.editors) ?? []) },
      brandGuidelines:   { editors: strip(ss.brandGuidelines.editors) },
      marketingStrategy: { editors: strip(ss.marketingStrategy.editors) },
    };
    await this.updateShareSettings(orgId, next);
  },

  ORG_MAX_MEMBERS,

  /**
   * Persist an encrypted secret value to the org record.
   * Uses an atomic UpdateExpression so it does not clobber other secrets.
   */
  async setOrgSecret(orgId: string, key: string, encryptedValue: string): Promise<void> {
    const params = {
      TableName: ORGS_TABLE,
      Key: { orgId },
      UpdateExpression: "SET #secrets.#key = :val, #updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#secrets": "secrets",
        "#key": key,
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":val": encryptedValue,
        ":updatedAt": new Date().toISOString(),
      },
      // If secrets map doesn't exist yet, the nested set will fail.
      // We use a conditional expression + fallback to initialise the map.
      ConditionExpression: "attribute_exists(#secrets)",
    };

    try {
      await dynamodb.update(params).promise();
    } catch (err: any) {
      if (err.code === "ConditionalCheckFailedException") {
        // secrets map does not exist — create it now
        await dynamodb.update({
          TableName: ORGS_TABLE,
          Key: { orgId },
          UpdateExpression: "SET #secrets = :secretsMap, #updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#secrets": "secrets",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":secretsMap": { [key]: encryptedValue },
            ":updatedAt": new Date().toISOString(),
          },
        }).promise();
      } else {
        throw err;
      }
    }
  },

  /**
   * Retrieve a single encrypted secret from the org record.
   * Returns null if the org doesn't exist or the key is absent.
   */
  async getOrgSecret(orgId: string, key: string): Promise<string | null> {
    const org = await this.getOrgById(orgId);
    if (!org?.secrets) return null;
    return (org.secrets as Record<string, string>)[key] ?? null;
  },

  /**
   * Remove a single secret key from the org record.
   */
  async removeOrgSecret(orgId: string, key: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: ORGS_TABLE,
        Key: { orgId },
        UpdateExpression: "REMOVE #secrets.#key SET #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#secrets": "secrets",
          "#key": key,
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":updatedAt": new Date().toISOString(),
        },
      }).promise();
    } catch {
      // If secrets map or key doesn't exist, that's fine — already absent.
    }
  },
};

// ─── Schedule Templates ──────────────────────────────────────────────────────

export const scheduleTemplateDb = {
  async createTemplate(template: {
    templateId: string;
    createdBy: string;
    name: string;
    description?: string;
    category: string;
    visibility: 'system' | 'private' | 'public' | 'pending_review';
    startingMessage: string;
    variables?: Array<{ name: string; description?: string; type?: 'text' | 'long_text' | 'file' }>;
    keywords?: string[];
    requiredFunctionCalls?: string[];
    functionCallMinCalls?: { [functionName: string]: number };
    suggestedFrequency?: string;
    frequencyIntervalDays?: number;
    emailNotifications?: string[];
    dailyDigest?: boolean;
    llmModel?: string;
    usageCount?: number;
    reviewFeedback?: string;
    createdAt: string;
    updatedAt: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        Item: template,
      };
      await dynamodb.put(params).promise();
      return template;
    } catch (error) {
      handleDynamoDbError(error, "createTemplate");
    }
  },

  async getTemplateById(templateId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        Key: { templateId },
      };
      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getTemplateById");
    }
  },

  async getTemplatesByCreator(createdBy: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        IndexName: 'CreatedByIndex',
        KeyConditionExpression: 'createdBy = :createdBy',
        ExpressionAttributeValues: { ':createdBy': createdBy },
      };
      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getTemplatesByCreator");
      return [];
    }
  },

  async getTemplatesByVisibility(visibility: string, category?: string) {
    try {
      let keyCondition = 'visibility = :visibility';
      const expressionValues: any = { ':visibility': visibility };

      if (category) {
        keyCondition += ' AND category = :category';
        expressionValues[':category'] = category;
      }

      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        IndexName: 'VisibilityCategoryIndex',
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: expressionValues,
      };
      return await paginatedQuery(dynamodb, params);
    } catch (error) {
      handleDynamoDbError(error, "getTemplatesByVisibility");
      return [];
    }
  },

  async updateTemplate(
    templateId: string,
    updates: Partial<{
      name: string;
      description: string;
      category: string;
      visibility: 'system' | 'private' | 'public' | 'pending_review';
      startingMessage: string;
      variables: Array<{ name: string; description?: string; type?: 'text' | 'long_text' | 'file' }>;
      keywords: string[];
      requiredFunctionCalls: string[];
      functionCallMinCalls: { [functionName: string]: number };
      suggestedFrequency: string;
      frequencyIntervalDays: number;
      emailNotifications: string[];
      dailyDigest: boolean;
      llmModel: string;
      usageCount: number;
      reviewFeedback: string;
      updatedAt: string;
    }>
  ) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      if (updateExpressions.length === 0) return;

      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        Key: { templateId },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW' as const,
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateTemplate");
    }
  },

  async deleteTemplate(templateId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        Key: { templateId },
      };
      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "deleteTemplate");
    }
  },

  async incrementUsageCount(templateId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
        Key: { templateId },
        UpdateExpression: 'SET usageCount = if_not_exists(usageCount, :zero) + :one, updatedAt = :now',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW' as const,
      };
      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "incrementUsageCount");
    }
  },

  async getAllTemplates() {
    try {
      return await paginatedScan(dynamodb, {
        TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
      });
    } catch (error) {
      handleDynamoDbError(error, "getAllTemplates");
      return [];
    }
  },
};

const OAUTH_SESSIONS_TABLE = `${TABLE_PREFIX}AW-OAuthSessions`;

export const oauthSessionDb = {
  async save(session: {
    sessionId: string;
    userId: string;
    access_token: string;
    expires_in?: number;
    scopes: string[];
    flow: string;
  }): Promise<void> {
    const TEN_MINUTES_SECONDS = 10 * 60;
    const ttl = Math.floor(Date.now() / 1000) + TEN_MINUTES_SECONDS;
    try {
      await dynamodb.put({
        TableName: OAUTH_SESSIONS_TABLE,
        Item: { ...session, ttl },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'oauthSessionDb.save');
    }
  },

  async get(sessionId: string, userId: string): Promise<{
    userId: string;
    access_token: string;
    expires_in?: number;
    scopes: string[];
    flow: string;
  } | null> {
    try {
      const result = await dynamodb.get({
        TableName: OAUTH_SESSIONS_TABLE,
        Key: { sessionId },
      }).promise();
      if (!result.Item) return null;
      if (result.Item.userId !== userId) return null;
      return result.Item as any;
    } catch (error) {
      handleDynamoDbError(error, 'oauthSessionDb.get');
      return null;
    }
  },

  async delete(sessionId: string): Promise<void> {
    try {
      await dynamodb.delete({
        TableName: OAUTH_SESSIONS_TABLE,
        Key: { sessionId },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'oauthSessionDb.delete');
    }
  },
};

const TEMP_EMAILS_TABLE = `${TABLE_PREFIX}AW-TempEmails`;

export const tempEmailDb = {
  async save(email: {
    emailId: string;
    toAddress: string;
    fromAddress: string;
    subject: string;
    text?: string;
    receivedAt: string;
  }) {
    try {
      const ttlSeconds = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
      await dynamodb.put({
        TableName: TEMP_EMAILS_TABLE,
        Item: {
          emailId: email.emailId,
          toAddress: email.toAddress.toLowerCase(),
          fromAddress: email.fromAddress,
          subject: email.subject || '',
          text: email.text || '',
          receivedAt: email.receivedAt,
          ttl: ttlSeconds,
        },
      }).promise();
    } catch (error) {
      handleDynamoDbError(error, "tempEmailDb.save");
    }
  },

  async getByAddress(toAddress: string, since?: string): Promise<any[]> {
    try {
      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: TEMP_EMAILS_TABLE,
        IndexName: 'ToAddressIndex',
        KeyConditionExpression: since
          ? 'toAddress = :addr AND receivedAt >= :since'
          : 'toAddress = :addr',
        ExpressionAttributeValues: {
          ':addr': toAddress.toLowerCase(),
          ...(since ? { ':since': since } : {}),
        },
        ScanIndexForward: false,
        Limit: 20,
      };
      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "tempEmailDb.getByAddress");
      return [];
    }
  },
};

// ─── Test Accounts ────────────────────────────────────────────────────────────

const TEST_ACCOUNTS_TABLE = `${TABLE_PREFIX}AW-TestAccounts`;

export interface TestAccount {
  accountId: string;
  userId: string;
  domain: string;
  siteUrl: string;
  email: string;
  password: string;
  notes?: string;
  source: 'manual' | 'auto-created';
  createdAt: string;
  updatedAt: string;
}

export const testAccountsDb = {
  async create(
    userId: string,
    data: { domain: string; siteUrl: string; email: string; password: string; notes?: string; source?: 'manual' | 'auto-created' }
  ): Promise<TestAccount> {
    const { ulid } = await import('ulid');
    const now = new Date().toISOString();
    const item: TestAccount = {
      accountId: ulid(),
      userId,
      domain: data.domain.toLowerCase(),
      siteUrl: data.siteUrl,
      email: data.email,
      password: data.password,
      notes: data.notes,
      source: data.source ?? 'manual',
      createdAt: now,
      updatedAt: now,
    };
    if (!item.notes) delete item.notes;
    try {
      await dynamodb.put({ TableName: TEST_ACCOUNTS_TABLE, Item: item }).promise();
      return item;
    } catch (error) {
      handleDynamoDbError(error, 'testAccountsDb.create');
      throw error;
    }
  },

  async getByUserId(userId: string): Promise<TestAccount[]> {
    try {
      const result = await dynamodb.query({
        TableName: TEST_ACCOUNTS_TABLE,
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false,
      }).promise();
      return (result.Items || []) as TestAccount[];
    } catch (error) {
      handleDynamoDbError(error, 'testAccountsDb.getByUserId');
      throw error;
    }
  },

  async getById(accountId: string): Promise<TestAccount | undefined> {
    try {
      const result = await dynamodb.get({
        TableName: TEST_ACCOUNTS_TABLE,
        Key: { accountId },
      }).promise();
      return result.Item as TestAccount | undefined;
    } catch (error) {
      handleDynamoDbError(error, 'testAccountsDb.getById');
      throw error;
    }
  },

  async getByDomain(userId: string, domain: string): Promise<TestAccount[]> {
    try {
      const result = await dynamodb.query({
        TableName: TEST_ACCOUNTS_TABLE,
        IndexName: 'UserIdDomainIndex',
        KeyConditionExpression: 'userId = :userId AND #domain = :domain',
        ExpressionAttributeNames: { '#domain': 'domain' },
        ExpressionAttributeValues: { ':userId': userId, ':domain': domain.toLowerCase() },
      }).promise();
      return (result.Items || []) as TestAccount[];
    } catch (error) {
      handleDynamoDbError(error, 'testAccountsDb.getByDomain');
      throw error;
    }
  },

  async update(
    accountId: string,
    updates: Partial<Pick<TestAccount, 'email' | 'password' | 'notes' | 'siteUrl'>>
  ): Promise<TestAccount | undefined> {
    const expressions: string[] = ['#updatedAt = :updatedAt'];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };

    if (updates.email !== undefined) { expressions.push('#email = :email'); names['#email'] = 'email'; values[':email'] = updates.email; }
    if (updates.password !== undefined) { expressions.push('#password = :password'); names['#password'] = 'password'; values[':password'] = updates.password; }
    if (updates.siteUrl !== undefined) { expressions.push('#siteUrl = :siteUrl'); names['#siteUrl'] = 'siteUrl'; values[':siteUrl'] = updates.siteUrl; }
    if (updates.notes !== undefined) { expressions.push('#notes = :notes'); names['#notes'] = 'notes'; values[':notes'] = updates.notes; }

    try {
      const result = await dynamodb.update({
        TableName: TEST_ACCOUNTS_TABLE,
        Key: { accountId },
        UpdateExpression: `SET ${expressions.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }).promise();
      return result.Attributes as TestAccount | undefined;
    } catch (error) {
      handleDynamoDbError(error, 'testAccountsDb.update');
      throw error;
    }
  },

  async delete(accountId: string): Promise<void> {
    try {
      await dynamodb.delete({ TableName: TEST_ACCOUNTS_TABLE, Key: { accountId } }).promise();
    } catch (error) {
      handleDynamoDbError(error, 'testAccountsDb.delete');
      throw error;
    }
  },
};
