import { Request, Response } from 'express';
import { agentModeService, AgentModeService } from '../services/agentModeService';
import { chatbotDb, updateTaskExecutionStatus } from '../services/chatbotService';
import { scheduleDb } from '../services/db';
import { User } from '../types/auth';
import multer from 'multer';
import crypto from 'crypto';
import { uploadFileToS3 } from '../utils/s3Utils';

// Interface for scheduled chat test results
interface ScheduledChatTestResult {
  scheduleId: string;
  runId: string;
  status: 'success' | 'failure';
  passed: boolean;
  actualResponse: string;
  actualFunctionCalls: string[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  executionTime: number; // milliseconds
  sessionId: string; // Test session ID for viewing conversation
  attempt: number; // Which attempt this was (1-3)
  createdAt: string;
}

// Evaluate schedule response against expected criteria
function evaluateScheduleResponse(
  actualResponse: string,
  actualFunctionCalls: string[],
  expectedOutput: {
    keywords: string[];
    functionCalls: string[];
  }
): {
  passed: boolean;
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
} {
  const expectedKeywords = expectedOutput.keywords || [];
  const expectedFunctionCalls = expectedOutput.functionCalls || [];

  // Evaluate keywords
  const keywordMatches: string[] = [];
  const keywordMisses: string[] = [];
  
  expectedKeywords.forEach((keyword: string) => {
    if (actualResponse.toLowerCase().includes(keyword.toLowerCase())) {
      keywordMatches.push(keyword);
    } else {
      keywordMisses.push(keyword);
    }
  });

  // Evaluate function calls
  const functionCallMatches: string[] = [];
  const functionCallMisses: string[] = [];
  
  expectedFunctionCalls.forEach((expectedCall: string) => {
    if (actualFunctionCalls.includes(expectedCall)) {
      functionCallMatches.push(expectedCall);
    } else {
      functionCallMisses.push(expectedCall);
    }
  });

  // Pass only if ALL expected keywords and ALL expected function calls are present
  const allKeywordsPresent = expectedKeywords.length === 0 || keywordMisses.length === 0;
  const allFunctionCallsPresent = expectedFunctionCalls.length === 0 || functionCallMisses.length === 0;
  const passed = allKeywordsPresent && allFunctionCallsPresent;

  return {
    passed,
    keywordMatches,
    keywordMisses,
    functionCallMatches,
    functionCallMisses
  };
}

// Common function to filter messages for client display
const filterMessagesForClient = (messages: any[]) => {
  return messages.filter(message => {
    // Remove tool messages
    if (message.role === 'tool') {
      return false;
    }
    
    // Remove assistant messages that have tool calls
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      return false;
    }
    
    return true;
  });
};

