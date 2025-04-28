import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

// Make sure we have a DynamoDB instance
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

// Initialize Azure OpenAI client
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview' },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
});

// Separate client for embeddings
const embeddingsClient = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_EMBEDDINGS_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT || 'text-embedding-3-large'}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_EMBEDDINGS_API_VERSION || '2024-08-01-preview' },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY }
});

// Interface for chat messages
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Interface for chat sessions
export interface ChatSession {
  sessionId: string;
  userId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pageContext?: string; // Full page context for storage
  contextChunks?: ContextChunk[]; // Chunked context for RAG
}

// Interface for context chunks used in RAG
interface ContextChunk {
  id: string;
  content: string;
  metadata?: {
    source?: string;
    section?: string;
  };
}

// Helper function to split text into chunks
function splitIntoChunks(text: string, maxChunkSize: number = 1000): ContextChunk[] {
  if (!text) return [];
  
  // Split by natural paragraph breaks first
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: ContextChunk[] = [];
  
  let currentChunk = '';
  let chunkId = 0;
  
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed the chunk size, create a new chunk
    if (currentChunk.length + paragraph.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push({
        id: `chunk-${chunkId++}`,
        content: currentChunk.trim()
      });
      currentChunk = '';
    }
    
    // If a single paragraph is longer than maxChunkSize, split it by sentences
    if (paragraph.length > maxChunkSize) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
          chunks.push({
            id: `chunk-${chunkId++}`,
            content: currentChunk.trim()
          });
          currentChunk = '';
        }
        
        currentChunk += sentence + ' ';
        
        if (currentChunk.length >= maxChunkSize) {
          chunks.push({
            id: `chunk-${chunkId++}`,
            content: currentChunk.trim()
          });
          currentChunk = '';
        }
      }
    } else {
      currentChunk += paragraph + '\n\n';
    }
  }
  
  // Add the last chunk if it's not empty
  if (currentChunk.trim().length > 0) {
    chunks.push({
      id: `chunk-${chunkId++}`,
      content: currentChunk.trim()
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
      dimensions: 1536
    });
    
    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
    
    // Get embeddings for all chunks (in a real system, you'd cache these)
    const chunkEmbeddings = await Promise.all(
      chunks.map(async (chunk) => {
        const response = await embeddingsClient.embeddings.create({
          model: `${process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT}`,
          input: chunk.content,
          dimensions: 1536
        });
        return {
          chunk,
          embedding: response.data[0].embedding
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
    return scoredChunks.slice(0, maxChunks).map(item => item.chunk);
  } catch (error) {
    console.error('Error finding relevant chunks:', error);
    
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
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3);
  
  if (keywords.length === 0) {
    // If no keywords, return first few chunks
    return chunks.slice(0, maxChunks);
  }
  
  // Score chunks by keyword matches
  const scoredChunks = chunks.map(chunk => {
    const content = chunk.content.toLowerCase();
    let score = 0;
    
    for (const keyword of keywords) {
      // Count occurrences of keyword in chunk
      const regex = new RegExp(`\\b${keyword}\\b`, 'g');
      const matches = content.match(regex);
      if (matches) {
        score += matches.length;
      }
    }
    
    return { chunk, score };
  });
  
  // Sort by score and take top N
  scoredChunks.sort((a, b) => b.score - a.score);
  return scoredChunks.slice(0, maxChunks).map(item => item.chunk);
}

class ChatbotDB {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-ChatSessions`;
    console.log(`ChatbotDB initialized with table: ${this.tableName}`);
  }

  async createChatSession(userId: string, pageContext?: string): Promise<ChatSession> {
    const sessionId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const chatSession: ChatSession = {
      sessionId,
      userId,
      messages: [
        {
          role: 'system',
          content: systemMessage
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    // Process page context if provided
    if (pageContext) {
      // Store the full context for reference
      chatSession.pageContext = pageContext;
      
      // Create chunked version for RAG
      chatSession.contextChunks = splitIntoChunks(pageContext);
      
      // Add basic instruction about context, but don't include the full context
      chatSession.messages.push({
        role: 'system',
        content: `The user is viewing a page within the AgentWeb platform. Use relevant information from the page context when answering their questions.`
      });
    }

    const params = {
      TableName: this.tableName,
      Item: chatSession
    };

    try {
      await dynamodb.put(params).promise();
      console.log(`Created chat session: ${sessionId} for user: ${userId}`);
      return chatSession;
    } catch (error) {
      console.error('Error creating chat session:', error);
      throw error;
    }
  }

  async getChatSession(sessionId: string): Promise<ChatSession | null> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId
      }
    };

    try {
      const result = await dynamodb.get(params).promise();
      return result.Item as ChatSession || null;
    } catch (error) {
      console.error('Error getting chat session:', error);
      throw error;
    }
  }

  async getUserSessions(userId: string): Promise<ChatSession[]> {
    console.log(`Getting chat sessions for user: ${userId} from table: ${this.tableName}`);
    
    const params = {
      TableName: this.tableName,
      IndexName: 'UserIdIndex',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    };

    try {
      const result = await dynamodb.query(params).promise();
      console.log(`Found ${result.Items?.length || 0} chat sessions for user: ${userId}`);
      return result.Items as ChatSession[] || [];
    } catch (error) {
      console.error('Error getting user chat sessions:', error);
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
        sessionId
      },
      UpdateExpression: 'SET messages = list_append(messages, :message), updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':message': [message],
        ':updatedAt': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error('Error adding message to session:', error);
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId
      }
    };

    try {
      await dynamodb.delete(params).promise();
    } catch (error) {
      console.error('Error deleting chat session:', error);
      throw error;
    }
  }

  async updatePageContext(sessionId: string, pageContext: string): Promise<ChatSession> {
    // Create chunks for the new context
    const contextChunks = splitIntoChunks(pageContext);
    
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId
      },
      UpdateExpression: 'SET pageContext = :pageContext, contextChunks = :contextChunks, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':pageContext': pageContext,
        ':contextChunks': contextChunks,
        ':updatedAt': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    };

    try {
      const result = await dynamodb.update(params).promise();
      
      // Add a system message to indicate context change but don't include the full context
      await this.addMessageToSession(sessionId, {
        role: 'system',
        content: `The user has navigated to a different page within the AgentWeb platform.`
      });
      
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error('Error updating page context:', error);
      throw error;
    }
  }
}

// Initialize database
export const chatbotDb = new ChatbotDB();

// Helper function to fetch content from frontend URLs
async function fetchContent(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    }
    return await response.text();
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return '';
  }
}

// Helper function to extract content from HTML
function extractContent(html: string): string {
  // Remove script and style tags
  const cleanHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                       .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  
  // Extract text content from main content area
  const mainContent = cleanHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] || cleanHtml;
  
  // Convert HTML to text
  return mainContent
    .replace(/<[^>]+>/g, ' ') // Remove HTML tags
    .replace(/\s+/g, ' ')     // Normalize whitespace
    .trim();
}

// Initialize knowledge base
let knowledgeBase: ContextChunk[] = [];

// Load and cache content from frontend URLs
async function loadKnowledgeBase(): Promise<void> {
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const urls = [
    `${baseUrl}/guide`,
    `${baseUrl}/release`,
    `${baseUrl}/api`
  ];

  const chunks: ContextChunk[] = [];
  
  for (const url of urls) {
    try {
      const html = await fetchContent(url);
      const content = extractContent(html);
      if (content) {
        chunks.push(...splitIntoChunks(content));
      }
    } catch (error) {
      console.error(`Error processing ${url}:`, error);
    }
  }

  knowledgeBase = chunks;
  console.log(`Loaded ${chunks.length} knowledge chunks from frontend pages`);
}

// Load knowledge base on startup and refresh periodically
loadKnowledgeBase().catch(error => {
  console.error('Error loading knowledge base:', error);
});

// Refresh knowledge base every hour
setInterval(() => {
  loadKnowledgeBase().catch(error => {
    console.error('Error refreshing knowledge base:', error);
  });
}, 60 * 60 * 1000);

// Update system message
const systemMessage = `You are a helpful customer support assistant for AgentWeb, a powerful web automation platform that allows users to create and manage web-based tasks using natural language instructions. 

Today's date is ${new Date().toISOString().split('T')[0]}.

I will provide you with relevant information from our documentation to help answer questions. Please use this information when responding to user queries.

Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <pre> for code blocks
- <a href="url" target="_blank"> for links
- <table> for structured data

Important formatting rules:
1. Use minimal spacing - no extra blank lines
2. Keep lists compact with minimal spacing
3. Use single line breaks between list items
4. Keep responses concise and well-structured
5. Always include target="_blank" for links
6. Use proper HTML5 semantic elements

Example of good formatting:
<p>To create a task in AgentWeb, follow these steps:</p>
<ul>
<li>Go to the <strong>Tasks</strong> page in AgentWeb</li>
<li>Click the <strong>New Task</strong> button</li>
<li>Enter your task instructions in plain English</li>
<li>Adjust settings as needed</li>
<li>Click <strong>Create</strong> to save</li>
</ul>

Be helpful, concise, and accurate. If you don't know the answer, suggest the user join our Discord community for human support: <a href="https://discord.gg/ec7yR3yG" target="_blank">Discord community</a>`;

// Update generateChatResponse to use cached knowledge base
export async function generateChatResponse(
  sessionId: string,
  userMessage: string,
  currentUrl?: string,
  pageContext?: string
): Promise<string> {
  try {
    // Add user message to session
    await chatbotDb.addMessageToSession(sessionId, {
      role: 'user',
      content: userMessage
    });

    // Get updated session with history
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      throw new Error('Chat session not found');
    }

    // Get messages for OpenAI
    const messages = [...session.messages];
    
    // Add URL context to the system message if available
    if (currentUrl) {
      const systemMessageIndex = messages.findIndex(msg => msg.role === 'system');
      if (systemMessageIndex !== -1) {
        messages[systemMessageIndex] = {
          ...messages[systemMessageIndex],
          content: `${messages[systemMessageIndex].content}\n\nThe user is currently on the page: ${currentUrl}`
        };
      }
    }
    
    // RAG: Retrieve relevant chunks from cached knowledge base
    let retrievalErrorOccurred = false;
    if (knowledgeBase.length > 0) {
      try {
        const relevantChunks = await findRelevantChunks(userMessage, knowledgeBase);
        
        if (relevantChunks.length > 0) {
          // Insert retrieved context right before the user's message
          const contextInfo = relevantChunks
            .map(chunk => chunk.content)
            .join('\n\n');
            
          // Find the index of the last user message
          const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');
          
          // Insert the context right before the user's message
          if (lastUserMsgIndex > 0) {
            messages.splice(lastUserMsgIndex, 0, {
              role: 'system',
              content: `Here is relevant information from our documentation:\n\n${contextInfo}`
            });
          }
        }
      } catch (error) {
        console.error('Error in context retrieval, continuing without context:', error);
        retrievalErrorOccurred = true;
      }
    }
    
    // Generate response using OpenAI
    const response = await openai.chat.completions.create({
      model: `${process.env.AZURE_OPENAI_DEPLOYMENT}`,
      messages
    });

    // Extract assistant's reply
    const assistantReply = response.choices[0]?.message?.content || 'I apologize, but I was unable to generate a response.';

    // Add assistant's reply to the session
    await chatbotDb.addMessageToSession(sessionId, {
      role: 'assistant',
      content: assistantReply
    });

    return assistantReply;
  } catch (error) {
    console.error('Error generating chat response:', error);
    throw error;
  }
} 