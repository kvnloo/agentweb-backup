/**
 * API Tools — MCP tools that wrap the backend REST API via HTTP self-calls.
 *
 * Every tool goes through authenticateToken middleware by making an HTTP
 * request to localhost with a short-lived JWT. This eliminates the IDOR
 * surface that existed when tools called agentModeService directly.
 *
 * No direct service calls — all tools route through the REST API.
 */

import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { fetchMergedPRs, formatDigestText } from '../../services/prDigestService';

// ─── Helpers ────────────────────────────────────────────────────────────────

// ENG-982: `ctx` and `jsonResult` moved to ./toolHelpers so workflowTools.ts can
// share them instead of keeping a second copy. Behaviour unchanged.
import { ctx, jsonResult } from './toolHelpers';
import { publishWithdrawnMidFlight } from '../../utils/scheduledPublishConsentGuard';

function normalizeSkillQuery(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function skillTokens(value: unknown): string[] {
  return normalizeSkillQuery(value)
    .split(' ')
    .filter((token) => token && token !== 'skill' && token !== 'engine' && token !== 'workflow');
}

function scoreSkillMatch(skill: any, query: string): number {
  const normalizedQuery = normalizeSkillQuery(query);
  if (!normalizedQuery) return 0;

  const name = normalizeSkillQuery(skill?.name);
  const description = normalizeSkillQuery(skill?.description);
  const haystack = `${name} ${description}`;
  const tokens = skillTokens(query);

  let score = 0;
  if (name === normalizedQuery) score += 100;
  if (name.startsWith(normalizedQuery)) score += 70;
  if (name.includes(normalizedQuery)) score += 55;
  if (description.includes(normalizedQuery)) score += 25;

  for (const token of tokens) {
    if (name.split(' ').includes(token)) score += 12;
    else if (name.includes(token)) score += 8;
    else if (description.includes(token)) score += 4;
  }

  const matchedTokens = tokens.filter((token) => haystack.includes(token)).length;
  if (tokens.length > 0) score += Math.round((matchedTokens / tokens.length) * 20);

  return score;
}

function compactSkillMatch(skill: any, query: string) {
  return {
    skill_id: skill.skillId,
    name: skill.name,
    description: skill.description,
    ownerEmail: skill.ownerEmail,
    visibility: skill.visibility,
    isPublished: skill.isPublished,
    matchScore: scoreSkillMatch(skill, query),
  };
}

function resolveSkillInstruction(action: string) {
  return `skill_id is required for ${action}. Call resolve_skill with the user's skill name first, then retry manage_skill with the returned skill_id. Do not claim a skill is missing without resolve_skill evidence.`;
}

function skillResolution(matches: Array<{ matchScore: number }>) {
  if (matches.length === 0) return 'no_match';
  const [top, runnerUp] = matches;
  if (top.matchScore >= 100 || (top.matchScore >= 60 && (!runnerUp || top.matchScore >= runnerUp.matchScore + 25))) {
    return 'single_strong_match';
  }
  return 'multiple_matches';
}

function skillResolutionNextStep(resolution: string, canManageSkills: boolean) {
  if (resolution === 'single_strong_match') {
    return canManageSkills
      ? 'Use manage_skill with this skill_id after user confirmation for mutations.'
      : 'Use this compact match to answer lookup questions. Skill mutations require admin access.';
  }
  if (resolution === 'multiple_matches') {
    return 'Ask the user which skill_id to use before calling manage_skill.';
  }
  return 'Tell the user no matching skill was found and ask for a more specific skill name.';
}

async function getSkillResolverScope(context: any) {
  const userId = context?.userId;
  const isDelegatedAccess = context?.isDelegatedAccess === true;
  if (!userId) {
    return { scope: 'unauthenticated' as const, canManageSkills: false, skills: [] as any[] };
  }

  const { skillService } = await import('../../services/skillService');
  const { userDb, orgDb } = await import('../../services/db');
  const currentUser = await userDb.getUserById(userId);
  const canManageSkills = currentUser?.isAdmin === true || isDelegatedAccess;

  const enrichOwnerEmails = async (skills: any[]) => {
    const ownerIds = [...new Set(skills.map((s) => s.ownerId).filter(Boolean))];
    const ownerEntries = await Promise.all(ownerIds.map(async (ownerId) => {
      const owner = await userDb.getUserById(ownerId).catch(() => null);
      return [ownerId, owner?.email] as const;
    }));
    const ownerEmailById = new Map(ownerEntries.filter(([, email]) => Boolean(email)) as Array<[string, string]>);
    return skills.map((skill) => skill.ownerId && ownerEmailById.has(skill.ownerId)
      ? { ...skill, ownerEmail: ownerEmailById.get(skill.ownerId) }
      : skill
    );
  };

  if (canManageSkills) {
    const skills = await skillService.getAllSkills();
    return {
      scope: 'admin_visible' as const,
      canManageSkills: true,
      skills: await enrichOwnerEmails(skills),
    };
  }

  let accessibleOrgId: string | undefined;
  try {
    const { isFeatureEffectivelyEnabled } = await import('../../services/orgShareService');
    const candidateOrgId = currentUser?.orgId;
    if (candidateOrgId) {
      const org = await orgDb.getOrgById(candidateOrgId);
      const enabled = isFeatureEffectivelyEnabled(
        { userId, orgId: candidateOrgId, orgRole: currentUser?.orgRole },
        org,
        'skills',
      );
      if (enabled) accessibleOrgId = candidateOrgId;
    }
  } catch {
    accessibleOrgId = undefined;
  }

  const skills = await skillService.getSkillsAvailableToUser(userId, accessibleOrgId);
  return {
    scope: accessibleOrgId ? 'user_accessible_with_org' as const : 'user_accessible' as const,
    canManageSkills: false,
    skills: await enrichOwnerEmails(skills),
  };
}

// ─── Emma Chat Sessions ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_create_session',
  definition: {
    name: 'emma_create_session',
    description: 'Create a new Emma chat session — the entry point for handing work to Emma, a full GTM (go-to-market) automation agent. Delegate marketing and growth requests to Emma via emma_send_message; she autonomously plans and executes them using far more capability than these MCP tools expose directly. Do not infer from the visible tools whether a given request is supported — delegate it and let Emma determine feasibility.',
    inputSchema: {
      type: 'object',
      properties: {
        llm_model: { type: 'string', description: 'LLM model to use (optional)' }
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'POST', path: '/api/agent-mode/sessions', context: ctx(context), body: { llmModel: args.llm_model } });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'emma_send_message',
  definition: {
    name: 'emma_send_message',
    description: 'Send a message to an Emma chat session and get a response. Use this to delegate any marketing or growth request in natural language; Emma plans and executes it end to end with capabilities well beyond the tools listed here. Do not pre-judge from the visible tool set whether something is supported — hand the request to Emma. If a task genuinely cannot be done or needs a prerequisite (e.g. a connected account), Emma says so and explains what is needed; relay her response rather than declaring the capability unavailable yourself. If the response (or emma_get_session) shows an awaiting pendingUserQuestion (a blocking AskUserQuestion card), do NOT answer it by sending a plain message here — that abandons the question instead of answering it. Use emma_answer_question.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The chat session ID' },
        message: { type: 'string', description: 'The message to send' },
        llm_model: { type: 'string', description: 'LLM model to use (optional)' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Array of image URLs (S3 paths or public URLs) to attach to the message' }
      },
      required: ['session_id', 'message']
    }
  },
  execute: async (args: any, context: any) => {
    const body: any = { sessionId: args.session_id, userMessage: args.message, llmModel: args.llm_model };
    if (args.media_urls && args.media_urls.length > 0) {
      body.attachments = args.media_urls.map((url: string) => {
        const filename = url.split('/').pop()?.split('?')[0] || 'image';
        return { url, filename };
      });
    }
    const data = await mcpFetch({
      method: 'POST', path: '/api/agent-mode/generate', context: ctx(context),
      body
    });
    return jsonResult(data);
  }
});

// ENG-400: MCP transport for the ENG-396 AskUserQuestion primitive. Without
// this, a blocking objective card fired by Emma over MCP (Claude.ai driving
// `emma_send_message`) degrades to prose — the client sees `pendingUserQuestion`
// on emma_get_session but has no way to resolve it STRUCTURALLY, so a plain
// reply (e.g. "Leads") never reaches the answer channel and the write gate
// stays blocked forever (the one-live-question guard also prevents Emma from
// re-asking). This posts through the SAME structured `questionAnswer` channel
// the chat card uses — the gate's human-attribution guarantee is unchanged,
// it just has a second front door. Prose is NEVER accepted as an answer here
// either: a plain emma_send_message reply to an awaiting question still just
// abandons the card server-side (agentModeController.generateResponse), same
// as typing past the card in the web UI.
mcpToolRegistry.register({
  name: 'emma_answer_question',
  definition: {
    name: 'emma_answer_question',
    description:
      'Answer a blocking AskUserQuestion card on an Emma session (see pendingUserQuestion on emma_get_session) — the ONLY way to resolve one over MCP. Provide option_id for a direct pick, or delegate:true for "Let Emma decide" (takes the recommended option). A plain emma_send_message reply is NOT an answer — it abandons the open question instead, same as typing past the card in the chat UI.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The chat session ID with the awaiting question.' },
        question_id: { type: 'string', description: 'The pendingUserQuestion.questionId from emma_get_session — must match the currently awaiting question.' },
        option_id: { type: 'string', description: 'The chosen option id. Required unless delegate is true.' },
        delegate: { type: 'boolean', description: 'Set true for "Let Emma decide" — proceeds with the recommended option, logged as a delegation. option_id is ignored when true.' },
        label: { type: 'string', description: 'Optional human-readable text to show as the chat message for this selection (e.g. the option label). Defaults to option_id, or "Let Emma decide" when delegating.' },
      },
      required: ['session_id', 'question_id'],
    },
  },
  execute: async (args: any, context: any) => {
    const delegate = args.delegate === true;
    if (!delegate && (typeof args.option_id !== 'string' || args.option_id.trim() === '')) {
      return jsonResult({ success: false, message: 'option_id is required unless delegate is true.' });
    }
    const label = typeof args.label === 'string' && args.label.trim() !== ''
      ? args.label
      : delegate ? 'Let Emma decide' : args.option_id;

    const data = await mcpFetch({
      method: 'POST',
      path: '/api/agent-mode/generate',
      context: ctx(context),
      body: {
        sessionId: args.session_id,
        userMessage: label,
        questionAnswer: { questionId: args.question_id, optionId: args.option_id, delegated: delegate },
      },
    });
    return jsonResult(data);
  },
});

