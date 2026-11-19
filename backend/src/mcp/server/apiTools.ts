import { mapManageBrandUpdate } from '../../utils/brandGuidelines';
import { summarizeItemizedUsage, USAGE_MONTH_PATTERN } from './usageBreakdown';
import { findAmbiguousMergeTargets, findConflictingMergeTargets, findStepContentLoss, mergeWorkPlanSteps, summarizeStepChange } from '../../services/workPlanSteps';
import { carryStoredStepModels } from '../../services/agentMode/workPlanStepModels';
/**
 * API Tools — MCP tools that wrap the backend REST API via HTTP self-calls.
 *
 * Every tool goes through authenticateToken middleware by making an HTTP
 * request to localhost with a short-lived JWT. This eliminates the IDOR
 * surface that existed when tools called agentModeService directly.
 *
 * No direct service calls — all tools route through the REST API.
 */

import { createHash } from 'node:crypto';
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import './adminLookupTools';
import './readEmailTool';
// Smartlead for outside agents (aw_ keys with smartlead:read / smartlead:control only).
import './smartleadTools';
import './conversionSummaryTool';
import type { AgentRunStatus } from '../../services/agentMode/runStore';
import { fetchMergedPRs, formatDigestText } from '../../services/prDigestService';
import { SCHEDULED_CHATS_DEFAULT_LIMIT, SCHEDULED_CHATS_MAX_LIMIT } from '../../utils/scheduledChatsPage';

// ─── Helpers ────────────────────────────────────────────────────────────────

// ENG-982: `ctx` and `jsonResult` moved to ./toolHelpers so workflowTools.ts can
// share them instead of keeping a second copy. Behaviour unchanged.
import { omitBranchedFrom } from '../../utils/adminOnlyMessageFilter';
import { branchOwnMessages } from '../../services/agentMode/chatBranching';
import { omitActiveRun } from '../../services/agentMode/sessionActiveRunGuard';
import { ctx, jsonResult, CLIENT_ID_SCHEMA_PROPERTY } from './toolHelpers';
import { publishWithdrawnMidFlight } from '../../utils/scheduledPublishConsentGuard';
import { resolveClientScopedContext } from './adminClientScope';
import { executeCrossAccountLeadAdd, normalizeAddLeadPayload, previewLeadAdd, resolveDryRunFlag } from './manageLeadsCrossAccountAdd';
import { buildLeadListQuery, executeLeadAdd, executeLeadDelete, executeLeadListDelete, executeLeadListUpdate, executeLeadUpdate, MAX_LEAD_ROWS_PER_CALL } from './manageLeadsWrites';

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
    description: 'Send a message to an Emma chat session and get a response. Use this to delegate any marketing or growth request in natural language; Emma plans and executes it end to end with capabilities well beyond the tools listed here. Do not pre-judge from the visible tool set whether something is supported — hand the request to Emma. If a task genuinely cannot be done or needs a prerequisite (e.g. a connected account), Emma says so and explains what is needed; relay her response rather than declaring the capability unavailable yourself. If the response (or emma_get_session) shows an awaiting pendingUserQuestion (a blocking legacy AskUserQuestion card) or an awaiting pendingApprovalDeck (a blocking question/approval deck), do NOT answer it by sending a plain message here — that abandons the question instead of answering it. Use emma_answer_question for pendingUserQuestion, or emma_answer_question_deck for pendingApprovalDeck.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The chat session ID' },
        message: { type: 'string', description: 'The message to send' },
        llm_model: { type: 'string', description: 'LLM model to use (optional)' },
        backup_model: { type: 'string', description: 'Legacy field, retained for compatibility. Since ENG-1211 no threshold below the hard usage cap restricts or rewrites a model, so this is never consulted. The server remains authoritative on model eligibility and on the hard cap.' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Array of image URLs (S3 paths or public URLs) to attach to the message' }
      },
      required: ['session_id', 'message']
    }
  },
  execute: async (args: any, context: any) => {
    const body: any = {
      sessionId: args.session_id,
      userMessage: args.message,
      llmModel: args.llm_model,
      llmBackupModel: args.backup_model,
    };
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

// ENG-1635/1644 PR2: the emma_answer_question tool (ENG-400's original MCP
// transport for the AskUserQuestion primitive) is deleted — it posted a
// structured `questionAnswer` body that generateResponse no longer handles
// (nothing ever populates session.pendingUserQuestion for it to resolve
// against anymore). emma_answer_question_deck below is the sole, sufficient
// MCP transport for every producer that used to reach this primitive.

// ENG-1635/1644 (ask_user_question retirement): the deck-of-one MCP transport.
// ask_user_question and the Meta objective-confirmation gate no longer
// populate pendingUserQuestion at all — they build a single-item
// pendingApprovalDeck instead, through the SAME present_question_deck deck
// mechanism, for UI consistency with the rest of the approval deck. Without
// this tool, an MCP client would see pendingApprovalDeck on emma_get_session
// but have no structured way to resolve it. Posts through the same
// `deckAnswer` channel the chat card uses (POST /api/agent-mode/generate
// body.deckAnswer); prose is never accepted as an answer here either.
mcpToolRegistry.register({
  name: 'emma_answer_question_deck',
  definition: {
    name: 'emma_answer_question_deck',
    description: 'Answer a blocking single-question deck card on an Emma session (see pendingApprovalDeck on emma_get_session, when it has exactly one item) — the sole MCP transport for ask_user_question and the Meta campaign-objective confirmation. Provide option_id for a direct pick, or delegate:true for "Let Emma decide" (takes the recommended option). A plain emma_send_message reply is NOT an answer — it abandons the open deck instead, same as typing past the card in the chat UI. Cards that need a person\'s approval (adding or releasing contacts in Smartlead, a hot-lead call, activating a CRM sequence, a paused Meta campaign bundle) cannot be approved this way: approving one returns an error with the link where the person approves it in AgentWeb; declining one works.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The chat session ID with the awaiting deck.' },
        deck_id: { type: 'string', description: 'The pendingApprovalDeck.deckId from emma_get_session — must match the currently awaiting deck.' },
        item_id: { type: 'string', description: 'The pendingApprovalDeck.items[0].itemId from emma_get_session — the single item being answered.' },
        option_id: { type: 'string', description: 'The chosen option id. Required unless delegate is true.' },
        delegate: { type: 'boolean', description: 'Set true for "Let Emma decide" — proceeds with the recommended option, logged as a delegation. option_id is ignored when true.' },
        label: { type: 'string', description: 'Optional human-readable text to show as the chat message for this selection (e.g. the option label). Defaults to option_id, or "Let Emma decide" when delegating.' },
      },
      required: ['session_id', 'deck_id', 'item_id'],
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
        deckAnswer: {
          deckId: args.deck_id,
          answers: [{ itemId: args.item_id, verdict: delegate ? '' : args.option_id, delegated: delegate }],
        },
      },
    });
    return jsonResult(data);
  },
});

// ENG-2057: expose the customer work-plan lifecycle as discrete outcomes so
// connector discovery can rank launch and structured answering independently.
// Keep both lifecycle tools public: external agents need the launch and unblock pair.
mcpToolRegistry.register({
  name: 'emma_launch_work_plan',
  requiresUserAccount: true,
  definition: {
    name: 'emma_launch_work_plan',
    description: 'Launch an accessible predefined work plan in an existing Emma session. Find a plan with list_predefined_work_plans first, then poll progress with emma_get_session. Refuses to replace a different active work plan.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The Emma session ID.' },
        plan_id: { type: 'string', description: 'The predefined plan ID. Alias: work_plan_id.' },
        work_plan_id: { type: 'string', description: 'Alias for plan_id.' },
      },
      required: ['session_id'],
    },
  },
  execute: async (args: any, context: any) => {
    const planId = args.plan_id ?? args.work_plan_id;
    if (typeof planId !== 'string' || planId.trim() === '') {
      return jsonResult({ success: false, message: 'plan_id (or work_plan_id) is required.' });
    }
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/agent-mode/session/${encodeURIComponent(args.session_id)}/work-plan`,
      context: ctx(context),
      body: { planId },
    });
    return jsonResult(data);
  },
});

mcpToolRegistry.register({
  name: 'emma_answer_work_plan_input',
  definition: {
    name: 'emma_answer_work_plan_input',
    description: 'Answer a pending structured work-plan input request shown by emma_get_session. Values must be keyed by the field IDs in pendingWorkPlanInput. A plain emma_send_message does not submit these structured values.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The Emma session ID.' },
        request_id: { type: 'string', description: 'The pendingWorkPlanInput.requestId. Alias: work_plan_request_id.' },
        work_plan_request_id: { type: 'string', description: 'Alias for request_id.' },
        values: { type: 'object', additionalProperties: true, description: 'Answers keyed by pendingWorkPlanInput field ID.' },
        label: { type: 'string', description: 'Optional chat-visible summary. Defaults to a neutral submission message.' },
      },
      required: ['session_id', 'values'],
    },
  },
  execute: async (args: any, context: any) => {
    const requestId = args.request_id ?? args.work_plan_request_id;
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return jsonResult({ success: false, message: 'request_id (or work_plan_request_id) is required.' });
    }
    const data = await mcpFetch({
      method: 'POST',
      path: '/api/agent-mode/generate',
      context: ctx(context),
      body: {
        sessionId: args.session_id,
        userMessage: typeof args.label === 'string' && args.label.trim() !== ''
          ? args.label
          : 'Submitted requested work plan details.',
        workPlanInputAnswer: { requestId, values: args.values },
      },
    });
    return jsonResult(data);
  },
});

mcpToolRegistry.register({
  name: 'emma_get_session',
  definition: {
    name: 'emma_get_session',
    description: 'Get details of an Emma chat session by ID, including the active workPlan summary and pendingWorkPlanInput when structured details are awaiting an answer, and pendingApprovalDeck when a blocking question/approval deck is awaiting (a single-item deck is the deck-of-one that ask_user_question and the Meta objective confirmation use). Pass run_id to check durable terminal status: completion_confirmed means the run ended, not that it succeeded. Missing records and detached handoffs remain unconfirmed. Check status before assuming a run has completed; resolve an "awaiting" pendingApprovalDeck with emma_answer_question_deck and pendingWorkPlanInput with emma_answer_work_plan_input, never with a plain emma_send_message reply. pendingUserQuestion may still appear on a session that predates this mechanism, but nothing produces a new one — always resolve via pendingApprovalDeck.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID' },
        run_id: { type: 'string', description: 'The run_id returned by a detached task (runId from emma_send_message). Pass it to check durable terminal status.' },
      },
      required: ['session_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/agent-mode/session/${encodeURIComponent(args.session_id)}`, context: ctx(context) });
    let run: AgentRunStatus | null = null;
    if (typeof args.run_id === 'string' && args.run_id) {
      try {
        const record: any = await mcpFetch({
          method: 'GET', path: `/api/agent-mode/runs/${encodeURIComponent(args.run_id)}`, context: ctx(context),
        });
        // This is a network boundary: validate identity and every field used as evidence.
        if (record && record.runId === args.run_id && record.sessionId === args.session_id &&
            ['running', 'completed', 'failed', 'interrupted'].includes(record.status) &&
            (record.finishReason == null || typeof record.finishReason === 'string')) {
          run = { runId: record.runId, sessionId: record.sessionId, status: record.status,
            finishReason: record.finishReason ?? null };
        }
      } catch {
        // A refusal, missing record or operational failure is never completion evidence.
      }
    }
    return jsonResult({
      // ENG-112: branch-family linkage is portal-only; MCP clients never see it.
      // ENG-110: the cross-instance run marker (runId/instanceId) is internal; MCP clients never see it.
      ...omitActiveRun(omitBranchedFrom(data)),
      run,
      // Terminal means the request ended, not that all detached or continuation work did.
      completion_confirmed: run !== null && run.status !== 'running' &&
        !['detached_still_building', 'timeout_partial_media', 'timeout_partial_work'].includes(run.finishReason ?? '') &&
        data?.pendingUserQuestion?.status !== 'awaiting' && data?.pendingWorkPlanInput?.status !== 'awaiting',
    });
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
    return jsonResult(omitActiveRun(omitBranchedFrom(data)));
  }
});

mcpToolRegistry.register({
  name: 'emma_list_models',
  definition: {
    name: 'emma_list_models',
    description: 'List the Emma models currently selectable for this account. Every entitled model stays selectable right up to the hard usage cap; only a paused account returns an empty list with canGenerate false. scheduleBackupModels is a legacy field and no longer restricts anything.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/agent-mode/model-options', context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_tasks',
  definition: {
    name: 'list_tasks',
    description: 'List all tasks owned by the authenticated user, or a specific client (admin-only, via client_id).',
    inputSchema: {
      type: 'object',
      properties: { client_id: CLIENT_ID_SCHEMA_PROPERTY },
      required: []
    }
  },
  /** Lists tasks for the caller, or (admin-only) for `args.client_id`'s account. */
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET',
      path: '/api/tasks',
      context: await resolveClientScopedContext(context, args?.client_id, 'list_tasks')
    });
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
        const data = await mcpFetch({ method: 'GET', path: `/api/tasks/${encodeURIComponent(args.task_id)}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const { action, task_id, ...updates } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/tasks/${encodeURIComponent(task_id)}`, context: c, body: updates });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/tasks/${encodeURIComponent(args.task_id)}`, context: c });
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
    const data = await mcpFetch({ method: 'POST', path: `/api/tasks/${encodeURIComponent(args.task_id)}/execute`, context: ctx(context) });
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
      ? `/api/tasks/${encodeURIComponent(args.task_id)}/executions/${encodeURIComponent(args.execution_id)}`
      : `/api/tasks/${encodeURIComponent(args.task_id)}/executions`;
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
    const data = await mcpFetch({ method: 'GET', path: `/api/schedules/task/${encodeURIComponent(args.task_id)}`, context: ctx(context) });
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
        const data = await mcpFetch({ method: 'PUT', path: `/api/schedules/${encodeURIComponent(schedule_id)}`, context: c, body: updates });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/schedules/${encodeURIComponent(args.schedule_id)}`, context: c });
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
    description: 'List scheduled chats (newest first) for the authenticated user, or a specific client (admin-only, via client_id). Paginated: returns { items, nextCursor }; pass nextCursor back as cursor to get the next page (null = last page).',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: CLIENT_ID_SCHEMA_PROPERTY,
        limit: { type: 'number', description: `Page size (default ${SCHEDULED_CHATS_DEFAULT_LIMIT}, max ${SCHEDULED_CHATS_MAX_LIMIT})` },
        cursor: { type: 'string', description: 'Opaque nextCursor from a previous page' },
      },
      required: []
    }
  },
  /**
   * Lists scheduled chats for the caller, or (admin-only) for `args.client_id`'s account.
   * ENG-1611: always requests a bounded page so a large client account cannot
   * produce an unbounded response.
   */
  execute: async (args: any, context: any) => {
    const limit = Number.isFinite(Number(args?.limit))
      ? Math.min(SCHEDULED_CHATS_MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit))))
      : SCHEDULED_CHATS_DEFAULT_LIMIT;
    const queryParams: Record<string, string> = { limit: String(limit) };
    if (typeof args?.cursor === 'string' && args.cursor) queryParams.cursor = args.cursor;
    const data = await mcpFetch({
      method: 'GET',
      path: '/api/agent-mode/scheduled-chats',
      queryParams,
      context: await resolveClientScopedContext(context, args?.client_id, 'list_scheduled_chats')
    });
    return jsonResult(data);
  }
});

const MANAGE_SCHEDULED_CHAT_ACTIONS = ['create', 'update', 'toggle', 'delete'];

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** ENG-1656: field-named validation for manage_scheduled_chat; null when the call is well-formed. */
export function validateManageScheduledChatArgs(args: any): string | null {
  const action = args?.action;
  if (!MANAGE_SCHEDULED_CHAT_ACTIONS.includes(action)) return null; // default branch reports Unknown action
  const fail = (msg: string) => `Invalid manage_scheduled_chat arguments: ${msg}`;
  if (action === 'create') {
    const missing = ['schedule_name', 'starting_message', 'schedule_frequency'].filter((f) => !isNonEmptyString(args[f]));
    if (missing.length) return fail(`Missing required fields: ${missing.join(', ')} (required for action "create")`);
  } else if (!isNonEmptyString(args.schedule_id)) {
    return fail(`schedule_id is required for action "${action}" — call list_scheduled_chats to get one`);
  }
  if (action === 'toggle' && args.status !== 'active' && args.status !== 'paused') {
    return fail('status must be "active" or "paused" for action "toggle"');
  }
  if (action === 'create' || action === 'update') {
    if (args.email_notifications !== undefined &&
        !Array.isArray(args.email_notifications)) {
      // [] is valid: the explicit "no email" opt-out (Opslane #2).
      return fail('email_notifications must be an array of email addresses when provided (use [] for no email)');
    }
    if (args.next_run_time !== undefined && Number.isNaN(Date.parse(args.next_run_time))) {
      return fail('next_run_time must be an ISO 8601 datetime (e.g. 2026-10-14T09:00:00Z)');
    }
  }
  return null;
}

