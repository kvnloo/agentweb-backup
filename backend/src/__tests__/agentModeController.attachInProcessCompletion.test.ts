/**
 * ENG-1495: attachInProcessCompletion (the durable-landing-build reconnect path —
 * genPromise is the SAME generateSessionResponse() promise from the primary
 * /generate handler, reattached after a timeout so the detached build's eventual
 * result still reaches the user over Socket.IO) had no direct test coverage. Its
 * happy path can't be reached cleanly through the full generateResponse HTTP
 * handler without faking withGenerationTimeout's internal timeout-then-later-
 * resolve race, so this tests it directly — exported for exactly this reason,
 * matching this file's existing convention (activeSessionGenerations,
 * AUTO_WORK_PLAN_CONTINUATION_MAX_ROUNDS are exported the same way).
 */
import { attachInProcessCompletion } from '../controllers/agentModeController';
import { claimCompletion } from '../services/durableLandingService';
import { markRunTerminal } from '../services/agentMode/runStore';

jest.mock('../services/durableLandingService', () => ({
  claimCompletion: jest.fn(),
}));
jest.mock('../services/agentMode/runStore', () => ({
  ...jest.requireActual('../services/agentMode/runStore'),
  markRunTerminal: jest.fn().mockResolvedValue(undefined),
}));

const mockIoEmit = jest.fn();
const mockIoTo = jest.fn().mockReturnValue({ emit: mockIoEmit });
jest.mock('../server', () => ({
  io: { to: mockIoTo },
}));

const mockClaimCompletion = claimCompletion as jest.Mock;
const mockMarkRunTerminal = markRunTerminal as jest.Mock;

describe('attachInProcessCompletion (ENG-1495)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delivers the real persisted messageIndex alongside the content, not just the content', async () => {
    mockClaimCompletion.mockResolvedValue(true);
    const genPromise = Promise.resolve({
      content: 'Your landing page "Pulseboard" is live.',
      toolCalls: [],
      responseMessages: [
        {
          role: 'assistant',
          content: 'Your landing page "Pulseboard" is live.',
          timestamp: '2026-09-10T00:00:00.000Z',
          metadata: { timestamp: '2026-09-10T00:00:00.000Z' },
          messageIndex: 23,
        },
      ],
    });

    attachInProcessCompletion(genPromise, 'page-in-flight', 'user-lp', 'session-lp');
    await genPromise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockClaimCompletion).toHaveBeenCalledWith('page-in-flight');
    expect(mockIoTo).toHaveBeenCalledWith('user:user-lp');
    expect(mockIoEmit).toHaveBeenCalledWith(
      'session-message-appended',
      expect.objectContaining({
        sessionId: 'session-lp',
        message: expect.objectContaining({
          content: 'Your landing page "Pulseboard" is live.',
          messageIndex: 23,
        }),
      }),
    );
  });

  it('omits messageIndex (does not throw) when responseMessages has no assistant entry', async () => {
    mockClaimCompletion.mockResolvedValue(true);
    const genPromise = Promise.resolve({
      content: 'Your landing page is live.',
      toolCalls: [],
      responseMessages: [],
    });

    attachInProcessCompletion(genPromise, 'page-in-flight', 'user-lp', 'session-lp');
    await genPromise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockIoEmit).toHaveBeenCalledWith(
      'session-message-appended',
      expect.objectContaining({
        message: { role: 'assistant', content: 'Your landing page is live.' },
      }),
    );
  });

  it('does not deliver anything when claimCompletion loses the race to the redeploy poller', async () => {
    mockClaimCompletion.mockResolvedValue(false);
    const genPromise = Promise.resolve({
      content: 'Your landing page is live.',
      toolCalls: [],
      responseMessages: [{ role: 'assistant', content: 'Your landing page is live.', messageIndex: 5 }],
    });

    attachInProcessCompletion(genPromise, 'page-in-flight', 'user-lp', 'session-lp');
    await genPromise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('terminal-marks the returned run only after detached success', async () => {
    mockClaimCompletion.mockResolvedValue(true);
    const genPromise = Promise.resolve({ content: 'ready', responseMessages: [] });

    attachInProcessCompletion(genPromise, 'page-in-flight', 'user-lp', 'session-lp', 'run-1');
    expect(mockMarkRunTerminal).not.toHaveBeenCalled();
    await genPromise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMarkRunTerminal).toHaveBeenCalledWith(
      'run-1',
      'completed',
      { finishReason: 'detached_completed' },
    );
  });

  it('terminal-marks the returned run failed when detached work rejects', async () => {
    const genPromise = Promise.reject(new Error('build failed'));

    attachInProcessCompletion(genPromise, 'page-in-flight', 'user-lp', 'session-lp', 'run-2');
    await expect(genPromise).rejects.toThrow('build failed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMarkRunTerminal).toHaveBeenCalledWith(
      'run-2',
      'failed',
      { finishReason: 'detached_failed' },
    );
  });
});
