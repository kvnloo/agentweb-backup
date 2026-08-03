import { classifyToolFailureType, FAILURE_TYPES } from '../utils/toolFailureType';

/**
 * Decision-layer classification for agent tool failures. Sits on top of the
 * technical errorClass taxonomy (classifyToolErrorClass) and answers "what kind
 * of action does this failure need" so retire/keep decisions and the weekly
 * scorecard run off failure TYPE, not raw failure rate (per dev.md 2026-06-13).
 *
 * Strings below are real error messages sampled from Dev-AW-LoopEvents.
 */
describe('classifyToolFailureType', () => {
  it('exposes the five canonical types', () => {
    expect([...FAILURE_TYPES].sort()).toEqual(
      ['bug', 'by_design', 'config', 'model_uninstalled_tool', 'schema_reject'].sort(),
    );
  });

  describe('model_uninstalled_tool — model called a tool the user does not have', () => {
    it('classifies "not available / install the required skill"', () => {
      expect(
        classifyToolFailureType('Error', 'Tool "search_tool_response" is not available. You must install the required skill first'),
      ).toBe('model_uninstalled_tool');
    });
    it('takes precedence over the "required" keyword (not a schema reject)', () => {
      // message contains "required" but is an uninstalled-tool error, not arg validation
      expect(
        classifyToolFailureType('Error', 'Tool "wait_seconds" is not available. You must install the required skill first'),
      ).toBe('model_uninstalled_tool');
    });
  });

  describe('by_design — validator/policy correctly rejected the request', () => {
    it('classifies a policy_blocked errorClass', () => {
      expect(classifyToolFailureType('policy_blocked', 'blocked by gateway policy')).toBe('by_design');
    });
    it('classifies run_local_agent_task scope rejection (historical events)', () => {
      expect(
        classifyToolFailureType('Error', 'Task rejected: local agent may only be used for web browsing and data extraction'),
      ).toBe('by_design');
    });
    it('classifies the local agent deprecation stub error (ENG-383) — retired-by-design, not a bug', () => {
      expect(
        classifyToolFailureType(
          'Error',
          'local_agent_deprecated: The local agent relay was retired in July 2026. For web research use you_search_web / you_search_news; other local-agent workloads are being replaced (see ENG-381).',
        ),
      ).toBe('by_design');
    });
    it('classifies the LinkedIn anti-spam invitation delay', () => {
      expect(classifyToolFailureType('Error', 'Should delay new invitation to this recipient')).toBe('by_design');
    });
    it('classifies a sequencing guard, NOT as schema_reject despite "required"', () => {
      expect(
        classifyToolFailureType('Error', 'Cannot mark steps as completed. Required function calls have not been made yet'),
      ).toBe('by_design');
    });
  });

  describe('schema_reject — arguments failed validation before execution', () => {
    it('classifies an invalid_args errorClass', () => {
      expect(
        classifyToolFailureType('invalid_args', 'Tool "read_tool_response" arguments failed schema validation before execution.'),
      ).toBe('schema_reject');
    });
    it('classifies "Both s3_key and query are required"', () => {
      expect(classifyToolFailureType('Error', 'Both s3_key and query are required')).toBe('schema_reject');
    });
    it('classifies a single missing required arg', () => {
      expect(classifyToolFailureType('Error', 's3_key is required')).toBe('schema_reject');
    });
  });

  describe('config — environment/credentials/quota, fixable without touching tool logic', () => {
    it('classifies rate_limit / 429', () => {
      expect(classifyToolFailureType('rate_limit', '429 Too Many Requests')).toBe('config');
    });
    it('classifies a provider 429 from the MESSAGE even when errorClass is the unhelpful "Error" (old events)', () => {
      // pre-classifier events recorded errorClass:'Error' on every failure, so
      // the message must carry the rate-limit signal on its own.
      expect(
        classifyToolFailureType('Error', 'Error: 429 Too Many Requests\n{"type":"ErrorResponse"}'),
      ).toBe('config');
    });
    it('classifies an auth errorClass', () => {
      expect(classifyToolFailureType('auth', 'Unauthorized')).toBe('config');
    });
    it('classifies a not_found errorClass (missing resource)', () => {
      expect(classifyToolFailureType('not_found', 'Request failed with status code 404')).toBe('config');
    });
    it('classifies a missing S3 bucket', () => {
      expect(classifyToolFailureType('Error', 'The specified bucket does not exist')).toBe('config');
    });
    it('classifies the Slack bot not being in the channel', () => {
      expect(classifyToolFailureType('Error', 'The Slack bot is not a member of channel C09JU')).toBe('config');
    });
    it('classifies a landing-page authorization gap', () => {
      expect(classifyToolFailureType('Error', 'Not authorized to edit this landing page.')).toBe('config');
    });
    it('classifies bad credentials', () => {
      expect(classifyToolFailureType('Error', 'Authentication Failed: Bad credentials')).toBe('config');
    });
    it('classifies a Meta insights job timeout (config pattern, not transient)', () => {
      expect(classifyToolFailureType('timeout', 'Meta Insights Job timed out.')).toBe('config');
    });
  });

  describe('bug — genuine code defect / unknown to investigate (default)', () => {
    it('classifies a network drop (transient, but worth investigating if recurring)', () => {
      expect(classifyToolFailureType('network', 'socket hang up')).toBe('bug');
    });
    it('classifies an opaque error', () => {
      expect(classifyToolFailureType('Error', 'An unknown error has occurred.')).toBe('bug');
    });
    it('classifies an opaque success=false', () => {
      expect(classifyToolFailureType('Error', 'Tool returned success=false')).toBe('bug');
    });
    it('classifies a playwright locator timeout as a bug (browser robustness), NOT config', () => {
      // distinct from an AbortController "operation was aborted" — a 5s locator
      // timeout is real browser flakiness to fix, not tunable infra.
      expect(classifyToolFailureType('Error', 'TimeoutError: Timeout 5000ms exceeded waiting for locator')).toBe('bug');
    });
    it('handles empty/undefined input without throwing', () => {
      expect(classifyToolFailureType('', '')).toBe('bug');
      expect(classifyToolFailureType(undefined as unknown as string, undefined as unknown as string)).toBe('bug');
    });
  });

  describe('tuned rules — reclassify the previously-bug-tagged misclassifications', () => {
    it('LinkedIn "Cannot resend yet" is by_design (platform state)', () => {
      expect(classifyToolFailureType('Error', 'Cannot resend yet')).toBe('by_design');
    });
    it('LinkedIn "Recipient cannot be reached" is by_design', () => {
      expect(classifyToolFailureType('Error', 'Recipient cannot be reached')).toBe('by_design');
    });
    it('"No search results found" is by_design, not a bug', () => {
      expect(classifyToolFailureType('Error', 'No search results found')).toBe('by_design');
    });
    it('a corrupted/password-protected PDF is by_design (bad input)', () => {
      expect(
        classifyToolFailureType('Error', 'Failed to parse PDF file. The file may be corrupted or password-protected. Invalid PDF structure'),
      ).toBe('by_design');
    });
    it('a too-long LinkedIn invitation note is schema_reject (arg constraint)', () => {
      expect(
        classifyToolFailureType('Error', 'Invitation message is too long (201 characters). LinkedIn limits invitation notes to 200 characters'),
      ).toBe('schema_reject');
    });
    it('the summarizer cascade is config (downstream of a 429)', () => {
      expect(classifyToolFailureType('Error', 'Unable to retrieve a Summarizer summary.')).toBe('config');
    });
    it('a perform_data_analysis 404 is config (missing resource)', () => {
      expect(classifyToolFailureType('Error', 'Request failed with status code 404')).toBe('config');
    });
    it('an AbortController timeout is config (tunable infra), not a code bug', () => {
      expect(classifyToolFailureType('timeout', 'AbortError: This operation was aborted')).toBe('config');
    });
  });
});

describe('payment_required → config (ENG-664)', () => {
  it('treats X credit exhaustion as a config/quota gap, not a tool bug', () => {
    expect(classifyToolFailureType('payment_required')).toBe('config');
  });

  it('classifies a 402 credit message as config even without an errorClass', () => {
    expect(
      classifyToolFailureType('', 'X API error (HTTP 402): AgentWeb X plan out of credits'),
    ).toBe('config');
  });
});

describe('402 alternation is HTTP-status-anchored, not a bare number (ENG-664)', () => {
  it('does NOT classify an unrelated "402" (id / line number) as config', () => {
    expect(classifyToolFailureType('', 'failed at line 402 while parsing row')).toBe('bug');
    expect(classifyToolFailureType('', 'record 402 not found')).not.toBe('config');
  });
  it('still classifies a real HTTP 402 credit message as config', () => {
    expect(classifyToolFailureType('', 'X API error (HTTP 402): out of credits')).toBe('config');
    expect(classifyToolFailureType('', 'status code 402 payment required')).toBe('config');
  });
});
