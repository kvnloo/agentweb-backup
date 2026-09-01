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

  // ENG-1256: the system prompt's own scheduling-suggestion example
  // (agentModeSystemPrompt.ts ~183-184) shows a genuine user-directed question
  // can live ENTIRELY inside the mandated "👉 Next Step:" trailer, with no body
  // text before it. Stripping the trailer for the judge must not blind it to
  // this class of halt by short-circuiting to "no" without ever asking the judge.
  describe('a halt phrased entirely inside the Next Step trailer', () => {
    const trailerOnlyHalt =
      "👉 Next Step: Want this to run automatically every week? I can set up a scheduled chat for you — just say 'schedule this' and I'll configure it.";

    it('is invisible to the regex fast-path (expected — the trailer is excluded from it)', () => {
      expect(scheduledRunAwaitsConfirmation(trailerOnlyHalt)).toBe(false);
    });

    it('still invokes the LLM judge on the ORIGINAL unstripped content, not an empty string', async () => {
      callLLM.mockResolvedValue(judge('yes'));
      const result = await scheduledTurnDefersToUser(trailerOnlyHalt);
      expect(result).toBe(true);
      expect(callLLM).toHaveBeenCalledTimes(1);
      const [, messages] = callLLM.mock.calls[0];
      const judgedContent = messages[1].content;
      expect(judgedContent).toContain('Want this to run automatically every week?');
    });

    it('classifyScheduledContinuationAsync still returns "confirmation" for a trailer-only halt', async () => {
      callLLM.mockResolvedValue(judge('yes'));
      expect(await classifyScheduledContinuationAsync({ content: trailerOnlyHalt })).toBe('confirmation');
    });
  });

  // ENG-1256: a genuine body-level halt with a benign trailer must still judge
  // with the trailer excluded — the trailer should never reach the judge as if
  // it were part of the message's closing content.
  it('judges a genuine body halt with the benign trailer excluded from the judged content', async () => {
    const bodyHaltWithTrailer =
      `${novelHalt} 👉 Next Step: Ask Harsha to confirm whether this shipped with data-plane approval.`;
    callLLM.mockResolvedValue(judge('yes'));
    const result = await scheduledTurnDefersToUser(bodyHaltWithTrailer);
    expect(result).toBe(true);
    expect(callLLM).toHaveBeenCalledTimes(1);
    const [, messages] = callLLM.mock.calls[0];
    const judgedContent = messages[1].content;
    expect(judgedContent).not.toContain('Ask Harsha to confirm');
    expect(judgedContent).toContain(novelHalt);
  });
});

// ENG-480: a live scheduled run reframed the impossible per-item pattern correctly
// but STILL dead-ended by asking the human to supply a scope parameter (time
// window) before delivering. That phrasing slipped the regex, so it depended
// entirely on the Gemini judge — which fails safe (false) when the provider is
// unavailable, letting the run finish blocked. These patterns catch the halt
// class DETERMINISTICALLY so the completion gate fires without a second LLM.
describe('scheduledRunAwaitsConfirmation — ENG-480 scope-clarification halt (deterministic)', () => {
  const eng480Halt =
    'One question so I scope it right: what time window do you want? "Daily" = last ' +
    '24 hours (ending now), or a specific calendar day? 👉 Next Step: Reply "last 24h" ' +
    "(or give me an exact date range) and I'll generate the report.";

  it('catches the exact ENG-480 halt via regex — no LLM judge needed', () => {
    expect(scheduledRunAwaitsConfirmation(eng480Halt)).toBe(true);
  });

  it('catches "Reply \'<value>\' (or …)" that dangles the deliverable behind a reply', () => {
    expect(scheduledRunAwaitsConfirmation('Reply "last 24h" (or a date range) and I will generate it.')).toBe(true);
    expect(scheduledRunAwaitsConfirmation("Reply 'all users' or name one account.")).toBe(true);
  });

  it('catches "what <scope> do you want?" scope-clarification questions', () => {
    expect(scheduledRunAwaitsConfirmation('what date range do you want me to use?')).toBe(true);
    expect(scheduledRunAwaitsConfirmation('what time window do you want?')).toBe(true);
  });

  it('does NOT fire on a delivered report with an optional follow-up next-step', () => {
    const delivered =
      'Daily User Activity Report — window: last 24h, avg 4.7/5. 👉 Next Step: the two ' +
      'score-3 sessions stemmed from card-emission failures — want me to pull those two ' +
      'transcripts and file a bug?';
    expect(scheduledRunAwaitsConfirmation(delivered)).toBe(false);
  });

  it('does NOT fire on a report that merely quotes the word reply', () => {
    expect(scheduledRunAwaitsConfirmation('The user said "reply to my thread"; report delivered below.')).toBe(false);
  });
});
