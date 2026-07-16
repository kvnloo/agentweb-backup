import {
  buildLocalAgentResult,
  isProcessCrashReturncode,
  isLikelyRelayTimeoutKill,
  buildLocalAgentCrashResult,
  buildLocalAgentTimeoutResult,
  classifyRelayProcessCrash,
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

  it('holds exactly at the -2 / 128 thresholds it depends on (off-by-one guard)', () => {
    expect(isProcessCrashReturncode(-2)).toBe(true);  // first signal code past the -1 sentinel
    expect(isProcessCrashReturncode(128)).toBe(false); // 128 = 128+0, no signal → not a crash
  });
});

/**
 * ENG-339 refix — returncode -9/137 is NOT unique to OOM. The relay SIGKILLs the
 * worker on its OWN per-task timeout (runner.py) and returns HTTP 200 + returncode
 * -9, indistinguishable from OOM by code alone. A slow-but-healthy task (the
 * 3-subreddit digest needing >120s) must be treated as a retryable timeout, not a
 * non-retryable crash. We disambiguate by elapsed wall-time.
 */
describe('isLikelyRelayTimeoutKill — timeout-kill vs genuine crash (ENG-339)', () => {
  it('flags a SIGKILL that ran the full timeout window as a relay timeout', () => {
    expect(isLikelyRelayTimeoutKill(-9, 120_000, 120)).toBe(true);
    expect(isLikelyRelayTimeoutKill(137, 118_000, 120)).toBe(true); // shell encoding, just shy of the window
  });

  it('does NOT flag a SIGKILL that died well under the timeout (genuine OOM crash)', () => {
    expect(isLikelyRelayTimeoutKill(-9, 12_000, 120)).toBe(false);
    expect(isLikelyRelayTimeoutKill(137, 5_000, 120)).toBe(false);
  });

  it('only treats SIGKILL as timeout-ambiguous — other fatal signals are always crashes', () => {
    expect(isLikelyRelayTimeoutKill(-11, 120_000, 120)).toBe(false); // SIGSEGV never comes from the timeout path
    expect(isLikelyRelayTimeoutKill(-6, 120_000, 120)).toBe(false);  // SIGABRT
  });

  it('is robust to a missing/invalid elapsed or timeout', () => {
    expect(isLikelyRelayTimeoutKill(-9, NaN, 120)).toBe(false);
    expect(isLikelyRelayTimeoutKill(-9, 120_000, 0)).toBe(false);
  });
});

describe('buildLocalAgentTimeoutResult — graceful, RETRYABLE timeout (ENG-339)', () => {
  it('returns success:true so it does not trip the repeated-failure breaker', () => {
    const r = buildLocalAgentTimeoutResult(-9, 120);
    expect(r.success).toBe(true);
    expect(r.reason).toBe('timed_out');
    expect(toolResultError(r)).toBeNull();
  });

  it('preserves the retry path with a backed-off, capped timeout', () => {
    const r = buildLocalAgentTimeoutResult(-9, 120);
    expect(r.suggestedTimeoutSeconds).toBe(240);
    expect(r.formattedContent).toContain('Retry run_local_agent_task');
    expect(r.formattedContent).toContain('240');
  });

  it('caps the suggested timeout at 900 and, at the ceiling, stops retrying', () => {
    expect(buildLocalAgentTimeoutResult(-9, 600).suggestedTimeoutSeconds).toBe(900);
    const atMax = buildLocalAgentTimeoutResult(-9, 900);
    expect(atMax.suggestedTimeoutSeconds).toBe(900);
    expect(atMax.formattedContent).not.toContain('Retry run_local_agent_task');
    expect(atMax.formattedContent.toLowerCase()).toContain('fall back');
  });

  it('does NOT mislabel a timeout as out of memory', () => {
    expect(buildLocalAgentTimeoutResult(-9, 120).message.toLowerCase()).not.toContain('memory');
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

/**
 * ENG-339 — classifyRelayProcessCrash is the routing extracted from the
 * run_local_agent_task handler: the parsed.ok guard + the timeout-vs-crash split
 * that were previously only reachable through the live relay path (uncoverable by
 * browser/curl, per the manual-test note). These lock the exact wiring the handler
 * now delegates to, without mocking the transport.
 */
describe('classifyRelayProcessCrash — handler routing (ENG-339)', () => {
  it('routes a fast SIGKILL (well under the timeout) to a non-retryable crash', () => {
    const r = classifyRelayProcessCrash({ ok: false, returncode: -9 }, 12_000, 120);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.reason).toBe('crashed');
    expect(toolResultError(r)).toBeNull(); // does not trip the repeated-failure breaker
  });

  it('routes a SIGKILL at the end of the timeout window to a retryable timeout', () => {
    const r = classifyRelayProcessCrash({ ok: false, returncode: -9 }, 120_000, 120);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('timed_out');
    expect(toolResultError(r)).toBeNull();
  });

  it('also routes the 137 shell encoding (128+9) as a crash', () => {
    const r = classifyRelayProcessCrash({ ok: false, returncode: 137 }, 5_000, 120);
    expect(r!.reason).toBe('crashed');
  });

  it('returns null for a normal non-zero task failure (returncode 1) — falls through to real error handling', () => {
    expect(classifyRelayProcessCrash({ ok: false, returncode: 1 }, 5_000, 120)).toBeNull();
  });

  it('returns null when the worker succeeded, even if a returncode is present', () => {
    expect(classifyRelayProcessCrash({ ok: true, returncode: -9 }, 5_000, 120)).toBeNull();
  });

  it('returns null for the -1 "returncode omitted" sentinel and a missing returncode', () => {
    expect(classifyRelayProcessCrash({ ok: false, returncode: -1 }, 5_000, 120)).toBeNull();
    expect(classifyRelayProcessCrash({ ok: false }, 5_000, 120)).toBeNull();
  });

  it('treats a non-SIGKILL fatal signal at the timeout window as a crash, not a timeout', () => {
    // SIGSEGV never comes from the relay timeout path, so elapsed time must not flip it.
    const r = classifyRelayProcessCrash({ ok: false, returncode: -11 }, 120_000, 120);
    expect(r!.reason).toBe('crashed');
  });
});
