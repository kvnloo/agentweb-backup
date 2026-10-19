import { classifyToolFailureType } from '../utils/toolFailureType';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { toolResultError } from '../utils/toolResultError';

/**
 * ENG-1888 AC1/AC3: every create_html_from_template failure row in prod
 * Dev-AW-LoopEvents (2026-06-13..2026-10-07, 26 rows) was either a caller
 * argument mismatch, a missing/invalid template (config), or an LLM output
 * defect. Two shapes were mis-bucketed as `bug`, inflating the tool-bug rate:
 *   - "Missing required array variables: ..."  (8 rows) -> schema_reject
 *   - "Invalid template structure: missing html_content or subject" -> config
 * Messages below are the verbatim sanitized prod strings.
 */
describe('ENG-1888 create_html_from_template failure classification', () => {
  it('message-only: "Missing required array variables" is a schema reject, not a bug', () => {
    const msg = 'Missing required array variables: breakdowns_n_recommendation';
    expect(classifyToolErrorClass(new Error(msg))).toBe('invalid_args');
    expect(classifyToolFailureType('Error', msg)).toBe('schema_reject');
  });

  it('scalar "Missing required variables" stays a schema reject', () => {
    expect(classifyToolFailureType('Error', 'Missing required variables: unsubscribe_url')).toBe('schema_reject');
  });

  it('tool-declared class flows through toolResultError for the invalid-template result', () => {
    const err = toolResultError({
      success: false,
      errorClass: 'not_found',
      message: "Invalid template structure: missing html_content or subject (template 'x').",
    });
    expect(err).toBeInstanceOf(Error);
    const cls = classifyToolErrorClass(err);
    expect(cls).toBe('not_found');
    expect(classifyToolFailureType(cls, (err as Error).message)).toBe('config');
  });

  it('tool-declared invalid_output stays in the investigate (bug) set', () => {
    const err = toolResultError({ success: false, errorClass: 'invalid_output', message: 'Failed to parse LLM response' });
    expect(classifyToolErrorClass(err)).toBe('invalid_output');
    expect(classifyToolFailureType('invalid_output', 'Failed to parse LLM response')).toBe('bug');
  });
});
