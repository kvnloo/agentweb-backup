/**
 * Unit tests for the shared loop digest builder (core/digest/loopDigest.ts) —
 * the error-handling branches the per-loop characterization tests don't reach:
 * missing slackUserId (default + custom warning) and Slack post failure.
 */

import {
  analystFindingsBody,
  buildLoopDigestLines,
  postLoopDigest,
  LOOP_DIGEST_FOOTER,
  type LoopDigestTemplate,
} from '../loops/core/digest/loopDigest';
import type { LoopRunResult } from '../loops/core/types';

function fakeResult(over: Partial<LoopRunResult>): LoopRunResult {
  return { runId: 'run_x', eventsScanned: 0, proposals: [], ...over } as unknown as LoopRunResult;
}

const template: LoopDigestTemplate<number> = {
  logTag: '[test-loop]',
  header: (date) => `*Test Loop ${date}*`,
  counts: (r, n) => `Scanned: ${r.eventsScanned}  |  Extra: ${n}`,
  emptyBody: () => ['empty body'],
  quietBody: () => ['quiet body'],
  findingsBody: (r) => r.proposals.map((p, i) => `${i + 1}. ${p.hypothesis}`),
};

describe('buildLoopDigestLines', () => {
  it('always starts with the header + Run ID + counts', () => {
    const lines = buildLoopDigestLines(fakeResult({ eventsScanned: 0 }), template, 7);
    expect(lines[0]).toBe(`*Test Loop ${new Date().toISOString().slice(0, 10)}*`);
    expect(lines[1]).toBe('Run ID: `run_x`');
    expect(lines[2]).toBe('Scanned: 0  |  Extra: 7');
    expect(lines).toContain('empty body');
  });

  it('does not append the cloud-dev dispatch footer when there are no proposals', () => {
    const lines = buildLoopDigestLines(fakeResult({ eventsScanned: 5 }), template, 0);
    expect(lines).toContain('quiet body');
    expect(lines).not.toContain(LOOP_DIGEST_FOOTER);
  });

  it('selects the quiet body when events were seen but nothing fired', () => {
    const lines = buildLoopDigestLines(fakeResult({ eventsScanned: 5 }), template, 0);
    expect(lines).toContain('quiet body');
    expect(lines).not.toContain('empty body');
  });

  it('selects the findings body when proposals fired and appends footerExtra', () => {
    const withExtra: LoopDigestTemplate<number> = { ...template, footerExtra: ['extra footer'] };
    const proposals = [{ hypothesis: 'h1', kind: 'copy', payload: {} }] as unknown as LoopRunResult['proposals'];
    const lines = buildLoopDigestLines(fakeResult({ eventsScanned: 5, proposals }), withExtra, 0);
    expect(lines).toContain('1. h1');
    expect(lines[lines.length - 1]).toBe('extra footer');
    expect(lines[lines.length - 2]).toBe(LOOP_DIGEST_FOOTER);
  });

  it('omits the extra-sections block (and its blank line) when it returns nothing', () => {
    const withSections: LoopDigestTemplate<number> = {
      ...template,
      extraSections: (r) => (r.eventsScanned > 10 ? ['section line'] : []),
    };
    const quiet = buildLoopDigestLines(fakeResult({ eventsScanned: 5 }), withSections, 0);
    expect(quiet).not.toContain('section line');
    const loud = buildLoopDigestLines(fakeResult({ eventsScanned: 11 }), withSections, 0);
    expect(loud).toContain('section line');
  });
});

describe('analystFindingsBody', () => {
  it('renders hypothesis + Kind lines, with Fix only when the payload has a directive', () => {
    const proposals = [
      { hypothesis: 'h1', kind: 'copy', payload: { directive: 'do it' } },
      { hypothesis: 'h2', kind: 'code_change', payload: {} },
    ] as unknown as LoopRunResult['proposals'];
    expect(analystFindingsBody(fakeResult({ eventsScanned: 2, proposals }))).toEqual([
      '*What I found*',
      '1. h1',
      '   Kind: `copy`  |  Fix: do it',
      '2. h2',
      '   Kind: `code_change`',
    ]);
  });
});

describe('postLoopDigest', () => {
  it('warns with the default message and posts nothing when slackUserId is missing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const slack = { postMessage: jest.fn() };

    await postLoopDigest(fakeResult({}), slack, undefined, template, 0);

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[test-loop] no approval.slackUserId — skipping DM');
    warn.mockRestore();
  });

  it('uses the template missingUserWarning override when provided', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const custom: LoopDigestTemplate<number> = {
      ...template,
      missingUserWarning: 'no approval.slackUserId configured — skipping daily DM',
    };

    await postLoopDigest(fakeResult({}), { postMessage: jest.fn() }, undefined, custom, 0);

    expect(warn).toHaveBeenCalledWith('[test-loop] no approval.slackUserId configured — skipping daily DM');
    warn.mockRestore();
  });

  it('posts the joined lines to the given user', async () => {
    const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    const proposals = [{ hypothesis: 'h1', kind: 'copy', payload: {} }] as unknown as LoopRunResult['proposals'];

    await postLoopDigest(fakeResult({ eventsScanned: 5, proposals }), slack, 'U123', template, 3);

    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    const [user, markdown] = slack.postMessage.mock.calls[0];
    expect(user).toBe('U123');
    expect(markdown).toContain('1. h1');
    expect(markdown).toContain(LOOP_DIGEST_FOOTER);
  });

  it('claims the daily digest before posting', async () => {
    const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    const claimDailyDigest = jest.fn().mockResolvedValue(true);

    await postLoopDigest(fakeResult({}), slack, 'U123', template, 0, { claimDailyDigest });

    expect(claimDailyDigest).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      'U123',
      'run_x',
    );
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
  });

  it('skips Slack when the daily digest was already claimed', async () => {
    const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    const claimDailyDigest = jest.fn().mockResolvedValue(false);

    await postLoopDigest(fakeResult({}), slack, 'U123', template, 0, { claimDailyDigest });

    expect(claimDailyDigest).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('skips Slack when the daily digest claim fails', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    const claimDailyDigest = jest.fn().mockRejectedValue(new Error('dynamo down'));

    await postLoopDigest(fakeResult({}), slack, 'U123', template, 0, { claimDailyDigest });

    expect(error).toHaveBeenCalledWith(
      '[test-loop] daily digest claim failed; skipping Slack DM:',
      expect.any(Error),
    );
    expect(slack.postMessage).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('never throws when the Slack post fails — logs and returns', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const slack = { postMessage: jest.fn().mockRejectedValue(new Error('slack down')) };

    await expect(postLoopDigest(fakeResult({}), slack, 'U123', template, 0)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith('[test-loop] Slack DM post failed:', expect.any(Error));
    error.mockRestore();
  });
});
