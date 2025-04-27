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
}

class ChatbotDB {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-ChatSessions`;
    console.log(`ChatbotDB initialized with table: ${this.tableName}`);
  }

  async createChatSession(userId: string): Promise<ChatSession> {
    const sessionId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const chatSession: ChatSession = {
      sessionId,
      userId,
      messages: [
        {
          role: 'system',
          content: `You are a helpful customer support assistant for AgentWeb, a powerful web automation platform that allows users to create and manage web-based tasks using natural language instructions. 
          
Today's date is ${new Date().toISOString().split('T')[0]}.

AgentWeb features:
- Natural language task creation
- Zero credential storage - credentials required per task execution
- Isolated browser sessions for each task
- Support for both single and recurring tasks
- Real-time task monitoring and alerts
- API Integration support

Be helpful, concise, and accurate. If you don't know the answer, suggest the user contact support via email at support@agentweb.pro.`
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };

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
}

// Initialize database
export const chatbotDb = new ChatbotDB();

// Function to generate chat response
export async function generateChatResponse(
  sessionId: string,
  userMessage: string
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

    // Generate response using Azure OpenAI
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
      messages: session.messages,
      max_tokens: 500,
      temperature: 0.7
    });

    const assistantMessage = response.choices[0].message.content || 
      'Sorry, I was unable to generate a response. Please try again later.';

    // Save assistant response to session
    await chatbotDb.addMessageToSession(sessionId, {
      role: 'assistant',
      content: assistantMessage
    });

    return assistantMessage;
  } catch (error) {
    console.error('Error generating chat response:', error);
    throw error;
  }
} 