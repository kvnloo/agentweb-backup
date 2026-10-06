import { createHash } from 'crypto';
import { emailLeadIds, emailLeadBucketMs, isEmailUniqueCreateEnabled } from '../utils/emailLeadId';

describe('emailLeadIds (ENG-2321)', () => {
  const W = 5000;
  beforeEach(() => { delete process.env.LEAD_EMAIL_UNIQUE_BUCKET_MS; delete process.env.LEAD_EMAIL_UNIQUE_CREATE; process.env.JWT_SECRET = 's1'; });

  it('same bucket -> same id; adjacent buckets differ only in the 13-digit prefix, by exactly one width', () => {
    const t = 1_700_000_000_000;
    const a = emailLeadIds('L', 'a@x.com', t); const b = emailLeadIds('L', 'a@x.com', t + 1);
    expect(a.leadId).toBe(b.leadId);
    const c = emailLeadIds('L', 'a@x.com', a.nextLeadId ? Number(a.nextLeadId.split('_')[1]) : 0);
    expect(c.prevLeadId).toBe(a.leadId);
    expect(a.nextLeadId).toBe(c.leadId);
    expect(Number(a.nextLeadId.split('_')[1]) - Number(a.prevLeadId.split('_')[1])).toBe(2 * W);
    for (const id of [a.leadId, a.prevLeadId, a.nextLeadId]) expect(id).toMatch(/^lead_\d{13}_[0-9a-f]{12}$/);
  });
  it('the prefix is the bucket START and never in the future', () => {
    const t = 1_700_000_003_999;
    expect(Number(emailLeadIds('L', 'a@x.com', t).leadId.split('_')[1])).toBeLessThanOrEqual(t);
    expect(t - Number(emailLeadIds('L', 'a@x.com', t).leadId.split('_')[1])).toBeLessThan(W);
  });
  it('is scoped by list and by email, and is not a plain hash of them', () => {
    const t = 1_700_000_000_000;
    expect(emailLeadIds('L1', 'a@x.com', t).leadId).not.toBe(emailLeadIds('L2', 'a@x.com', t).leadId);
    expect(emailLeadIds('L1', 'a@x.com', t).leadId).not.toBe(emailLeadIds('L1', 'b@x.com', t).leadId);
    const plain = createHash('sha256').update('L1:a@x.com').digest('hex').slice(0, 12);
    expect(emailLeadIds('L1', 'a@x.com', t).leadId.endsWith(plain)).toBe(false);
  });
  it('depends on the server secret', () => {
    const t = 1_700_000_000_000; const a = emailLeadIds('L', 'a@x.com', t).leadId;
    process.env.JWT_SECRET = 's2';
    expect(emailLeadIds('L', 'a@x.com', t).leadId).not.toBe(a);
  });
  it('bucket width: default 5000, tunable, invalid/out-of-range falls back', () => {
    expect(emailLeadBucketMs()).toBe(5000);
    for (const [v, want] of [['2000', 2000], ['999', 5000], ['60001', 5000], ['abc', 5000], ['2500.5', 5000]] as const) {
      process.env.LEAD_EMAIL_UNIQUE_BUCKET_MS = v; expect(emailLeadBucketMs()).toBe(want);
    }
  });
  it('kill switch defaults ON', () => {
    expect(isEmailUniqueCreateEnabled()).toBe(true);
    for (const v of ['false', 'FALSE', '0', 'off', 'no', ' false ']) { process.env.LEAD_EMAIL_UNIQUE_CREATE = v; expect(isEmailUniqueCreateEnabled()).toBe(false); }
    for (const v of ['true', '1', '', 'garbage']) { process.env.LEAD_EMAIL_UNIQUE_CREATE = v; expect(isEmailUniqueCreateEnabled()).toBe(true); }
  });
});
