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
  role: "system" | "user" | "assistant";
  content: string;
  timestamp?: string; // Add direct timestamp field
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
    portalType?: "customer" | "partner" | "genius";
    pageIdentifier?: string;
    isContextMessage?: boolean;
  };
}

// Interface for chat sessions
export interface ChatSession {
  sessionId: string;
  userId: string;
  title?: string; // Session title for display
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pageContent?: string; // Full page content for storage
  contextChunks?: ContextChunk[]; // Chunked context for RAG
  portalType?: "customer" | "partner" | "genius"; // Added portalType to session
  pageIdentifier?: string; // Added pageIdentifier for page-specific sessions
  archived?: boolean; // Archive status for soft deletion
  selectedStartupId?: string; // Selected startup profile for context
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

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-ChatSessions`;
  }

  async createChatSession(
    userId: string,
    pageContent?: string,
    portalType?: "customer" | "partner" | "genius",
    pageIdentifier?: string,
    selectedStartupId?: string
  ): Promise<ChatSession> {
    const sessionId = uuidv4();
    const timestamp = new Date().toISOString();

    const selectedSystemMessage =
      portalType === "customer" ? emmaSystemMessage :
      portalType === "genius" ? geniusSystemMessage :
      partnerSystemMessage;

    const chatSession: ChatSession = {
      sessionId,
      userId,
      title: 'New Chat Session', // Default title that will be updated after first message
      messages: [
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
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
      portalType,
      pageIdentifier,
      selectedStartupId,
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

  async addMessageToSession(
    sessionId: string,
    message: ChatMessage
  ): Promise<ChatSession> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId,
      },
      UpdateExpression:
        "SET messages = list_append(messages, :message), updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":message": [message],
        ":updatedAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error("Error adding message to session:", error);
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
      return (result.Item as ChatSession) || null;
    } catch (error) {
      console.error("Error getting chat session:", error);
      throw error;
    }
  }

  async getUserSessions(
    userId: string,
    portalType?: "customer" | "partner" | "genius",
    limit?: number,
    sortDescending: boolean = true
  ): Promise<ChatSession[]> {
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

      return sessions;
    } catch (error) {
      console.error("Error getting user chat sessions:", error);
      throw error;
    }
  }

  async getUserSessionCount(userId: string, portalType?: "customer" | "partner" | "genius"): Promise<number> {
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
  async getArchivedSessions(userId?: string, portalType?: "customer" | "partner" | "genius"): Promise<ChatSession[]> {
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
      UpdateExpression: "SET archived = :archived, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":archived": true,
        ":updatedAt": timestamp,
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
        "SET pageContent = :pageContent, contextChunks = :contextChunks, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":pageContent": pageContent,
        ":contextChunks": contextChunks,
        ":updatedAt": timestamp,
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
        "SET title = :title, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":title": title,
        ":updatedAt": timestamp,
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
    portalType: "customer" | "partner" | "genius"
  ): Promise<ChatSession> {
    const timestamp = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
      sessionId,
      },
      UpdateExpression:
        "SET portalType = :portalType, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":portalType": portalType,
        ":updatedAt": timestamp,
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
        "SET selectedStartupId = :selectedStartupId, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":selectedStartupId": selectedStartupId,
        ":updatedAt": timestamp,
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

  async updateMessageInSession(sessionId: string, messageIndex: number, updatedMessage: ChatMessage): Promise<ChatSession> {
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

      // Create a copy of messages array and update the specific message
      const updatedMessages = [...currentSession.messages];
      updatedMessages[messageIndex] = updatedMessage;

      // Update the session with the new messages array
      const params = {
        TableName: this.tableName,
        Key: {
          sessionId,
        },
        UpdateExpression: "SET messages = :messages, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":messages": updatedMessages,
          ":updatedAt": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
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
      messages: messages.map(({ role, content }) => ({ role, content })), // Only send role and content to OpenAI
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

