import { Request, Response } from 'express';
import { AuthenticatedRequest, getUserFromToken } from '../middleware/auth';
import { agentModeService, AgentModeService } from '../services/agentModeService';
import { ABOUT_AGENTWEB_TEAM } from '../docs/agentModeSystemPrompt';
import { chatbotDb, updateTaskExecutionStatus, ChatMessage, getEmmaSystemContext } from '../services/chatbotService';
import { scheduleDb, userDb, taskDb, scheduleTemplateDb } from '../services/db';
import { User } from '../types/auth';
import multer from 'multer';
import crypto from 'crypto';
import { uploadFileToS3, uploadScreenshotToS3 } from '../utils/s3Utils';
import { emailService } from '../services/emailService';
import { settingsService } from '../services/settingsService';
import { workPlanService } from '../services/workPlanService';
import { v4 as uuidv4 } from 'uuid';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { emitProgress, registerProgressCallback, getLatestProgress, progressStore, requestCancel, clearCancel } from '../utils/sseProgress';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { isContextLimitError, isSessionLimitError, isTransientLLMError, isWorkerShutdownError } from '../utils/agentModeErrors';
import { DiagnosisContext } from '../services/agentModeService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import * as loopEventsEmitter from '../services/loopEventsEmitter';
import { createOncallItem } from '../services/notionService';
import { skillService } from '../services/skillService';
import { normalizeEmailList } from '../utils/validation';
import { getAllowedSkills } from '../services/subscriptionService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { transcribeSpeech } from '../services/voiceService';
import { summarizeSessionIfNeeded } from '../services/sessionSummaryService';
import { DynamoDB } from 'aws-sdk';

/** Default expiration for legacy interactive shares that don't have an expiresAt field (7 days from sharedAt). */
const LEGACY_SHARE_DEFAULT_EXPIRATION_DAYS = 7;

/**
 * In-memory set of session IDs that are currently generating a response.
 * Used to reject concurrent /generate requests for the same session with 409.
 * Exported so tests can inspect and reset it.
 */
export const activeSessionGenerations = new Set<string>();

/**
 * Wall-clock timeout for a single agent-mode generation. Without this, a hung
 * LLM call (stuck await, runaway tool loop, never-resolving upstream) keeps
 * the activeSessionGenerations lock held indefinitely — every subsequent
 * /generate request then returns 409 "Session is busy" forever. The lock
 * release lives in a try/finally that only runs when the inner promise
 * settles; Promise.race against this timeout forces a rejection so the
 * finally runs and the lock releases.
 *
 * Note: this does NOT cancel the underlying generation (would require an
 * AbortController plumbed through every layer). The orphaned generation
 * continues in the background until it settles. That's acceptable — the
 * critical thing is that the user-facing lock releases.
 */
const GENERATION_TIMEOUT_MS = parseInt(
  process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || '600000',
  10
); // 10 minutes default — local agent browser tasks need > 5 min

async function withGenerationTimeout<T>(
  promise: Promise<T>,
  sessionId: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(
        `Generation timed out after ${GENERATION_TIMEOUT_MS}ms for session ${sessionId}. ` +
        `The lock has been released; the orphaned generation may still complete in the background.`
      ));
    }, GENERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Returns the effective expiration date for an interactive share.
 * If expiresAt is set, use it. Otherwise, default to sharedAt + 7 days.
 * If neither is set, returns a date in the past (treat as expired).
 */
function getInteractiveShareExpiresAt(share: { expiresAt?: string; sharedAt?: string }): Date {
  if (share.expiresAt) return new Date(share.expiresAt);
  if (share.sharedAt) return new Date(new Date(share.sharedAt).getTime() + LEGACY_SHARE_DEFAULT_EXPIRATION_DAYS * 86400000);
  return new Date(0); // No dates at all — treat as expired
}

/**
 * Auto-files a Notion "Customer Reported" issue for context-limit errors.
 * Skips if the session already has contextLimitReported set (dedup).
 */
async function autoReportContextLimitToNotion(
  sessionId: string | undefined,
  userEmail: string | undefined,
  userId: string | undefined,
  llmModel: string | undefined,
  session: import('../services/chatbotService').ChatSession | null
): Promise<void> {
  if (!sessionId || session?.contextLimitReported) return;
  try {
    await createOncallItem({
      title: `Context limit reached - session ${sessionId}`,
      description: `User hit the context window limit in agent mode.\n\nUser: ${userEmail || 'Unknown'}\nModel: ${llmModel || 'Not specified'}\nSession messages: ${session?.messages?.length ?? 'N/A'}\nSession title: ${session?.title || 'N/A'}`,
      additionalTags: ['Customer Reported', 'Context Limit'],
      context: {
        'User ID': userId || 'N/A',
        'User Email': userEmail || 'N/A',
        'Session ID': sessionId,
        'LLM Model': llmModel || 'Not specified',
        'Session Message Count': session?.messages?.length ?? 'N/A',
        'Session Title': session?.title || 'N/A',
      },
    });
    chatbotDb.updateSessionContextLimitReported(sessionId).catch(err =>
      console.error('Failed to set contextLimitReported flag:', err)
    );
  } catch (err) {
    console.error('Failed to create context-limit Notion item:', err);
  }
}

/** Classify an error for the diagnosis agent. */
function classifyErrorType(error: unknown): DiagnosisContext['errorType'] {
  if (isContextLimitError(error)) return 'context_limit';
  if (error instanceof Error) {
    if (error.message.includes('content policies') || error.message.includes('content_filter')) return 'content_filter';
    if (error.message.includes('high demand') || (error as any)?.status === 429) return 'rate_limit';
    if (isTransientLLMError(error)) return 'transient';
  }
  return 'unknown';
}

/** Build a compact work plan summary string for the diagnosis agent. */
function buildWorkPlanSummary(session: any): string | null {
  if (!session?.workPlan?.steps?.length) return null;
  return session.workPlan.steps
    .map((s: any) => `Step ${s.stepCount}: ${s.title} [${s.status}]`)
    .join('\n');
}

/**
 * Invoke the diagnosis agent to produce a context-aware error message.
 * Returns null if diagnosis fails — caller should fall back to the generic message.
 */
async function getDiagnosticErrorMessage(
  error: unknown,
  sessionId: string,
  userMessage: string
): Promise<string | null> {
  try {
    const session = await chatbotDb.getChatSession(sessionId).catch(() => null);
    const context: DiagnosisContext = {
      errorType: classifyErrorType(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      userMessage: userMessage || '',
      workPlanSummary: buildWorkPlanSummary(session),
      failedFunctions: session?.failedFunctions || null,
    };
    return await agentModeService.generateDiagnosticMessage(context);
  } catch {
    return null;
  }
}

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
  type?: 'text' | 'long_text' | 'file';
}

const SCHEDULED_CHAT_VARIABLE_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// How many previous scheduled-chat prompts to retain for revert. Oldest are dropped.
export const SCHEDULE_PROMPT_REVISION_LIMIT = 10;

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

  const VALID_VARIABLE_TYPES = new Set(['text', 'long_text', 'file']);
  const normalizedInputVariables: ScheduledChatVariable[] = Array.isArray(inputVariables)
    ? inputVariables
        .filter((v: any) => v && typeof v.name === 'string')
        .map((v: any) => ({
          name: v.name.trim(),
          description: typeof v.description === 'string' ? v.description.trim() : '',
          ...(typeof v.type === 'string' && VALID_VARIABLE_TYPES.has(v.type) ? { type: v.type as 'text' | 'long_text' | 'file' } : {}),
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

  const existingMap = new Map(
    (existingVariables || []).map(variable => [variable.name, variable])
  );
  const inputMap = new Map(
    normalizedInputVariables.map(variable => [variable.name, variable])
  );

  const variables: ScheduledChatVariable[] = variableNames.map((name) => {
    const input = inputMap.get(name);
    const existing = existingMap.get(name);
    const description = input ? (input.description || '') : (existing?.description || '');
    const type = input?.type || existing?.type;
    return {
      name,
      description,
      ...(type ? { type } : {}),
    };
  });

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

function parseFileVariableValue(value: string): { url: string; filename: string; size: number; mimetype: string } | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.url === 'string' && typeof parsed.filename === 'string') {
      return parsed;
    }
  } catch {
    // not a file variable JSON
  }
  return null;
}

function applyScheduledChatVariableValues(
  startingMessage: string,
  variableValues: Record<string, string> = {},
  variables: ScheduledChatVariable[] = []
): string {
  const variableTypeMap = new Map(variables.map(v => [v.name, v.type || 'text']));
  return startingMessage.replace(SCHEDULED_CHAT_VARIABLE_REGEX, (_, variableName: string) => {
    const value = variableValues[variableName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `{{${variableName}}}`;
    }
    // For file variables, replace with a markdown link
    if (variableTypeMap.get(variableName) === 'file') {
      const fileMeta = parseFileVariableValue(value);
      if (fileMeta) {
        return `[${fileMeta.filename}](${fileMeta.url})`;
      }
    }
    return value;
  });
}

function extractFileAttachmentsFromVariables(
  variables: ScheduledChatVariable[],
  variableValues: Record<string, string> = {}
): Array<{ url: string; filename: string; size: number; mimetype: string }> {
  const attachments: Array<{ url: string; filename: string; size: number; mimetype: string }> = [];
  for (const variable of variables) {
    if (variable.type === 'file') {
      const value = variableValues[variable.name];
      if (typeof value === 'string') {
        const fileMeta = parseFileVariableValue(value);
        if (fileMeta) {
          attachments.push(fileMeta);
        }
      }
    }
  }
  return attachments;
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

  // Only apply task-type model overrides when no explicit model was provided.
  // When params.llmModel is set (e.g. from a scheduled chat's configured model),
  // respect the caller's choice instead of overriding based on required functions.
  if (!params.llmModel) {
    const shouldUseReportGenerationModel = requiredFunctions.some((reqFunc) => (
      reqFunc.functionName === 'update_html_file' || reqFunc.functionName === 'read_file_content' || reqFunc.functionName === 'create_blog_article'
    ));
    const shouldUseImageGenerationModel = requiredFunctions.some((reqFunc) => (
      reqFunc.functionName === 'generate_image'
    ));
    const shouldUseVideoGenerationModel = requiredFunctions.some((reqFunc) => (
      reqFunc.functionName === 'generate_video'
    ));
    if (shouldUseReportGenerationModel) {
      const reportGenModel = await agentModeService.getReportGenerationDefaultModel();
      if (sessionModel !== reportGenModel) {
        await chatbotDb.updateSessionLlmModel(sessionId, reportGenModel);
        sessionModel = reportGenModel;
      }
    } else if (shouldUseImageGenerationModel) {
      const imageGenModel = await agentModeService.getImageGenerationDefaultModel();
      if (sessionModel !== imageGenModel) {
        await chatbotDb.updateSessionLlmModel(sessionId, imageGenModel);
        sessionModel = imageGenModel;
      }
    } else if (shouldUseVideoGenerationModel) {
      const videoGenModel = await agentModeService.getVideoGenerationDefaultModel();
      if (sessionModel !== videoGenModel) {
        await chatbotDb.updateSessionLlmModel(sessionId, videoGenModel);
        sessionModel = videoGenModel;
      }
    }
  }
  const defaultModel = params.llmModel || sessionModel || await agentModeService.getDefaultModel();

  // Auto-install skills that contain required function calls so the LLM has
  // access to them from the start (avoids relying on the LLM to call install_skills).
  if (requiredFunctions.length > 0) {
    try {
      const [publishedSkills, userAllowedSkillIds] = await Promise.all([
        skillService.getPublishedSkills(),
        getAllowedSkills(userId)
      ]);
      const isWildcard = userAllowedSkillIds.includes('*');
      const requiredToolNames = new Set(requiredFunctions.map(rf => rf.functionName));

      // Find skills that contain any of the required tools and are allowed
      const skillIdsToInstall: string[] = [];
      for (const skill of publishedSkills) {
        const hasRequiredTool = skill.toolNames?.some(t => requiredToolNames.has(t));
        const isAllowed = isWildcard || userAllowedSkillIds.includes(skill.skillId);
        if (hasRequiredTool && isAllowed) {
          skillIdsToInstall.push(skill.skillId);
        }
      }

      // Also check if any required tools are "other" (not in any published skill)
      const adminToolNames = new Set(agentModeService.getAdminToolNames());
      const allSkillToolNames = new Set(publishedSkills.flatMap(s => s.toolNames || []));
      const hasOtherTools = [...requiredToolNames].some(t => !allSkillToolNames.has(t) && !adminToolNames.has(t));
      if (hasOtherTools && (isWildcard || userAllowedSkillIds.includes('__other_skills__'))) {
        skillIdsToInstall.push('__other_skills__');
      }

      // Auto-install admin tools if any required function calls are admin-only tools
      const hasAdminTools = [...requiredToolNames].some(t => adminToolNames.has(t));
      if (hasAdminTools) {
        skillIdsToInstall.push('__admin_tools__');
      }

      if (skillIdsToInstall.length > 0) {
        await agentModeService.installSkills(skillIdsToInstall, userId, sessionId);
      }
    } catch (error) {
      console.error('AgentMode runVerifiedChat: Error auto-installing skills for required functions:', error);
    }
  }

  // When the agent calls a bravesearch MCP tool, it satisfies the equivalent built-in
  // search_web requirement (but not vice-versa: explicit bravesearch_* requirements stay specific).
  const FUNCTION_CALL_SATISFIES: Record<string, string[]> = {
    'search_web': ['bravesearch_brave_web_search', 'bravesearch_brave_news_search'],
  };
  // Count how many times a required function was called, including via accepted aliases.
  const countCallsForRequirement = (functionName: string, calls: string[]): number => {
    const aliases = FUNCTION_CALL_SATISFIES[functionName] ?? [];
    return calls.filter(c => c === functionName || aliases.includes(c)).length;
  };

  // Track remaining keywords and function calls
  let remainingKeywords = [...keywords];
  const remainingFunctionCallCounts: Record<string, number> = {};
  requiredFunctions.forEach((reqFunc) => {
    remainingFunctionCallCounts[reqFunc.functionName] = reqFunc.minCount;
  });

  // Track all function calls across attempts (raw names, used for alias-aware evaluation)
  const allActualFunctionCallsForReporting: string[] = [];

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
          // NOTE: Only missing function calls are requested on retry. If a search tool
          // (e.g. search_web) was already called, it won't be re-requested even if the
          // output was insufficient. Avoid adding search tools to requiredFunctionCalls
          // unless a minimum call count is truly needed — the LLM calls them organically.
          const keywordText = remainingKeywords.length > 0
            ? `include these keywords: ${remainingKeywords.join(', ')}`
            : '';
          const functionCallText = requiredFunctions
            .filter(reqFunc => {
              const currentCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
              return currentCount < reqFunc.minCount;
            })
            .map(reqFunc => {
              const currentCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
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

      // Keep original names so bravesearch_* requirements remain trackable
      allActualFunctionCallsForReporting.push(...actualFunctionCalls);

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
          const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
          if (actualCount >= reqFunc.minCount) {
            functionCallMatches.push(reqFunc.functionName);
          } else {
            functionCallMisses.push(reqFunc.functionName);
          }
        });
      }

      // Check if all requirements are met
      const allKeywordsMet = remainingKeywords.length === 0;
      const allFunctionCallsMet = requiredFunctions.every(reqFunc => {
        return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount;
      });
      const allRequirementsMet = (!workPlan || workPlanCompleted) && allKeywordsMet && allFunctionCallsMet;

      if (allRequirementsMet) {
        // Build final function status
        const functionStatus = requiredFunctions.map((reqFunc) => {
          const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
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
            return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount;
          }).map(reqFunc => reqFunc.functionName),
          functionCallMisses: requiredFunctions.filter(reqFunc => {
            return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) < reqFunc.minCount;
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
      if (!isTransientLLMError(error) || isContextLimitError(error)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw error;
      }
    }
  }

  // If we get here, we've exhausted all attempts
  const functionStatus = requiredFunctions.map((reqFunc) => {
    const actualCount = countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting);
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
      return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) >= reqFunc.minCount;
    }).map(reqFunc => reqFunc.functionName),
    functionCallMisses: requiredFunctions.filter(reqFunc => {
      return countCallsForRequirement(reqFunc.functionName, allActualFunctionCallsForReporting) < reqFunc.minCount;
    }).map(reqFunc => reqFunc.functionName),
    functionStatus,
    attempts: attempt,
    workPlanCompleted: false
  };
}

