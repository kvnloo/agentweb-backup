import OpenAI from "openai";
import { getAzureClient } from "../utils/llmClients";
import { meterUserUsage } from "./usageRecorderService";
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
import { getGCSPPrivateKey, getSecret } from '../utils/secretsManager';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { AgentModeService } from './agentModeService';
import { AGENT_MODE_SYSTEM_PROMPT, EMMA_SIDEBAR_ADDENDUM, getScheduledSessionOverride } from '../docs/agentModeSystemPrompt';
import { Citation, CitationRegistry, WEB_SEARCH_TOOL_NAMES, buildCitationIndexBlock } from '../utils/citations';
import { isTransientLLMError } from '../utils/agentModeErrors';
import { shrinkMessageForPersistence } from '../utils/messageSizeGuard';
import { uploadFileToS3, uploadScreenshotToS3 } from '../utils/s3Utils';
import { scanMessagesForAssets } from '../utils/scanMessagesForAssets';
import { withKeyedMutex } from '../utils/keyedMutex';
import { computeCostMicroUsd } from './usageRecorderService';
import type { CacheWriteByTtl } from '../utils/llmPricing';
import { approvalDb } from './approvalDb';
import { PendingUserQuestion } from './agentMode/core/askUserQuestion';
// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Max serialized message size for DynamoDB persistence (400KB item limit).
// Safety net in addMessagesToMessagesTable; primary truncation happens in agentModeService.
const MAX_MESSAGE_CONTENT_SIZE = 350_000;

// Tool calls that require repair for empty results (MCP PR #433 bug)
const REPAIRABLE_TOOL_CALLS = [
  'generate_image',
  'generate_video'
];

