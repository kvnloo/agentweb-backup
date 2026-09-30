jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
  },
}));

import { agentModeService } from '../services/agentModeService';
import { runStopRequestIncumbentJudge } from '../services/stopRequestJudgeService';

const callLLM = agentModeService.callLLM as jest.Mock;

describe('canonical stop-request incumbent judge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns yes from the same Gemini one-word contract', async () => {
    callLLM.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'yes' } }],
    });
    const result = await runStopRequestIncumbentJudge('please stop now');
    expect(result).toMatchObject({
      stop: true,
      failed: false,
      truncated: false,
    });
    expect(callLLM).toHaveBeenCalledTimes(1);
    const [model, messages, options] = callLLM.mock.calls[0];
    expect(model).toBe('gemini-3.1-flash-lite');
    expect(messages[1]).toEqual({ role: 'user', content: 'please stop now' });
    expect(options).toMatchObject({
      temperature: 0,
      max_completion_tokens: 500,
      taskClass: 'scheduled_background',
    });
  });

  it('preserves fail-safe false on incumbent failure', async () => {
    callLLM.mockRejectedValue(new Error('offline'));
    const result = await runStopRequestIncumbentJudge('please stop now');
    expect(result).toMatchObject({
      stop: false,
      failed: true,
      truncated: false,
    });
  });

  it('marks truncation but preserves the parsed boolean', async () => {
    callLLM.mockResolvedValue({
      choices: [{ finish_reason: 'length', message: { content: 'yes' } }],
    });
    const result = await runStopRequestIncumbentJudge('pause');
    expect(result).toMatchObject({
      stop: true,
      failed: false,
      truncated: true,
    });
  });

  it('caps the exact user payload at 2500 characters', async () => {
    callLLM.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'no' } }],
    });
    await runStopRequestIncumbentJudge('x'.repeat(3000));
    expect(callLLM.mock.calls[0][1][1].content).toHaveLength(2500);
  });
});
