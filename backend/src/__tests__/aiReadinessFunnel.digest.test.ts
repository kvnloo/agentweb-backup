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

const {
  summarizeFunnel,
  buildDigestLines,
  buildDailyDigestClaimItem,
  buildLowDataDecisions,
  postDigest,
} = _testing;

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
    const lines = buildDigestLines(
      result({ eventsScanned: 0 }),
      { landed: 0, quiz_started: 0, form_submitted: 0, book_clicked: 0, signup_clicked: 0 },
    ).join('\n');
    expect(lines.toLowerCase()).not.toContain('funnel is healthy');
    expect(lines.toLowerCase()).not.toContain('looks healthy');
    expect(lines.toLowerCase()).not.toContain('no issues');
    expect(lines).toContain('empty');
    expect(lines).toContain('low-data-no-traffic');
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

describe('ai-readiness-funnel low-data decisions', () => {
  it('empty window: recommends a telemetry and traffic sanity check instead of waiting for significance', () => {
    const decisions = buildLowDataDecisions({ landed: 0, quiz_started: 0, form_submitted: 0, book_clicked: 0, signup_clicked: 0 });

    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe('low-data-no-traffic');
    expect(decisions[0].confidence).toBe('low');
    expect(decisions[0].requiresApproval).toBe(true);
  });

  it('low captures: recommends an awareness/routing action even when there are too few samples', () => {
    const decisions = buildLowDataDecisions({ landed: 19, quiz_started: 2, form_submitted: 9, book_clicked: 0, signup_clicked: 1 });

    expect(decisions.map((d) => d.id)).toContain('low-data-awareness-routing');
    expect(decisions[0].requiresApproval).toBe(true);
    expect(decisions[0].evidence).toContain('9 captures');
  });

  it('quiz-start leak: recommends a first-screen hypothesis from weak signal', () => {
    const decisions = buildLowDataDecisions({ landed: 30, quiz_started: 2, form_submitted: 1, book_clicked: 0, signup_clicked: 0 });

    expect(decisions.map((d) => d.id)).toContain('low-data-quiz-start-leak');
    expect(decisions.find((d) => d.id === 'low-data-quiz-start-leak')?.action).toContain('above-the-fold');
  });

  it('captured leads with no next-step clicks: recommends fixing the thank-you CTA', () => {
    const decisions = buildLowDataDecisions({ landed: 40, quiz_started: 16, form_submitted: 12, book_clicked: 0, signup_clicked: 0 });

    expect(decisions.map((d) => d.id)).toContain('low-data-post-capture-cta');
    expect(decisions.find((d) => d.id === 'low-data-post-capture-cta')?.evidence).toContain('0 next-step clicks');
  });

  it('digest includes startup decisions when findings are empty', () => {
    const lines = buildDigestLines(
      result({ eventsScanned: 31, proposals: [] }),
      { landed: 19, quiz_started: 2, form_submitted: 9, book_clicked: 0, signup_clicked: 1 },
    ).join('\n');

    expect(lines).toContain('Startup decisions');
    expect(lines).toContain('Needs approval');
    expect(lines).toContain('low-data-awareness-routing');
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
