import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { toolResultError, extractToolResultMessage } from '../utils/toolResultError';

describe('extractToolResultMessage', () => {
  it('reads a string error/message/content (existing behavior)', () => {
    expect(extractToolResultMessage({ error: 'boom' })).toBe('boom');
    expect(extractToolResultMessage({ message: 'nope' })).toBe('nope');
    expect(extractToolResultMessage({ content: 'text' })).toBe('text');
  });

  it('reads content as an array of {text} parts, skipping parts without text', () => {
    expect(extractToolResultMessage({ content: [{ text: 'a' }, { foo: 1 }, { text: 'b' }] })).toBe('a\nb');
  });

  describe('hardening — object-shaped errors (previously dropped → opaque fallback)', () => {
    it('extracts a Meta Graph-style nested error with subcode', () => {
      const meta = { success: false, error: { message: 'Invalid OAuth token', code: 190, error_subcode: 460 } };
      expect(extractToolResultMessage(meta)).toBe('Invalid OAuth token (code 190)');
    });
    it('prefers error_user_msg when present', () => {
      const meta = { error: { error_user_msg: 'Your ad account is restricted', message: 'generic', code: 100 } };
      expect(extractToolResultMessage(meta)).toBe('Your ad account is restricted (code 100)');
    });
    it('returns the nested message without code when no code is present', () => {
      expect(extractToolResultMessage({ error: { message: 'something failed' } })).toBe('something failed');
    });
    it('falls back to error_user_title, then detail, when no message', () => {
      expect(extractToolResultMessage({ error: { error_user_title: 'Restricted' } })).toBe('Restricted');
      expect(extractToolResultMessage({ error: { detail: 'low-level detail' } })).toBe('low-level detail');
    });
    it('uses error_subcode as the code when code is absent', () => {
      expect(extractToolResultMessage({ error: { message: 'm', error_subcode: 460 } })).toBe('m (code 460)');
    });
    it('ignores an empty-string code', () => {
      expect(extractToolResultMessage({ error: { message: 'm', code: '' } })).toBe('m');
    });
  });

  describe('hardening — status/reason fallback for tools that set no message', () => {
    it('surfaces a status instead of an empty string', () => {
      expect(extractToolResultMessage({ success: false, status: 'invalid_parameters' })).toBe('status: invalid_parameters');
    });
    it('surfaces a reason', () => {
      expect(extractToolResultMessage({ success: false, reason: 'quota exhausted' })).toBe('reason: quota exhausted');
    });
    it('ignores unhelpful status values ("error"/"false")', () => {
      expect(extractToolResultMessage({ success: false, status: 'error' })).toBe('');
      expect(extractToolResultMessage({ success: false, status: 'false' })).toBe('');
    });
  });

  it('returns empty string when the result genuinely carries no reason', () => {
    expect(extractToolResultMessage({ success: false })).toBe('');
  });
});

