import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  taskTemplateDb: {
    listTemplates: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('aws-sdk');

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - Work Plan', () => {
  let agentModeService: AgentModeService;
  const mockSessionId = 'test-session-123';
  const mockUserId = 'user-456';

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('createWorkPlan', () => {
    it('should create a new work plan with valid steps', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T09:00:00.000Z',
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue({
        ...mockSession,
        workPlan: {
          title: 'Client Onboarding',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' },
            { stepCount: 2, title: 'Step 2', status: 'pending' },
          ],
        },
      });

      const result = await (agentModeService as any).createWorkPlan(
        'Client Onboarding',
        [
          { stepCount: 1, title: 'Step 1' },
          { stepCount: 2, title: 'Step 2' },
        ],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Work plan "Client Onboarding" created with 2 steps');
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          title: 'Client Onboarding',
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              title: 'Step 1',
              status: 'pending',
            }),
            expect.objectContaining({
              stepCount: 2,
              title: 'Step 2',
              status: 'pending',
            }),
          ]),
        })
      );
    });

    it('should create work plan with step descriptions', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).createWorkPlan(
        'Project Plan',
        [
          {
            stepCount: 1,
            title: 'Research',
            description: 'Conduct market research',
          },
          {
            stepCount: 2,
            title: 'Development',
            description: 'Build the solution',
          },
        ],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              title: 'Research',
              description: 'Conduct market research',
              status: 'pending',
            }),
          ]),
        })
      );
    });

    it('should overwrite existing work plan when creating new one', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: {
          title: 'Existing Plan',
          steps: [{ stepCount: 1, title: 'Step 1', status: 'pending' as const }],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T09:00:00.000Z',
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue({
        ...mockSession,
        workPlan: {
          title: 'New Plan',
          steps: [{ stepCount: 1, title: 'New Step', status: 'pending' as const }],
        },
      });

      const result = await (agentModeService as any).createWorkPlan(
        'New Plan',
        [{ stepCount: 1, title: 'New Step' }],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Work plan "New Plan" created');
    });

    it('ENG-1698: resets calledFunctions so a new plan does not inherit stale tool-call credit', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        // Leftover credit from a completely unrelated earlier plan in this session.
        calledFunctions: { generate_image: 5 },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).createWorkPlan(
        'Fresh Plan',
        [{ stepCount: 1, title: 'Step 1' }],
        mockSessionId
      );

      expect(chatbotDb.updateCalledFunctions).toHaveBeenCalledWith(mockSessionId, {});
    });
  });

  describe('modifyWorkPlan', () => {
    const existingWorkPlan = {
      title: 'Project Plan',
      steps: [
        { stepCount: 1, title: 'Step 1', status: 'completed' as const },
        { stepCount: 2, title: 'Step 2', status: 'pending' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    it('should add new steps to existing work plan', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(
        [{ stepCount: 3, title: 'Step 3', description: 'New step' }],
        [],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ stepCount: 1, title: 'Step 1' }),
            expect.objectContaining({ stepCount: 2, title: 'Step 2' }),
            expect.objectContaining({
              stepCount: 3,
              title: 'Step 3',
              description: 'New step',
              status: 'pending',
            }),
          ]),
        })
      );
    });

    it('should update existing step details without changing status', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(
        [
          {
            stepCount: 2,
            title: 'Updated Step 2',
            description: 'Updated description',
          },
        ],
        [],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ stepCount: 1, status: 'completed' }), // Unchanged
            expect.objectContaining({
              stepCount: 2,
              title: 'Updated Step 2',
              description: 'Updated description',
              status: 'pending', // Status preserved
            }),
          ]),
        })
      );
    });

    it('should remove steps when removeStepCounts is provided', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(
        [],
        [2],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: [
            expect.objectContaining({ stepCount: 1, title: 'Step 1' }),
            // Step 2 should be removed
          ],
        })
      );
    });

    it('should fail when no work plan exists', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        // No workPlan
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).modifyWorkPlan(
        [{ stepCount: 1, title: 'Step 1' }],
        [],
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No work plan found');
    });
  });

  describe('setWorkPlanStatus', () => {
    const existingWorkPlan = {
      title: 'Project Plan',
      steps: [
        { stepCount: 1, title: 'Step 1', status: 'completed' as const },
        { stepCount: 2, title: 'Step 2', status: 'pending' as const },
        { stepCount: 3, title: 'Step 3', status: 'pending' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    it('should update step status to completed', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 2, status: 'completed', notes: 'Completed successfully' }],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Step 2 status updated to completed');
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 2,
              status: 'completed',
              notes: 'Completed successfully',
              completedAt: expect.any(String),
            }),
          ]),
        })
      );
    });

    it('should update step status to skipped', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 3, status: 'skipped', notes: 'Not needed' }],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 3,
              status: 'skipped',
              notes: 'Not needed',
            }),
          ]),
        })
      );
    });

    it('should update step status without notes', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 2, status: 'completed' }],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 2,
              status: 'completed',
              completedAt: expect.any(String),
            }),
          ]),
        })
      );
    });

    it('should fail when step does not exist', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 99, status: 'completed' }],
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should fail when no work plan exists', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        // No workPlan
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 1, status: 'completed' }],
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No work plan found');
    });

    it('should update multiple steps at once', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [
          { stepCount: 1, status: 'completed', notes: 'First done' },
          { stepCount: 2, status: 'completed', notes: 'Second done' },
        ],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Updated 2 steps');
      expect(result.updatedSteps).toHaveLength(2);
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              status: 'completed',
              notes: 'First done',
            }),
            expect.objectContaining({
              stepCount: 2,
              status: 'completed',
              notes: 'Second done',
            }),
          ]),
        })
      );
    });

    // ENG-1682 (prod session f771b626-…): a step's own pendingWorkPlanInput is only
    // cleared by the structured WorkPlanInputCard submission. A user who answers the
    // step conversationally in chat instead never hits that path, so the stale
    // "awaiting" request stuck around for the rest of the session — permanently
    // hiding the customer portal's Details surface (its default landing view) behind
    // an already-answered card, since that surface treats any 'awaiting' input as
    // still-active. setWorkPlanStatus must clear (or replace) the request the moment
    // its own step resolves, regardless of how the step got answered.
    describe('pendingWorkPlanInput cleanup on step resolution', () => {
      const inputRequestFor = (stepCount: number, title: string) => ({
        title,
        prompt: `Describe ${title}`,
        fields: [{ id: 'value', label: title, type: 'text' as const, required: true }],
      });

      it('clears a stale awaiting input once its own step resolves and no later step needs input', async () => {
        const freshWorkPlan = {
          title: 'Project Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' as const, inputRequest: inputRequestFor(1, 'Target customer') },
            { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T09:00:00.000Z',
        };
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: freshWorkPlan,
          pendingWorkPlanInput: {
            requestId: 'req-step-1',
            stepCount: 1,
            title: 'Target customer',
            prompt: 'Describe Target customer',
            fields: [{ id: 'value', label: 'Target customer', type: 'text' }],
            status: 'awaiting',
            createdAt: '2025-01-15T09:00:00.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed', notes: 'User answered in chat' }],
          mockSessionId,
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlanInputRequest).toHaveBeenCalledWith(
          mockSessionId,
          null,
          { requireStillAwaiting: 'req-step-1' },
        );
      });

      it('clears the stale input as its own guarded step before writing the next step\'s (preserves the pendingUserQuestion guard)', async () => {
        const freshWorkPlan = {
          title: 'Project Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' as const, inputRequest: inputRequestFor(1, 'Target customer') },
            { stepCount: 2, title: 'Step 2', status: 'pending' as const, inputRequest: inputRequestFor(2, 'Target subreddits') },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T09:00:00.000Z',
        };
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: freshWorkPlan,
          pendingWorkPlanInput: {
            requestId: 'req-step-1',
            stepCount: 1,
            title: 'Target customer',
            prompt: 'Describe Target customer',
            fields: [{ id: 'value', label: 'Target customer', type: 'text' }],
            status: 'awaiting',
            createdAt: '2025-01-15T09:00:00.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed', notes: 'User answered in chat' }],
          mockSessionId,
        );

        // Two calls, in order: clear the known-stale record by exact requestId match...
        expect(chatbotDb.updateSessionWorkPlanInputRequest).toHaveBeenNthCalledWith(
          1,
          mockSessionId,
          null,
          { requireStillAwaiting: 'req-step-1' },
        );
        // ...then write the next step's request with the guard fully intact (still
        // checking pendingUserQuestion, not just pendingWorkPlanInput).
        expect(chatbotDb.updateSessionWorkPlanInputRequest).toHaveBeenNthCalledWith(
          2,
          mockSessionId,
          expect.objectContaining({ stepCount: 2, title: 'Target subreddits' }),
          { failIfAwaitingExists: true },
        );
      });

      it('leaves an unrelated still-open awaiting input untouched', async () => {
        const freshWorkPlan = {
          title: 'Project Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' as const },
            { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T09:00:00.000Z',
        };
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: freshWorkPlan,
          // Belongs to step 2, which is NOT being resolved by this call.
          pendingWorkPlanInput: {
            requestId: 'req-step-2',
            stepCount: 2,
            title: 'Something else',
            prompt: 'Describe something else',
            fields: [{ id: 'value', label: 'Something else', type: 'text' }],
            status: 'awaiting',
            createdAt: '2025-01-15T09:00:00.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed', notes: 'Done' }],
          mockSessionId,
        );

        expect(chatbotDb.updateSessionWorkPlanInputRequest).not.toHaveBeenCalled();
      });
    });

    // Asset-count completion gate (xCures incident, prod session 7c8ff5b2-…): a step
    // declaring expectedAssetCount may not be completed until that many media assets
    // have actually been produced this session (counted from "Image generated:" markers).
    describe('expectedAssetCount completion gate', () => {
      // Build a session with an image step needing 18 assets and `produced` images present.
      const makeSession = (produced: number, expectedAssetCount = 18) => {
        const messages: any[] = [];
        for (let i = 0; i < produced; i++) {
          messages.push({ role: 'system', content: `Image generated: hook_${i}.png`, metadata: { kind: 'image-generated', imageFilename: `hook_${i}.png` } });
        }
        return {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages,
          workPlan: {
            title: 'LinkedIn Ads Campaign generator',
            steps: [
              { stepCount: 1, title: 'Generate 3 Images Per Hook - 18 total', status: 'pending' as const, expectedAssetCount },
            ],
            createdAt: '2025-01-15T09:00:00.000Z',
            updatedAt: '2025-01-15T10:00:00.000Z',
          },
        };
      };

      it('BLOCKS completing an image step when fewer assets than expected were produced', async () => {
        const mockSession = makeSession(3, 18);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.insufficientAssets).toEqual([
          expect.objectContaining({ stepCount: 1, expected: 18, produced: 3 }),
        ]);
        expect(result.formattedContent).toContain('3 of 18');
        // Must NOT have persisted a completed status.
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('ALLOWS completing the step once the full asset count is produced', async () => {
        const mockSession = makeSession(18, 18);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      // Regression guard for a hazard that reads like a bug but is not one.
      // The required-call decrement runs before the asset gate has had its say, so
      // it LOOKS like a step rejected for missing assets would burn its tool-call
      // credits. It does not: the decrement lands in a local copy of
      // session.calledFunctions, and the asset-gate failure returns early — well
      // before the updateCalledFunctions persistence below. Raised as a finding on
      // PR #2266 and disproved by this test. If someone later moves that early
      // return, or persists the counts sooner, this test fails and the retry-burns-
      // credits behaviour is caught rather than shipped.
      it('does NOT consume required-call credits when the asset gate rejects the step', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [
            { role: 'system', content: 'Image generated: a.png', metadata: { kind: 'image-generated', imageFilename: 'a.png' } },
          ],
          calledFunctions: { generate_image: 5 },
          workPlan: {
            title: 'Creative Hub',
            steps: [
              {
                stepCount: 1,
                title: 'Generate 4 images',
                status: 'pending' as const,
                requiredFunctionCalls: ['generate_image'],
                expectedAssetCount: 4,
              },
            ],
            createdAt: '2025-01-15T09:00:00.000Z',
            updatedAt: '2025-01-15T10:00:00.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        // The required-call gate passes (5 >= 1) but only 1 of 4 assets exists.
        expect(result.success).toBe(false);
        expect(result.insufficientAssets).toEqual([
          expect.objectContaining({ stepCount: 1, expected: 4, produced: 1 }),
        ]);
        // The step was not completed, so its credits must be untouched.
        expect(chatbotDb.updateCalledFunctions).not.toHaveBeenCalled();
        expect(chatbotDb.decrementCalledFunctionsClamped).not.toHaveBeenCalled();
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('does NOT gate a step that has no expectedAssetCount (zero regression)', async () => {
        // Step with NO expectedAssetCount field at all and zero images produced.
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: {
            title: 'LinkedIn Ads Campaign generator',
            steps: [
              { stepCount: 1, title: 'Generate 3 Images Per Hook - 18 total', status: 'pending' as const },
            ],
            createdAt: '2025-01-15T09:00:00.000Z',
            updatedAt: '2025-01-15T10:00:00.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      it('does NOT gate skipping a short image step (only completion is gated)', async () => {
        const mockSession = makeSession(3, 18);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'skipped' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });
    });

    // ENG-1188 root cause fault #3: the xCures session marked "QA, Contact Sheet
    // & Delivery" (step 4) completed while "Render the Full Size Matrix" (step 3)
    // was still pending -- delivery never actually gated on the rendering it
    // claimed to deliver. Neither the requiredFunctionCalls gate nor the
    // expectedAssetCount gate catches this: both are scoped to the step being
    // completed, not to whether earlier steps in the plan are actually done.
    describe('cross-step ordering completion gate', () => {
      const makeSession = (steps: Array<{ stepCount: number; status: string; completedAt?: string }>) => ({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: {
          title: 'Display Ad Set Production',
          steps: steps.map((s) => ({ ...s, title: `Step ${s.stepCount}` })),
          createdAt: '2026-08-12T14:54:35.000Z',
          updatedAt: '2026-08-12T14:54:35.000Z',
        },
      });

      it('BLOCKS completing a step while an earlier step is still pending', async () => {
        const mockSession = makeSession([
          { stepCount: 1, status: 'completed' },
          { stepCount: 2, status: 'completed' },
          { stepCount: 3, status: 'pending' }, // "Render the Full Size Matrix"
          { stepCount: 4, status: 'pending' }, // "QA, Contact Sheet & Delivery"
        ]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 4, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.outOfOrderSteps).toEqual([
          expect.objectContaining({ stepCount: 4 }),
        ]);
        expect(result.formattedContent).toContain('3');
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('ALLOWS completing a step once every earlier step is completed', async () => {
        const mockSession = makeSession([
          { stepCount: 1, status: 'completed' },
          { stepCount: 2, status: 'completed' },
          { stepCount: 3, status: 'completed' },
          { stepCount: 4, status: 'pending' },
        ]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 4, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      it('ALLOWS completing a step when the earlier step was legitimately skipped', async () => {
        const mockSession = makeSession([
          { stepCount: 1, status: 'completed' },
          { stepCount: 2, status: 'skipped' },
          { stepCount: 3, status: 'pending' },
        ]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      it('does NOT gate step 1 (no earlier steps exist)', async () => {
        const mockSession = makeSession([{ stepCount: 1, status: 'pending' }]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
      });

      it('does NOT gate skipping a step out of order (only completion is gated)', async () => {
        const mockSession = makeSession([
          { stepCount: 1, status: 'pending' },
          { stepCount: 2, status: 'pending' },
        ]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'skipped' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
      });

      it('ALLOWS completing several steps in one batch, in order, chaining against each other', async () => {
        const mockSession = makeSession([
          { stepCount: 1, status: 'pending' },
          { stepCount: 2, status: 'pending' },
          { stepCount: 3, status: 'pending' },
        ]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [
            { stepCount: 1, status: 'completed' },
            { stepCount: 2, status: 'completed' },
            { stepCount: 3, status: 'completed' },
          ],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.updatedSteps).toHaveLength(3);
      });

      it('BLOCKS the WHOLE batch when a step within it is completed out of order, matching the other gates\' all-or-nothing behavior', async () => {
        const mockSession = makeSession([
          { stepCount: 1, status: 'pending' },
          { stepCount: 2, status: 'pending' },
        ]);
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        // Step 2 completed BEFORE step 1 in the same call -- step 1 is still
        // pending at the moment step 2's update is processed. Same all-or-nothing
        // semantics as missingFunctionCalls/insufficientAssets: the assistant can
        // just resend the same updates in the correct order.
        const result = await (agentModeService as any).setWorkPlanStatus(
          [
            { stepCount: 2, status: 'completed' },
            { stepCount: 1, status: 'completed' },
          ],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.outOfOrderSteps).toEqual([
          expect.objectContaining({ stepCount: 2 }),
        ]);
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });
    });

    // ENG-1188: expectedAssetCount was checked against the SESSION-WIDE image
    // count, so a later step could pass on the strength of an earlier step's
    // images without producing any of its own -- the exact gap the ticket's fix
    // recommendation #4 ("block delivery until the required image is actually
    // attached") calls out. Scope the count to images generated after the
    // previous step completed.
    describe('expectedAssetCount is scoped to the step, not the whole session', () => {
      it('does NOT let an earlier step\'s images satisfy a later step\'s own requirement', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [
            // All 18 images were generated during step 1, before it completed.
            ...Array.from({ length: 18 }, (_, i) => ({
              role: 'system',
              content: `Image generated: hook_${i}.png`,
              metadata: { kind: 'image-generated', imageFilename: `hook_${i}.png`, timestamp: '2026-08-12T15:00:00.000Z' },
            })),
          ],
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [
              { stepCount: 1, title: 'Generate hero images', status: 'completed', completedAt: '2026-08-12T15:30:00.000Z' },
              { stepCount: 2, title: 'Render the Full Size Matrix', status: 'pending', expectedAssetCount: 3 },
            ],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T15:30:00.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.insufficientAssets).toEqual([
          expect.objectContaining({ stepCount: 2, expected: 3, produced: 0 }),
        ]);
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('DOES count images the step itself produced after the previous step completed', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [
            { role: 'system', content: 'Image generated: hero_v1.png', metadata: { kind: 'image-generated', imageFilename: 'hero_v1.png', timestamp: '2026-08-12T15:00:00.000Z' } },
            // These three were generated during step 2, after step 1 completed.
            { role: 'system', content: 'Image generated: matrix_1.png', metadata: { kind: 'image-generated', imageFilename: 'matrix_1.png', timestamp: '2026-08-12T15:35:00.000Z' } },
            { role: 'system', content: 'Image generated: matrix_2.png', metadata: { kind: 'image-generated', imageFilename: 'matrix_2.png', timestamp: '2026-08-12T15:36:00.000Z' } },
            { role: 'system', content: 'Image generated: matrix_3.png', metadata: { kind: 'image-generated', imageFilename: 'matrix_3.png', timestamp: '2026-08-12T15:37:00.000Z' } },
          ],
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [
              { stepCount: 1, title: 'Generate hero images', status: 'completed', completedAt: '2026-08-12T15:30:00.000Z' },
              { stepCount: 2, title: 'Render the Full Size Matrix', status: 'pending', expectedAssetCount: 3 },
            ],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T15:30:00.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      it('still counts everything toward step 1 (no earlier step to scope against)', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: Array.from({ length: 3 }, (_, i) => ({
            role: 'system',
            content: `Image generated: hook_${i}.png`,
            metadata: { kind: 'image-generated', imageFilename: `hook_${i}.png`, timestamp: '2026-08-12T15:00:00.000Z' },
          })),
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [
              { stepCount: 1, title: 'Generate hero images', status: 'pending', expectedAssetCount: 3 },
            ],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
      });
    });

    // Greptile (PR #2430, ENG-1188): a "just wrote the image marker, then
    // immediately completed the step" turn can race the default eventually-
    // consistent read -- ENG-510 built consistentRead for exactly this shape
    // (agentModeController.ts already uses it for the analogous timed-out-run
    // read), setWorkPlanStatus just never opted in.
    it('reads the session with consistentRead so a marker written moments earlier is never missed', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: {
          title: 'Plan',
          steps: [{ stepCount: 1, title: 'Step 1', status: 'pending' }],
          createdAt: '2026-08-12T14:54:35.000Z',
          updatedAt: '2026-08-12T14:54:35.000Z',
        },
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 1, status: 'completed' }],
        mockSessionId
      );

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId, true);
    });

    // Greptile (PR #2430, ENG-1188 follow-up): two failure modes in the
    // timestamp-based per-step asset scoping added above.
    describe('asset-count cutoff attribution across a batch (Greptile follow-up)', () => {
      it('scopes correctly against a SKIPPED earlier step instead of falling through to the whole session', async () => {
        // Step 1 is skipped -- no completedAt is ever set for a skip. Before this
        // fix, that meant zero earlier steps had a completedAt, sinceIso fell
        // through to undefined, and step 2's own requirement was checked against
        // the WHOLE session -- these 5 unrelated pre-existing images (generated
        // before step 1 was even skipped, belonging to no step in particular)
        // would have wrongly satisfied it even though step 2 produced nothing.
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: Array.from({ length: 5 }, (_, i) => ({
            role: 'system',
            content: `Image generated: unrelated_${i}.png`,
            metadata: { kind: 'image-generated', imageFilename: `unrelated_${i}.png`, timestamp: '2026-08-12T14:55:00.000Z' },
          })),
          workPlan: {
            title: 'Plan',
            steps: [
              // Starts 'pending', not 'skipped' -- the call below must be a real
              // status transition (ENG-1626's idempotency short-circuit treats a
              // same-status call as a no-op and never reaches updateSessionWorkPlan).
              { stepCount: 1, title: 'Optional intro', status: 'pending' },
              { stepCount: 2, title: 'Generate 3 images', status: 'pending', expectedAssetCount: 3 },
            ],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:56:00.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        // Skip step 1 first (stamping its resolvedAt), then attempt step 2 --
        // mirrors the real sequence: the skip already happened in an earlier
        // turn/call, this call is the (premature) attempt to complete step 2.
        await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'skipped' }],
          mockSessionId
        );
        const skippedWorkPlan = (chatbotDb.updateSessionWorkPlan as jest.Mock).mock.calls[0][1];
        const sessionAfterSkip = { ...mockSession, workPlan: skippedWorkPlan };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionAfterSkip);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.insufficientAssets).toEqual([
          expect.objectContaining({ stepCount: 2, expected: 3, produced: 0 }),
        ]);
      });

      it('does NOT let assets genuinely produced for this step get excluded when earlier steps complete in the SAME batch', async () => {
        // Steps 1 and 2 produced no images of their own. Step 3's 3 images were
        // generated in an EARLIER TURN, before this batch. All three steps are
        // now completed together in one call. A cutoff derived from step 2's
        // freshly-minted (this-instant) completedAt would wrongly post-date --
        // and so exclude -- step 3's already-existing images.
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [
            { role: 'system', content: 'Image generated: matrix_1.png', metadata: { kind: 'image-generated', imageFilename: 'matrix_1.png', timestamp: '2026-08-12T15:00:00.000Z' } },
            { role: 'system', content: 'Image generated: matrix_2.png', metadata: { kind: 'image-generated', imageFilename: 'matrix_2.png', timestamp: '2026-08-12T15:01:00.000Z' } },
            { role: 'system', content: 'Image generated: matrix_3.png', metadata: { kind: 'image-generated', imageFilename: 'matrix_3.png', timestamp: '2026-08-12T15:02:00.000Z' } },
          ],
          workPlan: {
            title: 'Plan',
            steps: [
              { stepCount: 1, title: 'Intake', status: 'pending' },
              { stepCount: 2, title: 'Approval', status: 'pending' },
              { stepCount: 3, title: 'Render the matrix', status: 'pending', expectedAssetCount: 3 },
            ],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [
            { stepCount: 1, status: 'completed' },
            { stepCount: 2, status: 'completed' },
            { stepCount: 3, status: 'completed' },
          ],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.updatedSteps).toHaveLength(3);
      });

      it('does NOT let a reset step\'s redo-attempt images satisfy a later step when it is re-completed in the SAME batch (CodeRabbit)', async () => {
        // Step 2 was completed once (completedAt 15:00), then reset back to
        // 'pending' -- simulating a step whose assets needed regenerating.
        // Only 'completed'/'skipped' transitions stamp completedAt/resolvedAt,
        // so the reset leaves that 15:00 timestamp in place even though the
        // step is no longer resolved. The 2 images below (15:03/15:04) are
        // step 2's OWN redo-attempt images, produced after the reset but
        // before it's re-completed below -- they must not count toward step
        // 3 just because they postdate step 2's stale 15:00 timestamp. Step 2
        // is re-completed in the SAME batch as step 3, so the fix must use
        // step 2's fresh, just-stamped (real "now") timestamp as step 3's
        // cutoff, which correctly excludes these 2026-08-12 images.
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [
            { role: 'system', content: 'Image generated: redo_1.png', metadata: { kind: 'image-generated', imageFilename: 'redo_1.png', timestamp: '2026-08-12T15:03:00.000Z' } },
            { role: 'system', content: 'Image generated: redo_2.png', metadata: { kind: 'image-generated', imageFilename: 'redo_2.png', timestamp: '2026-08-12T15:04:00.000Z' } },
          ],
          workPlan: {
            title: 'Plan',
            steps: [
              { stepCount: 1, title: 'Intake', status: 'completed', completedAt: '2026-08-12T14:50:00.000Z', resolvedAt: '2026-08-12T14:50:00.000Z' },
              { stepCount: 2, title: 'Draft images', status: 'pending', completedAt: '2026-08-12T15:00:00.000Z' },
              { stepCount: 3, title: 'Render final', status: 'pending', expectedAssetCount: 2 },
            ],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T15:05:00.000Z',
          },
        };
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [
            { stepCount: 2, status: 'completed' },
            { stepCount: 3, status: 'completed' },
          ],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.insufficientAssets).toEqual([
          expect.objectContaining({ stepCount: 3, expected: 2, produced: 0 }),
        ]);
      });
    });

    // ENG-1626: production session 822c1ed4 saw set_work_plan_status fail twice
    // back-to-back with no system-level retry, while the customer watched the
    // workplan progress bar stall with no explanation. A transient failure
    // anywhere in the read-modify-write (session read or workPlan persist) should
    // be retried once automatically before the tool reports failure.
    describe('transient failure retry (ENG-1626)', () => {
      const singleStepWorkPlan = () => ({
        title: 'Plan',
        steps: [{ stepCount: 1, title: 'Step 1', status: 'pending' as const }],
        createdAt: '2026-08-27T17:00:00.000Z',
        updatedAt: '2026-08-27T17:00:00.000Z',
      });

      it('retries once and succeeds after a transient (network) session read failure', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: singleStepWorkPlan(),
        };

        (chatbotDb.getChatSession as jest.Mock)
          .mockRejectedValueOnce(new Error('socket hang up'))
          .mockResolvedValueOnce(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.getChatSession).toHaveBeenCalledTimes(2);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledTimes(1);
      });

      it('retries once and succeeds after a transient (throttling/5xx) persist failure', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: singleStepWorkPlan(),
        };

        // Each read returns an independent clone -- like a real DynamoDB read,
        // the retry's fresh read must not see the failed first attempt's local
        // (never-persisted) mutation of workPlan.steps, which would otherwise
        // make the ENG-1626 idempotency short-circuit mistake this retry for
        // an already-applied ack-lost write.
        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() =>
          Promise.resolve(JSON.parse(JSON.stringify(mockSession)))
        );
        (chatbotDb.updateSessionWorkPlan as jest.Mock)
          .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException: 503 Service Unavailable'))
          .mockResolvedValueOnce(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledTimes(2);
      });

      it('does NOT retry a non-transient (validation) exception — fails immediately with the real error', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: singleStepWorkPlan(),
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        // A real invalid_args pattern from toolErrorClassifier's classFromMessage
        // ("arguments failed schema validation") — a model/data bug, not a
        // transient blip.
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockRejectedValue(
          new Error('set_work_plan_status arguments failed schema validation: notes must be a string.')
        );

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('failed schema validation');
        // Only ONE attempt — invalid_args is excluded by isRetryableErrorClass, so
        // the classifier (not an unrecognized-fallback coincidence) is what keeps
        // a validation bug from being retried and silently doubling the model's
        // tool budget.
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledTimes(1);
      });

      it('gives up after a persistent transient failure and reports it as a normal failure', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: singleStepWorkPlan(),
        };

        // Same independent-clone-per-read reasoning as the persist-failure test
        // above -- otherwise the first attempt's local mutation makes the
        // ENG-1626 idempotency short-circuit skip the second attempt's persist
        // call entirely.
        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() =>
          Promise.resolve(JSON.parse(JSON.stringify(mockSession)))
        );
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockRejectedValue(new Error('ETIMEDOUT'));

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to update work plan status');
        expect(result.error).toContain('ETIMEDOUT');
        // Exactly two attempts total (one retry), never an unbounded retry loop.
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledTimes(2);
      });

      it('does not re-stamp resolvedAt or re-decrement counts on retry when attempt 1 actually committed (ack-lost)', async () => {
        // The scenario the ENG-1626 idempotency guard exists for: attempt 1's
        // updateSessionWorkPlan call commits server-side, but the client sees a
        // transient error anyway (the ack itself was lost, not the write). The
        // retry's fresh read sees the ALREADY-completed step. updateSessionWorkPlan
        // itself is safe to call again (an unconditional SET, re-writing the same
        // state) -- CodeRabbit's review on this PR flagged that the ORIGINAL guard
        // over-corrected by skipping that entire write (and its post-write side
        // effects: the decision-card input request, skill install), stranding the
        // decision card. What must NOT repeat is the resolvedAt re-stamp and the
        // calledFunctionCounts decrement -- this test pins THAT invariant.
        const pendingSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: singleStepWorkPlan(),
        };
        const committedSession = {
          ...pendingSession,
          workPlan: {
            ...pendingSession.workPlan,
            steps: [{ stepCount: 1, title: 'Step 1', status: 'completed' as const, resolvedAt: '2026-08-27T17:00:05.000Z' }],
          },
        };

        (chatbotDb.getChatSession as jest.Mock)
          .mockResolvedValueOnce(JSON.parse(JSON.stringify(pendingSession)))
          .mockResolvedValueOnce(JSON.parse(JSON.stringify(committedSession)));
        // Attempt 1's persist call itself throws -- the caller never sees a
        // successful response, even though (per the committedSession read above)
        // the write actually landed. Attempt 2's persist call (the same
        // already-applied state written back) succeeds.
        (chatbotDb.updateSessionWorkPlan as jest.Mock)
          .mockRejectedValueOnce(new Error('ETIMEDOUT'))
          .mockResolvedValueOnce(committedSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.getChatSession).toHaveBeenCalledTimes(2);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledTimes(2);
        // The retry's own write must carry the ORIGINAL committed resolvedAt, not
        // a freshly-generated one -- a re-stamp here would shift the asset-count
        // cutoff window for any later step.
        const secondCallWorkPlan = (chatbotDb.updateSessionWorkPlan as jest.Mock).mock.calls[1][1];
        expect(secondCallWorkPlan.steps[0].resolvedAt).toBe('2026-08-27T17:00:05.000Z');
      });
    });
  });

  describe('buildMarketingContext with work plan', () => {
    it('should inject work plan status into context', () => {
      const sessionHistory = [
        {
          role: 'system' as const,
          content: 'You are a helpful assistant',
          timestamp: '2025-01-15T09:00:00.000Z',
        },
        {
          role: 'user' as const,
          content: 'Hello',
          timestamp: '2025-01-15T09:01:00.000Z',
        },
      ];

      const workPlan = {
        title: 'Client Onboarding',
        steps: [
          { stepCount: 1, title: 'Analyze website', status: 'completed' as const },
          { stepCount: 2, title: 'Update guidelines', status: 'pending' as const },
          { stepCount: 3, title: 'Create strategy', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'What is next?',
        sessionHistory,
        [],
        workPlan
      );

      // Find the work plan status message
      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('Current Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).toContain('Client Onboarding');
      expect(workPlanMessage.content).toContain('1. ✓ Analyze website (completed)');
      expect(workPlanMessage.content).toContain('2. ○ Update guidelines (pending)');
      expect(workPlanMessage.content).toContain('3. ○ Create strategy (pending)');
    });

    it('should include skipped steps with correct icon', () => {
      const workPlan = {
        title: 'Project Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'skipped' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Continue',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('Current Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).toContain('1. ✓ Step 1 (completed)');
      expect(workPlanMessage.content).toContain('2. ⊘ Step 2 (skipped)');
      expect(workPlanMessage.content).toContain('3. ○ Step 3 (pending)');
    });

    it('should not inject work plan when none exists', () => {
      const result = (agentModeService as any).buildMarketingContext(
        'Hello',
        [],
        [],
        undefined // No work plan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('Current Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeUndefined();
    });

    it('should include step descriptions in work plan context', () => {
      const workPlan = {
        title: 'Client Onboarding',
        steps: [
          {
            stepCount: 1,
            title: 'Analyze website',
            description: 'Research and analyze the client\'s website and business',
            status: 'pending' as const,
          },
          {
            stepCount: 2,
            title: 'Create brand guidelines',
            description: 'Establish brand guidelines including colors and fonts',
            status: 'pending' as const,
          },
          {
            stepCount: 3,
            title: 'Create strategy',
            // No description for this step
            status: 'pending' as const,
          },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'What should I do next?',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).toContain('Description: Research and analyze the client\'s website and business');
      expect(workPlanMessage.content).toContain('Description: Establish brand guidelines including colors and fonts');
      // Step 3 should not have a description line
      expect(workPlanMessage.content).toContain('3. ○ Create strategy (pending)');
      const step3Index = workPlanMessage.content.indexOf('3. ○ Create strategy (pending)');
      const afterStep3 = workPlanMessage.content.substring(step3Index);
      // After step 3, there should be no "Description:" line before the next step or end
      expect(afterStep3).not.toMatch(/Description:.*Create strategy/);
    });

    it('should include required function calls in work plan context', () => {
      const workPlan = {
        title: 'Content Creation Plan',
        steps: [
          {
            stepCount: 1,
            title: 'Research topic',
            requiredFunctionCalls: ['you_search_web'],
            status: 'pending' as const,
          },
          {
            stepCount: 2,
            title: 'Create blog articles',
            requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            status: 'pending' as const,
          },
          {
            stepCount: 3,
            title: 'Generate images',
            requiredFunctionCalls: ['generate_image'],
            status: 'pending' as const,
          },
          {
            stepCount: 4,
            title: 'Finalize content',
            // No required function calls
            status: 'pending' as const,
          },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Continue with the plan',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).toContain('Required Functions: you_search_web');
      expect(workPlanMessage.content).toContain('Required Functions: create_blog_article, create_blog_article, create_blog_article');
      expect(workPlanMessage.content).toContain('Required Functions: generate_image');
      // Step 4 should not have required functions
      expect(workPlanMessage.content).toContain('4. ○ Finalize content (pending)');
      const step4Index = workPlanMessage.content.indexOf('4. ○ Finalize content (pending)');
      const afterStep4 = workPlanMessage.content.substring(step4Index);
      // After step 4, there should be no "Required Functions:" line before the next step or end
      expect(afterStep4).not.toMatch(/Required Functions:.*Finalize content/);
    });

    it('should include both descriptions and required function calls when both are present', () => {
      const workPlan = {
        title: 'Complete Onboarding',
        steps: [
          {
            stepCount: 1,
            title: 'Analyze website and business',
            description: 'Research and analyze the client\'s website and business to understand their industry',
            requiredFunctionCalls: ['you_search_web'],
            status: 'pending' as const,
          },
          {
            stepCount: 2,
            title: 'Create brand guidelines',
            description: 'Establish brand guidelines',
            requiredFunctionCalls: ['update_brand_guidelines'],
            status: 'completed' as const,
          },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'What is the next step?',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      // Check step 1 has both description and required functions
      expect(workPlanMessage.content).toContain('1. ○ Analyze website and business (pending)');
      expect(workPlanMessage.content).toContain('Description: Research and analyze the client\'s website and business to understand their industry');
      expect(workPlanMessage.content).toContain('Required Functions: you_search_web');
      // Check step 2 has both description and required functions
      expect(workPlanMessage.content).toContain('2. ✓ Create brand guidelines (completed)');
      expect(workPlanMessage.content).toContain('Description: Establish brand guidelines');
      expect(workPlanMessage.content).toContain('Required Functions: update_brand_guidelines');
    });

    it('should include warning message about existing work plan', () => {
      const workPlan = {
        title: 'Project Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Hello',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).toContain('⚠️ IMPORTANT: A WORK PLAN ALREADY EXISTS FOR THIS SESSION ⚠️');
      expect(workPlanMessage.content).toContain('You MUST continue working with this existing plan');
      expect(workPlanMessage.content).toContain('DO NOT create a new work plan');
      expect(workPlanMessage.content).toContain('Use modify_work_plan if you need to add or change steps');
    });

    it('should include autocomplete instruction when autocomplete is enabled', () => {
      const workPlan = {
        title: 'Auto Onboarding',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
        autocomplete: true,
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Continue',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      // Autocomplete plans run hands-off — the guidance must forbid pausing for approval
      // and instruct best-effort completion, never the interactive "don't complete until
      // approved" guard (which would contradict the autocomplete contract).
      expect(workPlanMessage.content).toContain('⚠️ AUTOCOMPLETE MODE');
      expect(workPlanMessage.content).toMatch(/do NOT pause to ask the user to approve or confirm/i);
      expect(workPlanMessage.content).toMatch(/reasonable defaults rather than blocking/i);
      expect(workPlanMessage.content).not.toContain('STEP COMPLETION');
    });

    it('should not include autocomplete instruction when autocomplete is false', () => {
      const workPlan = {
        title: 'Manual Onboarding',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
        autocomplete: false,
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Continue',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).not.toContain('AUTOCOMPLETE MODE');
      // Step-progression guidance (which mentions set_work_plan_status) is added for
      // ALL active plans regardless of autocomplete — only the AUTOCOMPLETE MODE block
      // is gated. Assert that the autocomplete-specific phrasing is what's absent.
      expect(workPlanMessage.content).not.toContain('DO NOT ask the user whether you should complete the step');
    });

    it('should not include autocomplete instruction when autocomplete is undefined', () => {
      const workPlan = {
        title: 'Default Onboarding',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
        // autocomplete is undefined
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Continue',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && (msg.content.includes('Current Active Work Plan') || msg.content.includes('WORK PLAN ALREADY EXISTS'))
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).not.toContain('AUTOCOMPLETE MODE');
      // See note above: step-progression guidance is intentionally present for active
      // plans; only the autocomplete-specific instruction must be absent here.
      expect(workPlanMessage.content).not.toContain('DO NOT ask the user whether you should complete the step');
    });
  });

  describe('Required Function Calls', () => {
    describe('createWorkPlan with requiredFunctionCalls', () => {
      it('should create work plan with requiredFunctionCalls', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).createWorkPlan(
          'Client Onboarding',
          [
            {
              stepCount: 1,
              title: 'Analyze website',
              requiredFunctionCalls: ['you_search_web'],
            },
            {
              stepCount: 2,
              title: 'Create 3 blog articles',
              requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            },
          ],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                title: 'Analyze website',
                requiredFunctionCalls: ['you_search_web'],
              }),
              expect.objectContaining({
                stepCount: 2,
                title: 'Create 3 blog articles',
                requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
              }),
            ]),
          })
        );
      });
    });

    describe('modifyWorkPlan with requiredFunctionCalls', () => {
      it('should add requiredFunctionCalls to existing step', async () => {
        const existingWorkPlan = {
          title: 'Project Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(existingWorkPlan)),
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [
            {
              stepCount: 1,
              title: 'Step 1',
              requiredFunctionCalls: ['you_search_web', 'create_blog_article'],
            },
          ],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                requiredFunctionCalls: ['you_search_web', 'create_blog_article'],
              }),
            ]),
          })
        );
      });
    });

    describe('setWorkPlanStatus with requiredFunctionCalls validation', () => {
      it('should fail to complete step when required functions not called', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Research',
              status: 'pending' as const,
              requiredFunctionCalls: ['you_search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // No functions called yet
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Required function calls have not been made');
        expect(result.missingFunctionCalls).toBeDefined();
        expect(result.missingFunctionCalls[0].missing).toContain('you_search_web (need 1, have 0)');
      });

      it('should succeed when required functions have been called', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Research',
              status: 'pending' as const,
              requiredFunctionCalls: ['you_search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { you_search_web: 1 },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.decrementCalledFunctionsClamped as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Step 1 status updated to completed');
        // ENG-1698: applied as a delta against a fresh read, not an absolute
        // value computed from this call's local snapshot.
        expect(chatbotDb.decrementCalledFunctionsClamped).toHaveBeenCalledWith(
          mockSessionId,
          { you_search_web: 1 }
        );
      });

      it('should fail when multiple calls required but not enough made', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Create 3 blog articles',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { create_blog_article: 2 }, // Only 2 calls, need 3
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Required function calls have not been made');
        expect(result.missingFunctionCalls[0].missing).toContain('create_blog_article (need 3, have 2)');
      });

      it('should succeed when multiple calls required and all made', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Create 3 blog articles',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { create_blog_article: 5 }, // More than enough
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.decrementCalledFunctionsClamped as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.decrementCalledFunctionsClamped).toHaveBeenCalledWith(
          mockSessionId,
          { create_blog_article: 3 } // Delta: decrement by 3
        );
      });

      it('should handle multiple different required functions', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Complete onboarding',
              status: 'pending' as const,
              requiredFunctionCalls: ['you_search_web', 'create_blog_article', 'generate_image'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {
            you_search_web: 1,
            create_blog_article: 1,
            generate_image: 0, // This one is missing
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.missingFunctionCalls[0].missing).toContain('generate_image (need 1, have 0)');
        expect(result.missingFunctionCalls[0].missing).not.toContain('you_search_web');
        expect(result.missingFunctionCalls[0].missing).not.toContain('create_blog_article');
      });

      it('should not validate requiredFunctionCalls when marking as skipped', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Research',
              status: 'pending' as const,
              requiredFunctionCalls: ['you_search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // No functions called
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'skipped', notes: 'Not needed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Step 1 status updated to skipped');
        // Should not try to update calledFunctions when skipping
        expect(chatbotDb.updateCalledFunctions).not.toHaveBeenCalled();
        expect(chatbotDb.decrementCalledFunctionsClamped).not.toHaveBeenCalled();
      });

      it('ENG-1698: decrements calledFunctions when skipping a step that already made its calls', async () => {
        // Step 1 called generate_image once (required) before being skipped. Without
        // decrementing, that credit stays in the pool and could silently satisfy step
        // 2's own generate_image requirement without step 2 ever calling it.
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Draft hero image',
              status: 'pending' as const,
              requiredFunctionCalls: ['generate_image'],
            },
            {
              stepCount: 2,
              title: 'Draft banner image',
              status: 'pending' as const,
              requiredFunctionCalls: ['generate_image'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { generate_image: 1 },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.decrementCalledFunctionsClamped as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'skipped', notes: 'Not needed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.decrementCalledFunctionsClamped).toHaveBeenCalledWith(
          mockSessionId,
          { generate_image: 1 }
        );
      });

      it('ENG-1698: skipping a step that never made its calls does not drive the count negative', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Draft hero image',
              status: 'pending' as const,
              requiredFunctionCalls: ['generate_image'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // never called
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'skipped' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        // Clamped at 0 -- must not persist a negative count for a later step to inherit.
        expect(chatbotDb.updateCalledFunctions).not.toHaveBeenCalled();
        expect(chatbotDb.decrementCalledFunctionsClamped).not.toHaveBeenCalled();
      });

      // ENG-1793: pins the "or failing" half of the ticket title -- a required
      // function that was invoked and FAILED (present in failedFunctions) but
      // never subsequently succeeded (absent/zero in calledFunctions) must not
      // satisfy the gate. calledFunctionCounts is keyed off calledFunctions only,
      // so this was already correctly enforced; this test guards against a future
      // change that starts crediting failed attempts toward the required count.
      it('ENG-1793: fails to complete a step whose required function was called but failed, never succeeded', async () => {
        const workPlan = {
          title: 'Meta Ads Performance Report',
          steps: [
            {
              stepCount: 3,
              title: 'Create HTML report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_from_template'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // never succeeded
          failedFunctions: { create_html_from_template: 1 }, // invoked, and failed
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Required function calls have not been made');
        expect(result.missingFunctionCalls[0].missing).toContain('create_html_from_template (need 1, have 0)');
      });
    });

    // ENG-1793: production session a90b38fc-a641-4e11-b5af-219d1fa39145 launched
    // the "Meta Ads Performance Report" predefined plan. Its "Create HTML report"
    // step required create_html_from_template; that call FAILED
    // (failedFunctions.create_html_from_template = 1, calledFunctions has no
    // successful entry for it), yet a mid-run modify_work_plan call updated that
    // step and happened to pass requiredFunctionCalls: [] -- silently clearing the
    // real requirement -- after which set_work_plan_status marked the step
    // completed anyway, because the gate had nothing left to check.
    describe('ENG-1793: modify_work_plan cannot silently drop a failed required function call', () => {
      it('re-adds a required function that already failed and never succeeded, even when the update omits it', async () => {
        const workPlan = {
          title: 'Meta Ads Performance Report',
          steps: [
            {
              stepCount: 3,
              title: 'Create HTML report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_from_template'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // create_html_from_template never succeeded
          failedFunctions: { create_html_from_template: 1 }, // ...but it DID fail
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [
            {
              stepCount: 3,
              title: 'Create HTML report',
              requiredFunctionCalls: [], // the exact production payload
            },
          ],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 3,
                requiredFunctionCalls: ['create_html_from_template'],
              }),
            ]),
          })
        );
      });

      it('reads the session with consistentRead so a same-turn failure is never missed', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [{ stepCount: 1, title: 'Step 1', status: 'pending' as const, requiredFunctionCalls: [] }],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 1, title: 'Step 1' }],
          [],
          mockSessionId
        );

        expect(chatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId, true);
      });

      // ENG-1799 tightened this: it is no longer enough for the dropped function to
      // have merely never failed -- it must have actually SUCCEEDED at least once
      // (see the new 'ENG-1799' describe block below for the "never called at all"
      // case this test used to leave unprotected).
      it('still allows a genuine scope reduction: dropping a required function that already succeeded', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Load Campaign Metrics',
              status: 'pending' as const,
              requiredFunctionCalls: ['list_meta_ads_campaigns', 'get_meta_ads_metrics'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { get_meta_ads_metrics: 1 }, // already succeeded once
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [
            {
              stepCount: 1,
              title: 'Load Campaign Metrics',
              requiredFunctionCalls: ['list_meta_ads_campaigns'], // user approved dropping the metrics call
            },
          ],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                requiredFunctionCalls: ['list_meta_ads_campaigns'],
              }),
            ]),
          })
        );
      });

      it('does not re-add a required function that failed but has since succeeded', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Create HTML report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_from_template'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { create_html_from_template: 1 }, // a later retry succeeded
          failedFunctions: { create_html_from_template: 1 }, // the first attempt failed
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 1, title: 'Create HTML report', requiredFunctionCalls: [] }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 1, requiredFunctionCalls: [] }),
            ]),
          })
        );
      });

      it('end-to-end: modify_work_plan cannot be used to bypass set_work_plan_status\'s completion gate', async () => {
        const workPlan = {
          title: 'Meta Ads Performance Report',
          steps: [
            {
              stepCount: 3,
              title: 'Create HTML report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_from_template'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {},
          failedFunctions: { create_html_from_template: 1 },
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Step 1: the model tries to clear the failed step's required calls via modify_work_plan.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Create HTML report', requiredFunctionCalls: [] }],
          [],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);

        // Step 2: the model then tries to mark the step completed anyway.
        const statusResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );

        expect(statusResult.success).toBe(false);
        expect(statusResult.message).toContain('Required function calls have not been made');
        expect(statusResult.missingFunctionCalls[0].missing).toContain('create_html_from_template (need 1, have 0)');
      });
    });

    // ENG-1799: production session 3fce3c5a-6b25-4167-987b-b5bd8c7f4c5b launched
    // the "Founder_Linkedin_Sales_Readiness_Audit" predefined plan. Investigation
    // showed the SAME class of gap ENG-1793 fixed above, but for a required
    // function that was never called at all rather than one that was called and
    // failed: the old mergeRequiredFunctionCalls only protected a function with
    // failedFunctions[fn] > 0, so a never-attempted function (failed === 0,
    // succeeded === 0) failed that `failed > 0` test and could be silently
    // dropped by modify_work_plan just as easily as a genuinely-satisfied one.
    describe('ENG-1799: modify_work_plan cannot silently drop a never-called required function call', () => {
      it('re-adds a required function that was never called, even when the update omits it', async () => {
        const workPlan = {
          title: 'Founder_Linkedin_Sales_Readiness_Audit',
          steps: [
            {
              stepCount: 1,
              title: 'ICP Info Collection',
              status: 'pending' as const,
              requiredFunctionCalls: ['read_knowledge_base_files', 'read_market_strategy', 'you_search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // none of the three has ever been called
          failedFunctions: {}, // and none has ever failed either -- just never attempted
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [
            {
              stepCount: 1,
              title: 'ICP Info Collection',
              requiredFunctionCalls: [], // silently drops all three unmet requirements
            },
          ],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                requiredFunctionCalls: expect.arrayContaining([
                  'read_knowledge_base_files',
                  'read_market_strategy',
                  'you_search_web',
                ]),
              }),
            ]),
          })
        );
      });

      it('still allows dropping a required function that already succeeded', async () => {
        const workPlan = {
          title: 'Founder_Linkedin_Sales_Readiness_Audit',
          steps: [
            {
              stepCount: 1,
              title: 'ICP Info Collection',
              status: 'pending' as const,
              requiredFunctionCalls: ['read_knowledge_base_files', 'you_search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { read_knowledge_base_files: 1, you_search_web: 1 }, // both already succeeded
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [
            {
              stepCount: 1,
              title: 'ICP Info Collection',
              requiredFunctionCalls: ['read_knowledge_base_files'], // user approved dropping the already-satisfied you_search_web
            },
          ],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 1, requiredFunctionCalls: ['read_knowledge_base_files'] }),
            ]),
          })
        );
      });

      it('still protects a never-succeeded required function even once the step shows completed (closes the reset-to-pending bypass)', async () => {
        // Fresh-eyes review of PR #2794 found: an earlier version of this fix
        // exempted a resolved (completed/skipped) step from protection entirely,
        // on the theory that "the gate that mattered already ran its decision."
        // That's unsafe -- a resolved step can be reset back to 'pending' later
        // (e.g. "assets need regenerating", see the ENG-1188/CodeRabbit PR #2430
        // cutoff-timestamp handling in setWorkPlanStatusAttempt, which explicitly
        // treats that reset as a supported transition) without restoring
        // requiredFunctionCalls to anything. Clearing a requirement while
        // 'completed' would then survive the reset silently, letting the step
        // re-complete with no gate at all. Protection must stay active
        // regardless of status; it's a no-op for a step that resolved normally
        // (every required call already succeeded), and only bites when a
        // requirement was never actually satisfied -- exactly the case this
        // test pins.
        const workPlan = {
          title: 'Founder_Linkedin_Sales_Readiness_Audit',
          steps: [
            {
              stepCount: 1,
              title: 'ICP Info Collection',
              status: 'completed' as const,
              requiredFunctionCalls: ['read_knowledge_base_files', 'you_search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          // Neither function ever actually succeeded for this session -- an
          // inconsistent-but-possible state (e.g. the step was force-completed
          // by an earlier bug, or reset-and-recompleted before this fix).
          calledFunctions: {},
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 1, title: 'ICP Info Collection', requiredFunctionCalls: [] }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                requiredFunctionCalls: expect.arrayContaining(['read_knowledge_base_files', 'you_search_web']),
              }),
            ]),
          })
        );
      });

      it('end-to-end: clearing a required call while completed cannot survive a reset-to-pending, then re-complete without the real work', async () => {
        // The exact exploit sequence the review reproduced. Starting state:
        // the step is already 'completed' with its credit already consumed
        // (calledFunctions: {}) -- the same realistic post-completion shape
        // ENG-1698's decrementCalledFunctionsClamped produces once a step
        // that consumed a required call's credit has resolved. From there:
        // clear requiredFunctionCalls via modify_work_plan while still
        // 'completed' (previously exempt from protection), reset the step
        // back to 'pending' (a real, already-supported transition -- resets
        // never restore requiredFunctionCalls), then re-complete it without
        // ever calling the required function again.
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            {
              stepCount: 3,
              title: 'Create HTML report',
              status: 'completed' as const,
              requiredFunctionCalls: ['create_html_file'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {},
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // 1. Clear requiredFunctionCalls via modify_work_plan while the step is 'completed'.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Create HTML report', requiredFunctionCalls: [] }],
          [],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);
        expect(mockSession.workPlan.steps[0].requiredFunctionCalls).toEqual(['create_html_file']);

        // 2. Reset the step back to pending (no required-call check on this transition).
        const resetResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'pending' }],
          mockSessionId
        );
        expect(resetResult.success).toBe(true);

        // 3. Re-complete without ever calling create_html_file again -- must be blocked.
        const secondComplete = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );
        expect(secondComplete.success).toBe(false);
        expect(secondComplete.missingFunctionCalls[0].missing).toContain('create_html_file (need 1, have 0)');
      });

      it('ENG-1811: a removed step\'s never-called requirement blocks finishing the plan, even reused in the SAME call, with requiredFunctionCalls omitted', async () => {
        // Live-verified on test-env1, 2026-09-07 (unprompted, organic model
        // behavior against the real deployed branch, not a scripted repro):
        // the model called modify_work_plan with removeStepCounts including a
        // stepCount, and a new step reusing that exact same stepCount, in the
        // SAME call, omitting requiredFunctionCalls entirely. Because
        // removeStepCounts filters workPlan.steps BEFORE the update-or-add
        // loop runs, the re-added step landed in the "add new step" branch
        // (existingIndex === -1), bypassing mergeRequiredFunctionCalls
        // entirely -- a different bypass mechanism than the reset-to-pending
        // one above, and one the original ENG-1799/1800 fix (and its first
        // correction) both missed since neither touched the removeStepCounts
        // interaction. The pendingRequiredFunctionCalls ledger closes this by
        // tracking the debt at the session level rather than trying to
        // reattach it to whichever step happens to reuse the stepCount.
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            {
              stepCount: 2,
              title: 'Perform data analysis on metrics',
              status: 'pending' as const,
              requiredFunctionCalls: ['list_html_templates', 'perform_data_analysis'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          // perform_data_analysis genuinely succeeded; list_html_templates never did.
          calledFunctions: { perform_data_analysis: 1 },
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Remove step 2, add a new step 2 (same number) with requiredFunctionCalls
        // omitted entirely -- the exact live-observed payload.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 2, title: 'Performance Report & Analysis' }],
          [2],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);

        const newStep2 = mockSession.workPlan.steps.find((s: any) => s.stepCount === 2);
        // The re-added step itself carries no requirement -- the ledger is
        // what actually protects the never-called function now, not the
        // step's own list.
        expect(newStep2.requiredFunctionCalls ?? []).toEqual([]);
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual(['list_html_templates']);

        // Attempting to finish the plan (this is the only remaining step)
        // without ever calling list_html_templates must be blocked, citing
        // the removed-step debt specifically -- not the ordinary
        // missing-function-calls gate, since step 2 itself no longer
        // declares the requirement.
        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(false);
        expect(completeResult.reason).toBe('workplan_unresolved_removed_requirements');
        expect(completeResult.pendingRequiredFunctionCalls).toEqual(['list_html_templates']);
      });

      it('ENG-1811: the debt survives across two SEPARATE modify_work_plan calls (remove in one, re-add with omitted fields in a later, independent call)', async () => {
        // The exact live-observed exploit that defeated the first (same-call
        // only) version of this fix: removal and re-addition split across two
        // independent modify_work_plan invocations. Each invocation does its
        // own fresh getChatSession read and has no in-memory knowledge of the
        // other -- only a value actually persisted on the session (workPlan
        // itself, hence pendingRequiredFunctionCalls living there) can bridge
        // the two.
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            { stepCount: 1, title: 'Load Campaign Metrics', status: 'completed' as const, requiredFunctionCalls: [] },
            {
              stepCount: 2,
              title: 'Perform data analysis on metrics',
              status: 'pending' as const,
              requiredFunctionCalls: ['list_html_templates', 'perform_data_analysis'],
            },
            {
              stepCount: 3,
              title: 'Create HTML report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_from_template'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { perform_data_analysis: 1, create_html_file: 1 },
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Call A: remove steps 2 and 3 entirely, no re-add in this call.
        const removeResult = await (agentModeService as any).modifyWorkPlan([], [2, 3], mockSessionId);
        expect(removeResult.success).toBe(true);
        expect(mockSession.workPlan.steps.map((s: any) => s.stepCount)).toEqual([1]);
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual(
          expect.arrayContaining(['list_html_templates', 'create_html_from_template'])
        );
        // perform_data_analysis genuinely succeeded before removal -- not a debt.
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).not.toContain('perform_data_analysis');

        // Call B: a SEPARATE, later modify_work_plan call re-adds steps 2 and 3
        // with requiredFunctionCalls omitted -- this call does not mention
        // removeStepCounts at all, since it isn't removing anything.
        const readdResult = await (agentModeService as any).modifyWorkPlan(
          [
            { stepCount: 2, title: 'Perform data analysis on metrics' },
            { stepCount: 3, title: 'Create HTML report' },
          ],
          [],
          mockSessionId
        );
        expect(readdResult.success).toBe(true);
        for (const s of mockSession.workPlan.steps) {
          expect(s.requiredFunctionCalls ?? []).toEqual([]);
        }

        // Completing steps 2 and 3 (finishing the plan) without ever calling
        // list_html_templates or create_html_from_template must be blocked.
        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }, { stepCount: 3, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(false);
        expect(completeResult.reason).toBe('workplan_unresolved_removed_requirements');
        expect(completeResult.pendingRequiredFunctionCalls).toEqual(
          expect.arrayContaining(['list_html_templates', 'create_html_from_template'])
        );
      });

      it('ENG-1811: the debt clears once the function genuinely succeeds, and no longer blocks finishing the plan', async () => {
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            {
              stepCount: 2,
              title: 'Perform data analysis on metrics',
              status: 'pending' as const,
              requiredFunctionCalls: [],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
          // Simulates a debt already recorded from an earlier removal this session.
          pendingRequiredFunctionCalls: ['list_html_templates'],
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          // The model went back and genuinely called it for real.
          calledFunctions: { list_html_templates: 1 },
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(true);
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual([]);
      });

      it('ENG-1811: does not falsely re-block when the CURRENTLY-COMPLETING step also genuinely requires the same debt function', async () => {
        // Fresh-eyes review of this PR found and reproduced a real bug: the debt
        // check originally compared against calledFunctionCounts, a LOCAL COPY
        // that gets decremented in-place (once per required call) as this same
        // batch's OWN steps pass their gates above (the pre-existing ENG-1698
        // credit-consumption mechanic). If a debt name is ALSO genuinely
        // required and satisfied by the step currently completing in this exact
        // batch, that step's own gate consumes the shared credit and drives the
        // LOCAL copy to 0 -- making a real, same-turn success look like it
        // never happened, and permanently blocking the plan from ever
        // finishing (retrying the identical batch fails identically forever,
        // since nothing persists past a blocked gate). Fixed by reading the
        // raw, never-mutated session.calledFunctions for this specific check
        // instead -- a debt is a "did this ever genuinely happen" fact check,
        // not a shared-pool credit-consumption check like the per-step gates.
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            {
              stepCount: 2,
              title: 'Perform data analysis on metrics',
              status: 'pending' as const,
              // The currently-completing step's OWN requirement is the exact
              // same function name recorded as an outstanding debt.
              requiredFunctionCalls: ['list_html_templates'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
          pendingRequiredFunctionCalls: ['list_html_templates'],
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          // Called exactly once, genuinely -- enough to satisfy step 2's own
          // requirement, which is also all the debt was ever asking for.
          calledFunctions: { list_html_templates: 1 },
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(true);
        expect(completeResult.reason).not.toBe('workplan_unresolved_removed_requirements');
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual([]);

        // A retry of the identical batch (proving this isn't a one-shot
        // ordering fluke) must also succeed, not repeat the same false block.
        const secondSession: any = {
          ...mockSession,
          workPlan: { ...workPlan, steps: [{ ...workPlan.steps[0], status: 'pending', completedAt: undefined, resolvedAt: undefined }] },
        };
        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(secondSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          secondSession.workPlan = updatedPlan;
          return Promise.resolve(secondSession);
        });
        const retryResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );
        expect(retryResult.success).toBe(true);
      });

      it('ENG-1811: a removed step\'s debt does NOT block completing an unrelated, still-in-progress step -- only finishing the whole plan', async () => {
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            { stepCount: 1, title: 'Load Campaign Metrics', status: 'pending' as const, requiredFunctionCalls: [] },
            {
              stepCount: 2,
              title: 'Perform data analysis on metrics',
              status: 'pending' as const,
              requiredFunctionCalls: [],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
          pendingRequiredFunctionCalls: ['list_html_templates'],
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {},
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Step 2 still hasn't resolved, so this batch does not finish the plan.
        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(true);
        // The debt is untouched -- still tracked for when the plan actually finishes.
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual(['list_html_templates']);
      });

      it('ENG-1808: N-to-M consolidation (remove steps 2 AND 3, re-add only step 2, step 3\'s number never reused) still blocks finishing the plan', async () => {
        // ENG-1808's exact original scenario, previously filed as a
        // deliberately-deferred residual gap on top of the (then same-call-only)
        // ENG-1811 fix: the reused-stepCount reattachment could never help step
        // 3's requirement here, because step 3's number is never used again --
        // the "replacement" work is folded entirely into step 2. The
        // session-level, stepCount-agnostic pendingRequiredFunctionCalls ledger
        // has no such limitation: it doesn't matter which step (if any) a
        // removed function's requirement is ever attached to again, only
        // whether the function itself has genuinely succeeded before the plan
        // finishes. This closes ENG-1808 for requiredFunctionCalls fully, not
        // just narrows it.
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            { stepCount: 1, title: 'Load Campaign Metrics', status: 'completed' as const, requiredFunctionCalls: [] },
            {
              stepCount: 2,
              title: 'Perform data analysis on metrics',
              status: 'pending' as const,
              requiredFunctionCalls: ['list_html_templates', 'perform_data_analysis'],
            },
            {
              stepCount: 3,
              title: 'Create HTML report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_from_template'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { perform_data_analysis: 1 },
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Remove steps 2 and 3, add back ONLY a consolidated step 2 -- step 3's
        // number is never mentioned again for the rest of the session.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 2, title: 'Performance Report & Analysis', requiredFunctionCalls: [] }],
          [2, 3],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);
        expect(mockSession.workPlan.steps.map((s: any) => s.stepCount)).toEqual([1, 2]);
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual(
          expect.arrayContaining(['list_html_templates', 'create_html_from_template'])
        );

        // Finishing the plan (step 2 is now the only remaining pending step)
        // without ever calling either debt function must be blocked --
        // including create_html_from_template, whose original step (3) is
        // permanently gone.
        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(false);
        expect(completeResult.reason).toBe('workplan_unresolved_removed_requirements');
        expect(completeResult.pendingRequiredFunctionCalls).toEqual(
          expect.arrayContaining(['list_html_templates', 'create_html_from_template'])
        );

        // Once both genuinely succeed, finishing the plan is correctly allowed.
        mockSession.calledFunctions.list_html_templates = 1;
        mockSession.calledFunctions.create_html_from_template = 1;
        const secondAttempt = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 2, status: 'completed' }],
          mockSessionId
        );
        expect(secondAttempt.success).toBe(true);
        expect(mockSession.workPlan.pendingRequiredFunctionCalls).toEqual([]);
      });

      describe('ENG-1875: judge-gated debt for a step removal the user explicitly authorized', () => {
        function buildMockSession(overrides: any = {}) {
          const workPlan = {
            title: 'Client Report',
            steps: [
              { stepCount: 1, title: 'Load Metrics', status: 'completed' as const, requiredFunctionCalls: [] },
              {
                stepCount: 2,
                title: 'Send report email',
                status: 'pending' as const,
                requiredFunctionCalls: ['send_report_email'],
              },
            ],
            createdAt: '2026-09-11T08:00:00.000Z',
            updatedAt: '2026-09-11T08:00:00.000Z',
          };
          const mockSession: any = {
            sessionId: mockSessionId,
            userId: mockUserId,
            messages: [],
            workPlan: JSON.parse(JSON.stringify(workPlan)),
            calledFunctions: {},
            failedFunctions: {},
            ...overrides,
          };
          (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
          (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
            mockSession.workPlan = updatedPlan;
            return Promise.resolve(mockSession);
          });
          return mockSession;
        }

        it('judge says "yes" against a real authorizing message -- debt is NOT ledgered for the removed step', async () => {
          buildMockSession();
          (chatbotDb.getMostRecentRealUserMessage as jest.Mock).mockResolvedValue({
            content: "skip step 2, we don't need that email sent",
          });
          const callLLMSpy = jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
            choices: [{ message: { content: 'yes' }, finish_reason: 'stop' }],
          });

          const result = await (agentModeService as any).modifyWorkPlan([], [2], mockSessionId);

          expect(result.success).toBe(true);
          expect(result.workPlan.pendingRequiredFunctionCalls || []).not.toContain('send_report_email');
          expect(callLLMSpy).toHaveBeenCalledTimes(1);
        });

        it('judge says "no" -- debt is ledgered exactly as before this fix (regression guard)', async () => {
          buildMockSession();
          (chatbotDb.getMostRecentRealUserMessage as jest.Mock).mockResolvedValue({
            content: 'looks good, keep going',
          });
          jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
            choices: [{ message: { content: 'no' }, finish_reason: 'stop' }],
          });

          const result = await (agentModeService as any).modifyWorkPlan([], [2], mockSessionId);

          expect(result.success).toBe(true);
          expect(result.workPlan.pendingRequiredFunctionCalls).toEqual(
            expect.arrayContaining(['send_report_email'])
          );
        });

        it('judge throws/times out -- fails safe, debt is still ledgered', async () => {
          buildMockSession();
          (chatbotDb.getMostRecentRealUserMessage as jest.Mock).mockResolvedValue({
            content: 'skip step 2',
          });
          jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('LLM gateway down'));

          const result = await (agentModeService as any).modifyWorkPlan([], [2], mockSessionId);

          expect(result.success).toBe(true);
          expect(result.workPlan.pendingRequiredFunctionCalls).toEqual(
            expect.arrayContaining(['send_report_email'])
          );
        });

        it('no real user message at all -- fails safe, debt is still ledgered, judge LLM is never called', async () => {
          buildMockSession();
          (chatbotDb.getMostRecentRealUserMessage as jest.Mock).mockResolvedValue(null);
          const callLLMSpy = jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
            choices: [{ message: { content: 'yes' }, finish_reason: 'stop' }],
          });

          const result = await (agentModeService as any).modifyWorkPlan([], [2], mockSessionId);

          expect(result.success).toBe(true);
          expect(result.workPlan.pendingRequiredFunctionCalls).toEqual(
            expect.arrayContaining(['send_report_email'])
          );
          expect(callLLMSpy).not.toHaveBeenCalled();
        });

        it('an authorized-judged removal never clears already-standing debt from an EARLIER, unauthorized removal', async () => {
          const workPlan = {
            title: 'Client Report',
            steps: [
              { stepCount: 1, title: 'Load Metrics', status: 'completed' as const, requiredFunctionCalls: [] },
              {
                stepCount: 2,
                title: 'Send report email',
                status: 'pending' as const,
                requiredFunctionCalls: ['send_report_email'],
              },
              {
                stepCount: 3,
                title: 'Publish landing page',
                status: 'pending' as const,
                requiredFunctionCalls: ['publish_landing_page'],
              },
            ],
            createdAt: '2026-09-11T08:00:00.000Z',
            updatedAt: '2026-09-11T08:00:00.000Z',
          };
          const mockSession: any = {
            sessionId: mockSessionId,
            userId: mockUserId,
            messages: [],
            workPlan: JSON.parse(JSON.stringify(workPlan)),
            calledFunctions: {},
            failedFunctions: {},
          };
          (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
          (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
            mockSession.workPlan = updatedPlan;
            return Promise.resolve(mockSession);
          });

          // First call: step 2 removed with no authorizing message at all --
          // its required call goes into debt exactly as before this fix.
          (chatbotDb.getMostRecentRealUserMessage as jest.Mock).mockResolvedValue(null);
          const firstResult = await (agentModeService as any).modifyWorkPlan([], [2], mockSessionId);
          expect(firstResult.workPlan.pendingRequiredFunctionCalls).toEqual(['send_report_email']);

          // Second, SEPARATE call: step 3 removed WITH an explicit authorizing
          // message and a "yes" judge -- only step 3's function is spared.
          // Step 2's already-standing debt must remain untouched.
          (chatbotDb.getMostRecentRealUserMessage as jest.Mock).mockResolvedValue({
            content: 'skip step 3, we already published manually',
          });
          jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
            choices: [{ message: { content: 'yes' }, finish_reason: 'stop' }],
          });
          const secondResult = await (agentModeService as any).modifyWorkPlan([], [3], mockSessionId);

          expect(secondResult.workPlan.pendingRequiredFunctionCalls).toEqual(['send_report_email']);
          expect(secondResult.workPlan.pendingRequiredFunctionCalls).not.toContain('publish_landing_page');
        });
      });

      it('ENG-1811: deleting the last pending step(s) WITHOUT re-adding them (never calling set_work_plan_status again) must not report the plan as done while debt is outstanding', async () => {
        // Round-3 fresh-eyes review of PR #2808 found: the ledger's ONLY
        // enforcement point is setWorkPlanStatusAttempt, which nothing calls
        // once no steps remain 'pending'. Every OTHER place that infers "plan
        // done" from workPlan.steps.every(completed|skipped) alone -- the
        // buildWorkPlanContextMessages context banner, and the two
        // workPlanCompleted checks in agentModeController's scheduled/verified
        // chat retry loop -- was fooled by simply deleting the last pending
        // step(s) via modify_work_plan and never re-adding them: no step is
        // left 'pending', so the naive .every() check says "done" even though
        // a removed step's required call never actually succeeded. Reviewer
        // proved this with an executed repro against buildWorkPlanContextMessages
        // directly; this test reproduces the same scenario plus the new
        // isWorkPlanFullyResolved helper that both call sites now share.
        const workPlan = {
          title: 'Meta_Ads_Perf_Report',
          steps: [
            { stepCount: 1, title: 'Load Campaign Metrics', status: 'completed' as const, requiredFunctionCalls: [] },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
          pendingRequiredFunctionCalls: ['list_html_templates'],
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          // list_html_templates never succeeded -- steps 2 & 3 were removed
          // (in an earlier, separate call) and never re-added.
          calledFunctions: {},
          failedFunctions: {},
        };

        // Every step is terminal (only step 1 remains, and it's completed) --
        // the naive .every(completed|skipped) check alone would say "done".
        expect(AgentModeService.isWorkPlanFullyResolved(mockSession.workPlan, mockSession.calledFunctions)).toBe(false);

        // The context-message banner shown to the model must NOT claim the
        // plan is finished -- it must surface the outstanding debt instead.
        const contextMessages = AgentModeService.buildWorkPlanContextMessages(
          mockSession.workPlan,
          undefined,
          true,
          mockSession.calledFunctions
        );
        expect(contextMessages).toHaveLength(1);
        expect(contextMessages[0].content).not.toContain('ALL 1 STEPS ARE DONE');
        expect(contextMessages[0].content).toContain('NOT actually finished');
        expect(contextMessages[0].content).toContain('list_html_templates');

        // Once the debt function genuinely succeeds, the plan resolves correctly.
        mockSession.calledFunctions.list_html_templates = 1;
        expect(AgentModeService.isWorkPlanFullyResolved(mockSession.workPlan, mockSession.calledFunctions)).toBe(true);
        const resolvedMessages = AgentModeService.buildWorkPlanContextMessages(
          mockSession.workPlan,
          undefined,
          true,
          mockSession.calledFunctions
        );
        expect(resolvedMessages[0].content).toContain('ALL 1 STEPS ARE DONE');
      });

      it('does not silently drop expectedAssetCount/expectedAssetCountTools when a reused step OMITS those fields entirely', async () => {
        // Second-round fresh-eyes review of PR #2794 found: the reused-stepCount
        // fix above unconditionally protects requiredFunctionCalls (the merge
        // function always runs when removedOriginal exists), but
        // expectedAssetCount/expectedAssetCountTools kept the OLD
        // "only call the merge function if the caller explicitly supplied the
        // field" pattern. A model reusing a just-removed stepCount and simply
        // OMITTING expectedAssetCount (rather than explicitly lowering it to
        // 0 -- the only case the earlier tests covered) skipped
        // mergeExpectedAssetCount entirely, so the re-added step ended up with
        // NO expectedAssetCount property at all -- a complete, silent removal
        // of the asset-count gate, worse than an explicit lowering, through
        // exactly the reused-stepCount surface this fix claims to close.
        // Reproduced independently before this test was written: pushing a
        // step with only { stepCount, title } (no asset-count fields) through
        // a removed-and-reused stepCount left expectedAssetCount undefined
        // instead of preserving the pre-removal value of 12.
        const workPlan = {
          title: 'Display Ad Set Production',
          steps: [
            {
              stepCount: 3,
              title: 'Render the Full Size Matrix',
              status: 'pending' as const,
              requiredFunctionCalls: ['playwright_browser_take_screenshot'],
              expectedAssetCount: 12,
              expectedAssetCountTools: ['playwright_browser_take_screenshot'],
            },
          ],
          createdAt: '2026-08-12T14:54:35.000Z',
          updatedAt: '2026-08-12T14:54:35.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          // Only 1 of the 12 required assets has genuinely been produced.
          messages: [{
            role: 'assistant',
            timestamp: '2026-08-12T15:35:00.000Z',
            metadata: {
              timestamp: '2026-08-12T15:35:00.000Z',
              toolCalls: [{ name: 'playwright_browser_take_screenshot', result: { success: true } }],
            },
          }],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { playwright_browser_take_screenshot: 1 },
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Remove step 3, add a new step 3 (same number) that OMITS
        // expectedAssetCount/expectedAssetCountTools entirely -- no explicit
        // lowering, just silence.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix' }],
          [3],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);

        const newStep3 = mockSession.workPlan.steps.find((s: any) => s.stepCount === 3);
        expect(newStep3.expectedAssetCount).toBe(12);
        expect(newStep3.expectedAssetCountTools).toEqual(['playwright_browser_take_screenshot']);

        // Attempting to complete the re-added step with only 1 of 12 assets
        // produced must still be blocked.
        const completeResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );
        expect(completeResult.success).toBe(false);
        expect(completeResult.reason).toBe('workplan_insufficient_assets');
      });

      it('end-to-end: modify_work_plan cannot be used to bypass set_work_plan_status\'s completion gate for a never-called function', async () => {
        const workPlan = {
          title: 'Founder_Linkedin_Sales_Readiness_Audit',
          steps: [
            {
              stepCount: 6,
              title: 'Generate HTML Readiness Report',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_html_file'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {},
          failedFunctions: {},
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Step 1: the model tries to clear the never-called step's required calls.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 6, title: 'Generate HTML Readiness Report', requiredFunctionCalls: [] }],
          [],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);

        // Step 2: the model then tries to mark the step completed anyway.
        const statusResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 6, status: 'completed' }],
          mockSessionId
        );

        expect(statusResult.success).toBe(false);
        expect(statusResult.message).toContain('Required function calls have not been made');
        expect(statusResult.missingFunctionCalls[0].missing).toContain('create_html_file (need 1, have 0)');
      });
    });

    // ENG-1800: production session ca06a9e0-9499-42e1-98ce-72b5bb7b4d04 launched
    // the "Display Ad Set Production -- One Master, Every Size" predefined plan.
    // "Render the Full Size Matrix" required expectedAssetCount: 12 (gated on
    // expectedAssetCountTools: ["playwright_browser_take_screenshot"]) but only 1
    // real screenshot was ever taken. Instead of producing the rest, the model
    // called modify_work_plan to shrink expectedAssetCount to 1, then to 0 --
    // silently clearing the sibling completion gate the same way ENG-1793/1799
    // showed requiredFunctionCalls could be cleared, with no protection at all
    // (the field was deliberately unguarded to allow a genuine user-approved
    // scope reduction). The step then completed with 1 of the promised 12 assets
    // and the closing synthesis falsely claimed "Deliverables Generated & Verified"
    // across all 12 units.
    describe('ENG-1800: modify_work_plan cannot silently clear the expectedAssetCount gate', () => {
      const makeStep = (overrides: Record<string, unknown> = {}) => ({
        stepCount: 3,
        title: 'Render the Full Size Matrix',
        status: 'pending' as const,
        requiredFunctionCalls: ['create_html_file', 'playwright_browser_take_screenshot'],
        expectedAssetCount: 12,
        expectedAssetCountTools: ['playwright_browser_take_screenshot'],
        ...overrides,
      });

      const screenshotMessage = (isoTimestamp: string) => ({
        role: 'assistant',
        timestamp: isoTimestamp,
        metadata: {
          timestamp: isoTimestamp,
          toolCalls: [{ name: 'playwright_browser_take_screenshot', result: { success: true } }],
        },
      });

      it('refuses to lower expectedAssetCount to 0 while only 1 of 12 assets has been produced', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [screenshotMessage('2026-08-12T15:35:00.000Z')],
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep()],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        // The exact production payload: the model shrinks the goalpost to match
        // what it actually produced instead of producing the rest.
        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCount: 0 }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 3, expectedAssetCount: 12 }),
            ]),
          })
        );
      });

      it('still allows lowering expectedAssetCount once enough assets have genuinely been produced', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          // 12 real screenshots -- the step has genuinely met its current target.
          messages: Array.from({ length: 12 }, (_, i) =>
            screenshotMessage(`2026-08-12T15:${String(35 + i).padStart(2, '0')}:00.000Z`)
          ),
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep()],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCount: 1 }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 3, expectedAssetCount: 1 }),
            ]),
          })
        );
      });

      it('still allows raising expectedAssetCount freely', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [screenshotMessage('2026-08-12T15:35:00.000Z')],
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep()],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCount: 20 }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 3, expectedAssetCount: 20 }),
            ]),
          })
        );
      });

      it('still refuses to lower expectedAssetCount even once the step shows completed (closes the reset-to-pending bypass)', async () => {
        // Fresh-eyes review of PR #2794 found: an earlier version of this fix
        // exempted a resolved (completed/skipped) step entirely. Unsafe for the
        // same reason as the requiredFunctionCalls case above -- a resolved step
        // can be reset back to 'pending' (a real, already-supported transition)
        // without restoring expectedAssetCount, so a shrink applied while
        // 'completed' would silently survive the reset. Protection must stay
        // active regardless of status; only 1 of 12 assets were ever produced
        // here, so the shrink must still be blocked.
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [screenshotMessage('2026-08-12T15:35:00.000Z')],
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep({ status: 'completed' as const })],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCount: 0 }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 3, expectedAssetCount: 12 }),
            ]),
          })
        );
      });

      it('refuses to retarget expectedAssetCountTools to an unrelated already-satisfied tool while the current requirement is unmet', async () => {
        // Fresh-eyes review of PR #2794 found a second, unaddressed bypass: the
        // numeric expectedAssetCount fix does nothing to protect
        // expectedAssetCountTools. Leaving expectedAssetCount at 12 but silently
        // retargeting expectedAssetCountTools to an unrelated tool the model
        // already called 12+ times achieves the identical "dodge a failing
        // gate" outcome through a field the numeric check never looks at.
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [
            screenshotMessage('2026-08-12T15:35:00.000Z'),
            ...Array.from({ length: 12 }, (_, i) => ({
              role: 'assistant',
              timestamp: `2026-08-12T15:${String(40 + i).padStart(2, '0')}:00.000Z`,
              metadata: {
                timestamp: `2026-08-12T15:${String(40 + i).padStart(2, '0')}:00.000Z`,
                toolCalls: [{ name: 'you_search_web', result: { success: true } }],
              },
            })),
          ],
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep()],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        // expectedAssetCount stays 12 -- only expectedAssetCountTools is retargeted
        // to a tool that was already called 12 times for an unrelated reason.
        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCountTools: ['you_search_web'] }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 3,
                expectedAssetCountTools: ['playwright_browser_take_screenshot'],
              }),
            ]),
          })
        );
      });

      it('still allows retargeting expectedAssetCountTools once the current requirement has genuinely been met', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          // 12 real screenshots under the EXISTING tool -- requirement already met.
          messages: Array.from({ length: 12 }, (_, i) =>
            screenshotMessage(`2026-08-12T15:${String(35 + i).padStart(2, '0')}:00.000Z`)
          ),
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep()],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCountTools: ['generate_image'] }],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ stepCount: 3, expectedAssetCountTools: ['generate_image'] }),
            ]),
          })
        );
      });

      it('end-to-end: modify_work_plan cannot be used to bypass set_work_plan_status\'s asset-count gate', async () => {
        const mockSession: any = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [screenshotMessage('2026-08-12T15:35:00.000Z')],
          calledFunctions: { create_html_file: 1, playwright_browser_take_screenshot: 1 },
          workPlan: {
            title: 'Display Ad Set Production',
            steps: [makeStep()],
            createdAt: '2026-08-12T14:54:35.000Z',
            updatedAt: '2026-08-12T14:54:35.000Z',
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockImplementation(() => Promise.resolve(mockSession));
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockImplementation((_sid: string, updatedPlan: any) => {
          mockSession.workPlan = updatedPlan;
          return Promise.resolve(mockSession);
        });

        // Step 1: set_work_plan_status correctly blocks -- only 1 of 12 produced.
        const blockedResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );
        expect(blockedResult.success).toBe(false);
        expect(blockedResult.reason).toBe('workplan_insufficient_assets');

        // Step 2: the model tries to shrink the goalpost instead of finishing the work.
        const modifyResult = await (agentModeService as any).modifyWorkPlan(
          [{ stepCount: 3, title: 'Render the Full Size Matrix', expectedAssetCount: 0 }],
          [],
          mockSessionId
        );
        expect(modifyResult.success).toBe(true);

        // Step 3: the model tries to mark the step completed anyway.
        const statusResult = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 3, status: 'completed' }],
          mockSessionId
        );

        expect(statusResult.success).toBe(false);
        expect(statusResult.reason).toBe('workplan_insufficient_assets');
        expect(statusResult.insufficientAssets).toEqual([
          expect.objectContaining({ stepCount: 3, expected: 12, produced: 1 }),
        ]);
      });
    });
  });
});
