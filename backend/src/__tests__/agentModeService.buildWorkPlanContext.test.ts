import { AgentModeService } from '../services/agentModeService';

// Mock heavy/external dependencies so the module loads in isolation.
jest.mock('aws-sdk');
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  taskTemplateDb: { listTemplates: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService.buildWorkPlanContextMessages', () => {
  const activeWorkPlan = {
    title: 'Client Onboarding',
    steps: [
      {
        stepCount: 1,
        title: 'Analyze website',
        description: 'Gather business information',
        status: 'completed' as const,
        completedAt: '2025-01-15T10:00:00.000Z',
      },
      {
        stepCount: 2,
        title: 'Update brand guidelines',
        status: 'pending' as const,
        requiredFunctionCalls: ['update_brand_guidelines'],
        skillIds: ['brand-skill'],
      },
      {
        stepCount: 3,
        title: 'Create marketing strategy',
        status: 'pending' as const,
      },
    ],
    createdAt: '2025-01-15T09:00:00.000Z',
    updatedAt: '2025-01-15T10:00:00.000Z',
  };

  it('returns an empty array when no work plan is provided', () => {
    expect(AgentModeService.buildWorkPlanContextMessages(undefined)).toEqual([]);
    expect(AgentModeService.buildWorkPlanContextMessages(null)).toEqual([]);
  });

  it('returns an empty array when the work plan has no steps', () => {
    expect(
      AgentModeService.buildWorkPlanContextMessages({ title: 'Empty', steps: [] })
    ).toEqual([]);
  });

  it('returns an empty array when steps is not an array', () => {
    expect(
      AgentModeService.buildWorkPlanContextMessages({ title: 'Bad', steps: undefined })
    ).toEqual([]);
  });

  it('renders an active plan as a single assistant message listing every step', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    const content: string = messages[0].content;

    // Header and continuation guidance
    expect(content).toContain('A WORK PLAN ALREADY EXISTS');
    expect(content).toContain('Client Onboarding');
    expect(content).toContain('DO NOT create a new work plan');

    // Each step rendered with the correct status icon
    expect(content).toContain('1. ✓ Analyze website (completed)');
    expect(content).toContain('2. ○ Update brand guidelines (pending)');
    expect(content).toContain('3. ○ Create marketing strategy (pending)');

    // Optional per-step details
    expect(content).toContain('Description: Gather business information');
    expect(content).toContain('Required Functions: update_brand_guidelines');
    expect(content).toContain('Skills (auto-installed when this step becomes active): brand-skill');

    // Not in autocomplete mode -> no autocomplete instruction
    expect(content).not.toContain('AUTOCOMPLETE MODE');
  });

  it('includes the autocomplete instruction when autocomplete is enabled', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages({
      ...activeWorkPlan,
      autocomplete: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('AUTOCOMPLETE MODE');
  });

  it('autocomplete mode never tells the agent to pause/ask, and omits the interactive complete-guard (no-stall for unattended onboarding)', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages({
      ...activeWorkPlan,
      autocomplete: true,
    });
    const content: string = messages[0].content;
    // Hands-off language: never pause for approval, proceed with defaults instead of blocking
    expect(content).toMatch(/do NOT pause to ask the user to approve or confirm/i);
    expect(content).toMatch(/reasonable defaults rather than blocking/i);
    expect(content).toContain('set_work_plan_status');
    // The interactive "don't complete until finished/approved" guard would be a stall
    // trigger here, so it must NOT appear in autocomplete mode.
    expect(content).not.toMatch(/Do NOT mark a step completed before its work is actually finished/i);
    expect(content).not.toContain('STEP COMPLETION');
  });

  it('includes step-progression and batched-intent guidance for active plans', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan);
    const content: string = messages[0].content;

    // Tells the model to advance steps explicitly instead of stalling
    expect(content).toContain('set_work_plan_status');
    expect(content).toContain('STEP PROGRESSION');
    // Tells the model how to handle a single message that stacks multiple intents
    expect(content).toMatch(/multiple instructions|bundles|stacked/i);
  });

  it('guards against marking a step completed before its work is done or approved', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan);
    const content: string = messages[0].content;
    expect(content).toMatch(/Do NOT mark a step completed before its work is actually finished/i);
    expect(content).toMatch(/before the user approves/i);
  });

  it('includes progression and multi-intent guidance for agent mode (default includeResumeGuidance)', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan);
    const content: string = messages[0].content;
    expect(content).toContain('STEP PROGRESSION');
    expect(content).toContain('HANDLING MESSAGES WITH MULTIPLE INSTRUCTIONS');
  });

  it('allows regeneration in the asset block when the user explicitly asks', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan, ['a.png']);
    const content: string = messages[0].content;
    // Carve-out: the no-regenerate guard yields to an explicit user request
    expect(content).toMatch(/UNLESS the user explicitly asks to regenerate/i);
  });

  describe('Emma production-parity (includeResumeGuidance=false)', () => {
    it('emits the plan + steps but NONE of the image-resume hardening blocks', () => {
      // Pass filenames too, to prove the asset block is gated off (not just absent for lack of input)
      const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan, ['a.png', 'b.png'], false);
      const content: string = messages[0].content;
      // Still shows the plan and its steps (unchanged from production)
      expect(content).toContain('A WORK PLAN ALREADY EXISTS');
      expect(content).toContain('Client Onboarding');
      expect(content).toContain('2. ○ Update brand guidelines (pending)');
      // None of the agent-mode hardening leaks into Emma's context
      expect(content).not.toContain('STEP PROGRESSION');
      expect(content).not.toContain('HANDLING MESSAGES WITH MULTIPLE INSTRUCTIONS');
      expect(content).not.toContain('STEP COMPLETION');
      expect(content).not.toContain('ALREADY-GENERATED ASSETS');
      expect(content).not.toContain('a.png');
    });

    it('uses the ORIGINAL autocomplete wording (no drift from production)', () => {
      const messages = AgentModeService.buildWorkPlanContextMessages(
        { ...activeWorkPlan, autocomplete: true }, undefined, false,
      );
      const content: string = messages[0].content;
      expect(content).toContain('After performing the work of a step, DO NOT ask the user whether you should complete the step. Simply call set_work_plan_status to complete the step.');
      // Not the new agent-mode hands-off wording
      expect(content).not.toMatch(/do NOT pause to ask the user to approve or confirm/i);
    });
  });

  it('lists already-generated asset filenames and instructs not to regenerate them', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan, [
      'xcures_h1_typographic.png',
      'xcures_h1_dataclarity.png',
    ]);
    const content: string = messages[0].content;

    expect(content).toContain('xcures_h1_typographic.png');
    expect(content).toContain('xcures_h1_dataclarity.png');
    expect(content).toMatch(/already.*exist|DO NOT regenerate|already been generated/i);
    // Only generate what is still missing
    expect(content).toMatch(/missing|remaining|still need/i);
  });

  it('does not add an asset section when no generated filenames are provided', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan);
    const content: string = messages[0].content;
    expect(content).not.toContain('ALREADY-GENERATED ASSETS');
  });

  it('does not add an asset section when an empty filename list is provided', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan, []);
    const content: string = messages[0].content;
    expect(content).not.toContain('ALREADY-GENERATED ASSETS');
  });

  it('ignores generated filenames once all steps are done (no regenerate section)', () => {
    const doneWorkPlan = {
      title: 'Finished Plan',
      steps: [
        { stepCount: 1, title: 'Step one', status: 'completed' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };
    const messages = AgentModeService.buildWorkPlanContextMessages(doneWorkPlan, ['a.png']);
    const content: string = messages[0].content;
    // Done branch keeps its existing "do not redo" messaging and ignores the list
    expect(content).toContain('ALL 1 STEPS ARE DONE');
    expect(content).not.toContain('ALREADY-GENERATED ASSETS');
  });

  describe('extractGeneratedImageFilenames', () => {
    it('returns an empty array for non-array / empty input', () => {
      expect(AgentModeService.extractGeneratedImageFilenames(undefined)).toEqual([]);
      expect(AgentModeService.extractGeneratedImageFilenames(null as any)).toEqual([]);
      expect(AgentModeService.extractGeneratedImageFilenames([])).toEqual([]);
    });

    it('extracts filenames from "Image generated:" system messages', () => {
      const history = [
        { role: 'user', content: 'go' },
        { role: 'system', content: 'Image generated: a.png' },
        { role: 'assistant', content: 'done' },
        { role: 'system', content: 'Image generated: b.png' },
      ];
      expect(AgentModeService.extractGeneratedImageFilenames(history)).toEqual(['a.png', 'b.png']);
    });

    it('de-duplicates repeated filenames preserving first-seen order', () => {
      const history = [
        { role: 'system', content: 'Image generated: a.png' },
        { role: 'system', content: 'Image generated: b.png' },
        { role: 'system', content: 'Image generated: a.png' },
      ];
      expect(AgentModeService.extractGeneratedImageFilenames(history)).toEqual(['a.png', 'b.png']);
    });

    it('ignores non-system messages and unrelated system messages', () => {
      const history = [
        { role: 'assistant', content: 'Image generated: not_this.png' },
        { role: 'system', content: 'Something else happened' },
        { role: 'system', content: 'Image generated: real.png' },
        { role: 'user', content: 'Image generated: also_not.png' },
      ];
      expect(AgentModeService.extractGeneratedImageFilenames(history)).toEqual(['real.png']);
    });

    it('tolerates malformed entries (missing content / wrong types)', () => {
      const history = [
        null,
        {},
        { role: 'system' },
        { role: 'system', content: 123 },
        { role: 'system', content: 'Image generated:   ' },
        { role: 'system', content: 'Image generated: ok.png' },
      ];
      expect(AgentModeService.extractGeneratedImageFilenames(history as any)).toEqual(['ok.png']);
    });

    it('extracts filenames from the structured metadata marker', () => {
      const history = [
        { role: 'system', content: 'Image generated: a.png', metadata: { kind: 'image-generated', imageFilename: 'a.png' } },
        { role: 'system', content: 'unrelated', metadata: { kind: 'image-generated', imageFilename: 'b.png' } },
      ];
      // Second entry has a non-matching content string but a valid marker -> still detected
      expect(AgentModeService.extractGeneratedImageFilenames(history as any)).toEqual(['a.png', 'b.png']);
    });

    it('de-duplicates across the marker and the legacy string form', () => {
      const history = [
        { role: 'system', content: 'Image generated: a.png' },
        { role: 'system', content: 'Image generated: a.png', metadata: { kind: 'image-generated', imageFilename: 'a.png' } },
      ];
      expect(AgentModeService.extractGeneratedImageFilenames(history as any)).toEqual(['a.png']);
    });
  });

  it('renders a fully completed/skipped plan as a single user [SYSTEM] message without step details', () => {
    const doneWorkPlan = {
      title: 'Finished Plan',
      steps: [
        { stepCount: 1, title: 'Step one', status: 'completed' as const },
        { stepCount: 2, title: 'Step two', status: 'skipped' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    const messages = AgentModeService.buildWorkPlanContextMessages(doneWorkPlan);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const content: string = messages[0].content;
    expect(content).toContain('[SYSTEM]');
    expect(content).toContain('ALL 2 STEPS ARE DONE (1 completed, 1 skipped)');
    expect(content).toContain('DO NOT retry or re-execute');
    // Should not enumerate individual step lines in the done case
    expect(content).not.toContain('1. ✓ Step one');
  });

  describe('done-branch missing-asset carve-out', () => {
    const doneWorkPlan = {
      title: 'Lilly - LinkedIn Ads Campaign generator',
      steps: [
        { stepCount: 1, title: 'Analyze hooks', status: 'completed' as const },
        { stepCount: 2, title: 'Generate 3 Images Per Hook - 18 total', status: 'completed' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    it('permits generate_image for explicitly-requested missing assets in agent mode', () => {
      const messages = AgentModeService.buildWorkPlanContextMessages(doneWorkPlan);
      const content: string = messages[0].content;
      // Still emits the all-done banner and base "do not redo" guard...
      expect(content).toContain('ALL 2 STEPS ARE DONE');
      expect(content).toContain('DO NOT call generate_image or other tools to redo completed work');
      // ...but now carves out an explicit user request to generate missing assets.
      expect(content).toContain('EXCEPTION');
      expect(content).toMatch(/missing/i);
      expect(content).toContain('search_user_assets');
      // The carve-out must explicitly re-authorize generate_image despite the done state.
      expect(content).toMatch(/explicitly ask[^.]*generate/i);
    });

    it('does NOT add the carve-out on the Emma path (includeResumeGuidance=false)', () => {
      const messages = AgentModeService.buildWorkPlanContextMessages(doneWorkPlan, undefined, false);
      const content: string = messages[0].content;
      // Emma's done-branch output stays byte-for-byte as production: banner + base guard,
      // no carve-out, no search_user_assets mention.
      expect(content).toContain('ALL 2 STEPS ARE DONE');
      expect(content).toContain('DO NOT call generate_image or other tools to redo completed work');
      expect(content).not.toContain('EXCEPTION');
      expect(content).not.toContain('search_user_assets');
    });
  });
});
