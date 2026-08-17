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
        (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Step 1 status updated to completed');
        expect(chatbotDb.updateCalledFunctions).toHaveBeenCalledWith(
          mockSessionId,
          { you_search_web: 0 }
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
        (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateCalledFunctions).toHaveBeenCalledWith(
          mockSessionId,
          { create_blog_article: 2 } // Should decrement by 3
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
      });
    });
  });
});
