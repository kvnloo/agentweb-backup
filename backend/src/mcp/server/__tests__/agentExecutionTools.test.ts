/**
 * ENG-2948 — agent-execution tool classification stays in sync with the real
 * main MCP registry, and deterministic emma_* tools are not misclassified.
 */
jest.mock('../httpClient', () => ({
  mcpFetch: jest.fn().mockResolvedValue({ success: true }),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-jwt'),
  clearUserCache: jest.fn(),
}));

import { mcpToolRegistry } from '../registry';
import '../apiTools';
import '../workflowTools';
import {
  AGENT_EXECUTION_TOOLS,
  DETERMINISTIC_TOOLS,
  filterDeterministicTools,
  isAgentExecutionTool,
} from '../agentExecutionTools';

const DETERMINISTIC = [
  'list_lead_lists',
  'edit_landing_page_file',
  'get_account_status',
  'emma_get_brand_profile',
];

describe('ENG-2948 agent-execution tool classification', () => {
  it.each(AGENT_EXECUTION_TOOLS)('%s is registered in the main MCP registry', (name) => {
    expect(mcpToolRegistry.getTool(name)).toBeDefined();
  });

  it.each(DETERMINISTIC)('%s is registered and not classified as agent execution', (name) => {
    expect(mcpToolRegistry.getTool(name)).toBeDefined();
    expect(isAgentExecutionTool(name)).toBe(false);
  });

  it('filterDeterministicTools removes only agent-execution tools, preserving order', () => {
    const input = ['get_account_status', 'emma_send_message', 'list_lead_lists', 'execute_task'];
    expect(filterDeterministicTools(input)).toEqual(['get_account_status', 'list_lead_lists']);
    expect(input).toHaveLength(4);
  });

  it('filtering the full registry leaves no agent-execution tool', () => {
    const remaining = filterDeterministicTools(mcpToolRegistry.getToolNames());
    expect(remaining.some(isAgentExecutionTool)).toBe(false);
    expect(remaining).toEqual(expect.arrayContaining(DETERMINISTIC));
  });
});

describe('ENG-2969 registry drift guard', () => {
  // Load every module mcpServerCore loads so the registry matches production.
  beforeAll(async () => {
    await import('../mcpServerCore');
  });

  it('every registered main-MCP tool is classified exactly once', () => {
    const registered = mcpToolRegistry.getToolNames();
    const execution = new Set(AGENT_EXECUTION_TOOLS);
    const deterministic = new Set(DETERMINISTIC_TOOLS);
    const unclassified = registered.filter((n) => !execution.has(n) && !deterministic.has(n));
    const both = registered.filter((n) => execution.has(n) && deterministic.has(n));
    const hint =
      'classify it in backend/src/mcp/server/agentExecutionTools.ts ' +
      '(AGENT_EXECUTION_TOOLS if it can start/resume/delegate an Emma agent run, else DETERMINISTIC_TOOLS)';
    if (unclassified.length) throw new Error(`Unclassified MCP tool(s): ${unclassified.join(', ')} — ${hint}`);
    if (both.length) throw new Error(`MCP tool(s) in both classifications: ${both.join(', ')} — ${hint}`);
    expect(execution.size + deterministic.size).toBe(registered.length);
  });

  it('classification lists contain no stale (unregistered) or duplicate names', () => {
    const all = [...AGENT_EXECUTION_TOOLS, ...DETERMINISTIC_TOOLS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((n) => !mcpToolRegistry.getTool(n))).toEqual([]);
  });
});