mcpToolRegistry.register({
  name: 'manage_scheduled_chat',
  definition: {
    name: 'manage_scheduled_chat',
    description: 'Create, update, toggle (pause/resume), or delete a scheduled chat. Use action: "create", "update", "toggle", or "delete". For "create": schedule_name, starting_message, and schedule_frequency are REQUIRED — do not call with action "create" unless you have all three. email_notifications: omit it to email results to the requesting user by default; pass [] ONLY when the user explicitly declines email (no emails are sent). For "update": schedule_id is required; omit any field to keep its existing value — email_notifications: [] turns emails off. next_run_time must carry a UTC offset (e.g. 2026-10-19T09:00:00-04:00), or pass timezone (the user IANA zone) and give next_run_time as local time in that zone. The result echoes what was stored — nextRunTime, nextRunTimeLocal (in the schedule timezone) and emailNotifications; tell the user those stored values, not what you intended to send. IMPORTANT: When email_notifications is configured on the schedule, the system automatically emails results after every run — do NOT include notify_session or any email-sending instruction in starting_message, as that would cause duplicate emails (one from the system, one from the AI executing the tool).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'toggle', 'delete'], description: 'CRUD action' },
        schedule_id: { type: 'string', description: 'Schedule ID (required for update/toggle/delete)' },
        schedule_name: { type: 'string', description: 'Schedule name (REQUIRED for create, optional for update)' },
        starting_message: { type: 'string', description: 'The prompt/message to run on each execution (REQUIRED for create, optional for update). IMPORTANT: Do NOT include notify_session or any instruction to send an email in this prompt when email_notifications is set — the system already sends emails automatically, and adding notify_session here will cause duplicate emails.' },
        schedule_frequency: { type: 'string', description: 'Frequency: hourly, daily, weekly, monthly, every_n_days (REQUIRED for create, optional for update)' },
        frequency_interval_days: { type: 'number', description: 'Number of days between runs when schedule_frequency is every_n_days (create/update)' },
        next_run_time: { type: 'string', description: 'ISO 8601 datetime for the first/next run (create/update). Include a UTC offset (2026-10-19T09:00:00-04:00), or omit the offset AND pass timezone so it is read as local time in that zone. An offset-less time with no timezone is rejected.' },
        timezone: { type: 'string', description: 'The user\'s IANA timezone, e.g. America/New_York (create/update). Used to interpret an offset-less next_run_time and stored on the schedule for its local-calendar cadence.' },
        description: { type: 'string', description: 'Description (create/update)' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to look for in results (create/update)' },
        required_function_calls: { type: 'array', items: { type: 'string' }, description: 'Function calls required in each run (create/update). Without a tool listed here, its delivery is best-effort — the run can complete "successfully" even if the model skips it, silently. IMPORTANT (ENG-2204): if starting_message instructs posting, alerting, or notifying via Slack, ALWAYS include slack_send_message here too — an unattended run has no live approval step for it, and without this it may be silently skipped even when the task asked for it. Same reasoning applies to any other action the run must actually take (a publish tool, etc.) — list it here rather than trusting the prompt wording alone.' },
        function_call_min_calls: { type: 'object', description: 'Minimum call counts per function (create/update)' },
        email_notifications: { type: 'array', items: { type: 'string' }, description: 'Email addresses that receive results after every run (create/update). Omit on create to default to the requesting user\'s email; omit on update to keep the current recipients. Pass [] only when the user explicitly does not want email — that stores no recipients and sends nothing.' },
        daily_digest: { type: 'boolean', description: 'Send daily digest instead of per-run emails (create/update, hourly only)' },
        self_improve: { type: 'boolean', description: 'When true, after each run a reflection turn reviews the result and may automatically refine starting_message so future runs do better. Off by default (create/update).' },
        run_count: { type: 'number', description: 'Number of runs (-1 for unlimited, create/update)' },
        variables: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] }, description: 'Variable definitions for the starting message (create/update)' },
        variable_values: { type: 'object', description: 'Initial variable values (create/update)' },
        llm_model: { type: 'string', description: 'LLM model to use (create/update)' },
        backup_model: { type: 'string', description: 'Legacy field, retained for compatibility. Since ENG-1211 a scheduled run always uses its own preferred model below the hard usage cap, so this is never consulted. Omitting it changes nothing.' },
        session_id: { type: 'string', description: 'Existing chat session ID to base the schedule on (create only)' },
        revoke_autopublish: { type: 'boolean', description: 'Set true to STOP this schedule publishing to the user\'s live connected accounts on its unattended runs, so future runs draft the content and tell them what is waiting instead. Revoking is always safe and always allowed. You CANNOT turn it back on — that means posts go live without the user ever seeing them, so only they can do it, on the schedule form. If a user asks you to enable automatic posting, point them there and never claim you have enabled it.' },
        status: { type: 'string', enum: ['active', 'paused'], description: 'Status (toggle only)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    // ENG-1656: reject malformed calls before any network hop with a message that
    // names the exact field. Without this an update/toggle/delete missing
    // schedule_id hit `/scheduled-chats/undefined` and came back as a misleading
    // "Scheduled chat not found", and a create missing a required field cost a
    // round-trip before failing.
    const preflight = validateManageScheduledChatArgs(args);
    if (preflight) throw new Error(preflight);
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
        if (args.email_notifications !== undefined) {
          body.emailNotifications = args.email_notifications;
          // An explicit [] is the user declining email — tell the API it is deliberate,
          // so it neither substitutes the requester's address nor refuses the clear.
          if (Array.isArray(args.email_notifications) && args.email_notifications.length === 0) body.emailNotificationsOptOut = true;
        }
        if (args.timezone !== undefined) body.timezone = args.timezone;
        if (args.daily_digest !== undefined) body.dailyDigest = args.daily_digest;
        if (args.self_improve !== undefined) body.selfImprove = args.self_improve;
        if (args.run_count !== undefined) body.runCount = args.run_count;
        if (args.variables !== undefined) body.variables = args.variables;
        if (args.variable_values !== undefined) body.variableValues = args.variable_values;
        if (args.llm_model !== undefined) body.llmModel = args.llm_model;
        if (args.backup_model !== undefined) body.llmBackupModel = args.backup_model;
        if (args.session_id !== undefined) body.sessionId = args.session_id;
        if (args.timezone !== undefined) body.timezone = args.timezone;
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
        if (args.email_notifications !== undefined) {
          body.emailNotifications = args.email_notifications;
          // An explicit [] is the user declining email — tell the API it is deliberate,
          // so it neither substitutes the requester's address nor refuses the clear.
          if (Array.isArray(args.email_notifications) && args.email_notifications.length === 0) body.emailNotificationsOptOut = true;
        }
        if (args.timezone !== undefined) body.timezone = args.timezone;
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
            path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}/publish-consent`,
            context: c,
            body: { authorized: false },
          });
        }

        if (args.backup_model !== undefined) body.llmBackupModel = args.backup_model;
        if (args.timezone !== undefined) body.timezone = args.timezone;
        const data = await mcpFetch({ method: 'PUT', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}`, context: c, body });
        return jsonResult(publishConsent ? { ...(data as any), publishConsent } : data);
      }
      case 'toggle': {
        const data = await mcpFetch({ method: 'PATCH', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}/toggle`, context: c, body: { status: args.status } });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}`, context: c });
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
      method: 'POST', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}/test`, context: ctx(context),
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
    const data = await mcpFetch({ method: 'GET', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}/test-history`, context: ctx(context) });
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
      method: 'POST', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}/variables`, context: ctx(context),
      body: {
        variableValues: args.variable_values,
        triggerRun: args.trigger_run || false,
      }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_scheduled_chat_storage_diagnostics',
  definition: {
    name: 'get_scheduled_chat_storage_diagnostics',
    description: 'Diagnose why a scheduled chat is failing to save with a size-related error, or check whether one is at risk of it. DynamoDB caps a schedule at 400KB; this returns a byte-usage breakdown (current prompt, saved prompt-edit history, saved run history) against that limit and, when the schedule is under storage pressure, the one corrective action the user can take. Returns byte counts only — never the schedule\'s actual prompt or run content.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'The scheduled chat ID to diagnose' }
      },
      required: ['schedule_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/agent-mode/scheduled-chats/${encodeURIComponent(args.schedule_id)}/storage-diagnostics`, context: ctx(context)
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
        visibility: { type: 'string', enum: ['private', 'pending_review'], description: "Visibility, on 'update' only. 'create' ALWAYS produces a private template and ignores this field. "
          + "Only these two are settable here: 'private' (visible to you alone) and 'pending_review' "
          + "(submitted for an administrator to approve). 'system' and 'public' are platform-wide and "
          + "admin-only — asking for them is refused, not silently downgraded. To share a template with "
          + "everyone, set 'pending_review' and an administrator approves or rejects it (ENG-1716)." },
        starting_message: { type: 'string', description: 'The prompt/message template. Use {{variable_name}} for variables. (create/update)' },
        variables: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, type: { type: 'string', enum: ['text', 'long_text', 'file'] } }, required: ['name'] }, description: 'Variable definitions (auto-extracted from message if not provided)' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to verify in scheduled chat output (create/update)' },
        required_function_calls: { type: 'array', items: { type: 'string' }, description: 'Function calls required in each run (create/update). Without a tool listed here, its delivery is best-effort — the run can complete "successfully" even if the model skips it, silently. IMPORTANT (ENG-2204): if starting_message instructs posting, alerting, or notifying via Slack, ALWAYS include slack_send_message here too — an unattended run has no live approval step for it, and without this it may be silently skipped even when the task asked for it. Same reasoning applies to any other action the run must actually take (a publish tool, etc.) — list it here rather than trusting the prompt wording alone.' },
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
        const data = await mcpFetch({ method: 'PUT', path: `/api/agent-mode/schedule-templates/${encodeURIComponent(args.template_id)}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/agent-mode/schedule-templates/${encodeURIComponent(args.template_id)}`, context: c });
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
        backup_model: { type: 'string', description: 'Legacy field, retained for compatibility. Since ENG-1211 the preferred model is not restricted at run time below the hard usage cap, so this is never consulted.' },
        required_function_calls: { type: 'array', items: { type: 'string' }, description: 'Override the function calls required in each run — replaces the template\'s own list rather than merging with it. Without a tool listed here, its delivery is best-effort — the run can complete "successfully" even if the model skips it, silently. IMPORTANT (ENG-2204): if the template\'s starting message instructs posting, alerting, or notifying via Slack and its own required_function_calls does not already include slack_send_message (older templates predate this guidance), pass the full list here with slack_send_message added — an unattended run has no live approval step for it, and without this it may be silently skipped even when the task asked for it. Omit to use the template\'s stored list as-is.' },
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
    if (args.backup_model !== undefined) body.llmBackupModel = args.backup_model;
    if (args.required_function_calls !== undefined) body.requiredFunctionCalls = args.required_function_calls;
    const data = await mcpFetch({ method: 'POST', path: `/api/agent-mode/schedule-templates/${encodeURIComponent(args.template_id)}/use`, context: ctx(context), body });
    return jsonResult(data);
  }
});