mcpToolRegistry.register({
  name: 'emma_get_session',
  definition: {
    name: 'emma_get_session',
    description: 'Get details of an Emma chat session by ID. Includes pendingUserQuestion when a blocking AskUserQuestion is awaiting or was recently answered — check its status before assuming a run has completed; resolve an "awaiting" one with emma_answer_question, never with a plain emma_send_message reply.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'The session ID' } },
      required: ['session_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/agent-mode/session/${args.session_id}`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'emma_list_sessions',
  definition: {
    name: 'emma_list_sessions',
    description: 'List all Emma chat sessions for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/agent-mode/sessions', context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_tasks',
  definition: {
    name: 'list_tasks',
    description: 'List all tasks owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/tasks', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_task',
  definition: {
    name: 'manage_task',
    description: 'Create, read, update, or delete a task. Use action: "create" (POST), "get" (GET), "update" (PUT), or "delete" (DELETE).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        task_id: { type: 'string', description: 'Task ID (required for get/update/delete)' },
        name: { type: 'string', description: 'Task name (create/update)' },
        prompt: { type: 'string', description: 'Task prompt (create/update)' },
        status: { type: 'string', description: 'Task status (update)' },
        category: { type: 'string', description: 'Task category (create/update)' },
        description: { type: 'string', description: 'Task description (create/update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const data = await mcpFetch({ method: 'POST', path: '/api/tasks', context: c, body: { name: args.name, prompt: args.prompt, category: args.category, description: args.description } });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/tasks/${args.task_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const { action, task_id, ...updates } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/tasks/${task_id}`, context: c, body: updates });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/tasks/${args.task_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'execute_task',
  definition: {
    name: 'execute_task',
    description: 'Queue a task for execution by the agent engine.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The task ID to execute' } },
      required: ['task_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'POST', path: `/api/tasks/${args.task_id}/execute`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'list_task_executions',
  definition: {
    name: 'list_task_executions',
    description: 'List execution history for a task, or get details of a specific execution.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        execution_id: { type: 'string', description: 'Specific execution ID (optional — omit to list all)' }
      },
      required: ['task_id']
    }
  },
  execute: async (args: any, context: any) => {
    const path = args.execution_id
      ? `/api/tasks/${args.task_id}/executions/${args.execution_id}`
      : `/api/tasks/${args.task_id}/executions`;
    const data = await mcpFetch({ method: 'GET', path, context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── Schedules ──────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_schedules',
  definition: {
    name: 'list_schedules',
    description: 'List schedules for a task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The task ID' } },
      required: ['task_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/schedules/task/${args.task_id}`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_schedule',
  definition: {
    name: 'manage_schedule',
    description: 'Create, update, or delete a schedule. Use action: "create" (POST), "update" (PUT), or "delete" (DELETE).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'CRUD action' },
        schedule_id: { type: 'string', description: 'Schedule ID (required for update/delete)' },
        task_id: { type: 'string', description: 'Task ID (required for create)' },
        frequency: { type: 'string', description: 'Schedule frequency: daily, weekly, monthly, or cron expression' },
        next_run_time: { type: 'string', description: 'ISO 8601 datetime for the first/next run' },
        schedule_name: { type: 'string', description: 'Schedule name' },
        description: { type: 'string', description: 'Description' },
        timezone: { type: 'string', description: 'Timezone (e.g. America/Los_Angeles)' },
        status: { type: 'string', description: 'Status (active or inactive, update only)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const data = await mcpFetch({
          method: 'POST', path: '/api/schedules', context: c,
          body: {
            taskId: args.task_id, frequency: args.frequency,
            nextRunTime: args.next_run_time, scheduleName: args.schedule_name,
            description: args.description, timezone: args.timezone
          }
        });
        return jsonResult(data);
      }
      case 'update': {
        const { action, schedule_id, ...updates } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/schedules/${schedule_id}`, context: c, body: updates });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/schedules/${args.schedule_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── Scheduled Chats ─────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_scheduled_chats',
  definition: {
    name: 'list_scheduled_chats',
    description: 'List all scheduled chats for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/agent-mode/scheduled-chats', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_scheduled_chat',
  definition: {
    name: 'manage_scheduled_chat',
    description: 'Create, update, toggle (pause/resume), or delete a scheduled chat. Use action: "create", "update", "toggle", or "delete". For "create": schedule_name, starting_message, and schedule_frequency are REQUIRED — do not call with action "create" unless you have all three. email_notifications is optional but strongly recommended — without it, the user gets no automatic notification when a run completes. For "update": schedule_id is required; omit any field to keep its existing value — if you provide email_notifications it must be non-empty. IMPORTANT: When email_notifications is configured on the schedule, the system automatically emails results after every run — do NOT include notify_session or any email-sending instruction in starting_message, as that would cause duplicate emails (one from the system, one from the AI executing the tool).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'toggle', 'delete'], description: 'CRUD action' },
        schedule_id: { type: 'string', description: 'Schedule ID (required for update/toggle/delete)' },
        schedule_name: { type: 'string', description: 'Schedule name (REQUIRED for create, optional for update)' },
        starting_message: { type: 'string', description: 'The prompt/message to run on each execution (REQUIRED for create, optional for update). IMPORTANT: Do NOT include notify_session or any instruction to send an email in this prompt when email_notifications is set — the system already sends emails automatically, and adding notify_session here will cause duplicate emails.' },
        schedule_frequency: { type: 'string', description: 'Frequency: hourly, daily, weekly, monthly, every_n_days (REQUIRED for create, optional for update)' },
        frequency_interval_days: { type: 'number', description: 'Number of days between runs when schedule_frequency is every_n_days (create/update)' },
        next_run_time: { type: 'string', description: 'ISO 8601 datetime for the first/next run (create/update)' },
        description: { type: 'string', description: 'Description (create/update)' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to look for in results (create/update)' },
        required_function_calls: { type: 'array', items: { type: 'string' }, description: 'Function calls required in each run (create/update)' },
        function_call_min_calls: { type: 'object', description: 'Minimum call counts per function (create/update)' },
        email_notifications: { type: 'array', items: { type: 'string' }, description: 'Email addresses for notifications (optional for create/update but strongly recommended — without it, the user gets no automatic notification when a run completes; if provided, must be non-empty)' },
        daily_digest: { type: 'boolean', description: 'Send daily digest instead of per-run emails (create/update, hourly only)' },
        self_improve: { type: 'boolean', description: 'When true, after each run a reflection turn reviews the result and may automatically refine starting_message so future runs do better. Off by default (create/update).' },
        run_count: { type: 'number', description: 'Number of runs (-1 for unlimited, create/update)' },
        variables: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] }, description: 'Variable definitions for the starting message (create/update)' },
        variable_values: { type: 'object', description: 'Initial variable values (create/update)' },
        llm_model: { type: 'string', description: 'LLM model to use (create/update)' },
        session_id: { type: 'string', description: 'Existing chat session ID to base the schedule on (create only)' },
        revoke_autopublish: { type: 'boolean', description: 'Set true to STOP this schedule publishing to the user\'s live connected accounts on its unattended runs, so future runs draft the content and tell them what is waiting instead. Revoking is always safe and always allowed. You CANNOT turn it back on — that means posts go live without the user ever seeing them, so only they can do it, on the schedule form. If a user asks you to enable automatic posting, point them there and never claim you have enabled it.' },
        status: { type: 'string', enum: ['active', 'paused'], description: 'Status (toggle only)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const body: any = {
          scheduleName: args.schedule_name,
          startingMessage: args.starting_message,
          scheduleFrequency: args.schedule_frequency,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.frequency_interval_days !== undefined) body.frequencyIntervalDays = args.frequency_interval_days;
        if (args.next_run_time !== undefined) body.nextRunTime = args.next_run_time;
        if (args.keywords !== undefined) body.keywords = args.keywords;
        if (args.required_function_calls !== undefined) body.requiredFunctionCalls = args.required_function_calls;
        if (args.function_call_min_calls !== undefined) body.functionCallMinCalls = args.function_call_min_calls;
        if (args.email_notifications !== undefined) body.emailNotifications = args.email_notifications;
        if (args.daily_digest !== undefined) body.dailyDigest = args.daily_digest;
        if (args.self_improve !== undefined) body.selfImprove = args.self_improve;
        if (args.run_count !== undefined) body.runCount = args.run_count;
        if (args.variables !== undefined) body.variables = args.variables;
        if (args.variable_values !== undefined) body.variableValues = args.variable_values;
        if (args.llm_model !== undefined) body.llmModel = args.llm_model;
        if (args.session_id !== undefined) body.sessionId = args.session_id;
        const data = await mcpFetch({ method: 'POST', path: '/api/agent-mode/scheduled-chats', context: c, body });
        return jsonResult(data);
      }
      case 'update': {
        const body: any = {
          scheduleName: args.schedule_name,
          startingMessage: args.starting_message,
          scheduleFrequency: args.schedule_frequency,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.frequency_interval_days !== undefined) body.frequencyIntervalDays = args.frequency_interval_days;
        if (args.next_run_time !== undefined) body.nextRunTime = args.next_run_time;
        if (args.keywords !== undefined) body.keywords = args.keywords;
        if (args.required_function_calls !== undefined) body.requiredFunctionCalls = args.required_function_calls;
        if (args.function_call_min_calls !== undefined) body.functionCallMinCalls = args.function_call_min_calls;
        if (args.email_notifications !== undefined) body.emailNotifications = args.email_notifications;
        if (args.daily_digest !== undefined) body.dailyDigest = args.daily_digest;
        if (args.self_improve !== undefined) body.selfImprove = args.self_improve;
        if (args.run_count !== undefined) body.runCount = args.run_count;
        if (args.variables !== undefined) body.variables = args.variables;
        if (args.variable_values !== undefined) body.variableValues = args.variable_values;
        if (args.llm_model !== undefined) body.llmModel = args.llm_model;

        // ENG-827: the publish setting never travels on this generic body — that route
        // ignores it, so a revoke sent there would be silently dropped. It goes to the
        // dedicated revoke-only endpoint, and it goes FIRST: if the ordinary update then
        // fails, the schedule is already in the SAFER (not publishing) state. Revoking
        // afterwards would leave publishing enabled whenever the second call failed.
        //
        // ONE DIRECTION ONLY. The endpoint rejects anything but `authorized: false`, so
        // no argument the model can pass turns publishing on. Do not name the underlying
        // schedule field anywhere in this file — a source-scanning test
        // (schedulePublishApproval.mcpGuard.test.ts) enforces that it stays unwritable
        // through the generic surface.
        let publishConsent: any;
        if (args.revoke_autopublish === true) {
          publishConsent = await mcpFetch({
            method: 'POST',
            path: `/api/agent-mode/scheduled-chats/${args.schedule_id}/publish-consent`,
            context: c,
            body: { authorized: false },
          });
        }

        const data = await mcpFetch({ method: 'PUT', path: `/api/agent-mode/scheduled-chats/${args.schedule_id}`, context: c, body });
        return jsonResult(publishConsent ? { ...(data as any), publishConsent } : data);
      }
      case 'toggle': {
        const data = await mcpFetch({ method: 'PATCH', path: `/api/agent-mode/scheduled-chats/${args.schedule_id}/toggle`, context: c, body: { status: args.status } });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/agent-mode/scheduled-chats/${args.schedule_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'test_scheduled_chat',
  definition: {
    name: 'test_scheduled_chat',
    description: 'Trigger a test run of a scheduled chat. This is a side-effecting action — only call it when the user has EXPLICITLY asked to test or run the schedule now. Do NOT trigger a test run on your own initiative, and do NOT treat a bare "retry"/regenerate of your previous turn as authorization to run a test; in that case simply re-answer the prior turn. Variables must already be set on the schedule. Returns immediately with a runId — the run executes in the background and can take several minutes for complex tasks. After calling this, wait ~30 seconds then poll get_scheduled_chat_test_history to check for a result matching the returned runId.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'The scheduled chat ID to test' },
        send_notification_email: { type: 'boolean', description: 'Whether to send notification emails with the test results (default false)' }
      },
      required: ['schedule_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: `/api/agent-mode/scheduled-chats/${args.schedule_id}/test`, context: ctx(context),
      body: { sendNotificationEmail: args.send_notification_email || false }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_scheduled_chat_test_history',
  definition: {
    name: 'get_scheduled_chat_test_history',
    description: 'Get test and run history for a scheduled chat.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'The scheduled chat ID' }
      },
      required: ['schedule_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/agent-mode/scheduled-chats/${args.schedule_id}/test-history`, context: ctx(context) });
    // A test run started via test_scheduled_chat executes in the background and can take
    // several minutes. When the history is still empty, returning a bare `[]` leads the model
    // to report "empty results" to the user as if the run finished with nothing. Instead,
    // surface an actionable diagnostic so the model waits/polls or checks the variables.
    if (Array.isArray(data) && data.length === 0) {
      return jsonResult({
        history: [],
        note: 'No test/run results are available yet for this scheduled chat. A test run triggered '
          + 'via test_scheduled_chat executes in the background and can take several minutes, so it '
          + 'may still be running. Wait ~30 seconds and poll get_scheduled_chat_test_history again '
          + 'with the same schedule_id. If results are still empty after a few polls, the schedule may '
          + 'be missing required variable values (check with list_scheduled_chats and set them via '
          + 'submit_scheduled_chat_variables) or may not have been run yet. Do NOT report this empty '
          + 'result to the user as a finished or failed run — explain that the run is still in progress '
          + 'or that variables/setup need to be confirmed.',
      });
    }
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'submit_scheduled_chat_variables',
  definition: {
    name: 'submit_scheduled_chat_variables',
    description: 'Submit variable values for a scheduled chat. Optionally trigger an immediate run after submission.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'The scheduled chat ID' },
        variable_values: { type: 'object', description: 'Object mapping variable names to their values' },
        trigger_run: { type: 'boolean', description: 'Whether to trigger a run immediately after submitting variables (default false)' }
      },
      required: ['schedule_id', 'variable_values']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: `/api/agent-mode/scheduled-chats/${args.schedule_id}/variables`, context: ctx(context),
      body: {
        variableValues: args.variable_values,
        triggerRun: args.trigger_run || false,
      }
    });
    return jsonResult(data);
  }
});

// ─── Schedule Templates ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_schedule_templates',
  definition: {
    name: 'list_schedule_templates',
    description: 'List all schedule templates available to the user (their own private templates + all platform-wide templates). Schedule templates are reusable blueprints for creating scheduled chats.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/agent-mode/schedule-templates', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_schedule_template',
  definition: {
    name: 'manage_schedule_template',
    description: 'Create, update, or delete a schedule template. Templates are reusable blueprints for scheduled chats that can be shared across the platform.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'CRUD action' },
        template_id: { type: 'string', description: 'Template ID (required for update/delete)' },
        name: { type: 'string', description: 'Template name (create/update)' },
        description: { type: 'string', description: 'Template description (create/update)' },
        category: { type: 'string', description: 'Template category e.g. SEO, Social, Email, Content, Analytics, General (create/update)' },
        visibility: { type: 'string', enum: ['system', 'private', 'public', 'pending_review'], description: 'Visibility: system (admin-created, always visible), private (only visible to creator), public (approved, visible to all), pending_review (submitted for admin review). Default: private. (create/update)' },
        starting_message: { type: 'string', description: 'The prompt/message template. Use {{variable_name}} for variables. (create/update)' },
        variables: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, type: { type: 'string', enum: ['text', 'long_text', 'file'] } }, required: ['name'] }, description: 'Variable definitions (auto-extracted from message if not provided)' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to verify in scheduled chat output (create/update)' },
        required_function_calls: { type: 'array', items: { type: 'string' }, description: 'Function calls required in each run (create/update)' },
        function_call_min_calls: { type: 'object', description: 'Minimum call counts per function (create/update)' },
        suggested_frequency: { type: 'string', description: 'Suggested frequency: hourly, daily, weekly, monthly, every_n_days (create/update)' },
        frequency_interval_days: { type: 'number', description: 'Days between runs when suggested_frequency is every_n_days (create/update)' },
        email_notifications: { type: 'array', items: { type: 'string' }, description: 'Default email addresses for notifications (create/update)' },
        daily_digest: { type: 'boolean', description: 'Default daily digest setting (create/update)' },
        llm_model: { type: 'string', description: 'Default LLM model (create/update)' },
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const body: any = {
          name: args.name,
          startingMessage: args.starting_message,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.category !== undefined) body.category = args.category;
        if (args.visibility !== undefined) body.visibility = args.visibility;
        if (args.variables !== undefined) body.variables = args.variables;
        if (args.keywords !== undefined) body.keywords = args.keywords;
        if (args.required_function_calls !== undefined) body.requiredFunctionCalls = args.required_function_calls;
        if (args.function_call_min_calls !== undefined) body.functionCallMinCalls = args.function_call_min_calls;
        if (args.suggested_frequency !== undefined) body.suggestedFrequency = args.suggested_frequency;
        if (args.frequency_interval_days !== undefined) body.frequencyIntervalDays = args.frequency_interval_days;
        if (args.email_notifications !== undefined) body.emailNotifications = args.email_notifications;
        if (args.daily_digest !== undefined) body.dailyDigest = args.daily_digest;
        if (args.llm_model !== undefined) body.llmModel = args.llm_model;
        const data = await mcpFetch({ method: 'POST', path: '/api/agent-mode/schedule-templates', context: c, body });
        return jsonResult(data);
      }
      case 'update': {
        const body: any = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.description !== undefined) body.description = args.description;
        if (args.category !== undefined) body.category = args.category;
        if (args.visibility !== undefined) body.visibility = args.visibility;
        if (args.starting_message !== undefined) body.startingMessage = args.starting_message;
        if (args.variables !== undefined) body.variables = args.variables;
        if (args.keywords !== undefined) body.keywords = args.keywords;
        if (args.required_function_calls !== undefined) body.requiredFunctionCalls = args.required_function_calls;
        if (args.function_call_min_calls !== undefined) body.functionCallMinCalls = args.function_call_min_calls;
        if (args.suggested_frequency !== undefined) body.suggestedFrequency = args.suggested_frequency;
        if (args.frequency_interval_days !== undefined) body.frequencyIntervalDays = args.frequency_interval_days;
        if (args.email_notifications !== undefined) body.emailNotifications = args.email_notifications;
        if (args.daily_digest !== undefined) body.dailyDigest = args.daily_digest;
        if (args.llm_model !== undefined) body.llmModel = args.llm_model;
        const data = await mcpFetch({ method: 'PUT', path: `/api/agent-mode/schedule-templates/${args.template_id}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/agent-mode/schedule-templates/${args.template_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'create_schedule_from_template',
  definition: {
    name: 'create_schedule_from_template',
    description: 'Create a new scheduled chat from a schedule template. The template provides the prompt, variables, keywords, and other defaults. You can override frequency, notifications, and provide variable values.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'The template ID to create from' },
        schedule_name: { type: 'string', description: 'Name for the new scheduled chat (defaults to template name)' },
        schedule_frequency: { type: 'string', description: 'Override frequency: hourly, daily, weekly, monthly, every_n_days' },
        frequency_interval_days: { type: 'number', description: 'Override days between runs for every_n_days' },
        next_run_time: { type: 'string', description: 'ISO 8601 datetime for the first run' },
        email_notifications: { type: 'array', items: { type: 'string' }, description: 'Override notification emails' },
        variable_values: { type: 'object', description: 'Variable values for the template placeholders' },
        run_count: { type: 'number', description: 'Number of runs (-1 for unlimited)' },
        llm_model: { type: 'string', description: 'Override LLM model' },
      },
      required: ['template_id']
    }
  },
  execute: async (args: any, context: any) => {
    const body: any = {};
    if (args.schedule_name !== undefined) body.scheduleName = args.schedule_name;
    if (args.schedule_frequency !== undefined) body.scheduleFrequency = args.schedule_frequency;
    if (args.frequency_interval_days !== undefined) body.frequencyIntervalDays = args.frequency_interval_days;
    if (args.next_run_time !== undefined) body.nextRunTime = args.next_run_time;
    if (args.email_notifications !== undefined) body.emailNotifications = args.email_notifications;
    if (args.variable_values !== undefined) body.variableValues = args.variable_values;
    if (args.run_count !== undefined) body.runCount = args.run_count;
    if (args.llm_model !== undefined) body.llmModel = args.llm_model;
    const data = await mcpFetch({ method: 'POST', path: `/api/agent-mode/schedule-templates/${args.template_id}/use`, context: ctx(context), body });
    return jsonResult(data);
  }
});

// ─── CRM / Leads ────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_lead_lists',
  definition: {
    name: 'list_lead_lists',
    description: 'List all lead lists for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/crm/lists', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'create_lead_list',
  definition: {
    name: 'create_lead_list',
    description: 'Create, update, or delete a lead list. Use action: "create", "get", "update", or "delete".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        list_id: { type: 'string', description: 'List ID (required for get/update/delete)' },
        name: { type: 'string', description: 'List name (create/update)' },
        description: { type: 'string', description: 'List description (create/update)' },
        list_type: { type: 'string', description: 'List type (create only)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const data = await mcpFetch({ method: 'POST', path: '/api/crm/lists', context: c, body: { name: args.name, description: args.description, listType: args.list_type } });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${args.list_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const data = await mcpFetch({ method: 'PUT', path: `/api/crm/lists/${args.list_id}`, context: c, body: { name: args.name, description: args.description } });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/crm/lists/${args.list_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'manage_leads',
  definition: {
    name: 'manage_leads',
    description: 'Add, get, update, or delete leads in a list. Use action: "add", "get", "update", "delete", or "list".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'get', 'update', 'delete'], description: 'Action to perform' },
        list_id: { type: 'string', description: 'The lead list ID' },
        lead_id: { type: 'string', description: 'Lead ID (for get/update)' },
        leads: { type: 'array', description: 'Array of lead objects to add (for add action)' },
        lead_ids: { type: 'array', items: { type: 'string' }, description: 'Lead IDs to delete (for delete action)' },
        updates: { type: 'object', description: 'Fields to update (for update action)' },
        limit: { type: 'number', description: 'Max leads to return (list action)' },
        last_key: { type: 'string', description: 'Pagination key (list action)' }
      },
      required: ['action', 'list_id']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    const listId = args.list_id;
    switch (args.action) {
      case 'list': {
        const qp: Record<string, string> = {};
        if (args.limit) qp.limit = String(args.limit);
        if (args.last_key) qp.lastKey = args.last_key;
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${listId}/leads`, context: c, queryParams: qp });
        return jsonResult(data);
      }
      case 'add': {
        const data = await mcpFetch({ method: 'POST', path: `/api/crm/lists/${listId}/leads`, context: c, body: { leads: args.leads } });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${listId}/leads/${args.lead_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const data = await mcpFetch({ method: 'PUT', path: `/api/crm/lists/${listId}/leads/${args.lead_id}`, context: c, body: args.updates });
        return jsonResult(data);
      }
      case 'delete': {
        // Delete uses the single-lead endpoint if one ID, or we need to call per-lead
        if (args.lead_ids && args.lead_ids.length === 1) {
          const data = await mcpFetch({ method: 'DELETE', path: `/api/crm/lists/${listId}/leads/${args.lead_ids[0]}`, context: c });
          return jsonResult(data);
        }
        // For multiple deletes, call individually
        const results = [];
        for (const leadId of (args.lead_ids || [])) {
          const data = await mcpFetch({ method: 'DELETE', path: `/api/crm/lists/${listId}/leads/${leadId}`, context: c });
          results.push(data);
        }
        return jsonResult({ deleted: args.lead_ids?.length || 0, results });
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'search_leads',
  definition: {
    name: 'search_leads',
    description: 'Search leads across lists using structured filters.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list ID to search in' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string' },
              value: {}
            },
            required: ['field', 'operator']
          },
          description: 'Array of filter conditions'
        },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' }
      },
      required: ['list_id', 'filters']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/search-leads', context: ctx(context),
      body: { list_id: args.list_id, filters: args.filters, limit: args.limit }
    });
    return jsonResult(data);
  }
});

