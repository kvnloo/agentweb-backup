/**
 * Workflow Tools — the job-shaped MCP surface (ENG-982, tranche 1 of 3).
 *
 * The external tool surface grew to ~67 listed tools named after resources and
 * CRUD verbs (`manage_task`, `manage_leads`, `manage_gtm_plan`, `list_*`). Two
 * costs fall out of that:
 *
 *   1. Every connected tool's schema loads into the model's context each turn.
 *      Selection accuracy collapses across dozens of near-identical options.
 *   2. Claude's connector directory cold-starts its ranking on tool names and
 *      descriptions, so the metadata IS the discovery signal.
 *
 * Anthropic's guidance: "Instead of implementing list_users, list_events, and
 * create_event tools, consider implementing a schedule_event tool which finds
 * availability and schedules an event" — build a few tools targeting specific
 * high-impact workflows.
 *
 * Design rules these all follow:
 *   - `emma_` prefix, so a caller with several MCP servers connected can tell
 *     whose tool this is at a glance.
 *   - verb + object, named for the OUTCOME. Nothing is `manage_*`, and nothing
 *     takes an `action:` enum — a model should not have to read a schema to
 *     discover that a verb exists.
 *   - descriptions say when NOT to use the tool, because selection errors are
 *     what actually break agent flows.
 *   - every call goes through the JWT-authed REST layer via `mcpFetch`, exactly
 *     as apiTools.ts does. No direct service calls, so the IDOR boundary and
 *     ENG-973's quota gate both still apply.
 *
 * Additive only: this file registers new tools and removes nothing. Unlisting
 * the granular catalogue behind tool search is ENG-983.
 */

import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';

/**
 * Read one optional profile section.
 *
 * A 404 means the account has not configured it — a real, reportable answer.
 * Anything else (401, 429, 5xx, network) is an operational failure and must NOT
 * be flattened into "not configured": an agent told the brand is empty will
 * cheerfully invent one. `mcpFetch` puts the HTTP status in its error message.
 */
async function section(name: string, path: string, identity: any) {
  try {
    return { name, data: await mcpFetch({ method: 'GET', path, context: identity }), error: undefined as string | undefined };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    if (/\(404\)/.test(message)) return { name, data: null, error: undefined };
    return { name, data: null, error: message };
  }
}

// ─── 1. Delegate a goal to Emma ─────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_run_marketing_task',
  requiresUserAccount: true,
  definition: {
    name: 'emma_run_marketing_task',
    description:
      'Give Emma a marketing goal in plain language and she plans and executes it end to end — campaigns, content, research, outreach. ' +
      'Use this when none of the more specific emma_* tools fits the request. ' +
      'Starts a new task unless you pass task_id to continue an existing one. ' +
      'Returns a task_id; poll emma_get_task_result for the outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'What you want Emma to achieve, in plain language.',
        },
        task_id: {
          type: 'string',
          description: 'Continue an existing task instead of starting a new one. Omit to start fresh.',
        },
      },
      required: ['goal'],
    },
  },
  execute: async (args: any, context: any) => {
    // One tool call, not two: create the session only when the caller has not
    // already got one. Previously this was emma_create_session followed by
    // emma_send_message, and an agent had to know to chain them.
    let taskId = args?.task_id;
    if (!taskId) {
      const session: any = await mcpFetch({
        method: 'POST',
        path: '/api/agent-mode/sessions',
        context: ctx(context),
        body: {},
      });
      taskId = session?.sessionId ?? session?.session_id ?? session?.id;
    }

    const data: any = await mcpFetch({
      method: 'POST',
      path: '/api/agent-mode/generate',
      context: ctx(context),
      // The endpoint's field is `userMessage`, not `message` — see
      // agentModeController. emma_send_message maps its own `message` argument
      // onto `userMessage` for exactly this reason.
      body: { sessionId: taskId, userMessage: args?.goal },
    });

    return jsonResult({
      task_id: taskId,
      status: 'running',
      reply: data?.message ?? data?.response ?? data,
      next: 'Poll emma_get_task_result with this task_id for the finished output.',
    });
  },
});

// ─── 2. Collect the result ──────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_get_task_result',
  requiresUserAccount: true,
  definition: {
    name: 'emma_get_task_result',
    description:
      'Check whether an Emma task has finished and get its output. ' +
      'Use with the task_id returned by emma_run_marketing_task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task_id from emma_run_marketing_task.' },
      },
      required: ['task_id'],
    },
  },
  execute: async (args: any, context: any) => {
    const data: any = await mcpFetch({
      method: 'GET',
      path: `/api/agent-mode/session/${args?.task_id}`,
      context: ctx(context),
    });

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const last = messages.length ? messages[messages.length - 1] : undefined;

    // A ChatSession has NO top-level `status` field, so reading one would report
    // "unknown" forever. Derive it from what the session actually carries:
    //   - a pendingUserQuestion means Emma is blocked on the caller
    //   - otherwise the last speaker tells us whether she has replied yet
    const pending = data?.pendingUserQuestion;
    const status = pending ? 'awaiting_input' : last?.role === 'assistant' ? 'idle' : 'running';

    return jsonResult({
      task_id: args?.task_id,
      status,
      latest_output: last?.content ?? null,
      message_count: messages.length,
      // Surfaced deliberately: a blocking question answered with a plain message
      // is abandoned rather than answered, so the caller needs to see it.
      awaiting_question: pending ?? null,
      next: pending
        ? 'Emma is waiting on an answer. Use emma_answer_question — a plain message abandons the question.'
        : undefined,
    });
  },
});

