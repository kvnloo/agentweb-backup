/**
 * ENG-2324 — the public ingest no longer rejects a well-formed sessionStartMs that is outside
 * [now-48h, now+5min]; it substitutes a stable, recent, server-derived one. forward-lead stays strict.
 */
import {
  resolveSessionIdentity, resolveIngestSessionIdentity, substituteSessionStart, sessionLeadId, SESSION_START_GENERATION_MS,
} from '../sessionList';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const H = 3600_000;
const SID = 'abcd1234-ef56-7890';
const body = (sessionStartMs: unknown, sessionId: unknown = SID) => ({ sessionId, sessionStartMs });

describe('resolveIngestSessionIdentity', () => {
  it('an in-window start is used unchanged (the common case costs nothing and is byte-identical to forward-lead)', () => {
    for (const d of [-47 * H, -5000, 0, 4 * 60_000]) {
      const ing = resolveIngestSessionIdentity(body(NOW + d), NOW);
      expect(ing).toEqual({ sessionId: SID, sessionStartMs: NOW + d });
      expect(ing).toEqual(resolveSessionIdentity(body(NOW + d), NOW));
    }
  });

  it.each([['+3d', 3 * 24 * H], ['-3d', -3 * 24 * H], ['+10min', 10 * 60_000], ['-49h', -49 * H], ['+1y', 365 * 24 * H], ['-30y', -30 * 365 * 24 * H]])(
    'a device clock %s off is substituted, not rejected, while forward-lead still rejects it', (_l, d) => {
      expect(resolveSessionIdentity(body(NOW + d), NOW)).toBeNull();
      const ing = resolveIngestSessionIdentity(body(NOW + d), NOW)!;
      expect(ing.sessionId).toBe(SID);
      expect(ing.sessionStartMs).toBeGreaterThan(NOW - SESSION_START_GENERATION_MS);
      expect(ing.sessionStartMs).toBeLessThanOrEqual(NOW);
      expect(String(ing.sessionStartMs)).toHaveLength(13);
      expect(ing.probeStartsMs).toContain(ing.sessionStartMs - SESSION_START_GENERATION_MS);
    });

  it('accepts the same encodings forward-lead does (digit string, customFields) and still rejects malformed input', () => {
    expect(resolveIngestSessionIdentity(body(String(NOW + 9 * 24 * H)), NOW)?.probeStartsMs).toBeDefined();
    expect(resolveIngestSessionIdentity({ customFields: { sessionId: SID, sessionStartMs: NOW - 9 * 24 * H } }, NOW)?.probeStartsMs).toBeDefined();
    for (const bad of [undefined, null, 'soon', '-5', '1.5', 1.5, NaN, Infinity, 1e300, {}, [], '12345678901234567', true]) {
      expect(resolveIngestSessionIdentity(body(bad), NOW)).toBeNull();
    }
    for (const badId of ['short', 'has space!', undefined, 7, 'x'.repeat(65)]) {
      expect(resolveIngestSessionIdentity({ sessionId: badId, sessionStartMs: NOW - 5000 }, NOW)).toBeNull();
    }
  });

  it('the substitute does not depend on WHICH out-of-window value the device sent (the device value may be anything)', () => {
    const a = resolveIngestSessionIdentity(body(NOW + 3 * 24 * H), NOW)!.sessionStartMs;
    expect(resolveIngestSessionIdentity(body(NOW - 3 * 24 * H), NOW)!.sessionStartMs).toBe(a);
    expect(resolveIngestSessionIdentity(body(NOW + 10 * 60_000), NOW)!.sessionStartMs).toBe(a);
  });
});

