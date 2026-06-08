/**
 * Unit tests for the ai-readiness-funnel digest + funnel tally.
 *
 * Behavioral contract (the thing the audit said the OLD loop got wrong):
 *  - The digest must NEVER say "healthy". On silence it reports the binding
 *    constraint (top-of-funnel volume) instead.
 *  - summarizeFunnel tallies the real funnel shape and drops site-wide `landed`
 *    events that aren't on /ai-readiness.
 */

import { _testing } from '../loops/instances/ai-readiness-funnel';
import type { DynamoPort, DynamoAttributeMap } from '../loops/core/ports';
import type { LoopRunResult } from '../loops/core/types';

const { summarizeFunnel, buildDigestLines, buildDailyDigestClaimItem, postDigest } = _testing;

function dynamoReturning(items: DynamoAttributeMap[]): DynamoPort {
  return {
    query: jest.fn().mockResolvedValue({ items }),
    putItem: jest.fn(),
    getItem: jest.fn(),
  } as unknown as DynamoPort;
}

const NOW_ISO = new Date().toISOString();
let n = 0;
function ev(eventType: string, landerPath = '/ai-readiness'): DynamoAttributeMap {
  return {
    loopId: 'ai-readiness-funnel',
    eventType,
    subjectId: `s${n++}`,
    ts: NOW_ISO,
    dimensions: { landerPath },
  } as unknown as DynamoAttributeMap;
}

function result(over: Partial<LoopRunResult>): LoopRunResult {
  return { runId: 'run_test', eventsScanned: 0, proposals: [], ...over } as unknown as LoopRunResult;
}

describe('ai-readiness-funnel summarizeFunnel', () => {
  it('tallies the funnel and drops site-wide landed not on /ai-readiness', async () => {
    const items = [
      ev('landed'),
      ev('landed'),
      ev('landed'),
      ev('landed', '/'), // off-funnel — must be dropped by the scope
      ev('landed', '/blog'), // off-funnel — dropped
      ev('quiz_started'),
      ev('quiz_started'),
      ev('form_submitted'),
      ev('book_clicked'),
    ];
    const shape = await summarizeFunnel(dynamoReturning(items));
    expect(shape.landed).toBe(3); // only /ai-readiness landings
    expect(shape.quiz_started).toBe(2);
    expect(shape.form_submitted).toBe(1);
    expect(shape.book_clicked).toBe(1);
    expect(shape.signup_clicked).toBe(0);
  });
});

describe('ai-readiness-funnel buildDigestLines — never reports "healthy"', () => {
  it('empty window: says empty, not healthy', () => {
    const lines = buildDigestLines(result({ eventsScanned: 0 }), null).join('\n');
    expect(lines.toLowerCase()).not.toContain('funnel is healthy');
    expect(lines.toLowerCase()).not.toContain('looks healthy');
    expect(lines.toLowerCase()).not.toContain('no issues');
    expect(lines).toContain('empty');
  });

  it('events but no findings + low captures: reports the binding constraint, not healthy', () => {
    const shape = { landed: 49, quiz_started: 20, form_submitted: 4, book_clicked: 1, signup_clicked: 1 };
    const lines = buildDigestLines(result({ eventsScanned: 50, proposals: [] }), shape).join('\n');
    expect(lines.toLowerCase()).not.toContain('funnel is healthy');
    expect(lines.toLowerCase()).not.toContain('looks healthy');
    expect(lines.toLowerCase()).not.toContain('no issues');
    expect(lines).toContain('Binding constraint: top-of-funnel volume');
    expect(lines).toContain('4'); // the capture count is surfaced
  });

  it('healthy capture volume with no leak: still not the word "healthy"', () => {
    const shape = { landed: 800, quiz_started: 400, form_submitted: 120, book_clicked: 40, signup_clicked: 40 };
    const lines = buildDigestLines(result({ eventsScanned: 800, proposals: [] }), shape).join('\n');
    expect(lines.toLowerCase()).not.toContain('funnel is healthy');
    expect(lines.toLowerCase()).not.toContain('looks healthy');
    expect(lines.toLowerCase()).not.toContain('no issues');
    expect(lines).toContain('thinnest');
  });

  it('with findings: lists the hypotheses + directives', () => {
    const proposals = [
      { hypothesis: 'Quiz step drops 40%', kind: 'copy', payload: { directive: 'shorten the quiz to one question' } },
    ];
    const lines = buildDigestLines(
      result({ eventsScanned: 200, proposals: proposals as unknown as LoopRunResult['proposals'] }),
      { landed: 200, quiz_started: 120, form_submitted: 30, book_clicked: 8, signup_clicked: 8 },
    ).join('\n');
    expect(lines).toContain('What I found');
    expect(lines).toContain('Quiz step drops 40%');
    expect(lines).toContain('shorten the quiz to one question');
  });
});

describe('ai-readiness-funnel daily digest posting', () => {
  it('builds a deterministic daily claim row keyed by loop + date', () => {
    const claim = buildDailyDigestClaimItem('2026-06-08', 'U08TM4QFQ1L', 'run_test', new Date('2026-06-08T16:30:00.000Z'));
    expect(claim.loopId).toBe('ai-readiness-funnel#daily-digest');
    expect(claim.tsSession).toBe('2026-06-08');
    expect(claim.subjectId).toBe('U08TM4QFQ1L');
    expect(claim.dimensions.runId).toBe('run_test');
  });

  it('posts the Slack digest when the daily claim succeeds', async () => {
    const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    const claimDigest = jest.fn().mockResolvedValue(true);

    await postDigest(result({ eventsScanned: 0 }), null, slack, 'U08TM4QFQ1L', claimDigest);

    expect(claimDigest).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'U08TM4QFQ1L', 'run_test');
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
  });

  it('skips Slack when another scheduler already claimed the daily digest', async () => {
    const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    const claimDigest = jest.fn().mockResolvedValue(false);

    await postDigest(result({ eventsScanned: 0 }), null, slack, 'U08TM4QFQ1L', claimDigest);

    expect(claimDigest).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});