// ─── CRM / Leads ────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_lead_lists',
  // A GET only: listing lists changes nothing. Read-only so a key scoped to tools:read (e.g. a Smartlead agent key) can find a listId.
  readOnly: true,
  definition: {
    name: 'list_lead_lists',
    description: 'List all lead lists for the authenticated user, or for a specific client (admin-only, via client_id).',
    inputSchema: {
      type: 'object',
      properties: { client_id: CLIENT_ID_SCHEMA_PROPERTY },
      required: []
    }
  },
  /** Lists lead lists for the caller, or (admin-only) for `args.client_id`'s account. */
  execute: async (args: any, context: any) => {
    // The tool is read-only so a tools:read key can find its own listIds, but reading ANOTHER account's lists (client_id, admin-only)
    // stays a tools:execute capability, as it was before the tool was marked read-only.
    if (args?.client_id && context?.externalMcp === true && context?.authMethod === 'api_key' && !(context.apiKeyScopes ?? []).includes('tools:execute')) {
      throw new Error("client_id needs an API key that holds the 'tools:execute' scope.");
    }
    const data = await mcpFetch({
      method: 'GET',
      path: '/api/crm/lists',
      context: await resolveClientScopedContext(context, args?.client_id, 'list_lead_lists')
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'create_lead_list',
  definition: {
    name: 'create_lead_list',
    description: 'Create, update, or delete a lead list. Use action: "create", "get", "update", or "delete". A list that holds leads marked do-not-contact is not deleted here (deleting it would erase those opt-outs); delete it in the app if that is intended.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        list_id: { type: 'string', description: 'List ID (required for get/update/delete)' },
        name: { type: 'string', description: 'List name (create/update)' },
        description: { type: 'string', description: 'List description (create/update)' },
        list_type: { type: 'string', description: 'List type: sales | customers | session (create, or update once: a type that is already set cannot be changed; validated by the API)' },
        icps_only: { type: 'boolean', description: 'Update: the list shows only leads that match the ICP by default' },
        engaged_only: { type: 'boolean', description: 'Update: the list shows only engaged leads by default' },
        auto_draft_enabled: { type: 'boolean', description: 'Update: turn automatic email drafts for new leads on or off' },
        auto_draft_instruction: { type: 'string', description: 'Update: instructions for the automatic email drafts (2000 characters at most)' },
        status_config: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Machine key (e.g. "qualified")' },
              label: { type: 'string', description: 'Display name (e.g. "Qualified")' },
              color: { type: 'string', description: 'Tailwind color name (e.g. "blue")' },
              type: { type: 'string', enum: ['active', 'won', 'lost', 'churned'], description: 'Status category' },
            },
            required: ['value', 'label', 'color', 'type'],
          },
          description: 'Update: the status pipeline stages of this list',
        }
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
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${encodeURIComponent(args.list_id)}`, context: c });
        return jsonResult(data);
      }
      case 'update':
        // Emma's eight list fields only (manageLeadsWrites.ts), not everything the REST route accepts.
        return executeLeadListUpdate(args, c);
      case 'delete':
        // A list that holds leads marked do-not-contact is not deleted here (manageLeadsWrites.ts).
        return executeLeadListDelete(args, c);
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── CRM lead-list CSV export, own account only (ENG-2867) ──────────────────
//
// Thin wrappers over POST /api/crm/lists/:listId/leads/export and
// GET /api/crm/lists/:listId/export-history. The route owns everything that
// matters: list ownership/sharing checks (canDestructiveCrmList /
// canAccessCrmList), Enigma card-revenue stripping, export-history record.
// The tool deliberately takes no client_id/user override — identity is always
// the calling key's runtime identity via ctx(context).

function requireListId(raw: unknown): string | null {
  const id = typeof raw === 'string' ? raw.trim() : '';
  return id ? encodeURIComponent(id) : null;
}

mcpToolRegistry.register({
  name: 'export_lead_list',
  definition: {
    name: 'export_lead_list',
    description: 'Export every lead in one of your own CRM lead lists to a CSV file. Returns the export record (exportId, recordCount, filename, fileUrl). Requires editor access to the list; works only on lists your account can edit.',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', description: 'Lead list ID to export' } },
      required: ['list_id']
    }
  },
  execute: async (args: any, context: any) => {
    const listId = requireListId(args?.list_id);
    if (!listId) return jsonResult({ error: 'list_id is required' });
    const data = await mcpFetch({ method: 'POST', path: `/api/crm/lists/${listId}/leads/export`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'list_lead_list_exports',
  readOnly: true,
  definition: {
    name: 'list_lead_list_exports',
    description: 'List past CSV exports (newest first, up to 50) for one of your own CRM lead lists.',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', description: 'Lead list ID' } },
      required: ['list_id']
    }
  },
  execute: async (args: any, context: any) => {
    const listId = requireListId(args?.list_id);
    if (!listId) return jsonResult({ error: 'list_id is required' });
    const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${listId}/export-history`, context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── CRM drip / nurture sequences, read-only (ENG-962) ──────────────────────
//
// `get_leads_by_crm_criteria` scopes WHO a campaign targets; this tool inspects
// the campaign itself. Read-only by construction: list + inspect + enrollment
// counts only. Create/activate/pause live in manage_crm_sequence (ENG-964,
// below) behind the activation gate and must never be added here.

mcpToolRegistry.register({
  name: 'list_crm_sequences',
  definition: {
    name: 'list_crm_sequences',
    description: `List the CRM email drip / nurture sequences on the caller's account, and inspect one with enrollment counts. Read-only — safe to call any time, including in a scheduled run. It cannot create, start, pause, or otherwise change a sequence; to change one, use manage_crm_sequence.

Use this to answer "are any email campaigns running for our CRM leads?". Each entry reports \`name\`, \`status\` (draft | active | paused | archived), \`audience\` (who the drip worker actually enrolls — auto-enroll lists, never the aspirational trigger), \`step_count\`, \`is_sending\` (true ONLY for \`active\` sequences, because the drip worker mails nothing for a draft/paused/archived sequence), and \`enrollment_count\` when a single sequence is inspected.

An account with no sequences returns \`{ total: 0, sequences: [] }\` with a summary line. That is a valid answer meaning "no campaigns exist", not an error — report it as such instead of retrying or guessing.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'active', 'paused', 'archived'],
          description: 'Only return sequences in this status. Omit to return all of them.',
        },
        sequence_id: {
          type: 'string',
          description: 'Inspect one sequence: returns its summary plus enrollment counts. Omit to list all.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  execute: async (args: any, context: any) => {
    const { summarizeSequence } = await import('../../services/crmSequenceRead');
    try {
      // Inspect-one path: summary + enrollment counts. The routes 403 when the
      // sequence belongs to another user, so cross-account reads fail closed
      // at the API boundary, not in this tool.
      if (typeof args?.sequence_id === 'string' && args.sequence_id.trim()) {
        const sequenceId = args.sequence_id.trim();
        const data = await mcpFetch({
          method: 'GET',
          path: `/api/crm/sequences/${encodeURIComponent(sequenceId)}`,
          context: ctx(context),
        });
        const sequence = data?.sequence;
        if (!sequence) return jsonResult({ error: `Sequence not found: ${sequenceId}` });
        let enrollment_count: unknown = undefined;
        let enrollment_error: string | undefined = undefined;
        try {
          const enrollments = await mcpFetch({
            method: 'GET',
            path: `/api/crm/sequences/${encodeURIComponent(sequenceId)}/enrollments`,
            context: ctx(context),
          });
          enrollment_count = enrollments?.stats ?? enrollments?.enrollments?.length ?? undefined;
        } catch (err: any) {
          // Surface enrollment-endpoint failures explicitly instead of
          // silently dropping the count (CodeRabbit, PR #2974): the
          // inspect-one contract promises an enrollment count, and a 401/403,
          // timeout, or 5xx here must not read as "zero enrollments".
          enrollment_count = undefined;
          enrollment_error = err?.message || String(err);
        }
        return jsonResult({
          ...summarizeSequence(sequence),
          enrollment_count,
          ...(enrollment_error ? { enrollment_error } : {}),
        });
      }

      const data = await mcpFetch({
        method: 'GET',
        path: '/api/crm/sequences',
        context: ctx(context),
      });

      const all = Array.isArray(data?.sequences) ? data.sequences : [];
      const filtered =
        typeof args?.status === 'string' ? all.filter((s: any) => s?.status === args.status) : all;
      const sequences = filtered.map(summarizeSequence);
      const activeCount = sequences.filter((s: any) => s.is_sending).length;

      return jsonResult({
        total: sequences.length,
        active_count: activeCount,
        sequences,
        summary:
          sequences.length === 0
            ? typeof args?.status === 'string'
              ? `No CRM drip sequences match status "${args.status}".`
              : 'No CRM drip sequences exist on this account. No campaign email is being sent to CRM leads.'
            : `${sequences.length} sequence(s); ${activeCount} actively sending.`,
      });
    } catch (err: any) {
      return jsonResult({ success: false, error: err?.message || String(err) });
    }
  },
});

// ─── CRM drip sequences, write side (ENG-964) ───────────────────────────────
//
// create / update / pause are ordinary reversible writes on a DRAFT (or paused)
// sequence. `activate` is the only path from this tool that ever sets
// status 'active', and it sits behind the ENG-587 A1+A2 boundary in
// crmSequenceActivationGate: attended sessions only, and only after the exact
// content/audience/cadence was previewed and a human picked "Activate" on the
// approval card. create/update never forward a `status`.

function mapSequenceSteps(steps: unknown): { steps?: any[]; error?: string } {
  if (steps === undefined) return {};
  if (!Array.isArray(steps) || steps.length === 0) return { error: 'steps must be a non-empty array' };
  const mapped: any[] = [];
  for (const [i, raw] of steps.entries()) {
    const s: any = raw ?? {};
    const channel = s.channel ?? 'email';
    const delayDays = Number(s.delay_days ?? 0);
    if (!Number.isFinite(delayDays) || delayDays < 0) return { error: `steps[${i}].delay_days must be a non-negative number` };
    if (channel === 'email' && (!s.subject || !s.body_html)) {
      return { error: `steps[${i}] is an email step and needs both subject and body_html` };
    }
    if (channel === 'linkedin' && !s.message_text) return { error: `steps[${i}] is a LinkedIn step and needs message_text` };
    if (channel !== 'email' && channel !== 'linkedin') return { error: `steps[${i}].channel must be "email" or "linkedin"` };
    mapped.push({
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `Step ${i + 1}`,
      delayDays,
      channel,
      ...(s.subject !== undefined ? { subject: s.subject } : {}),
      ...(s.body_html !== undefined ? { bodyHtml: s.body_html } : {}),
      ...(s.message_text !== undefined ? { messageText: s.message_text } : {}),
      ...(s.sender_id !== undefined ? { senderId: s.sender_id } : {}),
    });
  }
  return { steps: mapped };
}

function mapAudienceListIds(ids: unknown): { ids?: string[]; error?: string } {
  if (ids === undefined) return {};
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return { error: 'audience_list_ids must be an array of lead list ids' };
  }
  return { ids: ids.map((id: string) => id.trim()) };
}

mcpToolRegistry.register({
  name: 'manage_crm_sequence',
  definition: {
    name: 'manage_crm_sequence',
    description: `Create, edit, preview, activate, or pause a CRM email drip sequence on the caller's account.

- "create": builds a new sequence as a DRAFT (nothing is sent). \`audience_list_ids\` are the lead lists whose new leads auto-enroll once it is active.
- "update": edits a draft or paused sequence. An active sequence must be paused first.
- "preview_activation": shows the user the exact steps, audience and timing and asks them to approve. Always do this before "activate".
- "activate": starts sending. Only works in a live chat, after "preview_activation", once the user has picked "Activate" on the approval card, and only if the sequence has not changed since the preview. Never call it in the same turn as the preview — wait for the user's choice.
- "pause": stops sending. Always allowed.
- "external_activation_preview" / "external_activate_confirm" (external MCP callers only, e.g. an aw_ key acting on a human's out-of-chat approval): preview returns a digest bound to the current sequence version and the named \`approver\`, with no side effects; confirm activates only if the digest, approver and sequence are all unchanged since that preview.

Use list_crm_sequences to find sequence ids.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'preview_activation', 'activate', 'pause', 'external_activation_preview', 'external_activate_confirm'] },
        sequence_id: { type: 'string', description: 'Required for every action except create.' },
        name: { type: 'string', description: 'Sequence name (create; optional on update).' },
        description: { type: 'string' },
        campaign_type: { type: 'string', enum: ['conversion', 'onboarding', 'reengagement', 'nurture', 'upsell', 'custom'] },
        audience_list_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lead list ids whose new leads auto-enroll while the sequence is active.',
        },
        steps: {
          type: 'array',
          description: 'Ordered steps. Replaces all steps on update.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              delay_days: { type: 'number', description: 'Days after the previous step (or enrollment, for step 1).' },
              channel: { type: 'string', enum: ['email', 'linkedin'] },
              subject: { type: 'string' },
              body_html: { type: 'string' },
              message_text: { type: 'string', description: 'LinkedIn steps only.' },
              sender_id: { type: 'string' },
            },
          },
        },
        preview_token: { type: 'string', description: 'activate only: the preview_token returned by preview_activation.' },
        approver: { type: 'string', description: 'external_* actions only: identity of the human who approved activation (e.g. slack:U123).' },
        digest: { type: 'object', description: 'external_activate_confirm only: the `digest` object returned by external_activation_preview, unmodified.' },
      },
      required: ['action'],
    },
  },
  execute: async (args: any, context: any) => {
    const gate = await import('../../services/crmSequenceActivationGate');
    const { describeSequenceAudience } = await import('../../services/crmSequenceRead');
    const action = args?.action;
    const sequenceId = typeof args?.sequence_id === 'string' ? args.sequence_id.trim() : '';
    const refuse = (code: string, error: string) => ({ success: false, blocked: true, code, error });
    const isSequenceConflict = (err: any) => /API error \(409\)/.test(String(err?.message ?? ''));
    const path = `/api/crm/sequences/${encodeURIComponent(sequenceId)}`;
    const loadSequence = async () => {
      const data = await mcpFetch({ method: 'GET', path, context: ctx(context) });
      if (!data?.sequence) throw new Error(`Sequence not found: ${sequenceId}`);
      return data.sequence;
    };

    try {
      if (action !== 'create' && !sequenceId) return { success: false, error: 'sequence_id is required' };

      switch (action) {
        case 'create': {
          const name = typeof args?.name === 'string' ? args.name.trim() : '';
          if (!name) return { success: false, error: 'name is required' };
          const steps = mapSequenceSteps(args?.steps);
          if (steps.error) return { success: false, error: steps.error };
          const audience = mapAudienceListIds(args?.audience_list_ids);
          if (audience.error) return { success: false, error: audience.error };
          // No status, no enrollmentTrigger: the route defaults to draft, and the
          // drip worker enrolls from autoEnrollListIds, not the trigger.
          const created = await mcpFetch({
            method: 'POST',
            path: '/api/crm/sequences',
            context: ctx(context),
            body: { name, description: args?.description, campaignType: args?.campaign_type, steps: steps.steps },
          });
          let sequence = created?.sequence;
          if (!sequence?.sequenceId) return { success: false, error: 'Sequence creation returned no sequence' };
          if (audience.ids?.length) {
            // PUT is the audience writer that refuses session lists (ENG-2311).
            try {
              const updated = await mcpFetch({
                method: 'PUT',
                path: `/api/crm/sequences/${encodeURIComponent(sequence.sequenceId)}`,
                context: ctx(context),
                body: { autoEnrollListIds: audience.ids },
              });
              sequence = updated?.sequence ?? sequence;
            } catch (err: any) {
              return {
                success: false,
                sequence_id: sequence.sequenceId,
                error: `Draft sequence ${sequence.sequenceId} was created, but setting its audience failed: ${err?.message || String(err)}. It has no audience and sends nothing.`,
              };
            }
          }
          return { success: true, sequence_id: sequence.sequenceId, status: sequence.status, audience: describeSequenceAudience(sequence) };
        }

        case 'update': {
          const existing = await loadSequence();
          if (existing.status === 'active') {
            return refuse('active_sequence', 'This sequence is active. Pause it before editing, then preview and activate it again.');
          }
          const steps = mapSequenceSteps(args?.steps);
          if (steps.error) return { success: false, error: steps.error };
          const audience = mapAudienceListIds(args?.audience_list_ids);
          if (audience.error) return { success: false, error: audience.error };
          const body: Record<string, unknown> = {};
          if (typeof args?.name === 'string' && args.name.trim()) body.name = args.name.trim();
          if (args?.description !== undefined) body.description = args.description;
          if (args?.campaign_type !== undefined) body.campaignType = args.campaign_type;
          if (steps.steps) body.steps = steps.steps;
          if (audience.ids) body.autoEnrollListIds = audience.ids;
          if (Object.keys(body).length === 0) return { success: false, error: 'Nothing to update' };
          // Atomic: the route refuses (409) if the sequence went active after the check above.
          body.requireStatusNot = 'active';
          let data: any;
          try {
            data = await mcpFetch({ method: 'PUT', path, context: ctx(context), body });
          } catch (err: any) {
            if (isSequenceConflict(err)) return refuse('active_sequence', 'This sequence became active while editing. Pause it before editing, then preview and activate it again.');
            throw err;
          }
          return { success: true, sequence_id: sequenceId, status: data?.sequence?.status, audience: describeSequenceAudience(data?.sequence ?? {}) };
        }

        case 'pause': {
          const data = await mcpFetch({ method: 'PUT', path, context: ctx(context), body: { status: 'paused' } });
          return { success: true, sequence_id: sequenceId, status: data?.sequence?.status ?? 'paused' };
        }

        case 'external_activation_preview':
        case 'external_activate_confirm': {
          // ENG-2961: out-of-chat activation for external MCP callers, bound to the ENG-2958
          // digest. Never reachable from an Emma session; no approval card, no agent call.
          if (context?.externalMcp !== true) {
            return refuse('external_only', 'This action is only available to external MCP callers. In chat, use preview_activation.');
          }
          if (args?.client_id !== undefined && args?.client_id !== null) {
            return refuse('own_account_only', 'External activation acts only on your own sequences; client_id is not accepted.');
          }
          const approver = typeof args?.approver === 'string' ? args.approver.trim() : '';
          if (!approver) return { success: false, error: 'approver is required' };
          const ext = await import('../../services/externalActivationPreview');
          const sequence = await loadSequence();
          if (sequence.userId !== undefined && context?.userId !== undefined && sequence.userId !== context.userId) {
            return refuse('own_account_only', 'This sequence does not belong to your account.');
          }
          if (sequence.status === 'active') return { success: true, sequence_id: sequenceId, status: 'active', note: 'Already active.' };
          if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
            return { success: false, error: 'This sequence has no steps, so there is nothing to send.' };
          }

          if (action === 'external_activation_preview') {
            const digest = ext.buildExternalActivationPreview(sequence, { approverPrincipal: approver });
            return {
              success: true,
              digest,
              preview: {
                sequence_id: sequenceId,
                name: sequence.name,
                audience: describeSequenceAudience(sequence),
                steps: sequence.steps.map((s: any) => ({
                  name: s.name,
                  delay_days: s.delayDays,
                  channel: s.channel ?? 'email',
                  subject: s.subject,
                  body_html: s.bodyHtml,
                  message_text: s.messageText,
                })),
              },
              message: 'Nothing was activated. Pass `digest` unchanged with the same approver to external_activate_confirm.',
            };
          }

          const digest = args?.digest;
          if (!digest || typeof digest !== 'object') {
            return refuse('missing_digest', 'A digest from external_activation_preview is required. Nothing was activated.');
          }
          const verdict = ext.verifyExternalActivationPreview(digest, sequence, { approverPrincipal: approver });
          if (!verdict.ok) {
            const why = verdict.reason === 'version_drift'
              ? 'The sequence changed after the preview. Preview it again.'
              : verdict.reason === 'principal_mismatch'
                ? 'The approver does not match the preview.'
                : 'The digest is malformed or was altered.';
            return refuse(verdict.reason === 'version_drift' ? 'stale_preview' : verdict.reason, `${why} Nothing was activated.`);
          }
          let data: any;
          try {
            data = await mcpFetch({
              method: 'PUT',
              path,
              context: ctx(context),
              body: { status: 'active', expectedUpdatedAt: sequence.updatedAt, requireStatusNot: 'active' },
            });
          } catch (err: any) {
            if (isSequenceConflict(err)) return refuse('stale_preview', 'The sequence changed after the preview. Preview it again. Nothing was activated.');
            throw err;
          }
          return { success: true, sequence_id: sequenceId, status: data?.sequence?.status ?? 'active', approver };
        }

        case 'preview_activation':
        case 'activate': {
          // A1 first: an unattended/external caller learns nothing more than "no".
          let session: any = null;
          if (context?.externalMcp !== true && context?.unattended !== true && context?.sessionId) {
            const { chatbotDb } = await import('../../services/chatbotService');
            session = await chatbotDb.getChatSession(context.sessionId).catch(() => null);
          }
          const attended = gate.checkAttendedSession({
            externalMcp: context?.externalMcp,
            unattended: context?.unattended,
            sessionId: context?.sessionId,
            session,
          });
          if (!attended.allowed) return refuse(attended.code, attended.reason);

          const sequence = await loadSequence();
          if (sequence.status === 'active') return { success: true, sequence_id: sequenceId, status: 'active', note: 'Already active.' };
          if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
            return { success: false, error: 'This sequence has no steps, so there is nothing to send.' };
          }
          const token = gate.computeSequencePreviewToken(sequence);

          if (action === 'preview_activation') {
            const audience = describeSequenceAudience(sequence);
            const question = gate.buildActivationQuestion(sequence, token, audience);
            return {
              success: true,
              awaitingUserConfirmation: true,
              type: 'ask_user_question',
              sessionId: context.sessionId,
              questionDeckPayload: [question],
              confirmationPrompt: question.question,
              summary: question.question,
              preview_token: token,
              preview: {
                sequence_id: sequenceId,
                name: sequence.name,
                audience,
                steps: sequence.steps.map((s: any) => ({
                  name: s.name,
                  delay_days: s.delayDays,
                  channel: s.channel ?? 'email',
                  subject: s.subject,
                  body_html: s.bodyHtml,
                  message_text: s.messageText,
                })),
              },
              message: 'The run halts here until the user picks an option. Do NOT call activate yourself in this turn.',
            };
          }

          const { chatbotDb } = await import('../../services/chatbotService');
          const messages = await chatbotDb.getMessagesFromMessagesTable(context.sessionId);
          const approval = gate.checkActivationApproval(messages as any, sequenceId, token);
          if (!approval.allowed) return refuse(approval.code, approval.reason);
          if (typeof args?.preview_token !== 'string' || args.preview_token !== token) {
            return refuse('stale_preview', 'preview_token does not match the sequence as it is now. Preview it again.');
          }

          // Atomic: activate only the exact version the user approved. If anything edited the
          // sequence after the read that produced `token`, the route returns 409 and nothing goes live.
          let data: any;
          try {
            data = await mcpFetch({
              method: 'PUT',
              path,
              context: ctx(context),
              body: { status: 'active', expectedUpdatedAt: sequence.updatedAt, requireStatusNot: 'active' },
            });
          } catch (err: any) {
            if (isSequenceConflict(err)) return refuse('stale_preview', 'The sequence changed after the preview was approved. Preview it again.');
            throw err;
          }
          return { success: true, sequence_id: sequenceId, status: data?.sequence?.status ?? 'active' };
        }

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  },
});

mcpToolRegistry.register({
  name: 'manage_leads',
  definition: {
    name: 'manage_leads',
    description: `Add, get, update, or delete leads in a list. Use action: "add", "get", "update", "delete", or "list". "list" pages with page + limit and filters with search, status and engaged_only. "add" takes up to ${MAX_LEAD_ROWS_PER_CALL} leads (several are created one by one and the answer counts what really happened; an address the account already marked do-not-contact is flagged do-not-contact on the new lead too; a new lead cannot be created with status "do-not-contact", add it and then update its status); "delete" takes up to ${MAX_LEAD_ROWS_PER_CALL} lead_ids and counts the same way (a lead marked do-not-contact or unsubscribed is not deleted here, because deleting it would let the address be added again as sendable). A call that runs out of its time budget reports the rows it did not touch. A lead added moments ago may briefly be reported as not found by a following update or delete: retry. "update" merges any field that is not a standard lead field into the lead's custom fields (it never replaces them); setting status to "do-not-contact" suppresses the lead and cannot be reversed with this tool; changing a lead's email to an address already marked do-not-contact flags it too. An email must be a plain ASCII address (name@example.com). Fields that identify the owner, sync or attribution data, and contact status cannot be set. Admin-only: pass client_id to act on a specific client\'s list instead of the caller\'s own — supported for "list", "get", and "add" (ENG-1557 v1: admin creates one lead on a customer\'s behalf, behind a feature flag; pass dry_run:true to preview first without writing anything). Still rejected for "update"/"delete" — those need a broader authorization review.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'get', 'update', 'delete'], description: 'Action to perform' },
        list_id: { type: 'string', description: 'The lead list ID' },
        lead_id: { type: 'string', description: 'Lead ID (for get/update)' },
        leads: { type: 'array', description: `Lead objects to add, 1 to ${MAX_LEAD_ROWS_PER_CALL} (exactly one with client_id or dry_run). Standard fields: email, firstName, lastName, phone, company, title, notes, linkedin, website, companyLinkedin, domain, status, dealValue, dealCurrency, lifecycle, priority (Low, Medium or High), role, isPrimary, expectedClose, closedDate, pocEmails, heatScore, healthScore, selectedSenderId, and attribution: { utm: { source, medium, campaign, content, term } } (source tracking); drafts are saved by an update after the lead exists; any other key becomes a custom field (add action)` },
        lead_ids: { type: 'array', items: { type: 'string' }, description: `Lead IDs to delete, 1 to ${MAX_LEAD_ROWS_PER_CALL} (for delete action)` },
        updates: { type: 'object', description: 'Fields to update (for update action). Standard lead fields (as for add, plus emailDraft { subject, htmlContent?, textContent? }, messageDraft and emailDraftFormat "text"|"html"; no attribution; priority, role, isPrimary, expectedClose, closedDate, heatScore and healthScore can only be given when adding) are set; the email of a lead marked do-not-contact cannot be changed; any other key is merged into the lead\'s custom fields. Setting status to "do-not-contact" suppresses the lead.' },
        limit: { type: 'number', description: 'Max leads to return per page (list action)' },
        page: { type: 'number', description: 'Page number, starting at 1 (list action)' },
        search: { type: 'string', description: 'Only leads matching this text (list action)' },
        status: { type: 'string', description: 'Only leads with this pipeline status (list action)' },
        engaged_only: { type: 'boolean', description: 'Only leads that have engaged (list action)' },
        client_id: {
          type: 'string',
          description: "Admin-only. Scope to a specific client's list instead of the caller's own — accepts the client's email or userId. Supported for 'list', 'get', and 'add'. For 'add', the real write additionally requires the MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED flag; dry_run:true always works regardless of the flag. Still rejected for 'update'/'delete' (broader authorization review pending).",
        },
        dry_run: {
          type: 'boolean',
          description: '"add" action only. When true, preview what would be created (list resolution, permission check, duplicate-email check) without creating anything. Advisory, not exhaustive — some real-write validations (e.g. selectedSenderId) aren\'t replicated, so a preview success doesn\'t guarantee the real write will succeed. Works regardless of client_id or the cross-account-add feature flag. Must be a real boolean if provided.',
        },
      },
      required: ['action', 'list_id']
    }
  },
  /**
   * CRUD dispatch for a lead list's leads. `args.client_id` (admin-only) scopes
   * `list`/`get`/`add` to a specific client's list; `update`/`delete` reject it
   * outright (ENG-1557: broader cross-account mutation is still pending
   * authorization review — `add` graduated out under ENG-1557 v1, scoped
   * narrowly and feature-flagged, see manageLeadsCrossAccountAdd.ts).
   */
  execute: async (args: any, context: any) => {
    const listId = args.list_id;
    const hasClientId = args.client_id !== undefined && args.client_id !== null;
    // Only update/delete remain blanket-rejected — add graduated out under
    // ENG-1557 v1. Still reject ANY present client_id (not just non-empty
    // strings — CodeRabbit, PR #2651) rather than silently falling through.
    const isRejectedWrite = (args.action === 'update' || args.action === 'delete') && hasClientId;
    if (isRejectedWrite) {
      throw new Error(
        `client_id is not supported for manage_leads action "${args.action}" — cross-account writes for this action are pending a broader ENG-1557 authorization review. Only "list", "get", and "add" support client_id today.`
      );
    }
    if (args.action === 'add' && hasClientId) {
      return executeCrossAccountLeadAdd(args, context);
    }
    const isWriteAction = args.action === 'add' || args.action === 'update' || args.action === 'delete';
    const c = isWriteAction ? ctx(context) : await resolveClientScopedContext(context, args.client_id, 'manage_leads');
    switch (args.action) {
      case 'list': {
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${encodeURIComponent(listId)}/leads`, context: c, queryParams: buildLeadListQuery(args) });
        return jsonResult(data);
      }
      case 'add': {
        // A real write: one to MAX_LEAD_ROWS_PER_CALL leads, counted honestly (manageLeadsWrites.ts). A preview is always exactly one lead.
        if (!resolveDryRunFlag(args.dry_run)) return executeLeadAdd(args, c);
        const leadPayload = normalizeAddLeadPayload(args.leads);
        // Must match httpClient.ts's own acting-identity resolution
        // (`context.userId || context.agentUserId`) exactly — otherwise an
        // internal service-to-service caller (userId deliberately distinct
        // from agentUserId, see mcpServerCore.ts) gets a preview checked
        // against a different identity than the one that actually performs
        // the real write a moment later.
        const actingUserId = c.userId || c.agentUserId;
        const preview = await previewLeadAdd(actingUserId, listId, leadPayload);
        return jsonResult({ dryRun: true, ...preview });
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${encodeURIComponent(listId)}/leads/${encodeURIComponent(args.lead_id)}`, context: c });
        return jsonResult(data);
      }
      case 'update':
        return executeLeadUpdate(args, c);
      case 'delete':
        return executeLeadDelete(args, c);
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'search_leads',
  definition: {
    name: 'search_leads',
    description: 'Search leads across lists using structured filters. Admin-only: pass client_id to search a specific client\'s leads instead of the caller\'s own.',
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
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        client_id: CLIENT_ID_SCHEMA_PROPERTY
      },
      required: ['list_id', 'filters']
    }
  },
  /** Searches leads for the caller, or (admin-only) for `args.client_id`'s account. */
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/search-leads', context: await resolveClientScopedContext(context, args.client_id, 'search_leads'),
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
        const data = await mcpFetch({ method: 'GET', path: `/api/gtm-plan/${encodeURIComponent(args.plan_id)}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const { action, plan_id, ...body } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/gtm-plan/${encodeURIComponent(args.plan_id)}`, context: c });
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
          method: 'POST', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases`, context: c,
          body: { name: args.name, description: args.description, status: args.status }
        });
        return jsonResult(data);
      }
      case 'update_phase': {
        const data = await mcpFetch({
          method: 'PUT', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases/${encodeURIComponent(phase_id)}`, context: c,
          body: { name: args.name, description: args.description, status: args.status }
        });
        return jsonResult(data);
      }
      case 'delete_phase': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases/${encodeURIComponent(phase_id)}`, context: c });
        return jsonResult(data);
      }
      case 'add_work_items': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases/${encodeURIComponent(phase_id)}/work-items`, context: c,
          body: { workItems: args.work_items }
        });
        return jsonResult(data);
      }
      case 'update_work_item': {
        const { action: _a, plan_id: _p, phase_id: _ph, work_item_id: _w, ...updates } = args;
        const data = await mcpFetch({
          method: 'PUT', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases/${encodeURIComponent(phase_id)}/work-items/${encodeURIComponent(work_item_id)}`, context: c,
          body: updates
        });
        return jsonResult(data);
      }
      case 'delete_work_item': {
        const data = await mcpFetch({
          method: 'DELETE', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases/${encodeURIComponent(phase_id)}/work-items/${encodeURIComponent(work_item_id)}`, context: c
        });
        return jsonResult(data);
      }
      case 'get_common_items': {
        const data = await mcpFetch({ method: 'GET', path: '/api/gtm-plan/common-items', context: c });
        return jsonResult(data);
      }
      case 'add_common_items': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${encodeURIComponent(plan_id)}/add-common-items`, context: c,
          body: { items: args.items, targetPhaseId: args.target_phase_id, newPhaseName: args.new_phase_name }
        });
        return jsonResult(data);
      }
      case 'send_status_report': {
        const path = phase_id
          ? `/api/gtm-plan/${encodeURIComponent(plan_id)}/phases/${encodeURIComponent(phase_id)}/send-status-report`
          : `/api/gtm-plan/${encodeURIComponent(plan_id)}/send-status-report`;
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

// ─── Knowledge base text-file writes, own account only (ENG-2892) ───────────
//
// Thin wrappers over the existing KB write routes (POST /api/emma/
// create-knowledge-base, /attach-knowledge-base-files, /update-knowledge-base-
// file and DELETE /api/tasks/:taskId/knowledge-base/files/:fileKey). No new
// storage: the routes own the GCS write and the task record.
//
// Ownership is decided here, not by the routes: the delete route also admits
// admins and org editors, and getTask admits org viewers. These tools act only
// on a KB whose owner is the calling key's runtime identity, and answer a
// foreign KB/file exactly like a missing one so existence never leaks. There
// is no client_id/user override. Every write is read back from the task record
// before the tool reports success.

export const KB_TEXT_FILE_MAX_BYTES = 1024 * 1024;
const KB_MAIN_FILE = 'knowledge-base.txt';
const KB_TEXT_FILE_EXTENSION = /\.(txt|md|markdown)$/i;
// Control characters other than tab/newline/CR mark binary data.
const KB_BINARY_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const KB_NOT_FOUND = 'Knowledge base or file not found';

function kbArg(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Returns an error string when `content` is not acceptable KB text, else null. */
function kbTextContentError(content: unknown): string | null {
  if (typeof content !== 'string' || content.trim().length === 0) return 'content must be a non-empty text string';
  const size = Buffer.byteLength(content, 'utf8');
  if (size > KB_TEXT_FILE_MAX_BYTES) return `content is ${size} bytes; the maximum is ${KB_TEXT_FILE_MAX_BYTES} bytes`;
  if (KB_BINARY_CHARS.test(content)) return 'content looks binary; only plain text or markdown is accepted';
  return null;
}

function kbFileNameError(fileName: string): string | null {
  if (!fileName) return 'file_name is required';
  if (!KB_TEXT_FILE_EXTENSION.test(fileName)) return 'file_name must end in .txt, .md or .markdown';
  return null;
}

/** The caller's own KB task, or null for a missing or foreign one (indistinguishable). */
async function loadOwnKnowledgeBase(kbId: string, context: any): Promise<any | null> {
  const ownerId = context?.userId || context?.agentUserId;
  if (!kbId || !ownerId) return null;
  try {
    const task = await mcpFetch({ method: 'GET', path: `/api/tasks/${encodeURIComponent(kbId)}`, context: ctx(context) });
    return task && task.userId === ownerId ? task : null;
  } catch (error: any) {
    if (/API error \((403|404)\)/.test(String(error?.message))) return null;
    throw error;
  }
}

/** Read back one file's stored key + size from the caller's own KB task. */
async function readBackKbFile(kbId: string, fileName: string, context: any): Promise<{ file_key: string; size_bytes: number } | null> {
  const task = await loadOwnKnowledgeBase(kbId, context);
  if (!task) return null;
  if (fileName === KB_MAIN_FILE) {
    return { file_key: `tasks/${task.taskId}/${KB_MAIN_FILE}`, size_bytes: Number(task.knowledgeBaseSize) || 0 };
  }
  const matches = (task.knowledgeBaseFiles || []).filter((f: any) => f?.filename === fileName);
  const entry = matches[matches.length - 1];
  return entry ? { file_key: entry.key, size_bytes: Number(entry.size) || 0 } : null;
}

async function verifiedKbWrite(kbId: string, fileName: string, content: string, context: any) {
  const expected = Buffer.byteLength(content, 'utf8');
  const stored = await readBackKbFile(kbId, fileName, context);
  if (!stored || stored.size_bytes !== expected) {
    return jsonResult({ success: false, error: 'Write could not be verified on read-back', kb_id: kbId, file_name: fileName });
  }
  return jsonResult({
    success: true,
    kb_id: kbId,
    file_name: fileName,
    file_key: stored.file_key,
    size_bytes: stored.size_bytes,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  });
}

function routeFailure(data: any) {
  return jsonResult({ success: false, error: data?.error || data?.message || 'Knowledge base write failed' });
}

mcpToolRegistry.register({
  name: 'create_knowledge_base_file',
  definition: {
    name: 'create_knowledge_base_file',
    description: `Create a plain-text or markdown file in one of your own knowledge bases (max ${KB_TEXT_FILE_MAX_BYTES} bytes, no binary). With kb_id, adds file_name to that knowledge base; without kb_id, creates a new private knowledge base named kb_name whose main file (${KB_MAIN_FILE}) holds the content. Returns the stored file key, size and sha256.`,
    inputSchema: {
      type: 'object',
      properties: {
        kb_id: { type: 'string', description: 'Your knowledge base ID (from list_knowledge_bases). Omit to create a new knowledge base.' },
        kb_name: { type: 'string', description: 'Name for the new knowledge base (only when kb_id is omitted)' },
        file_name: { type: 'string', description: 'File name ending in .txt, .md or .markdown (required with kb_id)' },
        content: { type: 'string', description: 'File text' }
      },
      required: ['content']
    }
  },
  execute: async (args: any, context: any) => {
    const contentError = kbTextContentError(args?.content);
    if (contentError) return jsonResult({ success: false, error: contentError });
    const content: string = args.content;
    const kbId = kbArg(args?.kb_id);

    if (!kbId) {
      const kbName = kbArg(args?.kb_name);
      if (!kbName) return jsonResult({ success: false, error: 'kb_name is required when kb_id is omitted' });
      const data = await mcpFetch({
        method: 'POST', path: '/api/emma/create-knowledge-base', context: ctx(context),
        body: { name: kbName, content, knowledge_base_type: 'private' }
      });
      if (!data?.success || !data.taskId) return routeFailure(data);
      return verifiedKbWrite(data.taskId, KB_MAIN_FILE, content, context);
    }

    const fileName = kbArg(args?.file_name);
    const nameError = kbFileNameError(fileName);
    if (nameError) return jsonResult({ success: false, error: nameError });
    const task = await loadOwnKnowledgeBase(kbId, context);
    if (!task) return jsonResult({ success: false, error: KB_NOT_FOUND });
    const lowered = fileName.toLowerCase();
    const existingName = lowered === KB_MAIN_FILE
      // An attachment stored under this exact case-variant name wins over the main file.
      ? (fileName !== KB_MAIN_FILE && (task.knowledgeBaseFiles || []).find((f: any) => f?.filename === fileName)?.filename) || KB_MAIN_FILE
      : (task.knowledgeBaseFiles || []).find((f: any) => String(f?.filename ?? '').toLowerCase() === lowered)?.filename;
    if (existingName) {
      // Report the stored name: update_knowledge_base_file_content matches names exactly.
      return jsonResult({ success: false, error: `"${existingName}" already exists; use update_knowledge_base_file_content with file_name "${existingName}" to change it` });
    }
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/attach-knowledge-base-files', context: ctx(context),
      body: { task_id: task.taskId, files: [{ name: fileName, content }] }
    });
    if (!data?.success) return routeFailure(data);
    return verifiedKbWrite(task.taskId, fileName, content, context);
  }
});

mcpToolRegistry.register({
  name: 'update_knowledge_base_file_content',
  definition: {
    name: 'update_knowledge_base_file_content',
    description: `Replace the full content of an existing text or markdown file in one of your own knowledge bases (max ${KB_TEXT_FILE_MAX_BYTES} bytes, no binary). Returns the stored file key, size and sha256.`,
    inputSchema: {
      type: 'object',
      properties: {
        kb_id: { type: 'string', description: 'Your knowledge base ID (from list_knowledge_bases)' },
        file_name: { type: 'string', description: `Existing file name (e.g. ${KB_MAIN_FILE})` },
        content: { type: 'string', description: 'New file text (replaces the old content)' }
      },
      required: ['kb_id', 'file_name', 'content']
    }
  },
  execute: async (args: any, context: any) => {
    const contentError = kbTextContentError(args?.content);
    if (contentError) return jsonResult({ success: false, error: contentError });
    const content: string = args.content;
    const fileName = kbArg(args?.file_name);
    const nameError = kbFileNameError(fileName);
    if (nameError) return jsonResult({ success: false, error: nameError });
    const task = await loadOwnKnowledgeBase(kbArg(args?.kb_id), context);
    const exists = fileName === KB_MAIN_FILE || (task?.knowledgeBaseFiles || []).some((f: any) => f?.filename === fileName);
    if (!task || !exists) return jsonResult({ success: false, error: KB_NOT_FOUND });
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/update-knowledge-base-file', context: ctx(context),
      body: { task_id: task.taskId, file_name: fileName, content, mode: 'replace' }
    });
    if (!data?.success) return routeFailure(data);
    return verifiedKbWrite(task.taskId, fileName, content, context);
  }
});

mcpToolRegistry.register({
  name: 'delete_knowledge_base_file',
  definition: {
    name: 'delete_knowledge_base_file',
    description: `Delete one uploaded or attached file from one of your own knowledge bases. The main ${KB_MAIN_FILE} file cannot be deleted. Pass file_key when two files share a name. Returns confirmation that the file is gone.`,
    inputSchema: {
      type: 'object',
      properties: {
        kb_id: { type: 'string', description: 'Your knowledge base ID (from list_knowledge_bases)' },
        file_name: { type: 'string', description: 'File name to delete' },
        file_key: { type: 'string', description: 'Stored file key (optional; disambiguates duplicate names)' }
      },
      required: ['kb_id', 'file_name']
    }
  },
  execute: async (args: any, context: any) => {
    const fileName = kbArg(args?.file_name);
    const fileKey = kbArg(args?.file_key);
    if (!fileName) return jsonResult({ success: false, error: 'file_name is required' });
    if (fileName === KB_MAIN_FILE) return jsonResult({ success: false, error: `The main ${KB_MAIN_FILE} file cannot be deleted` });
    const task = await loadOwnKnowledgeBase(kbArg(args?.kb_id), context);
    // Only keys recorded on the caller's own task are ever sent to the delete route.
    const matches = (task?.knowledgeBaseFiles || []).filter(
      (f: any) => f?.filename === fileName && typeof f?.key === 'string' && (!fileKey || f.key === fileKey)
    );
    if (!task || matches.length === 0) return jsonResult({ success: false, error: KB_NOT_FOUND });
    if (matches.length > 1) {
      return jsonResult({ success: false, error: `${matches.length} files are named "${fileName}"; pass file_key`, file_keys: matches.map((f: any) => f.key) });
    }
    const key: string = matches[0].key;
    await mcpFetch({
      method: 'DELETE',
      path: `/api/tasks/${encodeURIComponent(task.taskId)}/knowledge-base/files/${encodeURIComponent(key)}`,
      context: ctx(context)
    });
    const after = await loadOwnKnowledgeBase(task.taskId, context);
    const stillPresent = !after || (after.knowledgeBaseFiles || []).some((f: any) => f?.key === key);
    if (stillPresent) return jsonResult({ success: false, error: 'Delete could not be confirmed on read-back', kb_id: task.taskId, file_key: key });
    return jsonResult({ success: true, deleted: true, kb_id: task.taskId, file_name: fileName, file_key: key });
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
    const body = mapManageBrandUpdate(args);
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

/** Allow-list projection of GET /api/crm/sender-emails shared by list/update sender tools. */
function projectSenderSettings(data: any) {
  const senders = Array.isArray(data?.senders) ? data.senders : [];
  const mailboxes = Array.isArray(data?.connectedEmailAccounts) ? data.connectedEmailAccounts : [];
  return {
    senders: senders.map((s: any) => ({
      id: s?.id ?? null,
      email: s?.email ?? null,
      from_name: s?.fromName ?? null,
      sender_provider: s?.senderProvider ?? null,
      connected_account_id: s?.connectedAccountId ?? null,
      daily_limit: s?.dailyLimit ?? null,
      effective_daily_limit: s?.effectiveDailyLimit ?? null,
      // null = unknown (uncapped sender, or the usage read failed) — never a fake zero.
      sent_today: s?.sentTodayKnown === false || typeof s?.sentToday !== 'number' ? null : s.sentToday,
      warmup_started_at: s?.warmupStartedAt ?? null,
    })),
    default_sender_id: data?.defaultSenderId ?? null,
    default_linkedin_account_id: data?.defaultLinkedInAccountId ?? null,
    connected_email_accounts: mailboxes.map((a: any) => ({
      account_id: a?.account_id ?? null,
      account_name: a?.account_name ?? null,
      email: a?.email ?? null,
      platform: a?.platform ?? null,
    })),
  };
}

// ─── Sender Settings (ENG-2868) ─────────────────────────────────────────────

/**
 * ENG-2868 (ENG-2847.4 read half): read-only view of the caller's own CRM
 * sender settings. Identity comes only from the runtime context — the tool
 * accepts no arguments, so no account can be selected via args. The response
 * is an explicit allow-list projection of GET /api/crm/sender-emails so a
 * future field added to that route can never leak through here.
 */
mcpToolRegistry.register({
  name: 'list_sender_settings',
  readOnly: true,
  definition: {
    name: 'list_sender_settings',
    description: "List your own CRM sender settings: configured email senders (with today's send usage and effective daily cap), the default email sender, the default LinkedIn sender account, and connected mailboxes that can be used as senders. Read-only; use before drafting or activating sequences.",
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/crm/sender-emails', context: ctx(context) });
    return jsonResult(projectSenderSettings(data));
  }
});

// ENG-2897 (ENG-2847.7): set the caller's own default email / LinkedIn sender.
// Identity is runtime-only (no client_id). Both ids are checked against the
// caller's OWN config / OWN connected accounts before anything is written, and
// the existing sender list is re-posted unchanged so only the defaults move.
// Sequence activation state is never touched.
mcpToolRegistry.register({
  name: 'update_sender_settings',
  definition: {
    name: 'update_sender_settings',
    description: 'Set your own default CRM email sender and/or default LinkedIn sender account. default_sender_id must be one of your configured senders (see list_sender_settings); default_linkedin_account_id must be a LinkedIn (unipile) account you own (see list_connected_accounts). Does not change sequences or their activation. Returns the resulting settings as list_sender_settings shows them.',
    inputSchema: {
      type: 'object',
      properties: {
        default_sender_id: { type: 'string', description: 'Sender id from list_sender_settings.senders[].id' },
        default_linkedin_account_id: { type: 'string', description: 'Your own LinkedIn (unipile) connected account_id' },
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    // null / "" / whitespace mean "not set" (same as omitting the field), so a
    // client that always sends both keys can still change just one default.
    const blankToUndefined = (v: any) => (v === null || (typeof v === 'string' && !v.trim()) ? undefined : v);
    const senderId = blankToUndefined(args?.default_sender_id);
    const linkedInId = blankToUndefined(args?.default_linkedin_account_id);
    if (senderId === undefined && linkedInId === undefined) {
      throw new Error('Provide default_sender_id and/or default_linkedin_account_id');
    }
    if (senderId !== undefined && typeof senderId !== 'string') {
      throw new Error('default_sender_id must be a string');
    }
    if (linkedInId !== undefined && typeof linkedInId !== 'string') {
      throw new Error('default_linkedin_account_id must be a string');
    }
    const scoped = ctx(context);
    if (linkedInId !== undefined) {
      const conn = await mcpFetch({ method: 'GET', path: '/api/oauth/connected-accounts', context: scoped, queryParams: { platform: 'unipile' } });
      const accounts: any[] = Array.isArray(conn?.accounts) ? conn.accounts : [];
      const ownsIt = accounts.some((a: any) => a?.platform === 'unipile' && a?.account_id === linkedInId && a?.owned === true);
      if (!ownsIt) {
        throw new Error(`default_linkedin_account_id "${linkedInId}" is not a LinkedIn account you own`);
      }
    }
    // The settings route stores the whole config, so this is read-modify-write.
    // Narrow the lost-update window: re-read right before writing and restart if
    // anything moved, then verify the stored result and retry if a concurrent
    // writer overwrote our defaults. Never report a default that is not stored.
    const fingerprint = (c: any) => JSON.stringify({
      senders: (Array.isArray(c?.senders) ? c.senders : []).map((s: any) => s),
      d: c?.defaultSenderId ?? null,
      l: c?.defaultLinkedInAccountId ?? null,
    });
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const current = await mcpFetch({ method: 'GET', path: '/api/crm/sender-emails', context: scoped });
      const senders: any[] = Array.isArray(current?.senders) ? current.senders : [];
      if (senderId !== undefined && !senders.some((s: any) => s?.id === senderId)) {
        throw new Error(`default_sender_id "${senderId}" is not one of your configured senders`);
      }
      const wantSender = senderId ?? current?.defaultSenderId ?? null;
      const wantLinkedIn = linkedInId ?? current?.defaultLinkedInAccountId ?? null;
      const recheck = await mcpFetch({ method: 'GET', path: '/api/crm/sender-emails', context: scoped });
      if (fingerprint(recheck) !== fingerprint(current)) continue;
      await mcpFetch({
        method: 'POST',
        path: '/api/crm/sender-emails',
        context: scoped,
        body: {
          // Unchanged senders pass the route's grandfather check, so no re-validation side effects.
          senders: senders.map((s: any) => ({
            id: s.id, email: s.email, fromName: s.fromName, notes: s.notes,
            senderType: s.senderType, senderProvider: s.senderProvider,
            connectedAccountId: s.connectedAccountId, gmailAccountId: s.gmailAccountId,
            dailyLimit: s.dailyLimit, warmupStartedAt: s.warmupStartedAt,
          })),
          defaultSenderId: wantSender,
          defaultLinkedInAccountId: wantLinkedIn,
        },
      });
      const after = await mcpFetch({ method: 'GET', path: '/api/crm/sender-emails', context: scoped });
      const stored = (senderId === undefined || after?.defaultSenderId === senderId)
        && (linkedInId === undefined || after?.defaultLinkedInAccountId === linkedInId);
      if (stored) return jsonResult(projectSenderSettings(after));
    }
    throw new Error('Sender settings changed concurrently and the update could not be applied; nothing was reported as saved. Re-read with list_sender_settings and retry.');
  }
});

// ─── Connected Accounts ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: `List all connected social media and integration accounts.

