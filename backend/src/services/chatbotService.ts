import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { getGuide } from "../controllers/guide";
import { getReleases } from "../controllers/release";
import { getApiDocs } from "../controllers/api";
import { getUserGuide } from "../controllers/user-guide";
import { getUserReleaseNotes } from "../controllers/docsController";
import { Request, Response } from "express";
import { EngineServiceClient } from '@google-cloud/discoveryengine';
import { Storage } from '@google-cloud/storage';
import { SearchServiceClient, protos } from '@google-cloud/discoveryengine';
import { taskDb } from '../services/db';
import { getGCSPPrivateKey } from '../utils/secretsManager';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Make sure we have a DynamoDB instance
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Initialize Azure OpenAI client
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: {
    "api-version": process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
  },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

// Separate client for embeddings
const embeddingsClient = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY,
  baseURL: `${
    process.env.AZURE_OPENAI_EMBEDDINGS_ENDPOINT
  }/openai/deployments/${
    process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT || "text-embedding-3-large"
  }`,
  defaultQuery: {
    "api-version":
      process.env.AZURE_OPENAI_EMBEDDINGS_API_VERSION || "2024-08-01-preview",
  },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY },
});

// Interface for chat messages
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string; // Add direct timestamp field
  name?: string; // For tool messages
  tool_call_id?: string; // For tool messages
  tool_calls?: any[]; // For assistant messages with tool calls
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
    portalType?: "customer" | "partner" | "genius" | "agent";
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
  portalType?: "customer" | "partner" | "genius" | "agent"; // Added portalType to session
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
    }>;
    createdAt: string;
    updatedAt: string;
    welcomeMessage?: string; // Custom welcome message for this work plan
    autocomplete?: boolean; // When true, Emma MUST complete each step before responding to the user
  };
  calledFunctions?: Record<string, number>; // Track count of each function call made in this session
  favorites?: Record<string, boolean>; // Track favorited assets by URL (key: assetUrl, value: true if favorited)
  archives?: Record<string, boolean>; // Track archived assets by URL (key: assetUrl, value: true if archived)
  sessionType?: "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation"; // Type of session based on how it was created
  llmModel?: string; // Selected LLM model for this session
}

