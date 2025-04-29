import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import puppeteer from 'puppeteer';

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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost: number;
  };
}

// Interface for chat sessions
export interface ChatSession {
  sessionId: string;
  userId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pageContent?: string; // Full page content for storage
  contextChunks?: ContextChunk[]; // Chunked context for RAG
}

// Interface for context chunks
interface ContextChunk {
  id: string;
  content: string;
  metadata: {
    source: string;
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
  let currentChunk = '';
  
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed chunk size
    if ((currentChunk + '\n' + paragraph).length > 2000) {
      // If current chunk is not empty, save it
      if (currentChunk.trim()) {
        chunks.push({
          id: `chunk-${chunkId++}`,
          content: currentChunk.trim(),
          metadata: { source: 'page-content' }
        });
      }
      
      // If paragraph itself is too long, split it into sentences
      if (paragraph.length > 2000) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        let sentenceChunk = '';
        
        for (const sentence of sentences) {
          if ((sentenceChunk + sentence).length > 2000) {
            if (sentenceChunk.trim()) {
              chunks.push({
                id: `chunk-${chunkId++}`,
                content: sentenceChunk.trim(),
                metadata: { source: 'page-content' }
              });
            }
            // If single sentence is too long, split by words
            if (sentence.length > 2000) {
              const words = sentence.split(/\s+/);
              let wordChunk = '';
              
              for (const word of words) {
                if ((wordChunk + ' ' + word).length > 2000) {
                  if (wordChunk.trim()) {
                    chunks.push({
                      id: `chunk-${chunkId++}`,
                      content: wordChunk.trim(),
                      metadata: { source: 'page-content' }
                    });
                  }
                  wordChunk = word;
                } else {
                  wordChunk += ' ' + word;
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
            sentenceChunk += ' ' + sentence;
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
      currentChunk += (currentChunk ? '\n' : '') + paragraph;
    }
  }
  
  // Add the last chunk if not empty
  if (currentChunk.trim()) {
    chunks.push({
      id: `chunk-${chunkId++}`,
      content: currentChunk.trim(),
      metadata: { source: 'page-content' }
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

  async createChatSession(userId: string, pageContent?: string): Promise<ChatSession> {
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

    // Process page content if provided
    if (pageContent) {
      // Store the full content for reference
      chatSession.pageContent = pageContent;
      
      // Create chunked version for RAG
      chatSession.contextChunks = splitIntoChunks(pageContent);
      
      // Add basic instruction about content, but don't include the full content
      chatSession.messages.push({
        role: 'system',
        content: `The user is viewing a page within the AgentWeb platform. Use relevant information from the page content when answering their questions.`
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

  async updatePageContext(sessionId: string, pageContent: string): Promise<ChatSession> {
    // Create chunks for the new content
    const contextChunks = splitIntoChunks(pageContent);
    
    const params = {
      TableName: this.tableName,
      Key: {
        sessionId
      },
      UpdateExpression: 'SET pageContent = :pageContent, contextChunks = :contextChunks, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':pageContent': pageContent,
        ':contextChunks': contextChunks,
        ':updatedAt': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    };

    try {
      const result = await dynamodb.update(params).promise();
      
      // Add a system message to indicate content change but don't include the full content
      await this.addMessageToSession(sessionId, {
        role: 'system',
        content: `The user has navigated to a different page within the AgentWeb platform.`
      });
      
      return result.Attributes as ChatSession;
    } catch (error) {
      console.error('Error updating page content:', error);
      throw error;
    }
  }
}

// Initialize database
export const chatbotDb = new ChatbotDB();

// Helper function to fetch content from frontend URLs
async function fetchContent(url: string): Promise<string> {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });
    
    // Wait for React to render
    await page.waitForSelector('main', { timeout: 5000 });
    
    // Get the rendered content
    const content = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return '';
      
      // Get all text nodes and their content
      const walker = document.createTreeWalker(
        main,
        NodeFilter.SHOW_TEXT,
        null
      );
      
      let text = '';
      let node;
      while (node = walker.nextNode()) {
        text += node.textContent + '\n';
      }
      
      return text;
    });
    
    await browser.close();
    return content.trim();
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

// Function to print knowledge base content
function printKnowledgeBase(): void {
  if (knowledgeBase.length === 0) {
    console.log('Knowledge base is empty');
    return;
  }

  console.log('\n=== Knowledge Base Content ===');
  knowledgeBase.forEach((chunk, index) => {
    console.log(`\nChunk ${index + 1} (${chunk.id}):`);
    console.log('Source:', chunk.metadata?.source || 'unknown');
    console.log('Content length:', chunk.content.length);
    console.log('Content preview:', chunk.content.substring(0, 200) + '...');
  });
  console.log('\n============================\n');
}

// Load and cache content from frontend URLs
async function loadKnowledgeBase(): Promise<void> {
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const urls = [
    `${baseUrl}/guide`,
    `${baseUrl}/release`,
    `${baseUrl}/api`
  ];

  const chunks: ContextChunk[] = [];
  let chunkId = 0;
  
  for (const url of urls) {
    try {
      const content = await fetchContent(url);
      if (content) {
        // Split content into smaller chunks (max 2000 chars per chunk)
        const textChunks = content.match(/[^\.!\?]+[\.!\?]+/g) || [content];
        let currentChunk = '';
        
        for (const sentence of textChunks) {
          if ((currentChunk + sentence).length > 2000) {
            if (currentChunk) {
              chunks.push({
                id: `chunk-${url}-${chunkId++}`,
                content: currentChunk.trim(),
                metadata: { source: url }
              });
            }
            currentChunk = sentence;
          } else {
            currentChunk += ' ' + sentence;
          }
        }
        
        // Add the last chunk if not empty
        if (currentChunk.trim()) {
          chunks.push({
            id: `chunk-${url}-${chunkId++}`,
            content: currentChunk.trim(),
            metadata: { source: url }
          });
        }
      }
    } catch (error) {
      console.error(`Error processing ${url}:`, error);
    }
  }

  knowledgeBase = chunks;
  console.log(`Loaded ${chunks.length} knowledge chunks from frontend pages`);
  printKnowledgeBase();
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

Be helpful, concise, and accurate. If you don't know the answer, suggest the user join our Discord community for human support: <a href="https://discord.gg/ec7yR3yG" target="_blank">Discord community</a>`;

// Helper function to calculate token cost
function calculateCost(promptTokens: number, completionTokens: number, model: string): number {
  // Azure OpenAI pricing per 1K tokens (as of 2024)
  const prices = {
    'gpt-4o': {
      prompt: 0.025,
      completion: 0.0125
    },
    'gpt-4.1': {
      prompt: 0.02,
      completion: 0.005
    }
  };
  
  // Get model pricing or return 0 if model not found
  let pricing;
  const modelLower = model.toLowerCase();
  if (modelLower.includes('gpt-4o')) {
    pricing = prices['gpt-4o'];
  } else if (modelLower.includes('gpt-4.1')) {
    pricing = prices['gpt-4.1'];
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
function logTokenUsage(response: OpenAI.Chat.ChatCompletion, context: string = '') {
  const usage = response.usage;
  if (!usage) return;

  const cost = calculateCost(
    usage.prompt_tokens,
    usage.completion_tokens,
    response.model
  );

  console.log(`[Token Usage] Model: ${response.model} | Prompt: ${usage.prompt_tokens} | Completion: ${usage.completion_tokens} | Total: ${usage.total_tokens} | Cost: ${cost > 0 ? '$' + cost.toFixed(6) : 'N/A'}${context ? ` | Context: ${context}` : ''}`);

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    estimated_cost: cost
  };
}

// Update generateChatResponse to use cached knowledge base
export async function generateChatResponse(
  sessionId: string,
  userMessage: string,
  currentUrl?: string,
  pageContent?: string
): Promise<string> {
  try {
    console.log('[generateChatResponse] Starting with:', {
      sessionId,
      messageLength: userMessage.length,
      currentUrl,
      hasPageContent: !!pageContent,
      pageContentLength: pageContent?.length
    });

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
    let contextInfo = '';
    
    // Process page content if available
    let combinedChunks: ContextChunk[] = [...knowledgeBase];
    if (pageContent) {
      console.log('[generateChatResponse] Processing page content:', {
        originalLength: pageContent.length,
        knowledgeBaseChunks: knowledgeBase.length
      });
      
      const pageChunks = splitIntoChunks(pageContent);
      console.log('[generateChatResponse] Created page chunks:', {
        numChunks: pageChunks.length,
        firstChunkPreview: pageChunks[0]?.content.substring(0, 100)
      });
      
      combinedChunks = [...pageChunks, ...knowledgeBase];
    }
    
    // RAG: Retrieve relevant chunks
    let retrievalErrorOccurred = false;
    try {
      console.log('[generateChatResponse] Finding relevant chunks from total:', combinedChunks.length);
      const relevantChunks = await findRelevantChunks(userMessage, combinedChunks);
      console.log('[generateChatResponse] Found relevant chunks:', {
        count: relevantChunks.length,
        sources: relevantChunks.map(c => c.metadata.source)
      });
      
      if (relevantChunks.length > 0) {
        // Insert retrieved context right before the user's message
        contextInfo = relevantChunks
          .map(chunk => `${chunk.content} (Source: ${chunk.metadata.source})`)
          .join('\n\n');
          
        // Find the index of the last user message
        const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');
        
        // Insert the context right before the user's message
        if (lastUserMsgIndex > 0) {
          console.log('[generateChatResponse] Inserting context before user message');
          messages.splice(lastUserMsgIndex, 0, {
            role: 'system',
            content: `Here is relevant information from the current page and our documentation:\n\n${contextInfo}`
          });
        }
      } else {
        console.log('[generateChatResponse] No relevant chunks found');
      }
    } catch (error) {
      console.error('[generateChatResponse] Error in context retrieval:', error);
      retrievalErrorOccurred = true;
    }
    
    // Generate response using OpenAI
    console.log('[generateChatResponse] Sending to OpenAI:', {
      numMessages: messages.length,
      hasContext: !!contextInfo
    });
    
    const response = await openai.chat.completions.create({
      model: `${process.env.AZURE_OPENAI_DEPLOYMENT}`,
      messages
    });

    // Log and get usage data
    const usageData = logTokenUsage(response, contextInfo ? `Used ${contextInfo.length} chars of context` : 'No context used');

    // Extract assistant's reply
    const assistantReply = response.choices[0]?.message?.content || 'I apologize, but I was unable to generate a response.';

    // Add assistant's reply to the session with usage data
    await chatbotDb.addMessageToSession(sessionId, {
      role: 'assistant',
      content: assistantReply,
      usage: usageData
    });

    return assistantReply;
  } catch (error) {
    console.error('[generateChatResponse] Error:', error);
    throw error;
  }
} 