GOOGLE ADS SPEND RISK (ENG-1362). google_ads rows carry test_account and can_spend.
  test_account: true = Google guarantees the account CANNOT serve ads and CANNOT spend.
  test_account: false = real, billable.
  test_account absent = never recorded; treat as billable.
  can_spend = false ONLY when test_account is true.
Never infer this from account_name — a fully billable account can be named "Test".

Admin-only: pass client_id to list a specific client's connected accounts instead of the caller's own.`,
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Filter by platform (e.g., "linkedin", "meta", "unipile")' },
        client_id: CLIENT_ID_SCHEMA_PROPERTY
      },
      required: []
    }
  },
  /** Lists connected accounts for the caller, or (admin-only) for `args.client_id`'s account. */
  execute: async (args: any, context: any) => {
    const qp: Record<string, string> = {};
    if (args.platform) qp.platform = args.platform;
    const data = await mcpFetch({
      method: 'GET',
      path: '/api/oauth/connected-accounts',
      context: await resolveClientScopedContext(context, args.client_id, 'list_connected_accounts'),
      queryParams: qp
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'post_on_account',
  internal: true,
  // ENG-974: outbound action — hidden AND refused for external MCP callers.
  internalOnly: true,
  definition: {
    name: 'post_on_account',
    description: 'Post content on a connected social media account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Connected account ID' },
        content: { type: 'string', description: 'Post content' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Optional media URLs' },
        in_reply_to_post_id: { type: 'string', description: 'X (Twitter) only. ID of an existing post to reply to. Omit for a new post.' }
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
      body: { account_id: args.account_id, content: args.content, media_urls: args.media_urls || [], ...(args.in_reply_to_post_id ? { in_reply_to_post_id: args.in_reply_to_post_id } : {}) }
    });
    return jsonResult(data);
  }
});

// ─── Landing Pages (v0) ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'generate_landing_page',
  definition: {
    name: 'generate_landing_page',
    description: 'Generate AND deploy a production landing page in one step. This tool sends brand guidelines + prompt to v0, which generates a polished React/Next.js site, pushes it to a private GitHub repo, and deploys to Vercel automatically. Returns the live URL when done. PREREQUISITE: Before calling this tool, you MUST have: 1. Called read_brand_guidelines to get brand data, 2. Called create_lead_list to create a lead list named "LP Leads - {page name}" for the contact form, 3. Called enable_lead_list_public_access to enable public form capture. Pass the lead list ID as lead_list_id. Include all brand details in the prompt for best results. Do NOT call deploy_landing_page after this — deployment is automatic. IMPORTANT: a returned "deployed" status means the BUILD succeeded, not that the page is launch-ready — check the response\'s launchReadiness field (or call get_deployment_status) before telling the user the page is ready to send traffic to. If launchReadiness.ready is false, relay the reasons plainly instead of calling it done.',
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
      method: 'POST', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/deploy`, context: ctx(context),
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
      method: 'POST', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/iterate`, context: ctx(context),
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
    const data = await mcpFetch({ method: 'GET', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}`, context: ctx(context) });
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
    const data = await mcpFetch({ method: 'DELETE', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}`, context: ctx(context) });
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
      method: 'PUT', path: `/api/crm/lists/${encodeURIComponent(args.list_id)}/public-access`, context: ctx(context),
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
      method: 'POST', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/duplicate`, context: ctx(context),
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
      method: 'PATCH', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/context`, context: ctx(context),
      body: { context: args.context }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'enable_session_tracking',
  definition: {
    name: 'enable_session_tracking',
    description: 'Turn on organic and paid visitor SESSION tracking for a landing page: creates (or reuses) a session list named "LP Sessions - {page name}" and adds the AgentWeb tracking tag to the page\'s own repo in one commit (the site redeploys in about a minute). Safe to call again: it never duplicates the tag or the list. Use it for a deployed landing page that has no session tracking yet, or after the page gains a new domain (re-running adds the new address to the list). Returns listId, embedSnippet, installed and alreadyInstalled. If the page already has its own tracker the tool refuses with an explanation instead of double-counting visits; report that to the user rather than retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID (from list_landing_pages or get_landing_page)' },
        html_path: { type: 'string', description: 'Only for a static-HTML page whose file is not public/<slug>.html or public/index.html: the file to tag, e.g. "public/offer.html"' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    // ENG-827: this commits to a customer's live repo, so it honours the same last-moment consent re-check
    // as publish_landing_page_changes (an unattended schedule whose consent was withdrawn mid-run stops here).
    const withdrawn = await publishWithdrawnMidFlight(context);
    if (withdrawn) return jsonResult({ success: false, message: withdrawn.error });
    const data = await mcpFetch({
      method: 'POST', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/session-tracking`, context: ctx(context),
      body: { ...(args.html_path ? { htmlPath: args.html_path } : {}) }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'set_landing_page_lead_list',
  definition: {
    name: 'set_landing_page_lead_list',
    description: 'Attach, change, or clear the CRM lead list on an existing landing page (including imported externally-deployed pages) without regenerating it. Pass lead_list_id=null to clear. Enables public submissions on the list and syncs the page capture route where the page has a repo.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        lead_list_id: { type: ['string', 'null'], description: 'Lead list ID to associate, or null to clear' }
      },
      required: ['page_id', 'lead_list_id']
    }
  },
  execute: async (args: any, context: any) => {
    const leadListId = typeof args.lead_list_id === 'string' && args.lead_list_id.trim() ? args.lead_list_id.trim() : null;
    const data = await mcpFetch({
      method: 'PATCH', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/lead-list`, context: ctx(context),
      body: { leadListId }
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
      method: 'PUT', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/github-edit`, context: ctx(context),
      body: { file_path: args.file_path, content: args.content, commit_message: args.commit_message, branch: args.branch }
    });
    return jsonResult(data);
  }
});

