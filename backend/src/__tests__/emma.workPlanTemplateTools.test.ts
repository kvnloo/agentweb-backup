/**
 * Tests for the launch_predefined_work_plan Emma tool, which instantiates a
 * predefined work plan template into the current chat session (the conversational
 * equivalent of Agent Mode's plan picker). It delegates directly to
 * emma/impl/workPlans.ts's applyPredefinedWorkPlan (ENG-2103 F2 extraction —
 * previously agentModeService.applyPredefinedWorkPlan, which still exists as
 * a one-line delegating wrapper but is no longer what emma/tools.ts calls).
 *
 * The companion listing tool, list_predefined_work_plans, lives in
 * mcp/server/apiTools.ts (role-aware) and is covered separately.
 */

// Mock agentModeService before importing tools.ts so the registered handlers bind
// to the mocked singleton. Still needed post-extraction: emma/tools.ts passes
// the agentModeService singleton through as applyPredefinedWorkPlan's 5th
// argument (the WorkPlanModelRegistry it uses to validate a template's
// defaultModel) — not called in these tests, but must exist as an object.
jest.mock('../services/agentModeService', () => ({
  // Static members are referenced by other modules at import time; provide a stub class too.
  AgentModeService: { FOUNDATION_TOOLS: new Set<string>() },
  agentModeService: {
    getSupportedModels: jest.fn(),
  },
}));

// ENG-2103 (F2): applyPredefinedWorkPlan's handler body now lives in
// emma/impl/workPlans.ts and emma/tools.ts calls it directly instead of
// through agentModeService — mock it here (a plain object, not a Proxy, so
// `import * as workPlansImpl` in emma/tools.ts doesn't get flattened to an
// empty object by TS's esModuleInterop wildcard-import helper — same fix
// blog.ts's extraction needed for emmaTools.publishRevalidationForwarding.test.ts).
jest.mock('../emma/impl/workPlans', () => ({
  applyPredefinedWorkPlan: jest.fn(),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as workPlansImpl from '../emma/impl/workPlans';

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

  it('delegates to applyPredefinedWorkPlan with session, user, and default force=false, confirmedDeclinedPlan=false', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error('tool not found');

    (workPlansImpl.applyPredefinedWorkPlan as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute({ planTitle: 'Client Onboarding' }, { userId: 'user-1', sessionId: 'sess-1' });

    expect(workPlansImpl.applyPredefinedWorkPlan).toHaveBeenCalledWith(
      'Client Onboarding', 'sess-1', 'user-1', { force: false, confirmedDeclinedPlan: false, isUnattendedRun: undefined },
      expect.anything(),
    );
  });

  it('forwards force=true when provided', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error('tool not found');

    (workPlansImpl.applyPredefinedWorkPlan as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute({ planTitle: 'X', force: true }, { userId: 'user-1', sessionId: 'sess-1' });

    expect(workPlansImpl.applyPredefinedWorkPlan).toHaveBeenCalledWith(
      'X', 'sess-1', 'user-1', { force: true, confirmedDeclinedPlan: false, isUnattendedRun: undefined },
      expect.anything(),
    );
  });

  // ENG-1974: the deterministic decline-gate confirmation flag.
  it('forwards confirmedDeclinedPlan=true when provided', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error('tool not found');

    (workPlansImpl.applyPredefinedWorkPlan as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute({ planTitle: 'X', confirmedDeclinedPlan: true }, { userId: 'user-1', sessionId: 'sess-1' });

    expect(workPlansImpl.applyPredefinedWorkPlan).toHaveBeenCalledWith(
      'X', 'sess-1', 'user-1', { force: false, confirmedDeclinedPlan: true, isUnattendedRun: undefined },
      expect.anything(),
    );
  });
});
