import { selectEngagementExitTrigger } from '../dripEngagementExit';

const ENROLLED = Date.parse('2026-10-01T00:00:00Z');
const SENT = '2026-10-02 10:00:00.000000+00:00';
const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function ev(eventType: string, createdAt: string, extra: any = {}) {
  return { eventType, createdAt, data: { created_at: SENT, ...extra } };
}

describe('selectEngagementExitTrigger (ENG-2548)', () => {
  it('human click exits', () => {
    const e = ev('email.clicked', '2026-10-02T10:05:00Z', { click: { userAgent: HUMAN_UA, link: 'https://a' } });
    expect(selectEngagementExitTrigger([e], ENROLLED, ['clicked']).trigger).toBe(e);
  });

  it('scanner sub-2s click does not exit and is reported suppressed', () => {
    const e = ev('email.clicked', '2026-10-02T10:00:01Z', { click: { userAgent: HUMAN_UA, link: 'https://a' } });
    const r = selectEngagementExitTrigger([e], ENROLLED, ['clicked']);
    expect(r.trigger).toBeNull();
    expect(r.suppressed).toEqual([{ event: e, reason: 'too_fast' }]);
  });

  it('SafeLinks scanner click does not exit', () => {
    const e = ev('email.clicked', '2026-10-02T11:00:00Z', { click: { userAgent: 'Microsoft SafeLinks', link: 'https://a' } });
    expect(selectEngagementExitTrigger([e], ENROLLED, ['clicked']).trigger).toBeNull();
  });

  it('Gmail GoogleImageProxy open is a human open and exits (ENG-325)', () => {
    const e = ev('email.opened', '2026-10-02T11:00:00Z', { open: { userAgent: 'Mozilla/5.0 via ggpht.com GoogleImageProxy' } });
    const r = selectEngagementExitTrigger([e], ENROLLED, ['opened']);
    expect(r.trigger).toBe(e);
    expect(r.suppressed).toEqual([]);
  });

  it('Apple MPP proxy open does not exit', () => {
    const e = ev('email.opened', '2026-10-02T11:00:00Z', { open: { userAgent: 'AppleMailProxy/1.0' } });
    const r = selectEngagementExitTrigger([e], ENROLLED, ['opened']);
    expect(r.trigger).toBeNull();
    expect(r.suppressed[0].reason).toBe('proxy_open');
  });

  it('human open after a suppressed proxy open still exits', () => {
    const proxy = ev('email.opened', '2026-10-02T11:00:00Z', { open: { userAgent: 'AppleMailProxy/1.0' } });
    const human = ev('email.opened', '2026-10-02T12:00:00Z', { open: { userAgent: HUMAN_UA } });
    const r = selectEngagementExitTrigger([proxy, human], ENROLLED, ['opened']);
    expect(r.trigger).toBe(human);
    expect(r.suppressed).toHaveLength(1);
  });

  it('missing/invalid send timestamp falls back to current behaviour (exits)', () => {
    const e = { eventType: 'email.clicked', createdAt: '2026-10-02T10:00:01Z', data: { click: { userAgent: 'Microsoft SafeLinks' } } };
    expect(selectEngagementExitTrigger([e], ENROLLED, ['clicked']).trigger).toBe(e);
  });

  it('reply always exits without classification', () => {
    const e = { eventType: 'email.received', createdAt: '2026-10-02T10:00:01Z', data: {} };
    expect(selectEngagementExitTrigger([e], ENROLLED, ['replied']).trigger).toBe(e);
  });

  it('ignores events before enrollment and unwanted types', () => {
    const old = ev('email.clicked', '2026-09-01T10:00:00Z', { click: { userAgent: HUMAN_UA } });
    const open = ev('email.opened', '2026-10-02T12:00:00Z', { open: { userAgent: HUMAN_UA } });
    expect(selectEngagementExitTrigger([old, open], ENROLLED, ['clicked']).trigger).toBeNull();
  });
});