export const MAX_LANDING_PAGE_FILES_PER_UPDATE = 20;
export const LANDING_PAGE_DRAFT_BRANCH = 'draft/agentweb-preview';

mcpToolRegistry.register({
  name: 'update_landing_page_files',
  definition: {
    name: 'update_landing_page_files',
    description: 'ENG-2896: commit up to 20 files to one of your landing pages in ONE atomic commit on the draft/preview branch (draft/agentweb-preview by default; main is rejected — publish with publish_landing_page_changes). Pass expected_base_sha (from a prior read) to fail with a conflict and write nothing if the branch moved. Returns the new commit SHA.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page ID' },
        files: {
          type: 'array',
          maxItems: MAX_LANDING_PAGE_FILES_PER_UPDATE,
          description: 'Files to write (max 20). Each: { path, content }.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Repo path, e.g. "src/app/page.tsx"' },
              content: { type: 'string', description: 'Full new file content' }
            },
            required: ['path', 'content']
          }
        },
        commit_message: { type: 'string', description: 'Commit message (optional)' },
        branch: { type: 'string', description: 'Target branch. Defaults to "draft/agentweb-preview". "main" is rejected.' },
        expected_base_sha: { type: 'string', description: 'Optional 40-char SHA the branch head must equal; otherwise the call fails with a conflict and writes nothing.' }
      },
      required: ['page_id', 'files']
    }
  },
  execute: async (args: any, context: any) => {
    const branch: string = args.branch || LANDING_PAGE_DRAFT_BRANCH;
    if (branch === 'main' || branch === 'refs/heads/main') {
      throw new Error('update_landing_page_files never writes to main. Omit branch to use the draft/preview branch, then publish with publish_landing_page_changes.');
    }
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files must be a non-empty array of { path, content }.');
    }
    if (files.length > MAX_LANDING_PAGE_FILES_PER_UPDATE) {
      throw new Error(`files must not exceed ${MAX_LANDING_PAGE_FILES_PER_UPDATE} entries per commit (got ${files.length}).`);
    }
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !f.path || typeof f.content !== 'string') {
        throw new Error('Each file requires a string path and string content.');
      }
    }
    const data: any = await mcpFetch({
      method: 'PUT', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/update-files`, context: ctx(context),
      body: {
        files: files.map((f: any) => ({ file_path: f.path, content: f.content })),
        commit_message: args.commit_message || `Update ${files.length} file(s) via update_landing_page_files`,
        branch,
        ...(args.expected_base_sha ? { expected_base_sha: args.expected_base_sha } : {})
      }
    });
    const commitSha = typeof data?.commit_url === 'string' ? data.commit_url.split('/commit/')[1] : undefined;
    return jsonResult({ ...data, commit_sha: commitSha });
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
        page_id: { type: 'string', description: 'The landing page ID' },
        branch: { type: 'string', description: 'Branch to read from (e.g. "draft/agentweb-preview" to read back staged edits). Omit for "main". Never selects a different repo.' }
      },
      required: ['page_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/files${args.branch ? `?branch=${encodeURIComponent(args.branch)}` : ''}`, context: ctx(context)
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
        file_path: { type: 'string', description: 'Path to the file in the repo (e.g., "src/app/page.tsx")' },
        branch: { type: 'string', description: 'Branch to read from (e.g. "draft/agentweb-preview" to read back staged edits). Omit for "main". Never selects a different repo.' }
      },
      required: ['page_id', 'file_path']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'GET', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/file-content?path=${encodeURIComponent(args.file_path)}${args.branch ? `&branch=${encodeURIComponent(args.branch)}` : ''}`, context: ctx(context)
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'get_deployment_status',
  definition: {
    name: 'get_deployment_status',
    description: 'Check the Vercel build/deployment status of a landing page. Use this after deploy_landing_page to verify the build succeeded. Note: for code edits, prefer using coding_agent which checks deployment status automatically after edits. The response\'s launchReadiness field is a SEPARATE signal from status/buildStatus: a page can build and deploy successfully and still not be launch-ready (failed post-deploy smoke test, no conversion tracking installed). Check launchReadiness.ready before telling the user the page is ready to send traffic to — if false, relay launchReadiness.reasons plainly.',
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
      method: 'GET', path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/deployment-status`, context: ctx(context)
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
      path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/preview-url`,
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
      path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/publish`,
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
      path: `/api/landing-pages/v0/generated/${encodeURIComponent(args.page_id)}/revert-publish`,
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
    description: 'Legacy alias of you_search_web (Google Custom Search retired, ENG-1281). Returns You.com web results.',
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
  expected_asset_count_tools: 'expectedAssetCountTools',
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


mcpToolRegistry.register({
  name: 'list_predefined_work_plans',
  definition: {
    name: 'list_predefined_work_plans',
    description: 'List the predefined work plan templates available to start. Non-admin users see published templates (system/public) plus their own and org-shared private plans. Admins (or admin-delegated sessions) get the full management list including unpublished and pending-review plans. To begin one, call launch_predefined_work_plan with the chosen title. Returns a compact listing shape by default (id, title, category, autocomplete, visibility, display) -- pass verbose=true only if you need a template\'s full per-step body (description, userInstructions, skillIds, requiredFunctionCalls), and pair it with plan_id (the id from a prior compact listing, or the exact title) to scope the full detail to that one template instead of the whole catalog. Prefer the default shape for browsing/matching, and always pass plan_id alongside verbose=true when you already know which template you want -- verbose without plan_id re-fetches full detail for every accessible template and may exceed the response-size threshold, getting offloaded to search_tool_response.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Return the full legacy shape (every step\'s complete body) instead of the compact listing. Defaults to false.' },
        plan_id: { type: 'string', description: 'Only used with verbose=true. Scope the full-detail response to the one template matching this id/planId or exact title, instead of the whole catalog.' },
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
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
    // ENG-1814: the raw HTTP response carries every step's full body (description,
    // userInstructions, skillIds, requiredFunctionCalls) for every accessible template --
    // trivially exceeds the platform's 8,000-char tool-response-to-S3 threshold for any
    // non-trivial catalog, forcing the model into a fragile multi-step
    // search_tool_response/read_tool_response detour just to find a specific title (the
    // detour that mis-selected a near-duplicate title in the live-reproduced ENG-1814
    // incident). launch_predefined_work_plan (applyPredefinedWorkPlan) never consumes
    // this tool's output -- it re-fetches its own candidates independently -- so nothing
    // needs the full shape here by default. Real external MCP clients (confirmed via
    // mcp_tool_used telemetry -- claude_ai OAuth callers) DO call this tool though, and
    // unlike launch_predefined_work_plan, an external end user reading the response
    // (via their own client's LLM) could legitimately want a template's full step
    // detail -- so the full legacy shape stays reachable behind an explicit opt-in
    // rather than being silently removed.
    if (args?.verbose === true) {
      // Round-4 review finding: verbose alone re-fetches full detail for the WHOLE
      // catalog, reopening the same oversized-response/S3-offload mechanism this PR
      // fixes -- for a caller who usually only wants one template's detail. plan_id
      // scopes the response to just the matching template(s) so the common case
      // (verbose + plan_id together) never re-triggers that risk; verbose alone with
      // no plan_id is still allowed (there's a real, if rarer, use case for "diff
      // every template's full detail at once") but isn't the guided default.
      const scoped = args?.plan_id && Array.isArray(data)
        ? data.filter((p: any) => p.id === args.plan_id || p.planId === args.plan_id || p.title === args.plan_id)
        : data;
      return jsonResult(scoped);
    }
    const { projectWorkPlanForCustomer } = await import('../../services/workPlanCustomerProjection');
    // Return only what a listing/matching consumer needs by default: the
    // already-built, already-tested ENG-1469 safe projection (`display`) plus the few
    // top-level fields launch/recommend calls actually reference.
    const compact = Array.isArray(data)
      ? data.map((p: any) => ({
          // Non-admin (getAllPredefinedWorkPlans) already remaps to `id`. Admin
          // (getAllWorkPlans -> raw WorkPlan records) never has `id` at all -- only
          // `planId`, the interface's actual primary key (workPlanService.ts) -- so
          // `p.id` alone silently dropped the identifier entirely for every
          // admin/delegated listing (JSON.stringify drops an undefined key), worse
          // than the pre-fix raw passthrough. Fall back to `planId` so both shapes
          // keep a real identifier under the `id` key recommend/launch expect.
          id: p.id ?? p.planId,
          title: p.title,
          category: p.category,
          autocomplete: p.autocomplete,
          visibility: p.visibility,
          // Non-admin already carries the computed ENG-1469 projection under
          // `display`. Admin (raw WorkPlan records) only ever has the raw,
          // often-undefined WorkPlanDisplayMetadataV1 shape (`stepLabels`, not
          // `steps`) -- compute the same projection here so admin/delegated
          // listings get equally useful disambiguating context.
          display: p.display?.steps ? p.display : (projectWorkPlanForCustomer(p) ?? p.display),
        }))
      : data;
    return jsonResult(compact);
  }
});


