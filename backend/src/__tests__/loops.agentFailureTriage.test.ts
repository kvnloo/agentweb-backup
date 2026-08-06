/**
 * ENG-820 — the tool-reliability digest must triage on the `failureType` it
 * already records, and rank by impact rather than rate.
 *
 * The digest posted "8 failing tools / fix specs: 8" every day for nine
 * consecutive sampled days with the same tools at the same rates, and nothing
 * moved. Measured Jul 28 – Aug 1 (217 failures): 77 of them — 35% — were not
 * handler bugs at all (`config` 54, `by_design` 15, `model_uninstalled_tool` 8),
 * and every one still got "investigate the handler + propose a robustness fix".
 *
 * Dispatching a depleted X API credit balance to an engineer as a handler bug
 * is how a digest trains people to ignore it.
 *
 * Nothing here changes how tools execute. It changes what gets selected and
 * what the message says.
 */

import { AgentFailureRuleSet } from '../loops/instances/agent-mode/failureRuleSet';
import { EVT_TOOL_FAILED, EVT_TOOL_INVOKED } from '../loops/instances/agent-mode/eventTypes';
import type { NormalizedEvent, TimeWindow } from '../loops/core/types';
import { asSubjectId } from '../loops/core/types';

const WINDOW: TimeWindow = {
  start: new Date('2026-07-28T00:00:00Z'),
  end: new Date('2026-08-01T00:00:00Z'),
};

let seq = 0;
function evt(
  eventType: string,
  toolName: string,
  extra: Record<string, string | number | boolean | null> = {},
): NormalizedEvent {
  seq++;
  return {
    subjectId: asSubjectId(`session-${seq}`),
    eventType,
    ts: new Date('2026-07-30T00:00:00Z'),
    dimensions: { toolName, ...extra },
  };
}

/** n invocations of which f failed, all with the given failureType. */
function toolEvents(
  toolName: string,
  invocations: number,
  failures: number,
  failureType: string,
  errorClass = 'Error',
  errorMessage = 'boom',
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (let i = 0; i < invocations; i++) out.push(evt(EVT_TOOL_INVOKED, toolName));
  for (let i = 0; i < failures; i++) {
    out.push(evt(EVT_TOOL_FAILED, toolName, { failureType, errorClass, errorMessage }));
  }
  return out;
}

const payloads = (proposals: any[]) =>
  proposals.map((p) => p.payload).filter((p) => 'toolName' in p);