// ─── GTM Plans ──────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_gtm_plans',
  definition: {
    name: 'list_gtm_plans',
    description: 'List all GTM plans for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/gtm-plan', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_gtm_plan',
  definition: {
    name: 'manage_gtm_plan',
    description: 'Create, read, update, or delete a GTM plan. Use action: "create", "get", "update", or "delete".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        plan_id: { type: 'string', description: 'Plan ID (required for get/update/delete)' },
        title: { type: 'string', description: 'Plan title (create/update)' },
        description: { type: 'string', description: 'Plan description (create/update)' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Plan goals (create/update)' },
        target_audience: { type: 'string', description: 'Target audience (create/update)' },
        timeline: { type: 'string', description: 'Timeline (create/update)' },
        budget: { type: 'string', description: 'Budget (create/update)' },
        status: { type: 'string', description: 'Plan status (update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const { action, plan_id, ...body } = args;
        const data = await mcpFetch({ method: 'POST', path: '/api/gtm-plan', context: c, body });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/gtm-plan/${args.plan_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const { action, plan_id, ...body } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/gtm-plan/${plan_id}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/gtm-plan/${args.plan_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'manage_gtm_items',
  definition: {
    name: 'manage_gtm_items',
    description: 'Manage GTM plan phases and work items. Use action: "add_phase", "update_phase", "delete_phase", "add_work_items", "update_work_item", "delete_work_item", "get_common_items", "add_common_items", or "send_status_report".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform' },
        plan_id: { type: 'string', description: 'Plan ID' },
        phase_id: { type: 'string', description: 'Phase ID' },
        work_item_id: { type: 'string', description: 'Work item ID' },
        name: { type: 'string', description: 'Phase/item name' },
        description: { type: 'string', description: 'Description' },
        status: { type: 'string', description: 'Status' },
        work_items: { type: 'array', description: 'Array of work item objects' },
        items: { type: 'array', description: 'Common items to add' },
        target_phase_id: { type: 'string', description: 'Target phase for common items' },
        new_phase_name: { type: 'string', description: 'New phase name for common items' },
        include_summary: { type: 'boolean', description: 'Include summary in status report' },
        include_details: { type: 'boolean', description: 'Include details in status report' }
      },
      required: ['action', 'plan_id']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    const { plan_id, phase_id, work_item_id } = args;
    switch (args.action) {
      case 'add_phase': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${plan_id}/phases`, context: c,
          body: { name: args.name, description: args.description, status: args.status }
        });
        return jsonResult(data);
      }
      case 'update_phase': {
        const data = await mcpFetch({
          method: 'PUT', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}`, context: c,
          body: { name: args.name, description: args.description, status: args.status }
        });
        return jsonResult(data);
      }
      case 'delete_phase': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}`, context: c });
        return jsonResult(data);
      }
      case 'add_work_items': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}/work-items`, context: c,
          body: { workItems: args.work_items }
        });
        return jsonResult(data);
      }
      case 'update_work_item': {
        const { action: _a, plan_id: _p, phase_id: _ph, work_item_id: _w, ...updates } = args;
        const data = await mcpFetch({
          method: 'PUT', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}/work-items/${work_item_id}`, context: c,
          body: updates
        });
        return jsonResult(data);
      }
      case 'delete_work_item': {
        const data = await mcpFetch({
          method: 'DELETE', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}/work-items/${work_item_id}`, context: c
        });
        return jsonResult(data);
      }
      case 'get_common_items': {
        const data = await mcpFetch({ method: 'GET', path: '/api/gtm-plan/common-items', context: c });
        return jsonResult(data);
      }
      case 'add_common_items': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${plan_id}/add-common-items`, context: c,
          body: { items: args.items, targetPhaseId: args.target_phase_id, newPhaseName: args.new_phase_name }
        });
        return jsonResult(data);
      }
      case 'send_status_report': {
        const path = phase_id
          ? `/api/gtm-plan/${plan_id}/phases/${phase_id}/send-status-report`
          : `/api/gtm-plan/${plan_id}/send-status-report`;
        const data = await mcpFetch({
          method: 'POST', path, context: c,
          body: { includeSummary: args.include_summary, includeDetails: args.include_details }
        });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── Knowledge Base ─────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_knowledge_bases',
  definition: {
    name: 'list_knowledge_bases',
    description: 'List all knowledge base files for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/emma/knowledge-bases', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'search_knowledge_base',
  definition: {
    name: 'search_knowledge_base',
    description: 'Search the knowledge base for relevant information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Max results (default 5)', default: 5 }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/search-knowledge-base', context: ctx(context),
      body: { query: args.query, max_results: args.max_results || 5 }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'read_knowledge_base_files',
  definition: {
    name: 'read_knowledge_base_files',
    description: 'Read specific files from the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kb_identifier: { type: 'string', description: 'Knowledge base task ID' },
              file_name: { type: 'string', description: 'File name to read' }
            },
            required: ['kb_identifier', 'file_name']
          }
        }
      },
      required: ['files']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/read-knowledge-base-files', context: ctx(context),
      body: { files: args.files }
    });
    return jsonResult(data);
  }
});

// ─── Brand & Strategy ───────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'manage_brand',
  definition: {
    name: 'manage_brand',
    description: 'Read or update brand guidelines. Use action: "read" or "update".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'Action' },
        company_name: { type: 'string', description: 'Company name (update)' },
        mission: { type: 'string', description: 'Mission statement (update)' },
        tone_of_voice: { type: 'string', description: 'Tone of voice (update)' },
        target_audience: { type: 'string', description: 'Target audience (update)' },
        key_messages: { type: 'array', items: { type: 'string' }, description: 'Key messages (update)' },
        visual_identity: { type: 'object', description: 'Visual identity settings (update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    if (args.action === 'read') {
      const data = await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c });
      return jsonResult(data);
    }
    const { action, ...body } = args;
    const data = await mcpFetch({ method: 'POST', path: '/api/brand/guidelines', context: c, body });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_market_strategy',
  definition: {
    name: 'manage_market_strategy',
    description: 'Read or update market strategy. Use action: "read" or "update".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'Action' },
        positioning: { type: 'string', description: 'Market positioning (update)' },
        competitors: { type: 'array', description: 'Competitor list (update)' },
        differentiators: { type: 'array', items: { type: 'string' }, description: 'Key differentiators (update)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Marketing channels (update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    if (args.action === 'read') {
      const data = await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c });
      return jsonResult(data);
    }
    const { action, ...body } = args;
    const data = await mcpFetch({ method: 'POST', path: '/api/market-strategy', context: c, body });
    return jsonResult(data);
  }
});

// ─── Content (internal tools — call agentModeService directly) ──────────────

mcpToolRegistry.register({
  name: 'create_blog_article',
  internal: true,
  // ENG-974: outbound action — hidden AND refused for external MCP callers.
  internalOnly: true,
  definition: {
    name: 'create_blog_article',
    description: 'Create a complete blog article with content, images, and HTML file. Takes a title draft and content draft in markdown format, creates a hero image, and produces a complete HTML file uploaded to S3.',
    inputSchema: {
      type: 'object',
      properties: {
        title_draft: { type: 'string', 'x-aliases': ['title', 'headline', 'subject'], description: 'A draft title for the blog article.' },
        content_draft: { type: 'string', 'x-aliases': ['content', 'body', 'text', 'markdown', 'article_content'], description: 'The blog article content in markdown format' },
        length: { type: 'string', enum: ['short', 'medium', 'long'], description: 'Desired article length', default: 'medium' },
        researchContext: { type: 'string', description: 'Optional research context or background information' },
        requirements: { type: 'string', description: 'Specific requirements (e.g., internal links, CTAs, branding)' },
        style: { type: 'string', enum: ['default', 'substack'], description: 'Writing style. "substack" for newsletter-like personal tone.', default: 'default' },
        deep_research: { type: 'boolean', description: 'When true, performs deep research and includes inline images. Takes several minutes.', default: false }
      },
      required: ['title_draft', 'content_draft']
    }
  },
  execute: async (args: any, context: any) => {
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.createBlogArticle(
      args.title_draft, args.content_draft, args.length || 'medium',
      args.researchContext || '', args.requirements || '',
      context?.userId, context?.sessionId,
      args.style || 'default', args.deep_research || false
    );
  }
});

mcpToolRegistry.register({
  name: 'publish_blog_article',
  internal: true,
  // ENG-974: outbound action — hidden AND refused for external MCP callers.
  internalOnly: true,
  definition: {
    name: 'publish_blog_article',
    description: 'Publish a blog article to CMS (Basehub or Webflow). Takes title, description, hero image URL, and blog HTML URL from create_blog_article. CRITICAL: Always review with user before publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title' },
        description: { type: 'string', description: 'Article description/meta description' },
        hero_image_url: { type: 'string', description: 'URL of the hero image' },
        blog_html_url: { type: 'string', description: 'URL of the HTML file from create_blog_article' },
        status: { type: 'string', enum: ['draft', 'published'], description: 'Publication status', default: 'draft' },
        author: { type: 'string', description: 'Optional author name or ID' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Blog categories (required when status is "published")' }
      },
      required: ['title', 'description', 'hero_image_url', 'blog_html_url']
    }
  },
  execute: async (args: any, context: any) => {
    // ENG-827: last moment before the article goes live on the CMS.
    const withdrawn = await publishWithdrawnMidFlight(context);
    if (withdrawn) return { success: false, message: withdrawn.error };
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.publishBlogArticle(
      args.title, args.description, args.hero_image_url, args.blog_html_url,
      context?.userId, context?.sessionId,
      args.status, args.author, args.categories,
      // The check above guards entry; this one rides through the HTML fetch inside.
      context?.assertPublishStillAuthorized
    );
  }
});

// ─── Connected Accounts ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: 'List all connected social media and integration accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Filter by platform (e.g., "linkedin", "meta", "unipile")' }
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const qp: Record<string, string> = {};
    if (args.platform) qp.platform = args.platform;
    const data = await mcpFetch({ method: 'GET', path: '/api/oauth/connected-accounts', context: ctx(context), queryParams: qp });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'post_on_account',
  definition: {
    name: 'post_on_account',
    description: 'Post content on a connected social media account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Connected account ID' },
        content: { type: 'string', description: 'Post content' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Optional media URLs' }
      },
      required: ['account_id', 'content']
    }
  },
  execute: async (args: any, context: any) => {
    // ENG-827: last in-process moment before this becomes a live post.
    const withdrawn = await publishWithdrawnMidFlight(context);
    if (withdrawn) return jsonResult({ success: false, message: withdrawn.error });
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/post-on-account', context: ctx(context),
      body: { account_id: args.account_id, content: args.content, media_urls: args.media_urls || [] }
    });
    return jsonResult(data);
  }
});

// ─── Landing Pages (v0) ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'generate_landing_page',
  definition: {
    name: 'generate_landing_page',
    description: 'Generate AND deploy a production landing page in one step. This tool sends brand guidelines + prompt to v0, which generates a polished React/Next.js site, pushes it to a private GitHub repo, and deploys to Vercel automatically. Returns the live URL when done. PREREQUISITE: Before calling this tool, you MUST have: 1. Called read_brand_guidelines to get brand data, 2. Called create_lead_list to create a lead list named "LP Leads - {page name}" for the contact form, 3. Called enable_lead_list_public_access to enable public form capture. Pass the lead list ID as lead_list_id. Include all brand details in the prompt for best results. Do NOT call deploy_landing_page after this — deployment is automatic.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the landing page including brand colors, fonts, tone, sections, copy guidance, and any specific requirements. The more detail, the better v0 output.' },
        name: { type: 'string', description: 'Optional display name for the page' },
        lead_list_id: { type: 'string', description: 'ID of the CRM lead list for the contact form (from create_lead_list)' },
        template_id: { type: 'string', description: 'Optional ID of a saved landing page template to use as design inspiration (from list_html_templates with type=landing_page)' },
        site_id: { type: 'string', description: 'Optional. The id of an existing landing page/site to add this page to — use for a variant or sub-page that should live under that site\'s existing URL.' },
        mode: { type: 'string', enum: ['unified', 'separate'], description: 'How to place a NEW page when site_id is not given. "unified" (default, cheaper): add it to the user\'s existing site as a page under the shared subdomain — only their first page does a full generation. "separate": give this campaign its OWN site and distinct URL — this costs more (a fresh full generation each time). Only choose "separate" when the user explicitly wants this campaign on a separate URL, and tell them it uses more of their generation budget first. When unsure, omit this and let the default (unified) apply.' }
      },
      required: ['prompt']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/landing-pages/v0/generate', context: ctx(context),
      body: { prompt: args.prompt, name: args.name, lead_list_id: args.lead_list_id, template_id: args.template_id, site_id: args.site_id, mode: args.mode, originating_session_id: context?.sessionId },
      timeoutMs: 25 * 60 * 1000, // 25 minutes — v0 generation + GitHub + Vercel deploy (extra headroom vs 15 min default)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'deploy_landing_page',
  definition: {
    name: 'deploy_landing_page',
    description: 'Retry deploying a landing page that failed during deployment. Only use this if generate_landing_page returned a failed status. Do NOT call this after a successful generate — deployment is already included in generate_landing_page.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The generated landing page ID' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: `/api/landing-pages/v0/generated/${args.page_id}/deploy`, context: ctx(context),
      body: {},
      timeoutMs: 25 * 60 * 1000, // 25 minutes — GitHub + Vercel deploy (extra headroom)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'iterate_landing_page',
  definition: {
    name: 'iterate_landing_page',
    description: 'Refine a generated landing page with follow-up instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The generated landing page ID' },
        message: { type: 'string', description: 'Instructions for how to refine the page' }
      },
      required: ['page_id', 'message']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: `/api/landing-pages/v0/generated/${args.page_id}/iterate`, context: ctx(context),
      body: { message: args.message },
      // An iteration is a full v0 generation round — it takes as long as a build. This passed
      // NO timeout, so it fell back to the ~5-min default and aborted while v0 was still
      // working. Matched to generate_landing_page. Note the global undici headersTimeout
      // (15 min, mcp/server/httpClient.ts) is the real ceiling above this; past that the call
      // still aborts, but the edit lands and the record is left deployable, so the user can
      // finish from the portal instead of losing the edit. (ENG-287 follow-up)
      timeoutMs: 25 * 60 * 1000
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'list_landing_pages',
  definition: {
    name: 'list_landing_pages',
    description: 'List all generated landing pages for the authenticated user. NOTE: Multiple landing pages can share the same Vercel project (vercelProjectId) and therefore share the same subdomain. The subdomain is configured per-project, not per-page — use configure_landing_page_subdomain with the vercelProjectId to set or change it.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/landing-pages/v0/generated', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_landing_page',
  definition: {
    name: 'get_landing_page',
    description: 'Get details of a specific generated landing page. The returned vercelProjectId identifies the Vercel project; all pages in the same project share one subdomain. To read or change the subdomain, use configure_landing_page_subdomain with that vercelProjectId.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The generated landing page ID' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/landing-pages/v0/generated/${args.page_id}`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'delete_landing_page',
  definition: {
    name: 'delete_landing_page',
    description: 'Delete a generated landing page record.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The generated landing page ID' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'DELETE', path: `/api/landing-pages/v0/generated/${args.page_id}`, context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── Landing Page Domain Tools ───────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'configure_landing_page_subdomain',
  definition: {
    name: 'configure_landing_page_subdomain',
    description: 'Set or update the subdomain for a Vercel project that hosts landing pages (e.g. "everyio" → everyio.agentwebforms.com). IMPORTANT: A subdomain is scoped to the entire Vercel project — all landing pages under the same project share it. Changing the subdomain updates the URL for every page in that project simultaneously. To find the vercelProjectId, call list_landing_pages or get_landing_page first. Use get_landing_page_subdomain to read the current subdomain before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        vercel_project_id: { type: 'string', description: 'The Vercel project ID shared by all pages in the project (from list_landing_pages or get_landing_page)' },
        subdomain: { type: 'string', description: 'The subdomain prefix to assign (e.g. "everyio" → everyio.agentwebforms.com). Must be lowercase alphanumeric and hyphens only.' }
      },
      required: ['vercel_project_id', 'subdomain']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/domains/subdomain', context: ctx(context),
      body: { vercelProjectId: args.vercel_project_id, subdomain: args.subdomain }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_landing_page_subdomain',
  definition: {
    name: 'get_landing_page_subdomain',
    description: 'Read the current subdomain configured for a Vercel project that hosts landing pages. Returns the domain (e.g. everyio.agentwebforms.com), its status, and record ID. Returns null if no subdomain is set.',
    inputSchema: {
      type: 'object',
      properties: {
        vercel_project_id: { type: 'string', description: 'The Vercel project ID (from list_landing_pages or get_landing_page)' }
      },
      required: ['vercel_project_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/domains/project-subdomain?vercelProjectId=${encodeURIComponent(args.vercel_project_id)}`, context: ctx(context)
    });
    return jsonResult(data);
  }
});