/** ENG-1992: summary of valid plans for an actionable not-found error. */
function summarizeWorkPlans(plans: any[]): Array<{ id: string; title: string }> {
  return plans
    .map((p: any) => ({ id: p?.planId ?? p?.id, title: p?.title }))
    .filter((p) => typeof p.id === 'string')
    .slice(0, 50);
}

/**
 * ENG-1992: resolve `plan_id` for get/update/delete. An id that matches a plan is
 * used as-is. For get/update, a value matching exactly one plan TITLE
 * (case-insensitive) resolves to that plan's id. Anything else — missing, unknown,
 * or an ambiguous title — returns an actionable error listing the valid plans.
 * If the plan list itself cannot be read, the original plan_id is passed through
 * unchanged so the route's own answer (and error) stands.
 */
async function resolveWorkPlanTarget(args: any, c: any): Promise<{ planId: string } | { error: Record<string, unknown> }> {
  const raw = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  let plans: any[] | undefined;
  try {
    const data = await mcpFetch({ method: 'GET', path: '/api/admin/work-plans', context: c });
    plans = Array.isArray(data) ? data : undefined;
  } catch {
    plans = undefined;
  }
  if (!plans) {
    if (raw) return { planId: raw };
    return { error: { error: `plan_id is required for action=${args.action}. Call list_predefined_work_plans to find it.` } };
  }
  if (raw && plans.some((p: any) => p?.planId === raw || p?.id === raw)) return { planId: raw };
  if (raw && args.action !== 'delete') {
    const needle = raw.toLowerCase();
    const byTitle = plans.filter((p: any) => typeof p?.title === 'string' && p.title.trim().toLowerCase() === needle);
    if (byTitle.length === 1) return { planId: byTitle[0].planId ?? byTitle[0].id };
    if (byTitle.length > 1) {
      return { error: {
        error: `plan_id "${raw}" matches ${byTitle.length} work plans by title; pass the exact plan id.`,
        matchingPlans: summarizeWorkPlans(byTitle),
      } };
    }
  }
  return { error: {
    error: raw
      ? `No work plan with id "${raw}"${args.action === 'delete' ? ' (delete requires the exact plan id, not a title)' : ''}. Use one of the ids below.`
      : `plan_id is required for action=${args.action}. Use one of the ids below.`,
    availablePlans: summarizeWorkPlans(plans),
  } };
}

mcpToolRegistry.register({
  name: 'manage_predefined_work_plan',
  definition: {
    name: 'manage_predefined_work_plan',
    description: 'Create, update, delete, or get a predefined work plan. Admin only. CAUTION: These operations modify production configuration — incorrect changes can cause outages. Always confirm with the user before making changes. STEPS ARE DESTRUCTIVE ON UPDATE: sending "steps" with action=update replaces the entire steps array, it does not patch individual steps. To amend one step without touching the others, pass steps_mode="merge" with just the step(s) you are changing. To intentionally rewrite the plan with fewer steps, send the complete new array plus confirm_step_removal=true. A replace stores exactly what you send, so a field you omit on a step is erased too — an update that would drop steps, or blank fields on the steps it keeps, is rejected unless confirmed. Every step change comes back as a stepsChange diff summary.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'get'], description: 'CRUD action' },
        plan_id: { type: 'string', description: 'Plan ID from list_predefined_work_plans (required for update/delete/get). For get/update an exact, unique plan title is also accepted. An unknown value returns the list of valid plan ids.' },
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
              requiredFunctionCalls: { type: 'array', items: { type: 'string' }, description: 'Tool names the step must call before it can complete. Note the camelCase name; the snake_case alias required_function_calls is also accepted. Without a tool listed here, its delivery is best-effort — the step can complete even if the model skips it, silently. IMPORTANT (ENG-2204): if this step\'s instructions call for posting, alerting, or notifying via Slack, ALWAYS include slack_send_message here too.' },
              skillIds: { type: 'array', items: { type: 'string' }, description: 'Skill IDs attached to this step (from list_skills / resolve_skill). Alias: skill_ids.' },
              userInstructions: { type: 'string', description: 'Instructions shown to the user for this step. Alias: user_instructions.' },
              stepCount: { type: 'number', description: 'Step order, 1-based. Defaults to the array position. In steps_mode="merge" this is what selects the existing step to amend. Alias: step_count.' },
              expectedAssetCount: { type: 'number', description: 'For a step that must produce a fixed number of media assets (e.g. "generate 18 images"), the required count. The step cannot be marked completed until that many assets have been produced SINCE THE PREVIOUS STEP RESOLVED — an earlier step\'s assets never count toward a later step\'s requirement. Omit for steps with no fixed asset count. Alias: expected_asset_count.' },
              expectedAssetCountTools: { type: 'array', items: { type: 'string' }, description: 'Which tool name(s) count toward expectedAssetCount, for a step that calls more than one asset-producing tool that aren\'t interchangeable (e.g. a step that builds a few reusable HTML templates via create_html_file AND takes one screenshot per requested size via playwright_browser_take_screenshot — only the screenshot count is "the N things"). Named tools are summed. Omit when the step calls only one asset-producing tool, or when every asset-producing tool it calls should count as the same deliverable — the count then falls back to the largest count among them. Alias: expected_asset_count_tools.' },
              model: { type: 'string', description: 'Optional model for THIS step (a canonical model id from the model picker). When set, the step runs on exactly this model and the plan pauses (never switches models) if it becomes unavailable. Omit to use the plan default_model, then the account default. Only stored while per-step models are enabled; a blank string clears it in steps_mode="merge". A model that is not served or not selectable is refused with a 422 naming the step.' }
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
          description: 'Required (true) when a steps_mode="replace" update would leave the plan with fewer steps than it has now, or would blank fields (description, requiredFunctionCalls, skillIds, userInstructions, expectedAssetCount, expectedAssetCountTools, model) that are currently set on the steps it keeps. Without it the update is rejected instead of silently destroying that content.'
        }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    // ENG-1992: the dominant failure cluster (18/28) was `not_found` — the model
    // passed a plan TITLE, a stale id, or nothing as plan_id, and the route's bare
    // "Work plan not found" 404 gave it nothing to recover with. Resolve a unique
    // exact title match to its real id (get/update only — never a destructive delete
    // by title), and otherwise return the valid plans instead of an opaque 404.
    // Resolution runs only on a missing plan_id or a 404, so the happy path is unchanged.
    const targetsPlan = args.action === 'update' || args.action === 'delete' || args.action === 'get';
    if (targetsPlan && !(typeof args.plan_id === 'string' && args.plan_id.trim())) {
      const resolved = await resolveWorkPlanTarget(args, c);
      return jsonResult('error' in resolved ? resolved.error : { error: 'plan_id is required' });
    }
    try {
      return await runManagePredefinedWorkPlan(args, c);
    } catch (error: any) {
      if (!targetsPlan || !/API error \(404\)/.test(String(error?.message || ''))) throw error;
      const resolved = await resolveWorkPlanTarget(args, c);
      if ('error' in resolved) return jsonResult(resolved.error);
      if (resolved.planId === args.plan_id) throw error;
      return await runManagePredefinedWorkPlan({ ...args, plan_id: resolved.planId }, c);
    }
  }
});