describe('ENG-820 — failure triage by failureType', () => {
  const rules = () => new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });

  it('AC5: a by_design failure never produces a dispatch', async () => {
    // `by_design` means the tool worked as intended. Proposing a fix for it is
    // strictly noise, and it is 15 of every 217 failures.
    const events = toolEvents('policy_gated_tool', 10, 9, 'by_design', 'policy_blocked');

    const proposals = await rules().evaluate(events, WINDOW);

    expect(payloads(proposals).map((p: any) => p.toolName)).not.toContain('policy_gated_tool');
  });

  it('excludes model_uninstalled_tool — a registry/prompt issue, not a handler bug', async () => {
    const events = toolEvents('ghost_tool', 10, 8, 'model_uninstalled_tool', 'tool_unavailable');

    const proposals = await rules().evaluate(events, WINDOW);

    expect(payloads(proposals).map((p: any) => p.toolName)).not.toContain('ghost_tool');
  });

  it('AC1: a config failure is never dispatched as a handler fix', async () => {
    // The real case: 16 failures of "X API error (HTTP 402): Payment Required —
    // credits depleted". That is a billing decision, not a code change.
    const events = toolEvents(
      'twitter_outreach', 20, 16, 'config', 'auth',
      'X API error (HTTP 402): Payment Required — credits depleted',
    );

    const proposals = await rules().evaluate(events, WINDOW);
    const twitter: any = payloads(proposals).find((p: any) => p.toolName === 'twitter_outreach');

    expect(twitter).toBeDefined();
    expect(twitter.failureType).toBe('config');
    expect(twitter.directive).not.toMatch(/investigate the handler/i);
    expect(twitter.directive).not.toMatch(/regression test/i);
  });

  it('AC2: a config failure names the required human action', async () => {
    const events = toolEvents(
      'linkedin_outreach', 10, 6, 'config', 'auth',
      'account is disconnected from Unipile',
    );

    const proposals = await rules().evaluate(events, WINDOW);
    const li: any = payloads(proposals).find((p: any) => p.toolName === 'linkedin_outreach');

    expect(li.directive).toMatch(/reconnect|re-authorise|re-authorize|top up|grant/i);
    // The operator has to know WHICH thing to go fix.
    expect(li.directive).toContain('linkedin_outreach');
  });

  it('still tells an engineer to investigate a real bug', async () => {
    const events = toolEvents('broken_tool', 10, 8, 'bug', 'Error', 'TypeError: undefined');

    const proposals = await rules().evaluate(events, WINDOW);
    const bug: any = payloads(proposals).find((p: any) => p.toolName === 'broken_tool');

    expect(bug.failureType).toBe('bug');
    expect(bug.directive).toMatch(/investigate/i);
  });

  it('AC3+AC4: ranks by failure COUNT, so the biggest source outranks a small 100% tool', async () => {
    // The exact inversion from the window: save_memory was the single largest
    // source of failures (33) and never once appeared, because 33% does not
    // crack a top-8 sorted by percentage. get_meta_ads_metrics appeared in all
    // nine digests on 4–8 failures because 6/6 is 100%.
    const events = [
      ...toolEvents('save_memory', 100, 33, 'bug'),
      ...toolEvents('get_meta_ads_metrics', 6, 6, 'bug'),
    ];

    const proposals = await rules().evaluate(events, WINDOW);
    const order = payloads(proposals).map((p: any) => p.toolName);

    expect(order.indexOf('save_memory')).toBeLessThan(order.indexOf('get_meta_ads_metrics'));
  });

  it('AC4: the Jul 28 – Aug 1 shape — save_memory dispatches, twitter credit-exhaustion does not', async () => {
    const events = [
      ...toolEvents('save_memory', 100, 33, 'bug'),
      ...toolEvents('twitter_outreach', 20, 16, 'config', 'auth', 'credits depleted'),
      ...toolEvents('policy_gated_tool', 10, 9, 'by_design', 'policy_blocked'),
    ];

    const proposals = await rules().evaluate(events, WINDOW);
    const handlerFixes = payloads(proposals)
      .filter((p: any) => p.failureType === 'bug' || p.failureType === 'schema_reject')
      .map((p: any) => p.toolName);

    expect(handlerFixes).toContain('save_memory');
    expect(handlerFixes).not.toContain('twitter_outreach');
    expect(handlerFixes).not.toContain('policy_gated_tool');
  });

  it('a schema_reject is a contract fix, and says so rather than "harden the handler"', async () => {
    const events = toolEvents('strict_tool', 10, 7, 'schema_reject', 'invalid_args');

    const proposals = await rules().evaluate(events, WINDOW);
    const s: any = payloads(proposals).find((p: any) => p.toolName === 'strict_tool');

    expect(s.failureType).toBe('schema_reject');
    expect(s.directive).toMatch(/schema|contract|declared/i);
  });

  it('an unclassified failure is still dispatched rather than silently dropped', async () => {
    // Failing closed the other way would hide real bugs from before the
    // failureType backfill. Absent classification must not mean "ignore".
    const events = toolEvents('legacy_tool', 10, 8, '', 'Error');

    const proposals = await rules().evaluate(events, WINDOW);

    expect(payloads(proposals).map((p: any) => p.toolName)).toContain('legacy_tool');
  });
});

/**
 * Defect 3 — the cap was silent. Every digest read "Failing tools: 8", always
 * exactly 8, with nothing saying the list was a top-N slice. Read as the
 * complete set, that is a misleading number, not merely an incomplete one.
 */
describe('ENG-820 — the digest states truncation', () => {
  const countsLine = (shown: number, truncated: number): string => {
    const { _internal } = require('../loops/instances/agent-mode/index');
    return _internal.digestTemplate().counts({
      eventsScanned: 100,
      // Real tool-proposal shape. The earlier fixture used bare `{}`, which is
      // not what the policy emits — and once the digest started counting tool
      // proposals specifically, that placeholder silently counted as zero.
      proposals: Array.from({ length: shown }, (_, i) => ({
        payload: { toolName: `tool_${i}`, failures: shown - i },
      })),
      proposalsTruncated: truncated,
    });
  };

  it('says "showing N of M" when the cap dropped proposals', () => {
    expect(countsLine(8, 5)).toContain('showing 8 of 13');
  });

  it('does not claim truncation when nothing was dropped', () => {
    const line = countsLine(3, 0);
    expect(line).toContain('Failing tools: 3');
    expect(line).not.toContain('showing');
  });

  it('treats a missing truncation count as untruncated rather than throwing', () => {
    const { _internal } = require('../loops/instances/agent-mode/index');
    const line = _internal.digestTemplate().counts({
      eventsScanned: 5,
      proposals: [{ payload: { toolName: 'only_tool', failures: 4 } }],
    });
    expect(line).toContain('Failing tools: 1');
  });
});

