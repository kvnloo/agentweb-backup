/**
 * ENG-200: workflow generation must use the one shared gateway/metering path.
 */

jest.mock('../services/db', () => ({
  taskDb: { getAvailableTasks: jest.fn().mockResolvedValue([]) },
}));

const mockCallLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { callLLM: (...a: any[]) => mockCallLLM(...a) },
}));

import { generateWorkflowFromDescription } from '../services/workflowGenerator';

const fakeCompletion = {
  choices: [
    {
      message: {
        function_call: {
          arguments: JSON.stringify({ name: 'W', description: 'd', nodes: [] }),
        },
      },
    },
  ],
};

describe('workflowGenerator metering (ENG-200)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(fakeCompletion);
  });

  it('routes once with attributable usage context (no double-record)', async () => {
    await generateWorkflowFromDescription('build a workflow', 'user-1').catch(() => undefined);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        usageContext: { userId: 'user-1', feature: 'workflow_gen' },
        taskClass: 'content_generation',
      }),
    );
  });
});