describe('toolResultError', () => {
  it('returns null for non-failure / non-object results', () => {
    expect(toolResultError(null)).toBeNull();
    expect(toolResultError('str')).toBeNull();
    expect(toolResultError({ success: true })).toBeNull();
    expect(toolResultError({})).toBeNull();
  });

  it('builds an Error from success:false, preferring the specific reason', () => {
    const err = toolResultError({ success: false, error: { message: 'Ad account not configured', code: 100 } });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe('Ad account not configured (code 100)');
  });

  it('builds an Error from isError:true', () => {
    expect(toolResultError({ isError: true, message: 'tool blew up' })!.message).toBe('tool blew up');
  });

  it('falls back to the generic string ONLY when there is truly no reason', () => {
    expect(toolResultError({ success: false })!.message).toBe('Tool returned success=false');
    expect(toolResultError({ isError: true })!.message).toBe('Tool returned isError=true');
  });

  it('a status-only failure is no longer opaque', () => {
    // the run_local "Tool returned success=false" class: now names the status
    expect(toolResultError({ success: false, status: 'rejected_out_of_scope' })!.message).toBe('status: rejected_out_of_scope');
  });

  it('preserves a tracking-preflight policy block as a typed error for telemetry', () => {
    const err = toolResultError({
      success: false,
      blocked: true,
      reason: 'tracking_preflight',
      error: 'Launch blocked: pre-flight tracking check failed.',
    });

    expect(err!.name).toBe('ToolResultPolicyBlockedError');
    expect(err).toMatchObject({ reason: 'tracking_preflight' });
    expect(classifyToolErrorClass(err)).toBe('policy_blocked');
  });

  it('preserves a scheduled publish-consent refusal as a typed policy block', () => {
    const err = toolResultError({
      success: false,
      blocked: true,
      reason: 'publish_consent',
      error: 'post_on_connected_account was not executed: this unattended scheduled run is not authorized to publish.',
    });

    expect(err!.name).toBe('ToolResultPolicyBlockedError');
    expect(err).toMatchObject({ reason: 'publish_consent' });
  });

  describe('ENG-1300 — a numeric `code` on the result rides along on the reconstructed Error', () => {
    it('attaches success:false code so status-based classification still fires', () => {
      const err = toolResultError({
        success: false,
        code: 403,
        error: 'Your X account is missing the "list.read" permission needed to read X Lists. Go to Settings → Connected Accounts and reconnect your X account to grant List access.',
      });
      expect(err).toMatchObject({ code: 403 });
      // The real regression: this message text alone matches none of
      // classifyToolErrorClass's message-based patterns, so without `.code`
      // riding along it silently fell back to the generic 'Error' class.
      expect(classifyToolErrorClass(err)).toBe('auth');
    });

    it('attaches isError:true code the same way', () => {
      const err = toolResultError({ isError: true, code: 429, message: 'Too many requests' });
      expect(err).toMatchObject({ code: 429 });
      expect(classifyToolErrorClass(err)).toBe('rate_limit');
    });

    it('leaves the Error without a code when the result carries none (no regression)', () => {
      const err = toolResultError({ success: false, error: 'Ad account not configured' });
      expect((err as { code?: number })?.code).toBeUndefined();
    });
  });

  describe('ENG-1300 follow-up — a numeric `status` field is read the same way as `code`', () => {
    it('attaches a top-level numeric status (HubSpot/Attio convention) to the reconstructed Error', () => {
      const err = toolResultError({
        success: false,
        status: 403,
        error: 'This app does not have MISSING_SCOPES permission for this call.',
      });
      expect(err).toMatchObject({ code: 403 });
      expect(classifyToolErrorClass(err)).toBe('auth');
    });

    it('prefers `code` over `status` when a result somehow carries both', () => {
      const err = toolResultError({ success: false, code: 429, status: 500, error: 'x' });
      expect(err).toMatchObject({ code: 429 });
    });

    it('ignores a `status` outside the HTTP range (100-599) as garbage, not a real status', () => {
      const err = toolResultError({ success: false, status: 3, error: 'x' });
      expect((err as { code?: number })?.code).toBeUndefined();
    });

    it('ignores a non-numeric `code`/`status` (e.g. a string vendor code) rather than misreading it', () => {
      const err = toolResultError({ success: false, code: 'ThrottlingException', status: 'rejected', error: 'x' });
      expect((err as { code?: number })?.code).toBeUndefined();
    });
  });

  describe('ENG-1162 — read_file_content publisher-refusal result through the real pipeline', () => {
    it('classifies a 403 publisher refusal as publisher_refused, not auth, end to end', () => {
      // The exact shape readFileContent's catch block returns for a 401/403 from
      // an external publisher (agentModeService.ts) — no numeric code/status/
      // statusCode field, by design: a future field with one of those names
      // would let toolResultError's withCode() attach it, and
      // classifyToolErrorClass checks the numeric-status branch BEFORE the
      // message-based publisher_refused match, silently reintroducing the
      // 'auth' misclassification this ticket fixed.
      const result = {
        success: false,
        message: 'The publisher refused this fetch (HTTP 403: Forbidden) — this is a site-side access block (bot filtering, WAF, or paywall), not an AgentWeb account or permissions problem.',
        error: 'The publisher refused this fetch (HTTP 403: Forbidden) — this is a site-side access block (bot filtering, WAF, or paywall), not an AgentWeb account or permissions problem.',
        file_url: 'https://files.gao.gov/example.pdf',
      };

      const err = toolResultError(result);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: number })?.code).toBeUndefined();
      expect(classifyToolErrorClass(err)).toBe('publisher_refused');
    });
  });

  describe('ENG-1300 CodeRabbit follow-up — a numeric `statusCode` field (AWS SDK v2 convention) is preferred', () => {
    it('attaches a top-level numeric statusCode to the reconstructed Error', () => {
      const err = toolResultError({ success: false, statusCode: 403, error: 'Access Denied' });
      expect(err).toMatchObject({ code: 403 });
      expect(classifyToolErrorClass(err)).toBe('auth');
    });

    it('prefers `statusCode` over `code` and `status` when a result carries all three', () => {
      const err = toolResultError({ success: false, statusCode: 403, code: 429, status: 500, error: 'x' });
      expect(err).toMatchObject({ code: 403 });
    });

    it('ignores a `statusCode` outside the HTTP range (100-599) as garbage, not a real status', () => {
      const err = toolResultError({ success: false, statusCode: 3, error: 'x' });
      expect((err as { code?: number })?.code).toBeUndefined();
    });
  });
});
