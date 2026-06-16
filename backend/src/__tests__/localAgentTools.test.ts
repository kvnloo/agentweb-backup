import { buildLocalAgentResult } from '../emma/localAgentTools';

describe('buildLocalAgentResult', () => {
  it('maps a successful relay response with no error', () => {
    const r = buildLocalAgentResult({ ok: true, result: 'page text', session_id: 's1', returncode: 0 }, []);
    expect(r).toEqual({ success: true, result: 'page text', session_id: 's1', returncode: 0 });
  });

  it('passes a relay error through on failure', () => {
    const r = buildLocalAgentResult({ ok: false, error: 'navigation blocked', returncode: 1 }, []);
    expect(r.success).toBe(false);
    expect(r.error).toBe('navigation blocked');
  });

  describe('Theme 1 — failure must never be opaque', () => {
    it('uses `result` as the reason when the relay returns ok:false with no error', () => {
      // the run_local "Tool returned success=false" class: detail was in result
      const r = buildLocalAgentResult({ ok: false, result: 'Page returned a 500 error screen', returncode: 1 }, []);
      expect(r.success).toBe(false);
      expect(r.error).toBe('Page returned a 500 error screen');
    });

    it('falls back to a returncode message when there is no error and no usable result', () => {
      const r = buildLocalAgentResult({ ok: false, returncode: 137 }, []);
      expect(r.error).toBe('Local agent task failed (returncode 137)');
    });

    it('uses returncode -1 when the relay omits it', () => {
      const r = buildLocalAgentResult({ ok: false }, []);
      expect(r.error).toBe('Local agent task failed (returncode -1)');
    });

    it('does not treat a non-string result as the reason', () => {
      const r = buildLocalAgentResult({ ok: false, result: { foo: 1 }, returncode: 2 }, []);
      expect(r.error).toBe('Local agent task failed (returncode 2)');
      expect(r.result).toEqual({ foo: 1 });
    });
  });

  it('includes screenshot_urls when present', () => {
    const r = buildLocalAgentResult({ ok: true, result: '', returncode: 0 }, ['https://s3/a.png']);
    expect(r.screenshot_urls).toEqual(['https://s3/a.png']);
  });

  it('still surfaces a non-fatal error on a successful run (backward compatible)', () => {
    const r = buildLocalAgentResult({ ok: true, result: 'ok', error: 'a screenshot failed to upload', returncode: 0 }, []);
    expect(r.success).toBe(true);
    expect(r.error).toBe('a screenshot failed to upload');
  });

  it('omits the error field when a success has none', () => {
    const r = buildLocalAgentResult({ ok: true, result: 'ok', returncode: 0 }, []);
    expect('error' in r).toBe(false);
  });
});
