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
});
