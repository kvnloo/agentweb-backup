/**
 * ENG-124: `wait_seconds` was failing on its FIRST call because the model
 * (gemini / opus) routinely omits the cosmetic `reason` argument, and the tool
 * schema marked `reason` as required — so validateAndRepairToolArgs rejected the
 * call BEFORE execution and it was recorded as a failed tool call.
 *
 * `reason` is only a human-facing label and must not be required. These tests pin
 * that contract against the SHARED schema the tool actually uses
 * (WAIT_SECONDS_PARAMETERS), so re-adding `reason` to `required` fails here.
 */
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';
import { WAIT_SECONDS_PARAMETERS } from '../utils/waitSecondsBudget';

describe('wait_seconds arg contract (ENG-124)', () => {
  it('does not mark reason as required (seconds only)', () => {
    expect(WAIT_SECONDS_PARAMETERS.required).toEqual(['seconds']);
    expect(WAIT_SECONDS_PARAMETERS.required).not.toContain('reason');
    // reason is still an advertised, optional property
    expect(WAIT_SECONDS_PARAMETERS.properties.reason).toBeDefined();
  });

  it('accepts a call with only seconds (reason omitted) — the failing case', () => {
    const result = validateAndRepairToolArgs({
      toolName: 'wait_seconds',
      args: { seconds: 30 },
      inputSchema: WAIT_SECONDS_PARAMETERS as any,
      effect: 'read',
    });
    expect(result.status).toBe('valid');
  });

  it('accepts a call with both seconds and reason', () => {
    const result = validateAndRepairToolArgs({
      toolName: 'wait_seconds',
      args: { seconds: 30, reason: 'waiting for the test run to finish' },
      inputSchema: WAIT_SECONDS_PARAMETERS as any,
      effect: 'read',
    });
    expect(result.status).toBe('valid');
  });

  it('still rejects a call missing the required seconds argument', () => {
    const result = validateAndRepairToolArgs({
      toolName: 'wait_seconds',
      args: { reason: 'waiting' },
      inputSchema: WAIT_SECONDS_PARAMETERS as any,
      effect: 'read',
    });
    expect(result.status).toBe('invalid');
  });
});
