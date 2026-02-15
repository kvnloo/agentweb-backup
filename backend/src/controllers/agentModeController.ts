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
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { isContextLimitError, isSessionLimitError } from '../utils/agentModeErrors';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
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

interface ScheduledChatVariable {
  name: string;
  description?: string;
}

const SCHEDULED_CHAT_VARIABLE_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function extractScheduledChatVariableNames(startingMessage: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  SCHEDULED_CHAT_VARIABLE_REGEX.lastIndex = 0;
  while ((match = SCHEDULED_CHAT_VARIABLE_REGEX.exec(startingMessage)) !== null) {
    seen.add(match[1]);
  }
  return Array.from(seen);
}

function validateAndBuildScheduledChatVariables(
  startingMessage: string,
  inputVariables: unknown,
  existingVariables: ScheduledChatVariable[] = []
): { variables: ScheduledChatVariable[]; error?: string } {
  const variableNames = extractScheduledChatVariableNames(startingMessage);
  if (variableNames.length === 0) {
    return { variables: [] };
  }

  const normalizedInputVariables: ScheduledChatVariable[] = Array.isArray(inputVariables)
    ? inputVariables
        .filter((v: any) => v && typeof v.name === 'string')
        .map((v: any) => ({
          name: v.name.trim(),
          description: typeof v.description === 'string' ? v.description.trim() : '',
        }))
    : [];

  const inputNames = new Set(normalizedInputVariables.map(v => v.name));
  const unknownVariables = Array.from(inputNames).filter(name => !variableNames.includes(name));
  if (unknownVariables.length > 0) {
    return {
      variables: [],
      error: `Variables not found in startingMessage: ${unknownVariables.join(', ')}`
    };
  }

  const existingDescriptionMap = new Map(
    (existingVariables || []).map(variable => [variable.name, variable.description || ''])
  );
  const inputDescriptionMap = new Map(
    normalizedInputVariables.map(variable => [variable.name, variable.description || ''])
  );

  const variables = variableNames.map((name) => ({
    name,
    description: inputDescriptionMap.has(name)
      ? inputDescriptionMap.get(name) || ''
      : existingDescriptionMap.get(name) || '',
  }));

  return { variables };
}

function getMissingScheduledChatVariableNames(
  variables: ScheduledChatVariable[],
  variableValues: Record<string, string> = {}
): string[] {
  return variables
    .filter(variable => !variableValues[variable.name] || !String(variableValues[variable.name]).trim())
    .map(variable => variable.name);
}

function applyScheduledChatVariableValues(
  startingMessage: string,
  variableValues: Record<string, string> = {}
): string {
  return startingMessage.replace(SCHEDULED_CHAT_VARIABLE_REGEX, (_, variableName: string) => {
    const value = variableValues[variableName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `{{${variableName}}}`;
    }
    return value;
  });
}

function hashScheduledChatVariableAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Helper function to reconstruct actualResponse from session messages (only used when sending emails)
async function getActualResponseFromSession(sessionId: string): Promise<string> {
  try {
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.messages || !Array.isArray(session.messages) || session.messages.length === 0) {
      return '';
    }
    
    // Iterate backwards to find the last assistant message with content
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0) {
        return msg.content.trim();
      }
    }
    
    return '';
  } catch (error) {
    console.error(`[getActualResponseFromSession] Error getting actualResponse from session ${sessionId}:`, error);
    return '';
  }
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

    // Remove assistant messages that have tool_calls (intermediate messages during tool execution)
    // BUT keep assistant messages that have metadata.toolCalls (final messages with tool execution results)
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 && !message.metadata?.toolCalls) {
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
    const todaysResultsRaw = runResults.filter((result: any) => {
      const resultDate = new Date(result.createdAt);
      return resultDate >= startOfDay && resultDate < endOfDay;
    });
    
    // Reconstruct actualResponse for results that don't have it (only needed for email)
    const todaysResults = await Promise.all(
      todaysResultsRaw.map(async (result: any) => {
        if (!result.actualResponse && result.sessionId) {
          const actualResponse = await getActualResponseFromSession(result.sessionId);
          return { ...result, actualResponse };
        }
        return result;
      })
    );

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
export async function runVerifiedChat(
  params: {
    sessionId: string;
    userId: string;
    startingMessage: string;
    keywords: string[];
    requiredFunctions: Array<{ functionName: string; minCount: number }>;
    maxAttempts?: number;
    attachments?: any[];
    llmModel?: string;
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
  
  // Ensure attachments is always an array
  const attachmentsArray = Array.isArray(attachments) ? attachments : [];
  console.log('AgentMode runVerifiedChat: Received attachments:', attachmentsArray.length, attachmentsArray);

  let attempt = 0;
  let allContent = '';
  const allToolCalls: any[] = [];
  const sessionForModel = await chatbotDb.getChatSession(sessionId);
  let sessionModel = sessionForModel?.llmModel;
  const normalizedStartingMessage = startingMessage.toLowerCase();
  const shouldUseReportsModel = requiredFunctions.some((reqFunc) => (
    reqFunc.functionName === 'update_html_file' || reqFunc.functionName === 'read_file_content'
  ));
  if (shouldUseReportsModel) {
    const reportsModel = await agentModeService.getReportsModel();
    if (sessionModel !== reportsModel) {
      await chatbotDb.updateSessionLlmModel(sessionId, reportsModel);
      sessionModel = reportsModel;
    }
  }
  const defaultModel = params.llmModel || sessionModel || await agentModeService.getDefaultModel();

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
      // Only pass attachments on the first attempt to avoid duplicating them
      const attachmentsForThisAttempt = attempt === 1 ? attachmentsArray : [];
      console.log(`AgentMode runVerifiedChat: Attempt ${attempt}, passing ${attachmentsForThisAttempt.length} attachments to generateSessionResponse`);
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        userId,
        defaultModel,
        attachmentsForThisAttempt
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
      if (isSessionLimitError(error)) {
        throw error;
      }
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
    const scheduleVariables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
    const scheduleVariableValues = (schedule.variableValues && typeof schedule.variableValues === 'object')
      ? schedule.variableValues as Record<string, string>
      : {};
    const missingVariableNames = getMissingScheduledChatVariableNames(scheduleVariables, scheduleVariableValues);
    if (scheduleVariables.length > 0 && missingVariableNames.length > 0) {
      return {
        scheduleId: schedule.scheduleId,
        runId: require('uuid').v4(),
        status: 'failure' as const,
        passed: false,
        actualResponse: `Scheduled chat cannot run. Missing variable values: ${missingVariableNames.map(name => `{{${name}}}`).join(', ')}`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString()
      };
    }

    // Check if required function calls are allowed for the user's subscription
    const expectedFunctionCalls = schedule.requiredFunctionCalls || [];
    if (expectedFunctionCalls.length > 0) {
      const { getAllowedFunctionCalls } = await import('../services/subscriptionService');
      const allowedFunctionCalls = await getAllowedFunctionCalls(userId);
      
      // Check if all required function calls are allowed
      // getAllowedFunctionCalls now always returns an array (never null or "*")
      // If the array is empty, it means no functions are allowed (shouldn't happen, but handle it)
      if (allowedFunctionCalls.length === 0) {
        // This shouldn't happen, but if it does, block all function calls
        const disallowedFunctions = expectedFunctionCalls;
        
        // Get user info for email
        const { userDb } = await import('../services/db');
        const user = await userDb.getUserById(userId);
        const emailNotifications = schedule.emailNotifications || [];
        
        // Send error email instead of running
        const { emailService } = await import('../services/emailService');
        await emailService.sendScheduledChatErrorEmail(
          emailNotifications.length > 0 ? emailNotifications : (user?.email ? [user.email] : []),
          schedule.scheduleName,
          disallowedFunctions,
          schedule.scheduleId
        );
        
        // Create failure result
        const errorResult = {
          scheduleId: schedule.scheduleId,
          runId: require('uuid').v4(),
          status: 'failure' as const,
          passed: false,
          actualResponse: `Scheduled chat cannot run: No function calls are allowed by your subscription.`,
          actualFunctionCalls: [],
          keywordMatches: [],
          keywordMisses: [],
          functionCallMatches: [],
          functionCallMisses: disallowedFunctions,
          executionTime: 0,
          sessionId: '',
          attempt: 0,
          createdAt: new Date().toISOString()
        };
        
        // Save the error result to database
        try {
          await scheduleDb.addRunResult(schedule.scheduleId, errorResult);
        } catch (error) {
          console.error('Error saving error run result:', error);
        }
        
        return errorResult;
      }
      
      const disallowedFunctions = expectedFunctionCalls.filter((funcName: string) => 
        !allowedFunctionCalls.includes(funcName)
      );
        
      if (disallowedFunctions.length > 0) {
        // Get user info for email
        const { userDb } = await import('../services/db');
        const user = await userDb.getUserById(userId);
        const emailNotifications = schedule.emailNotifications || [];
        
        // Send error email instead of running
        const { emailService } = await import('../services/emailService');
        await emailService.sendScheduledChatErrorEmail(
          emailNotifications.length > 0 ? emailNotifications : (user?.email ? [user.email] : []),
          schedule.scheduleName,
          disallowedFunctions,
          schedule.scheduleId
        );
        
        // Create failure result
        const errorResult = {
          scheduleId: schedule.scheduleId,
          runId: require('uuid').v4(),
          status: 'failure' as const,
          passed: false,
          actualResponse: `Scheduled chat cannot run: Required function calls are not allowed by your subscription: ${disallowedFunctions.join(', ')}`,
          actualFunctionCalls: [],
          keywordMatches: [],
          keywordMisses: [],
          functionCallMatches: [],
          functionCallMisses: disallowedFunctions,
          executionTime: 0,
          sessionId: '',
          attempt: 0,
          createdAt: new Date().toISOString()
        };
        
        // Save the error result to database
        try {
          await scheduleDb.addRunResult(schedule.scheduleId, errorResult);
        } catch (error) {
          console.error('Error saving error run result:', error);
        }
        
        return errorResult;
      }
    }

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

    // Update the session with the selected model from the schedule
    const defaultModel = await agentModeService.getDefaultModel();
    const modelToUse = schedule.llmModel || defaultModel;
    await chatbotDb.updateSessionLlmModel(sessionId, modelToUse);

    // Convert schedule format to runVerifiedChat format
    const expectedKeywords = schedule.keywords || [];
    const functionCallMinCalls = schedule.functionCallMinCalls || {};

    const requiredFunctions = expectedFunctionCalls.map((funcName: string) => ({
      functionName: funcName,
      minCount: functionCallMinCalls[funcName] || 1
    }));

    const resolvedStartingMessage = applyScheduledChatVariableValues(
      schedule.startingMessage,
      schedule.variableValues || {}
    );

    // Run verified chat
    const result = await runVerifiedChat({
      sessionId,
      userId,
      startingMessage: resolvedStartingMessage,
      keywords: expectedKeywords,
      requiredFunctions,
      maxAttempts: 20,
      attachments: [],
      llmModel: schedule.llmModel || defaultModel
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

    // Save the result to database (without actualResponse to save space)
    const resultToStore = { ...finalResult };
    delete (resultToStore as any).actualResponse;
    try {
      await scheduleDb.addRunResult(schedule.scheduleId, resultToStore);
    } catch (error) {
      console.error('Error saving run result:', error);
      // Continue even if saving fails - we still want to return the result
    }

    // Also sync Research Reports execution for email campaigns
    try {
      if (schedule.emailCampaignTaskId && finalResult.sessionId) {
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
      // console.error(`[SSE] Request error for session ${sessionId}:`, error);
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

function hasActiveProgress(sessionId: string): boolean {
  const latestProgress = getLatestProgress(sessionId);
  if (!latestProgress) return false;
  return latestProgress.status !== 'complete';
}

// Common function to generate AI response for a session
// Always uses worker process to prevent blocking the main event loop
export async function generateSessionResponse(
  sessionId: string,
  userMessage: string,
  userId: string,
  llmModel: string,
  attachments?: any[]
): Promise<{
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
  workPlan?: any;
  skills?: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[];
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
  console.log('AgentMode generateSessionResponse: Saving user message with attachments:', {
    hasAttachments: !!(userMessageObj.metadata?.attachments && userMessageObj.metadata.attachments.length > 0),
    attachmentCount: userMessageObj.metadata?.attachments?.length || 0,
    attachments: userMessageObj.metadata?.attachments?.map((a: any) => ({ url: a.url, filename: a.filename }))
  });
  await chatbotDb.addMessageToSession(sessionId, userMessageObj);
  console.log('AgentMode generateSessionResponse: User message saved successfully');

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
      llmModel,
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

  // Build skills list with installed status (includes virtual other_skills), filtered by subscription
  let skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[] = [];
  try {
    skills = await agentModeService.getSkillsForDisplay(finalSession?.associatedSkills || [], userId);
  } catch (error) {
    console.error('AgentMode generateSessionResponse: Failed to fetch skills:', error);
  }

  return {
    ...response,
    workPlan: finalSession?.workPlan,
    skills
  };
}

// Helper function to calculate next run time based on frequency
const calculateNextRunTime = (frequency: string, fromDate: Date): Date => {
  const now = new Date();
  let nextRun = new Date(fromDate);

  switch (frequency) {
    case 'hourly':
      nextRun.setUTCHours(nextRun.getUTCHours() + 1);
      nextRun.setUTCMinutes(0, 0, 0); // Top of the hour

      // If still in the past, keep adding hours until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCHours(nextRun.getUTCHours() + 1);
      }
      break;
    case 'daily':
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      // Preserve the time from fromDate

      // If still in the past (schedule ran late), keep adding days until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      }
      break;
    case 'weekly':
      // Add exactly 7 days (same day of week, one week later)
      nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      // Preserve the time from fromDate

      // If still in the past, keep adding weeks until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      }
      break;
    case 'monthly':
      // Calculate same weekday of next month (e.g., 2nd Tuesday -> 2nd Tuesday of next month)
      const currentDayOfWeek = nextRun.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
      const currentWeekOfMonth = Math.floor((nextRun.getUTCDate() - 1) / 7); // 0-based week number

      // Move to next month, 1st day
      nextRun.setUTCMonth(nextRun.getUTCMonth() + 1);
      nextRun.setUTCDate(1);

      // Find the first occurrence of the target day of week in the new month
      const firstDayOfMonth = nextRun.getUTCDay();
      let daysToAdd = (currentDayOfWeek - firstDayOfMonth + 7) % 7;

      // Add weeks to get to the same week number
      daysToAdd += currentWeekOfMonth * 7;

      nextRun.setUTCDate(1 + daysToAdd);
      // Preserve the time from fromDate

      // If still in the past, keep adding months until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCMonth(nextRun.getUTCMonth() + 1);
        nextRun.setUTCDate(1);

        const firstDayOfMonth = nextRun.getUTCDay();
        let daysToAdd = (currentDayOfWeek - firstDayOfMonth + 7) % 7;
        daysToAdd += currentWeekOfMonth * 7;
        nextRun.setUTCDate(1 + daysToAdd);
      }
      break;
    default:
      // Default to daily
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      nextRun.setUTCHours(9, 0, 0, 0); // Fallback to 9 AM UTC for unknown frequencies

      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      }
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
      const authReq = req as AuthenticatedRequest;
      const user = authReq.user as User;
      const { portalType = 'agent', pageIdentifier = 'agent-mode', sessionType } = req.body;

      // Determine sessionType: if explicitly provided, use it; otherwise default to 'regular'
      // For ad image generation from Images page, sessionType should be 'image-generation'
      // For ad video generation from Videos page, sessionType should be 'video-generation'
      const finalSessionType = sessionType || 'regular';

      // Pass delegate info if this is a delegated access session
      const delegateInfo = authReq.delegateInfo;

      const session = await chatbotDb.createChatSession(
        user.userId,
        undefined, // pageContent
        portalType,
        pageIdentifier,
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined, // executionId
        undefined, // emailCampaignTaskId
        finalSessionType as "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation" | "report_generation",
        delegateInfo // Pass delegate info for admin delegation tracking
      );

      // Set default model for new sessions
      // Use reports model for report_generation sessions, otherwise use default model
      const modelToUse = finalSessionType === 'report_generation'
        ? await agentModeService.getReportsModel()
        : await agentModeService.getDefaultModel();
      const sessionWithModel = await chatbotDb.updateSessionLlmModel(session.sessionId, modelToUse);

      res.status(201).json(sessionWithModel);
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
      const progressActive = hasActiveProgress(session.sessionId);

      // For non-admin users, check if they own the session
      if (!user?.isAdmin && session.userId !== user?.userId) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      await syncEmailCampaignExecution(session.userId, session.sessionId, session.emailCampaignTaskId || '');

      // Build skills list with installed status (includes virtual other_skills), filtered by subscription
      let skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[] = [];
      try {
        skills = await agentModeService.getSkillsForDisplay(session.associatedSkills || [], session.userId);
      } catch (error) {
        console.error('AgentMode getSession: Failed to fetch skills:', error);
      }

      // Filter out tool messages and assistant messages with tool calls for user display
      const filteredSession = {
        ...session,
        messages: filterMessagesForClient(session.messages),
        hasActiveProgress: progressActive,
        skills
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
      const user = req.user as User;
      const tools = agentModeService.getAvailableTools();
      
      // For admin users, return all function calls without filtering
      // For regular users, filter tools based on subscription
      let toolsToReturn = tools;
      if (!user.isAdmin) {
        const { getAllowedFunctionCalls, filterFunctionCalls } = await import('../services/subscriptionService');
        const allowedFunctionCalls = await getAllowedFunctionCalls(user.userId);
        // getAllowedFunctionCalls now always returns an array (never null)
        toolsToReturn = filterFunctionCalls(tools, allowedFunctionCalls);
      }

      // Extract function names and descriptions
      let functionCalls = toolsToReturn
        .filter((tool: any) => tool?.type === 'function' && tool?.function?.name)
        .map((tool: any) => ({
          name: tool.function.name,
          description: tool.function.description || ''
        }));

      // When fetching for skill configuration, exclude foundation tools
      // (they're always available and shouldn't be assigned to skills)
      if (req.query?.forSkillConfig === 'true') {
        const foundationTools = agentModeService.getFoundationToolNames();
        functionCalls = functionCalls.filter((fc: any) => !foundationTools.has(fc.name));
      }

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
      const { sessionId, userMessage, llmModel, attachments } = req.body;

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

      // Use llmModel from request, session, or default
      const modelToUse = llmModel || session.llmModel || agentModeService.default_model;

      // Generate AI response using common function
      const response = await generateSessionResponse(
        sessionId,
        userMessage,
        user.userId,
        modelToUse,
        attachments
      );

      // Clear progress store after completion (keep connections open for future messages)
      progressStore.delete(sessionId);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills
      });
    } catch (error) {
      console.error('AgentMode: Generate response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const sessionId = req.body?.sessionId;
      if (sessionId) {
        emitProgress(sessionId, { iteration: 0, status: 'complete' });
        progressStore.delete(sessionId);
      }

      // Handle specific error types
      if (error instanceof Error) {
        if (error.message.includes('SESSION_MESSAGE_LIMIT_EXCEEDED')) {
          // Extract the actual error message from the error
          const errorMessage = error.message.includes(':') 
            ? error.message.split(':').slice(1).join(':').trim()
            : `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`;
          res.status(413).json({
            error: 'Session message limit exceeded',
            message: errorMessage,
            code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
          res.status(413).json({
            error: 'Session size limit exceeded',
            message: 'Please start a new session to continue the conversation.',
            code: 'SESSION_SIZE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (isContextLimitError(error)) {
          const user = req.user as User;
          const sessionId = req.body?.sessionId;
          const userMessage = req.body?.userMessage;
          const llmModel = req.body?.llmModel;
          const attachments = req.body?.attachments;
          const session = sessionId ? await chatbotDb.getChatSession(sessionId).catch(() => null) : null;

          sendAgentModeOncallAlert({
            subject: 'Agent Mode: Context limit exceeded',
            message: `The request exceeded the model context window.\n\nError: ${error.message || 'Unknown error'}`,
            sessionId,
            context: {
              'Error Message': error.message || 'Unknown error',
              'Error Stack': error.stack || 'No stack trace available',
              'Error Name': error.name || 'Unknown',
              'User ID': user?.userId || 'Not available',
              'User Email': user?.email || 'Not available',
              'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
              'LLM Model': llmModel || 'Not specified',
              'Attachments Count': attachments?.length || 0,
              'Session Exists': session ? 'Yes' : 'No',
              'Session User ID': session?.userId || 'N/A',
              'Session Title': session?.title || 'N/A',
              'Session Message Count': session?.messages?.length || 0,
              'Timestamp': new Date().toISOString(),
              'Request Method': req.method,
              'Request Path': req.path,
              'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
            }
          }).catch(err => console.error('Failed to send oncall alert:', err));

          res.status(413).json({
            error: 'Context limit exceeded',
            message: 'This conversation is too long for the current model context window. Please start a new session or shorten the request.',
            code: 'CONTEXT_LIMIT_EXCEEDED',
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

        if (error.message.includes('content policies') || error.message.includes('violate content policies') || error.message.includes('content management policy') || error.message.includes('content_filter')) {
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

        // Unknown error - send oncall alert
        const user = req.user as User;
        const sessionId = req.body?.sessionId;
        const userMessage = req.body?.userMessage;
        const llmModel = req.body?.llmModel;
        const attachments = req.body?.attachments;
        const session = sessionId ? await chatbotDb.getChatSession(sessionId).catch(() => null) : null;
        
        // Send oncall alert asynchronously (don't await to avoid blocking response)
        sendAgentModeOncallAlert({
          subject: 'Agent Mode: Unknown Error in Generate Response',
          message: `An unknown error occurred while generating a response in Agent Mode.\n\nError: ${error.message || 'Unknown error'}`,
          sessionId,
          context: {
            'Error Message': error.message || 'Unknown error',
            'Error Stack': error.stack || 'No stack trace available',
            'Error Name': error.name || 'Unknown',
            'User ID': user?.userId || 'Not available',
            'User Email': user?.email || 'Not available',
            'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
            'LLM Model': llmModel || 'Not specified',
            'Attachments Count': attachments?.length || 0,
            'Session Exists': session ? 'Yes' : 'No',
            'Session User ID': session?.userId || 'N/A',
            'Session Title': session?.title || 'N/A',
            'Session Message Count': session?.messages?.length || 0,
            'Timestamp': new Date().toISOString(),
            'Request Method': req.method,
            'Request Path': req.path,
            'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
          }
        }).catch(err => console.error('Failed to send oncall alert:', err));
      }

      res.status(500).json({ error: 'Failed to generate response' });
    }
  },

  async getSupportedModels(req: Request, res: Response) {
    try {
      const models = await agentModeService.getSupportedModels();
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get supported models error:', error);
      res.status(500).json({ error: 'Failed to get supported models' });
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

      // Use session's llmModel if available, otherwise use default
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Get user's supportNote if available
      let supportNote: string | undefined;
      try {
        const user = await userDb.getUserById(session.userId);
        supportNote = user?.supportNote;
      } catch (error) {
        console.error('Failed to fetch user supportNote:', error);
        // Continue without supportNote if fetch fails
      }

      // Build skills list with installed status (includes virtual other_skills), filtered by subscription
      let sharedSkills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[] = [];
      try {
        sharedSkills = await agentModeService.getSkillsForDisplay(session.associatedSkills || [], session.userId);
      } catch (error) {
        console.error('AgentMode getSharedConversation: Failed to fetch skills:', error);
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
          llmModel: modelToUse,
          isConversable: !!conversable,
          hasActiveProgress: hasActiveProgress(session.sessionId),
          supportNote: supportNote,
          skills: sharedSkills
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
      const { userMessage, llmModel, attachments = [] } = req.body;

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

      // Always use session's llmModel for ishare endpoints (ignore request body's llmModel)
      // This ensures anonymous users get the correct model from the session
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Use the same generateSessionResponse logic as the regular generateResponse
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId,
        modelToUse,
        attachments
      );

      // Clear progress store after completion (keep connections open for future messages)
      progressStore.delete(session.sessionId);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills
      });
    } catch (error) {
      console.error('AgentMode: Generate shared response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const shareId = req.params?.shareId;
      if (shareId) {
        emitProgress(shareId, { iteration: 0, status: 'complete' });
        progressStore.delete(shareId);
      }

      // Handle specific error types (same as generateResponse)
      if (error instanceof Error) {
        if (error.message.includes('SESSION_MESSAGE_LIMIT_EXCEEDED')) {
          // Extract the actual error message from the error
          const errorMessage = error.message.includes(':')
            ? error.message.split(':').slice(1).join(':').trim()
            : `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`;
          res.status(413).json({
            error: 'Session message limit exceeded',
            message: errorMessage,
            code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (error.message.includes('SESSION_SIZE_LIMIT_EXCEEDED')) {
          res.status(413).json({
            error: 'Session size limit exceeded',
            message: 'Please start a new session to continue the conversation.',
            code: 'SESSION_SIZE_LIMIT_EXCEEDED',
            suggestion: 'start_new_session'
          });
          return;
        }

        if (isContextLimitError(error)) {
          const shareId = req.params?.shareId;
          const conversable = req.query?.conversable;
          const userMessage = req.body?.userMessage;
          const llmModel = req.body?.llmModel;
          const attachments = req.body?.attachments || [];
          const session = shareId ? await chatbotDb.getChatSession(shareId).catch(() => null) : null;

          sendAgentModeOncallAlert({
            subject: 'Agent Mode: Context limit exceeded (shared response)',
            message: `The request exceeded the model context window.\n\nError: ${error.message || 'Unknown error'}`,
            sessionId: shareId,
            context: {
              'Error Message': error.message || 'Unknown error',
              'Error Stack': error.stack || 'No stack trace available',
              'Error Name': error.name || 'Unknown',
              'Session ID (Share ID)': shareId || 'Not provided',
              'Conversable Token': conversable ? 'Provided' : 'Not provided',
              'Session User ID': session?.userId || 'N/A',
              'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
              'LLM Model': llmModel || session?.llmModel || 'Not specified',
              'Attachments Count': attachments?.length || 0,
              'Session Exists': session ? 'Yes' : 'No',
              'Session Title': session?.title || 'N/A',
              'Session Message Count': session?.messages?.length || 0,
              'Is Conversable Mode': session?.interactiveShareMetadata?.isActive ? 'Yes' : 'No',
              'Timestamp': new Date().toISOString(),
              'Request Method': req.method,
              'Request Path': req.path,
              'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
            }
          }).catch(err => console.error('Failed to send oncall alert:', err));

          res.status(413).json({
            error: 'Context limit exceeded',
            message: 'This conversation is too long for the current model context window. Please start a new session or shorten the request.',
            code: 'CONTEXT_LIMIT_EXCEEDED',
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

        if (error.message.includes('content policies') || error.message.includes('violate content policies') || error.message.includes('content management policy') || error.message.includes('content_filter')) {
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

        // Unknown error - send oncall alert
        const shareId = req.params?.shareId;
        const conversable = req.query?.conversable;
        const userMessage = req.body?.userMessage;
        const llmModel = req.body?.llmModel;
        const attachments = req.body?.attachments || [];
        const session = shareId ? await chatbotDb.getChatSession(shareId).catch(() => null) : null;
        
        // Send oncall alert asynchronously (don't await to avoid blocking response)
        sendAgentModeOncallAlert({
          subject: 'Agent Mode: Unknown Error in Generate Shared Response',
          message: `An unknown error occurred while generating a shared response in Agent Mode.\n\nError: ${error.message || 'Unknown error'}`,
          sessionId: shareId,
          context: {
            'Error Message': error.message || 'Unknown error',
            'Error Stack': error.stack || 'No stack trace available',
            'Error Name': error.name || 'Unknown',
            'Session ID (Share ID)': shareId || 'Not provided',
            'Conversable Token': conversable ? 'Provided' : 'Not provided',
            'Session User ID': session?.userId || 'N/A',
            'User Message': userMessage ? (userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage) : 'Not provided',
            'LLM Model': llmModel || session?.llmModel || 'Not specified',
            'Attachments Count': attachments?.length || 0,
            'Session Exists': session ? 'Yes' : 'No',
            'Session Title': session?.title || 'N/A',
            'Session Message Count': session?.messages?.length || 0,
            'Is Conversable Mode': session?.interactiveShareMetadata?.isActive ? 'Yes' : 'No',
            'Timestamp': new Date().toISOString(),
            'Request Method': req.method,
            'Request Path': req.path,
            'Request IP': req.ip || req.socket.remoteAddress || 'Unknown'
          }
        }).catch(err => console.error('Failed to send oncall alert:', err));
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

  // Submit or update message feedback
  async submitMessageFeedback(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId, messageIndex } = req.params;
      const { type, comment } = req.body;
      const user = req.user as User;

      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate feedback type
      if (!type || (type !== 'like' && type !== 'dislike')) {
        return res.status(400).json({ error: 'Invalid feedback type. Must be "like" or "dislike"' });
      }

      // Validate comment length if provided
      if (comment && comment.length > 500) {
        return res.status(400).json({ error: 'Comment too long. Maximum 500 characters' });
      }

      // Check if session exists and verify ownership or admin access
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Only allow the session owner or admin to submit feedback
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Cannot rate other user\'s sessions' });
      }

      // Get all messages to verify the message exists and is an assistant message
      const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
      const messageIndexNum = parseInt(messageIndex, 10);

      if (isNaN(messageIndexNum) || messageIndexNum < 0 || messageIndexNum >= messages.length) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const message = messages[messageIndexNum];
      if (message.role !== 'assistant') {
        return res.status(400).json({ error: 'Can only rate assistant messages' });
      }

      // Create feedback object
      const feedback = {
        type: type as 'like' | 'dislike',
        comment: comment || undefined,
        timestamp: new Date().toISOString(),
        userId: user.userId,
      };

      // Update the message with feedback
      const updatedMessage = await chatbotDb.updateMessageFeedback(
        sessionId,
        messageIndexNum,
        feedback
      );

      res.json({
        success: true,
        message: updatedMessage,
      });
    } catch (error) {
      console.error('AgentMode: Submit message feedback error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  },

  // Submit message feedback for ishare sessions (public with conversable token)
  async submitIShareMessageFeedback(req: Request, res: Response) {
    try {
      const { shareId, messageIndex } = req.params;
      const { conversable } = req.query;
      const { type, comment } = req.body;

      if (!conversable) {
        return res.status(401).json({ error: 'Conversable token required' });
      }

      // Validate feedback type
      if (!type || (type !== 'like' && type !== 'dislike')) {
        return res.status(400).json({ error: 'Invalid feedback type. Must be "like" or "dislike"' });
      }

      // Validate comment length if provided
      if (comment && comment.length > 500) {
        return res.status(400).json({ error: 'Comment too long. Maximum 500 characters' });
      }

      // Get session and verify conversable token
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const interactiveShare = session.interactiveShareMetadata;
      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Get all messages to verify the message exists and is an assistant message
      const messages = await chatbotDb.getMessagesFromMessagesTable(shareId);
      const messageIndexNum = parseInt(messageIndex, 10);

      if (isNaN(messageIndexNum) || messageIndexNum < 0 || messageIndexNum >= messages.length) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const message = messages[messageIndexNum];
      if (message.role !== 'assistant') {
        return res.status(400).json({ error: 'Can only rate assistant messages' });
      }

      // Create feedback object (use 'anonymous' as userId for ishare)
      const feedback = {
        type: type as 'like' | 'dislike',
        comment: comment || undefined,
        timestamp: new Date().toISOString(),
        userId: 'anonymous-ishare',
      };

      // Update the message with feedback
      const updatedMessage = await chatbotDb.updateMessageFeedback(
        shareId,
        messageIndexNum,
        feedback
      );

      res.json({
        success: true,
        message: updatedMessage,
      });
    } catch (error) {
      console.error('AgentMode: Submit ishare message feedback error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
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

  // Upload image directly to Agent Mode session
  async uploadImageToSession(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Validate that it's an image file
      if (!file.mimetype.startsWith('image/')) {
        return res.status(400).json({ error: 'File must be an image' });
      }

      // Verify session exists and belongs to user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
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

      // Create a system message with toolCall metadata using upload_image
      // This structure matches what getExecutionsWithAssets expects
      const uploadedImageMessage = {
        role: 'system' as const,
        content: `Image uploaded: ${file.originalname}`,
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'agent' as const,
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              id: uuidv4(),
              name: 'upload_image',
              arguments: {},
              result: {
                success: true,
                imageUrl: uploadResult.url,
                filename: file.originalname,
                message: `✅ Image "${file.originalname}" uploaded successfully!`
              }
            }
          ]
        }
      };

      // Add message to session
      await chatbotDb.addMessageToSession(sessionId, uploadedImageMessage);

      res.json({
        success: true,
        message: 'Image uploaded successfully',
        url: uploadResult.url,
        filename: file.originalname,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload image to session error:', error);
      res.status(500).json({ error: 'Failed to upload image to session' });
    }
  },

  // Upload video directly to Agent Mode session
  async uploadVideoToSession(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Validate that it's a video file
      if (!file.mimetype.startsWith('video/')) {
        return res.status(400).json({ error: 'File must be a video' });
      }

      // Verify session exists and belongs to user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
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

      // Create a system message with toolCall metadata using upload_video
      // This structure matches what getExecutionsWithAssets expects
      const uploadedVideoMessage = {
        role: 'system' as const,
        content: `Video uploaded: ${file.originalname}`,
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'agent' as const,
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              id: uuidv4(),
              name: 'upload_video',
              arguments: {},
              result: {
                success: true,
                videoUrl: uploadResult.url,
                filename: file.originalname,
                message: `✅ Video "${file.originalname}" uploaded successfully!`
              }
            }
          ]
        }
      };

      // Add message to session
      await chatbotDb.addMessageToSession(sessionId, uploadedVideoMessage);

      res.json({
        success: true,
        message: 'Video uploaded successfully',
        url: uploadResult.url,
        filename: file.originalname,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload video to session error:', error);
      res.status(500).json({ error: 'Failed to upload video to session' });
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
        nextRunTime,
        keywords,
        requiredFunctionCalls,
        functionCallMinCalls,
        emailNotifications,
        emailCampaignTaskId,
        llmModel,
        runCount,
        variables,
        variableValues
      } = req.body;

      if (!scheduleName || !startingMessage || !scheduleFrequency) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate runCount if provided
      if (runCount !== undefined) {
        if (!Number.isInteger(runCount) || (runCount !== -1 && runCount < 1)) {
          return res.status(400).json({ error: 'runCount must be -1 (unlimited) or a positive integer' });
        }
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

      // Use provided nextRunTime or calculate default
      let scheduledNextRunTime: string;
      if (nextRunTime) {
        // Validate the provided nextRunTime
        const providedDate = new Date(nextRunTime);
        if (isNaN(providedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid nextRunTime format' });
        }
        scheduledNextRunTime = providedDate.toISOString();
      } else {
        // Default behavior: calculate next run time (9 AM UTC = 1 AM PST)
        const calculatedTime = calculateNextRunTime(scheduleFrequency, now);
        scheduledNextRunTime = calculatedTime.toISOString();
      }

      const scheduledChat: any = {
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
        nextRunTime: scheduledNextRunTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        sessionId: sessionId || null, // Store original sessionId for reference (can be null)
        type: 'scheduled_chat', // Distinguish from regular task schedules
        emailCampaignTaskId: emailCampaignTaskId || null,
        llmModel: llmModel || await agentModeService.getDefaultModel(), // Use provided model or default
        runCount: runCount !== undefined ? runCount : -1, // Default to unlimited runs if not specified
        variables: [] as ScheduledChatVariable[],
        variableValues: {} as Record<string, string>,
        variableRequestStatus: 'idle'
      };

      const { variables: normalizedVariables, error: variableError } =
        validateAndBuildScheduledChatVariables(startingMessage, variables);
      if (variableError) {
        return res.status(400).json({ error: variableError });
      }
      if (normalizedVariables.length > 0 && (!Array.isArray(emailNotifications) || emailNotifications.length === 0)) {
        return res.status(400).json({ error: 'Email Notifications are required when using variables in startingMessage' });
      }

      const normalizedVariableValues: Record<string, string> = {};
      if (normalizedVariables.length > 0 && variableValues && typeof variableValues === 'object') {
        normalizedVariables.forEach((variable) => {
          const rawValue = (variableValues as Record<string, unknown>)[variable.name];
          if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
            normalizedVariableValues[variable.name] = rawValue.trim();
          }
        });
      }

      scheduledChat.variables = normalizedVariables;
      scheduledChat.variableValues = normalizedVariableValues;
      scheduledChat.variableRequestStatus = normalizedVariables.length > 0
        ? (getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length > 0 ? 'pending' : 'provided')
        : 'idle';
      if (Object.keys(normalizedVariableValues).length > 0) {
        scheduledChat.variableValuesUpdatedAt = now.toISOString();
      }

      await scheduleDb.createSchedule(scheduledChat);

      res.status(201).json({
        scheduleId,
        message: 'Scheduled chat created successfully',
        nextRunTime: scheduledNextRunTime
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

      // Sort by creation time descending (newest first)
      scheduledChats.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });

      res.json(scheduledChats);
    } catch (error) {
      console.error('AgentMode: Get scheduled chats error:', error);
      res.status(500).json({ error: 'Failed to get scheduled chats' });
    }
  },

  // Update scheduled chat
  async updateScheduledChat(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;
      const {
        scheduleName,
        description,
        startingMessage,
        scheduleFrequency,
        nextRunTime,
        keywords,
        requiredFunctionCalls,
        functionCallMinCalls,
        emailNotifications,
        dailyDigest,
        emailCampaignTaskId,
        llmModel,
        runCount,
        variables,
        variableValues
      } = req.body;

      if (!scheduleName || !startingMessage || !scheduleFrequency) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate runCount if provided
      if (runCount !== undefined) {
        if (!Number.isInteger(runCount) || (runCount !== -1 && runCount < 1)) {
          return res.status(400).json({ error: 'runCount must be -1 (unlimited) or a positive integer' });
        }
      }

      // Verify schedule exists and belongs to user
      const existingSchedule = await scheduleDb.getScheduleById(scheduleId);
      if (!existingSchedule || existingSchedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      const now = new Date();

      // Determine nextRunTime: use provided value or keep existing
      let scheduledNextRunTime = existingSchedule.nextRunTime;
      let shouldUpdateNextRunTime = false;
      if (nextRunTime) {
        const providedDate = new Date(nextRunTime);
        if (isNaN(providedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid nextRunTime format' });
        }
        scheduledNextRunTime = providedDate.toISOString();
        shouldUpdateNextRunTime = true;
      }

      // Update the schedule
      const updates: any = {
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
        emailCampaignTaskId: emailCampaignTaskId || null,
        llmModel: llmModel || await agentModeService.getDefaultModel(), // Use provided model or default
      };

      const { variables: normalizedVariables, error: variableError } =
        validateAndBuildScheduledChatVariables(startingMessage, variables, existingSchedule.variables || []);
      if (variableError) {
        return res.status(400).json({ error: variableError });
      }
      const effectiveEmailNotifications = Array.isArray(emailNotifications)
        ? emailNotifications
        : (Array.isArray(existingSchedule.emailNotifications) ? existingSchedule.emailNotifications : []);
      if (normalizedVariables.length > 0 && effectiveEmailNotifications.length === 0) {
        return res.status(400).json({ error: 'Email Notifications are required when using variables in startingMessage' });
      }
      updates.variables = normalizedVariables;

      // Preserve existing values for unchanged variables unless explicitly overwritten
      const existingValues = (existingSchedule.variableValues && typeof existingSchedule.variableValues === 'object')
        ? existingSchedule.variableValues as Record<string, string>
        : {};
      const normalizedVariableValues: Record<string, string> = {};

      normalizedVariables.forEach((variable) => {
        const incomingValue = variableValues && typeof variableValues === 'object'
          ? (variableValues as Record<string, unknown>)[variable.name]
          : undefined;

        if (typeof incomingValue === 'string') {
          const trimmed = incomingValue.trim();
          if (trimmed.length > 0) {
            normalizedVariableValues[variable.name] = trimmed;
          }
          return;
        }

        const existingValue = existingValues[variable.name];
        if (typeof existingValue === 'string' && existingValue.trim().length > 0) {
          normalizedVariableValues[variable.name] = existingValue.trim();
        }
      });

      updates.variableValues = normalizedVariableValues;
      updates.variableRequestStatus = normalizedVariables.length > 0
        ? (getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length > 0 ? 'pending' : 'provided')
        : 'idle';
      if (Object.keys(normalizedVariableValues).length > 0) {
        updates.variableValuesUpdatedAt = now.toISOString();
      }

      // Only include nextRunTime in updates if it was explicitly provided
      if (shouldUpdateNextRunTime) {
        updates.nextRunTime = scheduledNextRunTime;
      }

      // Only include runCount in updates if it was explicitly provided
      if (runCount !== undefined) {
        updates.runCount = runCount;
      }

      await scheduleDb.updateSchedule(scheduleId, updates);

      res.json({
        message: 'Scheduled chat updated successfully',
        nextRunTime: scheduledNextRunTime
      });
    } catch (error) {
      console.error('AgentMode: Update scheduled chat error:', error);
      res.status(500).json({ error: 'Failed to update scheduled chat' });
    }
  },

  // Submit variable values for a scheduled chat
  async submitScheduledChatVariables(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { scheduleId } = req.params;
      const { variableValues, triggerRun } = req.body as { variableValues?: Record<string, string>; triggerRun?: boolean };

      if (!variableValues || typeof variableValues !== 'object') {
        return res.status(400).json({ error: 'variableValues object is required' });
      }

      const schedule = await scheduleDb.getScheduleById(scheduleId);
      if (!schedule || schedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      if (variables.length === 0) {
        return res.status(400).json({ error: 'This scheduled chat has no variables' });
      }

      const sanitizedValues: Record<string, string> = {};
      variables.forEach((variable) => {
        const rawValue = variableValues[variable.name];
        if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
          sanitizedValues[variable.name] = rawValue.trim();
        }
      });

      const missingVariableNames = getMissingScheduledChatVariableNames(variables, sanitizedValues);
      const nowIso = new Date().toISOString();

      await scheduleDb.updateSchedule(scheduleId, {
        variableValues: sanitizedValues,
        variableRequestStatus: missingVariableNames.length > 0 ? 'pending' : 'provided',
        variableValuesUpdatedAt: nowIso,
        variableRequestAccessTokenConsumedAt: nowIso,
        updatedAt: nowIso,
      });

      if (missingVariableNames.length === 0 && triggerRun !== false) {
        const scheduleToRun: any = {
          ...schedule,
          variableValues: sanitizedValues,
          variableRequestStatus: 'provided',
          variableValuesUpdatedAt: nowIso
        };

        runScheduledChat(scheduleToRun, user.userId, false).then(async (result) => {
          if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
            try {
              await scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
                variableValues: {},
                variableRequestStatus: 'pending',
                updatedAt: new Date().toISOString()
              });
            } catch (clearError) {
              console.error(`Error clearing variable values after manual trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
            }
          }

          if (result.sessionId) {
            try {
              const emailNotifications = scheduleToRun.emailNotifications || [];
              if (emailNotifications.length > 0) {
                await emailService.sendScheduledChatResultEmail(
                  emailNotifications,
                  scheduleToRun.scheduleName,
                  result,
                  scheduleToRun.scheduleId
                );
              }
            } catch (emailError) {
              console.error('Error sending scheduled chat result email after manual trigger:', emailError);
            }
          }
        }).catch(async (runError) => {
          if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
            scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
              variableValues: {},
              variableRequestStatus: 'pending',
              updatedAt: new Date().toISOString()
            }).catch((clearError) => {
              console.error(`Error clearing variable values after failed manual trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
            });
          }
          console.error(`Error triggering scheduled chat after variable submission for ${scheduleToRun.scheduleName}:`, runError);
        });
      }

      res.json({
        message: missingVariableNames.length === 0
          ? (triggerRun === false
              ? 'Variable values saved.'
              : 'Variable values saved. Scheduled chat run started.')
          : 'Variable values saved, but some required variables are still missing.',
        missingVariables: missingVariableNames
      });
    } catch (error) {
      console.error('AgentMode: Submit scheduled chat variables error:', error);
      res.status(500).json({ error: 'Failed to submit scheduled chat variables' });
    }
  },

  // Public endpoint: view required variables by one-time access token (no login required)
  async getScheduledChatVariablesByAccessToken(req: Request, res: Response) {
    try {
      const { accessToken } = req.params;
      if (!accessToken || typeof accessToken !== 'string') {
        return res.status(400).json({ error: 'Access token is required' });
      }

      const tokenHash = hashScheduledChatVariableAccessToken(accessToken);
      const schedule = await scheduleDb.getScheduledChatByVariableAccessTokenHash(tokenHash);
      if (!schedule) {
        return res.status(404).json({ error: 'Invalid or expired variable request link' });
      }

      const nowMs = Date.now();
      const expiresAtMs = schedule.variableRequestAccessTokenExpiresAt
        ? new Date(schedule.variableRequestAccessTokenExpiresAt).getTime()
        : NaN;
      const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs < nowMs;
      if (isExpired) {
        return res.status(410).json({ error: 'This variable request link has expired' });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      const isCompleted = Boolean(schedule.variableRequestAccessTokenConsumedAt)
        || schedule.variableRequestStatus === 'provided';

      return res.json({
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.scheduleName || 'Scheduled Chat',
        variables,
        status: isCompleted ? 'completed' : 'pending',
        submittedAt: schedule.variableRequestAccessTokenConsumedAt || null,
        expiresAt: schedule.variableRequestAccessTokenExpiresAt || null,
      });
    } catch (error) {
      console.error('AgentMode: Get scheduled chat variables by access token error:', error);
      return res.status(500).json({ error: 'Failed to load variable request' });
    }
  },

  // Public endpoint: submit variables by one-time access token (no login required)
  async submitScheduledChatVariablesByAccessToken(req: Request, res: Response) {
    try {
      const { accessToken } = req.params;
      const { variableValues } = req.body as { variableValues?: Record<string, string> };

      if (!accessToken || typeof accessToken !== 'string') {
        return res.status(400).json({ error: 'Access token is required' });
      }
      if (!variableValues || typeof variableValues !== 'object') {
        return res.status(400).json({ error: 'variableValues object is required' });
      }

      const tokenHash = hashScheduledChatVariableAccessToken(accessToken);
      const schedule = await scheduleDb.getScheduledChatByVariableAccessTokenHash(tokenHash);
      if (!schedule) {
        return res.status(404).json({ error: 'Invalid or expired variable request link' });
      }

      const nowIso = new Date().toISOString();
      const expiresAtMs = schedule.variableRequestAccessTokenExpiresAt
        ? new Date(schedule.variableRequestAccessTokenExpiresAt).getTime()
        : NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
        return res.status(410).json({ error: 'This variable request link has expired' });
      }

      if (schedule.variableRequestAccessTokenConsumedAt) {
        return res.status(409).json({
          error: 'This variable request link has already been used',
          status: 'completed',
          submittedAt: schedule.variableRequestAccessTokenConsumedAt
        });
      }

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      if (variables.length === 0) {
        return res.status(400).json({ error: 'This scheduled chat has no variables' });
      }

      const sanitizedValues: Record<string, string> = {};
      variables.forEach((variable) => {
        const rawValue = variableValues[variable.name];
        if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
          sanitizedValues[variable.name] = rawValue.trim();
        }
      });

      const missingVariableNames = getMissingScheduledChatVariableNames(variables, sanitizedValues);
      if (missingVariableNames.length > 0) {
        return res.status(400).json({
          error: 'Missing values for required variables',
          missingVariables: missingVariableNames
        });
      }

      await scheduleDb.updateSchedule(schedule.scheduleId, {
        variableValues: sanitizedValues,
        variableRequestStatus: 'provided',
        variableValuesUpdatedAt: nowIso,
        variableRequestAccessTokenConsumedAt: nowIso,
        updatedAt: nowIso,
      });

      const scheduleToRun: any = {
        ...schedule,
        variableValues: sanitizedValues,
        variableRequestStatus: 'provided',
        variableValuesUpdatedAt: nowIso
      };

      runScheduledChat(scheduleToRun, schedule.userId, false).then(async (result) => {
        if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
          try {
            await scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
              variableValues: {},
              variableRequestStatus: 'pending',
              updatedAt: new Date().toISOString()
            });
          } catch (clearError) {
            console.error(`Error clearing variable values after public trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
          }
        }

        if (result.sessionId) {
          try {
            const emailNotifications = scheduleToRun.emailNotifications || [];
            if (emailNotifications.length > 0) {
              await emailService.sendScheduledChatResultEmail(
                emailNotifications,
                scheduleToRun.scheduleName,
                result,
                scheduleToRun.scheduleId
              );
            }
          } catch (emailError) {
            console.error('Error sending scheduled chat result email after public variable submit:', emailError);
          }
        }
      }).catch((runError) => {
        if (Array.isArray(scheduleToRun.variables) && scheduleToRun.variables.length > 0) {
          scheduleDb.updateSchedule(scheduleToRun.scheduleId, {
            variableValues: {},
            variableRequestStatus: 'pending',
            updatedAt: new Date().toISOString()
          }).catch((clearError) => {
            console.error(`Error clearing variable values after failed public trigger for schedule ${scheduleToRun.scheduleName}:`, clearError);
          });
        }
        console.error(`Error triggering scheduled chat after public variable submission for ${scheduleToRun.scheduleName}:`, runError);
      });

      return res.json({
        message: 'Variable values submitted successfully. Scheduled chat run started.',
        status: 'completed',
        submittedAt: nowIso
      });
    } catch (error) {
      console.error('AgentMode: Submit scheduled chat variables by access token error:', error);
      return res.status(500).json({ error: 'Failed to submit variable values' });
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

      const variables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
      const variableValues = (schedule.variableValues && typeof schedule.variableValues === 'object')
        ? schedule.variableValues as Record<string, string>
        : {};
      const missingVariables = getMissingScheduledChatVariableNames(variables, variableValues);
      if (variables.length > 0 && missingVariables.length > 0) {
        return res.status(400).json({
          error: 'Missing variable values for scheduled chat',
          missingVariables
        });
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
        const startOfDay = new Date(Date.UTC(selectedResultDate.getUTCFullYear(), selectedResultDate.getUTCMonth(), selectedResultDate.getUTCDate()));
        const endOfDay = new Date(Date.UTC(selectedResultDate.getUTCFullYear(), selectedResultDate.getUTCMonth(), selectedResultDate.getUTCDate() + 1));

        const sameDayResultsRaw = testHistory.filter((result: any) => {
          const resultDate = new Date(result.createdAt);
          return resultDate >= startOfDay && resultDate < endOfDay;
        });

        // Reconstruct actualResponse for results that don't have it (only needed for email)
        const sameDayResults = await Promise.all(
          sameDayResultsRaw.map(async (result: any) => {
            if (!result.actualResponse && result.sessionId) {
              const actualResponse = await getActualResponseFromSession(result.sessionId);
              return { ...result, actualResponse };
            }
            return result;
          })
        );

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
      // Reconstruct actualResponse from session if missing
      let actualResponse = record.actualResponse || record.response || '';
      if ((!actualResponse || actualResponse.trim().length === 0) && record.sessionId) {
        actualResponse = await getActualResponseFromSession(record.sessionId);
      }
      
      // Build a result object compatible with emailService
      const resultForEmail = {
        passed: !!record.passed,
        actualResponse: actualResponse || 'Response not available. View the conversation to see the full response.',
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
          const scheduleVariables: ScheduledChatVariable[] = Array.isArray(schedule.variables) ? schedule.variables : [];
          const scheduleVariableValues = (schedule.variableValues && typeof schedule.variableValues === 'object')
            ? schedule.variableValues as Record<string, string>
            : {};
          const missingVariableNames = getMissingScheduledChatVariableNames(scheduleVariables, scheduleVariableValues);
          const hasAllVariableValues = missingVariableNames.length === 0;
          const hasVariableRequestSentAt = typeof schedule.variableRequestSentAt === 'string' && schedule.variableRequestSentAt.length > 0;
          const hasVariableValuesUpdatedAt = typeof schedule.variableValuesUpdatedAt === 'string' && schedule.variableValuesUpdatedAt.length > 0;
          const hasLastRunTime = typeof schedule.lastRunTime === 'string' && schedule.lastRunTime.length > 0;
          const variableRequestSentAtMs = hasVariableRequestSentAt ? new Date(schedule.variableRequestSentAt).getTime() : NaN;
          const variableValuesUpdatedAtMs = hasVariableValuesUpdatedAt ? new Date(schedule.variableValuesUpdatedAt).getTime() : NaN;
          const lastRunTimeMs = hasLastRunTime ? new Date(schedule.lastRunTime).getTime() : NaN;
          const valuesProvidedAfterLatestRequest = Number.isFinite(variableRequestSentAtMs)
            && Number.isFinite(variableValuesUpdatedAtMs)
            && variableValuesUpdatedAtMs >= variableRequestSentAtMs;
          const valuesProvidedAfterLastRun = !Number.isFinite(lastRunTimeMs)
            || (Number.isFinite(variableValuesUpdatedAtMs) && variableValuesUpdatedAtMs > lastRunTimeMs);
          const isVariableRequestSatisfied = schedule.variableRequestStatus === 'provided'
            && hasAllVariableValues
            && valuesProvidedAfterLatestRequest
            && valuesProvidedAfterLastRun;

          // Calculate next run based on the current nextRunTime to preserve the scheduled time
          const currentNextRun = new Date(schedule.nextRunTime);
          const nextRunTime = calculateNextRunTime(schedule.frequency, currentNextRun);

          if (scheduleVariables.length > 0 && !isVariableRequestSatisfied) {
            const requestedVariableNames = missingVariableNames.length > 0
              ? missingVariableNames
              : scheduleVariables.map(variable => variable.name);
            const variableAccessToken = crypto.randomBytes(32).toString('hex');
            const variableAccessTokenHash = hashScheduledChatVariableAccessToken(variableAccessToken);
            const variableAccessTokenExpiresAtDate = new Date(nextRunTime.getTime() - (30 * 60 * 1000));
            const variableAccessTokenExpiresAt = variableAccessTokenExpiresAtDate.toISOString();
            const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
            const variableInputUrl = `${customerFrontendUrl}/scheduled-chat/variables/${variableAccessToken}`;

            // Advance next run immediately. This run window is now waiting for variable submission.
            await scheduleDb.updateScheduleAfterRun(
              schedule.scheduleId,
              now.toISOString(),
              nextRunTime.toISOString(),
              true
            );

            await scheduleDb.updateSchedule(schedule.scheduleId, {
              updatedAt: now.toISOString(),
              variableRequestStatus: 'pending',
              variableRequestSentAt: now.toISOString(),
              variableRequestAccessTokenHash: variableAccessTokenHash,
              variableRequestAccessTokenExpiresAt: variableAccessTokenExpiresAt,
              variableRequestAccessTokenConsumedAt: ''
            });

            try {
              const user = await userDb.getUserById(schedule.userId);
              const emailNotifications = schedule.emailNotifications || [];
              const recipients = emailNotifications.length > 0 ? emailNotifications : (user?.email ? [user.email] : []);

              if (recipients.length > 0) {
                await emailService.sendScheduledChatVariableRequestEmail(
                  recipients,
                  schedule.scheduleName,
                  schedule.scheduleId,
                  scheduleVariables.filter(variable => requestedVariableNames.includes(variable.name)),
                  variableInputUrl,
                  variableAccessTokenExpiresAt
                );
              } else {
                console.log(`No recipients configured for variable request on schedule ${schedule.scheduleName}`);
              }
            } catch (error) {
              console.error(`Error sending variable request email for schedule ${schedule.scheduleName}:`, error);
            }

            results.push({
              scheduleId: schedule.scheduleId,
              scheduleName: schedule.scheduleName,
              status: 'waiting_for_variables',
              nextRunTime: nextRunTime.toISOString(),
              variableRequestExpiresAt: variableAccessTokenExpiresAt,
              missingVariables: requestedVariableNames
            });

            continue;
          }

          // Check if we've reached the concurrent run limit
          if (currentConcurrentRuns >= maxConcurrentRuns) {
            // Delay the run for half an hour
            const delayedRunTime = new Date(now);
            delayedRunTime.setMinutes(delayedRunTime.getMinutes() + 30);

            // Update the schedule with delayed run time
            // Don't decrement runCount since this run hasn't actually happened
            await scheduleDb.updateScheduleAfterRun(
              schedule.scheduleId,
              schedule.lastRunTime || now.toISOString(),
              delayedRunTime.toISOString(),
              false // Don't decrement runCount for delayed runs
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

          // Decrement runCount and auto-pause if it reaches 0
          // Note: Both successful and failed runs count toward the run limit
          await scheduleDb.updateScheduleAfterRun(
            schedule.scheduleId,
            now.toISOString(),
            nextRunTime.toISOString(),
            true // Decrement runCount (default behavior)
          );

          // Increment concurrent run counter
          currentConcurrentRuns++;

          // Start the scheduled chat run asynchronously (don't await)
          runScheduledChat(schedule, schedule.userId, false).then(async (result) => {
            // Decrement concurrent run counter when done
            currentConcurrentRuns--;

            // Clear consumed variable values so each run requests fresh values
            if (scheduleVariables.length > 0) {
              try {
                await scheduleDb.updateSchedule(schedule.scheduleId, {
                  variableValues: {},
                  variableRequestStatus: 'pending',
                  updatedAt: new Date().toISOString()
                });
              } catch (error) {
                console.error(`Error clearing variable values for schedule ${schedule.scheduleName}:`, error);
              }
            }

            // Send email notification with the result (only if it actually ran, not if it was blocked)
            // If result.sessionId is empty, it means the run was blocked due to subscription restrictions
            if (result.sessionId) {
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
            }
            // If result.sessionId is empty, the error email was already sent in runScheduledChat
          }).catch((error) => {
            // Decrement concurrent run counter on error
            currentConcurrentRuns--;

            if (scheduleVariables.length > 0) {
              scheduleDb.updateSchedule(schedule.scheduleId, {
                variableValues: {},
                variableRequestStatus: 'pending',
                updatedAt: new Date().toISOString()
              }).catch((updateError) => {
                console.error(`Error clearing variable values after failed run for schedule ${schedule.scheduleName}:`, updateError);
              });
            }

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

      // Use session's llmModel if available, otherwise use default
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      res.json({
        sessionId: session.sessionId,
        title: session.title,
        messages: filterMessagesForClient(session.messages),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        workPlan: session.workPlan,
        llmModel: modelToUse,
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

      // Use session's llmModel if available, otherwise use default
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Generate AI response using the same function as regular users
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId, // Use the original session owner's userId
        modelToUse,
        attachments
      );

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills
      });
    } catch (error) {
      console.error('AgentMode: Generate conversable response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const convSessionId = req.params?.shareId;
      if (convSessionId) {
        emitProgress(convSessionId, { iteration: 0, status: 'complete' });
        progressStore.delete(convSessionId);
      }

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

        if (error.message.includes('content policies') || error.message.includes('violate content policies') || error.message.includes('content management policy') || error.message.includes('content_filter')) {
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

  // Get all predefined work plans (public)
  async getAllPredefinedWorkPlans(req: Request, res: Response) {
    try {
      const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
      
      if (!setting || !setting.settingValue) {
        return res.json([]);
      }
      
      const workPlans = JSON.parse(setting.settingValue);
      // Filter plans to only include those with showInAgentMode === true
      const visiblePlans = workPlans.filter((plan: any) => plan.showInAgentMode === true);
      res.json(visiblePlans);
    } catch (error) {
      console.error('AgentMode: Get all predefined work plans error:', error);
      res.status(500).json({ error: 'Failed to get all predefined work plans' });
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

      res.json({
        ...workPlan,
        showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
        requireLogin: workPlan.requireLogin || false
      });
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
        autocomplete: predefinedPlan.autocomplete || false,
        showLoginSignup: predefinedPlan.showLoginSignup || 'after_plan_completed',
        requireLogin: predefinedPlan.requireLogin || false
      };
      await chatbotDb.updateSessionWorkPlan(session.sessionId, workPlanWithWelcome);

      // Set default model for new sessions
      // Use work plan's default model if specified, otherwise use global default
      let selectedModel = predefinedPlan.defaultModel;

      // Validate work plan's default model
      if (selectedModel) {
        const supportedModels = await agentModeService.getSupportedModels();
        if (!supportedModels.includes(selectedModel)) {
          console.warn(`AgentMode: Work plan default model "${selectedModel}" not supported, using global default`);
          selectedModel = undefined;
        } else {
          console.log(`AgentMode: Using work plan default model: ${selectedModel}`);
        }
      }

      // Fall back to global default if no valid work plan model
      if (!selectedModel) {
        selectedModel = await agentModeService.getDefaultModel();
      }

      await chatbotDb.updateSessionLlmModel(session.sessionId, selectedModel);

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
      
      // Log attachments for debugging
      console.log('AgentMode verifiedGenerate: Received attachments:', attachments?.length || 0, attachments);

      // Validate required fields
      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      if (!startingMessage || !startingMessage.trim()) {
        return res.status(400).json({ error: 'Starting message is required' });
      }

      if (requiredFunctions !== undefined && !Array.isArray(requiredFunctions)) {
        return res.status(400).json({ error: 'Required functions must be an array when provided' });
      }

      const requiredFunctionsArray = Array.isArray(requiredFunctions) ? requiredFunctions : [];

      // Validate requiredFunctions format: [{ functionName: string, minCount: number }]
      for (const reqFunc of requiredFunctionsArray) {
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
      // Ensure attachments is always an array
      const attachmentsArray = Array.isArray(attachments) ? attachments : [];
      console.log('AgentMode verifiedGenerate: Passing attachments to runVerifiedChat:', attachmentsArray.length, attachmentsArray);
      const result = await runVerifiedChat({
        sessionId,
        userId: user.userId,
        startingMessage: startingMessage.trim(),
        keywords: keywords || [],
        requiredFunctions: requiredFunctionsArray,
        maxAttempts: maxAttemptsParam || 5,
        attachments: attachmentsArray
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
      const sessionId = req.body?.sessionId;
      const user = req.user as User;
      const isSessionLimit = isSessionLimitError(error);

      try {
        await sendAgentModeOncallAlert({
          subject: isSessionLimit
            ? 'Agent Mode Verified Generate: Session limit exceeded'
            : 'Agent Mode Verified Generate: Failed',
          message: isSessionLimit
            ? `Verified generation failed because the session reached its limit.\n\nSession: ${sessionId || 'unknown'}\nUser: ${user?.userId || 'unknown'}`
            : `Verified generation failed.\n\nSession: ${sessionId || 'unknown'}\nUser: ${user?.userId || 'unknown'}`,
          sessionId,
          context: {
            'User ID': user?.userId || 'unknown',
            'Error': error.message || String(error),
            'Starting Message': req.body?.startingMessage || 'N/A',
            'Required Functions': JSON.stringify(req.body?.requiredFunctions || []),
            'Keywords': JSON.stringify(req.body?.keywords || [])
          }
        });
      } catch (alertError) {
        console.error('❌ Error sending oncall alert:', alertError);
      }
      res.status(500).json({
        error: 'Failed to perform verified generation',
        message: error.message || 'Unknown error'
      });
    }
  },

  // Update session LLM model (for authenticated users)
  async updateSessionLlmModel(req: AuthenticatedRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const { llmModel } = req.body;
      const user = req.user;

      if (!llmModel) {
        return res.status(400).json({ error: 'llmModel is required' });
      }

      // Get the session to verify ownership
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user owns the session (or is admin)
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Update the session's llmModel
      const updatedSession = await chatbotDb.updateSessionLlmModel(sessionId, llmModel);

      res.json({ llmModel: updatedSession.llmModel });
    } catch (error) {
      console.error('AgentMode: Update session LLM model error:', error);
      res.status(500).json({ error: 'Failed to update session LLM model' });
    }
  },

  // Update session LLM model for shared conversation (with conversable token)
  async updateSharedSessionLlmModel(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;
      const { llmModel } = req.body;

      if (!llmModel) {
        return res.status(400).json({ error: 'llmModel is required' });
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

      // Update the session's llmModel
      const updatedSession = await chatbotDb.updateSessionLlmModel(shareId, llmModel);

      res.json({ llmModel: updatedSession.llmModel });
    } catch (error) {
      console.error('AgentMode: Update shared session LLM model error:', error);
      res.status(500).json({ error: 'Failed to update session LLM model' });
    }
  },

  // Update session title
  async updateSessionTitle(req: AuthenticatedRequest, res: Response) {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { sessionId } = req.params;
      const { title } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
      }

      // Get the session to verify ownership
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user owns the session (or is admin)
      if (session.userId !== user.userId && !user.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access to session' });
      }

      // Update the session title
      const updatedSession = await chatbotDb.updateSessionTitle(sessionId, title.trim());

      res.json({ title: updatedSession.title });
    } catch (error) {
      console.error('AgentMode: Update session title error:', error);
      res.status(500).json({ error: 'Failed to update session title' });
    }
  },
};