async function runManagePredefinedWorkPlan(args: any, c: any): Promise<any> {
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
            const current = await mcpFetch({ method: 'GET', path: `/api/admin/work-plans/${encodeURIComponent(args.plan_id)}`, context: c });
            existingSteps = Array.isArray(current?.steps) ? current.steps : [];
            // Stake the read: everything below is judged against these steps, so
            // a write that lands in between has to fail rather than quietly make
            // that judgement wrong (ENG-890).
            body.expectedStepsRev = current?.steps_rev ?? null;
          } catch (error: any) {
            // A 404 means the plan_id itself is wrong: let it reach execute()'s
            // title/candidate resolution (ENG-1992) instead of masking it here.
            if (/API error \(404\)/.test(String(error?.message || ''))) throw error;
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
            // ENG-2378: a replace built from memory (the tool never shows a step's model) must not erase stored models.
            body.steps = carryStoredStepModels(incomingSteps, existingSteps);
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
          data = await mcpFetch({ method: 'PUT', path: `/api/admin/work-plans/${encodeURIComponent(args.plan_id)}`, context: c, body });
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
        const data = await mcpFetch({ method: 'DELETE', path: `/api/admin/work-plans/${encodeURIComponent(args.plan_id)}`, context: c });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/admin/work-plans/${encodeURIComponent(args.plan_id)}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
}

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
        const data = await mcpFetch({ method: 'PUT', path: `/api/skills/${encodeURIComponent(args.skill_id)}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        if (!args.skill_id) return jsonResult({ error: resolveSkillInstruction('delete') });
        const data = await mcpFetch({ method: 'DELETE', path: `/api/skills/${encodeURIComponent(args.skill_id)}`, context: c });
        return jsonResult(data);
      }
      case 'get': {
        if (!args.skill_id) return jsonResult({ error: resolveSkillInstruction('get') });
        const data = await mcpFetch({ method: 'GET', path: `/api/skills/${encodeURIComponent(args.skill_id)}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── Chat History (admin-only) ──────────────────────────────────────────────

const CHAT_HISTORY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** ENG-2972: resolve an optional start/end window (default: trailing 24h ending now). */
export function resolveChatHistoryWindow(
  args: any,
  now: Date = new Date()
): { start_time: string; end_time: string } | { error: string } {
  const endRaw = typeof args?.end_time === 'string' && args.end_time.trim() ? args.end_time.trim() : undefined;
  const startRaw = typeof args?.start_time === 'string' && args.start_time.trim() ? args.start_time.trim() : undefined;
  const endMs = endRaw ? Date.parse(endRaw) : now.getTime();
  if (Number.isNaN(endMs)) return { error: `end_time "${endRaw}" is not a valid ISO 8601 timestamp` };
  const startMs = startRaw ? Date.parse(startRaw) : endMs - CHAT_HISTORY_DEFAULT_WINDOW_MS;
  if (Number.isNaN(startMs)) return { error: `start_time "${startRaw}" is not a valid ISO 8601 timestamp` };
  if (startMs >= endMs) return { error: 'start_time must be before end_time' };
  // Caller-supplied values pass through verbatim; only missing ends are filled.
  return { start_time: startRaw ?? new Date(startMs).toISOString(), end_time: endRaw ?? new Date(endMs).toISOString() };
}

mcpToolRegistry.register({
  name: 'get_chat_history',
  definition: {
    name: 'get_chat_history',
    description: `Get chat history by time range with satisfaction scores. Returns sessions with their metadata including satisfaction scores. Useful for generating support summaries and analyzing customer satisfaction. Admin-only. When sync=true, generates satisfaction scores for sessions that don't have them (slower but ensures all scores are present).

SCORING COVERAGE — a null satisfactionScore is NOT self-explanatory. Under sync=true every session carries scoringOutcome {status, reason}, and the response carries scoringSummary {scored, skipped, failed, notAttempted, timedOut}:
- status 'scored' — a score was generated on this call.
- status 'skipped' — deliberately not scored; reason says which rule (in-flight, already-scored, no-task-session, test-run, no-user-message, admin-override). 'in-flight' means the run had not finished at read time, so it is legitimately unscorable — NOT a failure.
- status 'failed' — scoring was attempted and errored (reason carries the error). The session IS in the cohort and is missing a score it should have. Report these; do not present the window as fully scored.
- status 'not-attempted' — the sync pass ran out of its wall-clock budget before this session. Same effect as 'failed' for coverage: the session is unscored and nothing re-attempts it later.
Any non-zero failed/notAttempted count means the satisfaction figures under-sample the window. Say so explicitly, with the counts, rather than reporting an average as if coverage were complete. scoringOutcome and scoringSummary are null when sync was not requested.

MODEL ATTRIBUTION — use attributedModels. Do not derive it yourself.
- attributedModels: the model(s) to name for this session. Already resolved for you. Null only when nothing is recorded at all.
- attributionBasis: 'transcript' when EVERY assistant turn recorded a model (trustworthy provenance); 'partial-transcript' when only some did — the model list is real but incomplete, so do not present it as the session's full attribution; 'selection-only' when no turn recorded a model and this fell back to the picker (state that it is unverified whenever you report it).
- modelLine: the exact per-session model line to print — use this verbatim, do not compose your own from llmModel/attributedModels. Already in "picker: X · ran: Y" form when the picker disagrees with what ran, INCLUDING when the picker is one of several models that ran (a multi-model run is never "agreement" — it is never equal to the single-value picker, so the picker's involvement doesn't collapse it); collapses to a single model name only when exactly one model ran and it is the picker, or when there is nothing to contrast (selection-only). When attributionBasis is 'partial-transcript' it carries its own "(partial — N of M assistant turns unlabelled)" suffix, so it is safe to print as-is without separately checking attributionBasis. Null only when attributedModels is null.
- modelMix (top-level, sibling of sessions): the model-mix / share-of-sessions section, precomputed from attributedModels — { sessionsWithModelData, partialAttributionSessions, truncated, byModel: [{model, sessions, share}] }, byModel sorted by sessions descending, share a 0-1 fraction of sessionsWithModelData. Use this directly for any "share of sessions per model" or model-mix reporting; do not recompute it from llmModel or you will hide a fleet-wide default-model switch behind stale picker values. partialAttributionSessions counts how many of sessionsWithModelData were only partially labelled (qualify the shares as approximate when this is > 0). truncated (also returned top-level, sibling of sessions) is true when more sessions exist in the requested range beyond the limit parameter — when true, do not present modelMix, or sessions, as covering the full range; say so, or re-run with a higher limit. Null when no session in range has any resolvable attribution.

The two underlying fields are also returned, and they are NOT interchangeable:
- llmModel: the model *selected* in the picker. A client-side selection only — the session may never have run on it (it can name a model outside the registry, or a live voice model that cannot generate text at all).
- generationModels: the models that actually generated the assistant turns, derived from the transcript. Null when no message recorded one.

TOKEN vs COST — they are not on the same basis. totalTokens EXCLUDES prompt-cache tokens, but totalCost/estimated_cost BILLS them. cacheTokens ({creation, read}, null when none) reports what was cached. A cache-heavy scheduled run can show 371 totalTokens against $2.94 of real spend, so a cost-per-token or "cheap because few tokens" claim computed from totalTokens alone is wrong by orders of magnitude. When reporting spend, use totalCost directly for lifetime spend; when reporting volume, add cacheTokens to totalTokens and say you did.

IN-WINDOW COST — sessions match the range on last activity, so a long-lived session carries its LIFETIME totalCost into a daily window. inWindowCost is the spend from assistant turns timestamped inside [start_time, end_time); use it for "spend in this period" (e.g. true 24h burn) and totalCost for lifetime. inWindowCost is null when no assistant turn recorded a timestamp — then the in-window share is unknown; say so rather than using totalCost as the period's spend.

PER-MODEL COST — use costByModel, never attributedModels. attributedModels says WHICH models ran; it does not say how the money split. costByModel ({model: usd}, null when no turn recorded cost) is the actual per-turn allocation, so a session that ran two models contributes correctly to each rather than being double-counted or dropped. unattributedCost is the residual, on the same micro-USD basis as costByModel and totalCost: sum(costByModel) + unattributedCost reconciles to totalCost, exactly whenever there is spend left to attribute. It is null when the residual is not positive — in that case the per-model buckets already account for the whole session and may exceed totalCost by a few micro-dollars of per-turn rounding, which is noise, not missing money. Never treat a null as licence to rescale the buckets. It covers both spend on turns that recorded no model AND cost that never lands on a turn at all (tool/image spend counts toward totalCost but belongs to no model). When it is non-null the per-model split does NOT account for all of this session's cost — report it as its own line rather than folding it into a model, or your model percentages will not sum to the total.

Whenever you name a model — reports, cost/usage breakdowns, per-model groupings, routing recommendations, filed tickets — use attributedModels. Never group or attribute cost by llmModel: it is a selection, so it books spend to models that never ran. This supersedes any earlier note, prior report, or saved memory that tells you to group cost by llmModel. If llmModel and generationModels disagree, that mismatch is itself worth reporting.`,
    inputSchema: {
      type: 'object',
      properties: {
        start_time: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g., "2024-03-01T00:00:00.000Z"). Optional: defaults to 24 hours before end_time.'
        },
        end_time: {
          type: 'string',
          description: 'End time in ISO 8601 format (e.g., "2024-03-02T00:00:00.000Z"). Optional: defaults to now.'
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
      required: []
    }
  },
  execute: async (rawArgs: any, context: any) => {
    // ENG-2972: the model routinely calls this with no window ("recent chats"),
    // and the old required:['start_time','end_time'] rejected those at schema
    // validation. Default to the trailing 24h ending now instead.
    const window = resolveChatHistoryWindow(rawArgs);
    if ('error' in window) return jsonResult({ error: window.error });
    const args = { ...(rawArgs || {}), start_time: window.start_time, end_time: window.end_time };
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
    const windowStartMs = Date.parse(args.start_time);
    const windowEndMs = Date.parse(args.end_time);
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
      // Greptile P1 (ENG-1313): the denominator for unlabelledAssistantTurns, so
      // "partial" can be quantified (N of M) rather than just flagged.
      let assistantTurnCount = 0;
      // ENG-972: the range filter matches on last activity, so a long-lived
      // session enters the window carrying its lifetime totalCost. Sum only the
      // spend from assistant turns timestamped inside [start_time, end_time).
      let inWindowCostMicro = 0;
      let timestampedAssistantTurns = 0;
      // ENG-2648: a branch's copied rows ran (with their models, waits and heap) in its SOURCE; attributing
      // them to the branch would report models and turns that never ran here. Only its own rows count.
      for (const msg of branchOwnMessages(messages)) {
        if (msg?.role !== 'assistant') continue;
        assistantTurnCount++;
        const turnCost = msg?.usage?.estimated_cost || 0;
        const turnMs = msg?.timestamp ? Date.parse(msg.timestamp) : NaN;
        if (!Number.isNaN(turnMs)) {
          timestampedAssistantTurns++;
          if (turnMs >= windowStartMs && turnMs < windowEndMs && turnCost) {
            inWindowCostMicro += Math.round(turnCost * 1e6);
          }
        }
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

      const attributedModels: string[] | null = generationModels.size > 0
        ? [...generationModels]
        : (session.llmModel ? [session.llmModel] : null);
      const attributionBasis: 'transcript' | 'partial-transcript' | 'selection-only' | null =
        generationModels.size > 0
          ? (unlabelledAssistantTurns > 0 ? 'partial-transcript' : 'transcript')
          : (session.llmModel ? 'selection-only' : null);
      // ENG-1313: the Daily Satisfaction Score Report named the picker
      // (llmModel) instead of the model that ran even after ENG-892 exposed
      // attributedModels — building the report's per-session line was still a
      // judgement call the reporting agent had to make correctly every time,
      // and it silently reverted to the field named `llmModel` on sight. Same
      // fix pattern as ENG-892: pre-compute the exact display line so there is
      // no choice left to make. Only names the picker when it disagrees with
      // what ran — agreement (or selection-only, where there is nothing to
      // contrast) collapses to a single value.
      //
      // Greptile P1 (ENG-1313 review): a partial-transcript session's
      // attributedModels only lists the turns that DID record a model, so
      // printing it bare (as "the" model line) presents an incomplete list as
      // complete — a model used only by an unlabelled turn goes unnamed with
      // no signal that anything is missing. Append an explicit "(partial — N
      // of M assistant turns unlabelled)" qualifier whenever attributionBasis
      // is 'partial-transcript', so modelLine can still be printed verbatim
      // without silently overstating its own completeness.
      const partialQualifier = attributionBasis === 'partial-transcript'
        ? ` (partial — ${unlabelledAssistantTurns} of ${assistantTurnCount} assistant turns unlabelled)`
        : '';
      // CodeRabbit (ENG-1313 review): "agreement" must mean the picker is the
      // WHOLE story — exactly one model ran and it is the picker — not merely
      // that the picker is somewhere among several models that ran. The old
      // `!includes()` check treated a picker-plus-backup run (picker ran, and
      // so did another model) as agreement, dropping the "picker:" label even
      // though a second model's involvement is exactly the kind of fact this
      // field exists to surface. Per acceptance criterion 1 (ENG-1313):
      // "when picker ≠ generation it shows both" — a multi-model
      // `attributedModels` is never equal to the single-value picker, so it
      // must take the "picker: X · ran: Y" form regardless of whether the
      // picker happens to be one of the models that ran.
      const modelLine: string | null = attributedModels
        ? (session.llmModel && (attributedModels.length !== 1 || attributedModels[0] !== session.llmModel)
            ? `picker: ${session.llmModel} · ran: ${attributedModels.join(', ')}${partialQualifier}`
            : `${attributedModels.join(', ')}${partialQualifier}`)
        : null;

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
        attributedModels,
        attributionBasis,
        // ENG-1313: the exact string the per-session report line should use
        // verbatim — see the modelLine computation above.
        modelLine,
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
        // ENG-972: spend from assistant turns inside the requested window only.
        // Null when no assistant turn carries a timestamp (unknown, not zero).
        inWindowCost: timestampedAssistantTurns > 0 ? inWindowCostMicro / 1e6 : null,
        satisfactionScore: session.satisfactionScore || null,
        judgeScores: session.judgeScores || null,
        // ENG-929: under sync=true, why this session does or does not have a
        // score. Null when sync was not requested (nothing was attempted).
        scoringOutcome: session.scoringOutcome || null,
        feedback: (likes > 0 || dislikes > 0) ? { likes, dislikes } : null,
        longestWaitMs: longestWaitMs > 0 ? longestWaitMs : null,
        maxHeapMB: maxHeapMB > 0 ? Math.round(maxHeapMB) : null,
        workPlan: workPlanSummary,
        delegateInfo: session.delegateInfo || null,
      };
    });

    // Greptile P1 (ENG-1313 review): the admin route paginates with a cursor
    // (`nextCursor`, non-null when more sessions exist beyond `limit`), but
    // this tool previously dropped it entirely — so a limit-truncated result
    // was returned with no signal that it was incomplete. Any range-wide
    // aggregate computed only over the returned page (modelMix below, but
    // this also applies to `count`/`sessions`) needs that signal surfaced,
    // not silently presented as covering the full requested range.
    const truncated = (data as any)?.nextCursor != null;

    // ENG-1313 acceptance criterion 3: the model-mix section must be computed
    // from attributedModels (transcript-derived where available), never from
    // llmModel — otherwise a fleet-wide default-model switch stays invisible
    // because every session still shows its old picker selection. Counted per
    // session (not per turn), against attributedModels only, so this can never
    // be pulled toward llmModel by accident.
    const modelMixCounts: Record<string, number> = {};
    let sessionsWithModelData = 0;
    // Greptile P1 (ENG-1313 review): sessions with only partial transcript
    // attribution are still counted (their known models are real), but the
    // count of how many are partial travels with the aggregate so a consumer
    // can qualify the shares rather than presenting them as exact.
    let partialAttributionSessions = 0;
    for (const s of formattedSessions) {
      if (!s.attributedModels) continue;
      sessionsWithModelData++;
      if (s.attributionBasis === 'partial-transcript') partialAttributionSessions++;
      for (const m of s.attributedModels as string[]) {
        modelMixCounts[m] = (modelMixCounts[m] || 0) + 1;
      }
    }
    const modelMix = sessionsWithModelData > 0
      ? {
          sessionsWithModelData,
          partialAttributionSessions,
          truncated,
          byModel: Object.entries(modelMixCounts)
            .map(([model, sessions]) => ({ model, sessions, share: sessions / sessionsWithModelData }))
            .sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model)),
        }
      : null;

    return jsonResult({
      sessions: formattedSessions,
      count: formattedSessions.length,
      timeRange: { startTime: args.start_time, endTime: args.end_time },
      syncMode: args.sync || false,
      // ENG-929: coverage of THIS sync pass. Null when sync was not requested.
      scoringSummary: (data as any)?.scoringSummary || null,
      truncated,
      modelMix,
      // ENG-1332: requested-range/scored/skipped counts for sync=true calls, so
      // a report can state its own coverage/denominator honestly instead of
      // inferring one from sessions.length. Null when sync=false — no scoring
      // pass ran, so there is nothing to report coverage on.
      scoringCoverage: (data as any)?.scoringCoverage ?? null,
    });
  }
});

// ─── Organization Diagnostics (admin-only) ─────────────────────────────────

