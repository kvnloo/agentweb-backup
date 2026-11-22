/**
 * Progressive disclosure for the external MCP surface (ENG-983, ENG-463 child 2).
 *
 * `tools/list` used to return every non-internal tool (~70 schemas loaded into
 * the caller's context every turn). It now returns only the job-shaped workflow
 * layer (ENG-982/ENG-1004), the core Emma session tools, and one discovery tool,
 * `emma_search_tools`. The granular catalogue is still registered and still
 * callable by name — it is just found on demand instead of preloaded.
 *
 * This is NOT authorization. `registry.execute()` still runs any named tool,
 * and internal/internalOnly semantics are unchanged (ENG-974). Discovery only
 * ever returns tools that `getToolDefinitions()` already exposes externally.
 */

import { mcpToolRegistry } from './registry';
import { jsonResult } from './toolHelpers';
import { WORKFLOW_TOOL_NAMES } from './workflowTools';
import { LANDING_WORKFLOW_TOOL_NAMES } from './landingWorkflowTools';
import { PUBLISH_WORKFLOW_TOOL_NAMES } from './publishWorkflowTools';

export const SEARCH_TOOL_NAME = 'emma_search_tools';

/** Core conversational surface — talking to Emma herself. */
const SESSION_TOOL_NAMES = [
  'emma_create_session',
  'emma_send_message',
  'emma_get_session',
  'emma_answer_question_deck',
  'emma_launch_work_plan',
  'emma_answer_work_plan_input',
] as const;

/** Resolved lazily so a module mock of either workflow file cannot crash import. */
export function listedToolNames(): string[] {
  return [
    ...(WORKFLOW_TOOL_NAMES ?? []),
    ...(LANDING_WORKFLOW_TOOL_NAMES ?? []),
    ...(PUBLISH_WORKFLOW_TOOL_NAMES ?? []),
    ...SESSION_TOOL_NAMES,
    SEARCH_TOOL_NAME,
  ];
}

/** What an external client sees in `tools/list`. */
export function getListedToolDefinitions(): any[] {
  const listed = new Set(listedToolNames());
  return mcpToolRegistry.getToolDefinitions().filter((d: any) => listed.has(d.name));
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);
}

/**
 * Rank externally visible, unlisted tools against a free-text query.
 * Name-token hits weigh more than description hits; ties keep registry order.
 */
export function searchTools(query: string, limit = 8): any[] {
  const q = tokens(query);
  if (q.length === 0) return [];
  const listed = new Set(listedToolNames());
  const scored = mcpToolRegistry
    .getToolDefinitions()
    .filter((d: any) => !listed.has(d.name))
    .map((d: any, i: number) => {
      const name = tokens(String(d.name).replace(/_/g, ' '));
      const desc = new Set(tokens(String(d.description ?? '')));
      let score = 0;
      for (const t of q) {
        if (name.some(n => n === t || n.startsWith(t) || t.startsWith(n))) score += 3;
        if (desc.has(t)) score += 1;
      }
      return { d, i, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, Math.max(1, Math.min(limit, 20))).map(x => x.d);
}

mcpToolRegistry.register({
  name: SEARCH_TOOL_NAME,
  readOnly: true,
  definition: {
    name: SEARCH_TOOL_NAME,
    description:
      'Find more Emma tools by keyword when none of the listed tools fits the job. ' +
      'Returns matching tool names with full input schemas; call a returned tool by its exact name. ' +
      'Use the listed emma_* workflow tools first — only search for specialised operations ' +
      '(e.g. "google ads keywords", "crm sequence", "linkedin post", "lead list").',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the capability you need.' },
        limit: { type: 'number', description: 'Max tools to return (default 8, max 20).' },
      },
      required: ['query'],
    },
  },
  execute: async (args: any) => {
    const tools = searchTools(String(args?.query ?? ''), Number(args?.limit) || 8);
    return jsonResult({
      query: args?.query,
      count: tools.length,
      tools: tools.map((d: any) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })),
      hint: tools.length
        ? 'Call any of these by exact name with arguments matching inputSchema.'
        : 'No match. Try broader keywords, or use emma_run_marketing_task to delegate the goal to Emma.',
    });
  },
});