// Common function to run a scheduled chat (used by both test and actual execution)
async function runScheduledChat(
  schedule: any,
  userId: string,
  isTest: boolean = false
): Promise<{
  scheduleId: string;
  runId: string;
  status: 'success' | 'failure';
  passed: boolean;
  actualResponse: string;
  actualFunctionCalls: string[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  executionTime: number;
  sessionId: string;
  attempt: number;
  createdAt: string;
}> {
  const now = new Date();
  const maxTries = 3;
  let attempt = 0;
  let finalResult: {
    scheduleId: string;
    runId: string;
    status: 'success' | 'failure';
    passed: boolean;
    actualResponse: string;
    actualFunctionCalls: string[];
    keywordMatches: string[];
    keywordMisses: string[];
    functionCallMatches: string[];
    functionCallMisses: string[];
    executionTime: number;
    sessionId: string;
    attempt: number;
    createdAt: string;
  } | null = null;

  // Create a session for the run
  const sessionTitle = isTest ? `Test: ${schedule.scheduleName}` : `Scheduled: ${schedule.scheduleName}`;
  const testSession = await chatbotDb.createChatSession(userId, undefined, "agent", sessionTitle);
  const sessionId = testSession.sessionId;

  while (attempt < maxTries) {
    attempt++;
    
    try {
      // Prepare user message for this attempt
      const userMessage = attempt === 1 
        ? schedule.startingMessage 
        : `Please try again. Make sure to include these keywords: ${finalResult?.keywordMisses?.join(', ') || ''} and use these function calls: ${finalResult?.functionCallMisses?.join(', ') || ''}.`;

      // Generate response using the common function (same as /generateResponse)
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        userId
      );

      // Extract function calls from the response
      const actualFunctionCalls = response.toolCalls?.map((call: any) => call.name).filter(Boolean) || [];

      // Evaluate the response against expected criteria
      const evaluation = evaluateScheduleResponse(
        response.content,
        actualFunctionCalls,
        {
          keywords: schedule.keywords || [],
          functionCalls: schedule.requiredFunctionCalls || []
        }
      );

      finalResult = {
        scheduleId: schedule.scheduleId,
        runId: require('uuid').v4(),
        status: evaluation.passed ? 'success' : 'failure',
        passed: evaluation.passed,
        actualResponse: response.content,
        actualFunctionCalls,
        keywordMatches: evaluation.keywordMatches,
        keywordMisses: evaluation.keywordMisses,
        functionCallMatches: evaluation.functionCallMatches,
        functionCallMisses: evaluation.functionCallMisses,
        executionTime: Date.now() - now.getTime(),
        sessionId: sessionId,
        attempt,
        createdAt: new Date().toISOString()
      };

      // If test passed, break out of loop
      if (evaluation.passed) {
        break;
      }

    } catch (error) {
      console.error(`Run attempt ${attempt} failed:`, error);
      if (attempt === maxTries) {
        throw error;
      }
    }
  }

  // Ensure we always return a result
  if (!finalResult) {
    throw new Error('Failed to generate result after all attempts');
  }

  // Save the result to database
  try {
    await scheduleDb.addRunResult(schedule.scheduleId, finalResult);
  } catch (error) {
    console.error('Error saving run result:', error);
    // Continue even if saving fails - we still want to return the result
  }
  
  return finalResult;
}

// Common function to generate AI response for a session
async function generateSessionResponse(
  sessionId: string,
  userMessage: string,
  userId: string,
  attachments?: any[]
): Promise<{
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
}> {
  // Get session
  const session = await chatbotDb.getChatSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Process attachments and include URLs in message content for LLM
  let messageContent = userMessage;
  if (attachments && attachments.length > 0) {
    const attachmentUrls = attachments.map((attachment: any) => {
      return `[${attachment.filename || 'Attachment'}](${attachment.url})`;
    }).join('\n');
    messageContent = `${userMessage}\n\n**Attached Files:**\n${attachmentUrls}`;
  }

  // Create user message object - store processed content with attachments
  const userMessageObj = {
    role: 'user' as const,
    content: userMessage, // Store original user message, not processed content
    timestamp: new Date().toISOString(),
    metadata: {
      portalType: 'agent' as const,
      timestamp: new Date().toISOString(),
      attachments: attachments || []
    }
  };

  // Check if this is the first user message (excluding system message)
  const userMessages = session.messages?.filter(msg => msg.role === 'user') || [];
  const isFirstMessage = userMessages.length === 0;

  // If this is the first message, add system message with version info first
  if (isFirstMessage) {
    try {
      // Get the current system prompt version
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      const systemPromptHash = require('crypto').createHash('md5').update(systemPrompt).digest('hex').substring(0, 8);
      
      // Add system message with version info (hash only in metadata)
      const systemMessage = {
        role: 'system' as const,
        content: systemPrompt,
        metadata: {
          timestamp: new Date().toISOString(),
          portalType: 'agent' as const,
          systemPromptVersion: systemPromptHash
        }
      };
      
      await chatbotDb.addMessageToSession(sessionId, systemMessage);
    } catch (error) {
      console.error('AgentMode: Failed to add system message:', error);
      // If it's a session size limit error, re-throw it
      if (error instanceof Error && error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
        throw error;
      }
      // Continue with the message processing for other errors
    }
  }

  // If this is the first message, generate session title
  if (isFirstMessage) {
    try {
      const title = await agentModeService.generateSessionTitle(userMessage);
      await chatbotDb.updateSessionTitle(sessionId, title);
    } catch (error) {
      console.error('AgentMode: Failed to update session title:', error);
      // Continue with the message processing even if this fails
    }
  }

  // Add user message to session in database
  await chatbotDb.addMessageToSession(sessionId, userMessageObj);

  // Get updated session with the new user message
  const updatedSession = await chatbotDb.getChatSession(sessionId);
  if (!updatedSession) {
    throw new Error('Session not found after update');
  }

  // Generate AI response
  const response = await agentModeService.generateMarketingResponse(
    messageContent,
    updatedSession.messages,
    userId,
    sessionId
  );

  // Add all response messages to session (includes assistant responses and tool calls)
  await chatbotDb.addMessagesToSession(sessionId, response.responseMessages);

  return response;
}

