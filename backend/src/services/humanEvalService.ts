import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { eventToItem, LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { asLoopId, asSubjectId, type NormalizedEvent } from '../loops/core/types';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { uploadFileToS3 } from '../utils/s3Utils';
import { chatbotDb } from './chatbotService';
import { userDb } from './db';
import {
  getSlackUserDisplayName,
  getSlackUserEmail,
  postSlackMessage,
  resolveSlackMentionsInText,
} from './slackService';
import { settingsService } from './settingsService';
import type { CreativeGateCheck, CreativeGateResult } from './creativeGates';
import type { CreativeRubricResult, StoredCreativePairwise } from './creativeRubricJudge';

import { TABLE_PREFIX } from '../config/constants';
export const HUMAN_EVAL_QUEUE_TABLE = `${TABLE_PREFIX}AW-HumanEvalQueue`;
const HUMAN_EVAL_TELEMETRY_LOOP_ID = asLoopId('human-eval');
const MAX_INLINE_IMAGE_BYTES = 15 * 1024 * 1024;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export type HumanEvalReviewType = 'creative_image' | 'landing_page' | 'lead_enrichment';
export type HumanEvalReviewer = 'matt' | 'fangfang';
export type HumanEvalStatus = 'pending' | 'reviewed';

/**
 * Use-case classification for reviewed outputs (ENG-90). Matt's feedback on an
 * image differs depending on whether it was made as an Ad or an Organic Post,
 * so enqueue call sites that know their flow tag candidates accordingly.
 * Anything unknown/missing fail-opens to 'uncategorized' — the category must
 * never break enqueueing or posting.
 */
export type HumanEvalCategory = 'ad' | 'organic_post' | 'uncategorized';

/** Fail-open normalizer: unknown/missing values become 'uncategorized', never an error. */
export function normalizeHumanEvalCategory(value: unknown): HumanEvalCategory {
  if (typeof value !== 'string') return 'uncategorized';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'ad' || normalized === 'organic_post') return normalized;
  return 'uncategorized';
}

/**
 * Strict parser for the READ/filter path (ENG-90 review fix). Fail-open is only
 * justified where it protects enqueueing; a list filter must never silently
 * coerce a typo ('ads', 'orgnic_post') to 'uncategorized' and return the wrong
 * record set as a success. Recognized spellings (case/space/hyphen tolerant)
 * map to the canonical value; anything else returns null so callers can 400.
 */
export function parseHumanEvalCategoryFilter(value: string): HumanEvalCategory | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'ad' || normalized === 'organic_post' || normalized === 'uncategorized') {
    return normalized;
  }
  return null;
}

export function humanEvalCategoryLabel(category: HumanEvalCategory | undefined): string {
  switch (category) {
    case 'ad':
      return 'Ad';
    case 'organic_post':
      return 'Organic Post';
    default:
      return 'Uncategorized';
  }
}

export type HumanEvalAction =
  | {
      type: 'agent_mode_image_revision';
      sessionId: string;
      userId: string;
      artifactUrl?: string;
      filename?: string;
    }
  | {
      type: 'landing_page_iteration_deploy';
      landingPageId: string;
      userId: string;
    }
  | {
      type: 'lead_enrichment_rerun';
      listId: string;
      userId: string;
      leadId?: string;
      leadIds?: string[];
      outputFields: Array<{ name: string; instruction: string; overwrite_policy?: 'fill_if_empty' | 'always_overwrite' }>;
      toolName: 'enrich_leads_execute' | 'enrich_lead_custom';
    };

export interface HumanEvalCandidate {
  candidateId: string;
  reviewType: HumanEvalReviewType;
  reviewer: HumanEvalReviewer;
  reviewerSlackUserId?: string;
  status: HumanEvalStatus;
  /** Additive (ENG-90); records created before it exist without the field — read as 'uncategorized'. */
  category?: HumanEvalCategory;
  userId?: string;
  sessionId?: string;
  agentRunId?: string;
  artifactUrl?: string;
  chatUrl?: string;
  outputSummary: string;
  originalRequest?: string;
  action?: HumanEvalAction;
  /** Advisory deterministic image checks from generation time (ENG-2139). Additive: absent on
   *  older records, on non-image candidates, and when the gates could not run. */
  creativeGates?: CreativeGateResult;
  /** Advisory rubric-judge result (ENG-2140), written after creation when the judge is enabled and
   *  this creative was sampled. Additive: absent otherwise. */
  creativeRubric?: CreativeRubricResult;
  /** Advisory runtime pairwise verdict vs the account's prior best creative for the same placement
   *  (ENG-2192), written after `creativeRubric` when a prior best exists. Additive: absent otherwise. */
  creativePairwise?: StoredCreativePairwise;
  /** Absent when Slack posting was disabled or failed for this candidate (ENG-1854) — the
   *  candidate still persists and is reviewable via the queue API either way. */
  slackChannel?: string;
  slackMessageTs?: string;
  feedback: HumanEvalFeedback[];
  createdAt: string;
  updatedAt: string;
}

export interface HumanEvalFeedback {
  feedbackId: string;
  slackUserId: string;
  slackUserEmail?: string;
  slackUserDisplayName: string;
  text: string;
  createdAt: string;
}

