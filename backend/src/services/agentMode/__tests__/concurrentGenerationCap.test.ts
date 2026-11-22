jest.mock('../../settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

import { settingsService } from '../../settingsService';
import {
  acquireInteractiveGenerationSlot,
  buildTooManyRunsBody,
  getMaxConcurrentGenerationsPerUser,
  DEFAULT_MAX_CONCURRENT_GENERATIONS_PER_USER,
  __resetConcurrentGenerationCapForTests,
  __activeGenerationCountForTests,
} from '../concurrentGenerationCap';

const getSetting = settingsService.getSetting as jest.Mock;
const setLimit = (v: unknown) => getSetting.mockResolvedValue(v === null ? null : { settingValue: v });

describe('concurrentGenerationCap (ENG-110)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    __resetConcurrentGenerationCapForTests();
    setLimit('3');
  });

  it('allows the 2nd and 3rd concurrent session and rejects the 4th (limit 3)', async () => {
    const a = await acquireInteractiveGenerationSlot('u1', 's1');
    const b = await acquireInteractiveGenerationSlot('u1', 's2');
    const c = await acquireInteractiveGenerationSlot('u1', 's3');
    const d = await acquireInteractiveGenerationSlot('u1', 's4');
    expect([a.ok, b.ok, c.ok, d.ok]).toEqual([true, true, true, false]);
    if (!d.ok) {
      expect(d.limit).toBe(3);
      expect(d.current).toBe(3);
    }
    expect(__activeGenerationCountForTests('u1')).toBe(3);
  });

  it('frees a slot on release so the next request is admitted', async () => {
    const slots = [];
    for (const s of ['s1', 's2', 's3']) slots.push(await acquireInteractiveGenerationSlot('u1', s));
    expect((await acquireInteractiveGenerationSlot('u1', 's4')).ok).toBe(false);
    (slots[0] as any).release();
    expect((await acquireInteractiveGenerationSlot('u1', 's4')).ok).toBe(true);
  });

  it('release is idempotent and cannot free another holder', async () => {
    const a = await acquireInteractiveGenerationSlot('u1', 's1');
    await acquireInteractiveGenerationSlot('u1', 's2');
    (a as any).release();
    (a as any).release();
    expect(__activeGenerationCountForTests('u1')).toBe(1);
  });

  it('is keyed per user', async () => {
    for (const s of ['s1', 's2', 's3']) await acquireInteractiveGenerationSlot('u1', s);
    expect((await acquireInteractiveGenerationSlot('u2', 's9')).ok).toBe(true);
  });

  it('does not count the same session twice', async () => {
    for (const s of ['s1', 's1', 's1']) expect((await acquireInteractiveGenerationSlot('u1', s)).ok).toBe(true);
    expect(__activeGenerationCountForTests('u1')).toBe(1);
  });

  it('a rejected request holds nothing (no leak)', async () => {
    setLimit('1');
    await acquireInteractiveGenerationSlot('u1', 's1');
    for (let i = 0; i < 5; i++) expect((await acquireInteractiveGenerationSlot('u1', `x${i}`)).ok).toBe(false);
    expect(__activeGenerationCountForTests('u1')).toBe(1);
  });

  it('cleans up the user entry when the last slot is released', async () => {
    const a = await acquireInteractiveGenerationSlot('u1', 's1');
    (a as any).release();
    expect(__activeGenerationCountForTests('u1')).toBe(0);
  });

  describe('limit resolution', () => {
    it('0 means unlimited', async () => {
      setLimit('0');
      for (let i = 0; i < 20; i++) expect((await acquireInteractiveGenerationSlot('u1', `s${i}`)).ok).toBe(true);
    });
    it.each(['abc', '-1', '2.5', '', 'NaN', '{"a":1}'])('garbage %j falls back to the default', async (v) => {
      setLimit(v);
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(DEFAULT_MAX_CONCURRENT_GENERATIONS_PER_USER);
    });
    it('accepts a numeric (non-string) value', async () => {
      setLimit(5);
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(5);
    });
    it('absent row => default 3', async () => {
      setLimit(null);
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(3);
    });
    it('read error with no prior value => default', async () => {
      getSetting.mockRejectedValue(new Error('ddb down'));
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(3);
    });
    it('read error after a good read => last-known value', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
      setLimit('7');
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(7);
      jest.setSystemTime(new Date('2026-01-01T00:02:00Z'));
      getSetting.mockRejectedValue(new Error('ddb down'));
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(7);
    });
    it('caches for ~60s then re-reads', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
      setLimit('4');
      await getMaxConcurrentGenerationsPerUser();
      await getMaxConcurrentGenerationsPerUser();
      expect(getSetting).toHaveBeenCalledTimes(1);
      setLimit('2');
      jest.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      expect(await getMaxConcurrentGenerationsPerUser()).toBe(2);
      expect(getSetting).toHaveBeenCalledTimes(2);
    });
  });

  it('builds the 429 body', () => {
    expect(buildTooManyRunsBody(3, 3)).toEqual({
      error: 'Too many concurrent runs',
      code: 'TOO_MANY_CONCURRENT_RUNS',
      message: 'You have 3 chats generating at once. Wait for one to finish, then try again.',
      limit: 3,
    });
  });
});