// ─── Landing Page Lead List + Editing Tools ─────────────────────────────────

mcpToolRegistry.register({
  name: 'enable_lead_list_public_access',
  definition: {
    name: 'enable_lead_list_public_access',
    description: 'Enable public access on a CRM lead list so landing page forms can submit leads without authentication. Call this after creating a lead list for a landing page.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list ID to enable public access on' }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'PUT', path: `/api/crm/lists/${args.list_id}/public-access`, context: ctx(context),
      body: { enabled: true }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'duplicate_landing_page',
  definition: {
    name: 'duplicate_landing_page',
    description: 'Create a copy of an existing landing page for independent editing.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID to duplicate' },
        name: { type: 'string', description: 'Name for the duplicated page (optional)' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: `/api/landing-pages/v0/generated/${args.page_id}/duplicate`, context: ctx(context),
      body: { name: args.name }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'update_landing_page_context',
  definition: {
    name: 'update_landing_page_context',
    description: 'Save or update the context field on a landing page — a plain-text description of when to use it, its tone, and target audience. Use this whenever the user provides notes about a landing page (e.g. "this is for cold outreach targeting SaaS founders"). Keep it concise (max 500 characters). The context is shown in the UI and used by the agent to pick the best matching page for CTAs.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        context: { type: 'string', description: 'Free-text notes: when to use this page, tone, audience, offer, etc.' }
      },
      required: ['page_id', 'context']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'PATCH', path: `/api/landing-pages/v0/generated/${args.page_id}/context`, context: ctx(context),
      body: { context: args.context }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'edit_landing_page_file',
  definition: {
    name: 'edit_landing_page_file',
    description: '[DEPRECATED — use coding_agent instead] Direct file edit requiring full file content. This tool is deprecated because it requires you to provide the entire file content, which fails for large files. Use the coding_agent tool instead — it supports diff-based editing, reads files automatically, checks deployment status, and iterates on errors. If you must use this tool, pass "draft/agentweb-preview" to stage changes and use publish_landing_page_changes to go live.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        file_path: { type: 'string', description: 'Path to the file in the repo (e.g., "src/app/page.tsx")' },
        content: { type: 'string', description: 'The new file content' },
        commit_message: { type: 'string', description: 'Git commit message (optional)' },
        branch: { type: 'string', description: 'Target branch for staging. Use "draft/agentweb-preview". Defaults to "main" for backward compatibility.' }
      },
      required: ['page_id', 'file_path', 'content']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'PUT', path: `/api/landing-pages/v0/generated/${args.page_id}/github-edit`, context: ctx(context),
      body: { file_path: args.file_path, content: args.content, commit_message: args.commit_message, branch: args.branch }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'list_landing_page_files',
  definition: {
    name: 'list_landing_page_files',
    description: 'List all files in a deployed landing page\'s GitHub repository. Use this to see what files exist. Note: for code edits, prefer using coding_agent which handles file listing internally.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/landing-pages/v0/generated/${args.page_id}/files`, context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'read_landing_page_file',
  definition: {
    name: 'read_landing_page_file',
    description: 'Read the contents of a specific file in a deployed landing page\'s GitHub repository. Note: for code edits, prefer using coding_agent which handles file reading and editing internally.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        file_path: { type: 'string', description: 'Path to the file in the repo (e.g., "src/app/page.tsx")' }
      },
      required: ['page_id', 'file_path']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/landing-pages/v0/generated/${args.page_id}/file-content?path=${encodeURIComponent(args.file_path)}`, context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_deployment_status',
  definition: {
    name: 'get_deployment_status',
    description: 'Check the Vercel build/deployment status of a landing page. Use this after deploy_landing_page to verify the build succeeded. Note: for code edits, prefer using coding_agent which checks deployment status automatically after edits.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/landing-pages/v0/generated/${args.page_id}/deployment-status`, context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_landing_page_preview_url',
  definition: {
    name: 'get_landing_page_preview_url',
    description: 'Get the Vercel preview URL for the reusable landing page draft branch. Use this after the coding_agent edits a landing page to get the preview link for the user to review before publishing. IMPORTANT: The branch name MUST come from the coding_agent tool result (normally "draft/agentweb-preview"). Do NOT invent random draft branches. If coding_agent returned is_staging=false or no branch, there is no draft to preview. If buildStatus is "not_found", the branch does not exist on Vercel — do NOT keep polling. If buildStatus is "building", the Vercel deployment is still in progress — wait 20-30 seconds and call this tool again to get the URL once ready.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        branch: { type: 'string', description: 'The draft branch name from the coding_agent result, normally "draft/agentweb-preview". Do NOT guess this value.' }
      },
      required: ['page_id', 'branch']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/landing-pages/v0/generated/${args.page_id}/preview-url`,
      queryParams: { branch: args.branch },
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'publish_landing_page_changes',
  definition: {
    name: 'publish_landing_page_changes',
    description: 'Merge the reusable draft branch into main to make landing page changes live. Use this after the user has reviewed the preview and approved the changes. This merges the draft branch, triggers a production deployment, and deletes the draft branch.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        branch: { type: 'string', description: 'The draft branch to merge, normally "draft/agentweb-preview"' }
      },
      required: ['page_id', 'branch']
    }
  },
  execute: async (args: any, context: any) => {
    // ENG-827: last in-process moment before the deployment goes live.
    const withdrawn = await publishWithdrawnMidFlight(context);
    if (withdrawn) return jsonResult({ success: false, message: withdrawn.error });
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/landing-pages/v0/generated/${args.page_id}/publish`,
      body: { branch: args.branch },
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'revert_landing_page_publish',
  definition: {
    name: 'revert_landing_page_publish',
    description: 'Undo the most recent publish of a landing page, rolling the live site back to exactly how it was before that publish. Use this when the user wants to revert or undo published landing page changes. This restores the previous state and triggers a production redeploy. Only the most recent publish can be reverted, and only once. If nothing has been published, or main has changed since (newer changes were published), the revert is refused with an explanation.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/landing-pages/v0/generated/${args.page_id}/revert-publish`,
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

// ─── Internal-only tools (hidden from external MCP clients) ─────────────────
// These tools are registered with internal: true so Emma can use them in chat,
// but they are NOT listed to external MCP clients.

// Session-state tools: install_skills and list_available_skills manipulate
// chat session state (associatedSkills). They call agentModeService directly
// because they're part of Emma's skill-first chat flow, same as customer portal.

mcpToolRegistry.register({
  name: 'install_skills',
  internal: true,
  // ENG-974: outbound action — hidden AND refused for external MCP callers.
  internalOnly: true,
  definition: {
    name: 'install_skills',
    description: 'Install skills by their IDs. Pass ALL skill IDs you need in a single call — do not call this tool multiple times. This makes the tools associated with the skills available for use. Use __other_skills__ to install tools that are not part of any specific skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skillIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of ALL skill IDs to install. Include every skill you need in one call.'
        }
      },
      required: ['skillIds']
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required: no user context');
    if (!Array.isArray(args.skillIds) || args.skillIds.length === 0) {
      return { message: 'skillIds must be a non-empty array of skill IDs.' };
    }
    if (!context?.sessionId) throw new Error('Missing session context');
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.installSkills(args.skillIds, userId, context.sessionId, context.isDelegatedAccess === true);
  }
});

mcpToolRegistry.register({
  name: 'list_available_skills',
  internal: true,
  definition: {
    name: 'list_available_skills',
    description: 'List all available skills with their descriptions and tool lists. Use this to discover what capabilities Emma offers before installing skills.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');
    if (!context?.sessionId) throw new Error('Missing session context');
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.listSkills(userId, context.sessionId);
  }
});

// Infrastructure tools: use backend APIs (search, image gen, email, storage).

mcpToolRegistry.register({
  name: 'you_search_web',
  internal: true,
  definition: {
    name: 'you_search_web',
    description: 'Search the public web using You.com Search. No hidden fallback provider is used. For social-platform research, include explicit site filters when useful, e.g. site:x.com, site:linkedin.com, site:reddit.com, or site:instagram.com.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Web search query' },
        max_results: { type: 'number', description: 'Max web results (default 5, max 10)', default: 5 }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/you-search-web', context: ctx(context),
      body: { query: args.query, max_results: args.max_results || 10 }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'you_search_news',
  internal: true,
  definition: {
    name: 'you_search_news',
    description: 'Search current news using You.com Search. Use this only when the user asks for news, today/latest/breaking updates, or recent articles. Do not call it as a companion to ordinary web/social searches unless the user explicitly asks for news too. No hidden fallback provider is used. Preserve freshness words from the user query such as today, latest, breaking, or the exact date; do not rewrite a today/latest-news request into a timeless entity query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'News search query. For current-news requests, keep temporal terms like today/latest/breaking or include the exact date.' },
        max_results: { type: 'number', description: 'Max news results (default 5, max 10)', default: 5 },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Optional You.com freshness window. Defaults to week for news unless the query implies a fresher window.'
        }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/you-search-news', context: ctx(context),
      body: { query: args.query, max_results: args.max_results || 10, freshness: args.freshness }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'google_search_web',
  internal: true,
  definition: {
    name: 'google_search_web',
    description: 'Opt-in Google Custom Search web search. Not a default search tool. No hidden fallback provider is used.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Google Custom Search query' },
        max_results: { type: 'number', description: 'Max Google web results (default 5, max 10)', default: 5 }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/google-search-web', context: ctx(context),
      body: { query: args.query, max_results: args.max_results || 10 }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'generate_image',
  internal: true,
  definition: {
    name: 'generate_image',
    description: 'Generate images using AI image generation models.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        filename: { type: 'string', description: 'Filename for the generated image' },
        size: { type: 'string', description: 'Image size (e.g., 1024x1024, auto)', default: 'auto' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Quality', default: 'medium' },
        input_images: { type: 'array', items: { type: 'string' }, description: 'Input images for editing' },
        logo_image: { type: 'string', description: 'Logo image URL to add' },
        image_model: { type: 'string', description: 'Model to use' },
        category: { type: 'string', enum: ['ad', 'organic_post'], description: "Use-case declaration for the human eval queue: 'ad' for paid ad creatives, 'organic_post' for organic social/content imagery" }
      },
      required: ['prompt', 'filename', 'category']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/generate-image', context: ctx(context),
      body: {
        prompt: args.prompt, filename: args.filename,
        size: args.size || '1024x1024', quality: args.quality || 'medium',
        input_images: args.input_images || [],
        image_model: args.image_model, logo_image: args.logo_image,
        category: args.category
      }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'send_email',
  internal: true,
  // ENG-974: outbound action — hidden AND refused for external MCP callers.
  internalOnly: true,
  definition: {
    name: 'send_email',
    description: 'Read, search, and send emails across connected email accounts (Gmail, Outlook, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Email account ID from list_connected_accounts' },
        action: { type: 'string', enum: ['search', 'list', 'get', 'send'], description: 'Action to perform' },
        query: { type: 'string', description: 'Search query (search action)' },
        folder: { type: 'string', description: 'Folder to list (list action)', default: 'INBOX' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'Message IDs (get action)' },
        max_results: { type: 'number', description: 'Max results (search/list)', default: 10 },
        to: { type: ['string', 'array'], description: 'Recipient(s) (send action)' },
        subject: { type: 'string', description: 'Email subject (send action)' },
        body: { type: 'string', description: 'Email body (send action)' },
        cc: { type: ['string', 'array'], description: 'CC recipients (send action)' },
        bcc: { type: ['string', 'array'], description: 'BCC recipients (send action)' },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to (send action)' },
        is_html: { type: 'boolean', description: 'Body is HTML (send action)', default: false }
      },
      required: ['account_id', 'action']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/email', context: ctx(context),
      body: args
    });
    return jsonResult(data);
  }
});