/**
 * Greptile review findings on the first cut of this change. Both were real, and
 * both are the kind that make a digest actively misleading rather than merely
 * noisy — which is worse than the problem being fixed.
 */
describe('ENG-820 — mixed classes and non-tool proposals', () => {
  const rules = () => new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });

  it('quotes a message from the SAME class the directive advises on', async () => {
    // Mixed classes, minority class first. Before the fix the representative
    // message stayed pinned to whichever failure arrived first, so a `config`
    // directive could quote a TypeError and send someone to reconnect an
    // account over a code bug.
    const events = [
      ...toolEvents('mixed_tool', 30, 2, 'bug', 'Error', 'TypeError: cannot read property'),
      ...toolEvents('mixed_tool', 0, 12, 'config', 'auth', 'credits depleted — top up required'),
    ];

    const proposals = await rules().evaluate(events, WINDOW);
    const p: any = payloads(proposals).find((x: any) => x.toolName === 'mixed_tool');

    expect(p.failureType).toBe('config');
    expect(p.directive).toContain('credits depleted');
    expect(p.directive).not.toContain('TypeError');
  });

  it('omits the quote entirely rather than borrowing one from another class', async () => {
    // If the dominant class has no message of its own, quoting a different
    // class's message would be worse than saying nothing.
    const events = [
      ...toolEvents('quiet_tool', 30, 2, 'bug', 'Error', 'TypeError: boom'),
      ...toolEvents('quiet_tool', 0, 12, 'config', 'auth', ''),
    ];

    const proposals = await rules().evaluate(events, WINDOW);
    const p: any = payloads(proposals).find((x: any) => x.toolName === 'quiet_tool');

    expect(p.failureType).toBe('config');
    expect(p.directive).not.toContain('TypeError');
  });

  it('the digest counts failing TOOLS, not every proposal', async () => {
    // A claim-mismatch proposal is a whole-run verdict, not a failing tool.
    // Counting it reported "showing 8 of 9" when only 8 tools existed.
    const { _internal } = require('../loops/instances/agent-mode/index');
    const line = _internal.digestTemplate().counts({
      eventsScanned: 100,
      proposals: [
        { payload: { occurrences: 4, sessionIds: [], directive: 'x' } }, // claim mismatch
        { payload: { toolName: 'a', failures: 9 } },
        { payload: { toolName: 'b', failures: 4 } },
      ],
      proposalsTruncated: 0,
    });

    expect(line).toContain('Failing tools: 2');
  });

  it('states the tool total correctly when the cap truncated', () => {
    const { _internal } = require('../loops/instances/agent-mode/index');
    const line = _internal.digestTemplate().counts({
      eventsScanned: 100,
      proposals: [
        { payload: { occurrences: 4, sessionIds: [], directive: 'x' } },
        ...Array.from({ length: 8 }, (_, i) => ({ payload: { toolName: `t${i}`, failures: 9 - i } })),
      ],
      proposalsTruncated: 5,
    });

    // 8 tools shown, 5 dropped — 13 tools, not 14.
    expect(line).toContain('showing 8 of 13');
  });
});

/**
 * Greptile round 3 — the same defect as the message mismatch, one level deeper.
 * Fixing `sampleMessage` per class left `topErrorClass` aggregated globally, so
 * the directive could still cite an error class from a cohort it was not
 * advising on. Every field the operator reads has to come from the same cohort.
 */
