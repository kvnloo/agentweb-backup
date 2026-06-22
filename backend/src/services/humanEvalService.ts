import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { chatbotDb } from './chatbotService';
import {
  getSlackUserDisplayName,
  getSlackUserEmail,
  postSlackMessage,
  resolveSlackMentionsInText,
} from './slackService';
import { settingsService } from './settingsService';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
export const HUMAN_EVAL_QUEUE_TABLE = `${TABLE_PREFIX}AW-HumanEvalQueue`;

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

export interface HumanEvalCandidate {
  candidateId: string;
  reviewType: HumanEvalReviewType;
  reviewer: HumanEvalReviewer;
  reviewerSlackUserId?: string;
  status: HumanEvalStatus;
  userId?: string;
  sessionId?: string;
  agentRunId?: string;
  artifactUrl?: string;
  chatUrl?: string;
  outputSummary: string;
  originalRequest?: string;
  slackChannel: string;
  slackMessageTs: string;
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
}

interface DynamoLike {
  put(params: AWS.DynamoDB.DocumentClient.PutItemInput): { promise(): Promise<unknown> };
  get(params: AWS.DynamoDB.DocumentClient.GetItemInput): { promise(): Promise<AWS.DynamoDB.DocumentClient.GetItemOutput> };
  update(params: AWS.DynamoDB.DocumentClient.UpdateItemInput): { promise(): Promise<unknown> };
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
}

interface LearningLike {
  recordFeedback(candidate: HumanEvalCandidate, feedback: HumanEvalFeedback): Promise<void>;
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

    const slackChannel = await this.getEvalChannel();
    const reviewer = this.getReviewerForType(input.reviewType);
    const reviewerSlackUserId = await this.getReviewerSlackUserId(reviewer);
    const candidateId = uuidv4();
    const now = new Date().toISOString();
    const chatUrl = input.chatUrl || this.buildChatUrl(input.sessionId);

    const message = this.buildSlackMessage({
      ...input,
      candidateId,
      reviewer,
      reviewerSlackUserId,
      chatUrl,
    });

    const posted = await this.slack.postSlackMessage(slackChannel, message);

    const candidate: HumanEvalCandidate = {
      candidateId,
      reviewType: input.reviewType,
      reviewer,
      reviewerSlackUserId,
      status: 'pending',
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      artifactUrl: input.artifactUrl,
      chatUrl,
      outputSummary: input.outputSummary.trim(),
      originalRequest: input.originalRequest?.trim() || undefined,
      slackChannel: posted.channel || slackChannel,
      slackMessageTs: posted.ts,
      feedback: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.db.put({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Item: candidate,
      ConditionExpression: 'attribute_not_exists(candidateId)',
    }).promise();

    await this.settings.setSetting(
      this.threadMappingKey(candidate.slackChannel, candidate.slackMessageTs),
      candidate.candidateId,
      'Slack thread to human eval candidate mapping',
      'human-eval',
    );

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
    return true;
  }

  async getCandidate(candidateId: string): Promise<HumanEvalCandidate | null> {
    const result = await this.db.get({
      TableName: HUMAN_EVAL_QUEUE_TABLE,
      Key: { candidateId },
    }).promise();
    return (result.Item as HumanEvalCandidate | undefined) || null;
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

  private buildSlackMessage(input: CreateHumanEvalCandidateInput & {
    candidateId: string;
    reviewer: HumanEvalReviewer;
    reviewerSlackUserId?: string;
    chatUrl?: string;
  }): string {
    const reviewerMention = input.reviewerSlackUserId
      ? `<@${input.reviewerSlackUserId}>`
      : input.reviewer === 'fangfang'
        ? 'Fangfang'
        : 'Matt';

    const lines = [
      `*Human eval: ${reviewTypeLabel(input.reviewType)}*`,
      `Reviewer: ${reviewerMention}`,
      '',
      input.artifactUrl ? `*Output:* <${input.artifactUrl}|open output>` : '',
      input.chatUrl ? `*Chat:* <${input.chatUrl}|open associated chat>` : '',
      input.originalRequest ? `*Ask:* ${truncate(input.originalRequest, 700)}` : '',
      `*Summary:* ${truncate(input.outputSummary, 1000)}`,
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

  private async getReviewerSlackUserId(reviewer: HumanEvalReviewer): Promise<string | undefined> {
    const settingName = reviewer === 'fangfang'
      ? 'human_eval_reviewer_fangfang_slack_user_id'
      : 'human_eval_reviewer_matt_slack_user_id';
    const envName = reviewer === 'fangfang'
      ? 'HUMAN_EVAL_FANGFANG_SLACK_USER_ID'
      : 'HUMAN_EVAL_MATT_SLACK_USER_ID';
    const setting = await this.settings.getSetting(settingName);
    return (setting?.settingValue || process.env[envName])?.trim() || undefined;
  }

  private async getCandidateIdForThread(channel: string, threadTs: string): Promise<string | null> {
    const setting = await this.settings.getSetting(this.threadMappingKey(channel, threadTs));
    return setting?.settingValue || null;
  }

  private threadMappingKey(channel: string, threadTs: string): string {
    return `human_eval_thread_${channel}_${threadTs}`;
  }

  private buildChatUrl(sessionId?: string): string | undefined {
    if (!sessionId) return undefined;
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

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

export const humanEvalService = new HumanEvalService();
