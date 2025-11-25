import { Request, Response } from 'express';
import { AuthenticatedRequest, getUserFromToken } from '../middleware/auth';
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
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { emitProgress, registerProgressCallback, getLatestProgress, progressStore } from '../utils/sseProgress';
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

// Common function to run verified chat with work plan, keywords, and function call verification
// Used by both scheduled chat and verified-generate
async function runVerifiedChat(
  params: {
    sessionId: string;
    userId: string;
    startingMessage: string;
    keywords: string[];
    requiredFunctions: Array<{ functionName: string; minCount: number }>;
    maxAttempts?: number;
    attachments?: any[];
  }
): Promise<{
  success: boolean;
  content: string;
  toolCalls: any[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  functionStatus: Array<{
    functionName: string;
    requiredCount: number;
    actualCount: number;
    met: boolean;
  }>;
  attempts: number;
  workPlanCompleted: boolean;
}> {
  const {
    sessionId,
    userId,
    startingMessage,
    keywords = [],
    requiredFunctions = [],
    maxAttempts = 20,
    attachments = []
  } = params;

  let attempt = 0;
  let allContent = '';
  const allToolCalls: any[] = [];
  
  // Track remaining keywords and function calls
  let remainingKeywords = [...keywords];
  const remainingFunctionCallCounts: Record<string, number> = {};
  requiredFunctions.forEach((reqFunc) => {
    remainingFunctionCallCounts[reqFunc.functionName] = reqFunc.minCount;
  });

  // Track all function calls for reporting (array format)
  const allActualFunctionCallsForReporting: string[] = [];
  // Track function calls for evaluation (key-value format, modified during evaluation)
  const allActualFunctionCalls: Record<string, number> = {};

  while (attempt < maxAttempts) {
    attempt++;

    try {
      // Prepare user message for this attempt
      let userMessage = startingMessage;

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
          const functionCallText = requiredFunctions
            .filter(reqFunc => {
              const currentCount = allActualFunctionCalls[reqFunc.functionName] || 0;
              return currentCount < reqFunc.minCount;
            })
            .map(reqFunc => {
              const currentCount = allActualFunctionCalls[reqFunc.functionName] || 0;
              const remaining = reqFunc.minCount - currentCount;
              return `${reqFunc.functionName} (${remaining} more time${remaining > 1 ? 's' : ''} needed)`;
            })
            .join(', ');

          const parts = [keywordText, functionCallText].filter(Boolean);
          userMessage = parts.length > 0
            ? `Please try again. Make sure to ${parts.join(' and ')}.`
            : startingMessage;
        }
      }

      // Generate response
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        userId,
        attachments
      );

      // Update content
      if (response.content) {
        allContent += (allContent ? '\n\n' : '') + response.content;
      }

      // Extract function calls from the response
      const toolCalls = response.toolCalls || [];
      allToolCalls.push(...toolCalls);
      const actualFunctionCalls = toolCalls.map((call: any) => call.name).filter(Boolean);

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
      let keywordMatches: string[] = [];
      let keywordMisses: string[] = [];
      let functionCallMatches: string[] = [];
      let functionCallMisses: string[] = [];

      if (!workPlan || workPlanCompleted) {
        // Evaluate keywords
        remainingKeywords.forEach((keyword: string) => {
          if (allContent.toLowerCase().includes(keyword.toLowerCase())) {
            keywordMatches.push(keyword);
          } else {
            keywordMisses.push(keyword);
          }
        });

        // Remove matched keywords
        remainingKeywords = remainingKeywords.filter(keyword =>
          !keywordMatches.includes(keyword)
        );

        // Evaluate function calls
        requiredFunctions.forEach((reqFunc) => {
          const actualCount = allActualFunctionCalls[reqFunc.functionName] || 0;
          if (actualCount >= reqFunc.minCount) {
            functionCallMatches.push(reqFunc.functionName);
            // Update remaining counts and remove matched calls from allActualFunctionCalls
            // This prevents double-counting in future evaluations
            if (remainingFunctionCallCounts.hasOwnProperty(reqFunc.functionName)) {
              remainingFunctionCallCounts[reqFunc.functionName] -= reqFunc.minCount;
              if (remainingFunctionCallCounts[reqFunc.functionName] < 0) {
                remainingFunctionCallCounts[reqFunc.functionName] = 0;
              }
            }
            // Decrement the count of matched calls from allActualFunctionCalls
            if (allActualFunctionCalls.hasOwnProperty(reqFunc.functionName)) {
              allActualFunctionCalls[reqFunc.functionName] -= reqFunc.minCount;
              if (allActualFunctionCalls[reqFunc.functionName] <= 0) {
                delete allActualFunctionCalls[reqFunc.functionName];
              }
            }
          } else {
            functionCallMisses.push(reqFunc.functionName);
          }
        });
      }

      // Check if all requirements are met
      const allKeywordsMet = remainingKeywords.length === 0;
      const allFunctionCallsMet = requiredFunctions.every(reqFunc => {
        const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
        return actualCount >= reqFunc.minCount;
      });
      const allRequirementsMet = (!workPlan || workPlanCompleted) && allKeywordsMet && allFunctionCallsMet;

      if (allRequirementsMet) {
        // Build final function status
        const functionStatus = requiredFunctions.map((reqFunc) => {
          const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
          return {
            functionName: reqFunc.functionName,
            requiredCount: reqFunc.minCount,
            actualCount: actualCount,
            met: actualCount >= reqFunc.minCount
          };
        });

        return {
          success: true,
          content: allContent,
          toolCalls: allToolCalls,
          keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
          keywordMisses: remainingKeywords,
          functionCallMatches: requiredFunctions.filter(reqFunc => {
            const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
            return actualCount >= reqFunc.minCount;
          }).map(reqFunc => reqFunc.functionName),
          functionCallMisses: requiredFunctions.filter(reqFunc => {
            const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
            return actualCount < reqFunc.minCount;
          }).map(reqFunc => reqFunc.functionName),
          functionStatus,
          attempts: attempt,
          workPlanCompleted: workPlanCompleted || !workPlan
        };
      }

    } catch (error) {
      console.error(`Run verified chat attempt ${attempt} failed:`, error);
      if (attempt === maxAttempts) {
        throw error;
      }
    }
  }

  // If we get here, we've exhausted all attempts
  const functionStatus = requiredFunctions.map((reqFunc) => {
    const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
    return {
      functionName: reqFunc.functionName,
      requiredCount: reqFunc.minCount,
      actualCount: actualCount,
      met: actualCount >= reqFunc.minCount
    };
  });

  return {
    success: false,
    content: allContent,
    toolCalls: allToolCalls,
    keywordMatches: keywords.filter(k => !remainingKeywords.includes(k)),
    keywordMisses: remainingKeywords,
    functionCallMatches: requiredFunctions.filter(reqFunc => {
      const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
      return actualCount >= reqFunc.minCount;
    }).map(reqFunc => reqFunc.functionName),
    functionCallMisses: requiredFunctions.filter(reqFunc => {
      const actualCount = allActualFunctionCallsForReporting.filter(call => call === reqFunc.functionName).length;
      return actualCount < reqFunc.minCount;
    }).map(reqFunc => reqFunc.functionName),
    functionStatus,
    attempts: attempt,
    workPlanCompleted: false
  };
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
      schedule.emailCampaignTaskId,
      'scheduled' // sessionType
    );
    const sessionId = testSession.sessionId;

    // Convert schedule format to runVerifiedChat format
    const expectedKeywords = schedule.keywords || [];
    const expectedFunctionCalls = schedule.requiredFunctionCalls || [];
    const functionCallMinCalls = schedule.functionCallMinCalls || {};
    
    const requiredFunctions = expectedFunctionCalls.map((funcName: string) => ({
      functionName: funcName,
      minCount: functionCallMinCalls[funcName] || 1
    }));

    // Run verified chat
    const result = await runVerifiedChat({
      sessionId,
      userId,
      startingMessage: schedule.startingMessage,
      keywords: expectedKeywords,
      requiredFunctions,
      maxAttempts: 20,
      attachments: []
    });

    // Convert result to scheduled chat format
    const actualFunctionCalls = result.toolCalls.map((call: any) => call.name).filter(Boolean);
    
    // Calculate final function call details
    const finalFunctionCallDetails: { [functionName: string]: { actual: number; required: number } } = {};
    const actualFunctionCallCounts: { [functionName: string]: number } = {};
    actualFunctionCalls.forEach((call: string) => {
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

    const finalResult = {
      scheduleId: schedule.scheduleId,
      runId: require('uuid').v4(),
      status: (result.success ? 'success' : 'failure') as 'success' | 'failure',
      passed: result.success,
      actualResponse: result.content,
      actualFunctionCalls: actualFunctionCalls,
      keywordMatches: result.keywordMatches,
      keywordMisses: result.keywordMisses,
      functionCallMatches: result.functionCallMatches,
      functionCallMisses: result.functionCallMisses,
      functionCallDetails: finalFunctionCallDetails,
      executionTime: Date.now() - now.getTime(),
      sessionId: sessionId,
      attempt: result.attempts,
      createdAt: new Date().toISOString()
    };

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

// Helper function to set up SSE connection
function setupSSEConnectionForSession(sessionId: string, res: Response, req: Request) {
  try {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection message
    res.write(': connected\n\n');

    // Send latest progress if available
    const latestProgress = getLatestProgress(sessionId);
    if (latestProgress) {
      res.write(`data: ${JSON.stringify(latestProgress)}\n\n`);
    }

    // Register callback for progress updates
    const cleanup = registerProgressCallback(sessionId, (progress) => {
      try {
        console.log(`[SSE] Writing progress for session ${sessionId}:`, progress);
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        // Flush the response to ensure it's sent immediately
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch (error) {
        console.error('Error writing SSE data:', error);
        cleanup();
      }
    });
    
    console.log(`[SSE] Progress callback registered for session ${sessionId}`);

    // Handle client disconnect
    req.on('close', () => {
      cleanup();
      res.end();
    });

    // Keep connection alive with periodic ping
    const pingInterval = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (error) {
        clearInterval(pingInterval);
        cleanup();
        res.end();
      }
    }, 30000); // Every 30 seconds

    // Clean up on error
    req.on('error', (error) => {
      console.error(`[SSE] Request error for session ${sessionId}:`, error);
      clearInterval(pingInterval);
      cleanup();
      res.end();
    });
  } catch (error) {
    console.error(`[SSE] Error setting up connection for session ${sessionId}:`, error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish progress stream' });
    }
  }
}

// Common function to generate AI response for a session
// Always uses worker process to prevent blocking the main event loop
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

  // Generate AI response using worker process to prevent blocking the main event loop
  // This allows health checks to continue working during long-running operations
  const response = await generateMarketingResponseWorkerService.runInWorker(
    {
      messageContent,
      sessionHistory: updatedSession.messages,
      userId,
      sessionId,
      mockMode: false
    },
    (progress) => {
      // Emit progress updates via SSE
      emitProgress(sessionId, progress);
    }
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
      const { portalType = 'agent', pageIdentifier = 'agent-mode', sessionType } = req.body;

      // Determine sessionType: if explicitly provided, use it; otherwise default to 'regular'
      // For ad image generation from Images page, sessionType should be 'image-generation'
      const finalSessionType = sessionType || 'regular';

      const session = await chatbotDb.createChatSession(
        user.userId,
        undefined, // pageContent
        portalType,
        pageIdentifier,
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined, // executionId
        undefined, // emailCampaignTaskId
        finalSessionType as "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "book-generation"
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

      // Clear old progress store (but keep active connections)
      // Don't call cleanupProgress here as it removes active SSE connections
      progressStore.delete(sessionId);

      // Generate AI response using common function
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        user.userId,
        attachments
      );

      // Clear progress store after completion (keep connections open for future messages)
      progressStore.delete(sessionId);

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

      // Clear old progress store (but keep active connections)
      progressStore.delete(session.sessionId);

      // Use the same generateSessionResponse logic as the regular generateResponse
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId,
        attachments
      );

      // Clear progress store after completion (keep connections open for future messages)
      progressStore.delete(session.sessionId);

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

            // Get max concurrent runs from environment (default 5)
            const maxConcurrentRuns = process.env.MAX_CONCURRENT_RUNS ? parseInt(process.env.MAX_CONCURRENT_RUNS) : 5;
            
            // Track concurrent runs
            let currentConcurrentRuns = 0;
            const results = [];

        for (const schedule of scheduledChats) {
          try {
            const now = new Date();
            
            // Check if we've reached the concurrent run limit
            if (currentConcurrentRuns >= maxConcurrentRuns) {
              // Delay the run for half an hour
              const delayedRunTime = new Date(now);
              delayedRunTime.setMinutes(delayedRunTime.getMinutes() + 30);
              
              // Update the schedule with delayed run time
              await scheduleDb.updateScheduleAfterRun(
                schedule.scheduleId,
                schedule.lastRunTime || now.toISOString(),
                delayedRunTime.toISOString()
              );

              console.log(`Delayed scheduled chat ${schedule.scheduleName} for 30 minutes due to concurrent run limit (${maxConcurrentRuns})`);
              
              results.push({
                scheduleId: schedule.scheduleId,
                scheduleName: schedule.scheduleName,
                status: 'delayed',
                nextRunTime: delayedRunTime.toISOString(),
                reason: `Delayed due to concurrent run limit (${maxConcurrentRuns})`
              });
              
              continue;
            }
            
            // Update the schedule with next run time FIRST (synchronously)
            // This prevents agent-engine from repeatedly calling the same schedule
            const nextRunTime = calculateNextRunTime(schedule.frequency, now);
            
            await scheduleDb.updateScheduleAfterRun(
              schedule.scheduleId,
              now.toISOString(),
              nextRunTime.toISOString()
            );
            
            // Increment concurrent run counter
            currentConcurrentRuns++;
            
             // Start the scheduled chat run asynchronously (don't await)
             runScheduledChat(schedule, schedule.userId, false).then(async (result) => {
               // Decrement concurrent run counter when done
               currentConcurrentRuns--;
               
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
               // Decrement concurrent run counter on error
               currentConcurrentRuns--;
               
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

      // Check if user is authenticated (optional - route is public)
      // Use the common function to extract user from token
      const result = await getUserFromToken(req);
      const userId = result.user ? result.user.userId : `anon_${uuidv4()}`;

      // Create session with userId (authenticated or anonymous)
      const session = await chatbotDb.createChatSession(
        userId,
        undefined, // pageContent
        'agent', // portalType
        `plan-${planTitle}`, // pageIdentifier
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined, // executionId
        undefined, // emailCampaignTaskId
        'predefined-work-plan' // sessionType
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

      // Create work plan in session (include welcome message and autocomplete if defined)
      const workPlanWithWelcome = {
        ...workPlan,
        welcomeMessage: predefinedPlan.welcomeMessage?.trim() || undefined,
        autocomplete: predefinedPlan.autocomplete || false
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
        conversableToken,
        userId: session.userId
      });
    } catch (error) {
      console.error('AgentMode: Create session with plan error:', error);
      res.status(500).json({ error: 'Failed to create session with plan' });
    }
  },

  // SSE endpoint for progress updates (authenticated)
  async getProgress(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as User;

      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      // Verify session exists and user has access
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Set up SSE connection - inline the logic since we can't use 'this' in object literal
      setupSSEConnectionForSession(sessionId, res, req);
    } catch (error) {
      console.error('AgentMode: SSE progress error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish progress stream' });
      }
    }
  },

  // SSE endpoint for progress updates (public, with conversable token)
  async getProgressPublic(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;

      if (!shareId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      // Verify session exists and conversable token is valid
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const interactiveShare = session.interactiveShareMetadata;
      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Set up SSE connection - inline the logic since we can't use 'this' in object literal
      setupSSEConnectionForSession(shareId, res, req);
    } catch (error) {
      console.error('AgentMode: SSE progress error (public):', error);
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish progress stream' });
      }
    }
  },


  // Transfer session from anonymous user to authenticated user
  async transferSession(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user;

      // Get the session to verify it exists and check if it's anonymous
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if the session belongs to an anonymous user
      if (!session.userId.startsWith('anon_')) {
        return res.status(400).json({ error: 'Session is not anonymous' });
      }

      // Update the session userId to the authenticated user's ID
      await chatbotDb.updateSessionUserId(sessionId, user.userId);

      res.json({ 
        message: 'Session transferred successfully',
        sessionId,
        userId: user.userId
      });
    } catch (error) {
      console.error('AgentMode: Transfer session error:', error);
      res.status(500).json({ error: 'Failed to transfer session' });
    }
  },

  // Verified generate - ensures required functions are called minimum number of times
  async verifiedGenerate(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId, startingMessage, requiredFunctions, keywords, attachments, maxAttempts: maxAttemptsParam } = req.body;

      // Validate required fields
      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      if (!startingMessage || !startingMessage.trim()) {
        return res.status(400).json({ error: 'Starting message is required' });
      }

      if (!requiredFunctions || !Array.isArray(requiredFunctions) || requiredFunctions.length === 0) {
        return res.status(400).json({ error: 'Required functions array is required and must not be empty' });
      }

      // Validate requiredFunctions format: [{ functionName: string, minCount: number }]
      for (const reqFunc of requiredFunctions) {
        if (!reqFunc.functionName || typeof reqFunc.functionName !== 'string') {
          return res.status(400).json({ error: 'Each required function must have a functionName (string)' });
        }
        if (typeof reqFunc.minCount !== 'number' || reqFunc.minCount < 1) {
          return res.status(400).json({ error: 'Each required function must have a minCount (number >= 1)' });
        }
      }

      // Get session and verify ownership
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId) {
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      // Track if client disconnected (user navigated away)
      let clientDisconnected = false;
      req.on('close', () => {
        clientDisconnected = true;
        console.log('AgentMode: Client disconnected, but continuing verified generation...');
      });

      // Run verified chat
      const result = await runVerifiedChat({
        sessionId,
        userId: user.userId,
        startingMessage: startingMessage.trim(),
        keywords: keywords || [],
        requiredFunctions,
        maxAttempts: maxAttemptsParam || 5,
        attachments: attachments || []
      });

      // If client disconnected, don't try to send response
      // The results are already saved to the session
      if (clientDisconnected) {
        console.log('AgentMode: Client disconnected before response could be sent, but verified generation completed');
        return;
      }

      res.status(200).json({
        success: result.success,
        message: result.success
          ? `All required functions were called successfully.`
          : `Some required functions were not called enough times after ${result.attempts} attempt${result.attempts !== 1 ? 's' : ''}.`,
        content: result.content,
        toolCalls: result.toolCalls,
        keywordMatches: result.keywordMatches,
        keywordMisses: result.keywordMisses,
        functionCallMatches: result.functionCallMatches,
        functionCallMisses: result.functionCallMisses,
        functionStatus: result.functionStatus,
        attempts: result.attempts,
        workPlanCompleted: result.workPlanCompleted,
        sessionId: sessionId
      });
    } catch (error: any) {
      console.error('AgentMode: Verified generate error:', error);
      res.status(500).json({ 
        error: 'Failed to perform verified generation',
        message: error.message || 'Unknown error'
      });
    }
  },
};