describe('ENG-820 — the cited error class matches the chosen failure class', () => {
  const rules = () => new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });

  /**
   * A genuine mismatch needs the GLOBAL dominant error class to differ from the
   * SELECTED cohort's. Two cohorts sharing a class is not enough — my first
   * attempt at this test had config=auth(12) / bug=TypeErrorClass(8), where
   * global and cohort both resolve to `auth`, so it passed with the fix
   * reverted and proved nothing.
   *
   * Here: config is dominant by count (12 v 8), but its own top class is
   * `throttle` (7), while `auth` totals 5 + 8 = 13 globally. So global says
   * `auth`, the config cohort says `throttle`.
   */
  const mixedCohort = (tool: string) => [
    ...toolEvents(tool, 40, 8, 'bug', 'auth', 'TypeError: boom'),
    ...toolEvents(tool, 0, 7, 'config', 'throttle', 'rate limited — raise the quota'),
    ...toolEvents(tool, 0, 5, 'config', 'auth', 'token expired — reconnect'),
  ];

  it('cites the dominant class of the SELECTED cohort, not the global one', async () => {
    const proposals = await rules().evaluate(mixedCohort('mixed_ec'), WINDOW);
    const p: any = payloads(proposals).find((x: any) => x.toolName === 'mixed_ec');

    expect(p.failureType).toBe('config');
    expect(p.topErrorClass).toBe('throttle');
    // `auth` is the GLOBAL winner (13) and belongs mostly to the bug cohort.
    expect(p.topErrorClass).not.toBe('auth');
  });

  it('does not leak the other cohort into the hypothesis either', async () => {
    // The hypothesis is what lands in the Slack digest, so it carries the same
    // obligation as the directive.
    const proposals = await rules().evaluate(mixedCohort('mixed_ec2'), WINDOW);
    const prop: any = proposals.find((x: any) => x.payload?.toolName === 'mixed_ec2');

    expect(prop.hypothesis).toContain('throttle');
    expect(prop.hypothesis).toContain('[config]');
  });

  it('falls back to the global aggregate for unclassified failures', async () => {
    // With no failureType there is no cohort, and global IS the right cohort.
    const events = toolEvents('legacy_ec', 10, 8, '', 'LegacyClass', 'old failure');

    const proposals = await rules().evaluate(events, WINDOW);
    const p: any = payloads(proposals).find((x: any) => x.toolName === 'legacy_ec');

    expect(p.topErrorClass).toBe('LegacyClass');
  });
});

/**
 * Greptile round 4, and the most serious of the four: my triage made the policy
 * HIDE real bugs. Dropping a tool because its dominant class is non-dispatchable
 * discards a recurring `bug` cohort sitting behind a larger `by_design` one —
 * the exact opposite of this issue's intent, which is to remove noise without
 * losing signal.
 *
 * The unit of exclusion is a FAILURE, not a tool.
 */
describe('ENG-820 — a non-actionable majority never hides an actionable minority', () => {
  const rules = () => new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });

  it('still dispatches the bug cohort hiding behind a larger by_design one', async () => {
    const events = [
      ...toolEvents('shadowed_tool', 40, 20, 'by_design', 'policy_blocked'),
      ...toolEvents('shadowed_tool', 0, 10, 'bug', 'TypeErrorClass', 'TypeError: boom'),
    ];

    const proposals = await rules().evaluate(events, WINDOW);
    const p: any = payloads(proposals).find((x: any) => x.toolName === 'shadowed_tool');

    expect(p).toBeDefined();
    expect(p.failureType).toBe('bug');
    // Counts and rate describe the ACTIONABLE cohort, not the raw total.
    expect(p.failures).toBe(10);
    expect(p.directive).toMatch(/investigate/i);
  });

  it('says how many failures it set aside, so the number is not silently smaller', async () => {
    const events = [
      ...toolEvents('shadowed_tool2', 40, 20, 'by_design', 'policy_blocked'),
      ...toolEvents('shadowed_tool2', 0, 10, 'bug', 'TypeErrorClass', 'TypeError: boom'),
    ];

    const proposals = await rules().evaluate(events, WINDOW);
    const prop: any = proposals.find((x: any) => x.payload?.toolName === 'shadowed_tool2');

    expect(prop.hypothesis).toContain('10/40');
    expect(prop.hypothesis).toContain('20 non-actionable excluded');
  });

  it('still drops a tool whose failures are ENTIRELY non-actionable', async () => {
    const events = toolEvents('pure_by_design', 30, 20, 'by_design', 'policy_blocked');

    const proposals = await rules().evaluate(events, WINDOW);

    expect(payloads(proposals).map((p: any) => p.toolName)).not.toContain('pure_by_design');
  });

  it('does not admit a tool whose actionable cohort is below the threshold', async () => {
    // 2 real bugs behind 20 by_design is still below minFailures=3. The gate
    // applies to the actionable cohort, not to the raw total, which would
    // otherwise let a single bug ride in on by_design volume.
    const events = [
      ...toolEvents('mostly_fine', 40, 20, 'by_design', 'policy_blocked'),
      ...toolEvents('mostly_fine', 0, 2, 'bug', 'TypeErrorClass', 'TypeError'),
    ];

    const proposals = await rules().evaluate(events, WINDOW);

    expect(payloads(proposals).map((p: any) => p.toolName)).not.toContain('mostly_fine');
  });
});
