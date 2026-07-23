/**
 * Unit tests for the LLM-judge confirmation-halt fallback (ENG-369).
 *
 * Live claude-opus-4-8 scheduled runs proved the regex detector cannot keep up:
 * the model invents a new phrasing of "stop and ask the human" nearly every run.
 * scheduledTurnDefersToUser() therefore adds a cheap, phrasing-independent LLM
 * judge that runs ONLY when the regex misses, and fails SAFE (any error → false),
 * so it can only ADD detections, never remove the regex's.
 */

import { agentModeService } from '../services/agentModeService';
import {
  scheduledTurnDefersToUser,
  classifyScheduledContinuationAsync,
  scheduledRunAwaitsConfirmation,
} from '../controllers/agentModeController';

const judge = (word: string) =>
  ({ choices: [{ message: { content: word } }] }) as any;

describe('scheduledTurnDefersToUser — LLM-judge fallback', () => {
  let callLLM: jest.SpyInstance;

  beforeEach(() => {
    callLLM = jest.spyOn(agentModeService, 'callLLM');
  });
  afterEach(() => {
    callLLM.mockRestore();
  });

  // A phrasing the regex does NOT catch, so the judge decides.
  const novelHalt =
    "I've sketched the plan above — what's your preference on the breakdown before I build it?";

  it('regex fast-path returns true WITHOUT calling the LLM judge', async () => {
    // Sanity: this is a regex hit, so no LLM call should be made.
    expect(scheduledRunAwaitsConfirmation("Reply 'go' to proceed.")).toBe(true);
    const result = await scheduledTurnDefersToUser("Reply 'go' to proceed.");
    expect(result).toBe(true);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('falls back to the LLM judge when the regex misses, and honors a "yes" verdict', async () => {
    expect(scheduledRunAwaitsConfirmation(novelHalt)).toBe(false); // regex misses it
    callLLM.mockResolvedValue(judge('yes'));
    const result = await scheduledTurnDefersToUser(novelHalt);
    expect(result).toBe(true);
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it('honors a "no" verdict — a delivered report with optional next-steps is not a halt', async () => {
    const delivered =
      'Report complete — table below. Next steps you could take: connect Bob on LinkedIn.';
    callLLM.mockResolvedValue(judge('no'));
    expect(await scheduledTurnDefersToUser(delivered)).toBe(false);
  });

  it('fails SAFE — a judge error/timeout returns false (never forces a continuation)', async () => {
    callLLM.mockRejectedValue(new Error('boom'));
    expect(await scheduledTurnDefersToUser(novelHalt)).toBe(false);
  });

  it('classifyScheduledContinuationAsync returns "confirmation" when the judge flags a regex-missed halt', async () => {
    callLLM.mockResolvedValue(judge('yes'));
    expect(await classifyScheduledContinuationAsync({ content: novelHalt })).toBe('confirmation');
  });

  it('budget truncation still takes precedence and never invokes the judge', async () => {
    const reason = await classifyScheduledContinuationAsync({
      content: novelHalt,
      truncatedByStepBudget: true,
    });
    expect(reason).toBe('budget');
    expect(callLLM).not.toHaveBeenCalled();
  });
});
