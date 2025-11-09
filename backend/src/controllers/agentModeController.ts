import { Request, Response } from 'express';
import { agentModeService, AgentModeService } from '../services/agentModeService';
import { chatbotDb, updateTaskExecutionStatus } from '../services/chatbotService';
import { scheduleDb, userDb, taskDb } from '../services/db';
import { User } from '../types/auth';
import multer from 'multer';
import crypto from 'crypto';
import { uploadFileToS3 } from '../utils/s3Utils';
import { emailService } from '../services/emailService';
import { settingsService } from '../services/settingsService';
import { v4 as uuidv4 } from 'uuid';
// Common function: ensure a campaign execution exists and contains all HTML report URLs
async function syncEmailCampaignExecution(
  userId: string,
  sessionId: string,
  emailCampaignTaskId: string
): Promise<void> {
  try {
    if (!emailCampaignTaskId) return;

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) return;

    // Collect unique HTML S3 URLs from assistant messages
    const assistantMessages = Array.isArray(session.messages)
      ? session.messages.filter((m: any) => m && m.role === 'assistant' && typeof m.content === 'string')
      : [];
    const htmlUrlRegex = /(https?:\/\/[^\s\"]+\.amazonaws\.com\/[^\s\"]+\.html)/gi;
    const foundUrlsSet = new Set<string>();
    assistantMessages.forEach((msg: any) => {
      let match;
      while ((match = htmlUrlRegex.exec(msg.content)) !== null) {
        foundUrlsSet.add(match[1]);
      }
    });

    const foundUrls = Array.from(foundUrlsSet);
    if (foundUrls.length === 0) return;

    const execId = `agentmode_${sessionId}`;
    const existingExecution = await taskDb.getTaskExecutionById(execId);
    if (!existingExecution) {
      const nowIso = new Date().toISOString();
      await taskDb.createTaskExecution({
        executionId: execId,
        taskId: emailCampaignTaskId,
        userId,
        status: 'completed',
        startTime: nowIso
      });
      const resultFiles = foundUrls.map((url) => ({
        url,
        filename: url.split('/').pop() || 'report.html',
        token: Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
        is_html: true
      }));
      await taskDb.updateTaskExecution(execId, {
        result_files: resultFiles as any
      });
      await taskDb.updateTaskExecution(execId, {
        completedAt: nowIso
      });
    } else {
      const current = existingExecution.result_files || [];
      const currentUrlSet = new Set<string>(current.map((f: any) => f.url));
      const additions = foundUrls
        .filter((u) => !currentUrlSet.has(u))
        .map((url) => ({
          url,
          filename: url.split('/').pop() || 'report.html',
          token: Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
          is_html: true
        }));
      if (additions.length > 0) {
        await taskDb.updateTaskExecution(execId, {
          result_files: [...current, ...additions] as any
        });
      }
    }
  } catch (err) {
    console.error('AgentMode: Email campaign execution sync error:', err);
  }
}

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
  functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
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
    functionCallMinCalls?: { [functionName: string]: number };
  }
): {
  passed: boolean;
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
} {
  const expectedKeywords = expectedOutput.keywords || [];
  const expectedFunctionCalls = expectedOutput.functionCalls || [];
  const functionCallMinCalls = expectedOutput.functionCallMinCalls || {};

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

  // Evaluate function calls with minimum call requirements
  const functionCallMatches: string[] = [];
  const functionCallMisses: string[] = [];
  const functionCallDetails: { [functionName: string]: { actual: number; required: number } } = {};
  
  // Count actual function calls using a hash map
  const actualFunctionCallCounts: { [functionName: string]: number } = {};
  actualFunctionCalls.forEach((call: string) => {
    actualFunctionCallCounts[call] = (actualFunctionCallCounts[call] || 0) + 1;
  });
  
  expectedFunctionCalls.forEach((expectedCall: string) => {
    const actualCount = actualFunctionCallCounts[expectedCall] || 0;
    const requiredCount = functionCallMinCalls[expectedCall] || 1; // Default to 1 if not specified
    
    functionCallDetails[expectedCall] = {
      actual: actualCount,
      required: requiredCount
    };
    
    if (actualCount >= requiredCount) {
      functionCallMatches.push(expectedCall);
    } else {
      functionCallMisses.push(expectedCall);
    }
  });

  // Pass only if ALL expected keywords and ALL expected function calls meet minimum requirements
  const allKeywordsPresent = expectedKeywords.length === 0 || keywordMisses.length === 0;
  const allFunctionCallsPresent = expectedFunctionCalls.length === 0 || functionCallMisses.length === 0;
  const passed = allKeywordsPresent && allFunctionCallsPresent;

  return {
    passed,
    keywordMatches,
    keywordMisses,
    functionCallMatches,
    functionCallMisses,
    functionCallDetails
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

// Helper function to check if this is the last run of the day for an hourly schedule
function isLastRunOfDayForHourlySchedule(currentTime: Date, nextRunTime: Date): boolean {
  const currentDay = currentTime.getDate();
  const nextDay = nextRunTime.getDate();
  const currentMonth = currentTime.getMonth();
  const nextMonth = nextRunTime.getMonth();
  const currentYear = currentTime.getFullYear();
  const nextYear = nextRunTime.getFullYear();
  
  // If the next run is on a different day, month, or year, this is the last run of the current day
  return nextDay !== currentDay || nextMonth !== currentMonth || nextYear !== currentYear;
}

// Helper function to send daily digest email
async function sendDailyDigestEmail(schedule: any, emailNotifications: string[]) {
  try {
    // Get all run results for today
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    
    const runResults = await scheduleDb.getRunResults(schedule.scheduleId);
    const todaysResults = runResults.filter((result: any) => {
      const resultDate = new Date(result.createdAt);
      return resultDate >= startOfDay && resultDate < endOfDay;
    });
    
    if (todaysResults.length === 0) {
      console.log(`No run results found for today for schedule ${schedule.scheduleName}`);
      return;
    }
    
    // Send daily digest email
    await emailService.sendDailyDigestEmail(
      emailNotifications,
      schedule.scheduleName,
      todaysResults,
      schedule.scheduleId
    );
    
    console.log(`Daily digest email sent for schedule ${schedule.scheduleName} with ${todaysResults.length} results`);
  } catch (error) {
    console.error(`Error sending daily digest email for schedule ${schedule.scheduleName}:`, error);
    throw error;
  }
}

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
  const maxTries = 20;
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
    functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
    executionTime: number;
    sessionId: string;
    attempt: number;
    createdAt: string;
  } | null = null;

  // Track missing items across all attempts
  const expectedKeywords = schedule.keywords || [];
  const expectedFunctionCalls = schedule.requiredFunctionCalls || [];
  const functionCallMinCalls = schedule.functionCallMinCalls || {};
  let remainingKeywords = [...expectedKeywords];
  let remainingFunctionCalls = [...expectedFunctionCalls];
  
  // Track remaining function call counts
  const remainingFunctionCallCounts: { [functionName: string]: number } = {};
  expectedFunctionCalls.forEach((funcName: string) => {
    remainingFunctionCallCounts[funcName] = functionCallMinCalls[funcName] || 1;
  });
  
  // Track all function calls across all attempts
  // allActualFunctionCallsForReporting: never modified, used for final reporting (array format)
  // allActualFunctionCalls: modified during evaluation to prevent double-counting (key-value format for easy updates)
  const allActualFunctionCallsForReporting: string[] = [];
  const allActualFunctionCalls: Record<string, number> = {};

  try {
    // Create a session for the run
    const sessionTitle = isTest ? `Test: ${schedule.scheduleName}` : `Scheduled: ${schedule.scheduleName}`;
    const testSession = await chatbotDb.createChatSession(
      userId, 
      undefined, 
      "agent", 
      sessionTitle,
      undefined,
      undefined,
      undefined,
      schedule.emailCampaignTaskId
    );
    const sessionId = testSession.sessionId;

  while (attempt < maxTries) {
    attempt++;
    
    try {
      // Prepare user message for this attempt
      let userMessage = schedule.startingMessage;
      
      if (attempt > 1) {
        // Check work plan status
        const session = await chatbotDb.getChatSession(sessionId);
        const workPlan = session?.workPlan;
        const workPlanCompleted = workPlan && workPlan.steps.every((step: any) => step.status === 'completed' || step.status === 'skipped');
        
        if (workPlan && !workPlanCompleted) {
          // Remind to complete pending steps
          userMessage = `Please perform the work on pending steps. After you are done, mark the steps as completed with set_work_plan_status.`;
        } else {
          // Work plan completed or doesn't exist - check keywords and function calls
          const keywordText = remainingKeywords.length > 0 
            ? `include these keywords: ${remainingKeywords.join(', ')}` 
            : '';
          const functionCallText = remainingFunctionCalls.length > 0
            ? `use these function calls: ${remainingFunctionCalls.map(funcName => {
                const remainingCount = remainingFunctionCallCounts[funcName] || 0;
                return `${funcName} (${remainingCount} more time${remainingCount > 1 ? 's' : ''} needed)`;
              }).join(', ')}`
            : '';
          
          const parts = [keywordText, functionCallText].filter(Boolean);
          userMessage = parts.length > 0
            ? `Please try again. Make sure to ${parts.join(' and ')}.`
            : schedule.startingMessage;
        }
      }

      // Generate response using the common function (same as /generateResponse)
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        userId
      );

      // Extract function calls from the response
      const actualFunctionCalls = response.toolCalls?.map((call: any) => call.name).filter(Boolean) || [];
      
      // Add to reporting array
      allActualFunctionCallsForReporting.push(...actualFunctionCalls);
      
      // Add to key-value format for easy updates
      actualFunctionCalls.forEach((callName: string) => {
        allActualFunctionCalls[callName] = (allActualFunctionCalls[callName] || 0) + 1;
      });

      // Check work plan status
      const workPlan = response.workPlan;
      const workPlanCompleted = workPlan && workPlan.steps.every((step: any) => step.status === 'completed' || step.status === 'skipped');

      // Only evaluate keywords and function calls if work plan is completed or doesn't exist
      let evaluation = {
        passed: true,
        keywordMatches: [] as string[],
        keywordMisses: [] as string[],
        functionCallMatches: [] as string[],
        functionCallMisses: [] as string[]
      };

      if (!workPlan || workPlanCompleted) {
        // Convert Record to array for evaluation
        const allActualFunctionCallsArray: string[] = [];
        Object.keys(allActualFunctionCalls).forEach((funcName: string) => {
          const count = allActualFunctionCalls[funcName] || 0;
          for (let i = 0; i < count; i++) {
            allActualFunctionCallsArray.push(funcName);
          }
        });

        // Evaluate against cumulative calls to check if requirements are met
        evaluation = evaluateScheduleResponse(
          response.content,
          allActualFunctionCallsArray,
          {
            keywords: remainingKeywords,
            functionCalls: remainingFunctionCalls,
            functionCallMinCalls: functionCallMinCalls
          }
        );

        // Update remaining function call counts and remove matched calls from allActualFunctionCalls
        // This prevents double-counting in future evaluations
        evaluation.functionCallMatches.forEach((matchedFunc: string) => {
          const requiredCount = functionCallMinCalls[matchedFunc] || 1;
          
          // Update remaining counts
          if (remainingFunctionCallCounts.hasOwnProperty(matchedFunc)) {
            remainingFunctionCallCounts[matchedFunc] -= requiredCount;
            if (remainingFunctionCallCounts[matchedFunc] < 0) {
              remainingFunctionCallCounts[matchedFunc] = 0;
            }
          }
          
          // Decrement the count of matched calls from allActualFunctionCalls
          // This prevents them from being counted again in future evaluations
          if (allActualFunctionCalls.hasOwnProperty(matchedFunc)) {
            allActualFunctionCalls[matchedFunc] -= requiredCount;
            if (allActualFunctionCalls[matchedFunc] <= 0) {
              delete allActualFunctionCalls[matchedFunc];
            }
          }
        });

        // Remove matched keywords
        remainingKeywords = remainingKeywords.filter(keyword => 
          !evaluation.keywordMatches.includes(keyword)
        );
        
        // Remove function calls from remaining list when their count reaches zero
        remainingFunctionCalls = remainingFunctionCalls.filter(funcCall => 
          remainingFunctionCallCounts[funcCall] > 0
        );
      }

      // Calculate cumulative results across all attempts
      const totalKeywordMatches = expectedKeywords.filter((keyword: string) => 
        !remainingKeywords.includes(keyword)
      );
      const totalFunctionCallMatches = expectedFunctionCalls.filter((funcCall: string) => 
        !remainingFunctionCalls.includes(funcCall)
      );

      // Calculate final function call details using cumulative counts from reporting array
      const finalFunctionCallDetails: { [functionName: string]: { actual: number; required: number } } = {};
      const actualFunctionCallCounts: { [functionName: string]: number } = {};
      allActualFunctionCallsForReporting.forEach((call: string) => {
        actualFunctionCallCounts[call] = (actualFunctionCallCounts[call] || 0) + 1;
      });
      
      expectedFunctionCalls.forEach((funcCall: string) => {
        const actualCount = actualFunctionCallCounts[funcCall] || 0;
        const requiredCount = functionCallMinCalls[funcCall] || 1;
        finalFunctionCallDetails[funcCall] = {
          actual: actualCount,
          required: requiredCount
        };
      });

      // Check if all requirements are met
      // If work plan exists and is not completed, requirements are not met
      // Otherwise, check keywords and function calls
      const allRequirementsMet = (!workPlan || workPlanCompleted) && 
        remainingKeywords.length === 0 && 
        remainingFunctionCalls.length === 0;

      finalResult = {
        scheduleId: schedule.scheduleId,
        runId: require('uuid').v4(),
        status: allRequirementsMet ? 'success' : 'failure',
        passed: allRequirementsMet,
        actualResponse: response.content,
        actualFunctionCalls: allActualFunctionCallsForReporting,
        keywordMatches: totalKeywordMatches,
        keywordMisses: remainingKeywords,
        functionCallMatches: totalFunctionCallMatches,
        functionCallMisses: remainingFunctionCalls,
        functionCallDetails: finalFunctionCallDetails,
        executionTime: Date.now() - now.getTime(),
        sessionId: sessionId,
        attempt,
        createdAt: new Date().toISOString()
      };

      // If all requirements met, break out of loop
      if (allRequirementsMet) {
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

  // Also sync Research Reports execution for email campaigns
  try {
    if (schedule.emailCampaignTaskId) {
      await syncEmailCampaignExecution(userId, finalResult.sessionId, schedule.emailCampaignTaskId);
    }
  } catch (err) {
    console.error('AgentMode: Email campaign execution sync after run error:', err);
  }
    
    return finalResult;
  
  } catch (error) {
    console.error(`Error in runScheduledChat for ${schedule.scheduleName}:`, error);
    console.error('Full error details:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Unknown'
    });
    throw error;
  }
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
  workPlan?: any;
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

  // Get the updated session to include workPlan if it was modified
  const finalSession = await chatbotDb.getChatSession(sessionId);
  
  return {
    ...response,
    workPlan: finalSession?.workPlan
  };
}

// Helper function to calculate next run time based on frequency
const calculateNextRunTime = (frequency: string, fromDate: Date): Date => {
  const nextRun = new Date(fromDate);
  
  switch (frequency) {
    case 'hourly':
      nextRun.setHours(nextRun.getHours() + 1);
      nextRun.setMinutes(0, 0, 0); // Top of the hour
      break;
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
  // Get user's agent chat sessions with infinite scroll support
  async getSessions(req: Request, res: Response) {
    try {
      const user = req.user as User;
      
      // Parse pagination parameters
      const lastEvaluatedKey = req.query.lastEvaluatedKey as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100 per request
      
      // Get sessions with pagination
      const result = await chatbotDb.getUserSessions(user.userId, 'agent', limit, true, lastEvaluatedKey);
      
      // Filter out tool messages and assistant messages with tool calls for user display
      const filteredSessions = result.sessions.map(session => ({
        ...session,
        messages: filterMessagesForClient(session.messages)
      }));
      
      res.json({
        sessions: filteredSessions,
        lastEvaluatedKey: result.lastEvaluatedKey,
        hasMore: !!result.lastEvaluatedKey
      });
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

      await syncEmailCampaignExecution(session.userId, session.sessionId, session.emailCampaignTaskId || '');

      // Filter out tool messages and assistant messages with tool calls for user display
      const filteredSession = {
        ...session,
        messages: filterMessagesForClient(session.messages)
      };

      res.json(filteredSession);
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
        sources: response.sources,
        workPlan: response.workPlan
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
        
        if (error.message.includes('content policies') || error.message.includes('violate content policies')) {
          res.status(400).json({ 
            error: 'Content policy violation',
            message: error.message,
            code: 'CONTENT_FILTER',
            suggestion: 'rephrase_message'
          });
          return;
        }
        
        if (error.message.includes('high demand')) {
          res.status(429).json({ 
            error: 'Rate limit exceeded',
            message: error.message,
            code: 'RATE_LIMIT',
            suggestion: 'wait_and_retry'
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

      res.status(200).json({ 
        shareId,
        shareUrl: `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5176'}/share/${shareId}`
      });
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

      // Update share metadata to disable sharing while preserving other fields
      const currentShareMetadata = session.shareMetadata || {};
      await chatbotDb.updateSessionShareMetadata(sessionId, { 
        ...currentShareMetadata,
        isShared: false 
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop sharing error:', error);
      res.status(500).json({ error: 'Failed to stop sharing' });
    }
  },

  // Get share information for a session
  async getShareInfo(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if the session is shared
      if (!session.shareMetadata?.isShared) {
        return res.status(404).json({ error: 'Session is not shared' });
      }

      // Return the share information
      res.json({
        shareId: sessionId, // The sessionId is used as the shareId
        isShared: true,
        sharedAt: session.shareMetadata.sharedAt,
        expiresAt: session.shareMetadata.expiresAt,
        conversableShare: (session.shareMetadata as any).conversableShare ? {
          isActive: (session.shareMetadata as any).conversableShare.isActive,
          sharedAt: (session.shareMetadata as any).conversableShare.sharedAt,
          conversableUrl: `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5176'}/ishare/${sessionId}?conversable=${(session.shareMetadata as any).conversableShare.token}`
        } : null
      });
    } catch (error) {
      console.error('AgentMode: Get share info error:', error);
      res.status(500).json({ error: 'Failed to get share information' });
    }
  },

  // Create conversable share link for a session
  async createConversableShare(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.body;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Use the common function to create or reuse interactive share
      const conversableUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);
      
      // Extract the token from the URL for backward compatibility
      const urlParams = new URL(conversableUrl).searchParams;
      const conversableToken = urlParams.get('conversable') || '';

      res.status(200).json({
        shareId: sessionId,
        conversableToken: conversableToken,
        conversableUrl: conversableUrl
      });
    } catch (error) {
      console.error('AgentMode: Create conversable share error:', error);
      res.status(500).json({ error: 'Failed to create conversable share link' });
    }
  },

  // Stop conversable sharing
  async stopConversableShare(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Update interactive share metadata to disable sharing while preserving other fields
      const currentInteractiveShareMetadata = session.interactiveShareMetadata || {};
      const interactiveShareMetadata = {
        ...currentInteractiveShareMetadata,
        isActive: false
      };
      
      await chatbotDb.updateSessionInteractiveShareMetadata(sessionId, interactiveShareMetadata);

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop conversable share error:', error);
      res.status(500).json({ error: 'Failed to stop conversable sharing' });
    }
  },

  // Get shared conversation
  async getSharedConversation(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;

      // Get the session data directly using shareId as sessionId
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Check sharing status
      const hasViewOnlyShare = session.shareMetadata?.isShared;
      const hasInteractiveShare = session.interactiveShareMetadata?.isActive;
      
      // If it's a conversable request (interactive share), ensure there's a valid interactive share
      if (conversable) {
        if (!hasInteractiveShare) {
          return res.status(404).json({ error: 'This conversation does not have interactive sharing enabled' });
        }
      } else {
        // If it's a view-only request, ensure there's a valid view-only share
        if (!hasViewOnlyShare) {
          return res.status(404).json({ error: 'This conversation is not shared for viewing' });
        }
      }

      // Check if view-only share expired (only if expiresAt is set)
      if (hasViewOnlyShare && session.shareMetadata?.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
        // Remove share metadata if expired
        await chatbotDb.updateSessionShareMetadata(shareId, { isShared: false });
        return res.status(410).json({ error: 'Share link has expired' });
      }

      // If conversable token is provided, validate it
      if (conversable) {
        const interactiveToken = session.interactiveShareMetadata?.token;
        if (!interactiveToken || interactiveToken !== conversable) {
          return res.status(401).json({ error: 'Invalid or expired interactive token' });
        }
      }

      res.status(200).json({
        session: {
          sessionId: session.sessionId,
          title: session.title,
          messages: filterMessagesForClient(session.messages),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          shareMetadata: session.shareMetadata,
          interactiveShareMetadata: session.interactiveShareMetadata,
          workPlan: session.workPlan,
          isConversable: !!conversable
        }
      });
    } catch (error) {
      console.error('AgentMode: Get shared conversation error:', error);
      res.status(500).json({ error: 'Failed to get shared conversation' });
    }
  },

  // Generate response for shared conversation (with conversable token)
  async generateSharedResponse(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;
      const { userMessage, attachments = [] } = req.body;

      if (!userMessage) {
        return res.status(400).json({ error: 'User message is required' });
      }

      // Get the session to verify the conversable token
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if conversable sharing is active and token matches
      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      const interactiveShare = session.interactiveShareMetadata;
      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Use the same generateSessionResponse logic as the regular generateResponse
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId,
        attachments
      );

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan
      });
    } catch (error) {
      console.error('AgentMode: Generate shared response error:', error);
      
      // Handle specific error types (same as generateResponse)
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
        
        if (error.message.includes('content policies') || error.message.includes('violate content policies')) {
          res.status(400).json({ 
            error: 'Content policy violation',
            message: error.message,
            code: 'CONTENT_FILTER',
            suggestion: 'rephrase_message'
          });
          return;
        }
        
        if (error.message.includes('high demand')) {
          res.status(429).json({ 
            error: 'Rate limit exceeded',
            message: error.message,
            code: 'RATE_LIMIT',
            suggestion: 'wait_and_retry'
          });
          return;
        }
      }
      
      res.status(500).json({ error: 'Failed to generate response' });
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
              requiredFunctionCalls,
              functionCallMinCalls,
              emailNotifications,
              emailCampaignTaskId
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
              functionCallMinCalls: functionCallMinCalls || {},
              emailNotifications: emailNotifications || [],
              dailyDigest: scheduleFrequency === 'hourly' ? (req.body.dailyDigest || false) : false, // Only allow daily digest for hourly schedules
              status: 'active',
              nextRunTime: nextRunTime.toISOString(),
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              sessionId: sessionId || null, // Store original sessionId for reference (can be null)
              type: 'scheduled_chat', // Distinguish from regular task schedules
              emailCampaignTaskId: emailCampaignTaskId || null
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
        schedule.type === 'scheduled_chat'
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
              requiredFunctionCalls,
              functionCallMinCalls,
              emailNotifications,
              dailyDigest,
              emailCampaignTaskId
            } = req.body;

            if (!scheduleName || !startingMessage || !scheduleFrequency) {
              return res.status(400).json({ error: 'Missing required fields' });
            }

            // Verify schedule exists and belongs to user
            const existingSchedule = await scheduleDb.getScheduleById(scheduleId);
            if (!existingSchedule || existingSchedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Update the schedule without modifying nextRunTime
            // nextRunTime should only be updated when the schedule actually runs
            const now = new Date();

            // Update the schedule
            const updates = {
              scheduleName,
              description: description || '',
              startingMessage,
              frequency: scheduleFrequency,
              keywords: keywords || [],
              requiredFunctionCalls: requiredFunctionCalls || [],
              functionCallMinCalls: functionCallMinCalls || {},
              emailNotifications: emailNotifications || [],
              dailyDigest: scheduleFrequency === 'hourly' ? (dailyDigest || false) : false, // Only allow daily digest for hourly schedules
              updatedAt: now.toISOString(),
              emailCampaignTaskId: emailCampaignTaskId || null
            };

            await scheduleDb.updateSchedule(scheduleId, updates);

            // Return the existing nextRunTime from the schedule
            res.json({
              message: 'Scheduled chat updated successfully',
              nextRunTime: existingSchedule.nextRunTime
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

        async toggleScheduledChatStatus(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const { scheduleId } = req.params;
            const { status } = req.body;

            if (!status || !['active', 'paused'].includes(status)) {
              return res.status(400).json({ error: 'Invalid status. Must be "active" or "paused"' });
            }

            // Verify schedule exists and belongs to user
            const schedule = await scheduleDb.getScheduleById(scheduleId);
            if (!schedule || schedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Update the schedule status
            await scheduleDb.updateSchedule(scheduleId, { 
              status,
              updatedAt: new Date().toISOString()
            });

            res.json({ message: `Scheduled chat ${status === 'active' ? 'enabled' : 'paused'} successfully` });

          } catch (error) {
            console.error('AgentMode: Toggle scheduled chat status error:', error);
            res.status(500).json({ error: 'Failed to toggle scheduled chat status' });
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

        async sendScheduledChatTestEmail(req: Request, res: Response) {
          try {
            const user = req.user as User;
            const { scheduleId, runId } = req.params as { scheduleId: string; runId: string };
            const { toEmail } = req.body as { toEmail: string };

            if (!toEmail) {
              return res.status(400).json({ error: 'toEmail is required' });
            }

            // Verify schedule exists and belongs to user
            const schedule = await scheduleDb.getScheduleById(scheduleId);
            if (!schedule || schedule.userId !== user.userId) {
              return res.status(404).json({ error: 'Scheduled chat not found' });
            }

            // Load test history and find the record
            const testHistory = await scheduleDb.getRunResults(scheduleId);
            const record = (testHistory || []).find((r: any) => r.runId === runId);
            if (!record) {
              return res.status(404).json({ error: 'Test record not found' });
            }

            // Check if this is an hourly schedule with daily digest enabled
            if (schedule.frequency === 'hourly' && schedule.dailyDigest) {
              // For hourly schedules with daily digest, send a daily digest email
              // Get all run results for the same date as the selected test entry
              const selectedResultDate = new Date(record.createdAt);
              const startOfDay = new Date(selectedResultDate.getFullYear(), selectedResultDate.getMonth(), selectedResultDate.getDate());
              const endOfDay = new Date(selectedResultDate.getFullYear(), selectedResultDate.getMonth(), selectedResultDate.getDate() + 1);
              
              const sameDayResults = testHistory.filter((result: any) => {
                const resultDate = new Date(result.createdAt);
                return resultDate >= startOfDay && resultDate < endOfDay;
              });
              
              if (sameDayResults.length > 0) {
                // Send daily digest email for the specific date
                await emailService.sendDailyDigestEmail(
                  [toEmail],
                  schedule.scheduleName,
                  sameDayResults,
                  schedule.scheduleId,
                  selectedResultDate
                );
                
                const dateStr = selectedResultDate.toLocaleDateString('en-US', { 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric' 
                });
                
                res.json({ 
                  success: true, 
                  message: `Daily digest email sent with all results from ${dateStr}`,
                  resultCount: sameDayResults.length,
                  date: dateStr
                });
                return;
              }
            }

            // For non-hourly schedules or hourly without daily digest, send individual email
            // Build a result object compatible with emailService
            const resultForEmail = {
              passed: !!record.passed,
              actualResponse: record.actualResponse || record.response || '',
              keywordMatches: record.keywordMatches || [],
              keywordMisses: record.keywordMisses || [],
              functionCallMatches: record.functionCallMatches || [],
              functionCallMisses: record.functionCallMisses || [],
              executionTime: record.executionTime || 0,
              sessionId: record.sessionId,
              attempt: record.attempt || 1,
              createdAt: record.createdAt || new Date().toISOString(),
            };

            await emailService.sendScheduledChatResultEmail(
              [toEmail],
              schedule.scheduleName,
              resultForEmail,
              schedule.scheduleId
            );

            res.json({ success: true });
          } catch (error) {
            console.error('AgentMode: Send scheduled chat test email error:', error);
            res.status(500).json({ error: 'Failed to send test email' });
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
            // Update the schedule with next run time FIRST (synchronously)
            // This prevents agent-engine from repeatedly calling the same schedule
            const now = new Date();
            const nextRunTime = calculateNextRunTime(schedule.frequency, now);
            
            await scheduleDb.updateScheduleAfterRun(
              schedule.scheduleId,
              now.toISOString(),
              nextRunTime.toISOString()
            );
            
             // Start the scheduled chat run asynchronously (don't await)
             runScheduledChat(schedule, schedule.userId, false).then(async (result) => {
               // Send email notification with the result
               try {
                 // Only send emails if email notifications are specified
                 const emailNotifications = schedule.emailNotifications || [];
                 if (emailNotifications.length > 0) {
                   // Check if this is an hourly schedule with daily digest enabled
                   if (schedule.frequency === 'hourly' && schedule.dailyDigest) {
                     // Check if this is the last run of the day
                     const now = new Date();
                     const nextRunTime = calculateNextRunTime('hourly', now);
                     const isLastRunOfDay = isLastRunOfDayForHourlySchedule(now, nextRunTime);
                     
                     if (isLastRunOfDay) {
                       // Send daily digest instead of individual email
                       await sendDailyDigestEmail(schedule, emailNotifications);
                     }
                     // For hourly schedules with daily digest, don't send individual emails
                     // Only send the daily digest on the last run of the day
                   } else {
                     // Send individual email as usual for non-hourly schedules or hourly without daily digest
                     await emailService.sendScheduledChatResultEmail(
                       emailNotifications,
                       schedule.scheduleName,
                       result,
                       schedule.scheduleId
                     );
                   }
                 } else {
                   console.log(`No email notifications configured for schedule ${schedule.scheduleName}, skipping email send`);
                 }
               } catch (error) {
                 console.error('Error sending scheduled chat result email:', error);
                 // Don't throw error - email failure shouldn't break the scheduled chat execution
               }
             }).catch((error) => {
               console.error(`Error running scheduled chat ${schedule.scheduleName}:`, error);
               // Log the full error details for debugging
               console.error('Full error details:', {
                 message: error.message,
                 stack: error.stack,
                 name: error.name
               });
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
        },

  // Get session for conversable access
  async getConversableSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const session = (req as any).conversableSession;

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({
        sessionId: session.sessionId,
        title: session.title,
        messages: filterMessagesForClient(session.messages),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        workPlan: session.workPlan,
        isConversable: true
      });
    } catch (error) {
      console.error('AgentMode: Get conversable session error:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  },

  // Generate response for conversable session
  async generateConversableResponse(req: Request, res: Response) {
    try {
      const { userMessage, attachments } = req.body;
      const session = (req as any).conversableSession;

      if (!userMessage) {
        return res.status(400).json({ error: 'User message is required' });
      }

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Generate AI response using the same function as regular users
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId, // Use the original session owner's userId
        attachments
      );

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan
      });
    } catch (error) {
      console.error('AgentMode: Generate conversable response error:', error);
      
      // Handle specific error types (same as generateResponse)
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
        
        if (error.message.includes('content policies') || error.message.includes('violate content policies')) {
          res.status(400).json({ 
            error: 'Content policy violation',
            message: error.message,
            code: 'CONTENT_FILTER',
            suggestion: 'rephrase_message'
          });
          return;
        }
        
        if (error.message.includes('high demand')) {
          res.status(429).json({ 
            error: 'Rate limit exceeded',
            message: error.message,
            code: 'RATE_LIMIT',
            suggestion: 'wait_and_retry'
          });
          return;
        }
      }
      
      res.status(500).json({ error: 'Failed to generate response' });
    }
  },

  // Get predefined work plan by title (public)
  async getPredefinedWorkPlan(req: Request, res: Response) {
    try {
      const { planTitle } = req.params;
      
      if (!planTitle) {
        return res.status(400).json({ error: 'Plan title is required' });
      }

      // Load predefined work plans from settings
      const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
      
      if (!setting || !setting.settingValue) {
        return res.status(404).json({ error: 'No predefined work plans found' });
      }

      const workPlans = JSON.parse(setting.settingValue);
      
      // Find work plan with matching title (case-insensitive)
      const workPlan = workPlans.find((wp: any) => 
        wp.title && wp.title.toLowerCase() === planTitle.toLowerCase()
      );

      if (!workPlan) {
        return res.status(404).json({ error: `Work plan "${planTitle}" not found` });
      }

      res.json(workPlan);
    } catch (error) {
      console.error('AgentMode: Get predefined work plan error:', error);
      res.status(500).json({ error: 'Failed to get predefined work plan' });
    }
  },

  // Create session with predefined work plan (public)
  async createSessionWithPlan(req: Request, res: Response) {
    try {
      const { planTitle } = req.params;
      
      if (!planTitle) {
        return res.status(400).json({ error: 'Plan title is required' });
      }

      // Get predefined work plan
      const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
      
      if (!setting || !setting.settingValue) {
        return res.status(404).json({ error: 'No predefined work plans found' });
      }

      const workPlans = JSON.parse(setting.settingValue);
      
      // Find work plan with matching title (case-insensitive)
      const predefinedPlan = workPlans.find((wp: any) => 
        wp.title && wp.title.toLowerCase() === planTitle.toLowerCase()
      );

      if (!predefinedPlan) {
        return res.status(404).json({ error: `Work plan "${planTitle}" not found` });
      }

      // Generate anonymous userId
      const anonymousUserId = `anon_${uuidv4()}`;

      // Create session with anonymous userId
      const session = await chatbotDb.createChatSession(
        anonymousUserId,
        undefined, // pageContent
        'agent', // portalType
        `plan-${planTitle}`, // pageIdentifier
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined, // executionId
        undefined  // emailCampaignTaskId
      );

      // Convert predefined plan to session work plan format
      const workPlan = {
        title: predefinedPlan.title,
        steps: predefinedPlan.steps.map((step: any) => ({
          stepCount: step.stepCount,
          title: step.title,
          description: step.description,
          status: 'pending' as const,
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: step.requiredFunctionCalls
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Create work plan in session (include welcome message if defined)
      const workPlanWithWelcome = {
        ...workPlan,
        welcomeMessage: predefinedPlan.welcomeMessage?.trim() || undefined
      };
      await chatbotDb.updateSessionWorkPlan(session.sessionId, workPlanWithWelcome);

      // Enable interactive sharing for the session
      const conversableToken = crypto.randomBytes(32).toString('hex');
      const interactiveShareMetadata = {
        isActive: true,
        token: conversableToken,
        sharedAt: new Date().toISOString()
      };
      await chatbotDb.updateSessionInteractiveShareMetadata(session.sessionId, interactiveShareMetadata);

      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const redirectUrl = `${customerFrontendUrl}/plan/${encodeURIComponent(planTitle)}/${session.sessionId}?conversable=${conversableToken}`;

      res.json({
        sessionId: session.sessionId,
        redirectUrl,
        workPlan: workPlanWithWelcome,
        conversableToken
      });
    } catch (error) {
      console.error('AgentMode: Create session with plan error:', error);
      res.status(500).json({ error: 'Failed to create session with plan' });
    }
  }
};