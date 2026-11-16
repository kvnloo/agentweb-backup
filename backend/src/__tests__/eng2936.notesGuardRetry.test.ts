/**
 * ENG-2936: retry policy for the notes compare-and-set on the public forward-lead merge.
 *
 * Measured on Dev-AW-Leads (2026-11-16): with no wait between attempts and a 5-attempt cap,
 * six concurrent same-lead appends lost one writer to an exhausted retry in 4 of 6 runs. The
 * writer that loses every round needs one attempt per competitor, so the cap must exceed the
 * burst it is meant to absorb, and attempts are spaced with jitter so losers do not re-collide.
 */
import { mergeWithNotesRetry, NOTES_GUARD_MAX_ATTEMPTS } from '../utils/leadSubmissionHistory';

const lost = () => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });

describe('ENG-2936 mergeWithNotesRetry', () => {
  it('runs once and never waits when the first write lands', async () => {
    const mergeOnce = jest.fn().mockResolvedValue(undefined);
    const reread = jest.fn();
    const sleep = jest.fn().mockResolvedValue(undefined);
    await mergeWithNotesRetry({ leadId: 'l1' }, mergeOnce, reread, { sleep });
    expect(mergeOnce).toHaveBeenCalledTimes(1);
    expect(reread).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('re-reads and re-merges against the fresh row after a lost guard', async () => {
    const fresh = { leadId: 'l1', notes: 'seed\n\nother visitor' };
    const mergeOnce = jest.fn().mockRejectedValueOnce(lost()).mockResolvedValueOnce(undefined);
    const reread = jest.fn().mockResolvedValue(fresh);
    await mergeWithNotesRetry({ leadId: 'l1', notes: 'seed' }, mergeOnce, reread, { sleep: async () => undefined });
    expect(mergeOnce).toHaveBeenCalledTimes(2);
    expect(mergeOnce.mock.calls[1][0]).toBe(fresh);
  });

  it('recognises the SDK v3 shape (error name) as a lost guard', async () => {
    const v3 = Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    const mergeOnce = jest.fn().mockRejectedValueOnce(v3).mockResolvedValueOnce(undefined);
    await mergeWithNotesRetry({ leadId: 'l1' }, mergeOnce, async () => null, { sleep: async () => undefined });
    expect(mergeOnce).toHaveBeenCalledTimes(2);
  });

  it('keeps the row it had when the re-read comes back empty', async () => {
    const initial = { leadId: 'l1', notes: 'seed' };
    const mergeOnce = jest.fn().mockRejectedValueOnce(lost()).mockResolvedValueOnce(undefined);
    await mergeWithNotesRetry(initial, mergeOnce, async () => null, { sleep: async () => undefined });
    expect(mergeOnce.mock.calls[1][0]).toBe(initial);
  });

  it('rethrows any other error at once, without waiting or re-reading', async () => {
    const boom = Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' });
    const mergeOnce = jest.fn().mockRejectedValue(boom);
    const reread = jest.fn();
    const sleep = jest.fn();
    await expect(mergeWithNotesRetry({ leadId: 'l1' }, mergeOnce, reread, { sleep })).rejects.toBe(boom);
    expect(mergeOnce).toHaveBeenCalledTimes(1);
    expect(reread).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the attempt cap and surfaces the lost guard', async () => {
    const mergeOnce = jest.fn().mockRejectedValue(lost());
    await expect(
      mergeWithNotesRetry({ leadId: 'l1' }, mergeOnce, async () => ({ leadId: 'l1' }), { sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(mergeOnce).toHaveBeenCalledTimes(NOTES_GUARD_MAX_ATTEMPTS);
  });

  it('allows more attempts than a six-way burst needs', () => {
    expect(NOTES_GUARD_MAX_ATTEMPTS).toBeGreaterThanOrEqual(7);
  });

  it('waits before every retry, with a jittered delay that grows and stays bounded', async () => {
    const mergeOnce = jest.fn().mockRejectedValue(lost());
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };
    await expect(
      mergeWithNotesRetry({ leadId: 'l1' }, mergeOnce, async () => null, { sleep, random: () => 1 }),
    ).rejects.toBeDefined();
    expect(delays).toHaveLength(NOTES_GUARD_MAX_ATTEMPTS - 1);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(400);

    const zero: number[] = [];
    await expect(
      mergeWithNotesRetry({ leadId: 'l1' }, jest.fn().mockRejectedValue(lost()), async () => null, {
        sleep: async (ms: number) => { zero.push(ms); }, random: () => 0,
      }),
    ).rejects.toBeDefined();
    expect(Math.max(...zero)).toBe(0);
  });
});