export interface CreateHumanEvalCandidateInput {
  reviewType: HumanEvalReviewType;
  outputSummary: string;
  userId?: string;
  sessionId?: string;
  agentRunId?: string;
  artifactUrl?: string;
  chatUrl?: string;
  originalRequest?: string;
  action?: HumanEvalAction;
  /** Optional Ad/Organic Post use-case tag; normalized fail-open (unknown → 'uncategorized'). */
  category?: string;
  /** Advisory creative gate result to store with the candidate (ENG-2139). */
  creativeGates?: CreativeGateResult;
}

interface DynamoLike {
  put(params: AWS.DynamoDB.DocumentClient.PutItemInput): { promise(): Promise<unknown> };
  get(params: AWS.DynamoDB.DocumentClient.GetItemInput): { promise(): Promise<AWS.DynamoDB.DocumentClient.GetItemOutput> };
  update(params: AWS.DynamoDB.DocumentClient.UpdateItemInput): { promise(): Promise<unknown> };
  scan(params: AWS.DynamoDB.DocumentClient.ScanInput): { promise(): Promise<AWS.DynamoDB.DocumentClient.ScanOutput> };
}

interface SettingsLike {
  getSetting(name: string): Promise<{ settingValue: string } | null>;
  setSetting(name: string, value: string, description?: string, updatedBy?: string): Promise<unknown>;
}

interface SlackLike {
  postSlackMessage(channelId: string, text: string, threadTs?: string): Promise<{ ts: string; channel: string }>;
  getSlackUserDisplayName(userId: string): Promise<string>;
  getSlackUserEmail(userId: string): Promise<string | null>;
  resolveSlackMentionsInText(text: string): Promise<string>;
}

interface ChatbotLike {
  addMessageToSession(sessionId: string, message: any): Promise<any>;
  createOrReuseInteractiveShare(sessionId: string): Promise<string>;
}

interface LearningLike {
  recordFeedback(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void>;
}

interface ActionRunnerLike {
  run(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void>;
}

interface UploadInlineImageContext {
  candidateId: string;
  reviewType: HumanEvalReviewType;
  userId?: string;
  sessionId?: string;
  agentRunId?: string;
}

interface UploadedInlineImage {
  url: string;
  key?: string;
  byteLength: number;
  mimeType: string;
}

interface HumanEvalAssetStoreLike {
  uploadInlineImage(dataUri: string, context: UploadInlineImageContext): Promise<UploadedInlineImage>;
}

type HumanEvalAssetEvent =
  | 'human_eval_asset_inline_image_detected'
  | 'human_eval_asset_inline_image_uploaded'
  | 'human_eval_asset_delivery_failed';

type HumanEvalAssetTelemetryInfo = Partial<UploadInlineImageContext> & {
  reason?: string;
  errorClass?: string;
  errorMessage?: string;
  mimeType?: string;
  byteLength?: number;
  artifactKey?: string;
};

interface HumanEvalAssetTelemetryLike {
  recordAssetEvent(eventType: HumanEvalAssetEvent, info: HumanEvalAssetTelemetryInfo): Promise<void>;
}

class HumanEvalActionRunner implements ActionRunnerLike {
  async run(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void> {
    const { runHumanEvalFeedbackAction } = await import('./humanEvalActionService');
    await runHumanEvalFeedbackAction(candidate, feedback);
  }
}

class HumanEvalS3AssetStore implements HumanEvalAssetStoreLike {
  async uploadInlineImage(dataUri: string, context: UploadInlineImageContext): Promise<UploadedInlineImage> {
    const parsed = parseInlineImageDataUri(dataUri);
    if (!parsed) {
      throw new Error('Unsupported inline image data URI');
    }
    if (parsed.buffer.length > MAX_INLINE_IMAGE_BYTES) {
      throw new Error(`Inline image is too long (${parsed.buffer.length} bytes)`);
    }

    const filename = `human-eval-${context.reviewType}-${context.candidateId}.${extensionForMimeType(parsed.mimeType)}`;
    const uploaded = await uploadFileToS3(
      parsed.buffer,
      filename,
      context.userId || 'human-eval',
      parsed.mimeType,
    );
    if (!uploaded.success || !uploaded.url) {
      throw new Error(uploaded.error || 'S3 upload returned no URL');
    }

    return {
      url: uploaded.url,
      key: uploaded.key,
      byteLength: parsed.buffer.length,
      mimeType: parsed.mimeType,
    };
  }
}

class HumanEvalDynamoTelemetry implements HumanEvalAssetTelemetryLike {
  async recordAssetEvent(eventType: HumanEvalAssetEvent, info: HumanEvalAssetTelemetryInfo): Promise<void> {
    try {
      const subjectId = info.candidateId || info.agentRunId || info.sessionId || info.userId || 'unknown';
      const dimensions = cleanDimensions({
        candidateId: info.candidateId,
        reviewType: info.reviewType,
        userId: info.userId,
        sessionId: info.sessionId,
        agentRunId: info.agentRunId,
        reason: info.reason,
        errorClass: info.errorClass,
        errorMessage: info.errorMessage,
        mimeType: info.mimeType,
        byteLength: info.byteLength,
        artifactKey: info.artifactKey,
      });
      const event: NormalizedEvent = {
        subjectId: asSubjectId(subjectId),
        eventType,
        ts: new Date(),
        dimensions,
      };
      const item = eventToItem(HUMAN_EVAL_TELEMETRY_LOOP_ID, event);
      await dynamodb.put({ TableName: LOOP_EVENTS_TABLE, Item: item }).promise();
    } catch (err) {
      console.warn('[human-eval] asset telemetry failed (swallowed):', err instanceof Error ? err.message : err);
    }
  }
}

class HumanEvalMemoryLearning implements LearningLike {
  async recordFeedback(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void> {
    if (!candidate.userId) return;

    const content = buildMemoryContent(candidate, feedback);
    try {
      const { accountMemoryDb, orgDb, orgMemoryDb, userDb } = await import('./db');
      const { embedText } = await import('../utils/embeddings');
      const user = await userDb.getUserById(candidate.userId);
      if (!user) return;

      const embedding = (await embedText(content, {
        userId: candidate.userId,
        feature: 'human_eval_feedback',
      })) ?? undefined;

      if (user.orgId) {
        const org = await orgDb.getOrgById(user.orgId);
        if (org && org.orgMemoryEnabled !== false) {
          await orgMemoryDb.addMemory(user.orgId, 'workflow', content, candidate.userId, embedding);
          return;
        }
      }

      if (user.memoryEnabled !== false) {
        await accountMemoryDb.addMemory(candidate.userId, 'workflow', content, candidate.sessionId, embedding);
      }
    } catch (err: any) {
      console.warn('[human-eval] failed to record memory learning:', err?.message || err);
    }
  }
}

export class HumanEvalService {
  constructor(
    private readonly db: DynamoLike = dynamodb,
    private readonly settings: SettingsLike = settingsService,
    private readonly slack: SlackLike = {
      postSlackMessage,
      getSlackUserDisplayName,
      getSlackUserEmail,
      resolveSlackMentionsInText,
    },
    private readonly chatbot: ChatbotLike = chatbotDb,
    private readonly learning: LearningLike = new HumanEvalMemoryLearning(),
    private readonly actions: ActionRunnerLike = new HumanEvalActionRunner(),
    private readonly assets: HumanEvalAssetStoreLike = new HumanEvalS3AssetStore(),
    private readonly telemetry: HumanEvalAssetTelemetryLike = new HumanEvalDynamoTelemetry(),
  ) {}