// Interface for context chunks
export interface ContextChunk {
  id: string;
  content: string;
  metadata: {
    source: string;
    taskId?: string;
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
    const queryEmbeddingResponse = await embeddingsClient.embeddings.create({
      model: `${process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT}`,
      input: query,
      dimensions: 1536,
    });

    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;

    // Get embeddings for all chunks (in a real system, you'd cache these)
    const chunkEmbeddings = await Promise.all(
      chunks.map(async (chunk) => {
        const response = await embeddingsClient.embeddings.create({
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
    portalType?: "customer" | "partner" | "genius" | "agent",
    pageIdentifier?: string,
    selectedStartupId?: string,
    workflowId?: string,
    executionId?: string,
    emailCampaignTaskId?: string,
    sessionType?: "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation"
  ): Promise<ChatSession> {
    const sessionId = uuidv4();
    const timestamp = new Date().toISOString();

    const selectedSystemMessage =
      portalType === "customer" ? emmaSystemMessage :
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
      return chatSession;
    } catch (error) {
      console.error("Error creating chat session:", error);
      throw error;
    }
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
        const writeRequests = batch.map((message, index) => ({
          PutRequest: {
            Item: {
              sessionId,
              messageIndex: startIndex + i + index,
              message,
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

  async addMessageToSession(
    sessionId: string,
    message: ChatMessage
  ): Promise<ChatSession> {
    // Check if session exists
    const currentSession = await this.getChatSession(sessionId);
    if (!currentSession) {
      throw new Error('Session not found');
    }

    // Get current message count from AW-ChatMessages
    const currentMessages = await this.getMessagesFromMessagesTable(sessionId);
    const currentMessageCount = currentMessages.length;

    // Check if adding this message would exceed the limit
    if (currentMessageCount >= MAX_MESSAGE_SIZE_PER_SESSION) {
      throw new Error(`SESSION_MESSAGE_LIMIT_EXCEEDED: This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`);
    }

    const messageIndex = currentMessageCount;

    // Add message to AW-ChatMessages table
    await this.addMessagesToMessagesTable(sessionId, [message], messageIndex);

    // Return session with updated messages (no need to update session table)
    return {
      ...currentSession,
      messages: [...currentMessages, message],
    };
  }

  async addMessagesToSession(
    sessionId: string,
    messages: ChatMessage[]
  ): Promise<ChatSession> {
    if (messages.length === 0) {
      return (await this.getChatSession(sessionId))!;
    }

    // Check if session exists
    const currentSession = await this.getChatSession(sessionId);
    if (!currentSession) {
      throw new Error('Session not found');
    }

    // Get current message count from AW-ChatMessages
    const currentMessages = await this.getMessagesFromMessagesTable(sessionId);
    const currentMessageCount = currentMessages.length;

    // Check if adding these messages would exceed the limit
    const totalMessageCount = currentMessageCount + messages.length;
    if (totalMessageCount > MAX_MESSAGE_SIZE_PER_SESSION) {
      throw new Error(`SESSION_MESSAGE_LIMIT_EXCEEDED: Adding ${messages.length} message(s) would exceed the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages per session (current: ${currentMessageCount}). Please start a new session to continue the conversation.`);
    }

    const messageIndex = currentMessageCount;

    // Add messages to AW-ChatMessages table
    await this.addMessagesToMessagesTable(sessionId, messages, messageIndex);

    // Return session with updated messages (no need to update session table)
    return {
      ...currentSession,
      messages: [...currentMessages, ...messages],
    };
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
      const result = await dynamodb.query(params).promise();
      return result.Count || 0;
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

  // Get messages from AW-ChatMessages table
  private async getMessagesFromMessagesTable(sessionId: string): Promise<ChatMessage[]> {
    const params = {
      TableName: this.messagesTableName,
      KeyConditionExpression: "sessionId = :sessionId",
      ExpressionAttributeValues: {
        ":sessionId": sessionId,
      },
      ScanIndexForward: true, // Sort by messageIndex ascending
    };

    try {
      const result = await dynamodb.query(params).promise();
      if (!result.Items || result.Items.length === 0) {
        return [];
      }
      // Sort by messageIndex and extract messages
      const messages = result.Items
        .sort((a, b) => a.messageIndex - b.messageIndex)
        .map((item) => item.message as ChatMessage);
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
              message,
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

  async getChatSession(sessionId: string): Promise<ChatSession | null> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
    };

    try {
      const result = await dynamodb.get(params).promise();
      const session = (result.Item as ChatSession) || null;
      
      if (!session) {
        return null;
      }

      // Check if messages exist in AW-ChatMessages
      let messages = await this.getMessagesFromMessagesTable(sessionId);

      // If no messages in AW-ChatMessages but messages exist in session record, migrate them
      if (messages.length === 0 && session.messages && session.messages.length > 0) {
        console.log(`Migrating ${session.messages.length} messages from session record to AW-ChatMessages for session ${sessionId}`);
        await this.migrateMessagesToMessagesTable(sessionId, session.messages);
        messages = session.messages; // Use the migrated messages
      } else if (messages.length > 0) {
        // Messages exist in AW-ChatMessages, use those instead
        console.log(`Using ${messages.length} messages from AW-ChatMessages for session ${sessionId}`);
      }

      // Remove messages from session object and replace with messages from messages table
      // This ensures we always return the correct format from the messages table
      const { messages: _, ...sessionWithoutMessages } = session;
      return {
        ...sessionWithoutMessages,
        messages,
      };
    } catch (error) {
      console.error("Error getting chat session:", error);
      throw error;
    }
  }

  async getUserSessions(
    userId: string,
    portalType?: "customer" | "partner" | "genius" | "agent",
    limit?: number,
    sortDescending: boolean = true,
    lastEvaluatedKey?: string
  ): Promise<{ sessions: ChatSession[], lastEvaluatedKey?: any }> {
    console.log(
      `Getting chat sessions for user: ${userId} from table: ${this.tableName}, portalType: ${portalType || 'all'}, limit: ${limit || 'unlimited'}`
    );

    const params: any = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };

    // Add portal type filter if specified
    if (portalType) {
      params.FilterExpression = 'portalType = :portalType';
      params.ExpressionAttributeValues[':portalType'] = portalType;
    }

    // Add limit if specified
    if (limit) {
      params.Limit = limit;
    }

    // Add scan index forward for sorting (false = descending, true = ascending)
    // Note: DynamoDB UserIdIndex doesn't support sorting by updatedAt, so we'll sort in memory
    params.ScanIndexForward = false; // Always get in consistent order

    // Add lastEvaluatedKey if provided for pagination
    if (lastEvaluatedKey) {
      try {
        params.ExclusiveStartKey = JSON.parse(lastEvaluatedKey);
      } catch (error) {
        console.error("Invalid lastEvaluatedKey format:", error);
        throw new Error("Invalid pagination key");
      }
    }

    try {
      const result = await dynamodb.query(params).promise();
      let sessions = (result.Items as ChatSession[]) || [];
      
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
        lastEvaluatedKey: result.LastEvaluatedKey
      };
    } catch (error) {
      console.error("Error getting user chat sessions:", error);
      throw error;
    }
  }

  async getUserSessionCount(userId: string, portalType?: "customer" | "partner" | "genius" | "agent"): Promise<number> {
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
  async getArchivedSessions(userId?: string, portalType?: "customer" | "partner" | "genius" | "agent"): Promise<ChatSession[]> {
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
    const timestamp = new Date().toISOString();
    
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET archived = :archived, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":archived": true,
        ":updatedAt": timestamp,
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
        "SET pageContent = :pageContent, contextChunks = :contextChunks, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":pageContent": pageContent,
        ":contextChunks": contextChunks,
        ":updatedAt": timestamp,
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

  async updateSessionTitle(
    sessionId: string,
    title: string
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET title = :title, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":title": title,
        ":updatedAt": timestamp,
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

  async updateSessionPortalType(
    sessionId: string,
    portalType: "customer" | "partner" | "genius" | "agent"
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
      sessionId,
      },
      UpdateExpression:
        "SET portalType = :portalType, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":portalType": portalType,
        ":updatedAt": timestamp,
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
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET selectedStartupId = :selectedStartupId, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":selectedStartupId": selectedStartupId,
        ":updatedAt": timestamp,
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
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET shareMetadata = :shareMetadata, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":shareMetadata": shareMetadata,
        ":updatedAt": timestamp,
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
    const timestamp = new Date().toISOString();

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
      UpdateExpression: "SET userId = :userId, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":userId": newUserId,
        ":updatedAt": timestamp,
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
    interactiveShareMetadata: { isActive: boolean; token?: string; sharedAt?: string }
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET interactiveShareMetadata = :interactiveShareMetadata, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":interactiveShareMetadata": interactiveShareMetadata,
        ":updatedAt": timestamp,
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

  async updateSessionWorkPlan(
    sessionId: string,
    workPlan: {
      title: string;
      steps: Array<{
        stepCount: number;
        title: string;
        description?: string;
        status: 'pending' | 'completed' | 'skipped';
        completedAt?: string;
        notes?: string;
        requiredFunctionCalls?: string[];
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
      UpdateExpression: "SET workPlan = :workPlan, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":workPlan": validatedWorkPlan,
        ":updatedAt": timestamp,
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

  async updateSessionLlmModel(
    sessionId: string,
    llmModel: string
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET llmModel = :llmModel, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":llmModel": llmModel,
        ":updatedAt": timestamp,
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

  async incrementCalledFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

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
      UpdateExpression: "SET calledFunctions = :calledFunctions, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":calledFunctions": updatedCounts,
        ":updatedAt": timestamp,
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

  async decrementCalledFunctions(
    sessionId: string,
    functionCounts: Record<string, number>
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

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
      UpdateExpression: "SET calledFunctions = :calledFunctions, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":calledFunctions": updatedCounts,
        ":updatedAt": timestamp,
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
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression: "SET calledFunctions = :calledFunctions, updatedAt = :updatedAt, adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":calledFunctions": calledFunctions,
        ":updatedAt": timestamp,
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
  async createOrReuseInteractiveShare(sessionId: string): Promise<string> {
    try {
      // First, get the current session to check if it already has an interactive share
      const session = await this.getChatSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Check if there's already an active interactive share
      if (session.interactiveShareMetadata?.isActive && session.interactiveShareMetadata?.token) {
        const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
        return `${customerFrontendUrl}/ishare/${sessionId}?conversable=${session.interactiveShareMetadata.token}`;
      }

      // Create a new interactive share
      const crypto = require('crypto');
      const conversableToken = crypto.randomBytes(32).toString('hex');
      
      const interactiveShareMetadata = {
        isActive: true,
        token: conversableToken,
        sharedAt: new Date().toISOString()
      };
      
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
    lastEvaluatedKey?: AWS.DynamoDB.DocumentClient.Key
  ): Promise<{ sessions: ChatSession[]; lastEvaluatedKey?: AWS.DynamoDB.DocumentClient.Key }> {
    const params: AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: this.tableName,
      IndexName: "AdminUpdatedAtIndex",
      KeyConditionExpression: "adminListPartition = :adminListPartition",
      ExpressionAttributeValues: {
        ":adminListPartition": "all",
      },
      Limit: limit,
      ScanIndexForward: false,
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    try {
      const result = await dynamodb.query(params).promise();
      return {
        sessions: (result.Items as ChatSession[]) || [],
        lastEvaluatedKey: result.LastEvaluatedKey,
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
          ":message": updatedMessage,
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
async function loadKnowledgeBase(): Promise<void> {
  const endpoints = [
    { controller: getGuide, source: "guide" },
    { controller: getReleases, source: "release" },
    { controller: getApiDocs, source: "api" },
    { controller: getUserGuide, source: "user-guide" },
    { controller: getUserReleaseNotes, source: "user-release" },
  ];

  const chunks: ContextChunk[] = [];
  let chunkId = 0;

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

        if (endpoint.source === "guide" || endpoint.source === "api") {
          for (const section of mockResponse.data.data) {
            content += `${section.title}\n`;
            for (const paragraph of section.content) {
              content += `${paragraph}\n`;
            }
            if (section.subsections) {
              for (const subsection of section.subsections) {
                content += `${subsection.title}\n`;
                for (const paragraph of subsection.content) {
                  content += `${paragraph}\n`;
                }
              }
            }
            content += "\n";
          }
        } else if (endpoint.source === "user-guide") {
          for (const section of mockResponse.data.data) {
            content += `${section.title}\n`;
            for (const paragraph of section.content) {
              content += `${paragraph}\n`;
            }
            if (section.subsections) {
              for (const subsection of section.subsections) {
                content += `${subsection.title}\n`;
                for (const paragraph of subsection.content) {
                  content += `${paragraph}\n`;
                }
              }
            }
            content += "\n";
          }
        } else if (endpoint.source === "user-release") {
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

// Load knowledge base on startup and refresh periodically
loadKnowledgeBase().catch((error) => {
  console.error("Error loading knowledge base:", error);
});

// Refresh knowledge base every hour
setInterval(() => {
  loadKnowledgeBase().catch((error) => {
    console.error("Error refreshing knowledge base:", error);
  });
}, 60 * 60 * 1000);

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

Be helpful, concise, and accurate. If you don't know the answer, suggest the user join our Discord community for human support: <a href="${
  process.env.DISCORD_INVITE_URL || "https://discord.gg/kP2u6Wf9KQ"
}" target="_blank">Discord community</a>`;

const emmaSystemMessage = `You are Emma, a helpful 24/7 marketing operator assistant for AgentWeb's Customer Portal. AgentWeb is a powerful web automation platform.

Your primary functions are to help users with market research, campaign planning and optimization, and tracking performance metrics. 

Today's date is ${new Date().toISOString().split("T")[0]}.

I will provide you with relevant information from the Customer Portal User Guide to help answer questions. Please use this information when responding to user queries.

When appropriate, you can suggest users explore specific features of the portal mentioned in the guide.

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
<p>To get started with market research, you can ask me things like:</p>
<ul>
<li>"Emma, research the latest trends in sustainable packaging."</li>
<li>"Emma, help me plan a social media campaign for a new product launch."</li>
<li>"Emma, what are the key performance metrics for my current email campaign?"</li>
</ul>

Be helpful, concise, and accurate. If you don't know the answer or the request is outside your marketing operator functions, suggest the user join our Discord community for human support: <a href="${
  process.env.DISCORD_INVITE_URL || "https://discord.gg/kP2u6Wf9KQ"
}" target="_blank">Discord community</a>`;

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

Be helpful, concise, and accurate. Focus on actionable growth marketing advice. If you don't know the answer, suggest the user join our Discord community for human support: <a href="${
  process.env.DISCORD_INVITE_URL || "https://discord.gg/kP2u6Wf9KQ"
}" target="_blank">Discord community</a>`;


// Helper function to calculate token cost
function calculateCost(
  promptTokens: number,
  completionTokens: number,
  model: string
): number {
  // Azure OpenAI pricing per 1K tokens (as of 2024)
  const prices = {
    "gpt-4o": {
      prompt: 0.025,
      completion: 0.0125,
    },
    "gpt-4.1": {
      prompt: 0.02,
      completion: 0.005,
    },
  };

  // Get model pricing or return 0 if model not found
  let pricing;
  const modelLower = model.toLowerCase();
  if (modelLower.includes("gpt-4o")) {
    pricing = prices["gpt-4o"];
  } else if (modelLower.includes("gpt-4.1")) {
    pricing = prices["gpt-4.1"];
  } else {
    console.log(`Unknown model ${model}, cost calculation not available`);
    return 0;
  }

  return (
    (promptTokens / 1000) * pricing.prompt +
    (completionTokens / 1000) * pricing.completion
  );
}

// Helper function to log token usage
function logTokenUsage(
  response: OpenAI.Chat.ChatCompletion,
  context: string = ""
) {
  const usage = response.usage;
  if (!usage) return;

  const cost = calculateCost(
    usage.prompt_tokens,
    usage.completion_tokens,
    response.model
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
    // Initialize the Search Service clients
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

      for (const segment of structData.fields.extractive_segments.listValue.values) {
        if (!segment.structValue?.fields?.content?.stringValue) {
          continue;
        }

        const content = segment.structValue.fields.content.stringValue;
        results.push({
          id: `kb-public-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          content: content,
          metadata: {
            source: 'public-knowledge-base'
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

      // Extract taskId from the link
      const link = structData.fields?.link?.stringValue;
      if (!link) continue;

      // Extract taskId from the link path (e.g., gs://bucket/tasks/1740437136262/knowledge-base.txt)
      const taskIdMatch = link.match(/\/tasks\/(\d+)\//);
      if (!taskIdMatch) continue;

      const taskId = taskIdMatch[1];
      
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
          content: content,
          metadata: {
            source: 'private-knowledge-base',
            taskId: taskId
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

// Update generateChatResponse to use platform knowledge base when needed
export async function generateChatResponse(
  sessionId: string,
  userMessage: string,
  currentUrl?: string,
  pageContent?: string,
  portalType: "customer" | "partner" = "partner",
  userId?: string
): Promise<string> {
  try {
    const timestamp = new Date().toISOString();

    // Add user message to session with metadata
    const userMessageMetadata = {
      currentUrl,
      pageContentLength: pageContent?.length,
      knowledgeBaseChunks: knowledgeBase.length,
      pageChunks: pageContent ? splitIntoChunks(pageContent).length : 0,
      timestamp,
      portalType,
    };

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
    const messages = [...session.messages];
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
          chunk.metadata.source === "user-guide" ||
          chunk.metadata.source === "user-release"
      );
      // Combine user-guide and user-release chunks with page chunks
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

    // Generate response using OpenAI
    const response = await openai.chat.completions.create({
      model: `${process.env.AZURE_OPENAI_DEPLOYMENT}`,
      messages: messages.map(({ role, content, name, tool_call_id }) => {
        const message: any = { role, content };
        if (role === 'tool' && tool_call_id) {
          message.tool_call_id = tool_call_id;
        }
        if (name) {
          message.name = name;
        }
        return message;
      }), // Send appropriate properties based on message type
    });

    // Log and get usage data
    const usageData = logTokenUsage(
      response,
      contextInfo
        ? `Used ${contextInfo.length} chars of context`
        : "No context used"
    );

    // Extract assistant's reply
    const assistantReply =
      response.choices[0]?.message?.content ||
      "I apologize, but I was unable to generate a response.";

    // Add assistant's reply to the session with usage data and metadata
    const assistantMessageMetadata = {
      currentUrl,
      pageContentLength: pageContent?.length,
      knowledgeBaseChunks: activeKnowledgeBase.length,
      pageChunks: pageChunksCount,
      relevantChunks: relevantChunksInfo,
      timestamp,
      portalType,
    };

    await chatbotDb.addMessageToSession(sessionId, {
      role: "assistant",
      content: assistantReply,
      usage: usageData,
      metadata: assistantMessageMetadata,
    });

    return assistantReply;
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
