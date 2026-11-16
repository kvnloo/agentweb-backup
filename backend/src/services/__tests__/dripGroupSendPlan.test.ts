import { planGroupSend } from '../dripGroupSendPlan';
import { buildSuppressionList } from '../dripSuppressionList';

const empty = buildSuppressionList([]);

describe('planGroupSend (ENG-2556)', () => {
  it('normalizes and dedupes case-insensitively, preserving first-seen order', () => {
    const plan = planGroupSend({
      recipients: [' B@x.com', 'a@x.com', 'b@X.com', 'c@x.com'],
      suppression: empty,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches).toEqual([['b@x.com', 'a@x.com', 'c@x.com']]);
    expect(plan.excluded).toEqual([{ email: 'b@x.com', reason: 'duplicate' }]);
  });

  it('excludes suppressed and invalid addresses with reasons', () => {
    const plan = planGroupSend({
      recipients: ['ok@x.com', 'stop@x.com', 'any@blocked.com', 'not-an-email', 42],
      suppression: buildSuppressionList(['stop@x.com', '*@blocked.com']),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches).toEqual([['ok@x.com']]);
    expect(plan.excluded).toEqual([
      { email: 'stop@x.com', reason: 'exact' },
      { email: 'any@blocked.com', reason: 'domain' },
      { email: 'not-an-email', reason: 'invalid_address' },
      { email: '42', reason: 'invalid_address' },
    ]);
  });

  it('chunks into batches of at most 100 by default', () => {
    const recipients = Array.from({ length: 250 }, (_, i) => `u${i}@x.com`);
    const plan = planGroupSend({ recipients, suppression: empty });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(plan.recipientCount).toBe(250);
  });

  it('honours a custom batch size and rejects sizes outside 1..100', () => {
    const recipients = ['a@x.com', 'b@x.com', 'c@x.com'];
    const plan = planGroupSend({ recipients, suppression: empty, batchSize: 2 });
    expect(plan.ok && plan.batches).toEqual([['a@x.com', 'b@x.com'], ['c@x.com']]);
    for (const batchSize of [0, 101, 1.5, NaN]) {
      expect(planGroupSend({ recipients, suppression: empty, batchSize })).toMatchObject({
        ok: false,
        error: 'invalid_batch_size',
      });
    }
  });

  it('fails closed with no batches when over maxRecipients', () => {
    const plan = planGroupSend({
      recipients: ['a@x.com', 'b@x.com', 'c@x.com'],
      suppression: empty,
      maxRecipients: 2,
    });
    expect(plan).toMatchObject({ ok: false, error: 'too_many_recipients', recipientCount: 3 });
    expect('batches' in plan).toBe(false);
  });

  it('returns no_recipients when everything is excluded', () => {
    expect(
      planGroupSend({ recipients: ['stop@x.com', 'bad'], suppression: buildSuppressionList(['stop@x.com']) }),
    ).toMatchObject({ ok: false, error: 'no_recipients' });
    expect(planGroupSend({ recipients: [], suppression: empty })).toMatchObject({
      ok: false,
      error: 'no_recipients',
    });
  });
});
