import {
  buildLocalAgentResult,
  isProcessCrashReturncode,
  buildLocalAgentCrashResult,
} from '../emma/localAgentTools';
import { toolResultError } from '../utils/toolResultError';

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

/**
 * ENG-339 — a scheduled Reddit-digest run failed because the local-agent worker
 * crashed 4x with returncode -9 (OS OOM-killer / SIGKILL). Each crash was mapped
 * to success:false → downgraded to agent_tool_failed → the model retried, crashing
 * the worker again and tripping the repeated-failure breaker. A process-level crash
 * is INFRASTRUCTURE (it recurs on every task, whatever we send), not a task failure,
 * so it must degrade gracefully like an unavailable relay: stop retrying, fall back.
 */
describe('isProcessCrashReturncode — worker killed by a signal (ENG-339)', () => {
  it('flags returncode -9 (OOM SIGKILL, subprocess signal encoding)', () => {
    expect(isProcessCrashReturncode(-9)).toBe(true);
  });

  it('flags returncode 137 (128+9, shell signal encoding for SIGKILL)', () => {
    expect(isProcessCrashReturncode(137)).toBe(true);
  });

  it('flags other fatal signals (SIGSEGV, SIGABRT) in both encodings', () => {
    expect(isProcessCrashReturncode(-11)).toBe(true); // SIGSEGV (subprocess)
    expect(isProcessCrashReturncode(-6)).toBe(true);  // SIGABRT (subprocess)
    expect(isProcessCrashReturncode(139)).toBe(true); // 128+11 SIGSEGV (shell)
  });

  it('does NOT flag the -1 "returncode omitted" sentinel', () => {
    expect(isProcessCrashReturncode(-1)).toBe(false);
  });

  it('does NOT flag a clean exit (0) or a normal non-zero task error (1, 2)', () => {
    expect(isProcessCrashReturncode(0)).toBe(false);
    expect(isProcessCrashReturncode(1)).toBe(false);
    expect(isProcessCrashReturncode(2)).toBe(false);
  });

  it('does NOT flag a missing or non-numeric returncode', () => {
    expect(isProcessCrashReturncode(undefined)).toBe(false);
    expect(isProcessCrashReturncode(NaN)).toBe(false);
  });
});

describe('buildLocalAgentCrashResult — graceful, non-retryable crash (ENG-339)', () => {
  it('returns success:true so the dispatch layer does not record agent_tool_failed', () => {
    const r = buildLocalAgentCrashResult(-9);
    expect(r.success).toBe(true);
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe('crashed');
    expect(r.returncode).toBe(-9);
  });

  it('is NOT downgraded to an error by toolResultError (the dispatch downgrade gate)', () => {
    expect(toolResultError(buildLocalAgentCrashResult(-9))).toBeNull();
    expect(toolResultError(buildLocalAgentCrashResult(137))).toBeNull();
  });

  it('tells the model NOT to retry run_local_agent_task and to use fallback tools', () => {
    const r = buildLocalAgentCrashResult(-9);
    expect(r.formattedContent).toContain('Do NOT retry run_local_agent_task');
    expect(r.formattedContent).toContain('you_search_web');
  });

  it('names likely OOM for SIGKILL codes so the reason is actionable', () => {
    expect(buildLocalAgentCrashResult(-9).message.toLowerCase()).toContain('memory');
    expect(buildLocalAgentCrashResult(137).message.toLowerCase()).toContain('memory');
  });

  it('does not claim OOM for a non-SIGKILL crash', () => {
    const r = buildLocalAgentCrashResult(-11);
    expect(r.message.toLowerCase()).not.toContain('memory');
    expect(r.message.toLowerCase()).toContain('crash');
  });
});