// Helper function to calculate next run time based on frequency
const calculateNextRunTime = (frequency: string, fromDate: Date): Date => {
  const nextRun = new Date(fromDate);
  
  switch (frequency) {
    case 'daily':
      nextRun.setDate(nextRun.getDate() + 1);
      nextRun.setHours(9, 0, 0, 0); // 9 AM
      break;
    case 'weekly':
      nextRun.setDate(nextRun.getDate() + 7);
      nextRun.setHours(9, 0, 0, 0); // 9 AM
      break;
    case 'monthly':
      nextRun.setMonth(nextRun.getMonth() + 1);
      nextRun.setHours(9, 0, 0, 0); // 9 AM
      break;
    default:
      // Default to daily
      nextRun.setDate(nextRun.getDate() + 1);
      nextRun.setHours(9, 0, 0, 0);
  }
  
  return nextRun;
};

export const agentModeController = {
  // Get user's agent chat sessions
  async getSessions(req: Request, res: Response) {
    try {
      const user = req.user as User;

      const sessions = await chatbotDb.getUserSessions(user.userId, 'agent');
      
      // Filter out tool messages and assistant messages with tool calls for user display
      const filteredSessions = sessions.map(session => ({
        ...session,
        messages: filterMessagesForClient(session.messages)
      }));
      
      res.json(filteredSessions);
    } catch (error) {
      console.error('AgentMode: Get sessions error:', error);
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  },

  // Create new agent chat session
  async createSession(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { portalType = 'agent', pageIdentifier = 'agent-mode' } = req.body;


      const session = await chatbotDb.createChatSession(
        user.userId,
        undefined, // pageContent
        portalType,
        pageIdentifier,
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined  // executionId
      );

      res.status(201).json(session);
    } catch (error) {
      console.error('AgentMode: Create session error:', error);
      res.status(500).json({ error: 'Failed to create session' });
    }
  },

  // Get specific chat session
  async getSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as any; // Should have user from auth middleware

      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Allow admin users to access any session for benchmark creation
      if (user && user.isAdmin) {
        return res.json(session);
      }

      // For non-admin users, check if they own the session
      if (session.userId !== user?.userId) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      res.json(session);
    } catch (error) {
      console.error('AgentMode: Get session error:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  },

  // Get available function calls for benchmark tests
  async getAvailableFunctionCalls(req: Request, res: Response) {
    try {
      const agentModeService = new AgentModeService();
      const tools = agentModeService.getAvailableTools();
      
      // Extract function names and descriptions
      const functionCalls = tools.map((tool: any) => ({
        name: tool.function.name,
        description: tool.function.description
      }));

      res.json({ functionCalls });
    } catch (error) {
      console.error('AgentMode: Get function calls error:', error);
      res.status(500).json({ error: 'Failed to get function calls' });
    }
  },

  // Generate AI response for marketing conversation
  async generateResponse(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId, userMessage, attachments } = req.body;

      if (!sessionId || !userMessage) {
        return res.status(400).json({ error: 'Session ID and user message are required' });
      }

      // Get session
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Generate AI response using common function
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        user.userId,
        attachments
      );

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources
      });
    } catch (error) {
      console.error('AgentMode: Generate response error:', error);
      
      // Handle specific error types
      if (error instanceof Error) {
        if (error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
          res.status(413).json({ 
            error: 'Session size limit exceeded',
            message: 'Please start a new session to continue the conversation.',
            code: 'SESSION_SIZE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }
        
        if (error.message.includes('MESSAGE_TOO_LARGE')) {
          res.status(413).json({ 
            error: 'Message too large',
            message: 'The message content is too large to be saved. Please try with shorter content.',
            code: 'MESSAGE_TOO_LARGE',
            suggestion: 'shorten_content'
          });
          return;
        }
      }
      
      res.status(500).json({ error: 'Failed to generate response' });
    }
  },

  // Get system prompt
  async getSystemPrompt(req: Request, res: Response) {
    try {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      res.json(systemPrompt);
    } catch (error) {
      console.error('AgentMode: Get system prompt error:', error);
      res.status(500).json({ error: 'Failed to get system prompt' });
    }
  },

  // Get welcome message
  async getWelcomeMessage(req: Request, res: Response) {
    try {
      const welcomeMessage = await agentModeService.getWelcomeMessage();
      res.json(welcomeMessage);
    } catch (error) {
      console.error('AgentMode: Get welcome message error:', error);
      res.status(500).json({ error: 'Failed to get welcome message' });
    }
  },

  // Get conversation starters
  async getConversationStarters(req: Request, res: Response) {
    try {
      const conversationStarters = await agentModeService.getConversationStarters();
      res.json(conversationStarters);
    } catch (error) {
      console.error('AgentMode: Get conversation starters error:', error);
      res.status(500).json({ error: 'Failed to get conversation starters' });
    }
  },

  // Create shareable link for conversation
  async createShareLink(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Use session ID as share ID
      const shareId = sessionId;
      
      // Add share metadata to the session (no expiration by default)
      const shareMetadata = {
        isShared: true,
        sharedAt: new Date().toISOString()
        // expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days - disabled for now
      };

      // Update the session with share metadata
      await chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata);

      res.json({ shareId });
    } catch (error) {
      console.error('AgentMode: Create share link error:', error);
      res.status(500).json({ error: 'Failed to create share link' });
    }
  },

  // Stop sharing conversation
  async stopSharing(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Remove share metadata from the session
      await chatbotDb.updateSessionShareMetadata(sessionId, { isShared: false });

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop sharing error:', error);
      res.status(500).json({ error: 'Failed to stop sharing' });
    }
  },

  // Get shared conversation
  async getSharedConversation(req: Request, res: Response) {
    try {
      const { shareId } = req.params;

      // Get the session data directly using shareId as sessionId
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Check if the session is shared
      if (!session.shareMetadata?.isShared) {
        return res.status(404).json({ error: 'This conversation is not shared' });
      }

      // Check if expired (only if expiresAt is set)
      if (session.shareMetadata.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
        // Remove share metadata if expired
        await chatbotDb.updateSessionShareMetadata(shareId, { isShared: false });
        return res.status(410).json({ error: 'Share link has expired' });
      }

      res.json({
        session: {
          sessionId: session.sessionId,
          title: session.title,
          messages: filterMessagesForClient(session.messages),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          shareMetadata: session.shareMetadata
        }
      });
    } catch (error) {
      console.error('AgentMode: Get shared conversation error:', error);
      res.status(500).json({ error: 'Failed to get shared conversation' });
    }
  },

  // Archive a chat session
  async archiveSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as User;


      await chatbotDb.archiveSession(sessionId);
      res.json({ message: 'Session archived successfully' });
    } catch (error) {
      console.error('AgentMode: Archive session error:', error);
      res.status(500).json({ error: 'Failed to archive session' });
    }
  },

  // Update task execution status in session
  async updateTaskStatus(req: Request, res: Response) {
    try {
      const { sessionId, taskId, executionId } = req.params;
      const { status } = req.body;
      const user = req.user as User;
      

      await updateTaskExecutionStatus(sessionId, taskId, executionId, status);
      res.json({ message: 'Task status updated successfully' });
    } catch (error) {
      console.error('AgentMode: Update task status error:', error);
      res.status(500).json({ error: 'Failed to update task status' });
    }
  },

  // Upload file attachment for Agent Mode
  async uploadAttachment(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Upload to S3 using common utility
      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        user.userId,
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file to S3' });
      }

      res.json({
        url: uploadResult.url,
        key: uploadResult.key,
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload attachment error:', error);
      res.status(500).json({ error: 'Failed to upload attachment' });
    }
  },

  // Create scheduled chat
        async createScheduledChat(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const {
              sessionId,
              scheduleName,
              description,
              startingMessage,
              scheduleFrequency,
              keywords,
              requiredFunctionCalls
            } = req.body;

            if (!scheduleName || !startingMessage || !scheduleFrequency) {
              return res.status(400).json({ error: 'Missing required fields' });
            }

            // If sessionId is provided, verify it exists and belongs to user
            if (sessionId) {
              const session = await chatbotDb.getChatSession(sessionId);
              if (!session || session.userId !== user.userId) {
                return res.status(404).json({ error: 'Session not found' });
              }
            }

            // Create scheduled chat using the existing scheduleDb
            const scheduleId = require('uuid').v4();
            const now = new Date();
            const nextRunTime = calculateNextRunTime(scheduleFrequency, now);

            const scheduledChat = {
              scheduleId,
              taskId: sessionId || 'global', // Use sessionId if provided, otherwise 'global'
              userId: user.userId,
              frequency: scheduleFrequency, // Map scheduleFrequency to frequency
              scheduleName,
              description: description || '',
              startingMessage,
              keywords: keywords || [],
              requiredFunctionCalls: requiredFunctionCalls || [],
              status: 'active',
              nextRunTime: nextRunTime.toISOString(),
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              sessionId: sessionId || null, // Store original sessionId for reference (can be null)
              type: 'scheduled_chat' // Distinguish from regular task schedules
            };

            await scheduleDb.createSchedule(scheduledChat);

            res.status(201).json({
              scheduleId,
              message: 'Scheduled chat created successfully',
              nextRunTime: nextRunTime.toISOString()
            });
          } catch (error) {
            console.error('AgentMode: Create scheduled chat error:', error);
            res.status(500).json({ error: 'Failed to create scheduled chat' });
          }
        },

  // Get user's scheduled chats
  async getScheduledChats(req: Request, res: Response) {
    try {
      const user = req.user as User;

      // Get all schedules for the user and filter for scheduled chats
      const schedules = await scheduleDb.getSchedulesByUserId(user.userId);
      const scheduledChats = schedules?.filter(schedule => 
        schedule.type === 'scheduled_chat' && schedule.status === 'active'
      ) || [];

      res.json(scheduledChats);
    } catch (error) {
      console.error('AgentMode: Get scheduled chats error:', error);
      res.status(500).json({ error: 'Failed to get scheduled chats' });
    }
  },

  // Delete scheduled chat
        async updateScheduledChat(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const { scheduleId } = req.params;
            const {
              scheduleName,
              description,
              startingMessage,
              scheduleFrequency,
              keywords,
              requiredFunctionCalls
            } = req.body;

            if (!scheduleName || !startingMessage || !scheduleFrequency) {
              return res.status(400).json({ error: 'Missing required fields' });
            }

            // Verify schedule exists and belongs to user
            const existingSchedule = await scheduleDb.getScheduleById(scheduleId);
            if (!existingSchedule || existingSchedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Calculate next run time based on new frequency
            const now = new Date();
            const nextRunTime = calculateNextRunTime(scheduleFrequency, now);

            // Update the schedule
            const updates = {
              scheduleName,
              description: description || '',
              startingMessage,
              frequency: scheduleFrequency,
              keywords: keywords || [],
              requiredFunctionCalls: requiredFunctionCalls || [],
              nextRunTime: nextRunTime.toISOString(),
              updatedAt: now.toISOString()
            };

            await scheduleDb.updateSchedule(scheduleId, updates);

            res.json({
              message: 'Scheduled chat updated successfully',
              nextRunTime: nextRunTime.toISOString()
            });
          } catch (error) {
            console.error('AgentMode: Update scheduled chat error:', error);
            res.status(500).json({ error: 'Failed to update scheduled chat' });
          }
        },

        async testScheduledChat(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const { scheduleId } = req.params;

            // Verify schedule exists and belongs to user
            const schedule = await scheduleDb.getScheduleById(scheduleId);
            if (!schedule || schedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Run the scheduled chat as a test
            const result = await runScheduledChat(schedule, user.userId, true);

            res.json(result);

          } catch (error) {
            console.error('AgentMode: Test scheduled chat error:', error);
            res.status(500).json({ error: 'Failed to test scheduled chat' });
          }
        },

        async deleteScheduledChat(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const { scheduleId } = req.params;

            // Verify schedule exists and belongs to user
            const schedule = await scheduleDb.getScheduleById(scheduleId);
            if (!schedule || schedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Delete the schedule
            await scheduleDb.deleteSchedule(scheduleId);

            res.json({ message: 'Scheduled chat deleted successfully' });
          } catch (error) {
            console.error('AgentMode: Delete scheduled chat error:', error);
            res.status(500).json({ error: 'Failed to delete scheduled chat' });
          }
        },

        async getScheduledChatTestHistory(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const { scheduleId } = req.params;

            // Verify schedule exists and belongs to user
            const schedule = await scheduleDb.getScheduleById(scheduleId);
            if (!schedule || schedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Get test history
            const testHistory = await scheduleDb.getRunResults(scheduleId);

            res.json(testHistory);
          } catch (error) {
            console.error('AgentMode: Get test history error:', error);
            res.status(500).json({ error: 'Failed to get test history' });
          }
        },

        async runScheduledChats(req: Request, res: Response) {
          try {
            // Get all scheduled chats that are ready to run
            const scheduledChats = await scheduleDb.getSchedulesReadyToRun();

            if (scheduledChats.length === 0) {
              return res.json({ 
                message: 'No scheduled chats ready to run',
                processed: 0,
                results: []
              });
            }

            const results = [];

            for (const schedule of scheduledChats) {
              try {
                console.log(`Processing scheduled chat: ${schedule.scheduleName} (${schedule.scheduleId})`);
                
                // Update the schedule with next run time FIRST (synchronously)
                // This prevents agent-engine from repeatedly calling the same schedule
                const now = new Date();
                const nextRunTime = calculateNextRunTime(schedule.frequency, now);
                
                await scheduleDb.updateScheduleAfterRun(
                  schedule.scheduleId,
                  now.toISOString(),
                  nextRunTime.toISOString()
                );
                
                console.log(`Updated next run time for schedule: ${schedule.scheduleName}`);
                
                // Start the scheduled chat run asynchronously (don't await)
                runScheduledChat(schedule, schedule.userId, false).then((result) => {
                  console.log(`Successfully completed scheduled chat: ${schedule.scheduleName}`);
                }).catch((error) => {
                  console.error(`Error running scheduled chat ${schedule.scheduleName}:`, error);
                });
                
                results.push({
                  scheduleId: schedule.scheduleId,
                  scheduleName: schedule.scheduleName,
                  status: 'started',
                  nextRunTime: nextRunTime.toISOString()
                });
                
              } catch (error) {
                console.error(`Error processing schedule ${schedule.scheduleName}:`, error);
                
                results.push({
                  scheduleId: schedule.scheduleId,
                  scheduleName: schedule.scheduleName,
                  status: 'error',
                  error: error instanceof Error ? error.message : 'Unknown error'
                });
              }
            }

            res.json({
              message: `Processed ${scheduledChats.length} scheduled chats`,
              processed: scheduledChats.length,
              results: results
            });

          } catch (error) {
            console.error('AgentMode: Run scheduled chats error:', error);
            res.status(500).json({ error: 'Failed to run scheduled chats' });
          }
        }
};