// ─── Predefined Work Plans (admin-only) ─────────────────────────────────────

// This tool's own parameters are snake_case, but /api/admin/work-plans reads the
// step fields in camelCase, so a snake_case step field used to be silently
// dropped (the plan saved with requiredFunctionCalls: [] and no error). Accept
// either casing and hand the route the camelCase names it reads (ENG-889).
const WORK_PLAN_STEP_ALIASES: Record<string, string> = {
  required_function_calls: 'requiredFunctionCalls',
  skill_ids: 'skillIds',
  user_instructions: 'userInstructions',
  step_count: 'stepCount',
  expected_asset_count: 'expectedAssetCount',
};

const normalizeWorkPlanSteps = (steps: any): any => {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step: any) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const normalized: any = {};
    // Copy everything that is already canonical first, then fill the gaps from
    // snake_case aliases. Two passes rather than one because a single pass is
    // key-order dependent: with `{required_function_calls, requiredFunctionCalls}`
    // the later key would overwrite whatever the earlier one resolved to.
    for (const [key, value] of Object.entries(step)) {
      if (!WORK_PLAN_STEP_ALIASES[key]) normalized[key] = value;
    }
    for (const [key, value] of Object.entries(step)) {
      const alias = WORK_PLAN_STEP_ALIASES[key];
      if (!alias) continue;
      // A camelCase value supplied alongside its snake_case twin wins — but
      // JSON has no undefined, so a model emitting an unset field emits null.
      // Treating that null as "present" would shadow a good snake_case value.
      if (normalized[alias] === undefined || normalized[alias] === null) {
        normalized[alias] = value;
      }
    }
    return normalized;
  });
};

/**
 * Work plan steps are stored as a whole array, so PUT /api/admin/work-plans/:id
 * replaces every step with the payload. Callers amending a single step used to
 * silently delete the rest (ENG-890); the helpers below add merge semantics and
 * a fail-closed guard around destructive replacements. They all run on steps
 * that normalizeWorkPlanSteps has already put in canonical camelCase.
 */

function normalizeStepTitle(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The step fields worth guarding. The admin route rebuilds every step from a
 * fixed field list and defaults these to empty (services/workPlanSteps.ts), so
 * re-sending a step without them blanks whatever was stored — at an unchanged
 * step count, which no length check can see.
 */
const STEP_CONTENT_FIELDS = [
  'description',
  'requiredFunctionCalls',
  'skillIds',
  'userInstructions',
  'expectedAssetCount',
] as const;

function isEmptyStepValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
}

/**
 * Locate `probe`'s counterpart in `steps`. Title first, then position: a caller
 * reordering a plan renumbers the steps but keeps their titles, so matching on
 * stepCount first would pair up the wrong two.
 */
function findStepIndex(steps: any[], probe: any): number {
  if (probe.title !== undefined) {
    const title = normalizeStepTitle(probe.title);
    const matches = steps.filter((s: any) => normalizeStepTitle(s.title) === title);
    // A title shared by two steps identifies neither — fall through to position
    // rather than pairing everything against the first one.
    if (matches.length === 1) return steps.indexOf(matches[0]);
  }
  if (probe.stepCount === undefined || probe.stepCount === null) return -1;
  return steps.findIndex((s: any) => Number(s.stepCount) === Number(probe.stepCount));
}

/**
 * Titles in `from` with no counterpart left in `to`. Counts occurrences instead
 * of testing set membership, so dropping one of two steps that share a title is
 * still reported as a drop.
 */
function diffStepTitles(from: any[], to: any[]): any[] {
  const available = new Map<string, number>();
  for (const step of to) {
    const title = normalizeStepTitle(step.title);
    available.set(title, (available.get(title) || 0) + 1);
  }
  const unmatched: any[] = [];
  for (const step of from) {
    const title = normalizeStepTitle(step.title);
    const remaining = available.get(title) || 0;
    if (remaining > 0) available.set(title, remaining - 1);
    else unmatched.push(step.title);
  }
  return unmatched;
}

/**
 * Incoming merge steps that name no stepCount and whose title matches more than
 * one existing step. Amending "whichever came first" is a silent wrong-step
 * edit, so the caller is asked to disambiguate instead.
 */
function findAmbiguousMergeTargets(existingSteps: any[], incomingSteps: any[]) {
  const ambiguous: { title: any; matchingStepCounts: any[] }[] = [];
  for (const incoming of incomingSteps) {
    // A stepCount only settles the target if it names a step that exists.
    // mergeWorkPlanSteps falls back to the title otherwise, so a stale or
    // invented count must not buy a pass through this check.
    const named = incoming.stepCount !== undefined && incoming.stepCount !== null
      && existingSteps.some((s: any) => Number(s.stepCount) === Number(incoming.stepCount));
    if (named) continue;
    if (incoming.title === undefined) continue;
    const title = normalizeStepTitle(incoming.title);
    const matches = existingSteps.filter((s: any) => normalizeStepTitle(s.title) === title);
    if (matches.length > 1) {
      ambiguous.push({ title: incoming.title, matchingStepCounts: matches.map((s: any) => s.stepCount) });
    }
  }
  return ambiguous;
}

/**
 * Two incoming entries that resolve to the same existing step. One request
 * saying both "rename step 1" and "amend the step titled <its old name>" is a
 * contradiction; applying them in array order silently lets the later one undo
 * the earlier, which is the kind of quiet resolution this tool no longer does.
 */
function findConflictingMergeTargets(existingSteps: any[], incomingSteps: any[]) {
  const byIndex = new Map<number, any[]>();
  for (const { index, incoming } of resolveMergeTargets(existingSteps, incomingSteps)) {
    if (index === -1) continue;
    byIndex.set(index, [...(byIndex.get(index) || []), incoming]);
  }
  return [...byIndex.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([index, entries]) => ({
      stepCount: existingSteps[index]?.stepCount,
      title: existingSteps[index]?.title,
      entries: entries.length,
    }));
}

/**
 * Fields a replace would blank on steps the caller plainly meant to keep. A
 * step with no counterpart at all is skipped: that is a removal or a rewrite,
 * which the count guard and the dropped-titles diff already report.
 */
function findStepContentLoss(before: any[], after: any[]) {
  const losses: { stepCount: any; title: any; fields: string[] }[] = [];
  for (const existing of before) {
    const index = findStepIndex(after, existing);
    if (index === -1) continue;
    const fields = STEP_CONTENT_FIELDS.filter(
      (field) => !isEmptyStepValue(existing[field]) && isEmptyStepValue(after[index][field]),
    );
    if (fields.length > 0) {
      losses.push({ stepCount: existing.stepCount, title: existing.title, fields: [...fields] });
    }
  }
  return losses;
}

