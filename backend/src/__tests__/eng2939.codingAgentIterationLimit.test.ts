/**
 * ENG-2939: coding_agent iteration-limit stops must tell the parent the edits are saved and
 * to continue with the remaining work, instead of re-running the whole task.
 */
import { iterationLimitMessage } from '../services/codingAgentService';
import { classifyCodingAgentFailure } from '../services/codingAgentFailureClass';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { toolResultError } from '../utils/toolResultError';

const SUMMARY = 'Coding agent hit the iteration limit (50). Files edited: lib/google-ads.ts, components/landing/google-ads-tag.tsx.';

describe('ENG-2939 coding_agent iteration-limit message', () => {
  it('with saved edits, names the branch and asks for only the remaining work', () => {
    const msg = iterationLimitMessage(SUMMARY, ['lib/google-ads.ts', 'components/landing/google-ads-tag.tsx'], 'agentweb-preview');
    expect(msg.startsWith(SUMMARY)).toBe(true);
    expect(msg).toContain('saved on draft branch agentweb-preview');
    expect(msg).toMatch(/Do NOT re-run the whole task/);
    expect(msg).toMatch(/ONLY the remaining work/);
  });

  it('with no edits, adds no continuation guidance', () => {
    const none = 'Coding agent hit the iteration limit (50). No files were edited.';
    expect(iterationLimitMessage(none, [], 'agentweb-preview')).toBe(none);
  });

  it('still reports as a failure classed invalid_output (not hidden)', () => {
    const r = { success: false, iterations: 50, terminationReason: 'iteration_limit' as const,
      message: iterationLimitMessage(SUMMARY, ['lib/google-ads.ts'], 'agentweb-preview') };
    const err = toolResultError({ success: false, error: r.message, errorClass: classifyCodingAgentFailure(r) });
    expect(classifyToolErrorClass(err)).toBe('invalid_output');
  });
});