describe('substituteSessionStart', () => {
  it('is deterministic: the same session at different times within a generation gets one start and ONE leadId', () => {
    const first = substituteSessionStart(SID, NOW);
    const ids = new Set<string>();
    for (let t = 0; t < 20 * 60_000; t += 1000) {
      const id = substituteSessionStart(SID, NOW + t);
      if (id.sessionStartMs === first.sessionStartMs) ids.add(sessionLeadId('list_x', id));
    }
    expect(ids.size).toBe(1);
  });

  it('property: over 5000 random sessions and instants it is always in (now-24h, now], 13 digits, and the probe list is the two previous generations', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 5000; i++) {
      const now = Date.UTC(2020, 0, 1) + Math.floor(rnd() * 15 * 365 * 24 * H);
      const sid = `sess-${Math.floor(rnd() * 1e12).toString(36)}-xx`;
      const s = substituteSessionStart(sid, now);
      expect(s.sessionStartMs).toBeGreaterThan(now - SESSION_START_GENERATION_MS);
      expect(s.sessionStartMs).toBeLessThanOrEqual(now);
      expect(String(s.sessionStartMs)).toHaveLength(13);
      expect(s.probeStartsMs).toEqual([s.sessionStartMs - SESSION_START_GENERATION_MS, s.sessionStartMs - 2 * SESSION_START_GENERATION_MS]);
    }
  });

  it('advances exactly once per 24h, at an instant that depends on the sessionId (no shared midnight), and the old value becomes the first probe', () => {
    const a = substituteSessionStart(SID, NOW);
    const boundary = a.sessionStartMs + SESSION_START_GENERATION_MS;
    expect(substituteSessionStart(SID, boundary - 1).sessionStartMs).toBe(a.sessionStartMs);
    const next = substituteSessionStart(SID, boundary);
    expect(next.sessionStartMs).toBe(boundary);
    expect(next.probeStartsMs![0]).toBe(a.sessionStartMs);
    const phases = new Set(Array.from({ length: 50 }, (_, i) => substituteSessionStart(`sess-${i}-abcdef`, NOW).sessionStartMs % SESSION_START_GENERATION_MS));
    expect(phases.size).toBeGreaterThan(40);
  });

  it('is case-insensitive in the sessionId, like sessionLeadId', () => {
    expect(substituteSessionStart('ABCD1234-EF56-7890', NOW).sessionStartMs).toBe(substituteSessionStart('abcd1234-ef56-7890', NOW).sessionStartMs);
  });
});

describe('resolveIngestSessionIdentity: device-ahead signal and aged-out starts', () => {
  const withNow = (start: number, clientNowMs: unknown) => ({ sessionId: SID, sessionStartMs: start, clientNowMs });

  it('a device whose clock is >5min ahead is substituted for the WHOLE session, even once its start has entered the window', () => {
    const deviceAhead = 10 * 60_000;
    const realStart = NOW;
    const startMs = realStart + deviceAhead;
    for (const elapsed of [0, 60_000, 4 * 60_000, 5 * 60_000 + 1, 6 * 60_000, 9 * 60_000, 30 * 60_000, 3 * H]) {
      const now = realStart + elapsed;
      const ing = resolveIngestSessionIdentity(withNow(startMs, now + deviceAhead), now)!;
      expect(ing.sessionStartMs).not.toBe(startMs); // never the device start, before OR after it enters the window
      expect(ing.sessionStartMs).toBe(substituteSessionStart(SID, now).sessionStartMs);
    }
    // ...whereas the window rule ALONE moves it onto its own start once that passes now+5min (the split this signal prevents)
    expect(resolveIngestSessionIdentity({ sessionId: SID, sessionStartMs: startMs }, realStart + 6 * 60_000)!.sessionStartMs).toBe(startMs);
  });

  it('clientNowMs cannot take a session off the window rule: a lying / absent / garbage value changes nothing for an in-window start', () => {
    for (const v of [undefined, NOW, NOW + 4 * 60_000, 'x', null, NaN, -1, {}, NOW - 9 * 24 * H]) {
      expect(resolveIngestSessionIdentity(withNow(NOW - 5000, v), NOW)).toEqual({ sessionId: SID, sessionStartMs: NOW - 5000 });
    }
  });

  it('a start that AGED OUT of the window is probed first (the row was created while it was inside); a future one is not', () => {
    const old = resolveIngestSessionIdentity(body(NOW - 49 * H), NOW)!;
    expect(old.probeStartsMs![0]).toBe(NOW - 49 * H);
    expect(old.probeStartsMs).toHaveLength(3);
    const future = resolveIngestSessionIdentity(body(NOW + 3 * 24 * H), NOW)!;
    expect(future.probeStartsMs).toHaveLength(2);
    expect(future.probeStartsMs).not.toContain(NOW + 3 * 24 * H);
  });
});