/** Apply the caller-supplied fields of `incoming` on top of an existing step. */
function mergeWorkPlanStep(existing: any, incoming: any): any {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    // stepCount only selects which step to amend. Copying it through would
    // renumber — and could duplicate — positions whenever the match came from
    // the title instead.
    if (key === 'stepCount') continue;
    // A model emits null for a field it is not setting (ENG-889), so treating
    // null as a value would blank an existing field in what is meant to be the
    // non-destructive mode.
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Resolve each incoming step to the index it amends, or -1 to append.
 *
 * Deliberately stepCount-before-title, the opposite of findStepIndex: here the
 * caller has explicitly named the step to amend, and the schema says so.
 * findStepIndex infers identity across two full arrays with no such selector.
 *
 * A shared title resolves to nothing rather than to the first match — the same
 * rule findAmbiguousMergeTargets pre-checks, kept here so the two cannot drift.
 */
function resolveMergeTargets(existingSteps: any[], incomingSteps: any[]) {
  return incomingSteps.map((incoming: any) => {
    const targetCount = incoming.stepCount;
    if (targetCount !== undefined && targetCount !== null) {
      const byCount = existingSteps.findIndex((s: any) => Number(s.stepCount) === Number(targetCount));
      if (byCount !== -1) return { index: byCount, incoming };
    }
    if (incoming.title !== undefined) {
      const title = normalizeStepTitle(incoming.title);
      const matches = existingSteps
        .map((s: any, i: number) => ({ s, i }))
        .filter(({ s }: any) => normalizeStepTitle(s.title) === title);
      if (matches.length === 1) return { index: matches[0].i, incoming };
    }
    return { index: -1, incoming };
  });
}

/**
 * Merge partial steps into the plan's current steps. Never removes a step.
 *
 * Targets are resolved for ALL entries first, against the plan as it was read.
 * Resolving during application would read a half-mutated array, so one request
 * could rename a step and then fail to find it for a later, already-validated
 * entry — turning an amendment into an append, and making the result depend on
 * the order the entries happened to arrive in. Resolution and the ambiguity
 * pre-check now share one frame of reference.
 */
function mergeWorkPlanSteps(existingSteps: any[], incomingSteps: any[]): any[] {
  const merged = existingSteps.map((s: any) => ({ ...s }));

  for (const { index, incoming } of resolveMergeTargets(existingSteps, incomingSteps)) {
    if (index === -1) {
      merged.push(mergeWorkPlanStep({ stepCount: merged.length + 1 }, incoming));
    } else {
      merged[index] = mergeWorkPlanStep(merged[index], incoming);
    }
  }

  return merged;
}

/** Diff summary returned to the caller so step removals can never go unnoticed. */
function summarizeStepChange(before: any[], after: any[], mode: 'merge' | 'replace') {
  const contentLoss = findStepContentLoss(before, after);
  return {
    mode,
    stepsBefore: before.length,
    stepsAfter: after.length,
    stepsRemoved: Math.max(0, before.length - after.length),
    droppedStepTitles: diffStepTitles(before, after),
    addedStepTitles: diffStepTitles(after, before),
    // Omitted rather than empty so a clean update's summary stays quiet.
    ...(contentLoss.length > 0 && { stepContentLoss: contentLoss }),
  };
}

mcpToolRegistry.register({
  name: 'list_predefined_work_plans',
  definition: {
    name: 'list_predefined_work_plans',
    description: 'List the predefined work plan templates available to start. Non-admin users see published templates (system/public) plus their own and org-shared private plans. Admins (or admin-delegated sessions) get the full management list including unpublished and pending-review plans. To begin one, call launch_predefined_work_plan with the chosen title.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    // Role-aware: admins (or admin-delegated sessions) get the full management
    // list via the admin route; everyone else gets the published/launchable set
    // via the public agent-mode route. Both go through authenticateToken.
    const c = ctx(context);
    let isAdmin = c.isDelegatedAccess === true;
    if (!isAdmin && c.userId) {
      try {
        const { userDb } = await import('../../services/db');
        const user = await userDb.getUserById(c.userId);
        isAdmin = user?.isAdmin === true;
      } catch { /* default to non-admin on lookup failure */ }
    }
    const path = isAdmin ? '/api/admin/work-plans' : '/api/agent-mode/public/plans';
    const data = await mcpFetch({ method: 'GET', path, context: c });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_predefined_work_plan',
  definition: {
    name: 'manage_predefined_work_plan',
    description: 'Create, update, delete, or get a predefined work plan. Admin only. CAUTION: These operations modify production configuration — incorrect changes can cause outages. Always confirm with the user before making changes. STEPS ARE DESTRUCTIVE ON UPDATE: sending "steps" with action=update replaces the entire steps array, it does not patch individual steps. To amend one step without touching the others, pass steps_mode="merge" with just the step(s) you are changing. To intentionally rewrite the plan with fewer steps, send the complete new array plus confirm_step_removal=true. A replace stores exactly what you send, so a field you omit on a step is erased too — an update that would drop steps, or blank fields on the steps it keeps, is rejected unless confirmed. Every step change comes back as a stepsChange diff summary.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'get'], description: 'CRUD action' },
        plan_id: { type: 'string', description: 'Plan ID (required for update/delete/get)' },
        title: { type: 'string', description: 'Plan title (create/update)' },
        description: { type: 'string', description: 'Plan description (create/update)' },
        welcome_message: { type: 'string', description: 'Welcome message shown to users (create/update)' },
        autocomplete: { type: 'boolean', description: 'Whether the plan auto-completes (create/update)' },
        require_login: { type: 'boolean', description: 'Whether login is required (create/update)' },
        show_in_agent_mode: { type: 'boolean', description: 'Whether to show in agent mode (create/update)' },
        show_login_signup: { type: 'string', enum: ['after_plan_completed', 'always'], description: 'When to show login/signup (create/update)' },
        default_model: { type: 'string', description: 'Default LLM model (create/update)' },
        category: { type: 'string', description: 'Plan category shown in the admin list, e.g. Paid Ads, Strategy, Content (create/update)' },
        // Deliberately no `visibility` parameter. The route accepts it, but
        // exposing it here would let a model publish a draft plan to every user
        // — or unpublish a live one — off a single misread instruction. Leave
        // that transition to a human in the portal (ENG-889).
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              requiredFunctionCalls: { type: 'array', items: { type: 'string' }, description: 'Tool names the step must call before it can complete. Note the camelCase name; the snake_case alias required_function_calls is also accepted.' },
              skillIds: { type: 'array', items: { type: 'string' }, description: 'Skill IDs attached to this step (from list_skills / resolve_skill). Alias: skill_ids.' },
              userInstructions: { type: 'string', description: 'Instructions shown to the user for this step. Alias: user_instructions.' },
              stepCount: { type: 'number', description: 'Step order, 1-based. Defaults to the array position. In steps_mode="merge" this is what selects the existing step to amend. Alias: step_count.' },
              expectedAssetCount: { type: 'number', description: 'For a step that must produce a fixed number of media assets (e.g. "generate 18 images"), the required count. The step cannot be marked completed until that many images/videos have been generated in the run, which stops it being closed with only some produced. Note the count is per run, not per step: assets generated by earlier steps of the same run also count towards it. Omit for steps with no fixed asset count. Alias: expected_asset_count.' }
            },
            required: ['title']
          },
          description: 'Work plan steps. On create this is the full plan. On update this REPLACES the entire steps array unless steps_mode="merge". Step fields are camelCase (unlike the snake_case top-level parameters); snake_case aliases are accepted too. Any field outside this list is not stored — the response lists such fields under "warnings".'
        },
        steps_mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description: 'How to apply "steps" on update. "replace" (default) overwrites the whole array. "merge" patches the supplied steps into the existing plan by stepCount (or title) and appends unmatched ones, leaving every other step intact. In "merge", send ONLY the fields you are actually changing on each step, plus stepCount to say which step you mean: every field you include is applied, so passing a title you did not mean to change RENAMES that step. Do not fill in placeholder values for fields you are leaving alone.'
        },
        confirm_step_removal: {
          type: 'boolean',
          description: 'Required (true) when a steps_mode="replace" update would leave the plan with fewer steps than it has now, or would blank fields (description, requiredFunctionCalls, skillIds, userInstructions, expectedAssetCount) that are currently set on the steps it keeps. Without it the update is rejected instead of silently destroying that content.'
        }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const body: any = { title: args.title, steps: normalizeWorkPlanSteps(args.steps) };
        if (args.description !== undefined) body.description = args.description;
        if (args.welcome_message !== undefined) body.welcomeMessage = args.welcome_message;
        if (args.autocomplete !== undefined) body.autocomplete = args.autocomplete;
        if (args.require_login !== undefined) body.requireLogin = args.require_login;
        if (args.show_in_agent_mode !== undefined) body.showInAgentMode = args.show_in_agent_mode;
        if (args.show_login_signup !== undefined) body.showLoginSignup = args.show_login_signup;
        if (args.default_model !== undefined) body.defaultModel = args.default_model;
        if (args.category !== undefined) body.category = args.category;
        const data = await mcpFetch({ method: 'POST', path: '/api/admin/work-plans', context: c, body });
        return jsonResult(data);
      }
      case 'update': {
        // `steps` is deliberately not set here — it is only ever assigned below,
        // after the current plan has been read (ENG-890).
        const body: any = { title: args.title };
        if (args.description !== undefined) body.description = args.description;
        if (args.welcome_message !== undefined) body.welcomeMessage = args.welcome_message;
        if (args.autocomplete !== undefined) body.autocomplete = args.autocomplete;
        if (args.require_login !== undefined) body.requireLogin = args.require_login;
        if (args.show_in_agent_mode !== undefined) body.showInAgentMode = args.show_in_agent_mode;
        if (args.show_login_signup !== undefined) body.showLoginSignup = args.show_login_signup;
        if (args.default_model !== undefined) body.defaultModel = args.default_model;
        if (args.category !== undefined) body.category = args.category;

        // Steps replace the whole array server-side, so read the current plan
        // first and either merge into it or refuse an unconfirmed shrink.
        let stepsChange: ReturnType<typeof summarizeStepChange> | undefined;
        if (args.steps !== undefined) {
          if (!Array.isArray(args.steps)) {
            return jsonResult({ error: 'steps must be an array of step objects' });
          }
          const mode: 'merge' | 'replace' = args.steps_mode === 'merge' ? 'merge' : 'replace';
          // Canonicalize the casing once, up front, so the merge matcher and the
          // replace payload both see the same camelCase fields the route reads
          // (ENG-889). Merging raw aliases would drop them on the stored step.
          const incomingSteps: any[] = normalizeWorkPlanSteps(args.steps);

          let existingSteps: any[] | undefined;
          try {
            const current = await mcpFetch({ method: 'GET', path: `/api/admin/work-plans/${args.plan_id}`, context: c });
            existingSteps = Array.isArray(current?.steps) ? current.steps : [];
            // Stake the read: everything below is judged against these steps, so
            // a write that lands in between has to fail rather than quietly make
            // that judgement wrong (ENG-890).
            body.expectedStepsRev = current?.steps_rev ?? null;
          } catch (error: any) {
            // Fail closed in both modes: without the current steps we can
            // neither merge nor tell whether a replace would delete steps, and
            // writing blind is exactly the silent deletion this guards against.
            return jsonResult({ error: `Cannot safely update work plan ${args.plan_id}: failed to read its current steps (${error?.message || error}). Retry, or re-send with the full steps array once the plan is readable.` });
          }

          if (mode === 'merge') {
            const ambiguous = findAmbiguousMergeTargets(existingSteps || [], incomingSteps);
            if (ambiguous.length > 0) {
              return jsonResult({
                error: `Refusing to merge into work plan ${args.plan_id}: ${ambiguous.length === 1 ? 'a step title matches' : 'some step titles match'} more than one step, so there is no way to tell which one to amend.`,
                ambiguousSteps: ambiguous,
                howToProceed: [
                  'Retry with stepCount on each ambiguous step to name the one you mean (call action="get" to see the current numbering).',
                ],
              });
            }
            const conflicting = findConflictingMergeTargets(existingSteps || [], incomingSteps);
            if (conflicting.length > 0) {
              return jsonResult({
                error: `Refusing to merge into work plan ${args.plan_id}: more than one supplied step resolves to the same existing step, so they would silently overwrite each other.`,
                conflictingSteps: conflicting,
                howToProceed: [
                  'Combine the changes for each step into a single entry, then retry.',
                ],
              });
            }
            body.steps = mergeWorkPlanSteps(existingSteps || [], incomingSteps);
          } else {
            body.steps = incomingSteps;
            if (existingSteps && body.steps.length < existingSteps.length && args.confirm_step_removal !== true) {
              const preview = summarizeStepChange(existingSteps, body.steps, 'replace');
              return jsonResult({
                error: `Refusing to update work plan ${args.plan_id}: action=update replaces the entire steps array, and this payload would take the plan from ${preview.stepsBefore} steps to ${preview.stepsAfter}, removing ${preview.stepsRemoved}.`,
                stepsWouldBeRemoved: preview.stepsRemoved,
                removedStepTitles: preview.droppedStepTitles,
                howToProceed: [
                  'To amend specific steps without touching the others, retry with steps_mode="merge" and only the steps you are changing.',
                  'To intentionally rewrite the plan with fewer steps, retry with confirm_step_removal=true (send the complete new steps array).',
                ],
              });
            }

            // Same failure, one level down: the step count is untouched but the
            // steps come back gutted, which is what happens when a caller
            // re-types the array from memory as title+description.
            const contentLoss = findStepContentLoss(existingSteps || [], body.steps);
            if (contentLoss.length > 0 && args.confirm_step_removal !== true) {
              return jsonResult({
                error: `Refusing to update work plan ${args.plan_id}: this payload keeps the steps but would blank fields that are currently set on ${contentLoss.length} of them. A replace stores exactly what you send, so any field you omit is erased.`,
                stepsWouldBeRemoved: 0,
                stepContentLoss: contentLoss,
                howToProceed: [
                  'To amend specific steps without touching the others, retry with steps_mode="merge" and only the steps you are changing.',
                  'To keep these steps as they are, re-send each one with its current fields (call action="get" first if you no longer have them).',
                  'To intentionally clear them, retry with confirm_step_removal=true.',
                ],
              });
            }
          }
          if (existingSteps) {
            stepsChange = summarizeStepChange(existingSteps, body.steps, mode);
          }
        }

        let data: any;
        try {
          data = await mcpFetch({ method: 'PUT', path: `/api/admin/work-plans/${args.plan_id}`, context: c, body });
        } catch (error: any) {
          // The stake above was rejected. Nothing was written, and a blind retry
          // would re-send a payload built from steps that no longer exist.
          if (String(error?.message || '').includes('409')) {
            return jsonResult({
              error: `Work plan ${args.plan_id} changed while this update was being prepared, so nothing was saved.`,
              howToProceed: [
                'Re-read the plan with action="get" and retry the change against its current steps.',
              ],
            });
          }
          throw error;
        }
        if (stepsChange && data && typeof data === 'object' && !Array.isArray(data)) {
          return jsonResult({ ...data, stepsChange });
        }
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/admin/work-plans/${args.plan_id}`, context: c });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/admin/work-plans/${args.plan_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── Skill Management (admin-only) ──────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_skills',
  definition: {
    name: 'list_skills',
    description: 'List all skill definitions. Returns each skill\'s ID, name, description, toolNames, systemPrompt, isPublished status, and extended fields. Admin-only.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/skills', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'resolve_skill',
  definition: {
    name: 'resolve_skill',
    description: 'Resolve a user-provided skill, engine, or workflow-skill name to compact skill metadata. Normal users search only skills they can access: published, own private, and org-shared private skills. Admin/delegated sessions search admin-visible skills. ALWAYS use this before saying a skill does not exist, and before manage_skill when the user gave a skill name rather than an exact skill_id. Returns compact matches only and never returns the full systemPrompt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Skill name or partial phrase to resolve, such as "Event skill" or "Luma Event Lead Engagement Engine".' },
        limit: { type: 'number', description: 'Maximum matches to return, 1-10. Defaults to 5.' }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return jsonResult({ error: 'query is required' });
    }

    const rawLimit = typeof args.limit === 'number' ? args.limit : 5;
    const limit = Math.max(1, Math.min(10, Math.floor(rawLimit) || 5));
    const { scope, canManageSkills, skills } = await getSkillResolverScope(context);
    const skillList = Array.isArray(skills) ? skills : [];
    const matches = skillList
      .map((skill: any) => compactSkillMatch(skill, query))
      .filter((skill: any) => skill.skill_id && skill.name && skill.matchScore > 0)
      .sort((a: any, b: any) => b.matchScore - a.matchScore || String(a.name).localeCompare(String(b.name)))
      .slice(0, limit);
    const resolution = skillResolution(matches);

    return jsonResult({
      success: true,
      query,
      scope,
      canManageSkills,
      totalMatches: matches.length,
      matches,
      resolution,
      nextStep: skillResolutionNextStep(resolution, canManageSkills),
    });
  }
});

mcpToolRegistry.register({
  name: 'manage_skill',
  definition: {
    name: 'manage_skill',
    description: 'Create, update, delete, or get a skill definition. Admin only. CAUTION: These operations modify production skill configuration — changes affect which tools are available to users. For update/delete/get, skill_id is required; if the user gave a skill name, call resolve_skill first and then use the returned skill_id. Always confirm with the user before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'get'], description: 'CRUD action' },
        skill_id: { type: 'string', description: 'Skill ID (required for update/delete/get)' },
        name: { type: 'string', description: 'Skill name (create/update)' },
        description: { type: 'string', description: 'Skill description (create/update)' },
        tool_names: { type: 'array', items: { type: 'string' }, description: 'Tool names included in this skill (create/update)' },
        system_prompt: { type: 'string', description: 'System prompt injected when skill is installed (create/update)' },
        is_published: { type: 'boolean', description: 'Whether the skill is visible to users (create/update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const body: any = { name: args.name, description: args.description, toolNames: args.tool_names || [] };
        if (args.system_prompt !== undefined) body.systemPrompt = args.system_prompt;
        if (args.is_published !== undefined) body.isPublished = args.is_published;
        const data = await mcpFetch({ method: 'POST', path: '/api/skills', context: c, body });
        return jsonResult(data);
      }
      case 'update': {
        if (!args.skill_id) return jsonResult({ error: resolveSkillInstruction('update') });
        const body: any = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.description !== undefined) body.description = args.description;
        if (args.tool_names !== undefined) body.toolNames = args.tool_names;
        if (args.system_prompt !== undefined) body.systemPrompt = args.system_prompt;
        if (args.is_published !== undefined) body.isPublished = args.is_published;
        const data = await mcpFetch({ method: 'PUT', path: `/api/skills/${args.skill_id}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        if (!args.skill_id) return jsonResult({ error: resolveSkillInstruction('delete') });
        const data = await mcpFetch({ method: 'DELETE', path: `/api/skills/${args.skill_id}`, context: c });
        return jsonResult(data);
      }
      case 'get': {
        if (!args.skill_id) return jsonResult({ error: resolveSkillInstruction('get') });
        const data = await mcpFetch({ method: 'GET', path: `/api/skills/${args.skill_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── Chat History (admin-only) ──────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'get_chat_history',
  definition: {
    name: 'get_chat_history',
    description: `Get chat history by time range with satisfaction scores. Returns sessions with their metadata including satisfaction scores. Useful for generating support summaries and analyzing customer satisfaction. Admin-only. When sync=true, generates satisfaction scores for sessions that don't have them (slower but ensures all scores are present).

MODEL ATTRIBUTION — use attributedModels. Do not derive it yourself.
- attributedModels: the model(s) to name for this session. Already resolved for you. Null only when nothing is recorded at all.
- attributionBasis: 'transcript' when EVERY assistant turn recorded a model (trustworthy provenance); 'partial-transcript' when only some did — the model list is real but incomplete, so do not present it as the session's full attribution; 'selection-only' when no turn recorded a model and this fell back to the picker (state that it is unverified whenever you report it).

The two underlying fields are also returned, and they are NOT interchangeable:
- llmModel: the model *selected* in the picker. A client-side selection only — the session may never have run on it (it can name a model outside the registry, or a live voice model that cannot generate text at all).
- generationModels: the models that actually generated the assistant turns, derived from the transcript. Null when no message recorded one.

TOKEN vs COST — they are not on the same basis. totalTokens EXCLUDES prompt-cache tokens, but totalCost/estimated_cost BILLS them. cacheTokens ({creation, read}, null when none) reports what was cached. A cache-heavy scheduled run can show 371 totalTokens against $2.94 of real spend, so a cost-per-token or "cheap because few tokens" claim computed from totalTokens alone is wrong by orders of magnitude. When reporting spend, use totalCost directly; when reporting volume, add cacheTokens to totalTokens and say you did.

PER-MODEL COST — use costByModel, never attributedModels. attributedModels says WHICH models ran; it does not say how the money split. costByModel ({model: usd}, null when no turn recorded cost) is the actual per-turn allocation, so a session that ran two models contributes correctly to each rather than being double-counted or dropped. unattributedCost is the residual, on the same micro-USD basis as costByModel and totalCost: sum(costByModel) + unattributedCost reconciles to totalCost, exactly whenever there is spend left to attribute. It is null when the residual is not positive — in that case the per-model buckets already account for the whole session and may exceed totalCost by a few micro-dollars of per-turn rounding, which is noise, not missing money. Never treat a null as licence to rescale the buckets. It covers both spend on turns that recorded no model AND cost that never lands on a turn at all (tool/image spend counts toward totalCost but belongs to no model). When it is non-null the per-model split does NOT account for all of this session's cost — report it as its own line rather than folding it into a model, or your model percentages will not sum to the total.

Whenever you name a model — reports, cost/usage breakdowns, per-model groupings, routing recommendations, filed tickets — use attributedModels. Never group or attribute cost by llmModel: it is a selection, so it books spend to models that never ran. This supersedes any earlier note, prior report, or saved memory that tells you to group cost by llmModel. If llmModel and generationModels disagree, that mismatch is itself worth reporting.`,
    inputSchema: {
      type: 'object',
      properties: {
        start_time: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g., "2024-03-01T00:00:00.000Z")'
        },
        end_time: {
          type: 'string',
          description: 'End time in ISO 8601 format (e.g., "2024-03-02T00:00:00.000Z")'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (1-1000, default: 500). Use limit: 1000 when you need complete coverage for accurate counts or percentages over busy time ranges.',
          default: 500
        },
        sync: {
          type: 'boolean',
          description: 'When true, generates satisfaction scores for sessions that don\'t have them before returning (default: false). Use this for complete satisfaction score coverage, but expect slower response times.',
          default: false
        }
      },
      required: ['start_time', 'end_time']
    }
  },
  execute: async (args: any, context: any) => {
    if (!args.start_time || !args.end_time) {
      return jsonResult({
        error: 'start_time and end_time are required. Provide ISO 8601 timestamps, e.g. start_time="2024-03-01T00:00:00.000Z"'
      });
    }
    const queryParams = new URLSearchParams({
      startTime: args.start_time,
      endTime: args.end_time,
      limit: (args.limit ?? 500).toString(),
      ...(args.sync && { sync: args.sync.toString() })
    });
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/admin/chat-sessions?${queryParams}`,
      context: ctx(context)
    });

    // Format response — return all metadata shown in the admin Chat History tab, but exclude raw messages
    const sessions = (data as any)?.sessions || [];
    const formattedSessions = sessions.map((session: any) => {
      const messages: any[] = session.messages || [];

      // Compute feedback summary from messages
      let likes = 0;
      let dislikes = 0;
      let longestWaitMs = 0;
      let maxHeapMB = 0;
      // ENG-892: session.llmModel is only what the model picker last stored — a
      // selection, not provenance. Each assistant message carries the model that
      // actually produced it (written after model resolution and any backup-model
      // switch), so derive real attribution from the transcript.
      const generationModels = new Set<string>();
      // ENG-892 follow-on: estimated_cost bills cache tokens, but total_tokens
      // excludes them, so cost/token on a cache-heavy scheduled run reads ~100x
      // the real rate (a live session: 371 total_tokens vs 156,013 cache-creation
      // tokens for $2.94). Surface them so cost and tokens can be reconciled.
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      // Per-model cost split. totalCost is one session-wide number, so a multi-model
      // session gave a per-model breakdown nothing to divide by — the per-turn cost
      // and model are both already here, so allocate rather than make callers guess.
      // Accumulated in whole micro-USD, the unit costs are already computed in
      // (usageRecorderService.computeCostMicroUsd). Rounding each bucket to 6dp on
      // the way out while deriving the residual from unrounded floats put the three
      // reported numbers on different bases, so they could fail to sum to totalCost —
      // the exact reconciliation the tool description tells consumers to rely on.
      const costMicroByModel: Record<string, number> = {};
      // Assistant turns carrying no model, counted regardless of cost: a turn with
      // no recorded spend still means the transcript is only partially labelled, and
      // keying that off cost alone let a partial set read as authoritative.
      let unlabelledAssistantTurns = 0;
      for (const msg of messages) {
        if (msg?.role !== 'assistant') continue;
        const turnCost = msg?.usage?.estimated_cost || 0;
        if (typeof msg?.llm === 'string' && msg.llm) {
          generationModels.add(msg.llm);
          if (turnCost) {
            costMicroByModel[msg.llm] = (costMicroByModel[msg.llm] || 0) + Math.round(turnCost * 1e6);
          }
        } else {
          unlabelledAssistantTurns++;
        }
        cacheCreationTokens += msg?.usage?.cache_creation_input_tokens || 0;
        cacheReadTokens += msg?.usage?.cache_read_input_tokens || 0;
        if (msg?.metadata?.feedback?.type === 'like') likes++;
        if (msg?.metadata?.feedback?.type === 'dislike') dislikes++;
        if (Array.isArray(msg?.metadata?.iterationTimings)) {
          const waitMs = msg.metadata.iterationTimings.reduce(
            (sum: number, t: any) => sum + (t.llmDurationMs || 0), 0
          );
          if (waitMs > longestWaitMs) longestWaitMs = waitMs;
        }
        if (msg?.metadata?.memoryUsage?.currentHeapUsedMB != null) {
          const heap = msg.metadata.memoryUsage.currentHeapUsedMB;
          if (heap > maxHeapMB) maxHeapMB = heap;
        }
      }

      // Work plan summary (title + step statuses, no full descriptions)
      let workPlanSummary = null;
      if (session.workPlan) {
        workPlanSummary = {
          title: session.workPlan.title,
          steps: (session.workPlan.steps || []).map((s: any) => ({
            stepCount: s.stepCount,
            title: s.title,
            status: s.status,
          })),
        };
      }

      return {
        sessionId: session.sessionId,
        userId: session.userId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        portalType: session.portalType || null,
        sessionType: session.sessionType || null,
        llmModel: session.llmModel || null,
        generationModels: generationModels.size > 0 ? [...generationModels] : null,
        // ENG-892: pre-resolve the attribution so the agent never has to choose
        // between two model-shaped fields. The original mis-report happened
        // because a field named `llmModel` sat in the payload and got named on
        // sight; a stored account memory still instructs grouping cost by it.
        // Emitting the answer (plus how trustworthy it is) removes that judgement
        // call rather than relying on the agent to make it correctly.
        attributedModels: generationModels.size > 0
          ? [...generationModels]
          : (session.llmModel ? [session.llmModel] : null),
        attributionBasis: generationModels.size > 0
          ? (unlabelledAssistantTurns > 0 ? 'partial-transcript' : 'transcript')
          : (session.llmModel ? 'selection-only' : null),
        messageCount: messages.length,
        totalTokens: session.totalTokens || null,
        cacheTokens: (cacheCreationTokens > 0 || cacheReadTokens > 0)
          ? { creation: cacheCreationTokens, read: cacheReadTokens }
          : null,
        costByModel: Object.keys(costMicroByModel).length > 0
          ? Object.fromEntries(
              Object.entries(costMicroByModel).map(([m, micro]) => [m, micro / 1e6])
            )
          : null,
        // The residual, on the SAME micro-USD basis as the buckets and as the
        // totalCost reported above, so the three always reconcile exactly. Captures
        // both spend on unlabelled turns and cost that never lands on an assistant
        // turn at all (tool/image spend is in totalCost but in no turn's usage —
        // measured at $1.92 on a real $100 session), which a turn-only sum would
        // silently drop from a per-model breakdown.
        unattributedCost: (() => {
          if (session.totalCost == null) return null;
          const totalMicro = Math.round(Number(session.totalCost) * 1e6);
          const attributedMicro = Object.values(costMicroByModel).reduce((a, b) => a + b, 0);
          const residualMicro = totalMicro - attributedMicro;
          return residualMicro > 0 ? residualMicro / 1e6 : null;
        })(),
        // Same micro-USD basis as costByModel/unattributedCost below, so the three
        // reconcile exactly rather than each being rounded independently.
        totalCost: session.totalCost != null ? Math.round(Number(session.totalCost) * 1e6) / 1e6 : null,
        satisfactionScore: session.satisfactionScore || null,
        judgeScores: session.judgeScores || null,
        feedback: (likes > 0 || dislikes > 0) ? { likes, dislikes } : null,
        longestWaitMs: longestWaitMs > 0 ? longestWaitMs : null,
        maxHeapMB: maxHeapMB > 0 ? Math.round(maxHeapMB) : null,
        workPlan: workPlanSummary,
        delegateInfo: session.delegateInfo || null,
      };
    });

    return jsonResult({
      sessions: formattedSessions,
      count: formattedSessions.length,
      timeRange: { startTime: args.start_time, endTime: args.end_time },
      syncMode: args.sync || false,
    });
  }
});