// Make sure we have a DynamoDB instance
export const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Metered Azure OpenAI client for Emma chat. Same standard deployment the
// module singleton used; usage is recorded per user/session via the factory.
function chatClient(userId?: string, sessionId?: string) {
  return getAzureClient(
    { userId, feature: "chat", sessionId },
    process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

// Metered client for embeddings (knowledge-base semantic search). Uses the
// separate EMBEDDINGS endpoint/key/api-version the module singleton used. No
// userId is in scope on this path, so usage is attributed to platform overhead.
function embeddingsClientFor() {
  return getAzureClient(
    { feature: "embeddings" },
    process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT || "text-embedding-3-large",
    {
      endpoint: process.env.AZURE_OPENAI_EMBEDDINGS_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY,
      apiVersion:
        process.env.AZURE_OPENAI_EMBEDDINGS_API_VERSION || "2024-08-01-preview",
    }
  );
}

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
  name?: string; // For tool messages
  tool_call_id?: string; // For tool messages
  tool_calls?: any[]; // For assistant messages with tool calls
  messageIndex?: number; // Index of message in the database (included when loading from DB)
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost: number;
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
    citations?: Citation[];             // ENG-351: de-duplicated web sources this message consulted (ChatGPT-style Sources UI)
  };
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
  };
  workPlan?: {
    title: string;
    steps: Array<{
      stepCount: number; // Step number starting from 1
      title: string;
      description?: string;
      status: 'pending' | 'completed' | 'skipped';
      completedAt?: string;
      notes?: string;
      requiredFunctionCalls?: string[]; // Required function names that must be called before marking complete
      skillIds?: string[]; // Skill IDs to auto-install when this step becomes active
      // Expected number of media assets (images/videos) this step must produce before
      // it may be marked completed. When set, setWorkPlanStatus blocks completion until
      // the session has produced at least this many assets — preventing a multi-image
      // step (e.g. "Generate 3 Images Per Hook — 18 total") from being marked done with
      // only a fraction generated (the xCures incident). Unset = no asset-count gate.
      expectedAssetCount?: number;
    }>;
    createdAt: string;
    updatedAt: string;
    welcomeMessage?: string; // Custom welcome message for this work plan
    autocomplete?: boolean; // When true, Emma MUST complete each step before responding to the user
  };
  contextLimitReported?: boolean; // True once a context-limit issue report has been auto-filed
  // ENG-396: the single structured question Emma is currently blocked on (if any).
  // Persisted so the answer is read STRUCTURALLY by the next tool call (never
  // re-parsed from prose) and so an unanswered gate survives run boundaries as a
  // parked pending_user_input state. Mirrors the workPlan persistence pattern.
  pendingUserQuestion?: PendingUserQuestion;
  // ENG-400: answered questions archived by questionId when they roll off the
  // live pendingUserQuestion slot (a later question replaced them). Lets a
  // write gate (checkQuestionGate) still find an earlier human answer even
  // after Emma has moved on to asking something else in the same session.
  answeredQuestions?: Record<string, PendingUserQuestion>;
  calledFunctions?: Record<string, number>; // Track count of each function call made in this session
  failedFunctions?: Record<string, number>; // Track count of each failed function call in this session
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
  llmUsagePolicyDecision?: {
    requestedModel: string | null;
    effectiveModel: string | null;
    backupModel: string | null;
    backupSource: 'user' | 'system' | null;
    modelSelection: 'honored' | 'corrected' | 'defaulted' | 'blocked';
    modelSelectionReason: string;
    usageMode: 'full_choice' | 'optimized' | 'paused';
    usagePolicyVersion: string | null;
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
    };
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
    // For simple semantic search, we'll use OpenAI embeddings
    const queryEmbeddingResponse = await embeddingsClientFor().embeddings.create({
      model: `${process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT}`,
      input: query,
      dimensions: 1536,
    });

    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;

    // Get embeddings for all chunks (in a real system, you'd cache these)
    const chunkEmbeddings = await Promise.all(
      chunks.map(async (chunk) => {
        const response = await embeddingsClientFor().embeddings.create({
          model: `${process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT}`,
          input: chunk.content,
          dimensions: 1536,
        });
        return {
          chunk,
          embedding: response.data[0].embedding,
        };
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
  /** Overall outcome of the gate for this launch attempt. */
  outcome: 'passed' | 'blocked' | 'overridden';
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
    initialState?: Partial<Pick<ChatSession, "llmModel" | "associatedSkills" | "messages">>
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

    // Update lastActiveAt on the user — only for real user sessions, not admin delegate access.
    // Fire-and-forget: don't fail session creation if this update fails.
    if (!delegateInfo?.isDelegated) {
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

      // Return session with updated messages (no need to update session table)
      return {
        ...currentSession,
        messages: [...currentMessages, message],
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

      // Return session with updated messages (no need to update session table)
      return {
        ...currentSession,
        messages: [...currentMessages, ...messages],
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
  async getChatSessionRecord(sessionId: string): Promise<ChatSession | null> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
    };

    try {
      const result = await dynamodb.get(params).promise();
      return (result.Item as ChatSession) || null;
    } catch (error) {
      console.error("Error getting chat session record:", error);
      throw error;
    }
  }

  async getChatSession(sessionId: string, consistentRead = false): Promise<ChatSession | null> {
    const session = await this.getChatSessionRecord(sessionId);

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
      const normalizedSession = {
        ...sessionWithoutMessages,
        messages,
      };

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
        const items = (result.Items as ChatSession[]) || [];
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
      const items = (result.Items as ChatSession[]) || [];
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
        allItems = allItems.concat((result.Items as ChatSession[]) || []);
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
      const sessions = (result.Items as ChatSession[]) || [];
      
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

  async updateSessionSatisfactionScore(
    sessionId: string,
    satisfactionScore: ChatSession["satisfactionScore"]
  ): Promise<ChatSession> {
    const params = {
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

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
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

  async updateSessionUserId(
    sessionId: string,
    newUserId: string
  ): Promise<ChatSession> {
    // First, get the session to verify it exists
    const session = await this.getChatSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Update the userId
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET userId = :userId, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":userId": newUserId,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating session userId:", error);
      throw error;
    }
  }

  async updateSessionInteractiveShareMetadata(
    sessionId: string,
    interactiveShareMetadata: { isActive: boolean; token?: string; sharedAt?: string; expiresAt?: string }
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
   * ENG-396/400: persist (or clear) the session's blocking AskUserQuestion.
   * Pass a PendingUserQuestion to set it (status 'awaiting' when posed,
   * 'answered' once the user selects); pass null to clear it after the
   * consumer has read the answer. Mirrors updateSessionWorkPlan — a targeted
   * SET/REMOVE so subsequent tool calls read session.pendingUserQuestion
   * directly rather than parsing prose.
   *
   * ENG-400: when posting a NEW question, if the CURRENT live slot is already
   * 'answered' (a different, earlier question), it is archived into
   * session.answeredQuestions[questionId] before being overwritten — so
   * checkQuestionGate can still find that earlier human answer by id even
   * after Emma has moved on to asking something else in the same session.
   */
  async updateSessionAskUserQuestion(
    sessionId: string,
    pendingUserQuestion: PendingUserQuestion | null,
    opts?: { failIfAwaitingExists?: boolean; requireStillAwaiting?: string },
  ): Promise<ChatSession | null> {
    // ENG-396: the one-live-question invariant. When posing a NEW awaiting question,
    // `failIfAwaitingExists` gates the write on there being no question already
    // awaiting — a settled 'answered' slot may be replaced (that's the normal
    // turn-by-turn next question). Enforced atomically so two ask_user_question
    // calls in the same turn can never both take the single slot; the loser is
    // refused (returns null) and the model asks it in a later turn.
    const guard = opts?.failIfAwaitingExists === true && pendingUserQuestion !== null;

    // Greptile P1 ("Concurrent answers overwrite selections" / "Typed messages
    // bypass answer lock"): persisting an ANSWER, or clearing an abandoned
    // question (the typed-past-a-card path), previously had no guard at all —
    // two concurrent requests (a card answer racing a typed message, or two
    // answer submissions) could both read the same 'awaiting' snapshot and the
    // later unconditional write would silently clobber or erase the earlier
    // one's result. `requireStillAwaiting` makes EITHER write (SET an answer,
    // or REMOVE/clear) optimistic-locked: it only succeeds if the question is
    // STILL exactly this one, STILL 'awaiting', at the moment of write — the
    // loser of the race gets null (refused) instead of corrupting the winner.
    const requireStillAwaiting =
      typeof opts?.requireStillAwaiting === 'string' ? opts.requireStillAwaiting : undefined;

    let updatedArchive: Record<string, PendingUserQuestion> | undefined;
    if (pendingUserQuestion !== null) {
      // A lightweight, PROJECTED read (not getChatSession — that also loads/migrates
      // messages, which this write doesn't need) of just the two fields this
      // archiving decision depends on.
      const existing = await dynamodb
        .get({
          TableName: this.tableName,
          Key: { sessionId },
          ProjectionExpression: "pendingUserQuestion, answeredQuestions",
        })
        .promise();
      const current: PendingUserQuestion | undefined = existing?.Item?.pendingUserQuestion;
      if (current && current.status === 'answered' && current.questionId !== pendingUserQuestion.questionId) {
        updatedArchive = { ...(existing?.Item?.answeredQuestions || {}), [current.questionId]: current };
      }
    }

    const params: any = pendingUserQuestion
      ? {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: updatedArchive
            ? "SET pendingUserQuestion = :pendingUserQuestion, adminListPartition = :adminListPartition, answeredQuestions = :answeredQuestions"
            : "SET pendingUserQuestion = :pendingUserQuestion, adminListPartition = :adminListPartition",
          ExpressionAttributeValues: {
            ":pendingUserQuestion": pendingUserQuestion,
            ":adminListPartition": "all",
            ...(updatedArchive ? { ":answeredQuestions": updatedArchive } : {}),
          },
          ReturnValues: "ALL_NEW",
        }
      : {
          TableName: this.tableName,
          Key: { sessionId },
          UpdateExpression: "REMOVE pendingUserQuestion",
          ReturnValues: "ALL_NEW",
        };

    if (guard) {
      params.ConditionExpression =
        "attribute_not_exists(pendingUserQuestion) OR pendingUserQuestion.#pStatus <> :awaitingStatus";
      params.ExpressionAttributeNames = { "#pStatus": "status" };
      params.ExpressionAttributeValues[":awaitingStatus"] = "awaiting";
    } else if (requireStillAwaiting) {
      params.ConditionExpression =
        "pendingUserQuestion.questionId = :requireQuestionId AND pendingUserQuestion.#pStatus = :awaitingStatus";
      params.ExpressionAttributeNames = { "#pStatus": "status" };
      // The REMOVE branch's params literal has no ExpressionAttributeValues at
      // all (nothing to reference) until a guard needs one — create it here
      // rather than assuming it exists, so a plain unconditional REMOVE keeps
      // its existing (undefined) shape when no guard applies.
      params.ExpressionAttributeValues = {
        ...(params.ExpressionAttributeValues || {}),
        ":requireQuestionId": requireStillAwaiting,
        ":awaitingStatus": "awaiting",
      };
    }

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      // A guarded write that fails the condition means either a question is
      // already awaiting (posting a new one) or this answer lost a race to a
      // concurrent one (persisting an answer) — an expected outcome, not an
      // error. Signal it with null either way.
      if ((guard || requireStillAwaiting) && (error as any)?.code === "ConditionalCheckFailedException") {
        return null;
      }
      console.error("Error updating session AskUserQuestion:", error);
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
        notes?: string;
        requiredFunctionCalls?: string[];
        skillIds?: string[];
        expectedAssetCount?: number;
      }>;
      createdAt: string;
      updatedAt: string;
      welcomeMessage?: string;
      autocomplete?: boolean;
    }
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    // Validate stepCount - must be sequential starting from 1 (index+1)
    for (let i = 0; i < workPlan.steps.length; i++) {
      const expectedStepCount = i + 1;
      if (workPlan.steps[i].stepCount !== expectedStepCount) {
        throw new Error(
          `Invalid stepCount at index ${i}: expected ${expectedStepCount} but got ${workPlan.steps[i].stepCount}. ` +
          `Steps must be numbered sequentially starting from 1 (stepCount must equal index+1).`
        );
      }
    }

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
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: policyDecision
        ? "SET llmModel = :llmModel, llmUsagePolicyDecision = :policyDecision, adminListPartition = :adminListPartition"
        : "SET llmModel = :llmModel, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":llmModel": llmModel,
        ...(policyDecision ? { ":policyDecision": policyDecision } : {}),
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

  async incrementCalledFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    // Get current session to retrieve existing calledFunctions
    const session = await this.getChatSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Merge the new counts with existing counts
    const currentCounts = session.calledFunctions || {};
    const updatedCounts = { ...currentCounts };
    
    for (const [functionName, count] of Object.entries(functionCounts)) {
      updatedCounts[functionName] = (updatedCounts[functionName] || 0) + count;
    }

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET calledFunctions = :calledFunctions, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":calledFunctions": updatedCounts,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error incrementing called functions:", error);
      throw error;
    }
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

  async decrementCalledFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    // Get current session to retrieve existing calledFunctions
    const session = await this.getChatSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Decrement the counts
    const currentCounts = session.calledFunctions || {};
    const updatedCounts = { ...currentCounts };
    
    for (const [functionName, count] of Object.entries(functionCounts)) {
      updatedCounts[functionName] = (updatedCounts[functionName] || 0) - count;
    }

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET calledFunctions = :calledFunctions, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":calledFunctions": updatedCounts,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error decrementing called functions:", error);
      throw error;
    }
  }

  async updateCalledFunctions(
    sessionId: string,
    calledFunctions: Record<string, number>
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET calledFunctions = :calledFunctions, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":calledFunctions": calledFunctions,
        ":adminListPartition": "all",
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error updating called functions:", error);
      throw error;
    }
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
  async createOrReuseInteractiveShare(sessionId: string, expirationDays?: number | null): Promise<string> {
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

      // Check if there's already an active interactive share
      if (session.interactiveShareMetadata?.isActive && session.interactiveShareMetadata?.token) {
        // If this caller wants no timed expiry but the stored token carries one —
        // e.g. an admin review link (45d) or a legacy 7d link — strip it. Links
        // shared out via email/slack/oncall must never expire regardless of who
        // minted the token first.
        if (!hasTimedExpiry && session.interactiveShareMetadata.expiresAt) {
          // Best-effort: a failed strip must not lose the working ishare link
          // (the outer catch would otherwise downgrade it to a login-required
          // /agent-mode URL). Worst case the link keeps its existing expiry and
          // a later send strips it.
          try {
            const { expiresAt, ...withoutExpiry } = session.interactiveShareMetadata;
            await this.updateSessionInteractiveShareMetadata(sessionId, withoutExpiry);
          } catch (stripError) {
            console.error(`Error stripping expiry from reused interactive share for session ${sessionId}:`, stripError);
          }
        }
        const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
        return `${customerFrontendUrl}/ishare/${sessionId}?conversable=${session.interactiveShareMetadata.token}`;
      }

      // Create a new interactive share
      const crypto = require('crypto');
      const conversableToken = crypto.randomBytes(32).toString('hex');

      // Only write expiresAt when the caller explicitly requested a timed expiry.
      const interactiveShareMetadata: { isActive: boolean; token: string; sharedAt: string; expiresAt?: string } = {
        isActive: true,
        token: conversableToken,
        sharedAt: new Date().toISOString(),
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
          allSessions = allSessions.concat(result.Items as ChatSession[]);
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
  ): Promise<{ sessions: ChatSession[]; lastEvaluatedKey?: AWS.DynamoDB.DocumentClient.Key }> {
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
          accumulated.push(...((result.Items as ChatSession[]) || []));
          currentKey = result.LastEvaluatedKey;
        } while (currentKey);

        return {
          sessions: accumulated.slice(0, limit),
          lastEvaluatedKey: undefined,
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
        accumulated.push(...((result.Items as ChatSession[]) || []));
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
  context: string = ""
) {
  const usage = response.usage;
  if (!usage) return;

  const u: any = usage;
  const cost = calculateCost(
    usage.prompt_tokens,
    usage.completion_tokens,
    response.model,
    u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0,
    u.cache_creation_input_tokens || 0,
    u.cache_creation_by_ttl
  );

  console.log(
    `[Token Usage] Model: ${response.model} | Prompt: ${
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

    // Search both knowledge bases in parallel
    const [publicResults, privateResults] = await Promise.all([
      publicClient.search({ ...searchRequest, servingConfig: publicServingConfig }),
      privateClient.search({ ...searchRequest, servingConfig: privateServingConfig })
    ]);

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

    // Get messages for OpenAI
    // Always inject the current system prompt fresh (ignoring the stale stored version)
    // so that DynamoDB overrides and prompt updates take effect immediately for all sessions.
    const freshSystemPrompt = portalType === "customer" ? getEmmaSystemContext(session.sessionType, orgRole) : null;
    const messages = [...session.messages];
    if (freshSystemPrompt) {
      const firstSystemIdx = messages.findIndex((m) => m.role === "system");
      if (firstSystemIdx >= 0) {
        messages[firstSystemIdx] = { ...messages[firstSystemIdx], content: freshSystemPrompt };
      } else {
        messages.unshift({ role: "system", content: freshSystemPrompt, metadata: { timestamp: new Date().toISOString() } });
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
      const workPlanMessages = AgentModeService.buildWorkPlanContextMessages(session.workPlan, undefined, false);
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
    let agentModeService: AgentModeService | null = null;
    let toolDefinitions: any[] = [];

    if (portalType === 'customer' || (portalType as string) === 'emma-sidebar' || isDelegatedAdmin) {
      try {
        // Initialize AgentModeService to access tool registry and executeTool
        agentModeService = new AgentModeService();
        await agentModeService.initialize();

        // Base tools: foundation tools (always available in agent mode) + Emma-specific extras
        // Only include customer-specific tools when on the customer portal or emma-sidebar
        const isCustomerContext = (portalType as string) === 'customer' || (portalType as string) === 'emma-sidebar';
        const toolsToInclude = new Set<string>(isCustomerContext ? [
          ...AgentModeService.FOUNDATION_TOOLS,
          'read_page_source',
          'enrich_leads_preview', 'enrich_leads_execute',
          'save_browser_cookies', 'load_browser_cookies', 'clear_browser_cookies',
          'search_user_guide',
          'report_product_issues',
          'get_temp_email', 'check_temp_inbox',
          'get_test_account', 'save_test_account', 'list_test_accounts',
        ] : []);

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
            'crm':              ['get_lead_lists', 'create_lead_list', 'add_leads_to_list', 'get_leads', 'search_leads', 'get_lead_details', 'update_lead', 'delete_leads', 'update_lead_list', 'delete_lead_list', 'update_lead_status', 'get_lead_list_statuses', 'configure_lead_statuses', 'get_lead_engagements', 'add_lead_engagement', 'send_email_to_lead', 'update_email_draft_for_lead'],
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
            'seo':              ['get_seo_metrics', 'get_website_analytics', 'get_clarity_metrics'],
            'blog':             ['create_blog_article', 'publish_blog_article', 'list_cms_categories', 'repair_blog_article', 'get_visual_context'],
            'agent-mode?tab=scheduled': ['list_scheduled_chats', 'manage_scheduled_chat', 'test_scheduled_chat', 'get_scheduled_chat_test_history', 'submit_scheduled_chat_variables'],
          };
          if (pageToolMap[pageKey]) {
            pageToolMap[pageKey].forEach(t => toolsToInclude.add(t));
          }
        }

        // Add admin tools when user is admin (direct or delegated)
        if (isDelegatedAdmin) {
          const adminToolNames = agentModeService.getAdminToolNames();
          adminToolNames.forEach(t => toolsToInclude.add(t));
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

        // Expand the tool set with any skills installed on this session
        // (session.associatedSkills). Without this, skills installed via Emma's
        // install_skills tool — or auto-installed when a work plan template is
        // launched (launch_predefined_work_plan) — would have no effect on Emma's tool list,
        // so the plan's required tools would never become available. This mirrors
        // Agent Mode, which resolves a session's installed skills into tool names.
        const sessionSkillIds = Array.isArray(session.associatedSkills) ? session.associatedSkills : [];
        if (sessionSkillIds.length > 0) {
          try {
            const { resolveSkillsToToolNames } = await import('./subscriptionService');
            const skillToolNames = await resolveSkillsToToolNames(sessionSkillIds);
            if (skillToolNames.includes('*')) {
              // Wildcard: every registered Emma/MCP tool becomes available.
              emmaToolRegistry.getToolNames().forEach(t => toolsToInclude.add(t));
              mcpToolRegistry.getToolNames().forEach(t => toolsToInclude.add(t));
            } else {
              skillToolNames.forEach(t => toolsToInclude.add(t));
            }
          } catch (skillErr) {
            console.error('[generateChatResponse] Error resolving session skills to tools:', skillErr);
          }
        }

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

    const isGeminiModel = model ? model.toLowerCase().includes('gemini') : false;
    // Match 'claude' or 'anthropic.' prefixed Bedrock IDs (e.g. anthropic.claude-3-5-sonnet-20241022)
    // Deliberately excludes generic 'sonnet' to avoid false positives on unrelated model names.
    const isClaudeModel = model ? (model.toLowerCase().includes('claude') || model.startsWith('anthropic.')) : false;

    // Select the active client:
    // - Claude/Bedrock: use agentModeService.getBedrockClient() which returns an
    //   OpenAI-compatible wrapper that fully supports tool calling via ChatBedrockConverse.
    // - Gemini: use agentModeService.getGeminiClient() which returns an
    //   OpenAI-compatible wrapper that supports tool calling.
    // - Azure OpenAI (default): use the standard OpenAI SDK client.
    const activeDeployment = isClaudeModel ? model! : (model || process.env.AZURE_OPENAI_DEPLOYMENT || '');
    let activeClient: any;

    if (isClaudeModel || isGeminiModel) {
      if (!agentModeService) {
        throw new Error('AgentModeService not initialized');
      }
    }

    // ENG-1134: NONE of these clients charges the quota. The llmClients factories
    // fire `recordUsage` only (see fireRecord) — a ledger row, no deduction — and
    // the Bedrock/Gemini wrappers from agentModeService do not meter at all.
    // Message persistence used to be the single charge point for every Emma path,
    // so removing it (it double-charged agent mode) would have left Emma spending
    // for free on all three providers.
    //
    // So Emma meters explicitly below, for every provider. The Azure client is
    // therefore requested UN-metered: leaving its factory recording while we also
    // meter here would write two ledger rows for one call, trading a missing
    // charge for a doubled record.

    if (isClaudeModel) {
      activeClient = await agentModeService!.getBedrockClient(model!);
    } else if (isGeminiModel) {
      activeClient = await agentModeService!.getGeminiClient();
    } else {
      // model specified → that Azure deployment; otherwise the default
      // deployment (what the module singleton used). Metered via the factory.
      activeClient = getAzureClient(
        { userId, feature: "chat", sessionId },
        model || process.env.AZURE_OPENAI_DEPLOYMENT,
        // Un-metered: the meter below is the single record-and-charge point.
        { metered: false }
      );
    }

    // Helper: Sleep function for exponential backoff
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    while (iteration < MAX_ITERATIONS) {
      console.log(`[generateChatResponse] Iteration ${iteration + 1}`);

      // Trim large old tool results to prevent context window overflow
      const trimmedMessages = trimToolMessagesForContext(messages);

      // Generate response using OpenAI (with tools if available)
      const llmStartMs = Date.now();
      let response: any;
      const maxAttempts = 3;
      const baseDelayMs = 2000;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          response = await activeClient.chat.completions.create({
            model: activeDeployment,
            messages: trimmedMessages.map(({ role, content, name, tool_call_id, tool_calls }: any) => {
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
        // Add tools only for customer portal with tools loaded
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions, tool_choice: 'auto' } : {})
          });
          break; // Success, break the retry loop
        } catch (error) {
          const isLastAttempt = attempt >= maxAttempts;
          if (!isTransientLLMError(error) || isLastAttempt) {
            throw error;
          }
          const jitterMs = Math.floor(Math.random() * 500);
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitterMs;
          console.warn(`[generateChatResponse] Rate limit/transient error for model "${activeDeployment}", attempt ${attempt}/${maxAttempts}. Waiting ${delayMs}ms before retry...`);
          await sleep(delayMs);
        }
      }

      const llmDurationMs = Date.now() - llmStartMs;
      const responseMessage = response.choices[0]?.message;
      if (!responseMessage) {
        throw new Error("No response from LLM");
      }

      // Log token usage for this iteration
      logTokenUsage(
        response,
        `Iteration ${iteration + 1}${contextInfo ? `, used ${contextInfo.length} chars of context` : ''}`
      );

      // ENG-1134: meter this turn for the clients that do not meter themselves.
      // Runs per iteration, because each loop pass is a separate billable call —
      // metering only the final one would undercount every tool-using turn.
      // Fire-and-forget and fail-open by contract, like every other meter.
      {
        // Tokens are read exactly the way callLLM reads them, NOT via
        // meterUsageFromResponse. That helper dispatches on response shape, and
        // the Bedrock Converse wrapper answers in OpenAI shape — so it would take
        // normalizeOpenAIUsage, which only knows `prompt_tokens_details.cached_tokens`
        // and would silently record Bedrock's cache tokens as zero. Cache is ~73%
        // of traffic, so that would under-count this spend by roughly 4x, in the
        // very ledger the cost cap is about to be enforced against.
        const u: any = response?.usage;
        if (u) {
          meterUserUsage({
            userId,
            sessionId,
            model: activeDeployment,
            provider: isClaudeModel ? 'bedrock' : isGeminiModel ? 'gemini' : 'azure-openai',
            feature: 'chat',
            // ENG-1251: response.id is stable across a retried/re-processed
            // response and distinct across real calls — closes the "retries
            // defeat charge dedup" Greptile P1 for this iteration's charge.
            eventId: typeof response?.id === 'string' ? response.id : undefined,
            inputTokens: u.prompt_tokens || 0,
            outputTokens: u.completion_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0,
            cacheWriteTokens: u.cache_creation_input_tokens || 0,
            // ENG-893: bill writes at the TTL Bedrock actually applied.
            cacheWriteByTtl: u.cache_creation_by_ttl,
          });
        }
      }

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
        // No tool calls - we're done
        iterationTimings.push({ iteration: iteration + 1, llmDurationMs, toolNames: [] });
        finalAssistantMessage = responseMessage.content || "I apologize, but I was unable to generate a response.";
        finalUsageData = logTokenUsage(response, "Final response");
        break;
      }

      console.log(`[generateChatResponse] Executing ${responseMessage.tool_calls.length} tool calls`);

      for (const toolCall of responseMessage.tool_calls) {
        let functionArgs: any;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
          console.log(`[generateChatResponse] Executing tool: ${toolCall.function.name}`, functionArgs);
          onToolStart?.(toolCall.function.name);
          if (!agentModeService) throw new Error("AgentModeService not initialized");
          const extraContext: Record<string, any> = {};
          if (socketId) extraContext.socketId = socketId;
          if (isDelegatedAdmin) extraContext.isDelegatedAdmin = true;
          if (isDelegatedAdmin && adminEmail) extraContext.adminEmail = adminEmail;
          const result = await agentModeService.executeTool(response.model, toolCall.function.name, functionArgs, userId!, sessionId, false, Object.keys(extraContext).length ? extraContext : undefined);
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
