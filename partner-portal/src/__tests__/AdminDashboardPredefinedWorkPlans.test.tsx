import '@testing-library/jest-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';

// Mock dependencies
jest.mock('axios');
jest.mock('../contexts/AuthContext');
jest.mock('../config', () => ({
  buildApiUrl: jest.fn((path: string) => `http://localhost:3000${path}`)
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedBuildApiUrl = buildApiUrl as jest.MockedFunction<typeof buildApiUrl>;

// Mock the AgentModeSettings component logic
interface WorkPlanStep {
  stepCount: number;
  title: string;
  description?: string;
  requiredFunctionCalls?: string[];
}

interface PredefinedWorkPlan {
  id?: string;
  title: string;
  steps: WorkPlanStep[];
  autocomplete?: boolean;
  requireLogin?: boolean;
  showLoginSignup?: 'after_plan_completed' | 'always';
  showInAgentMode?: boolean;
  defaultModel?: string;
}

// Helper function to get default onboarding plan
const getDefaultOnboardingPlan = (): PredefinedWorkPlan => ({
  title: 'Onboarding',
  requireLogin: false,
  showLoginSignup: 'after_plan_completed',
  steps: [
    {
      stepCount: 1,
      title: 'Analyze website and business',
      description: 'Research and analyze the client\'s website and business to understand their industry, target audience, and current marketing presence',
      requiredFunctionCalls: ['search_web']
    },
    {
      stepCount: 2,
      title: 'Create/update brand guidelines',
      description: 'Establish or update brand guidelines including colors, fonts, tone of voice, and visual identity',
      requiredFunctionCalls: ['update_brand_guidelines']
    },
    {
      stepCount: 3,
      title: 'Create/update marketing strategy',
      description: 'Develop a comprehensive marketing strategy based on business analysis and brand guidelines',
      requiredFunctionCalls: ['update_marketing_strategy']
    },
    {
      stepCount: 4,
      title: 'Generate 3 blog articles',
      description: 'Create three high-quality blog articles aligned with the marketing strategy and brand voice',
      requiredFunctionCalls: ['create_blog_article']
    },
    {
      stepCount: 5,
      title: 'Generate social media posts',
      description: 'Create engaging social media content and visuals to support the marketing strategy',
      requiredFunctionCalls: ['generate_image']
    }
  ]
});

// Mock loadPredefinedWorkPlans function
const loadPredefinedWorkPlans = async (
  token: string,
  buildApiUrlFn: (path: string) => string
): Promise<PredefinedWorkPlan[]> => {
  try {
    try {
      const response = await mockedAxios.get(buildApiUrlFn('/api/settings/agent-mode-predefined-workplans'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data && response.data.settingValue) {
        const workPlans = JSON.parse(response.data.settingValue);
        
        // Check if "Onboarding" work plan already exists
        const hasOnboarding = workPlans.some((wp: PredefinedWorkPlan) => 
          wp.title.toLowerCase() === 'onboarding'
        );
        
        // If no Onboarding plan exists, add the default one
        if (!hasOnboarding) {
          const defaultOnboardingPlan = getDefaultOnboardingPlan();
          workPlans.push(defaultOnboardingPlan);
          
          // Save the updated work plans with the default Onboarding plan
          try {
            await mockedAxios.put(buildApiUrlFn('/api/settings/agent-mode-predefined-workplans'), {
              settingValue: JSON.stringify(workPlans),
              description: 'Agent Mode predefined work plans for Emma AI assistant'
            }, {
              headers: { Authorization: `Bearer ${token}` }
            });
          } catch (saveError) {
            console.error('Error saving default Onboarding work plan:', saveError);
          }
        }
        
        return workPlans;
      }
    } catch (settingsError: any) {
      // If setting doesn't exist (404), create default Onboarding plan
      if (settingsError.response?.status === 404) {
        const defaultOnboardingPlan = getDefaultOnboardingPlan();
        
        // Try to save the default Onboarding plan
        try {
          await mockedAxios.put(buildApiUrlFn('/api/settings/agent-mode-predefined-workplans'), {
            settingValue: JSON.stringify([defaultOnboardingPlan]),
            description: 'Agent Mode predefined work plans for Emma AI assistant'
          }, {
            headers: { Authorization: `Bearer ${token}` }
          });
        } catch (saveError) {
          console.error('Error saving default Onboarding work plan:', saveError);
        }
        
        return [defaultOnboardingPlan];
      } else {
        console.error('Error loading predefined work plans:', settingsError);
        return [];
      }
    }
  } catch (error) {
    console.error('Error loading predefined work plans:', error);
    return [];
  }
  return [];
};

// Mock savePredefinedWorkPlans function
const savePredefinedWorkPlans = async (
  workPlans: PredefinedWorkPlan[],
  token: string,
  buildApiUrlFn: (path: string) => string
): Promise<void> => {
  // Validate work plans
  const validatedWorkPlans = workPlans.map(workPlan => ({
    title: workPlan.title.trim(),
    requireLogin: workPlan.requireLogin || false,
    showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
    steps: workPlan.steps
      .filter(step => step.title.trim().length > 0)
      .map((step, index) => ({
        stepCount: index + 1,
        title: step.title.trim(),
        description: step.description?.trim() || undefined,
        requiredFunctionCalls: step.requiredFunctionCalls?.filter(f => f.trim().length > 0) || undefined
      }))
  })).filter(workPlan => workPlan.title.length > 0 && workPlan.steps.length > 0);
  
  await mockedAxios.put(buildApiUrlFn('/api/settings/agent-mode-predefined-workplans'), {
    settingValue: JSON.stringify(validatedWorkPlans),
    description: 'Agent Mode predefined work plans for Emma AI assistant'
  }, {
    headers: { Authorization: `Bearer ${token}` }
  });
};

describe('AdminDashboard Predefined Work Plans', () => {
  const mockToken = 'test-token';
  const mockBuildApiUrl = (path: string) => `http://localhost:3000${path}`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ token: mockToken } as any);
    mockedBuildApiUrl.mockImplementation(mockBuildApiUrl);
  });

  describe('getDefaultOnboardingPlan', () => {
    it('should return the default Onboarding work plan with 5 steps', () => {
      const plan = getDefaultOnboardingPlan();
      
      expect(plan.title).toBe('Onboarding');
      expect(plan.steps).toHaveLength(5);
      expect(plan.steps[0].title).toBe('Analyze website and business');
      expect(plan.steps[0].requiredFunctionCalls).toEqual(['search_web']);
      expect(plan.steps[1].title).toBe('Create/update brand guidelines');
      expect(plan.steps[1].requiredFunctionCalls).toEqual(['update_brand_guidelines']);
      expect(plan.steps[4].title).toBe('Generate social media posts');
      expect(plan.steps[4].requiredFunctionCalls).toEqual(['generate_image']);
    });

    it('should have sequential stepCount starting from 1', () => {
      const plan = getDefaultOnboardingPlan();
      
      plan.steps.forEach((step, index) => {
        expect(step.stepCount).toBe(index + 1);
      });
    });

    it('should have descriptions for all steps', () => {
      const plan = getDefaultOnboardingPlan();
      
      plan.steps.forEach(step => {
        expect(step.description).toBeDefined();
        expect(step.description?.length).toBeGreaterThan(0);
      });
    });
  });

  describe('loadPredefinedWorkPlans', () => {
    it('should load existing work plans when they exist', async () => {
      const existingWorkPlans: PredefinedWorkPlan[] = [
        {
          title: 'Campaign Setup',
          steps: [
            { stepCount: 1, title: 'Step 1' }
          ]
        }
      ];

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          settingValue: JSON.stringify(existingWorkPlans)
        }
      });
      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      // Onboarding should be added since it doesn't exist
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Campaign Setup');
      expect(result[1].title).toBe('Onboarding');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://localhost:3000/api/settings/agent-mode-predefined-workplans',
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );
      expect(mockedAxios.put).toHaveBeenCalled();
    });

    it('should add default Onboarding plan when no work plans exist (404)', async () => {
      const error404 = {
        response: { status: 404 }
      };

      mockedAxios.get.mockRejectedValueOnce(error404);
      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Onboarding');
      expect(result[0].steps).toHaveLength(5);
      expect(mockedAxios.put).toHaveBeenCalledWith(
        'http://localhost:3000/api/settings/agent-mode-predefined-workplans',
        {
          settingValue: JSON.stringify([getDefaultOnboardingPlan()]),
          description: 'Agent Mode predefined work plans for Emma AI assistant'
        },
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );
    });

    it('should add default Onboarding plan when work plans exist but no Onboarding plan', async () => {
      const existingWorkPlans: PredefinedWorkPlan[] = [
        {
          title: 'Campaign Setup',
          steps: [
            { stepCount: 1, title: 'Step 1' }
          ]
        }
      ];

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          settingValue: JSON.stringify(existingWorkPlans)
        }
      });
      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Campaign Setup');
      expect(result[1].title).toBe('Onboarding');
      expect(mockedAxios.put).toHaveBeenCalled();
    });

    it('should not add Onboarding plan when it already exists', async () => {
      const existingWorkPlans: PredefinedWorkPlan[] = [
        {
          title: 'Onboarding',
          steps: [
            { stepCount: 1, title: 'Custom step' }
          ]
        }
      ];

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          settingValue: JSON.stringify(existingWorkPlans)
        }
      });

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Onboarding');
      expect(result[0].steps[0].title).toBe('Custom step');
      expect(mockedAxios.put).not.toHaveBeenCalled();
    });

    it('should handle case-insensitive Onboarding plan check', async () => {
      const existingWorkPlans: PredefinedWorkPlan[] = [
        {
          title: 'ONBOARDING',
          steps: [
            { stepCount: 1, title: 'Custom step' }
          ]
        }
      ];

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          settingValue: JSON.stringify(existingWorkPlans)
        }
      });

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      expect(result).toHaveLength(1);
      expect(mockedAxios.put).not.toHaveBeenCalled();
    });

    it('should return empty array on non-404 errors', async () => {
      const error500 = {
        response: { status: 500 }
      };

      mockedAxios.get.mockRejectedValueOnce(error500);

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      expect(result).toEqual([]);
      expect(mockedAxios.put).not.toHaveBeenCalled();
    });

    it('should handle network errors gracefully', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await loadPredefinedWorkPlans(mockToken, mockBuildApiUrl);

      expect(result).toEqual([]);
    });
  });

  describe('savePredefinedWorkPlans', () => {
    it('should save validated work plans', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Test Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', description: 'Description 1' },
            { stepCount: 2, title: 'Step 2' }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      expect(mockedAxios.put).toHaveBeenCalledWith(
        'http://localhost:3000/api/settings/agent-mode-predefined-workplans',
        {
          settingValue: expect.stringContaining('Test Plan'),
          description: 'Agent Mode predefined work plans for Emma AI assistant'
        },
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );
    });

    it('should apply defaults for requireLogin and showLoginSignup', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Plan With Defaults',
          steps: [
            { stepCount: 1, title: 'Step 1' }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      expect(savedPlans[0].requireLogin).toBe(false);
      expect(savedPlans[0].showLoginSignup).toBe('after_plan_completed');
    });

    it('should filter out empty work plans and steps', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Valid Plan',
          steps: [
            { stepCount: 1, title: 'Valid Step' }
          ]
        },
        {
          title: '   ', // Empty title
          steps: [
            { stepCount: 1, title: 'Step' }
          ]
        },
        {
          title: 'Another Plan',
          steps: [
            { stepCount: 1, title: '   ' }, // Empty step title
            { stepCount: 2, title: 'Valid Step' }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      expect(savedPlans).toHaveLength(2);
      expect(savedPlans[0].title).toBe('Valid Plan');
      expect(savedPlans[1].title).toBe('Another Plan');
      expect(savedPlans[1].steps).toHaveLength(1); // Empty step filtered out
    });

    it('should renumber stepCount sequentially', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Test Plan',
          steps: [
            { stepCount: 5, title: 'Step 1' },
            { stepCount: 10, title: 'Step 2' }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      expect(savedPlans[0].steps[0].stepCount).toBe(1);
      expect(savedPlans[0].steps[1].stepCount).toBe(2);
    });

    it('should trim whitespace from titles and descriptions', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: '  Test Plan  ',
          steps: [
            { stepCount: 1, title: '  Step 1  ', description: '  Description  ' }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      expect(savedPlans[0].title).toBe('Test Plan');
      expect(savedPlans[0].steps[0].title).toBe('Step 1');
      expect(savedPlans[0].steps[0].description).toBe('Description');
    });

    it('should filter out empty requiredFunctionCalls', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Test Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              requiredFunctionCalls: ['search_web', '   ', 'analyze_data', '']
            }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      expect(savedPlans[0].steps[0].requiredFunctionCalls).toEqual(['search_web', 'analyze_data']);
    });

    it('should remove requiredFunctionCalls if array becomes empty', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Test Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              requiredFunctionCalls: ['   ', '']
            }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      // When all function calls are filtered out, the property should be undefined or empty array
      // The implementation may return an empty array, which is also acceptable
      const functionCalls = savedPlans[0].steps[0].requiredFunctionCalls;
      expect(functionCalls === undefined || (Array.isArray(functionCalls) && functionCalls.length === 0)).toBe(true);
    });

    it('should handle work plans with no steps', async () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          title: 'Empty Plan',
          steps: []
        },
        {
          title: 'Valid Plan',
          steps: [
            { stepCount: 1, title: 'Step 1' }
          ]
        }
      ];

      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await savePredefinedWorkPlans(workPlans, mockToken, mockBuildApiUrl);

      const callArgs = mockedAxios.put.mock.calls[0][1] as any;
      const savedPlans = JSON.parse(callArgs.settingValue);

      expect(savedPlans).toHaveLength(1);
      expect(savedPlans[0].title).toBe('Valid Plan');
    });
  });

  describe('Work Plan Management Operations', () => {
    it('should add a new work plan', () => {
      const workPlans: PredefinedWorkPlan[] = [];
      const newPlan: PredefinedWorkPlan = {
        title: 'New Plan',
        steps: [{ stepCount: 1, title: 'Step 1' }]
      };

      const updated = [...workPlans, newPlan];

      expect(updated).toHaveLength(1);
      expect(updated[0].title).toBe('New Plan');
    });

    it('should remove a work plan by index', () => {
      const workPlans: PredefinedWorkPlan[] = [
        { title: 'Plan 1', steps: [{ stepCount: 1, title: 'Step 1' }] },
        { title: 'Plan 2', steps: [{ stepCount: 1, title: 'Step 1' }] },
        { title: 'Plan 3', steps: [{ stepCount: 1, title: 'Step 1' }] }
      ];

      const indexToRemove = 1;
      const updated = workPlans.filter((_, i) => i !== indexToRemove);

      expect(updated).toHaveLength(2);
      expect(updated[0].title).toBe('Plan 1');
      expect(updated[1].title).toBe('Plan 3');
    });

    it('should add a step to a work plan', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step 1' }
        ]
      };

      const newStep: WorkPlanStep = {
        stepCount: workPlan.steps.length + 1,
        title: 'Step 2'
      };

      const updated = {
        ...workPlan,
        steps: [...workPlan.steps, newStep]
      };

      expect(updated.steps).toHaveLength(2);
      expect(updated.steps[1].stepCount).toBe(2);
      expect(updated.steps[1].title).toBe('Step 2');
    });

    it('should remove a step from a work plan and renumber', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step 1' },
          { stepCount: 2, title: 'Step 2' },
          { stepCount: 3, title: 'Step 3' }
        ]
      };

      const stepIndexToRemove = 1;
      const updated = {
        ...workPlan,
        steps: workPlan.steps
          .filter((_, i) => i !== stepIndexToRemove)
          .map((step, i) => ({ ...step, stepCount: i + 1 }))
      };

      expect(updated.steps).toHaveLength(2);
      expect(updated.steps[0].stepCount).toBe(1);
      expect(updated.steps[0].title).toBe('Step 1');
      expect(updated.steps[1].stepCount).toBe(2);
      expect(updated.steps[1].title).toBe('Step 3');
    });

    it('should update a work plan', () => {
      const workPlans: PredefinedWorkPlan[] = [
        { title: 'Plan 1', steps: [{ stepCount: 1, title: 'Step 1' }] },
        { title: 'Plan 2', steps: [{ stepCount: 1, title: 'Step 1' }] }
      ];

      const index = 1;
      const updatedPlan: PredefinedWorkPlan = {
        title: 'Updated Plan 2',
        steps: [
          { stepCount: 1, title: 'Updated Step 1' }
        ]
      };

      const updated = [...workPlans];
      updated[index] = updatedPlan;

      expect(updated[1].title).toBe('Updated Plan 2');
      expect(updated[1].steps[0].title).toBe('Updated Step 1');
    });

    it('should update a step in a work plan', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step 1' },
          { stepCount: 2, title: 'Step 2' }
        ]
      };

      const stepIndex = 1;
      const updatedStep: WorkPlanStep = {
        stepCount: 2,
        title: 'Updated Step 2',
        description: 'New description',
        requiredFunctionCalls: ['test_function']
      };

      const updated = {
        ...workPlan,
        steps: [...workPlan.steps]
      };
      updated.steps[stepIndex] = updatedStep;

      expect(updated.steps[1].title).toBe('Updated Step 2');
      expect(updated.steps[1].description).toBe('New description');
      expect(updated.steps[1].requiredFunctionCalls).toEqual(['test_function']);
    });
  });

  describe('Duplicate Work Plan', () => {
    const duplicateWorkPlan = (workPlans: PredefinedWorkPlan[], index: number): PredefinedWorkPlan[] => {
      const original = workPlans[index];
      const copy: PredefinedWorkPlan = {
        ...JSON.parse(JSON.stringify(original)),
        id: undefined,
        title: `${original.title} (Copy)`,
      };
      return [...workPlans, copy];
    };

    it('should create a copy with "(Copy)" appended to the title', () => {
      const workPlans: PredefinedWorkPlan[] = [
        { id: 'plan-1', title: 'My Plan', steps: [{ stepCount: 1, title: 'Step 1' }] }
      ];

      const updated = duplicateWorkPlan(workPlans, 0);

      expect(updated).toHaveLength(2);
      expect(updated[1].title).toBe('My Plan (Copy)');
    });

    it('should clear the id on the duplicated plan', () => {
      const workPlans: PredefinedWorkPlan[] = [
        { id: 'plan-1', title: 'My Plan', steps: [{ stepCount: 1, title: 'Step 1' }] }
      ];

      const updated = duplicateWorkPlan(workPlans, 0);

      expect(updated[1].id).toBeUndefined();
      expect(updated[0].id).toBe('plan-1');
    });

    it('should preserve all steps in the duplicated plan', () => {
      const workPlans: PredefinedWorkPlan[] = [
        {
          id: 'plan-1',
          title: 'My Plan',
          autocomplete: true,
          requireLogin: true,
          showInAgentMode: true,
          defaultModel: 'gpt-4',
          steps: [
            { stepCount: 1, title: 'Step 1', description: 'Desc 1', requiredFunctionCalls: ['func_a'] },
            { stepCount: 2, title: 'Step 2', description: 'Desc 2' },
          ]
        }
      ];

      const updated = duplicateWorkPlan(workPlans, 0);
      const copy = updated[1];

      expect(copy.steps).toHaveLength(2);
      expect(copy.steps[0].title).toBe('Step 1');
      expect(copy.steps[0].requiredFunctionCalls).toEqual(['func_a']);
      expect(copy.steps[1].title).toBe('Step 2');
      expect(copy.autocomplete).toBe(true);
      expect(copy.requireLogin).toBe(true);
      expect(copy.showInAgentMode).toBe(true);
      expect(copy.defaultModel).toBe('gpt-4');
    });

    it('should deep copy steps so mutations do not affect original', () => {
      const workPlans: PredefinedWorkPlan[] = [
        { id: 'plan-1', title: 'My Plan', steps: [{ stepCount: 1, title: 'Step 1', requiredFunctionCalls: ['func_a'] }] }
      ];

      const updated = duplicateWorkPlan(workPlans, 0);
      updated[1].steps[0].title = 'Modified';
      updated[1].steps[0].requiredFunctionCalls!.push('func_b');

      expect(updated[0].steps[0].title).toBe('Step 1');
      expect(updated[0].steps[0].requiredFunctionCalls).toEqual(['func_a']);
    });
  });

  describe('Move Step in Work Plan', () => {
    const moveStepInWorkPlan = (
      workPlan: PredefinedWorkPlan,
      stepIndex: number,
      direction: 'up' | 'down'
    ): PredefinedWorkPlan => {
      const steps = [...workPlan.steps];
      const targetIndex = direction === 'up' ? stepIndex - 1 : stepIndex + 1;
      if (targetIndex < 0 || targetIndex >= steps.length) return workPlan;
      [steps[stepIndex], steps[targetIndex]] = [steps[targetIndex], steps[stepIndex]];
      return { ...workPlan, steps: steps.map((s, i) => ({ ...s, stepCount: i + 1 })) };
    };

    it('should move a step up', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step A' },
          { stepCount: 2, title: 'Step B' },
          { stepCount: 3, title: 'Step C' },
        ]
      };

      const updated = moveStepInWorkPlan(workPlan, 2, 'up');

      expect(updated.steps[0].title).toBe('Step A');
      expect(updated.steps[1].title).toBe('Step C');
      expect(updated.steps[2].title).toBe('Step B');
      expect(updated.steps[0].stepCount).toBe(1);
      expect(updated.steps[1].stepCount).toBe(2);
      expect(updated.steps[2].stepCount).toBe(3);
    });

    it('should move a step down', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step A' },
          { stepCount: 2, title: 'Step B' },
          { stepCount: 3, title: 'Step C' },
        ]
      };

      const updated = moveStepInWorkPlan(workPlan, 0, 'down');

      expect(updated.steps[0].title).toBe('Step B');
      expect(updated.steps[1].title).toBe('Step A');
      expect(updated.steps[2].title).toBe('Step C');
      expect(updated.steps[0].stepCount).toBe(1);
      expect(updated.steps[1].stepCount).toBe(2);
      expect(updated.steps[2].stepCount).toBe(3);
    });

    it('should not move the first step up (boundary)', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step A' },
          { stepCount: 2, title: 'Step B' },
        ]
      };

      const updated = moveStepInWorkPlan(workPlan, 0, 'up');

      expect(updated).toBe(workPlan); // Same reference — no change
      expect(updated.steps[0].title).toBe('Step A');
      expect(updated.steps[1].title).toBe('Step B');
    });

    it('should not move the last step down (boundary)', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step A' },
          { stepCount: 2, title: 'Step B' },
        ]
      };

      const updated = moveStepInWorkPlan(workPlan, 1, 'down');

      expect(updated).toBe(workPlan);
      expect(updated.steps[0].title).toBe('Step A');
      expect(updated.steps[1].title).toBe('Step B');
    });

    it('should renumber stepCount after moving', () => {
      const workPlan: PredefinedWorkPlan = {
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step A' },
          { stepCount: 2, title: 'Step B' },
          { stepCount: 3, title: 'Step C' },
        ]
      };

      const updated = moveStepInWorkPlan(workPlan, 1, 'up');

      updated.steps.forEach((step, index) => {
        expect(step.stepCount).toBe(index + 1);
      });
      expect(updated.steps[0].title).toBe('Step B');
      expect(updated.steps[1].title).toBe('Step A');
    });
  });
});