// Common function to run a scheduled chat (used by both test and actual execution)
export async function runScheduledChat(
  schedule: any,
  userId: string,
  isTest: boolean = false,
  preGeneratedRunId?: string
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
  summary?: string;
}> {
  const now = new Date();
  let sessionId: string = '';
  let generatedSummary: string | undefined;

  try {
    // Guard against orphaned schedules whose owning user no longer exists.
    // Without this, downstream calls (e.g. token-usage checks) throw
    // "User not found: <userId>" on every run, repeatedly alerting oncall.
    // Auto-pause the schedule so it stops firing, and return gracefully.
    const scheduleOwner = await userDb.getUserById(userId);
    if (!scheduleOwner) {
      console.warn(
        `Scheduled chat "${schedule.scheduleName}" (${schedule.scheduleId}) references a missing user ${userId}. Auto-pausing schedule.`
      );

      if (!isTest) {
        try {
          await scheduleDb.updateSchedule(schedule.scheduleId, {
            status: 'paused',
            updatedAt: new Date().toISOString(),
          });
        } catch (pauseError) {
          console.error(
            `Failed to auto-pause orphaned schedule ${schedule.scheduleId}:`,
            pauseError
          );
        }
      }

      const orphanedUserResult = {
        scheduleId: schedule.scheduleId,
        runId: preGeneratedRunId || require('uuid').v4(),
        status: 'failure' as const,
        passed: false,
        actualResponse: `Scheduled chat paused: the owning user (${userId}) no longer exists.`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: schedule.keywords || [],
        functionCallMatches: [],
        functionCallMisses: schedule.requiredFunctionCalls || [],
        executionTime: 0,
        sessionId: '',
        attempt: 0,
        createdAt: new Date().toISOString(),
      };

      try {
        await scheduleDb.addRunResult(schedule.scheduleId, orphanedUserResult);
      } catch (saveError) {
        console.error('Error saving orphaned-user run result:', saveError);
      }

      return orphanedUserResult;
    }

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

      // If wildcard is present, all function calls are allowed — skip filtering
      const allAllowed = allowedFunctionCalls.includes("*");

      // Foundation tools are always allowed regardless of subscription
      const foundationTools = agentModeService.getFoundationToolNames();
      // Admin tools are allowed for admin users
      const { userDb } = await import('../services/db');
      const scheduleUser = await userDb.getUserById(userId);
      const adminToolNames = new Set(agentModeService.getAdminToolNames());
      const isAdminUser = scheduleUser?.isAdmin || false;
      const disallowedFunctions = allAllowed ? [] : expectedFunctionCalls.filter((funcName: string) =>
        !allowedFunctionCalls.includes(funcName) && !foundationTools.has(funcName) && !(isAdminUser && adminToolNames.has(funcName))
      );

      if (disallowedFunctions.length > 0) {
        const emailNotifications = schedule.emailNotifications || [];
        
        // Send error email instead of running
        const { emailService } = await import('../services/emailService');
        await emailService.sendScheduledChatErrorEmail(
          emailNotifications.length > 0 ? emailNotifications : (scheduleUser?.email ? [scheduleUser.email] : []),
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

    // Check token usage limits before creating the session
    const usageStatus = await checkTokenUsage(userId);
    if (!usageStatus.allowed) {
      const emailNotifications = schedule.emailNotifications || [];
      let notifyEmails: string[] = emailNotifications;
      if (notifyEmails.length === 0) {
        const { userDb: tokenUserDb } = await import('../services/db');
        const tokenUser = await tokenUserDb.getUserById(userId);
        if (tokenUser?.email) notifyEmails = [tokenUser.email];
      }

      if (notifyEmails.length > 0) {
        const { emailService } = await import('../services/emailService');
        await emailService.sendScheduledChatTokenLimitEmail(
          notifyEmails,
          schedule.scheduleName,
          schedule.scheduleId,
          usageStatus
        );
      }

      const tokenLimitResult = {
        scheduleId: schedule.scheduleId,
        runId: require('uuid').v4(),
        status: 'failure' as const,
        passed: false,
        actualResponse: `Scheduled chat cannot run: Monthly token limit reached (${usageStatus.used?.toLocaleString() ?? 0} / ${usageStatus.allowance?.toLocaleString() ?? 0} tokens used).`,
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

      try {
        await scheduleDb.addRunResult(schedule.scheduleId, tokenLimitResult);
      } catch (error) {
        console.error('Error saving token limit run result:', error);
      }

      return tokenLimitResult;
    }

    // Create a session for the run
    const sessionTitle = isTest ? `Test: ${schedule.scheduleName}` : `Scheduled: ${schedule.scheduleName}`;
    const pageIdentifier = `${sessionTitle}|scheduleId:${schedule.scheduleId}`;
    const testSession = await chatbotDb.createChatSession(
      userId,
      undefined,
      "agent",
      pageIdentifier,
      undefined,
      undefined,
      undefined,
      schedule.emailCampaignTaskId,
      'scheduled' // sessionType
    );
    sessionId = testSession.sessionId;

    // Set the session title to the schedule name
    await chatbotDb.updateSessionTitle(sessionId, sessionTitle);

    // Update the session with the selected model from the schedule
    const defaultModel = await agentModeService.getScheduledChatsDefaultModel();
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
      schedule.variableValues || {},
      scheduleVariables
    );

    // Extract file attachments from file-type variables
    const fileAttachments = extractFileAttachmentsFromVariables(
      scheduleVariables,
      schedule.variableValues || {}
    ).map(f => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      mimetype: f.mimetype,
    }));

    // Run verified chat
    const result = await runVerifiedChat({
      sessionId,
      userId,
      startingMessage: resolvedStartingMessage,
      keywords: expectedKeywords,
      requiredFunctions,
      maxAttempts: 20,
      attachments: fileAttachments,
      llmModel: schedule.llmModel || defaultModel
    });

    // Generate a 2-3 word summary and update the session title
    try {
      const summary = await agentModeService.generateScheduledChatSummary(resolvedStartingMessage, result.content);
      if (summary) {
        generatedSummary = summary;
        const summaryTitle = `${sessionTitle} — ${summary}`;
        await chatbotDb.updateSessionTitle(sessionId, summaryTitle);
      }
    } catch (err) {
      console.error('AgentMode: Failed to update session title with summary:', err);
    }

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
      runId: preGeneratedRunId || require('uuid').v4(),
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
      createdAt: new Date().toISOString(),
      summary: generatedSummary
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

    // Self-improve: when enabled, run a reflection turn in the same session that may
    // rewrite the schedule's prompt so future runs do better. Runs on test runs too so
    // it's easy to try out. Best-effort — never fails the run.
    if (schedule.selfImprove === true) {
      try {
        await runScheduleSelfImprovement({
          schedule,
          sessionId,
          userId,
          llmModel: modelToUse,
        });
      } catch (err) {
        console.error('AgentMode: Self-improve reflection failed:', err);
      }
    }

    // Send oncall alert and Notion ticket if scheduled chat failed validation (not for test runs)
    if (!finalResult.passed && !isTest) {
      sendAgentModeOncallAlert({
        subject: `Scheduled Chat Failed: ${schedule.scheduleName}`,
        message: `Scheduled chat "${schedule.scheduleName}" completed but failed validation.\n\nMissing function calls: ${finalResult.functionCallMisses.join(', ') || 'none'}\nKeyword misses: ${finalResult.keywordMisses.join(', ') || 'none'}`,
        sessionId,
        context: {
          'Schedule ID': schedule.scheduleId,
          'Schedule Name': schedule.scheduleName,
          'User ID': userId,
          'Attempts': finalResult.attempt,
          'Execution Time (ms)': finalResult.executionTime,
          'Function Call Misses': finalResult.functionCallMisses.join(', ') || 'none',
          'Function Call Matches': finalResult.functionCallMatches.join(', ') || 'none',
          'Keyword Misses': finalResult.keywordMisses.join(', ') || 'none',
          'Timestamp': finalResult.createdAt
        }
      }).catch(err => console.error('Failed to send oncall alert for scheduled chat failure:', err));
      createOncallItem({
        title: `Scheduled Chat Failed: ${schedule.scheduleName}`,
        description: `Scheduled chat "${schedule.scheduleName}" completed but failed validation.\n\nMissing function calls: ${finalResult.functionCallMisses.join(', ') || 'none'}\nKeyword misses: ${finalResult.keywordMisses.join(', ') || 'none'}`,
        additionalTags: ['Scheduled Chat'],
        context: {
          'Schedule ID': schedule.scheduleId,
          'User ID': userId,
          'Session ID': sessionId,
          'Attempts': finalResult.attempt,
        }
      }).catch(err => console.error('Failed to create Notion item for scheduled chat failure:', err));
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
      originalMessage: (error as any)?.originalMessage || null,
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Unknown'
    });

    // Save error to session record if session was created
    if (sessionId) {
      // Persist partial token usage from messages accumulated before the error
      if ((error as any)?.partialUsageMessages?.length) {
        try {
          await chatbotDb.addMessagesToSession(sessionId, (error as any).partialUsageMessages);
          console.log(`Scheduled chat: Persisted partial usage from ${(error as any).partialUsageMessages.length} messages for failed session ${sessionId}`);
        } catch (usageErr) {
          console.error('Failed to persist partial usage for scheduled chat:', usageErr);
        }
      }

      try {
        await chatbotDb.updateSessionError(
          sessionId,
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined
        );
      } catch (saveError) {
        console.error('Failed to save error to session:', saveError);
      }
    }

    // Build error result
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorResult = {
      scheduleId: schedule.scheduleId,
      runId: preGeneratedRunId || require('uuid').v4(),
      status: 'failure' as const,
      passed: false,
      actualResponse: `Error during execution: ${errorMessage}`,
      actualFunctionCalls: [],
      keywordMatches: [],
      keywordMisses: schedule.keywords || [],
      functionCallMatches: [],
      functionCallMisses: schedule.requiredFunctionCalls || [],
      executionTime: Date.now() - now.getTime(),
      sessionId: sessionId || '',
      attempt: 0,
      createdAt: new Date().toISOString()
    };

    // Save the error result to database (without actualResponse to save space)
    const resultToStore = { ...errorResult };
    delete (resultToStore as any).actualResponse;
    try {
      await scheduleDb.addRunResult(schedule.scheduleId, resultToStore);
    } catch (saveError) {
      console.error('Error saving error run result:', saveError);
      // Continue even if saving fails - we still want to return the result
    }

    // Send oncall alert and Notion ticket for scheduled chat exception (always, including test runs)
    const originalMessage = (error as any)?.originalMessage;
    sendAgentModeOncallAlert({
      subject: `Scheduled Chat Error: ${schedule.scheduleName}`,
      message: `Scheduled chat "${schedule.scheduleName}" threw an exception during execution.\n\nError: ${errorMessage}`,
      sessionId: sessionId || undefined,
      context: {
        'Schedule ID': schedule.scheduleId,
        'Schedule Name': schedule.scheduleName,
        'User ID': userId,
        'Is Test Run': isTest ? 'Yes' : 'No',
        'Error Message': errorMessage,
        ...(originalMessage ? { 'Original Error (Bedrock/API)': originalMessage } : {}),
        'Error Stack': error instanceof Error ? (error.stack || 'No stack trace') : 'N/A',
        'Execution Time (ms)': errorResult.executionTime,
        'Timestamp': errorResult.createdAt
      }
    }).catch(err => console.error('Failed to send oncall alert for scheduled chat error:', err));
    createOncallItem({
      title: `Scheduled Chat Error: ${schedule.scheduleName}`,
      description: `Scheduled chat "${schedule.scheduleName}" threw an exception during execution.\n\nError: ${errorMessage}${originalMessage ? `\n\nOriginal API error: ${originalMessage}` : ''}`,
      additionalTags: ['Scheduled Chat'],
      context: {
        'Schedule ID': schedule.scheduleId,
        'User ID': userId,
        'Session ID': sessionId || 'N/A',
        'Is Test Run': isTest ? 'Yes' : 'No',
        'Error Message': errorMessage,
        ...(originalMessage ? { 'Original Error (Bedrock/API)': originalMessage } : {}),
      }
    }).catch(err => console.error('Failed to create Notion item for scheduled chat error:', err));

    // Return error result for error reporting
    return errorResult;
  }
}

// Run one reflection turn (a real Emma turn in the same session, with full tool access)
// after a scheduled chat completes. Emma reviews how the run went, and using anything it
// can access, decides whether the schedule's prompt could be improved for future runs.
// This is just another message to Emma — if it decides to improve the prompt, it calls
// the same manage_scheduled_chat tool a user would, which records a revision automatically.
export async function runScheduleSelfImprovement(params: {
  schedule: any;
  sessionId: string;
  userId: string;
  llmModel: string;
}): Promise<void> {
  const { schedule, sessionId, userId, llmModel } = params;

  const reflectionPrompt = [
    'This was an automated scheduled run. Now reflect on it to help FUTURE runs of this same schedule do better.',
    '',
    'Review how this run went. You may use any tools or data you can access (the results of this run, past runs, the account\'s current state, etc.) to find concrete, actionable opportunities to improve.',
    '',
    `Then decide whether this schedule's instruction prompt (its starting_message) should be improved so future runs produce better results. If — and only if — you find a clear improvement, update it now by calling the manage_scheduled_chat tool with action "update" and schedule_id "${schedule.scheduleId}", passing the full improved starting_message.`,
    '',
    'Rules for any improved prompt: keep the same overall goal and any {{variables}} exactly as they are; only refine the wording/instructions to make future runs more reliable. Do not invent new variables. If the current prompt is already good, make no change and simply explain why.',
  ].join('\n');

  await generateSessionResponse(sessionId, reflectionPrompt, userId, llmModel);
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
  // 'suggestions' is emitted after 'complete' (post-processing) — treat as done
  return latestProgress.status !== 'complete' && latestProgress.status !== 'suggestions';
}

