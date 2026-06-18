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

  it('includes step-progression and batched-intent guidance for active plans', () => {
    const messages = AgentModeService.buildWorkPlanContextMessages(activeWorkPlan);
    const content: string = messages[0].content;

    // Tells the model to advance steps explicitly instead of stalling
    expect(content).toContain('set_work_plan_status');
    expect(content).toContain('STEP PROGRESSION');
    // Tells the model how to handle a single message that stacks multiple intents
    expect(content).toMatch(/multiple instructions|bundles|stacked/i);
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
});