// ─── 3. Live web research ───────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_research',
  requiresUserAccount: true,
  definition: {
    name: 'emma_research',
    description:
      'Research a topic, company, or market using live web search, and get sourced findings back. ' +
      'Set recency to "news" for today/latest/breaking questions; leave it off for general research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to research.' },
        recency: {
          type: 'string',
          enum: ['general', 'news'],
          description: 'Use "news" only for current-events questions. Defaults to "general".',
        },
      },
      required: ['query'],
    },
  },
  execute: async (args: any, context: any) => {
    const path = args?.recency === 'news' ? '/api/emma/you-search-news' : '/api/emma/you-search-web';
    const data = await mcpFetch({
      method: 'POST',
      path,
      context: ctx(context),
      body: { query: args?.query },
    });
    return jsonResult({ query: args?.query, recency: args?.recency ?? 'general', findings: data });
  },
});

// ─── 4. Account status ──────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_get_account_status',
  requiresUserAccount: true,
  definition: {
    name: 'emma_get_account_status',
    description:
      "Get this account's plan, usage, and remaining quota. " +
      'Call this when a tool returns a quota error, to see how much allowance is left.',
    inputSchema: { type: 'object', properties: {} },
  },
  execute: async (_args: any, context: any) => {
    const me: any = await mcpFetch({ method: 'GET', path: '/api/auth/me', context: ctx(context) });
    return jsonResult({
      email: me?.email,
      plan: me?.subscriptionType ?? me?.plan ?? null,
      is_onboarded: me?.hasBrandGuidelines ?? null,
      usage: me?.tokenUsage ?? null,
    });
  },
});

// ─── 5. What Emma knows about this company ──────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_get_brand_profile',
  requiresUserAccount: true,
  definition: {
    name: 'emma_get_brand_profile',
    description:
      'Read what Emma knows about this company: brand guidelines, market strategy, and the knowledge-base files. ' +
      'Call this FIRST when you need context about the business before writing copy, planning, or generating anything.',
    inputSchema: { type: 'object', properties: {} },
  },
  execute: async (_args: any, context: any) => {
    // Three calls collapsed into one. An agent previously had to know that
    // brand, market strategy and the knowledge base were separate tools, and
    // that it wanted all three.
    const identity = ctx(context);
    const [brand, strategy, knowledge] = await Promise.all([
      section('brand_guidelines', '/api/brand/guidelines', identity),
      section('market_strategy', '/api/market-strategy', identity),
      section('knowledge_base_files', '/api/emma/knowledge-bases', identity),
    ]);

    const failures = [brand, strategy, knowledge].filter(s => s.error).map(s => `${s.name}: ${s.error}`);

    return jsonResult({
      brand_guidelines: brand.data,
      market_strategy: strategy.data,
      knowledge_base_files: knowledge.data,
      // "Not configured" and "we could not reach the service" are different
      // facts. Collapsing both to null tells the agent this company has no
      // brand, and it will then invent one.
      unavailable: failures.length ? failures : undefined,
      note: failures.length
        ? 'Some sections could not be read — treat those as UNKNOWN, not as unconfigured. Do not generate content that assumes they are empty.'
        : 'A null section is genuinely not configured on this account yet.',
    });
  },
});

// ─── 6. Build a targeted lead list ──────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_find_leads',
  requiresUserAccount: true,
  definition: {
    name: 'emma_find_leads',
    description:
      'Find leads matching an ideal-customer description and return them with the list they belong to. ' +
      'Use filters for structured criteria (title, industry, company size); use description for a plain-language ICP.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Plain-language description of the ideal customer.' },
        filters: { type: 'object', description: 'Structured filters, when you already know the exact criteria.' },
        limit: { type: 'number', description: 'Maximum leads to return. Defaults to 50.' },
      },
    },
  },
  execute: async (args: any, context: any) => {
    const data: any = await mcpFetch({
      method: 'POST',
      path: '/api/emma/search-leads',
      context: ctx(context),
      body: { query: args?.description, filters: args?.filters, limit: args?.limit ?? 50 },
    });

    const leads = data?.leads ?? data?.results ?? data;
    return jsonResult({
      matched: Array.isArray(leads) ? leads.length : undefined,
      leads,
      list_id: data?.listId ?? data?.list_id ?? null,
    });
  },
});

/** Names registered by this layer — exported so tests can assert the set. */
export const WORKFLOW_TOOL_NAMES = [
  'emma_run_marketing_task',
  'emma_get_task_result',
  'emma_research',
  'emma_get_account_status',
  'emma_get_brand_profile',
  'emma_find_leads',
] as const;