// Helper to update a GTM work item's status in the GTM plan
async function updateGtmWorkItemStatus(
  gtmWorkItem: { planId: string; phaseId: string; workItemId: string },
  status: string
): Promise<void> {
  const dynamoClient = new DynamoDB.DocumentClient({
    region: process.env.AWS_REGION || 'us-west-2',
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    }),
  });
  const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

  const result = await dynamoClient.get({ TableName: TABLE_NAME, Key: { planId: gtmWorkItem.planId } }).promise();
  if (!result.Item) return;

  const phases = result.Item.phases || [];
  const phaseIdx = phases.findIndex((p: any) => p.id === gtmWorkItem.phaseId);
  if (phaseIdx === -1) return;

  const items = phases[phaseIdx].workItems || [];
  const itemIdx = items.findIndex((i: any) => i.id === gtmWorkItem.workItemId);
  if (itemIdx === -1) return;

  items[itemIdx] = { ...items[itemIdx], status };
  phases[phaseIdx] = { ...phases[phaseIdx], workItems: items };

  await dynamoClient.update({
    TableName: TABLE_NAME,
    Key: { planId: gtmWorkItem.planId },
    UpdateExpression: 'SET #phases = :phases, #updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#phases': 'phases', '#updatedAt': 'updatedAt' },
    ExpressionAttributeValues: { ':phases': phases, ':updatedAt': new Date().toISOString() },
  }).promise();

  console.log(`GTM work item ${gtmWorkItem.workItemId}: status updated to ${status}`);
}