mcpToolRegistry.register({
  name: 'inspect_orphaned_org_join_requests',
  definition: {
    name: 'inspect_orphaned_org_join_requests',
    description: 'Inspect pending organization join requests whose user record no longer exists. Admin-only, read-only; repair is not supported by this tool.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  execute: async (_args: any, context: any) => jsonResult(await mcpFetch({
    method: 'GET',
    path: '/api/admin/org-diagnostics/orphaned-org-join-requests',
    context: ctx(context),
  })),
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
- has_ads: whether a Meta ad account is on record (it may have expired — see ad_connection)
- ad_connection: never_connected (no ad account anywhere: activation, not churn) / connected / expired (Meta connection broke) / other_platform (ads on Google Ads or LinkedIn Ads, no Meta)
- ad_connection_all_platforms: never_connected / connected / expired across Meta, Google Ads and LinkedIn Ads — expired means no ad account on any platform is usable (reconnect needed; a setup problem, not churn)
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
- **Overall status**: healthy / mediocre / needs-attention / blocked / onboarding with reasons
  - onboarding = activation incomplete (no ad account ever connected). This is NOT churn or at-risk — treat it as an activation nudge.
  - ads_layer.connection other_platform = ads run on Google Ads or LinkedIn Ads; the Meta layer is not assessed and this is not a problem.
  - needs-attention = setup or reconnect work: every ad connection expired (ads_layer.connection_all_platforms, all_platforms_expired_at) or several setup gaps. This is NOT churn or at-risk evidence — never describe it as churn risk.
  - This tool never returns at-risk: churn risk needs behavioural evidence (spend, results, payments, feedback) and is not assessed here.

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

mcpToolRegistry.register({
  name: 'read_client_meta_activity',
  definition: {
    name: 'read_client_meta_activity',
    description: `Read the Meta ad account change history (who changed what, when) for one named client. Admin-only tool, read-only — nothing is written to Meta.

Resolves the client the same way assess_client_health does, with one difference: a name that matches more than one client is refused, so pass the exact email when a name is ambiguous.

Returns:
- 'ad_account_id' and 'client': the account that was actually read and whose it is. Check these before quoting the history.
- 'events': one page of Meta activity events (event_time, event_type, object_id, object_name, object_type, actor_name, extra_data). When Meta supplies old and new values (for example a budget change), they are also given as 'before' and 'after'. Fields Meta did not return are absent.
- 'paging': cursors; pass paging.cursors.after as 'after' to read the next page.

A result with success:false means nothing was read ('reason' says why: ambiguous_client, client_not_found, no_meta_connection, credential_pair_mismatch, invalid_argument, meta_read_failed). Never report a failed read as "no changes".`,
    inputSchema: {
      type: 'object',
      properties: {
        client_name_or_email: {
          type: 'string',
          description: 'The client\'s email address or display name. Email lookup is tried first, then name matching.'
        },
        since: { type: 'string', description: 'ISO date or unix seconds; earliest event.' },
        until: { type: 'string', description: 'ISO date or unix seconds; latest event.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Events per page (default 50).' },
        after: { type: 'string', description: 'Paging cursor from a previous result.' }
      },
      required: ['client_name_or_email']
    }
  },
  execute: async (args: any, context: any) => {
    const queryParams: Record<string, string> = {};
    for (const key of ['since', 'until', 'limit', 'after']) {
      if (args[key] !== undefined && args[key] !== null && String(args[key]).trim() !== '') queryParams[key] = String(args[key]);
    }
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/client-health/${encodeURIComponent(args.client_name_or_email)}/meta-activity`,
      context: ctx(context),
      queryParams
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'check_account_tracking_health',
  definition: {
    name: 'check_account_tracking_health',
    description: `Check Meta pixel/CAPI health and destination-URL coverage for a specific client's ad account. Admin-only tool, read-only — never sends a real alert, always runs in dry-run mode against this one account.

Resolves the client (email or name) to their Meta ad account via the same lookup assess_client_health uses, then runs the tracking-integrity check scoped to that one account only.

Returns:
- 'summary': aggregate counts (blackouts, tokenErrors, fetchErrors, healthy, destinationAlerts, destinationOk, etc.) — since this call is scoped to exactly one account, a nonzero count on any of these describes THIS account, not a fleet-wide total.
- 'summary.capturedAlerts': the specific findings that would have alerted, each with a subject, message, and structured context — this is the actual evidence (which pixel, which destination check, why) behind the aggregate counts above.

Use this to check "is the pixel broken" / "is CAPI deployed" / "does this ad's destination actually carry a pixel this account owns" BEFORE concluding a lead-volume or CTR/CPM anomaly is caused by tracking failure rather than a genuine performance issue — the same reasoning monitor_lead_volume's 'requiresTrackingValidation' field already points here for.

If the client has no connected Meta ad account, this returns an error rather than a health result — check assess_client_health first if account connectivity itself is in question.`,
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
    const healthData: any = await mcpFetch({
      method: 'GET',
      path: `/api/client-health/${encodeURIComponent(args.client_name_or_email)}`,
      context: ctx(context)
    });
    if (!healthData?.success || !healthData?.health?.client?.userId) {
      return jsonResult({ success: false, error: healthData?.message || `Could not resolve client "${args.client_name_or_email}"` });
    }
    const userId = healthData.health.client.userId;
    const adAccountId = healthData.health.ads_layer?.ad_account_id;
    if (!adAccountId) {
      return jsonResult({ success: false, error: `Client "${args.client_name_or_email}" has no connected Meta ad account — nothing to check.` });
    }
    const data = await mcpFetch({
      method: 'POST',
      path: '/api/admin/tracking-monitor/run',
      context: ctx(context),
      body: { dryRun: true, userId, adAccountId },
    });
    return jsonResult({ success: true, client: healthData.health.client, ...data });
  }
});

mcpToolRegistry.register({
  name: 'diagnose_leads_at_zero',
  definition: {
    name: 'diagnose_leads_at_zero',
    description: `Discriminate between look-alike causes for a client's "leads at zero" symptom, per connected Meta ad account. Admin-only, read-only.

Evaluates five causes — pixel_capi_broken, landing_page_unreachable, budget_exhausted, genuine_demand_drop, normal_variance — using monitor_lead_volume and the tracking-health sweep as evidence, and applies a strict discrimination gate: 'determined' is only returned when exactly one cause has DIRECT supporting evidence and every other checkable cause has been ruled out. 'budget_exhausted' has no evidence source anywhere in this system today and is always reported as 'unchecked'. 'genuine_demand_drop' can be ruled out but never confirmed here either — a real drought requires a Conversion Tracking Validator pass this tool cannot run, so it stops at 'unchecked' rather than a confident but unvalidated 'supported'. Neither blocks a determined diagnosis on a different, well-evidenced cause — both are always disclosed.

⚠ When the result is 'could_not_determine', do NOT pick a cause anyway and do NOT recommend an action — report it as an honest diagnosis gap, listing which causes remain live/unchecked. A confidently wrong diagnosis is worse than an honest "could not determine" — this is the one thing this tool must never be used to work around.

Returns one diagnosis per connected Meta ad account, each with: outcome ('determined'|'could_not_determine'), concludedCause (null unless determined), causes (every cause evaluated, with its verdict and evidence — always read this, not just the top-line outcome), and reason (populated only when could_not_determine).`,
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
      path: `/api/l2-diagnose/leads-at-zero/${encodeURIComponent(args.client_name_or_email)}`,
      context: ctx(context)
    });
    return jsonResult(data);
  }
});

// ENG-1994: the /api/lead-volume-monitor route accepts only YYYY-MM-DD. Models routinely send a
// full ISO-8601 datetime for a schema field described as a date, which the route rejected as
// invalid_args. Truncate a well-formed datetime to its date; anything else passes through
// untouched so the route still fails closed with a 400 instead of being silently coerced.
const LEAD_VOLUME_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}(T[0-9:.]+(Z|[+-]\\d{2}:?\\d{2})?)?$';
const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;
export function normalizeLeadVolumeDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const str = String(value).trim();
  const m = ISO_DATETIME_RE.exec(str);
  if (!m) return str;
  // Only truncate a real calendar date; otherwise pass the raw value through so the route's
  // YYYY-MM-DD check rejects it with a 400 instead of forwarding e.g. 2025-02-31.
  const [y, mo, d] = m[1].split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return real ? m[1] : str;
}

mcpToolRegistry.register({
  name: 'monitor_lead_volume',
  definition: {
    name: 'monitor_lead_volume',
    description: `Report spend and CRM-landed leads per Meta ad campaign per day for a specific client, and flag campaigns whose lead volume has collapsed relative to THAT CAMPAIGN'S OWN history. Admin-only tool. Pass the client's name or email as client_name_or_email; client_id and client_email are accepted aliases.

Trigger is distribution-aware, not a fixed day count: a campaign is flagged only when its trailing 7-day lead average falls below its OWN 5th-percentile historical floor. A campaign needs at least 14 days of baseline history (excluding the trailing window) before it can be flagged at all — with less, status is 'insufficient_history', not 'normal' or 'drought'.

⚠ A flagged campaign ('status': 'drought') is NOT a confirmed drought — 'requiresTrackingValidation' is always true on that verdict, and you MUST run Conversion Tracking Validator on the same client before reporting it as a real issue. Pixel/CAPI breakage produces the same signal as a genuine lead collapse, and this tool cannot distinguish them.

⚠ The response also includes 'unattributedContext' and 'totalUnattributedLeads' at the ACCOUNT level, separate from every campaign's own totals. A nonzero unattributed count is normal (not every ad carries a matchable UTM) — NEVER read it as evidence any specific campaign's volume collapsed, and never subtract it from a campaign's lead total.

Returns one report per connected Meta ad account for the client.

⚠ If the response has 'truncated': true, the underlying data read was cut short and every verdict in this response (including 'normal' ones) may be based on incomplete history — narrow the since/until window and retry rather than reporting any of it as final.`,
    inputSchema: {
      type: 'object',
      properties: {
        client_name_or_email: {
          type: 'string',
          description: 'The client\'s email address or display name. Email lookup is tried first, then name matching.'
        },
        since: {
          type: 'string',
          pattern: LEAD_VOLUME_DATE_PATTERN,
          description: 'Optional window start, YYYY-MM-DD (a full ISO-8601 datetime is truncated to its date). Must not be after `until`; the since..until window must not exceed 366 days. Defaults to 60 days before `until`.'
        },
        until: {
          type: 'string',
          pattern: LEAD_VOLUME_DATE_PATTERN,
          description: 'Optional window end, YYYY-MM-DD (a full ISO-8601 datetime is truncated to its date). Defaults to today.'
        }
      },
      required: ['client_name_or_email']
    }
  },
  execute: async (args: any, context: any) => {
    const query = new URLSearchParams();
    const since = normalizeLeadVolumeDate(args.since);
    const until = normalizeLeadVolumeDate(args.until);
    if (since) query.set('since', since);
    if (until) query.set('until', until);
    const qs = query.toString();
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/lead-volume-monitor/${encodeURIComponent(args.client_name_or_email)}${qs ? `?${qs}` : ''}`,
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
    // ENG-1628: the route answers "no match" with 404 and a bad url with 400, and
    // mcpFetch turns both into a bare `Error` — so ordinary lookups were counted as
    // bug-class runtime failures (4/4). Return typed results for those outcomes and
    // reserve a thrown, specifically-named error for genuine faults.
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!url) return jsonResult({ status: 'invalid_url', error: "'url' is required: pass a live page URL or bare hostname." });
    let data: any;
    try {
      data = await mcpFetch({
        method: 'GET',
        path: `/api/admin/landing-pages/resolve?url=${encodeURIComponent(url)}`,
        context: ctx(context)
      });
    } catch (error: any) {
      const message = String(error?.message || error);
      const status = Number(/API error \((\d{3})\)/.exec(message)?.[1]);
      if (status === 404) {
        const scannedAll = !/"scannedAll"\s*:\s*false/.test(message);
        return jsonResult({
          status: 'not_found',
          matches: [],
          scannedAll,
          message: scannedAll
            ? `No landing page matches "${url}".`
            : `No landing page matched "${url}" within the scan cap; the result is inconclusive.`,
        });
      }
      if (status === 400) {
        return jsonResult({ status: 'invalid_url', error: `"${url}" is not a valid URL or hostname.` });
      }
      throw new LandingPageResolveError(message, Number.isFinite(status) ? status : undefined);
    }
    return jsonResult({ status: 'found', ...(data && typeof data === 'object' ? data : { data }) });
  }
});

/** ENG-1628: a genuine (non-404/400) failure of resolve_landing_page_by_url. */
export class LandingPageResolveError extends Error {
  readonly httpStatus?: number;
  constructor(cause: string, httpStatus?: number) {
    super(`resolve_landing_page_by_url failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${cause}`);
    this.name = 'LandingPageResolveError';
    this.httpStatus = httpStatus;
  }
}

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
      ? `/api/admin/users/${encodeURIComponent(args.user_id)}/deactivate`
      : `/api/admin/users/${encodeURIComponent(args.user_id)}/reactivate`;
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
        const data = await mcpFetch({ method: 'GET', path: `/api/admin/users/${encodeURIComponent(user_id)}/notes`, context: ctx(context) });
        return jsonResult(data);
      }
      case 'add': {
        if (!content) return jsonResult({ error: 'content is required for add' });
        const data = await mcpFetch({ method: 'POST', path: `/api/admin/users/${encodeURIComponent(user_id)}/notes`, context: ctx(context), body: { content } });
        return jsonResult(data);
      }
      case 'delete': {
        if (!note_id) return jsonResult({ error: 'note_id is required for delete' });
        const data = await mcpFetch({ method: 'DELETE', path: `/api/admin/users/${encodeURIComponent(user_id)}/notes/${encodeURIComponent(note_id)}`, context: ctx(context) });
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
        const data = await mcpFetch({ method: 'PUT', path: `/api/settings/scoring-judges/${encodeURIComponent(judge_id)}`, context: ctx(context), body: { name, systemPrompt: system_prompt } });
        return jsonResult(data);
      }
      case 'delete': {
        if (!judge_id) return jsonResult({ error: 'judge_id is required for delete' });
        const data = await mcpFetch({ method: 'DELETE', path: `/api/settings/scoring-judges/${encodeURIComponent(judge_id)}`, context: ctx(context) });
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

const USAGE_MONTH_SCHEMA_PROPERTY = {
  type: 'string',
  description: 'Optional YYYY-MM. When set, include usage_breakdown (tokens and calls by model/day, session count) for that month.',
};

/**
 * ENG-758: optional usage breakdown. Absent month = no extra read (status stays cheap).
 * An invalid month or a failed ledger read is reported in-band, never fabricated and
 * never allowed to fail the status read itself.
 */
async function readUsageBreakdown(month: unknown, context: any): Promise<Record<string, unknown>> {
  if (month === undefined || month === null || month === '') return {};
  if (typeof month !== 'string' || !USAGE_MONTH_PATTERN.test(month)) {
    return { usage_breakdown_error: 'usage_month must be YYYY-MM' };
  }
  try {
    const payload = await mcpFetch({
      method: 'GET',
      path: `/api/subscription/usage/itemized?month=${encodeURIComponent(month)}`,
      context,
    });
    return { usage_breakdown: summarizeItemizedUsage(payload, month) };
  } catch {
    return { usage_breakdown_error: 'Usage data is temporarily unavailable' };
  }
}

mcpToolRegistry.register({
  name: 'get_account_status',
  definition: {
    name: 'get_account_status',
    description: "Get the current user's account status, subscription plan, and usage. Pass usage_month (YYYY-MM) to also get that month's LLM token/call totals by model and by day plus a session count. Admin-only: pass client_id to check a specific client's status instead of the caller's own.",
    inputSchema: {
      type: 'object',
      properties: { client_id: CLIENT_ID_SCHEMA_PROPERTY, usage_month: USAGE_MONTH_SCHEMA_PROPERTY },
      required: []
    }
  },
  /** Reports the caller's own account status, or (admin-only) `args.client_id`'s. */
  execute: async (args: any, context: any) => {
    const c = await resolveClientScopedContext(context, args?.client_id, 'get_account_status');

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
    //
    // ENG-1540: `subscription_status` is only ever populated on the org OWNER's
    // record by a live Stripe subscription sync — an owner whose paid access
    // was granted out-of-band (admin/manual comp, no Stripe subscription object)
    // never gets the field set at all, org members riding that owner's billing
    // inherit the same gap, and it stays unset indefinitely (no ongoing owner
    // -side sync ever revisits it). Defaulting that absence to the literal
    // 'inactive' told a currently-paying-and-unblocked Pro customer their
    // subscription was inactive. A paid, non-Free plan with no persisted status
    // means "active but never synced", not "inactive".
    // `||`, not `??`: auth.ts's own sync trigger (`!user.subscription_status`)
    // already treats an empty string as missing, so this has to match or a
    // stray '' would pass through unresolved instead of deriving a real status.
    const subscriptionStatus =
      me?.subscription_status ||
      (me?.subscriptionType && me.subscriptionType !== 'Free' ? 'active' : 'inactive');
    return jsonResult({
      email: me?.email ?? null,
      subscription_plan: me?.subscriptionType ?? 'Free',
      subscription_status: subscriptionStatus,
      current_period_end: me?.current_period_end ?? null,
      allowed_features: Array.isArray(me?.allowedPages) ? me.allowedPages : [],
      api_key_count: apiKeyCount,
      ...(await readUsageBreakdown(args?.usage_month, c)),
    });
  }
});
