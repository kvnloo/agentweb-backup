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
