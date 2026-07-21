/**
 * ENG-200: workflowGenerator obtained a METERED getAzureClient (auto-records burn)
 * AND called meterUsageFromResponse on the same completion → burn recorded twice.
 * These tests lock the fix: the client is requested UN-metered (metered:false) and
 * the single meterUsageFromResponse records+deducts exactly once.
 */

jest.mock('../services/db', () => ({
  taskDb: { getAvailableTasks: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../utils/llmClients', () => ({
  getAzureClient: jest.fn(),
  meterUsageFromResponse: jest.fn(),
}));

import { getAzureClient, meterUsageFromResponse } from '../utils/llmClients';
import { generateWorkflowFromDescription } from '../services/workflowGenerator';

const mockGetAzure = getAzureClient as jest.Mock;
const mockMeter = meterUsageFromResponse as jest.Mock;

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
    const create = jest.fn().mockResolvedValue(fakeCompletion);
    mockGetAzure.mockReturnValue({ chat: { completions: { create } } });
  });

  it('requests an UN-metered client and meters exactly once (no double-record)', async () => {
    // Metering happens in generateWorkflowYaml, before any downstream visualization
    // post-processing — so the meter contract holds regardless of what follows.
    await generateWorkflowFromDescription('build a workflow', 'user-1').catch(() => undefined);

    // 4th arg carries metered:false so the factory does NOT auto-record.
    expect(mockGetAzure).toHaveBeenCalledTimes(1);
    // overrides (3rd arg) carries metered:false.
    expect(mockGetAzure.mock.calls[0][2]).toEqual(
      expect.objectContaining({ metered: false })
    );

    // Exactly one explicit meter — records AND deducts once.
    expect(mockMeter).toHaveBeenCalledTimes(1);
    expect(mockMeter).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', feature: 'workflow_gen' }),
      fakeCompletion
    );
  });
});