// ─── Client Health Assessment (admin-only) ──────────────────────────────────

mcpToolRegistry.register({
  name: 'list_all_clients',
  definition: {
    name: 'list_all_clients',
    description: `List all client accounts (including admins) with quick health indicators. Admin-only tool.

Returns for each client:
- userId: internal account id — use this to map a userId (e.g. from get_chat_history) back to a human-readable email/displayName
- displayName, email, roles
- has_ads: whether they have a Meta ad account connected
- has_lander: whether they have landing pages (productDomain or seoDomains)
- has_crm: whether they have CRM integrations (email domain, LinkedIn)
- last_activity: last login timestamp
- signup_time: account creation / sign-up timestamp
- subscription_type: subscription tier (e.g. Free, Basic, Pro)
- stripe_customer_id: Stripe customer ID (null if not set)
- current_period_end: ISO date of current billing period end (null if not set)
- has_payment_method: whether the client has a payment method on file in Stripe
- monthly_amount_cents: most recent invoice amount in cents (e.g. 4900 = $49.00), null if not set

Use this for a quick overview of all clients before diving into individual health assessments with assess_client_health.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET',
      path: '/api/client-health',
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'assess_client_health',
  definition: {
    name: 'assess_client_health',
    description: `Assess the health of a specific client account across three layers: ads, landing pages, and lead quality. Admin-only tool.

Returns a structured health assessment with:
- **Ads layer**: Meta ad account connectivity, active campaigns
- **Lander layer**: Landing page / website presence (productDomain, seoDomains)
- **Lead quality layer**: CRM / lead capture integrations (email domain, LinkedIn)
- **Creative variety**: Distinct creatives, cannibalization warnings, fatigue indicators
- **Overall status**: healthy / mediocre / at-risk / blocked with reasons

Use this to quickly diagnose a client's marketing funnel completeness.`,
    inputSchema: {
      type: 'object',
      properties: {
        client_name_or_email: {
          type: 'string',
          description: 'The client\'s email address or display name. Email lookup is tried first, then name matching.'
        }
      },
      required: ['client_name_or_email']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/client-health/${encodeURIComponent(args.client_name_or_email)}`,
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

// ─── Admin landing-page discovery/reassociation (ENG-721, admin-only) ───────

mcpToolRegistry.register({
  name: 'resolve_landing_page_by_url',
  definition: {
    name: 'resolve_landing_page_by_url',
    description: `Resolve a landing page by its live URL or domain across ALL accounts. Admin-only tool.

Use this when a customer references a live page (e.g. "https://acme.agentwebforms.com/book-a-demo") and you need to find which account owns it — list_landing_pages only shows the calling user's own pages.

Returns matches with the page record (id, status, lead list), the owner (userId, email, orgId), and the canonical live URL. Returns 404 when no page matches. If \`scannedAll\` is false the lookup hit its scan cap and a non-match is inconclusive.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The live page URL or bare hostname to resolve, e.g. "https://acme.agentwebforms.com/book-a-demo" or "acme.agentwebforms.com".'
        }
      },
      required: ['url']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/admin/landing-pages/resolve?url=${encodeURIComponent(args.url)}`,
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'share_landing_page_with_org',
  definition: {
    name: 'share_landing_page_with_org',
    description: `Enable org-level visibility for a landing page's owner organization and grant named org members edit access. Admin-only tool.

Works entirely through share settings — no page duplication, no redeploy, no raw database access. The members must already belong to the page owner's organization. Returns the updated share state plus each member's effective access (canView/canEdit) so you can verify the grant took effect.

Find the page id first with resolve_landing_page_by_url or list_landing_pages.`,
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page id.' },
        member_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Org member emails (or userIds) to grant edit access.'
        }
      },
      required: ['page_id', 'member_emails']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/admin/landing-pages/${encodeURIComponent(args.page_id)}/org-share`,
      context: ctx(context),
      body: { memberEmails: args.member_emails }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_landing_page_effective_view',
  definition: {
    name: 'get_landing_page_effective_view',
    description: `Report what a specific user actually sees for a landing page: whether they can view it, whether they can edit it, the canonical live URL, deploy status, and the connected lead list. Admin-only tool.

Use this after share_landing_page_with_org to verify the target member's effective access, or to diagnose "user can't see the page" reports.`,
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page id.' },
        member: { type: 'string', description: 'The user to check — email or userId.' }
      },
      required: ['page_id', 'member']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/admin/landing-pages/${encodeURIComponent(args.page_id)}/effective-view?member=${encodeURIComponent(args.member)}`,
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

// ─── Lifecycle Drip segmentation (admin-only) ───────────────────────────────

mcpToolRegistry.register({
  name: 'get_users_by_lifecycle_stage',
  definition: {
    name: 'get_users_by_lifecycle_stage',
    description: `List users filtered by their onboarding lifecycle stage. Admin-only tool — used to segment users for the Lifecycle Drip campaign engine.

Stages in order of engagement:
- \`signed_up_no_start\` — account exists but no onboarding events recorded
- \`goal_selected\` — picked a goal (e.g. paid_ads, seo) but no brand yet
- \`brand_submitted\` / \`brand_skipped\` — completed or skipped the brand step
- \`data_connected\` — connected CRM / data source
- \`channel_connected\` — connected an outbound channel
- \`onboarding_completed\` — finished onboarding (no recent activity)
- \`active\` — finished onboarding AND recently active
- \`stale\` — finished onboarding but no activity for 30+ days

Returns a structured list (NOT markdown) with: \`userId\`, \`email\`, \`displayName\`, \`companyName\`, \`onboardingStage\`, \`onboardingGoal\` (from the goal_selected event, if present), \`lastActiveAt\`, \`createdAt\`, \`onboardingEventCount\`, \`emmaHelpInterests\`. The drip campaign UI consumes this list directly.

Typical prompts this answers:
- "show me everyone who dropped at the brand step" → stage=brand_skipped or signed_up_no_start
- "who hasn't logged in for 7 days?" → lastActivityBefore=<now-7d>
- "list stale users with completed onboarding" → stage=stale`,
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: [
            'signed_up_no_start',
            'goal_selected',
            'brand_submitted',
            'brand_skipped',
            'data_connected',
            'channel_connected',
            'onboarding_completed',
            'active',
            'stale',
          ],
          description: 'Onboarding stage to filter by. Omit to return all users with any stage set.',
        },
        lastActivityBefore: {
          type: 'string',
          description: 'ISO 8601 date. Only return users whose lastActiveAt is before this timestamp. Users with no lastActiveAt at all are excluded (we cannot prove they were inactive). Example: "2026-04-10T00:00:00Z".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Cap the number of users returned (max 500). Omit to return up to 500 by default.',
        },
      },
      required: [],
    },
  },
  execute: async (args: any, context: any) => {
    const queryParams: Record<string, string> = {};
    if (typeof args.stage === 'string' && args.stage) queryParams.stage = args.stage;
    if (typeof args.lastActivityBefore === 'string' && args.lastActivityBefore) {
      queryParams.lastActivityBefore = args.lastActivityBefore;
    }
    if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
      queryParams.limit = String(Math.max(1, Math.floor(args.limit)));
    }

    const data = await mcpFetch({
      method: 'GET',
      path: '/api/onboarding/users',
      context: ctx(context),
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    });
    return jsonResult(data);
  },
});

