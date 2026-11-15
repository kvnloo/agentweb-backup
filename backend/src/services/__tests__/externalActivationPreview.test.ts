import * as fs from 'fs';
import * as path from 'path';
import {
  buildExternalActivationPreview,
  computeExternalVersionHash,
  verifyExternalActivationPreview,
} from '../externalActivationPreview';

const base = () => ({
  sequenceId: 'seq-1',
  autoEnrollListIds: ['b', 'a'],
  steps: [
    { channel: 'email', subject: 'Hi', bodyHtml: '<p>x</p>', delayDays: 0, senderId: 's1' },
    { channel: 'linkedin', messageText: 'hey', delayDays: 3, linkedInAccountId: 'li1' },
  ],
});
const who = { approverPrincipal: 'slack:U08TM4QFQ1L' };

describe('externalActivationPreview (ENG-2958)', () => {
  it('hash is stable across key order', () => {
    const a = base();
    const b = {
      steps: a.steps.map((s) => Object.fromEntries(Object.entries(s).reverse())),
      autoEnrollListIds: ['a', 'b'],
      sequenceId: 'seq-1',
    };
    expect(computeExternalVersionHash(b)).toBe(computeExternalVersionHash(a));
  });

  it.each([
    ['subject', (s: any) => (s.steps[0].subject = 'Hello')],
    ['body', (s: any) => (s.steps[0].bodyHtml = '<p>y</p>')],
    ['delay', (s: any) => (s.steps[1].delayDays = 4)],
    ['channel', (s: any) => (s.steps[0].channel = 'linkedin')],
    ['sender', (s: any) => (s.steps[0].senderId = 's2')],
    ['order', (s: any) => s.steps.reverse()],
    ['enrollment', (s: any) => (s.autoEnrollListIds = ['c'])],
  ])('hash changes on %s change', (_n, mutate) => {
    const s = base();
    mutate(s);
    expect(computeExternalVersionHash(s)).not.toBe(computeExternalVersionHash(base()));
  });

  it('builds preview summary', () => {
    const p = buildExternalActivationPreview({ ...base(), recipientsCount: 12 }, who);
    expect(p).toMatchObject({ sequenceId: 'seq-1', stepCount: 2, channels: ['email', 'linkedin'], recipientsCount: 12, approverPrincipal: who.approverPrincipal });
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts unchanged sequence + same principal', () => {
    const p = buildExternalActivationPreview(base(), who);
    expect(verifyExternalActivationPreview(p, base(), who)).toEqual({ ok: true });
  });

  it('rejects drift after preview', () => {
    const p = buildExternalActivationPreview(base(), who);
    const cur = base();
    cur.steps[0].subject = 'edited';
    expect(verifyExternalActivationPreview(p, cur, who)).toEqual({ ok: false, reason: 'version_drift' });
    expect(verifyExternalActivationPreview(p, { ...base(), sequenceId: 'seq-2' }, who)).toEqual({ ok: false, reason: 'version_drift' });
  });

  it('rejects a different approver', () => {
    const p = buildExternalActivationPreview(base(), who);
    expect(verifyExternalActivationPreview(p, base(), { approverPrincipal: 'slack:OTHER' })).toEqual({ ok: false, reason: 'principal_mismatch' });
  });

  it('rejects malformed / tampered previews', () => {
    const p = buildExternalActivationPreview(base(), who);
    expect(verifyExternalActivationPreview({ ...p, digest: '' }, base(), who)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyExternalActivationPreview({ ...p, approverPrincipal: 'slack:OTHER' }, base(), { approverPrincipal: 'slack:OTHER' })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyExternalActivationPreview(null as any, base(), who)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyExternalActivationPreview(p, {} as any, who)).toEqual({ ok: false, reason: 'malformed' });
    expect(() => buildExternalActivationPreview({ sequenceId: 'x', steps: [] }, who)).toThrow();
    expect(() => buildExternalActivationPreview(base(), { approverPrincipal: '' })).toThrow();
  });

  it('imports only node crypto (no Emma agent, db, or network modules)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'externalActivationPreview.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['crypto']);
  });
});
