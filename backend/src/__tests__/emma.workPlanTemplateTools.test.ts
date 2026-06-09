/**
 * Tests for the launch_predefined_work_plan Emma tool, which instantiates a
 * predefined work plan template into the current chat session (the conversational
 * equivalent of Agent Mode's plan picker). It delegates to
 * agentModeService.applyPredefinedWorkPlan.
 *
 * The companion listing tool, list_predefined_work_plans, lives in
 * mcp/server/apiTools.ts (role-aware) and is covered separately.
 */

// Mock agentModeService before importing tools.ts so the registered handlers bind
// to the mocked singleton.
jest.mock('../services/agentModeService', () => ({
  // Static members are referenced by other modules at import time; provide a stub class too.
  AgentModeService: { FOUNDATION_TOOLS: new Set<string>() },
  agentModeService: {
    applyPredefinedWorkPlan: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';

// Import tools.ts to ensure tools are registered
import '../emma/tools';

describe('launch_predefined_work_plan Emma tool', () => {
  const toolName = 'launch_predefined_work_plan';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered and requires a planTitle', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
    expect((tool?.definition.inputSchema as any)?.required).toContain('planTitle');
  });

  it('delegates to applyPredefinedWorkPlan with session, user, and default force=false', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error('tool not found');

    (agentModeService.applyPredefinedWorkPlan as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute({ planTitle: 'Client Onboarding' }, { userId: 'user-1', sessionId: 'sess-1' });

    expect(agentModeService.applyPredefinedWorkPlan).toHaveBeenCalledWith(
      'Client Onboarding', 'sess-1', 'user-1', { force: false }
    );
  });

  it('forwards force=true when provided', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error('tool not found');

    (agentModeService.applyPredefinedWorkPlan as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute({ planTitle: 'X', force: true }, { userId: 'user-1', sessionId: 'sess-1' });

    expect(agentModeService.applyPredefinedWorkPlan).toHaveBeenCalledWith(
      'X', 'sess-1', 'user-1', { force: true }
    );
  });
});