// Common function to generate AI response for a session
// Always uses worker process to prevent blocking the main event loop
export async function generateSessionResponse(
  sessionId: string,
  userMessage: string,
  userId: string,
  llmModel: string,
  attachments?: any[],
  isInteractiveShare?: boolean,
  pageContext?: { currentUrl?: string; structuredContext?: string; screenshot?: string },
  isDelegatedAccess?: boolean,
  ishareSenderInfo?: { ip?: string; userAgent?: string }
): Promise<{
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
  workPlan?: any;
  skills?: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[];
  backupModelUsed?: boolean;
  originalModel?: string;
  backupModel?: string;
}> {
  // Clear any stale cancel from a previous request on this session
  clearCancel(sessionId);

  // Get session
  const session = await chatbotDb.getChatSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Check message limit before starting a new turn so in-progress writes (e.g. tool
  // system messages) that pushed the count over the limit don't silently drop the
  // final assistant response. The check is intentionally at turn-start so writes during
  // a turn are never blocked mid-flight.
  const currentMessageCount = (await chatbotDb.getMessagesFromMessagesTable(sessionId)).length;
  if (currentMessageCount >= MAX_MESSAGE_SIZE_PER_SESSION) {
    throw new Error(`SESSION_MESSAGE_LIMIT_EXCEEDED: This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`);
  }

  // Process attachments and include URLs in message content for LLM
  let messageContent = userMessage;
  if (attachments && attachments.length > 0) {
    const IMAGE_MIMETYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']);
    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
    const VIDEO_MIMETYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/avi', 'video/x-msvideo']);
    const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv']);
    const attachmentUrls = attachments.map((attachment: any) => {
      const mimetype = (attachment.mimetype || '').toLowerCase();
      const ext = (attachment.filename || '').split('.').pop()?.toLowerCase() || '';
      const isImage = IMAGE_MIMETYPES.has(mimetype) || IMAGE_EXTS.has(ext);
      const isVideo = VIDEO_MIMETYPES.has(mimetype) || VIDEO_EXTS.has(ext);
      let hint: string;
      if (isImage) {
        hint = ' (image — use describe_image tool to analyze)';
      } else if (isVideo) {
        hint = ' (video — use describe_video tool to analyze)';
      } else {
        hint = ' (document — use read_file_content tool to read its contents)';
      }
      return `[${attachment.filename || 'Attachment'}](${attachment.url})${hint}`;
    }).join('\n');
    messageContent = `${userMessage}\n\n**Attached Files:**\n${attachmentUrls}`;
  }

  // For emma-sidebar sessions, append current page URL so the LLM knows user context
  if (pageContext?.currentUrl && session.portalType === 'emma-sidebar') {
    messageContent += `\n\n[Current page: ${pageContext.currentUrl}]`;
  }

  // Create user message object - store processed content with attachments
  const userMessageObj = {
    role: 'user' as const,
    content: userMessage, // Store original user message, not processed content
    timestamp: new Date().toISOString(),
    metadata: {
      portalType: (session.portalType || 'agent') as 'agent',
      timestamp: new Date().toISOString(),
      attachments: attachments || [],
      ...(pageContext?.currentUrl ? { currentUrl: pageContext.currentUrl } : {}),
      ...(isInteractiveShare ? {
        ishareSender: {
          isAnonymous: true as const,
          ...(ishareSenderInfo?.ip ? { ip: ishareSenderInfo.ip } : {}),
          ...(ishareSenderInfo?.userAgent ? { userAgent: ishareSenderInfo.userAgent } : {}),
        }
      } : {})
    }
  };

  // Check if this is the first user message (excluding system message)
  const userMessages = session.messages?.filter(msg => msg.role === 'user') || [];
  const isFirstMessage = userMessages.length === 0;

  // If this is the first message, add system message with version info first
  if (isFirstMessage) {
    try {
      let systemPrompt: string;

      if (session.portalType === 'emma-sidebar') {
        // Emma sidebar uses the Emma system prompt with page context
        systemPrompt = await getEmmaSystemContext();
        if (pageContext?.currentUrl) {
          systemPrompt += `\n\n[Page Context] The user is currently on the page: ${pageContext.currentUrl}. Help them with tasks relevant to this page.`;
        }
        if (pageContext?.structuredContext) {
          try {
            const parsed = JSON.parse(pageContext.structuredContext);
            const contextParts: string[] = [];
            if (parsed.headings?.length) contextParts.push(`Headings: ${parsed.headings.join(', ')}`);
            if (parsed.buttons?.length) contextParts.push(`Buttons: ${parsed.buttons.join(', ')}`);
            if (parsed.inputs?.length) contextParts.push(`Inputs: ${parsed.inputs.map((i: any) => i.label || i.placeholder).filter(Boolean).join(', ')}`);
            if (contextParts.length) {
              systemPrompt += `\n\n[Page UI Elements]\n${contextParts.join('\n')}`;
            }
            // Include page-specific tool context so Emma knows which tools are relevant
            if (parsed.availableTools?.length) {
              systemPrompt += `\n\n[Available Tools for This Page]\nThe following tools are most relevant to the user's current page: ${parsed.availableTools.join(', ')}. Prefer these tools when responding to user requests on this page.`;
            }
            if (parsed.suggestedActions?.length) {
              systemPrompt += `\n[Suggested Actions]\nCommon actions the user might want on this page:\n${parsed.suggestedActions.map((a: string) => `- ${a}`).join('\n')}`;
            }
          } catch { /* ignore parse errors */ }
        }
      } else {
        // Regular Agent Mode system prompt
        systemPrompt = await agentModeService.getMarketingSystemPrompt();

        // For scheduled chat sessions, inject schedule context so Emma can reference/update the schedule
        if (session.sessionType === 'scheduled' && session.pageIdentifier) {
          const scheduleIdMatch = session.pageIdentifier.match(/scheduleId:([a-f0-9-]+)/);
          if (scheduleIdMatch) {
            systemPrompt += `\n\n[Schedule Context] This session was created by a scheduled chat (scheduleId: ${scheduleIdMatch[1]}). If the user asks to update this schedule, first call list_scheduled_chats to get the current schedule details, then use manage_scheduled_chat with action "update" and the schedule_id. You can do partial updates — only include the fields you want to change.`;
          }
          systemPrompt += `\n\n[AUTOMATED UNATTENDED EXECUTION]\nThis is a scheduled, automated run. No human is present. You MUST:\n- Execute the complete task in a single run without stopping to ask for confirmation, approval, or clarification at any point.\n- If the task specifies a volume or range (e.g. "send 30-40 connection requests", "post 5 times"), treat the FULL stated amount as your target for this session. Do NOT split into sub-batches and pause between them.\n- Never ask "should I continue?" or "shall I proceed with the next batch?" — just execute continuously until the stated goal is reached.\n- If you encounter an unrecoverable error, stop and report it in your final message. Otherwise, keep going.`;
        }

        // For Slack sessions (including scheduled scans), inject team identity context so Emma
        // knows who is on the team and can distinguish teammates from external parties.
        if ((session.pageIdentifier || '').toLowerCase().includes('slack')) {
          systemPrompt += `\n\n[Slack Context] You are part of the AgentWeb team.\n${ABOUT_AGENTWEB_TEAM}\nMessages in this Slack thread are prefixed with the sender's name (e.g. "Rui Wang: message text"). When a team member asks you to help reply, you are drafting a response FROM that team member TO the other person in the thread — not answering the team member as if they were asking you a direct question. Always respond in the voice of the team member addressing their conversation partner.`;
        }
      }

      const systemPromptHash = require('crypto').createHash('md5').update(systemPrompt).digest('hex').substring(0, 8);

      // Add system message with version info (hash only in metadata)
      const systemMessage = {
        role: 'system' as const,
        content: systemPrompt,
        metadata: {
          timestamp: new Date().toISOString(),
          portalType: (session.portalType || 'agent') as 'agent',
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

  // If this is the first message, generate session title (skip for scheduled sessions which already have a title)
  if (isFirstMessage && session.sessionType !== 'scheduled') {
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

  // If this session is linked to a GTM work item, update status to agent_in_progress
  if (updatedSession.gtmWorkItem) {
    try {
      await updateGtmWorkItemStatus(updatedSession.gtmWorkItem, 'agent_in_progress');
    } catch (error) {
      console.error('GTM status sync: Failed to set agent_in_progress:', error);
    }
  }

  // Compute tools to exclude based on page context (e.g. get_visual_context only on visual pages)
  let excludeTools: string[] | undefined;
  if (session.portalType === 'emma-sidebar') {
    // Only include get_visual_context on pages where seeing the rendered UI is useful
    const visualPages = new Set(['brand-guidelines', 'social-posts', 'images', 'videos', 'templates', 'newsletter', 'blog']);
    const urlPath = (pageContext?.currentUrl || '').replace(/^\//, '');
    const page = urlPath.split('/')[0].split('?')[0];
    if (!visualPages.has(page)) {
      excludeTools = ['get_visual_context'];
    }
  } else {
    // Non-sidebar sessions (agent mode, scheduled chats) never need visual context
    excludeTools = ['get_visual_context'];
  }

  // Upload screenshot to S3 if provided (emma-sidebar sessions only)
  let screenshotUrl: string | undefined;
  if (pageContext?.screenshot) {
    const result = await uploadScreenshotToS3(pageContext.screenshot, userId);
    if (result) screenshotUrl = result.url;
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
      mockMode: false,
      isInteractiveShare: isInteractiveShare || false,
      isDelegatedAccess,
      excludeTools,
      screenshotUrl
    },
    (progress) => {
      // Emit progress updates via SSE
      emitProgress(sessionId, progress);
    }
  );

  // If the user clicked Stop, discard the response entirely — don't persist anything.
  // The user message was already saved before the LLM call; the assistant response is dropped
  // so a page reload shows the user message with no ghost response from a cancelled turn.
  if (response.cancelled) {
    clearCancel(sessionId);
  } else {
    // Add all response messages to session (includes assistant responses and tool calls).
    // Strip base64 image data URIs from tool result content before persisting — they are
    // ~300KB each and would exceed the DynamoDB 400KB item limit.
    if (response.responseMessages.length > 0) {
      const persistableMessages = response.responseMessages.map((msg: any) => {
        if (msg.role === 'tool' && Array.isArray(msg.content)) {
          const strippedContent = msg.content
            .filter((item: any) => item.type !== 'image_url')
            .map((item: any) => item.text ?? item)
            .join('\n') || '[screenshot captured]';
          return { ...msg, content: strippedContent };
        }
        return msg;
      });
      // Wrap in try/catch so a DynamoDB save failure does not discard the generated response.
      // The caller (e.g. Slack handler) still receives response.content and can deliver it to the user.
      try {
        await chatbotDb.addMessagesToSession(sessionId, persistableMessages);
      } catch (saveError) {
        console.error('AgentMode: Failed to persist response messages to session — response will still be returned to caller:', saveError);
      }
    }

    // If this session is linked to a GTM work item, update status to pending_review after AI responds
    if (updatedSession.gtmWorkItem) {
      try {
        await updateGtmWorkItemStatus(updatedSession.gtmWorkItem, 'pending_review');
      } catch (error) {
        console.error('GTM status sync: Failed to set pending_review:', error);
      }
    }
  }

  // Get the updated session to include workPlan if it was modified
  const finalSession = await chatbotDb.getChatSession(sessionId);

  // Build skills list with installed status (includes virtual other_skills), filtered by subscription
  let skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[]; visibility?: string }[] = [];
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
const calculateNextRunTime = (frequency: string, fromDate: Date, frequencyIntervalDays?: number): Date => {
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
    case 'every_n_days': {
      const interval = frequencyIntervalDays && frequencyIntervalDays >= 1 ? frequencyIntervalDays : 1;
      nextRun.setUTCDate(nextRun.getUTCDate() + interval);
      // Preserve the time from fromDate

      // If still in the past, keep adding intervals until we're in the future
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + interval);
      }
      break;
    }
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
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 1000); // Max 1000 per request (search uses 1000)
      const portalType = (req.query.portalType as string) === 'emma-sidebar' ? 'emma-sidebar' as const : 'agent' as const;
      const pageIdentifier = req.query.pageIdentifier as string | undefined;
      const search = req.query.search as string | undefined;

      // Get sessions with pagination — messages are stripped here and replaced with
      // a lightweight previewText so the list payload stays small (the full message
      // history is loaded on-demand when a session is actually opened).
      const result = await chatbotDb.getUserSessions(user.userId, portalType, limit, true, lastEvaluatedKey, pageIdentifier, search);

      const listSessions = result.sessions.map(session => {
        // Derive previewText from first user message if not already stored
        const previewText: string | null = (session as any).previewText ||
          session.messages?.find((m: any) => m.role === 'user')?.content?.slice(0, 200) || null;
        const { messages: _, ...sessionWithoutMessages } = session as any;
        return { ...sessionWithoutMessages, messages: [], previewText };
      });

      res.json({
        sessions: listSessions,
        lastEvaluatedKey: result.lastEvaluatedKey,
        hasMore: !!result.lastEvaluatedKey
      });

      // Fire-and-forget: update stale/missing session summaries in background
      // so they're available on the next load (cache-aware — skips up-to-date ones)
      for (const session of result.sessions) {
        const messageCount = session.messageCount ?? session.messages?.length ?? 0;
        const needsSummary = messageCount > 0 && (
          !session.sessionSummary ||
          session.sessionSummary.evaluatedMessageIndex < messageCount
        );
        if (needsSummary) {
          summarizeSessionIfNeeded(session).catch((err) => {
            console.error(`AgentMode: Background summarization failed for ${session.sessionId}:`, err);
          });
        }
      }
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
      // Use reports model for report_generation sessions, customer support model for emma-sidebar, otherwise use default model
      let modelToUse: string;
      if (finalSessionType === 'report_generation') {
        modelToUse = await agentModeService.getReportsModel();
      } else if (portalType === 'emma-sidebar') {
        modelToUse = await agentModeService.getCustomerSupportDefaultModel();
      } else {
        modelToUse = await agentModeService.getDefaultModel();
      }
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
      let skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[]; visibility?: string }[] = [];
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
      // Foundation tools are always included regardless of subscription
      let toolsToReturn = tools;
      if (!user.isAdmin) {
        const { getAllowedFunctionCalls, filterFunctionCalls } = await import('../services/subscriptionService');
        const allowedFunctionCalls = await getAllowedFunctionCalls(user.userId);
        // getAllowedFunctionCalls now always returns an array (never null)
        // Ensure foundation tools are always allowed
        const foundationTools = agentModeService.getFoundationToolNames();
        foundationTools.forEach(name => {
          if (!allowedFunctionCalls.includes(name)) {
            allowedFunctionCalls.push(name);
          }
        });
        toolsToReturn = filterFunctionCalls(tools, allowedFunctionCalls);
      }

      // Extract function names and descriptions
      let functionCalls = toolsToReturn
        .filter((tool: any) => tool?.type === 'function' && tool?.function?.name)
        .map((tool: any) => ({
          name: tool.function.name,
          description: tool.function.description || ''
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
      const { sessionId, llmModel, attachments, currentUrl, structuredContext, screenshot, audioInput } = req.body;
      let { userMessage } = req.body;

      // If the request contains audio, transcribe it to text first
      if (audioInput?.data && !userMessage) {
        try {
          userMessage = await transcribeSpeech(audioInput.data);
        } catch (err) {
          console.error('Voice: STT transcription failed:', err);
          return res.status(422).json({ error: 'Failed to transcribe audio. Please try again or type your message.' });
        }
      }

      if (!sessionId || !userMessage) {
        return res.status(400).json({ error: 'Session ID and user message are required' });
      }

      // Reject concurrent requests for the same session (synchronous check before any await)
      if (activeSessionGenerations.has(sessionId)) {
        return res.status(409).json({
          error: 'Session is busy',
          message: 'A response is already being generated for this session. Please wait.',
          code: 'SESSION_BUSY',
        });
      }
      activeSessionGenerations.add(sessionId);

      try {

      // Check token usage limits
      const usageStatus = await checkTokenUsage(user.userId);
      if (!usageStatus.allowed) {
        return res.status(429).json({
          error: 'Monthly token limit reached. Please contact support or upgrade your plan.',
          tokenUsage: usageStatus,
        });
      }

      // Get session
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Clear old progress store (but keep active connections)
      // Don't call cleanupProgress here as it removes active SSE connections
      progressStore.delete(sessionId);

      // Cancel generation immediately when the client disconnects (e.g. Stop button aborts the fetch).
      // This fires before /stop reaches the backend and ensures the worker receives the cancel signal
      // while it still has a live sessionToRequestId mapping. Also emit SSE 'complete' so the frontend
      // SSE stream clears the "Thinking..." state on reload instead of showing it indefinitely.
      req.on('close', () => {
        if (!res.headersSent) {
          console.log(`AgentMode: Client disconnected for session ${sessionId} — signalling cancellation`);
          requestCancel(sessionId);
          generateMarketingResponseWorkerService.cancelSession(sessionId);
          emitProgress(sessionId, { iteration: 0, status: 'complete' });
          progressStore.delete(sessionId);
        }
      });

      // Use llmModel from request, session, or default
      const modelToUse = llmModel || session.llmModel || agentModeService.default_model;

      // Build page context for emma-sidebar sessions
      const pageContext = session.portalType === 'emma-sidebar'
        ? { currentUrl, structuredContext, screenshot }
        : undefined;

      // Check if this request is from admin delegated access (per-request, from JWT)
      const authReqForGenerate = req as any;
      const isDelegatedAccessForMessage = authReqForGenerate.delegateInfo?.isDelegated === true;

      // Generate AI response using common function (wrapped in wall-clock timeout
      // so the activeSessionGenerations lock always releases even if generation hangs).
      // Use session.userId (the account owner) — not user.userId (the requester) — so that
      // tool calls (e.g. get_lead_lists) query the correct user's data in delegated sessions.
      const response = await withGenerationTimeout(
        generateSessionResponse(
          sessionId,
          userMessage,
          session.userId,
          modelToUse,
          attachments,
          undefined, // isInteractiveShare
          pageContext,
          isDelegatedAccessForMessage
        ),
        sessionId
      );

      // Clear progress store after completion (keep connections open for future messages)
      progressStore.delete(sessionId);

      // Compute page invalidations for emma-sidebar sessions so the frontend
      // can refresh the underlying page after a mutating tool call.
      let invalidations: string[] | undefined;
      if (session.portalType === 'emma-sidebar' && response.toolCalls?.length) {
        const PAGE_INVALIDATION_MAP: Record<string, string[]> = {
          'update_brand_guidelines': ['brand-guidelines'],
          'update_market_strategy': ['market-strategy'],
          'update_gtm_plan': ['gtm-plan'],
          'add_gtm_phase': ['gtm-plan'],
          'add_gtm_work_items': ['gtm-plan'],
          'update_gtm_work_item': ['gtm-plan'],
          'update_gtm_phase': ['gtm-plan'],
          'delete_gtm_items': ['gtm-plan'],
          'create_gtm_plan': ['gtm-plan'],
          'update_lead': ['crm'],
          'create_lead_list': ['crm'],
          'add_leads_to_list': ['crm'],
          'delete_leads': ['crm'],
          'update_lead_status': ['crm'],
          'update_book_content': ['books'],
          'create_book': ['books'],
          'generate_book_content': ['books'],
          'create_html_from_template': ['templates'],
          'update_html_file': ['templates'],
          'create_knowledge_base': ['knowledge-base'],
          'update_knowledge_base_file': ['knowledge-base'],
          'generate_image': ['images'],
          'generate_video': ['videos'],
        };
        const all = [...new Set(
          response.toolCalls
            .filter((tc: any) => !tc.error)
            .flatMap((tc: any) => PAGE_INVALIDATION_MAP[tc.name] || [])
        )];
        if (all.length > 0) invalidations = all;
      }

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills,
        ...(invalidations ? { invalidations } : {}),
        ...(response.backupModelUsed ? { backupModelUsed: true, originalModel: response.originalModel, backupModel: response.backupModel } : {})
      });
      } finally {
        activeSessionGenerations.delete(sessionId);
      }
    } catch (error) {
      console.error('AgentMode: Generate response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const sessionId = req.body?.sessionId;
      if (sessionId) {
        emitProgress(sessionId, { iteration: 0, status: 'complete' });
        progressStore.delete(sessionId);
      }

      // Persist partial token usage from messages accumulated before the error.
      // This ensures we track costs even when generation fails mid-stream.
      if (sessionId && (error as any)?.partialUsageMessages?.length) {
        try {
          await chatbotDb.addMessagesToSession(sessionId, (error as any).partialUsageMessages);
          console.log(`AgentMode: Persisted partial usage from ${(error as any).partialUsageMessages.length} messages for failed session ${sessionId}`);
        } catch (usageErr) {
          console.error('AgentMode: Failed to persist partial usage on error:', usageErr);
        }
      }

      // Persist an error message to the session so the user sees feedback on reload.
      // Skip for session-limit errors (user message wasn't saved either).
      // Use the diagnosis agent for a context-aware message when possible.
      let diagnosticContent: string | null = null;
      if (sessionId && !(error instanceof Error && isSessionLimitError(error))) {
        // Skip diagnosis for context-limit errors (they have specific handling below).
        // Worker-shutdown errors do NOT skip — they leave an orphaned user message and need feedback.
        if (!(error instanceof Error && isContextLimitError(error))) {
          if (error instanceof Error && isWorkerShutdownError(error)) {
            diagnosticContent = 'The server restarted while processing your request. Please send your message again.';
          } else {
            const userMessage = req.body?.userMessage || '';
            diagnosticContent = await getDiagnosticErrorMessage(error, sessionId, userMessage);
          }
        }

        const errorAssistantMessage: ChatMessage = {
          role: 'assistant',
          content: diagnosticContent || 'I encountered an error processing your request. Please try sending your message again.',
          timestamp: new Date().toISOString(),
          metadata: {
            timestamp: new Date().toISOString(),
            isErrorMessage: true,
            ...(diagnosticContent ? { isDiagnosticMessage: true } : {}),
          },
        };
        await chatbotDb.addMessageToSession(sessionId, errorAssistantMessage).catch(err => {
          console.error('AgentMode: Failed to persist error message to session:', err);
        });
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

        if (isWorkerShutdownError(error)) {
          res.status(503).json({
            error: 'Server is restarting',
            message: 'The server is restarting. Please try again in a moment.',
            code: 'SERVER_RESTARTING',
            suggestion: 'wait_and_retry'
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

          autoReportContextLimitToNotion(sessionId, user?.email, user?.userId, llmModel, session)
            .catch(err => console.error('autoReportContextLimitToNotion failed:', err));

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

        if (error.message.includes('Generation timed out')) {
          res.status(504).json({
            error: 'Generation timed out',
            message: 'The response took too long to generate. Please try again — your session is still active.',
            code: 'GENERATION_TIMEOUT',
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
        const originalMessageForAlert = (error as any)?.originalMessage;
        sendAgentModeOncallAlert({
          subject: 'Agent Mode: Unknown Error in Generate Response',
          message: `An unknown error occurred while generating a response in Agent Mode.\n\nError: ${originalMessageForAlert || error.message || 'Unknown error'}`,
          sessionId,
          context: {
            'Error Message': error.message || 'Unknown error',
            'Original Error': originalMessageForAlert || 'Not available',
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

      res.status(500).json({
        error: 'Failed to generate response',
        ...(diagnosticContent ? { diagnosticMessage: diagnosticContent } : {}),
      });
    }
  },

  async getSupportedModels(req: Request, res: Response) {
    try {
      const { user } = await getUserFromToken(req);
      const models = await agentModeService.getSupportedModels(user?.isAdmin === true);
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get supported models error:', error);
      res.status(500).json({ error: 'Failed to get supported models' });
    }
  },

  async getReportsModelOptions(req: Request, res: Response) {
    try {
      const { user } = await getUserFromToken(req);
      const models = await agentModeService.getReportsModelOptions(user?.isAdmin === true);
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get reports model options error:', error);
      res.status(500).json({ error: 'Failed to get reports model options' });
    }
  },

  async getVisionModelOptions(req: Request, res: Response) {
    try {
      const { user } = await getUserFromToken(req);
      const models = await agentModeService.getVisionModelOptions(user?.isAdmin === true);
      res.json(models);
    } catch (error) {
      console.error('AgentMode: Get vision model options error:', error);
      res.status(500).json({ error: 'Failed to get vision model options' });
    }
  },

  async getCustomerSupportDefaultModel(req: Request, res: Response) {
    try {
      const model = await agentModeService.getCustomerSupportDefaultModel();
      res.json({ model });
    } catch (error) {
      console.error('AgentMode: Get customer support default model error:', error);
      res.status(500).json({ error: 'Failed to get customer support default model' });
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
      const { sessionId, expirationDays: rawExpirationDays } = req.body;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Validate expirationDays (default 7, max 365)
      const expirationDays = rawExpirationDays != null ? Number(rawExpirationDays) : 7;
      if (!Number.isFinite(expirationDays) || expirationDays < 1 || expirationDays > 365) {
        return res.status(400).json({ error: 'Expiration must be between 1 and 365 days' });
      }

      // Use the common function to create or reuse interactive share
      const conversableUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId, expirationDays);

      // Extract the token from the URL for backward compatibility
      const urlParams = new URL(conversableUrl).searchParams;
      const conversableToken = urlParams.get('conversable') || '';

      const expiresAt = new Date(Date.now() + expirationDays * 86400000).toISOString();

      res.status(200).json({
        shareId: sessionId,
        conversableToken: conversableToken,
        conversableUrl: conversableUrl,
        expiresAt: expiresAt
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

      // Check if interactive share expired (including legacy shares without expiresAt)
      if (conversable && hasInteractiveShare && session.interactiveShareMetadata &&
          new Date() > getInteractiveShareExpiresAt(session.interactiveShareMetadata)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, {
          ...session.interactiveShareMetadata,
          isActive: false
        });
        return res.status(410).json({ error: 'Interactive share link has expired' });
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
          skills: sharedSkills,
          slackThread: session.slackThread
        }
      });

      // ai-eval-funnel loop telemetry — fire-once eval_completed / eval_failed
      // events server-side so the lander's loop sensor can see them
      // reliably. Idempotent via ConditionExpression in fireLoopEventOnce —
      // safe to call on every poll. Only fires for AI_GTM_Position_Eval
      // sessions; other plan sessions are no-ops.
      if (session.pageIdentifier === 'plan-AI_GTM_Position_Eval') {
        const messages = session.messages || [];
        let reportUrl: string | undefined;
        let firstErrorText: string | undefined;
        for (const msg of messages) {
          const m = msg as { content?: string; text?: string; role?: string; metadata?: { isErrorMessage?: boolean } };
          const content = (m.content || m.text || '');
          if (m.role !== 'system' && !reportUrl) {
            const s3Match = content.match(/https:\/\/[^\s"']+\.html/);
            if (s3Match) reportUrl = s3Match[0];
          }
          if (m.metadata?.isErrorMessage === true && !firstErrorText) {
            firstErrorText = content.slice(0, 1000);
          }
        }
        if (reportUrl) {
          loopEventsEmitter.fireEvalCompleted(session.sessionId, reportUrl).catch(() => {});
        }
        if (firstErrorText) {
          loopEventsEmitter.fireEvalFailed(session.sessionId, firstErrorText).catch(() => {});
        }
      }
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

      // Check if interactive share has expired (including legacy shares without expiresAt)
      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, {
          ...interactiveShare,
          isActive: false
        });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Reject concurrent requests for the same session (synchronous check before any await)
      if (activeSessionGenerations.has(session.sessionId)) {
        return res.status(409).json({
          error: 'Session is busy',
          message: 'A response is already being generated for this session. Please wait.',
          code: 'SESSION_BUSY',
        });
      }
      activeSessionGenerations.add(session.sessionId);

      try {

      // Clear old progress store (but keep active connections)
      progressStore.delete(session.sessionId);

      // Always use session's llmModel for ishare endpoints (ignore request body's llmModel)
      // This ensures anonymous users get the correct model from the session
      const defaultModel = await agentModeService.getDefaultModel();
      const modelToUse = session.llmModel || defaultModel;

      // Use the same generateSessionResponse logic as the regular generateResponse,
      // wrapped in wall-clock timeout to guarantee lock release on hung generation.
      const ishareSenderInfo = {
        ip: req.ip || (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0].trim(),
        userAgent: req.headers?.['user-agent'] as string | undefined,
      };
      const response = await withGenerationTimeout(
        generateSessionResponse(
          session.sessionId,
          userMessage,
          session.userId,
          modelToUse,
          attachments,
          true, // isInteractiveShare - block admin tools for security
          undefined, // pageContext
          undefined, // isDelegatedAccess
          ishareSenderInfo
        ),
        session.sessionId
      );

      // Clear progress store after completion (keep connections open for future messages)
      progressStore.delete(session.sessionId);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills,
        ...(response.backupModelUsed ? { backupModelUsed: true, originalModel: response.originalModel, backupModel: response.backupModel } : {})
      });
      } finally {
        activeSessionGenerations.delete(session.sessionId);
      }
    } catch (error) {
      console.error('AgentMode: Generate shared response error:', error);

      // Clean up progress store on error so session doesn't appear stuck in generating state
      const shareId = req.params?.shareId;
      if (shareId) {
        emitProgress(shareId, { iteration: 0, status: 'complete' });
        progressStore.delete(shareId);
      }

      // Persist an error message to the session so the user sees feedback on reload.
      // Skip for session-limit errors (user message wasn't saved either).
      // Use the diagnosis agent for a context-aware message when possible.
      let diagnosticContent: string | null = null;
      if (shareId && !(error instanceof Error && isSessionLimitError(error))) {
        // Skip diagnosis for context-limit errors (they have specific handling below).
        // Worker-shutdown errors do NOT skip — they leave an orphaned user message and need feedback.
        if (!(error instanceof Error && isContextLimitError(error))) {
          if (error instanceof Error && isWorkerShutdownError(error)) {
            diagnosticContent = 'The server restarted while processing your request. Please send your message again.';
          } else {
            const userMessage = req.body?.userMessage || '';
            diagnosticContent = await getDiagnosticErrorMessage(error, shareId, userMessage);
          }
        }

        const errorAssistantMessage: ChatMessage = {
          role: 'assistant',
          content: diagnosticContent || 'I encountered an error processing your request. Please try sending your message again.',
          timestamp: new Date().toISOString(),
          metadata: {
            timestamp: new Date().toISOString(),
            isErrorMessage: true,
            ...(diagnosticContent ? { isDiagnosticMessage: true } : {}),
          },
        };
        await chatbotDb.addMessageToSession(shareId, errorAssistantMessage).catch(err => {
          console.error('AgentMode: Failed to persist error message to session:', err);
        });
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

          autoReportContextLimitToNotion(shareId, session?.userId, session?.userId, llmModel || session?.llmModel, session)
            .catch(err => console.error('autoReportContextLimitToNotion failed (shared):', err));

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

        if (isWorkerShutdownError(error)) {
          res.status(503).json({
            error: 'Server is restarting',
            message: 'The server is restarting. Please try again in a moment.',
            code: 'SERVER_RESTARTING',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (error.message.includes('Generation timed out')) {
          res.status(504).json({
            error: 'Generation timed out',
            message: 'The response took too long to generate. Please try again — your session is still active.',
            code: 'GENERATION_TIMEOUT',
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
        const originalMessage = (error as any)?.originalMessage;
        sendAgentModeOncallAlert({
          subject: 'Agent Mode: Unknown Error in Generate Shared Response',
          message: `An unknown error occurred while generating a shared response in Agent Mode.\n\nError: ${originalMessage || error.message || 'Unknown error'}`,
          sessionId: shareId,
          context: {
            'Error Message': error.message || 'Unknown error',
            'Original Error': originalMessage || 'Not available',
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

      res.status(500).json({
        error: 'Failed to generate response',
        ...(diagnosticContent ? { diagnosticMessage: diagnosticContent } : {}),
      });
    }
  },

  // Stop generation for a session
  async stopGeneration(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;

      // Signal cancellation
      requestCancel(sessionId);
      generateMarketingResponseWorkerService.cancelSession(sessionId);

      // Emit complete progress so the frontend SSE stream gets the signal
      emitProgress(sessionId, { iteration: 0, status: 'complete' });
      progressStore.delete(sessionId);

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop generation error:', error);
      res.status(500).json({ error: 'Failed to stop generation' });
    }
  },

  // Stop generation for an interactive shared session (public)
  async stopGenerationPublic(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;

      if (!shareId || !conversable) {
        return res.status(400).json({ error: 'Session ID and conversable token are required' });
      }

      // Verify session exists and conversable token is valid
      const session = await chatbotDb.getChatSession(shareId);
      if (!session || !session.interactiveShareMetadata?.isActive) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Signal cancellation
      requestCancel(shareId);
      generateMarketingResponseWorkerService.cancelSession(shareId);

      emitProgress(shareId, { iteration: 0, status: 'complete' });
      progressStore.delete(shareId);

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop generation (public) error:', error);
      res.status(500).json({ error: 'Failed to stop generation' });
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

      // Propagate feedback to images if the message contains generate_image tool calls
      try {
        const toolCalls = message.metadata?.toolCalls || [];
        const imageToolCalls = toolCalls.filter(
          (tc: any) => tc.name === 'generate_image' && tc.result?.imageUrl
        );

        if (imageToolCalls.length > 0) {
          const currentFeedbacks = session.feedbacks || {};
          const updatedFeedbacks = { ...currentFeedbacks };

          for (const tc of imageToolCalls) {
            const imageUrl = tc.result.imageUrl;
            updatedFeedbacks[imageUrl] = {
              type: type as 'like' | 'dislike',
              comment: comment || undefined,
              timestamp: new Date().toISOString(),
              userId: user.userId,
            };
          }

          await chatbotDb.updateSessionFeedbacks(sessionId, updatedFeedbacks);

          // If dislike, inject system message for Emma to learn
          if (type === 'dislike') {
            for (const tc of imageToolCalls) {
              const filename = tc.result.filename || tc.result.imageUrl.split('/').pop() || 'image';
              const commentText = comment ? ` Comment: "${comment}".` : '';
              const systemContent = `[Image Feedback] The user disliked the image "${filename}".${commentText} Please take this feedback into account for future image generations.`;

              try {
                await chatbotDb.addMessageToSession(sessionId, {
                  role: 'system',
                  content: systemContent,
                  metadata: {
                    timestamp: new Date().toISOString(),
                    isContextMessage: true,
                  },
                });
              } catch (msgError: any) {
                console.warn('Failed to inject image feedback system message:', msgError.message);
              }
            }
          }
        } else {
          // Inject general message feedback for non-image messages
          const commentText = comment ? ` Comment: "${comment}".` : '';
          const systemContent = type === 'dislike'
            ? `[Message Feedback] The user disliked the previous response.${commentText} Please take this feedback into account for future responses.`
            : `[Message Feedback] The user liked the previous response.${commentText} Keep doing more of this.`;

          try {
            await chatbotDb.addMessageToSession(sessionId, {
              role: 'system',
              content: systemContent,
              metadata: {
                timestamp: new Date().toISOString(),
                isContextMessage: true,
              },
            });
          } catch (msgError: any) {
            console.warn('Failed to inject message feedback system message:', msgError.message);
          }
        }
      } catch (propagateError) {
        // Don't fail the main feedback response if image propagation fails
        console.warn('Failed to propagate message feedback to images:', propagateError);
      }

      // Fire-and-forget: create a Notion item so the team can review positive/negative feedback
      createOncallItem({
        title: `Agent Mode ${type === 'like' ? 'Like' : 'Dislike'} Feedback – ${session.title || sessionId}`,
        description: [
          `User ${user.email} voted ${type} on a message in session "${session.title || sessionId}".`,
          comment ? `Comment: "${comment}"` : '',
          '',
          `Message preview: ${String(message.content || '').slice(0, 300)}`,
        ].filter(Boolean).join('\n'),
        additionalTags: [type === 'like' ? 'Feedback-Like' : 'Feedback-Dislike'],
        context: {
          sessionId,
          messageIndex: messageIndexNum,
          userId: user.userId,
          userEmail: user.email,
        },
      }).catch((err: Error) => {
        console.warn('Failed to create Notion feedback item:', err.message);
      });

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

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

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

      // Propagate feedback to images if the message contains generate_image tool calls
      try {
        const toolCalls = message.metadata?.toolCalls || [];
        const imageToolCalls = toolCalls.filter(
          (tc: any) => tc.name === 'generate_image' && tc.result?.imageUrl
        );

        if (imageToolCalls.length > 0) {
          const currentFeedbacks = session.feedbacks || {};
          const updatedFeedbacks = { ...currentFeedbacks };

          for (const tc of imageToolCalls) {
            const imageUrl = tc.result.imageUrl;
            updatedFeedbacks[imageUrl] = {
              type: type as 'like' | 'dislike',
              comment: comment || undefined,
              timestamp: new Date().toISOString(),
              userId: 'anonymous-ishare',
            };
          }

          await chatbotDb.updateSessionFeedbacks(shareId, updatedFeedbacks);

          // If dislike, inject system message for Emma to learn
          if (type === 'dislike') {
            for (const tc of imageToolCalls) {
              const filename = tc.result.filename || tc.result.imageUrl.split('/').pop() || 'image';
              const commentText = comment ? ` Comment: "${comment}".` : '';
              const systemContent = `[Image Feedback] The user disliked the image "${filename}".${commentText} Please take this feedback into account for future image generations.`;

              try {
                await chatbotDb.addMessageToSession(shareId, {
                  role: 'system',
                  content: systemContent,
                  metadata: {
                    timestamp: new Date().toISOString(),
                    isContextMessage: true,
                  },
                });
              } catch (msgError: any) {
                console.warn('Failed to inject image feedback system message:', msgError.message);
              }
            }
          }
        } else {
          // Inject general message feedback for non-image messages
          const commentText = comment ? ` Comment: "${comment}".` : '';
          const systemContent = type === 'dislike'
            ? `[Message Feedback] The user disliked the previous response.${commentText} Please take this feedback into account for future responses.`
            : `[Message Feedback] The user liked the previous response.${commentText} Keep doing more of this.`;

          try {
            await chatbotDb.addMessageToSession(shareId, {
              role: 'system',
              content: systemContent,
              metadata: {
                timestamp: new Date().toISOString(),
                isContextMessage: true,
              },
            });
          } catch (msgError: any) {
            console.warn('Failed to inject message feedback system message:', msgError.message);
          }
        }
      } catch (propagateError) {
        console.warn('Failed to propagate ishare message feedback to images:', propagateError);
      }

      // Fire-and-forget: create a Notion item for anonymous ishare votes
      createOncallItem({
        title: `Agent Mode ${type === 'like' ? 'Like' : 'Dislike'} Feedback (iShare) – ${session.title || shareId}`,
        description: [
          `Anonymous visitor voted ${type} on a message in shared session "${session.title || shareId}".`,
          comment ? `Comment: "${comment}"` : '',
          '',
          `Message preview: ${String(message.content || '').slice(0, 300)}`,
        ].filter(Boolean).join('\n'),
        additionalTags: [type === 'like' ? 'Feedback-Like' : 'Feedback-Dislike'],
        context: {
          sessionId: shareId,
          messageIndex: messageIndexNum,
          source: 'ishare',
        },
      }).catch((err: Error) => {
        console.warn('Failed to create Notion feedback item (ishare):', err.message);
      });

      res.json({
        success: true,
        message: updatedMessage,
      });
    } catch (error) {
      console.error('AgentMode: Submit ishare message feedback error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  },

  // Upload file attachment for ishare sessions (public with conversable token)
  async uploadIShareAttachment(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { conversable } = req.query;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
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

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      if (!interactiveShare?.isActive || interactiveShare.token !== conversable) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      // Upload to S3 using ishare folder structure (not the session owner's userId)
      // This prevents anonymous/guest uploads from being attributed to the session owner
      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        `ishare-sessions/${shareId}`, // Use session-specific folder instead of user folder
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
      console.error('AgentMode: Upload ishare attachment error:', error);
      res.status(500).json({ error: 'Failed to upload attachment' });
    }
  },

  // Email report to lead (public with conversable token)
  async emailReportToLead(req: Request, res: Response) {
    try {
      const { shareId } = req.params;
      const { email, reportUrl, conversableToken } = req.body;

      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'email is required' });
      }
      if (!reportUrl || typeof reportUrl !== 'string') {
        return res.status(400).json({ error: 'reportUrl is required' });
      }
      if (!conversableToken) {
        return res.status(401).json({ error: 'conversableToken is required' });
      }

      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const interactiveShare = session.interactiveShareMetadata;
      if (!interactiveShare?.isActive || interactiveShare.token !== conversableToken) {
        return res.status(401).json({ error: 'Invalid or expired conversable token' });
      }

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      // Build email HTML
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
            <p style="color: #666; margin: 5px 0;">Your AI-Powered Report</p>
          </div>

          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Your Report is Ready!</h2>
            <p style="color: #333; line-height: 1.6;">
              Your personalized AI analysis has been completed. Click below to view your full report.
            </p>

            <div style="text-align: center; margin: 20px 0;">
              <a href="${reportUrl}"
                 style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                View Your Report
              </a>
            </div>

            <p style="color: #333; line-height: 1.6; margin-top: 20px;">
              Want Emma to help you act on these insights?
              <a href="https://app.agentweb.pro/register" style="color: #643B7E; text-decoration: none;">Create your free account</a>
              and she'll walk you through fixing each issue step by step.
            </p>
          </div>

          <div style="text-align: center; color: #666; font-size: 12px;">
            <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
          </div>
        </div>`;

      await emailService.sendEmail(
        email.trim(),
        'Your AI Report is Ready — AgentWeb',
        `Your report is ready! View it here: ${reportUrl}`,
        emailHtml
      );

      res.json({ success: true, message: `Report sent to ${email.trim()}` });
    } catch (error) {
      console.error('AgentMode: Email report to lead error:', error);
      res.status(500).json({ error: 'Failed to send report email' });
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
        variableValues,
        frequencyIntervalDays,
        selfImprove
      } = req.body;

      if (!scheduleName || !startingMessage || !scheduleFrequency) {
        const missing = [
          !scheduleName && 'scheduleName',
          !startingMessage && 'startingMessage',
          !scheduleFrequency && 'scheduleFrequency',
        ].filter(Boolean).join(', ');
        return res.status(400).json({ error: `Missing required fields: ${missing}` });
      }

      // Validate frequencyIntervalDays for every_n_days frequency
      if (scheduleFrequency === 'every_n_days') {
        if (frequencyIntervalDays === undefined || !Number.isInteger(frequencyIntervalDays) || frequencyIntervalDays < 1) {
          return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days' });
        }
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
        const calculatedTime = calculateNextRunTime(scheduleFrequency, now, frequencyIntervalDays);
        scheduledNextRunTime = calculatedTime.toISOString();
      }

      const scheduledChat: any = {
        scheduleId,
        taskId: sessionId || 'global', // Use sessionId if provided, otherwise 'global'
        userId: user.userId,
        frequency: scheduleFrequency, // Map scheduleFrequency to frequency
        ...(scheduleFrequency === 'every_n_days' && { frequencyIntervalDays }),
        scheduleName,
        description: description || '',
        startingMessage,
        keywords: keywords || [],
        requiredFunctionCalls: requiredFunctionCalls || [],
        functionCallMinCalls: functionCallMinCalls || {},
        emailNotifications: [] as string[],
        dailyDigest: scheduleFrequency === 'hourly' ? (req.body.dailyDigest || false) : false, // Only allow daily digest for hourly schedules
        selfImprove: selfImprove === true, // When on, a reflection turn after each run may improve the prompt
        status: 'active',
        nextRunTime: scheduledNextRunTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        sessionId: sessionId || null, // Store original sessionId for reference (can be null)
        type: 'scheduled_chat', // Distinguish from regular task schedules
        emailCampaignTaskId: emailCampaignTaskId || null,
        llmModel: llmModel || '', // Empty means "use default at runtime"
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
      const normalizedVariableValues: Record<string, string> = {};
      if (normalizedVariables.length > 0 && variableValues && typeof variableValues === 'object') {
        normalizedVariables.forEach((variable) => {
          const rawValue = (variableValues as Record<string, unknown>)[variable.name];
          if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
            normalizedVariableValues[variable.name] = rawValue.trim();
          }
        });
      }

      // When no email is provided, fall back to the requester's email so LLMs don't need to
      // know this requirement. On delegate access use the admin's email (the person setting
      // up the schedule), not the target account's email.
      // Exception: variables are present and all pre-filled (silent run).
      const authReqForEmail = req as AuthenticatedRequest;
      const fallbackEmail = authReqForEmail.delegateInfo?.isDelegated
        ? authReqForEmail.delegateInfo.adminEmail
        : user.email;
      const allVariablesPrefilled = normalizedVariables.length > 0
        && getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length === 0;
      const normalizedEmails = normalizeEmailList(emailNotifications);
      const shouldUseFallbackEmail = normalizedEmails.length === 0 && !allVariablesPrefilled;
      scheduledChat.emailNotifications = shouldUseFallbackEmail ? [fallbackEmail] : normalizedEmails;
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

      // Exclude runResults to keep response size manageable (run history is
      // available via the dedicated GET /scheduled-chats/:id/test-history endpoint)
      const scheduledChatsWithoutRunResults = scheduledChats.map(({ runResults, ...rest }: any) => rest);

      res.json(scheduledChatsWithoutRunResults);
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
        variableValues,
        frequencyIntervalDays,
        selfImprove
      } = req.body;

      // Verify schedule exists and belongs to user (before validation so we can merge)
      const existingSchedule = await scheduleDb.getScheduleById(scheduleId);
      if (!existingSchedule || existingSchedule.userId !== user.userId) {
        return res.status(404).json({ error: 'Scheduled chat not found' });
      }

      // Support partial updates: fall back to existing values for missing required fields
      const effectiveScheduleName = scheduleName || existingSchedule.scheduleName;
      const effectiveStartingMessage = startingMessage !== undefined ? startingMessage : existingSchedule.startingMessage;
      const effectiveScheduleFrequency = scheduleFrequency || existingSchedule.frequency;

      if (!effectiveScheduleName || !effectiveStartingMessage || !effectiveScheduleFrequency) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate frequencyIntervalDays for every_n_days frequency
      const effectiveFrequencyIntervalDays = frequencyIntervalDays !== undefined ? frequencyIntervalDays : existingSchedule.frequencyIntervalDays;
      if (effectiveScheduleFrequency === 'every_n_days') {
        if (effectiveFrequencyIntervalDays === undefined || !Number.isInteger(effectiveFrequencyIntervalDays) || effectiveFrequencyIntervalDays < 1) {
          return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days' });
        }
      }

      // Validate runCount if provided
      if (runCount !== undefined) {
        if (!Number.isInteger(runCount) || (runCount !== -1 && runCount < 1)) {
          return res.status(400).json({ error: 'runCount must be -1 (unlimited) or a positive integer' });
        }
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

      // Update the schedule (merge with existing values for partial updates)
      const updates: any = {
        scheduleName: effectiveScheduleName,
        description: description !== undefined ? description : (existingSchedule.description || ''),
        startingMessage: effectiveStartingMessage,
        frequency: effectiveScheduleFrequency,
        ...(effectiveScheduleFrequency === 'every_n_days' && { frequencyIntervalDays: effectiveFrequencyIntervalDays }),
        keywords: keywords !== undefined ? keywords : (existingSchedule.keywords || []),
        requiredFunctionCalls: requiredFunctionCalls !== undefined ? requiredFunctionCalls : (existingSchedule.requiredFunctionCalls || []),
        functionCallMinCalls: functionCallMinCalls !== undefined ? functionCallMinCalls : (existingSchedule.functionCallMinCalls || {}),
        emailNotifications: normalizeEmailList(emailNotifications !== undefined ? emailNotifications : (existingSchedule.emailNotifications || [])),
        dailyDigest: effectiveScheduleFrequency === 'hourly' ? (dailyDigest !== undefined ? dailyDigest : (existingSchedule.dailyDigest || false)) : false,
        selfImprove: selfImprove !== undefined ? (selfImprove === true) : ((existingSchedule as any).selfImprove || false),
        updatedAt: now.toISOString(),
        emailCampaignTaskId: emailCampaignTaskId !== undefined ? emailCampaignTaskId : (existingSchedule.emailCampaignTaskId || null),
        llmModel: llmModel !== undefined ? llmModel : (existingSchedule.llmModel || ''),
      };

      // Whenever the prompt actually changes, snapshot the PREVIOUS prompt into the
      // revision history so it can be reverted. This applies to every update path —
      // manual edits, Emma's manage_scheduled_chat tool, and self-improve. Keep the
      // most recent SCHEDULE_PROMPT_REVISION_LIMIT revisions only.
      const previousStartingMessage = existingSchedule.startingMessage || '';
      if (effectiveStartingMessage !== previousStartingMessage) {
        const existingRevisions = Array.isArray((existingSchedule as any).promptRevisions)
          ? (existingSchedule as any).promptRevisions as Array<{ startingMessage: string; updatedAt: string }>
          : [];
        const nextRevisions = [
          ...existingRevisions,
          { startingMessage: previousStartingMessage, updatedAt: now.toISOString() },
        ];
        updates.promptRevisions = nextRevisions.slice(-SCHEDULE_PROMPT_REVISION_LIMIT);
      }

      const { variables: normalizedVariables, error: variableError } =
        validateAndBuildScheduledChatVariables(effectiveStartingMessage, variables, existingSchedule.variables || []);
      if (variableError) {
        return res.status(400).json({ error: variableError });
      }
      const effectiveEmailNotifications = normalizeEmailList(
        emailNotifications !== undefined ? emailNotifications : (existingSchedule.emailNotifications || [])
      );
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

      // At least one email notification is always required for scheduled chats
      if (effectiveEmailNotifications.length === 0) {
        return res.status(400).json({ error: 'At least one email notification is required for scheduled chats' });
      }

      const allUpdateVariablesPrefilled = normalizedVariables.length > 0
        && getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length === 0;

      updates.variableValues = normalizedVariableValues;
      updates.variableRequestStatus = normalizedVariables.length > 0
        ? (getMissingScheduledChatVariableNames(normalizedVariables, normalizedVariableValues).length > 0 ? 'pending' : 'provided')
        : 'idle';
      if (Object.keys(normalizedVariableValues).length > 0) {
        updates.variableValuesUpdatedAt = now.toISOString();
      }

      // Re-saving with all values pre-filled means the schedule should use permanent defaults,
      // not the email request flow. Reset the flow state so subsequent runs don't wait for email.
      if (allUpdateVariablesPrefilled) {
        updates.variableRequestSentAt = '';
        updates.variableRequestAccessTokenHash = '';
        updates.variableRequestAccessTokenExpiresAt = '';
        updates.variableRequestAccessTokenConsumedAt = '';
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
                  scheduleToRun.scheduleId,
                  result.summary
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
                scheduleToRun.scheduleId,
                result.summary
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

  // Public endpoint: upload a file for a file-type variable (no login required, access token validates)
  async uploadScheduledChatVariableFile(req: Request, res: Response) {
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

      const expiresAtMs = schedule.variableRequestAccessTokenExpiresAt
        ? new Date(schedule.variableRequestAccessTokenExpiresAt).getTime()
        : NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
        return res.status(410).json({ error: 'This variable request link has expired' });
      }

      if (schedule.variableRequestAccessTokenConsumedAt) {
        return res.status(409).json({ error: 'This variable request link has already been used' });
      }

      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const uploadResult = await uploadFileToS3(
        file.buffer,
        file.originalname,
        schedule.userId,
        file.mimetype
      );

      if (!uploadResult.success) {
        return res.status(500).json({ error: 'Failed to upload file' });
      }

      return res.json({
        url: uploadResult.url,
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
      });
    } catch (error) {
      console.error('AgentMode: Public variable file upload error:', error);
      return res.status(500).json({ error: 'Failed to upload file' });
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

      // Generate runId upfront so the agent can poll for this specific result
      const runId = require('uuid').v4();
      const { sendNotificationEmail } = req.body || {};

      // Fire-and-forget: run in background so the HTTP request doesn't time out
      // for complex tasks that take many minutes (e.g. scraping 13+ web pages).
      // The agent should poll get_scheduled_chat_test_history to see the result.
      const backgroundRun = async () => {
        const result = await runScheduledChat(schedule, user.userId, true, runId);

        if (sendNotificationEmail && result.sessionId) {
          try {
            const emailNotifications = schedule.emailNotifications || [];
            if (emailNotifications.length > 0) {
              await emailService.sendScheduledChatResultEmail(
                emailNotifications,
                schedule.scheduleName,
                result,
                schedule.scheduleId,
                result.summary
              );
            }
          } catch (emailError) {
            console.error('AgentMode: Failed to send test notification email:', emailError);
          }
        }
      };
      backgroundRun().catch(err => {
        console.error('AgentMode: Background test run error:', err);
        const { reportUIError } = require('../utils/errorReporter');
        reportUIError({
          operation: 'schedule-manual-run',
          errorMessage: err?.message || String(err),
          userId: user.userId,
          context: {
            'Schedule ID': scheduleId,
            'Schedule Name': schedule.scheduleName || 'unknown',
            'Run ID': runId,
          },
        }).catch((reportErr: Error) => console.error('errorReporter failed:', reportErr));
      });

      res.json({
        runId,
        status: 'pending',
        message: 'Test run started in background. Poll get_scheduled_chat_test_history to check results.'
      });

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

      const runSummary: string | undefined = record.summary;

      await emailService.sendScheduledChatResultEmail(
        [toEmail],
        schedule.scheduleName,
        resultForEmail,
        schedule.scheduleId,
        runSummary
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
          // Pre-filled defaults (no email request ever sent) are valid for all runs.
          // variableValuesUpdatedAt guards against legacy records missing timestamps.
          const prefilledWithoutRequest = !hasVariableRequestSentAt && hasVariableValuesUpdatedAt;
          const isVariableRequestSatisfied = schedule.variableRequestStatus === 'provided'
            && hasAllVariableValues
            && (prefilledWithoutRequest || (valuesProvidedAfterLatestRequest && valuesProvidedAfterLastRun));

          // Calculate next run based on the current nextRunTime to preserve the scheduled time
          const currentNextRun = new Date(schedule.nextRunTime);
          const nextRunTime = calculateNextRunTime(schedule.frequency, currentNextRun, schedule.frequencyIntervalDays);

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

          // Only clear variable values if the user submitted them via the email link
          // (token consumed). Config-time defaults and admin-updated values persist forever.
          const accessTokenWasConsumed = typeof schedule.variableRequestAccessTokenConsumedAt === 'string' && schedule.variableRequestAccessTokenConsumedAt.length > 0;
          const shouldClearVariablesAfterRun = hasVariableRequestSentAt && accessTokenWasConsumed;

          // Start the scheduled chat run asynchronously (don't await)
          runScheduledChat(schedule, schedule.userId, false).then(async (result) => {
            // Decrement concurrent run counter when done
            currentConcurrentRuns--;
            if (scheduleVariables.length > 0 && shouldClearVariablesAfterRun) {
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
                      schedule.scheduleId,
                      result.summary
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

            if (scheduleVariables.length > 0 && shouldClearVariablesAfterRun) {
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

            // Save failure run result to database so it's visible in the UI
            const errorResult = {
              scheduleId: schedule.scheduleId,
              runId: require('uuid').v4(),
              status: 'failure' as const,
              passed: false,
              actualResponse: `Scheduled chat runtime error: ${error.message || 'Unknown error'}`,
              actualFunctionCalls: [],
              keywordMatches: [],
              keywordMisses: [],
              functionCallMatches: [],
              functionCallMisses: [],
              executionTime: 0,
              sessionId: '',
              attempt: 0,
              createdAt: new Date().toISOString()
            };

            scheduleDb.addRunResult(schedule.scheduleId, errorResult).catch((saveError) => {
              console.error(`Error saving failure run result for schedule ${schedule.scheduleName}:`, saveError);
            });

            // Send oncall alert for unhandled scheduled chat error (safety net)
            sendAgentModeOncallAlert({
              subject: `Scheduled Chat Unhandled Error: ${schedule.scheduleName}`,
              message: `Scheduled chat "${schedule.scheduleName}" failed with an unhandled error in the fire-and-forget handler.\n\nError: ${error.message || 'Unknown error'}`,
              context: {
                'Schedule ID': schedule.scheduleId,
                'Schedule Name': schedule.scheduleName,
                'User ID': schedule.userId,
                'Error Message': error.message || 'Unknown error',
                'Error Stack': error.stack || 'No stack trace',
                'Timestamp': new Date().toISOString()
              }
            }).catch(err => console.error('Failed to send oncall alert for unhandled scheduled chat error:', err));

            // Send error notification email
            const emailNotifications = schedule.emailNotifications || [];
            if (emailNotifications.length > 0) {
              import('../services/emailService').then(({ emailService }) => {
                emailService.sendScheduledChatResultEmail(
                  emailNotifications,
                  schedule.scheduleName,
                  errorResult,
                  schedule.scheduleId
                ).catch((emailError) => {
                  console.error(`Error sending failure email for schedule ${schedule.scheduleName}:`, emailError);
                });
              }).catch((importError) => {
                console.error('Error importing emailService:', importError);
              });
            }
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

      // Cancel generation immediately when the client disconnects
      req.on('close', () => {
        if (!res.headersSent) {
          console.log(`AgentMode: Client disconnected for conversable session ${session.sessionId} — signalling cancellation`);
          requestCancel(session.sessionId);
          generateMarketingResponseWorkerService.cancelSession(session.sessionId);
        }
      });

      // Generate AI response using the same function as regular users
      const response = await generateSessionResponse(
        session.sessionId,
        userMessage,
        session.userId, // Use the original session owner's userId
        modelToUse,
        attachments
      );

      progressStore.delete(session.sessionId);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources,
        workPlan: response.workPlan,
        skills: response.skills,
        ...(response.backupModelUsed ? { backupModelUsed: true, originalModel: response.originalModel, backupModel: response.backupModel } : {})
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

        if (isWorkerShutdownError(error)) {
          res.status(503).json({
            error: 'Server is restarting',
            message: 'The server is restarting. Please try again in a moment.',
            code: 'SERVER_RESTARTING',
            suggestion: 'wait_and_retry'
          });
          return;
        }

        if (error.message.includes('Generation timed out')) {
          res.status(504).json({
            error: 'Generation timed out',
            message: 'The response took too long to generate. Please try again — your session is still active.',
            code: 'GENERATION_TIMEOUT',
            suggestion: 'wait_and_retry'
          });
          return;
        }
      }

      res.status(500).json({ error: 'Failed to generate response' });
    }
  },

  // Get all predefined work plans (public + user's own private, deduped by title) — reads from AW-WorkPlans table
  async getAllPredefinedWorkPlans(req: Request, res: Response) {
    try {
      const publicPlans = await workPlanService.getPublicPlansForAgentMode();

      // If user is authenticated, include their own private plans + org members' private plans
      let userPrivatePlans: any[] = [];
      const result = await getUserFromToken(req);
      if (result.user) {
        const user = await userDb.getUserById(result.user.userId);
        const [ownPlans, orgPlans] = await Promise.all([
          workPlanService.getWorkPlansByOwner(result.user.userId),
          user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
        ]);
        const seen = new Set<string>();
        for (const p of [...ownPlans, ...orgPlans]) {
          if (p.visibility === 'private' && !seen.has(p.planId)) {
            seen.add(p.planId);
            userPrivatePlans.push(p);
          }
        }
      }

      // Map to legacy shape expected by customer portal (uses 'id' not 'planId')
      const mapPlan = (p: any) => ({
        id: p.planId,
        title: p.title,
        description: p.description,
        welcomeMessage: p.welcomeMessage,
        autocomplete: p.autocomplete || false,
        requireLogin: p.requireLogin || false,
        showLoginSignup: p.showLoginSignup || 'after_plan_completed',
        showInAgentMode: p.showInAgentMode !== false,
        defaultModel: p.defaultModel,
        category: p.category,
        steps: p.steps,
        visibility: p.visibility,
        thumbnail_url: p.thumbnail_url,
        thumbnail_alt_text: p.thumbnail_alt_text,
      });

      // Put private plans first, then public — deduplicate by title so user's
      // private plan takes priority over a system/public plan with the same title
      const allPlans = [...userPrivatePlans.map(mapPlan), ...publicPlans.map(mapPlan)];
      const seen = new Set<string>();
      const deduped = allPlans.filter(p => {
        const key = p.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      res.json(deduped);
    } catch (error) {
      console.error('AgentMode: Get all predefined work plans error:', error);
      res.status(500).json({ error: 'Failed to get all predefined work plans' });
    }
  },

  // Get predefined work plan by title (public + user's private) — reads from AW-WorkPlans table
  async getPredefinedWorkPlan(req: Request, res: Response) {
    try {
      const { planTitle } = req.params;

      if (!planTitle) {
        return res.status(400).json({ error: 'Plan title is required' });
      }

      // Load system + public plans from AW-WorkPlans table
      const [systemPlans, publicPlans] = await Promise.all([
        workPlanService.getWorkPlansByVisibility('system'),
        workPlanService.getWorkPlansByVisibility('public'),
      ]);
      // Put user's private plans FIRST so they take priority over system/public plans with same title
      const result = await getUserFromToken(req);
      const allPlans: any[] = [];
      if (result.user) {
        const user = await userDb.getUserById(result.user.userId);
        const [ownPlans, orgPlans] = await Promise.all([
          workPlanService.getWorkPlansByOwner(result.user.userId),
          user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
        ]);
        const seen = new Set<string>();
        for (const p of [...ownPlans, ...orgPlans]) {
          if (p.visibility === 'private' && !seen.has(p.planId)) {
            seen.add(p.planId);
            allPlans.push(p);
          }
        }
      }
      allPlans.push(...systemPlans, ...publicPlans);

      // Find work plan with matching title (case-insensitive) — private plans checked first
      const workPlan = allPlans.find((wp) =>
        wp.title && wp.title.toLowerCase() === planTitle.toLowerCase()
      );

      if (!workPlan) {
        return res.status(404).json({ error: `Work plan "${planTitle}" not found` });
      }

      // Enforce ownership/org-membership for private plans
      if (workPlan.visibility === 'private' && !result.user) {
        return res.status(403).json({ error: 'Not authorized to view this private work plan' });
      }

      res.json({
        id: workPlan.planId,
        title: workPlan.title,
        description: workPlan.description,
        welcomeMessage: workPlan.welcomeMessage,
        autocomplete: workPlan.autocomplete || false,
        requireLogin: workPlan.requireLogin || false,
        showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
        showInAgentMode: workPlan.showInAgentMode !== false,
        defaultModel: workPlan.defaultModel,
        steps: workPlan.steps,
        visibility: workPlan.visibility,
      });
    } catch (error) {
      console.error('AgentMode: Get predefined work plan error:', error);
      res.status(500).json({ error: 'Failed to get predefined work plan' });
    }
  },

  // Create session with predefined work plan (public) — reads from AW-WorkPlans table
  async createSessionWithPlan(req: Request, res: Response) {
    try {
      const { planTitle } = req.params;
      const { startingMessage } = req.body || {};

      if (!planTitle) {
        return res.status(400).json({ error: 'Plan title is required' });
      }

      // Check if user is authenticated (optional - route is public)
      const result = await getUserFromToken(req);
      const userId = result.user ? result.user.userId : `anon_${uuidv4()}`;

      // Load system + public plans from AW-WorkPlans table
      const [systemPlans, publicPlans] = await Promise.all([
        workPlanService.getWorkPlansByVisibility('system'),
        workPlanService.getWorkPlansByVisibility('public'),
      ]);
      // Put user's private plans FIRST so they take priority over system/public plans with same title
      const allPlans: any[] = [];
      if (result.user) {
        const user = await userDb.getUserById(result.user.userId);
        const [ownPlans, orgPlans] = await Promise.all([
          workPlanService.getWorkPlansByOwner(result.user.userId),
          user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
        ]);
        const seen = new Set<string>();
        for (const p of [...ownPlans, ...orgPlans]) {
          if (p.visibility === 'private' && !seen.has(p.planId)) {
            seen.add(p.planId);
            allPlans.push(p);
          }
        }
      }
      allPlans.push(...systemPlans, ...publicPlans);

      // Find work plan with matching title (case-insensitive) — private plans checked first
      const predefinedPlan = allPlans.find((wp) =>
        wp.title && wp.title.toLowerCase() === planTitle.toLowerCase()
      );

      if (!predefinedPlan) {
        return res.status(404).json({ error: `Work plan "${planTitle}" not found` });
      }

      // Enforce ownership/org-membership for private plans.
      // allPlans already only includes private plans belonging to the user or their org,
      // so a plan found in allPlans is already authorized. Only block unauthenticated users.
      if (predefinedPlan.visibility === 'private' && !result.user) {
        return res.status(403).json({ error: 'Not authorized to use this private work plan' });
      }

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
          // Carry the user-facing instructions through to the session so
          // <HorizontalPlanProgress> can render them in the expanded-step
          // panel. Without this, the field set in the partner-portal
          // editor never reaches the customer portal.
          ...(step.userInstructions !== undefined && { userInstructions: step.userInstructions }),
          status: 'pending' as const,
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: step.requiredFunctionCalls,
          skillIds: step.skillIds
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

      // Auto-install ALL skills from ALL work plan steps upfront.
      // Skills need to be available from the start because tool filtering is computed
      // at the beginning of each message — installing mid-conversation (on step completion)
      // doesn't take effect until the next message, causing tools to be unavailable.
      // The work plan's requiredFunctionCalls still enforce step ordering.
      const allSkillIds = new Set<string>();
      for (const step of predefinedPlan.steps) {
        if (step.skillIds?.length) {
          step.skillIds.forEach((id: string) => allSkillIds.add(id));
        }
      }
      if (allSkillIds.size > 0) {
        try {
          await chatbotDb.addAssociatedSkills(session.sessionId, Array.from(allSkillIds));
          console.log(`AgentMode: Auto-installed all plan skills for "${predefinedPlan.title}": ${Array.from(allSkillIds).join(', ')}`);
        } catch (skillErr) {
          console.error('AgentMode: Error auto-installing plan skills:', skillErr);
        }
      }

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

      // ai-eval-funnel loop telemetry — fire eval_started server-side so the
      // loop's sensor sees the start regardless of frontend telemetry state.
      // Idempotent via ConditionExpression — safe on retries.
      if (planTitle === 'AI_GTM_Position_Eval') {
        loopEventsEmitter.fireEvalStarted(session.sessionId).catch(() => {});
      }

      // Fire-and-forget: send starting message after response is returned
      if (startingMessage && typeof startingMessage === 'string' && startingMessage.trim()) {
        const trimmedMessage = startingMessage.trim();
        const sessionId = session.sessionId;

        console.log(`AgentMode: Fire-and-forget starting for session ${sessionId}, model=${selectedModel}`);
        generateSessionResponse(sessionId, trimmedMessage, userId, selectedModel)
          .then(() => {
            progressStore.delete(sessionId);
            console.log(`AgentMode: Fire-and-forget completed successfully for session ${sessionId}`);
          })
          .catch(async (firstErr: any) => {
            console.warn(`AgentMode: First attempt failed for session ${sessionId}: ${firstErr?.message}`);

            // Persist a tagged "first attempt failed" record IMMEDIATELY so the
            // closed-loop sensor (which queries for metadata.isErrorMessage = true)
            // sees the failure even when the retry rescues the session.
            // Without this, retries silently mask LLM/Bedrock/Playwright failures —
            // the lander loop reported 0 logged failures over 30 days despite
            // known agent crashes, because the retry path here always overwrote
            // the first-attempt failure with a successful response.
            //
            // Uses role='system' so the user doesn't see this in their chat UI
            // (filterMessagesForClient strips system messages on read). The sensor
            // path queries the raw messages array, so it still sees the tag.
            try {
              // Pack debug info (errorName/code/httpStatus) into the content
              // since the ChatMessage metadata type is strict — we don't want
              // to widen the type just to thread these fields through.
              const debugCtx = JSON.stringify({
                firstAttemptOnly: true,
                errorName: firstErr?.name,
                errorCode: firstErr?.code,
                httpStatus: firstErr?.status ?? firstErr?.$metadata?.httpStatusCode,
              });
              const firstAttemptErrorMessage: ChatMessage = {
                role: 'system',
                content: `[telemetry] First-attempt agent failure (retry will follow): ${(firstErr?.message ?? String(firstErr)).slice(0, 500)} | ctx: ${debugCtx}`,
                timestamp: new Date().toISOString(),
                metadata: {
                  timestamp: new Date().toISOString(),
                  isErrorMessage: true,
                },
              };
              await chatbotDb.addMessageToSession(sessionId, firstAttemptErrorMessage);
            } catch (saveErr) {
              console.error('AgentMode: Failed to save first-attempt-failure telemetry record', sessionId, saveErr);
            }

            // Restart the worker before retrying — the current worker may be unresponsive
            try {
              await generateMarketingResponseWorkerService.restartWorker();
            } catch (restartErr) {
              console.error(`AgentMode: Worker restart failed for session ${sessionId}:`, restartErr);
            }

            await new Promise(resolve => setTimeout(resolve, 3000));

            let retryErrCaught: any = null;
            try {
              console.log(`AgentMode: Retrying fire-and-forget for session ${sessionId}`);
              await generateSessionResponse(sessionId, trimmedMessage, userId, selectedModel);
              progressStore.delete(sessionId);
              console.log(`AgentMode: Retry succeeded for session ${sessionId}`);
              return; // Retry succeeded — done. The first-attempt-failure telemetry record
                      // we wrote above stays in the session as a "rescued by retry" marker.
            } catch (retryErr: any) {
              retryErrCaught = retryErr;
              console.error(`AgentMode: Retry also failed for session ${sessionId}: ${retryErr?.message}`);
            }

            // Both attempts failed — persist user-visible error message and alert.
            // The earlier telemetry record (firstAttemptOnly: true) plus this user-
            // visible message together give the sensor two markers for terminal
            // failures and one marker for retry-rescued failures.

            // Also fire eval_failed to the lander loop's anon-event table, so the
            // loop's policy DSL can see this terminal failure regardless of
            // the chat-session message-scan path.
            if (planTitle === 'AI_GTM_Position_Eval') {
              loopEventsEmitter
                .fireEvalFailed(
                  sessionId,
                  `first: ${(firstErr?.message ?? 'unknown').slice(0, 200)} | retry: ${(retryErrCaught?.message ?? 'unknown').slice(0, 200)}`,
                )
                .catch(() => {});
            }

            // Persist error message to session so the user sees something went wrong
            try {
              const errorMessage: ChatMessage = {
                role: 'assistant',
                content: 'I encountered an error while processing your request. Please try sending your message again or start a new session.',
                timestamp: new Date().toISOString(),
                metadata: {
                  timestamp: new Date().toISOString(),
                  isErrorMessage: true
                }
              };
              await chatbotDb.addMessageToSession(sessionId, errorMessage);
            } catch (saveErr) {
              console.error('AgentMode: Failed to save error message to session', sessionId, saveErr);
            }

            // Emit progress complete so the frontend stops showing the loading state and refreshes
            emitProgress(sessionId, { iteration: 0, status: 'complete' });

            // Send oncall alert so the team is notified
            sendAgentModeOncallAlert({
              subject: `Work Plan Session Failed: ${sessionId}`,
              message: `A predefined work plan session failed after retry.\n\nFirst error: ${firstErr?.message || 'Unknown'}\n\nRetry error: (see above)`,
              sessionId,
              context: {
                'Session ID': sessionId,
                'User ID': userId,
                'Plan Title': workPlanWithWelcome?.title || 'Unknown',
                'LLM Model': selectedModel,
                'Error Message': firstErr?.message || 'Unknown error',
                'Error Stack': firstErr?.stack || 'No stack trace',
                'Timestamp': new Date().toISOString()
              }
            }).catch(alertErr => console.error('Failed to send oncall alert for work plan session error:', alertErr));
          });
      }
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

      // Under delegation (`req.delegateInfo.isDelegated`), `req.user.userId` is
      // the TARGET customer per middleware/auth.ts — so owner-matching against
      // `user.userId` already covers the "admin viewing target's sessions"
      // case. But an admin-created session (owned by the admin's own userId)
      // shown in the admin's UI while they're delegated gets a false-positive
      // 403 otherwise — which is why the prod UI sat in a 403 polling loop
      // during impersonation (see nginx log, 2026-04-23 23:52 UTC). Allow
      // the delegated admin to read their own admin-owned sessions too.
      const delegateInfo = req.delegateInfo;
      const isOwner = session.userId === user.userId;
      const isDelegatedAdminOwnSession =
        delegateInfo?.isDelegated &&
        session.userId === delegateInfo.adminUserId;
      if (!isOwner && !isDelegatedAdminOwnSession) {
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

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

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

      // Block non-admins from using opus models
      if (llmModel.includes('opus') && !user.isAdmin) {
        return res.status(403).json({ error: 'Opus models are not available for your account' });
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

      // Shared sessions are non-admin; block opus models
      if (llmModel.includes('opus')) {
        return res.status(403).json({ error: 'Opus models are not available for shared sessions' });
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

      if (interactiveShare?.isActive && new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        await chatbotDb.updateSessionInteractiveShareMetadata(shareId, { ...interactiveShare, isActive: false });
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

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

  async getShareOgMetadata(req: Request, res: Response) {
    try {
      const { shareId } = req.params;

      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Must have view-only or interactive sharing enabled
      const hasViewOnlyShare = session.shareMetadata?.isShared;
      const hasInteractiveShare = session.interactiveShareMetadata?.isActive;
      if (!hasViewOnlyShare && !hasInteractiveShare) {
        return res.status(404).json({ error: 'This conversation is not shared' });
      }

      // Check if view-only share expired
      if (hasViewOnlyShare && session.shareMetadata?.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
        return res.status(410).json({ error: 'Share link has expired' });
      }

      // Check if interactive share expired
      if (!hasViewOnlyShare && hasInteractiveShare && session.interactiveShareMetadata &&
          new Date() > getInteractiveShareExpiresAt(session.interactiveShareMetadata)) {
        return res.status(410).json({ error: 'Interactive share link has expired' });
      }

      const title = session.title || 'AgentWeb Conversation';

      // Extract first user message for description
      let description = 'View this conversation on AgentWeb';
      if (Array.isArray(session.messages)) {
        const firstUserMessage = session.messages.find(
          (m: any) => m && m.role === 'user' && typeof m.content === 'string'
        );
        if (firstUserMessage) {
          const content = firstUserMessage.content.trim();
          description = content.length > 160 ? content.substring(0, 157) + '...' : content;
        }
      }

      res.json({ title, description });
    } catch (error) {
      console.error('AgentMode: Get share OG metadata error:', error);
      res.status(500).json({ error: 'Failed to get share metadata' });
    }
  },

  // GET /api/agent-mode/foundation-tools
  getFoundationTools: async (req: Request, res: Response) => {
    try {
      const toolNames = [...agentModeService.getFoundationToolNames()];
      const defaults = [...AgentModeService.DEFAULT_FOUNDATION_TOOLS];
      const adminToolNames = agentModeService.getAdminToolNames();
      res.json({ toolNames, defaults, adminToolNames });
    } catch (error) {
      console.error('AgentMode: Get foundation tools error:', error);
      res.status(500).json({ error: 'Failed to get foundation tools' });
    }
  },

  // PUT /api/agent-mode/foundation-tools
  updateFoundationTools: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { toolNames } = req.body;
      if (!Array.isArray(toolNames)) {
        return res.status(400).json({ error: 'toolNames must be an array of strings' });
      }
      if (!toolNames.every((t: unknown) => typeof t === 'string' && t.length > 0)) {
        return res.status(400).json({ error: 'Each tool name must be a non-empty string' });
      }

      const updatedBy = req.user?.email || 'admin';
      const updated = await agentModeService.updateFoundationTools(toolNames, updatedBy);
      res.json({ toolNames: updated });
    } catch (error) {
      console.error('AgentMode: Update foundation tools error:', error);
      res.status(500).json({ error: 'Failed to update foundation tools' });
    }
  },

  // ─── Schedule Templates ──────────────────────────────────────────────────

  // POST /api/agent-mode/schedule-templates
  createScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const {
        name, description, category, visibility,
        startingMessage, variables, keywords,
        requiredFunctionCalls, functionCallMinCalls,
        suggestedFrequency, frequencyIntervalDays,
        emailNotifications, dailyDigest, llmModel,
      } = req.body;

      if (!name || !startingMessage) {
        return res.status(400).json({ error: 'name and startingMessage are required' });
      }

      if (suggestedFrequency === 'every_n_days' && (frequencyIntervalDays === undefined || !Number.isInteger(frequencyIntervalDays) || frequencyIntervalDays < 1)) {
        return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer when suggestedFrequency is every_n_days' });
      }

      // Extract variables from message
      const variableRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
      const messageVarNames = new Set<string>();
      let match;
      while ((match = variableRegex.exec(startingMessage)) !== null) {
        messageVarNames.add(match[1]);
      }

      // Build normalized variables list
      const inputVars = Array.isArray(variables) ? variables : [];
      const normalizedVariables = Array.from(messageVarNames).map(varName => {
        const existing = inputVars.find((v: any) => v.name === varName);
        return {
          name: varName,
          description: existing?.description || '',
          type: existing?.type || 'text',
        };
      });

      const templateId = uuidv4();
      const now = new Date().toISOString();

      const template = {
        templateId,
        createdBy: user.userId,
        name,
        description: description || '',
        category: category || 'General',
        visibility: 'private' as const,
        startingMessage,
        variables: normalizedVariables,
        keywords: keywords || [],
        requiredFunctionCalls: requiredFunctionCalls || [],
        functionCallMinCalls: functionCallMinCalls || {},
        suggestedFrequency: suggestedFrequency || 'daily',
        ...(suggestedFrequency === 'every_n_days' && { frequencyIntervalDays }),
        emailNotifications: emailNotifications || [],
        dailyDigest: dailyDigest || false,
        llmModel: llmModel || '',
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      await scheduleTemplateDb.createTemplate(template);

      res.status(201).json({
        templateId,
        message: 'Schedule template created successfully',
      });
    } catch (error) {
      console.error('AgentMode: Create schedule template error:', error);
      res.status(500).json({ error: 'Failed to create schedule template' });
    }
  },

  // GET /api/agent-mode/schedule-templates
  getScheduleTemplates: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;

      // Get user's own templates + all system/public templates
      const [userTemplates, systemTemplates, publicTemplates] = await Promise.all([
        scheduleTemplateDb.getTemplatesByCreator(user.userId),
        scheduleTemplateDb.getTemplatesByVisibility('system'),
        scheduleTemplateDb.getTemplatesByVisibility('public'),
      ]);

      // Merge: system + public + user's own templates, deduplicated
      const sharedTemplates = [...(systemTemplates || []), ...(publicTemplates || [])];
      const sharedIds = new Set(sharedTemplates.map((t: any) => t.templateId));
      const privateTemplates = (userTemplates || []).filter((t: any) => !sharedIds.has(t.templateId));
      const all = [...sharedTemplates, ...privateTemplates];

      // Sort newest first
      all.sort((a: any, b: any) => {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });

      res.json(all);
    } catch (error) {
      console.error('AgentMode: Get schedule templates error:', error);
      res.status(500).json({ error: 'Failed to get schedule templates' });
    }
  },

  // GET /api/agent-mode/schedule-templates/:templateId
  getScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const template = await scheduleTemplateDb.getTemplateById(templateId);
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      // Allow access if system/public visibility or owned by user
      const isPubliclyVisible = template.visibility === 'system' || template.visibility === 'public';
      if (!isPubliclyVisible && template.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found' });
      }

      res.json(template);
    } catch (error) {
      console.error('AgentMode: Get schedule template error:', error);
      res.status(500).json({ error: 'Failed to get schedule template' });
    }
  },

  // PUT /api/agent-mode/schedule-templates/:templateId
  updateScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const existing = await scheduleTemplateDb.getTemplateById(templateId);
      if (!existing || existing.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found or not owned by you' });
      }

      const {
        name, description, category, visibility,
        startingMessage, variables, keywords,
        requiredFunctionCalls, functionCallMinCalls,
        suggestedFrequency, frequencyIntervalDays,
        emailNotifications, dailyDigest, llmModel,
      } = req.body;

      const updates: any = { updatedAt: new Date().toISOString() };

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (category !== undefined) updates.category = category;
      if (visibility !== undefined) updates.visibility = visibility;
      if (keywords !== undefined) updates.keywords = keywords;
      if (requiredFunctionCalls !== undefined) updates.requiredFunctionCalls = requiredFunctionCalls;
      if (functionCallMinCalls !== undefined) updates.functionCallMinCalls = functionCallMinCalls;
      if (suggestedFrequency !== undefined) updates.suggestedFrequency = suggestedFrequency;
      if (frequencyIntervalDays !== undefined) updates.frequencyIntervalDays = frequencyIntervalDays;
      if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
      if (dailyDigest !== undefined) updates.dailyDigest = dailyDigest;
      if (llmModel !== undefined) updates.llmModel = llmModel;

      if (startingMessage !== undefined) {
        updates.startingMessage = startingMessage;

        // Re-extract variables from updated message
        const variableRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
        const messageVarNames = new Set<string>();
        let match;
        while ((match = variableRegex.exec(startingMessage)) !== null) {
          messageVarNames.add(match[1]);
        }
        const inputVars = Array.isArray(variables) ? variables : (existing.variables || []);
        updates.variables = Array.from(messageVarNames).map(varName => {
          const existingVar = inputVars.find((v: any) => v.name === varName);
          return { name: varName, description: existingVar?.description || '', type: existingVar?.type || 'text' };
        });
      } else if (variables !== undefined) {
        updates.variables = variables;
      }

      await scheduleTemplateDb.updateTemplate(templateId, updates);

      res.json({ message: 'Schedule template updated successfully' });
    } catch (error) {
      console.error('AgentMode: Update schedule template error:', error);
      res.status(500).json({ error: 'Failed to update schedule template' });
    }
  },

  // DELETE /api/agent-mode/schedule-templates/:templateId
  deleteScheduleTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const existing = await scheduleTemplateDb.getTemplateById(templateId);
      if (!existing || existing.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found or not owned by you' });
      }

      await scheduleTemplateDb.deleteTemplate(templateId);

      res.json({ message: 'Schedule template deleted successfully' });
    } catch (error) {
      console.error('AgentMode: Delete schedule template error:', error);
      res.status(500).json({ error: 'Failed to delete schedule template' });
    }
  },

  // POST /api/agent-mode/schedule-templates/:templateId/use
  createScheduleFromTemplate: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;
      const {
        scheduleName, nextRunTime, scheduleFrequency,
        frequencyIntervalDays: overrideInterval,
        emailNotifications: overrideEmails,
        variableValues, runCount, llmModel: overrideModel,
      } = req.body;

      const template = await scheduleTemplateDb.getTemplateById(templateId);
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      const isPubliclyVisible = template.visibility === 'system' || template.visibility === 'public';
      if (!isPubliclyVisible && template.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const frequency = scheduleFrequency || template.suggestedFrequency || 'daily';
      const interval = overrideInterval || template.frequencyIntervalDays;

      if (frequency === 'every_n_days' && (!interval || !Number.isInteger(interval) || interval < 1)) {
        return res.status(400).json({ error: 'frequencyIntervalDays must be a positive integer for every_n_days frequency' });
      }

      const now = new Date();
      let scheduledNextRunTime: string;
      if (nextRunTime) {
        const providedDate = new Date(nextRunTime);
        if (isNaN(providedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid nextRunTime format' });
        }
        scheduledNextRunTime = providedDate.toISOString();
      } else {
        scheduledNextRunTime = calculateNextRunTime(frequency, now, interval).toISOString();
      }

      // Build normalized variable values from template variables
      const normalizedVariableValues: Record<string, string> = {};
      const templateVars: any[] = template.variables || [];
      if (templateVars.length > 0 && variableValues && typeof variableValues === 'object') {
        templateVars.forEach((v: any) => {
          const rawValue = (variableValues as Record<string, unknown>)[v.name];
          if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
            normalizedVariableValues[v.name] = rawValue.trim();
          }
        });
      }

      const missingVars = templateVars.filter((v: any) => !normalizedVariableValues[v.name]);

      const overrideEmailsList = normalizeEmailList(overrideEmails);
      const baseEmails = overrideEmailsList.length > 0
        ? overrideEmailsList
        : normalizeEmailList(template.emailNotifications);
      const emails = (templateVars.length > 0 && missingVars.length > 0 && baseEmails.length === 0)
        ? [user.email]
        : baseEmails;

      const scheduleId = uuidv4();
      const scheduledChat: any = {
        scheduleId,
        taskId: 'global',
        userId: user.userId,
        frequency,
        ...(frequency === 'every_n_days' && { frequencyIntervalDays: interval }),
        scheduleName: scheduleName || template.name,
        description: template.description || '',
        startingMessage: template.startingMessage,
        keywords: template.keywords || [],
        requiredFunctionCalls: template.requiredFunctionCalls || [],
        functionCallMinCalls: template.functionCallMinCalls || {},
        emailNotifications: emails,
        dailyDigest: frequency === 'hourly' ? (template.dailyDigest || false) : false,
        status: 'active',
        nextRunTime: scheduledNextRunTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        sessionId: null,
        type: 'scheduled_chat',
        llmModel: overrideModel || template.llmModel || '',
        runCount: runCount !== undefined ? runCount : -1,
        variables: templateVars,
        variableValues: normalizedVariableValues,
        variableRequestStatus: missingVars.length > 0 ? 'pending' : (templateVars.length > 0 ? 'provided' : 'idle'),
      };

      await scheduleDb.createSchedule(scheduledChat);

      // Increment template usage count
      await scheduleTemplateDb.incrementUsageCount(templateId);

      res.status(201).json({
        scheduleId,
        message: 'Scheduled chat created from template successfully',
        nextRunTime: scheduledNextRunTime,
        templateId,
      });
    } catch (error) {
      console.error('AgentMode: Create schedule from template error:', error);
      res.status(500).json({ error: 'Failed to create schedule from template' });
    }
  },

  // POST /api/agent-mode/schedule-templates/:templateId/submit-for-review
  submitTemplateForReview: async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user as User;
      const { templateId } = req.params;

      const template = await scheduleTemplateDb.getTemplateById(templateId);
      if (!template || template.createdBy !== user.userId) {
        return res.status(404).json({ error: 'Template not found or not owned by you' });
      }
      if (template.visibility !== 'private') {
        return res.status(400).json({ error: 'Only private templates can be submitted for review' });
      }

      await scheduleTemplateDb.updateTemplate(templateId, {
        visibility: 'pending_review',
        reviewFeedback: '',
        updatedAt: new Date().toISOString(),
      });

      res.json({ message: 'Template submitted for review successfully' });
    } catch (error) {
      console.error('AgentMode: Submit template for review error:', error);
      res.status(500).json({ error: 'Failed to submit template for review' });
    }
  },
};
