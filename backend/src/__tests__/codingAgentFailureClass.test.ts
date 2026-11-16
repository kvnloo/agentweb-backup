/**
 * ENG-1949 — coding_agent's generic `Error` cluster. Fixtures are synthetic,
 * shaped after the production agent_tool_failed rows (no customer data).
 */
import { classifyCodingAgentFailure } from '../services/codingAgentFailureClass';
import type { CodingAgentResult } from '../services/codingAgentService';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { toolResultError } from '../utils/toolResultError';

const failed = (over: Partial<CodingAgentResult>): CodingAgentResult => ({
  success: false, message: '', iterations: 3, ...over,
});

/** Mirrors the coding_agent tool's failure shape -> telemetry class. */
const telemetryClass = (r: CodingAgentResult) =>
  classifyToolErrorClass(toolResultError({ success: false, error: r.message, errorClass: classifyCodingAgentFailure(r) }));

describe('ENG-1949 coding_agent failure classification', () => {
  it('prose sub-agent summary with failed acceptance -> invalid_output, not Error', () => {
    const r = failed({ message: 'Done! The hero headline was updated.\n\nAcceptance failed (1/1 checks failed).', state: 'failed' });
    expect(telemetryClass(r)).toBe('invalid_output');
  });

  it('iteration-limit exhaustion -> invalid_output', () => {
    const r = failed({ message: 'Coding agent hit the iteration limit (50). Files edited: app/page.tsx' });
    expect(telemetryClass(r)).toBe('invalid_output');
  });

  it('LLM transport "Connection error." -> network', () => {
    const r = failed({ message: 'Coding agent encountered an error: Connection error.' });
    expect(telemetryClass(r)).toBe('network');
  });

  it('unrecognised internal error -> upstream_5xx, never generic Error', () => {
    const r = failed({ message: 'Coding agent encountered an error: something odd' });
    expect(telemetryClass(r)).toBe('upstream_5xx');
  });

  it('missing landing page on preview prep -> not_found', () => {
    const r = failed({ message: 'Cannot prepare preview branch: no landing page found with id noop' });
    expect(telemetryClass(r)).toBe('not_found');
  });

  it('permanent preview setup errors -> upstream_rejected (non-retryable)', () => {
    expect(telemetryClass(failed({ message: 'Cannot prepare preview branch: landing page has no GitHub repository' }))).toBe('upstream_rejected');
    expect(telemetryClass(failed({ message: 'Cannot prepare preview branch: invalid GitHub repo URL' }))).toBe('upstream_rejected');
  });

  it('not authorized -> auth; timeout -> timeout', () => {
    expect(telemetryClass(failed({ message: 'Not authorized to edit this landing page.', notAuthorized: true }))).toBe('auth');
    expect(telemetryClass(failed({ message: 'Coding agent timed out after 15 minutes.', state: 'timed_out' }))).toBe('timeout');
  });

  it('a successful run carries no error class (no false failure)', () => {
    expect(classifyCodingAgentFailure({ success: true, message: 'Done!' })).toBeUndefined();
  });

  it('an unknown declared errorClass is ignored (falls back to message classification)', () => {
    const err = toolResultError({ success: false, error: 'Request failed with status code 422', errorClass: 'made_up' });
    expect(classifyToolErrorClass(err)).toBe('invalid_args');
  });
});