  getReviewerForType(reviewType: HumanEvalReviewType): HumanEvalReviewer {
    if (reviewType === 'lead_enrichment') return 'fangfang';
    return 'matt';
  }

  async createCandidate(input: CreateHumanEvalCandidateInput): Promise<HumanEvalCandidate> {
    this.assertReviewType(input.reviewType);

    if (!input.outputSummary?.trim()) {
      throw new Error('outputSummary is required');
    }

    const reviewer = this.getReviewerForType(input.reviewType);
    const reviewerSlackUserId = await this.getReviewerSlackUserId(reviewer);
    const candidateId = uuidv4();
    const now = new Date().toISOString();
    const category = normalizeHumanEvalCategory(input.category);
    const preparedInput = await this.prepareCandidateInput(input, candidateId);
    const chatUrl = await this.resolveChatUrl(preparedInput);

    // ENG-1854: persistence no longer depends on a Slack post succeeding (or even being
    // attempted) — a prior version built the Slack message and posted it BEFORE writing to
    // DynamoDB, so a Slack outage or an unconfigured channel silently dropped the candidate
    // entirely, not just the notification. Write the record first, unconditionally.
    const candidate: HumanEvalCandidate = {
      candidateId,
      reviewType: input.reviewType,
      reviewer,
      reviewerSlackUserId,
      status: 'pending',
      category,
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      artifactUrl: preparedInput.artifactUrl,
      chatUrl,
      outputSummary: preparedInput.outputSummary.trim(),
      originalRequest: preparedInput.originalRequest?.trim() || undefined,
      action: preparedInput.action,
      ...(input.creativeGates ? { creativeGates: input.creativeGates } : {}),
      feedback: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.db.put({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Item: candidate,
      ConditionExpression: 'attribute_not_exists(candidateId)',
    }).promise();

    const postingReason = await this.slackPostingReasonFor(input.userId);
    if (postingReason) {
      try {
        const slackChannel = await this.getEvalChannel();
        const message = postingReason === 'exception'
          ? this.buildConciseExceptionMessage({
              reviewer,
              reviewerSlackUserId,
              chatUrl,
              artifactUrl: preparedInput.artifactUrl,
            })
          : this.buildSlackMessage({
              ...preparedInput,
              candidateId,
              reviewer,
              reviewerSlackUserId,
              chatUrl,
              normalizedCategory: category,
              userEmail: await this.resolveUserEmail(input.userId),
            });
        const posted = await this.slack.postSlackMessage(slackChannel, message);

        candidate.slackChannel = posted.channel || slackChannel;
        candidate.slackMessageTs = posted.ts;

        await this.db.update({
          TableName: HUMAN_EVAL_QUEUE_TABLE,
          Key: { candidateId },
          UpdateExpression: 'SET slackChannel = :c, slackMessageTs = :t',
          ExpressionAttributeValues: { ':c': candidate.slackChannel, ':t': candidate.slackMessageTs },
        }).promise();

        await this.settings.setSetting(
          this.threadMappingKey(candidate.slackChannel, candidate.slackMessageTs),
          candidate.candidateId,
          'Slack thread to human eval candidate mapping',
          'human-eval',
        );
      } catch (err: any) {
        // Fail open: the candidate is already persisted and reviewable via the queue API
        // even if the Slack post itself failed (e.g. channel not configured).
        console.warn('[human-eval] Slack post failed, candidate persisted without it:', err?.message || err);
      }
    }

    return candidate;
  }

  async handleSlackThreadReply(input: {
    channel: string;
    threadTs: string;
    messageTs: string;
    slackUserId: string;
    text?: string;
  }): Promise<boolean> {
    const rawText = input.text?.trim();
    if (!rawText) return false;

    const candidateId = await this.getCandidateIdForThread(input.channel, input.threadTs);
    if (!candidateId) return false;

    const candidate = await this.getCandidate(candidateId);
    if (!candidate) return false;

    const feedbackId = `${input.channel}:${input.messageTs}`;
    if (candidate.feedback.some((f) => f.feedbackId === feedbackId)) {
      return true;
    }

    const [displayName, email, resolvedText] = await Promise.all([
      this.slack.getSlackUserDisplayName(input.slackUserId),
      this.slack.getSlackUserEmail(input.slackUserId),
      this.slack.resolveSlackMentionsInText(rawText),
    ]);

    const feedback: HumanEvalFeedback = {
      feedbackId,
      slackUserId: input.slackUserId,
      slackUserEmail: email || undefined,
      slackUserDisplayName: displayName,
      text: resolvedText.trim(),
      createdAt: new Date().toISOString(),
    };

    await this.appendFeedback(candidate, feedback);
    await this.addFeedbackToSession(candidate, feedback);
    await this.learning.recordFeedback(candidate, feedback);

    // ENG-1687: acknowledge receipt in-thread immediately. Feedback was
    // previously recorded (and, for the 3 known action types, silently acted
    // on) with zero reply — a reviewer who posts feedback with no visible
    // confirmation has no way to tell "recorded, working on it" from "the
    // bot never saw this." Every reply gets an ack; only candidates with a
    // known runnable action additionally get an auto-action note.
    const ackLines = [
      `:inbox_tray: Got it, <@${input.slackUserId}> — feedback recorded on candidate \`${candidate.candidateId}\`.`,
    ];
    if (candidate.action) {
      ackLines.push('Running the auto-action now; the revised result will post back to this thread when ready.');
    } else {
      ackLines.push('No automatic re-run is wired for this review type yet — this will be actioned manually.');
    }
    void this.slack
      .postSlackMessage(input.channel, ackLines.join('\n'), input.threadTs)
      .catch((err: any) => {
        console.warn('[human-eval] failed to post Slack ack reply:', err?.message || err);
      });

    void this.actions.run(candidate, feedback).catch((err: any) => {
      console.warn('[human-eval] failed to run feedback action:', err?.message || err);
    });
    return true;
  }

  /** Stores the rubric-judge result on an existing candidate (ENG-2140). Never creates an item. */
  async setCreativeRubric(candidateId: string, result: CreativeRubricResult): Promise<void> {
    await this.db.update({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Key: { candidateId },
      UpdateExpression: 'SET creativeRubric = :rubric',
      ConditionExpression: 'attribute_exists(candidateId)',
      ExpressionAttributeValues: { ':rubric': result },
    }).promise();
  }

  /** Stores the runtime pairwise verdict on an existing candidate (ENG-2192). Never creates an item. */
  async setCreativePairwise(candidateId: string, result: StoredCreativePairwise): Promise<void> {
    await this.db.update({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Key: { candidateId },
      UpdateExpression: 'SET creativePairwise = :pairwise',
      ConditionExpression: 'attribute_exists(candidateId)',
      ExpressionAttributeValues: { ':pairwise': result },
    }).promise();
  }

  /**
   * Merges additional deterministic-check results onto an existing candidate's `creativeGates`
   * (ENG-2193: OCR/spelling/brand-colour/logo/policy-keyword checks, computed out-of-band by
   * `creativeContentCheckRunner.ts` after the structural gates already stored at creation time).
   * A no-op — not an error — when the candidate has no `creativeGates` yet (generation never
   * produced structural gates, e.g. a Runway download failure), since there is nothing to extend.
   * Never creates an item.
   */
  async appendCreativeGateChecks(candidateId: string, checks: CreativeGateCheck[]): Promise<void> {
    if (checks.length === 0) return;
    const candidate = await this.getCandidate(candidateId);
    if (!candidate?.creativeGates) return;
    const mergedChecks = [...candidate.creativeGates.checks, ...checks];
    const merged: CreativeGateResult = {
      ...candidate.creativeGates,
      checks: mergedChecks,
      passed: mergedChecks.every((c) => c.status !== 'fail'),
    };
    await this.db.update({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Key: { candidateId },
      UpdateExpression: 'SET creativeGates = :gates',
      ConditionExpression: 'attribute_exists(candidateId)',
      ExpressionAttributeValues: { ':gates': merged },
    }).promise();
  }

  async getCandidate(candidateId: string): Promise<HumanEvalCandidate | null> {
    const result = await this.db.get({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Key: { candidateId },
    }).promise();
    return (result.Item as HumanEvalCandidate | undefined) || null;
  }

  /**
   * List queue entries, filterable by category / status / reviewType (ENG-90).
   * The queue is small and keyed only by candidateId, so this is a paged scan
   * with in-code filtering; records written before the category field existed
   * match `category: 'uncategorized'`.
   */
  async listCandidates(filter: {
    /** Canonical value only — parse raw input via parseHumanEvalCategoryFilter and reject nulls. */
    category?: HumanEvalCategory;
    status?: HumanEvalStatus;
    reviewType?: HumanEvalReviewType;
    limit?: number;
  } = {}): Promise<HumanEvalCandidate[]> {
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), 200);
    const categoryFilter = filter.category;