// ─── CRM lead segmentation ──────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'get_leads_by_crm_criteria',
  definition: {
    name: 'get_leads_by_crm_criteria',
    description: `Preview which CRM leads (from AW-Leads, scoped to the caller's own lead lists) match a segment query. Use this before creating a drip campaign to confirm who will be targeted. Read-only — does not persist a campaign.

Supported criteria (all optional; leaving a criterion unset means "any"):
- \`lifecycle\`: lifecycle stage of the lead. One of \`unknown\`, \`inbox\`, \`signed_up\`, \`in_deal\`, \`trialing\`, \`paying\`, \`at_risk\`, \`churned\`.
- \`min_heat_score\`: minimum heat score (0-100). Leads below this score are excluded. Missing heat scores count as 0.
- \`utm_source\`: exact-match filter on the lead's attribution source (e.g. \`linkedin\`, \`google\`, \`newsletter\`).
- \`lead_list_id\`: scope to a single lead list. If omitted, every list owned by the caller is searched.
- \`limit\`: maximum number of sample leads to return (default 20, max 100). The \`total\` field always reflects the full matching count.

Example:
  action inputs: { lifecycle: "trialing", min_heat_score: 50, limit: 10 }
  response: { total: 42, sampleSize: 10, leads: [...], criteria: {...} }`,
    inputSchema: {
      type: 'object',
      properties: {
        lifecycle: {
          type: 'string',
          enum: [
            'unknown',
            'inbox',
            'signed_up',
            'in_deal',
            'trialing',
            'paying',
            'at_risk',
            'churned',
          ],
          description: 'Lifecycle stage filter.',
        },
        min_heat_score: {
          type: 'number',
          description: 'Minimum heat score (0-100). Leads below this value are excluded.',
        },
        utm_source: {
          type: 'string',
          description: 'Exact-match filter on attribution source (e.g. linkedin, google).',
        },
        lead_list_id: {
          type: 'string',
          description: 'Restrict to a single lead list. Omit to search every list owned by caller.',
        },
        limit: {
          type: 'integer',
          description: 'Sample size to return. Default 20, max 100.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  execute: async (args: any, context: any) => {
    const body: Record<string, any> = {};
    if (typeof args.lifecycle === 'string') body.lifecycle = args.lifecycle;
    if (typeof args.min_heat_score === 'number')
      body.minHeatScore = args.min_heat_score;
    if (typeof args.utm_source === 'string') body.utmSource = args.utm_source;
    if (typeof args.lead_list_id === 'string')
      body.leadListId = args.lead_list_id;
    if (typeof args.limit === 'number') body.limit = args.limit;

    const data = await mcpFetch({
      method: 'POST',
      path: '/api/drip-campaigns/preview-segment',
      context: ctx(context),
      body,
    });
    return jsonResult(data);
  },
});

mcpToolRegistry.register({
  name: 'get_registration_status',
  definition: {
    name: 'get_registration_status',
    description: `Join a batch of emails against AgentWeb user accounts to learn which ones registered (signed up) and which became premium (paying/trialing) users. When computing a funnel Registered or Premium stage, you MUST call this on the lead emails to get real signup/payment status — do not infer it from list_all_clients or search. Admin-only (non-admin callers get a 403) and read-only.

For each input email the response reports:
- \`registered\`: true if a (non-deleted) AgentWeb account exists for that email.
- \`isPremium\`: true if that account's subscription is active or trialing.
- \`subscriptionStatus\` / \`subscriptionType\` / \`userId\` / \`createdAt\`: present when registered.

Emails with no matching account come back as \`{ registered: false, isPremium: false }\`. The response also includes a \`summary\` with \`total\`, \`registered\`, and \`premium\` counts.

Set \`include_chat_session_count: true\` to also get \`chatSessionCount\` (a live count of each registered user's chat sessions) — use it for a funnel Usage/Active stage instead of scraping the admin page. It costs one extra query per registered user, so only request it when you need usage.

Example:
  action inputs: { emails: ["lead1@acme.com", "lead2@acme.com"] }
  response: { statuses: [ { email: "lead1@acme.com", registered: true, isPremium: true, ... }, { email: "lead2@acme.com", registered: false, isPremium: false } ], summary: { total: 2, registered: 1, premium: 1 } }`,
    inputSchema: {
      type: 'object',
      properties: {
        emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Emails to look up (1-1000). Case/whitespace-insensitive; duplicates are collapsed.',
        },
        include_chat_session_count: {
          type: 'boolean',
          description: 'When true, also return a live chatSessionCount for each registered user (for a funnel Usage/Active stage). Costs one extra query per registered user. Default false.',
        },
      },
      required: ['emails'],
      additionalProperties: false,
    },
  },
  execute: async (args: any, context: any) => {
    const emails = Array.isArray(args?.emails)
      ? args.emails
          .filter((e: unknown) => typeof e === 'string')
          .map((e: string) => e.trim())
          .filter((e: string) => e.length > 0)
      : [];

    const data = await mcpFetch({
      method: 'POST',
      path: '/api/crm/registration-status',
      context: ctx(context),
      body: { emails, includeChatSessionCount: args?.include_chat_session_count === true },
    });
    return jsonResult(data);
  },
});

// ─── PR Digest (admin-only) ─────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'get_pr_digest',
  definition: {
    name: 'get_pr_digest',
    description: 'Fetch merged pull requests from GitHub repositories (agentweb and agentweb-customer-portal) within a time range and return a formatted summary. Defaults to the past 24 hours. Admin-only. Use this to generate change digests to send to the team. When the user asks for "last N days" or a specific date range, always pass the appropriate days_ago or since/until — do not rely on the default.',
    inputSchema: {
      type: 'object',
      properties: {
        days_ago: {
          type: 'integer',
          description: 'Number of days to look back from now (e.g., 7 for the last 7 days). Use this when the user specifies a relative time range like "last week" or "past 7 days". Takes precedence over since if both are provided.'
        },
        since: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g., "2026-03-19T00:00:00Z"). Defaults to 24 hours ago if neither days_ago nor since is provided.'
        },
        until: {
          type: 'string',
          description: 'End time in ISO 8601 format (e.g., "2026-03-20T00:00:00Z"). Defaults to now.'
        }
      },
      required: []
    }
  },
  execute: async (_args: any) => {
    const now = new Date();
    const daysAgo: number | undefined = _args.days_ago;
    const computedSince = daysAgo != null
      ? new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since = daysAgo != null ? computedSince.toISOString() : (_args.since || computedSince.toISOString());
    const until = _args.until || now.toISOString();

    const results = await fetchMergedPRs(since, until);
    const totalPRs = results.reduce((sum, r) => sum + r.prs.length, 0);

    return jsonResult({
      totalPRs,
      since,
      until,
      text: formatDigestText(results),
      results,
    });
  }
});

mcpToolRegistry.register({
  name: 'freeze_user_account',
  definition: {
    name: 'freeze_user_account',
    description: 'Freeze (deactivate) or unfreeze (reactivate) a user account. Admin only. Use this to disable bot accounts or re-enable legitimate accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'The userId of the account to freeze or unfreeze' },
        action: { type: 'string', enum: ['freeze', 'unfreeze'], description: '"freeze" to deactivate the account, "unfreeze" to reactivate it' }
      },
      required: ['user_id', 'action']
    }
  },
  execute: async (args: any, context: any) => {
    const path = args.action === 'freeze'
      ? `/api/admin/users/${args.user_id}/deactivate`
      : `/api/admin/users/${args.user_id}/reactivate`;
    const data = await mcpFetch({ method: 'POST', path, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_user_notes',
  definition: {
    name: 'manage_user_notes',
    description: `Manage time-stamped admin notes for a specific user. Notes are stored per user and sorted newest-first. Up to 50 notes per user; adding a 51st removes the oldest. Use this to track client status, blockers, or action items over time. Admin only.

You can identify the user by either user_id OR email — provide one of them.

Actions:
- list: Get all notes for a user (newest first)
- add: Add a new note for a user
- delete: Delete a specific note by note_id`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'delete'],
          description: 'The action to perform'
        },
        user_id: { type: 'string', description: 'The userId of the user (use this OR email)' },
        email: { type: 'string', description: 'The email address of the user (use this OR user_id)' },
        content: { type: 'string', description: 'The note text (required for add)' },
        note_id: { type: 'string', description: 'The note ID (required for delete)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const { action, content, note_id } = args;
    let { user_id, email } = args;

    if (!user_id && !email) return jsonResult({ error: 'Either user_id or email is required' });

    // Resolve email to userId if only email was provided
    if (!user_id && email) {
      const lookup = await mcpFetch({ method: 'GET', path: `/api/admin/users/lookup?email=${encodeURIComponent(email)}`, context: ctx(context) });
      if (lookup.error || !lookup.userId) return jsonResult({ error: `User not found for email: ${email}` });
      user_id = lookup.userId;
    }

    switch (action) {
      case 'list': {
        const data = await mcpFetch({ method: 'GET', path: `/api/admin/users/${user_id}/notes`, context: ctx(context) });
        return jsonResult(data);
      }
      case 'add': {
        if (!content) return jsonResult({ error: 'content is required for add' });
        const data = await mcpFetch({ method: 'POST', path: `/api/admin/users/${user_id}/notes`, context: ctx(context), body: { content } });
        return jsonResult(data);
      }
      case 'delete': {
        if (!note_id) return jsonResult({ error: 'note_id is required for delete' });
        const data = await mcpFetch({ method: 'DELETE', path: `/api/admin/users/${user_id}/notes/${note_id}`, context: ctx(context) });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'manage_scoring_judges',
  definition: {
    name: 'manage_scoring_judges',
    description: 'Manage the judge system prompts used to evaluate chat session satisfaction. Admin only. Actions: get_default (view current default prompt), update_default (replace default prompt text), reset_default (revert to hardcoded default), list (list all custom judges), create (add a new custom judge), update (edit an existing custom judge), delete (remove a custom judge).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_default', 'update_default', 'reset_default', 'list', 'create', 'update', 'delete'],
          description: 'The action to perform'
        },
        system_prompt: { type: 'string', description: 'The system prompt text (required for update_default, create, and update actions)' },
        judge_id: { type: 'string', description: 'The judge ID (required for update and delete actions)' },
        name: { type: 'string', description: 'Human-readable name for the judge (required for create, optional for update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const { action, system_prompt, judge_id, name } = args;
    switch (action) {
      case 'get_default': {
        const data = await mcpFetch({ method: 'GET', path: '/api/settings/scoring-judges/default-prompt', context: ctx(context) });
        return jsonResult(data);
      }
      case 'update_default': {
        if (!system_prompt) return jsonResult({ error: 'system_prompt is required for update_default' });
        const data = await mcpFetch({ method: 'PUT', path: '/api/settings/scoring-judges/default-prompt', context: ctx(context), body: { systemPrompt: system_prompt } });
        return jsonResult(data);
      }
      case 'reset_default': {
        const data = await mcpFetch({ method: 'DELETE', path: '/api/settings/scoring-judges/default-prompt', context: ctx(context) });
        return jsonResult(data);
      }
      case 'list': {
        const data = await mcpFetch({ method: 'GET', path: '/api/settings/scoring-judges', context: ctx(context) });
        return jsonResult(data);
      }
      case 'create': {
        if (!name || !system_prompt) return jsonResult({ error: 'name and system_prompt are required for create' });
        const data = await mcpFetch({ method: 'POST', path: '/api/settings/scoring-judges', context: ctx(context), body: { name, systemPrompt: system_prompt } });
        return jsonResult(data);
      }
      case 'update': {
        if (!judge_id) return jsonResult({ error: 'judge_id is required for update' });
        const data = await mcpFetch({ method: 'PUT', path: `/api/settings/scoring-judges/${judge_id}`, context: ctx(context), body: { name, systemPrompt: system_prompt } });
        return jsonResult(data);
      }
      case 'delete': {
        if (!judge_id) return jsonResult({ error: 'judge_id is required for delete' });
        const data = await mcpFetch({ method: 'DELETE', path: `/api/settings/scoring-judges/${judge_id}`, context: ctx(context) });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'save_file',
  internal: true,
  definition: {
    name: 'save_file',
    description: 'Save a file to cloud storage.',
    inputSchema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', 'x-aliases': ['filename', 'fileName', 'name'], description: 'Name for the file' },
        file_content: { type: 'string', 'x-aliases': ['content', 'file', 'text', 'body', 'html_content', 'markdown'], description: 'File content to save' }
      },
      required: ['file_name', 'file_content']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/save-file', context: ctx(context),
      body: { file_name: args.file_name, file_content: args.file_content }
    });
    return jsonResult(data);
  }
});

// ─── Account ─────────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'get_account_status',
  definition: {
    name: 'get_account_status',
    description: "Get the current user's account status, subscription plan, and usage.",
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const c = ctx(context);

    // Plan/status comes from /api/auth/me. Let auth errors propagate — if we can't
    // resolve the account, returning a fake "status" would be misleading.
    const me = await mcpFetch({ method: 'GET', path: '/api/auth/me', context: c });

    // API key count is best-effort: a failure to list keys must not block the
    // account-status read, so it falls back to 0.
    let apiKeyCount = 0;
    try {
      const keysResponse = await mcpFetch({ method: 'GET', path: '/api/v1/agent/api-keys', context: c });
      apiKeyCount = Array.isArray(keysResponse?.keys) ? keysResponse.keys.length : 0;
    } catch {
      apiKeyCount = 0;
    }

    // Curate a stable, minimal shape. Never echo the raw /me payload — it carries
    // sensitive fields (stripe ids, tokens, internal flags).
    return jsonResult({
      email: me?.email ?? null,
      subscription_plan: me?.subscriptionType ?? 'Free',
      subscription_status: me?.subscription_status ?? 'inactive',
      current_period_end: me?.current_period_end ?? null,
      allowed_features: Array.isArray(me?.allowedPages) ? me.allowedPages : [],
      api_key_count: apiKeyCount,
    });
  }
});