    const matches: HumanEvalCandidate[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    let pages = 0;
    const MAX_PAGES = 20;

    do {
      const result = await this.db.scan({
        TableName: HUMAN_EVAL_QUEUE_TABLE,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }).promise();

      for (const item of (result.Items || []) as HumanEvalCandidate[]) {
        if (categoryFilter !== undefined && normalizeHumanEvalCategory(item.category) !== categoryFilter) continue;
        if (filter.status !== undefined && item.status !== filter.status) continue;
        if (filter.reviewType !== undefined && item.reviewType !== filter.reviewType) continue;
        matches.push(item);
      }

      lastKey = result.LastEvaluatedKey;
      pages += 1;
    } while (lastKey && pages < MAX_PAGES);

    matches.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return matches.slice(0, limit);
  }

  /**
   * Every candidate of one review type for one user, across all scan pages (ENG-2140: the prior
   * creative for pairwise judging). Unlike `listCandidates` there is no result cap, so an older
   * match is never cut off by newer candidates of other accounts. It scans, so the only runtime
   * caller is the sampled, flag-gated pairwise judge (ENG-2192), once per judged creative.
   */
  async listCandidatesForUser(userId: string, reviewType: HumanEvalReviewType): Promise<HumanEvalCandidate[]> {
    const matches: HumanEvalCandidate[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await this.db.scan({
        TableName: HUMAN_EVAL_QUEUE_TABLE,
        FilterExpression: 'userId = :userId AND reviewType = :reviewType',
        ExpressionAttributeValues: { ':userId': userId, ':reviewType': reviewType },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }).promise();
      matches.push(...((result.Items || []) as HumanEvalCandidate[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return matches;
  }

  /**
   * Every candidate of one review type, all accounts, across all scan pages (ENG-2142: the weekly
   * calibration sampler's pool). No result cap, like `listCandidatesForUser`. Offline/cron use only: it scans.
   */
  async listCandidatesByReviewType(reviewType: HumanEvalReviewType): Promise<HumanEvalCandidate[]> {
    const matches: HumanEvalCandidate[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await this.db.scan({
        TableName: HUMAN_EVAL_QUEUE_TABLE,
        FilterExpression: 'reviewType = :reviewType',
        ExpressionAttributeValues: { ':reviewType': reviewType },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }).promise();
      matches.push(...((result.Items || []) as HumanEvalCandidate[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return matches;
  }

  private async appendFeedback(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void> {
    await this.db.update({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Key: { candidateId: candidate.candidateId },
      UpdateExpression: [
        'SET feedback = list_append(if_not_exists(feedback, :empty), :feedback)',
        '#status = :status',
        'updatedAt = :updatedAt',
      ].join(', '),
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':empty': [],
        ':feedback': [feedback],
        ':status': 'reviewed',
        ':updatedAt': feedback.createdAt,
      },
    }).promise();
  }

  private async prepareCandidateInput(
    input: CreateHumanEvalCandidateInput,
    candidateId: string,
  ): Promise<CreateHumanEvalCandidateInput> {
    const telemetryBase: UploadInlineImageContext = {
      candidateId,
      reviewType: input.reviewType,
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
    };

    const prepared: CreateHumanEvalCandidateInput = {
      ...input,
      artifactUrl: input.artifactUrl?.trim() || undefined,
      chatUrl: await this.sanitizeChatUrl(input.chatUrl, telemetryBase),
      outputSummary: redactInlineImageData(input.outputSummary),
      originalRequest: input.originalRequest ? redactInlineImageData(input.originalRequest) : undefined,
    };

    // Memoize uploads so a data URI duplicated across artifactUrl and action.artifactUrl
    // (the auto image-revision case sends the same result.imageUrl into both) only hits S3 once.
    const uploadCache = new Map<string, string>();

    prepared.artifactUrl = await this.sanitizeArtifactReference(prepared.artifactUrl, telemetryBase, uploadCache);

    // The nested action carries a second copy of the artifact (agent_mode_image_revision); run it
    // through the same upload/fail-closed guard so a raw image binary never lands in the persisted item.
    if (prepared.action?.type === 'agent_mode_image_revision' && prepared.action.artifactUrl) {
      const safeActionArtifactUrl = await this.sanitizeArtifactReference(
        prepared.action.artifactUrl.trim() || undefined,
        telemetryBase,
        uploadCache,
      );
      prepared.action = { ...prepared.action, artifactUrl: safeActionArtifactUrl };
    }

    return prepared;
  }

  // Converts a supported inline image data URI to an S3 URL, fails closed on any other data: URI or
  // upload failure, and passes through ordinary URLs. Shared by the top-level artifact and the nested
  // action artifact so neither can deliver a raw binary to Slack or persist one in the queue item.
  private async sanitizeArtifactReference(
    rawUrl: string | undefined,
    telemetryBase: UploadInlineImageContext,
    uploadCache: Map<string, string>,
  ): Promise<string | undefined> {
    if (!rawUrl) {
      return undefined;
    }

    if (isInlineImageDataUri(rawUrl)) {
      const cached = uploadCache.get(rawUrl);
      if (cached) {
        return cached;
      }

      await this.recordAssetTelemetry('human_eval_asset_inline_image_detected', telemetryBase);
      try {
        const uploaded = await this.assets.uploadInlineImage(rawUrl, telemetryBase);
        uploadCache.set(rawUrl, uploaded.url);
        await this.recordAssetTelemetry('human_eval_asset_inline_image_uploaded', {
          ...telemetryBase,
          mimeType: uploaded.mimeType,
          byteLength: uploaded.byteLength,
          artifactKey: uploaded.key,
        });
        return uploaded.url;
      } catch (err) {
        await this.recordAssetTelemetry('human_eval_asset_delivery_failed', {
          ...telemetryBase,
          reason: 'inline_image_upload_failed',
          errorClass: classifyToolErrorClass(err),
          errorMessage: errorMessage(err),
        });
        throw new Error('Human eval image artifact could not be uploaded before Slack delivery. Retry with a fetchable image URL.');
      }
    }

    if (isDataUri(rawUrl)) {
      await this.recordAssetTelemetry('human_eval_asset_delivery_failed', {
        ...telemetryBase,
        reason: 'unsupported_data_uri',
      });
      throw new Error('Human eval artifact must be a fetchable URL or supported data:image URI.');
    }

    return rawUrl;
  }

  // A chat link is never a data: URI. Drop one if present (so resolveChatUrl falls back to a real
  // session share link) rather than rendering the raw binary into Slack or storing it on the item.
  private async sanitizeChatUrl(
    chatUrl: string | undefined,
    telemetryBase: UploadInlineImageContext,
  ): Promise<string | undefined> {
    const trimmed = chatUrl?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (isDataUri(trimmed)) {
      await this.recordAssetTelemetry('human_eval_asset_delivery_failed', {
        ...telemetryBase,
        reason: 'unsupported_chat_url_data_uri',
      });
      return undefined;
    }
    return trimmed;
  }

  private async recordAssetTelemetry(eventType: HumanEvalAssetEvent, info: HumanEvalAssetTelemetryInfo): Promise<void> {
    try {
      await this.telemetry.recordAssetEvent(eventType, info);
    } catch (err) {
      console.warn('[human-eval] asset telemetry failed (swallowed):', err instanceof Error ? err.message : err);
    }
  }

  private async addFeedbackToSession(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void> {
    if (!candidate.sessionId) return;

    const reviewLabel = reviewTypeLabel(candidate.reviewType);
    const reviewerLabel = candidate.reviewer === 'fangfang' ? 'Fangfang' : 'Matt';
    const content = [
      `[Human Eval Feedback] ${reviewerLabel} reviewed ${reviewLabel}.`,
      `Feedback from ${feedback.slackUserDisplayName}: "${feedback.text}"`,
      candidate.artifactUrl ? `Reviewed artifact: ${candidate.artifactUrl}` : '',
      'Use this as human quality feedback for future work in this chat and as training signal for the workflow.',
    ].filter(Boolean).join('\n');

    try {
      await this.chatbot.addMessageToSession(candidate.sessionId, {
        role: 'system',
        content,
        metadata: {
          timestamp: feedback.createdAt,
          isContextMessage: true,
          source: 'human-eval-slack-thread',
          humanEvalCandidateId: candidate.candidateId,
          humanEvalReviewType: candidate.reviewType,
          humanEvalReviewer: candidate.reviewer,
        },
      });
    } catch (err: any) {
      console.warn('[human-eval] failed to add feedback context to session:', err?.message || err);
    }
  }

  /**
   * Whose chat produced this candidate. Matt asked for the account's email on the card: the
   * reviewer otherwise can't tell which customer an artifact belongs to without opening the
   * chat link, which is the context-free-noise complaint ENG-1853/1854 exist to fix.
   *
   * Deliberately fail-safe and resolved only for the Slack message — never let a user lookup
   * decide whether a candidate posts at all. `getUserById` is a GSI query that can throw on a
   * transient DynamoDB error; swallowing it here means the card just omits the line, instead of
   * the error bubbling into createCandidate's posting try/catch and silently costing the whole
   * notification.
   */
  private async resolveUserEmail(userId: string | undefined): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const user = await userDb.getUserById(userId);
      return user?.email || undefined;
    } catch (err: any) {
      console.warn('[human-eval] failed to resolve user email for the Slack card:', err?.message || err);
      return undefined;
    }
  }

  private buildSlackMessage(input: CreateHumanEvalCandidateInput & {
    candidateId: string;
    reviewer: HumanEvalReviewer;
    reviewerSlackUserId?: string;
    chatUrl?: string;
    normalizedCategory: HumanEvalCategory;
    userEmail?: string;
  }): string {
    const reviewerMention = input.reviewerSlackUserId
      ? `<@${input.reviewerSlackUserId}>`
      : input.reviewer === 'fangfang'
        ? 'Fangfang'
        : 'Matt';

    // Ad vs Organic Post is an image distinction (ENG-90): always tag images —
    // including the fail-open "Uncategorized" label — and tag other review
    // types only when the enqueueing flow explicitly categorized them.
    const showCategory = input.reviewType === 'creative_image'
      || input.normalizedCategory !== 'uncategorized';

    const lines = [
      `*Human eval: ${reviewTypeLabel(input.reviewType)}*`,
      showCategory ? `*Category:* ${humanEvalCategoryLabel(input.normalizedCategory)}` : '',
      `Reviewer: ${reviewerMention}`,
      input.userEmail ? `*User:* ${input.userEmail}` : '',
      '',
      input.artifactUrl ? `*Output:* <${input.artifactUrl}|open output>` : '',
      input.chatUrl ? `*Chat:* <${input.chatUrl}|open associated chat>` : '',
      input.originalRequest ? `*Ask:* ${truncate(input.originalRequest, 700)}` : '',
      `*Summary:* ${truncate(input.outputSummary, 1000)}`,
      input.action ? `*Auto-action:* ${humanEvalActionLabel(input.action)}` : '',
      '',
      'Reply in this thread with free-form feedback. Include what failed, what worked, and what would make it pass. No form needed for v0.',
      `Candidate: \`${input.candidateId}\``,
    ];

    return lines.filter((line) => line !== '').join('\n');
  }

  private async getEvalChannel(): Promise<string> {
    const setting = await this.settings.getSetting('human_eval_slack_channel');
    const channel = setting?.settingValue
      || process.env.HUMAN_EVAL_SLACK_CHANNEL
      || process.env.EVAL_QUEUE_SLACK_CHANNEL
      || process.env.SLACK_EVAL_CHANNEL;

    if (!channel?.trim()) {
      throw new Error('Human eval Slack channel is not configured');
    }

    return channel.trim();
  }

  /**
   * ENG-1854: switch for #eval-queue Slack fan-out, default ON — an explicit 'false' is an
   * unconditional kill switch. (It shipped default-off; the default was flipped back once the
   * two real noise sources — routine lead-enrichment pings and cross-path duplicates — were
   * fixed independently of this toggle.) The queue itself (creation, persistence, the admin
   * read API) is unaffected either way; this only gates whether a candidate additionally gets
   * posted to Slack. DB-backed (not an env var) so it's flippable without a redeploy, same
   * reasoning as `getEvalChannel`'s own setting above.
   *
   * Returns why (if at all) this candidate should be posted — the caller uses this to pick
   * the message format: a normal global-toggle post gets the full multi-field message, an
   * exception-list post gets a deliberately concise one (ENG-1854 item 6 — "one concise
   * reviewer assignment/link", not the same noisy format this ticket exists to quiet down).
   */
  private async slackPostingReasonFor(userId: string | undefined): Promise<'global' | 'exception' | false> {
    // Deliberately fail-safe: `settingsService.getSetting` re-throws on a DynamoDB error, and
    // this is called AFTER the candidate is already persisted (createCandidate's whole point
    // is that persistence must never depend on anything Slack-related succeeding). A transient
    // settings-lookup failure defaults to "don't post" rather than letting the exception
    // propagate out of createCandidate — which would skip the caller's own post-persist steps
    // (e.g. autoHumanEvalService's dedupe-key write) and risk a duplicate candidate on retry.
    try {
      // Round-3 review finding: an explicit 'false' here is meant to be a genuine emergency
      // stop — checked FIRST and unconditionally, so it isn't silently bypassed by any entry
      // on the exception list. The exception list's job is to keep specific accounts posting
      // through the ORDINARY default state, not to survive someone deliberately hitting the
      // kill switch. Checking exceptions first (as an earlier version of this did) would mean
      // "a single explicit false is the full rollback lever" stops being true the moment the
      // exception list is non-empty — currently harmless since it ships empty, but a real
      // footgun waiting for whenever that changes.
      const globalToggle = await this.settings.getSetting('human_eval_slack_posting_enabled');
      if (globalToggle?.settingValue === 'false') return false;

      if (userId) {
        // Now that the default is ON (below), this list's practical role has narrowed: it no
        // longer decides WHETHER a candidate posts (that already happens for everyone unless
        // the kill switch above fired) — it only selects the concise message FORMAT for
        // specific accounts, distinct from the ordinary verbose one. Kept for when a real
        // named-packet flow needs it (see the PR's own note on Haven/Every not currently
        // routing through this pipeline at all).
        const exceptions = await this.settings.getSetting('human_eval_slack_posting_exception_user_ids');
        const exceptionIds = (exceptions?.settingValue || '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        if (exceptionIds.includes(userId)) return 'exception';
      }
      // Default ON: absent, or anything other than an explicit 'false' (already handled
      // above), means posting is enabled. Flipped from the original default-off (ENG-1854's
      // initial ask) once the two real noise sources were fixed independently of this toggle —
      // the lead-enrichment anomaly gate is unconditional, so it stays quiet regardless of this
      // setting; this now only governs creative_image/landing_page (which always needed a
      // human's eyes) and any genuine lead-enrichment failures.
      return 'global';
    } catch (err: any) {
      console.warn('[human-eval] failed to resolve Slack posting toggle, defaulting to not posting:', err?.message || err);
      return false;
    }
  }

  /** ENG-1854 item 6: one line, one mention, one link — not the full field dump. */
  private buildConciseExceptionMessage(input: {
    reviewer: HumanEvalReviewer;
    reviewerSlackUserId?: string;
    chatUrl?: string;
    artifactUrl?: string;
  }): string {
    const reviewerMention = input.reviewerSlackUserId
      ? `<@${input.reviewerSlackUserId}>`
      : input.reviewer === 'fangfang'
        ? 'Fangfang'
        : 'Matt';
    const link = input.chatUrl || input.artifactUrl;
    return link
      ? `${reviewerMention} — new review ready: <${link}>`
      : `${reviewerMention} — new review ready.`;
  }

  private async getReviewerSlackUserId(reviewer: HumanEvalReviewer): Promise<string | undefined> {
    // ENG-1854: this runs before createCandidate's db.put — same fail-safe reasoning as
    // slackPostingReasonFor. Unguarded, a transient settings-lookup failure here would throw
    // out of createCandidate before the record is ever persisted, silently dropping the
    // candidate the same way the pre-PR bug did. The return type is already optional, so a
    // plain-text reviewer-name fallback in buildSlackMessage handles the missing-ID case fine.
    try {
      const settingName = reviewer === 'fangfang'
        ? 'human_eval_reviewer_fangfang_slack_user_id'
        : 'human_eval_reviewer_matt_slack_user_id';
      const envName = reviewer === 'fangfang'
        ? 'HUMAN_EVAL_FANGFANG_SLACK_USER_ID'
        : 'HUMAN_EVAL_MATT_SLACK_USER_ID';
      const setting = await this.settings.getSetting(settingName);
      return (setting?.settingValue || process.env[envName])?.trim() || undefined;
    } catch (err: any) {
      console.warn('[human-eval] failed to resolve reviewer Slack user id, continuing without it:', err?.message || err);
      return undefined;
    }
  }

  private async getCandidateIdForThread(channel: string, threadTs: string): Promise<string | null> {
    const setting = await this.settings.getSetting(this.threadMappingKey(channel, threadTs));
    return setting?.settingValue || null;
  }

  private threadMappingKey(channel: string, threadTs: string): string {
    return `human_eval_thread_${channel}_${threadTs}`;
  }

  private async resolveChatUrl(input: CreateHumanEvalCandidateInput): Promise<string | undefined> {
    if (input.chatUrl?.trim()) return input.chatUrl.trim();
    if (!input.sessionId) return undefined;

    try {
      return await this.chatbot.createOrReuseInteractiveShare(input.sessionId);
    } catch (err: any) {
      console.warn('[human-eval] failed to create interactive share link:', err?.message || err);
      return this.buildDirectChatUrl(input.sessionId);
    }
  }

  private buildDirectChatUrl(sessionId: string): string {
    const base = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    return `${base}/agent-mode/${encodeURIComponent(sessionId)}`;
  }

  private assertReviewType(reviewType: string): asserts reviewType is HumanEvalReviewType {
    if (!['creative_image', 'landing_page', 'lead_enrichment'].includes(reviewType)) {
      throw new Error('reviewType must be creative_image, landing_page, or lead_enrichment');
    }
  }
}

function buildMemoryContent(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): string {
  const reviewerLabel = candidate.reviewer === 'fangfang' ? 'Fangfang' : 'Matt';
  return [
    `Human eval feedback for ${reviewTypeLabel(candidate.reviewType)}: ${reviewerLabel} / ${feedback.slackUserDisplayName} said "${feedback.text}".`,
    candidate.originalRequest ? `Original ask: ${truncate(candidate.originalRequest, 500)}` : '',
    candidate.outputSummary ? `Reviewed output: ${truncate(candidate.outputSummary, 500)}` : '',
    'Apply this guidance when producing similar future outputs.',
  ].filter(Boolean).join(' ');
}

function reviewTypeLabel(reviewType: HumanEvalReviewType): string {
  switch (reviewType) {
    case 'creative_image':
      return 'creative image';
    case 'landing_page':
      return 'landing page';
    case 'lead_enrichment':
      return 'lead enrichment';
  }
}

function humanEvalActionLabel(action: HumanEvalAction): string {
  switch (action.type) {
    case 'agent_mode_image_revision':
      return 'revise the image in Agent Mode and send the new image back for eval';
    case 'landing_page_iteration_deploy':
      return 'iterate the landing page, deploy it, and send the live page back for eval';
    case 'lead_enrichment_rerun':
      return 'rerun lead enrichment with this feedback and send the updated results back for eval';
  }
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function isDataUri(value: string): boolean {
  return /^data:/i.test(value.trim());
}

function isInlineImageDataUri(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim());
}

function parseInlineImageDataUri(value: string): { mimeType: string; buffer: Buffer } | null {
  const match = value.trim().match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([\s\S]+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return null;

  return { mimeType, buffer };
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/jpeg':
    default:
      return 'jpg';
  }
}

function redactInlineImageData(value: string): string {
  return value.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[inline image data redacted; artifact uploaded separately]');
}

function cleanDimensions(
  dimensions: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(dimensions).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number | boolean | null>;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export const humanEvalService = new HumanEvalService();
