import {
  hotLeadCallConfigOf, type HotLeadCallConfig, type HotLeadCallMember, type HotLeadCallWindow,
} from '../services/hotLeadCallConfig';
import { isWithinCallWindow } from '../services/voice/hotLeadCallLimits';
import { memberAvailableAt, previewHotLeadCallCandidates, selectHotLeadCallCandidates } from '../services/hotLeadCallRoster';

const TZ = 'America/Chicago';
const VERIFIED = '2026-01-01T00:00:00.000Z';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

let nextPhone = 0;
function member(id: string, windows: HotLeadCallWindow[], over: Partial<HotLeadCallMember> = {}): HotLeadCallMember {
  return { id: `m${id.toLowerCase().padEnd(7, '0')}`, name: `Member ${id}`, phone: `+1415555${String(1000 + nextPhone++)}`, verifiedAt: VERIFIED, windows, ...over };
}
const daily = (start: string, end: string): HotLeadCallWindow => ({ days: ALL_DAYS, start, end });

function configOf(team: HotLeadCallMember[], callingHours: { start: string; end: string } | null = { start: '09:00', end: '18:00' }): HotLeadCallConfig {
  const raw = {
    enabled: false, team, announcedName: 'Acme',
    ...(callingHours ? { callingHours: { ...callingHours, timezone: TZ } } : {}),
  };
  const config = hotLeadCallConfigOf(raw);
  if (!config) throw new Error('fixture config is invalid');
  return config;
}

// Monday 2026-10-19. Chicago is on daylight time (UTC-5) until 2026-11-01, and on standard time (UTC-6) after.
const CDT_HOURS_BEHIND_UTC = 5;
const CST_HOURS_BEHIND_UTC = 6;
const chicago = (hhmm: string, date = '2026-10-19', hoursBehindUtc = CDT_HOURS_BEHIND_UTC): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  const base = new Date(`${date}T00:00:00Z`).getTime();
  return new Date(base + (h + hoursBehindUtc) * 3600_000 + m * 60_000);
};
const ids = (members: HotLeadCallMember[]) => members.map(m => m.id.slice(1, 2).toUpperCase());

describe('reference scenario', () => {
  const A = member('A', [daily('09:00', '12:00')]);
  const B = member('B', [daily('12:15', '15:00')]);
  const C = member('C', [daily('15:00', '18:00')]);
  const D = member('D', [daily('14:00', '19:00')]);
  const team = [A, B, C, D];

  it.each([
    ['11:00', ['A']],
    ['12:05', []],
    ['14:30', ['B', 'D']],
    ['16:00', ['C', 'D']],
    ['18:30', []],
    ['07:00', []],
  ])('with calling hours 09:00-18:00, %s rings %j', (time, expected) => {
    expect(ids(selectHotLeadCallCandidates(configOf(team), chicago(time)))).toEqual(expected);
  });

  it.each([
    ['18:30', ['D']],
    ['07:00', []],
    ['12:05', []],
  ])('with calling hours 07:00-21:00, %s rings %j', (time, expected) => {
    expect(ids(selectHotLeadCallCandidates(configOf(team, { start: '07:00', end: '21:00' }), chicago(time)))).toEqual(expected);
  });

  it('with no calling hours at all rings nobody (fails closed)', () => {
    expect(selectHotLeadCallCandidates(configOf(team, null), chicago('11:00'))).toEqual([]);
  });

  it('puts C before D by team order and D before C when the team order is reversed', () => {
    expect(ids(selectHotLeadCallCandidates(configOf([D, C]), chicago('16:00')))).toEqual(['D', 'C']);
  });
});

describe('boundaries', () => {
  const cfg = configOf([member('A', [daily('09:00', '12:00')])]);
  it('includes a window starting exactly at the instant', () => {
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('09:00')))).toEqual(['A']);
  });
  it('excludes a window ending exactly at the instant, and includes the minute before', () => {
    expect(selectHotLeadCallCandidates(cfg, chicago('12:00'))).toEqual([]);
    expect(ids(selectHotLeadCallCandidates(cfg, new Date(chicago('12:00').getTime() - 1000)))).toEqual(['A']);
  });
  it('excludes the instant just before the start', () => {
    expect(selectHotLeadCallCandidates(cfg, new Date(chicago('09:00').getTime() - 1000))).toEqual([]);
  });
  it('treats 24:00 as the end of the day, so 23:59 is inside and 00:00 the next day is not', () => {
    const night = configOf([member('A', [{ days: [1], start: '22:00', end: '24:00' }])], { start: '21:00', end: '20:00' });
    expect(ids(selectHotLeadCallCandidates(night, chicago('23:59')))).toEqual(['A']);
    expect(selectHotLeadCallCandidates(night, chicago('00:00', '2026-10-20'))).toEqual([]);
  });
  it('includes local midnight for a window starting at 00:00 (the h24 quirk)', () => {
    const early = configOf([member('A', [{ days: [1], start: '00:00', end: '01:00' }])], { start: '00:00', end: '23:59' });
    expect(ids(selectHotLeadCallCandidates(early, chicago('00:00')))).toEqual(['A']);
    expect(ids(selectHotLeadCallCandidates(early, chicago('00:30')))).toEqual(['A']);
    expect(selectHotLeadCallCandidates(early, chicago('01:00'))).toEqual([]);
  });
});

describe('weekdays', () => {
  // 2026-10-19 is a Monday.
  const weekdays = member('A', [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }]);
  const weekend = member('B', [{ days: [0, 6], start: '10:00', end: '14:00' }]);
  const cfg = configOf([weekdays, weekend], { start: '08:00', end: '20:00' });

  it.each([
    ['Mon 2026-10-19', ['A']], ['Fri 2026-10-23', ['A']], ['Sat 2026-10-24', []], ['Sun 2026-10-25', []],
  ])('at 11:00 on %s rings %j', (label, expected) => {
    const date = label.split(' ')[1];
    const rung = ids(selectHotLeadCallCandidates(cfg, chicago('11:00', date)));
    expect(rung.filter(i => i === 'A')).toEqual(expected);
  });
  it('rings the weekend member only on Saturday and Sunday', () => {
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('11:00', '2026-10-24')))).toEqual(['B']);
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('11:00', '2026-10-25')))).toEqual(['B']);
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('11:00', '2026-10-21')))).toEqual(['A']);
  });
  it('reads the weekday on the business clock, not UTC', () => {
    // Sunday 22:00 in Chicago is already Monday 03:00 UTC.
    const sunNight = configOf([member('A', [{ days: [0], start: '21:00', end: '24:00' }]), member('B', [{ days: [1], start: '21:00', end: '24:00' }])],
      { start: '20:00', end: '23:30' });
    expect(ids(selectHotLeadCallCandidates(sunNight, chicago('22:00', '2026-10-25')))).toEqual(['A']);
  });
  it('lets one window list several days and a member hold several windows', () => {
    const split = configOf([member('A', [{ days: [1, 3], start: '09:00', end: '10:00' }, { days: [3], start: '13:00', end: '14:00' }])], { start: '08:00', end: '20:00' });
    expect(ids(selectHotLeadCallCandidates(split, chicago('09:30', '2026-10-19')))).toEqual(['A']); // Mon
    expect(selectHotLeadCallCandidates(split, chicago('09:30', '2026-10-20'))).toEqual([]); // Tue
    expect(ids(selectHotLeadCallCandidates(split, chicago('09:30', '2026-10-21')))).toEqual(['A']); // Wed morning
    expect(ids(selectHotLeadCallCandidates(split, chicago('13:30', '2026-10-21')))).toEqual(['A']); // Wed afternoon
    expect(selectHotLeadCallCandidates(split, chicago('13:30', '2026-10-19'))).toEqual([]);
    expect(selectHotLeadCallCandidates(split, chicago('11:00', '2026-10-21'))).toEqual([]);
  });
});

describe('standard time', () => {
  it('reads the same wall-clock windows in winter, when Chicago is six hours behind UTC', () => {
    const team = [member('A', [daily('09:00', '12:00')]), member('C', [daily('15:00', '18:00')]), member('D', [daily('14:00', '19:00')])];
    const monday = (hhmm: string) => chicago(hhmm, '2026-12-14', CST_HOURS_BEHIND_UTC);
    expect(ids(selectHotLeadCallCandidates(configOf(team), monday('11:00')))).toEqual(['A']);
    expect(ids(selectHotLeadCallCandidates(configOf(team), monday('16:00')))).toEqual(['C', 'D']);
    expect(selectHotLeadCallCandidates(configOf(team), monday('18:30'))).toEqual([]);
  });
});

describe('daylight saving', () => {
  const wide = { start: '00:00', end: '23:59' };
  it('spring forward (2026-03-08): the window is read on the post-change clock', () => {
    const cfg = configOf([member('A', [{ days: [0], start: '08:00', end: '09:00' }])], wide);
    // 13:30Z is 08:30 CDT; a fixed UTC-6 offset would call it 07:30 and miss the window.
    expect(ids(selectHotLeadCallCandidates(cfg, new Date('2026-03-08T13:30:00Z')))).toEqual(['A']);
    expect(selectHotLeadCallCandidates(cfg, new Date('2026-03-08T14:30:00Z'))).toEqual([]); // 09:30 CDT
    expect(selectHotLeadCallCandidates(cfg, new Date('2026-03-08T12:59:00Z'))).toEqual([]); // 07:59 CDT
  });
  it('spring forward: a window across the skipped hour covers both sides of the jump', () => {
    const cfg = configOf([member('A', [{ days: [0], start: '01:30', end: '03:30' }])], wide);
    expect(ids(selectHotLeadCallCandidates(cfg, new Date('2026-03-08T07:59:00Z')))).toEqual(['A']); // 01:59 CST
    expect(ids(selectHotLeadCallCandidates(cfg, new Date('2026-03-08T08:00:00Z')))).toEqual(['A']); // 03:00 CDT
    expect(selectHotLeadCallCandidates(cfg, new Date('2026-03-08T08:30:00Z'))).toEqual([]); // 03:30 CDT
  });
  it('fall back (2026-11-01): the repeated hour matches in both passes and only there', () => {
    const cfg = configOf([member('A', [{ days: [0], start: '01:30', end: '02:30' }])], wide);
    expect(ids(selectHotLeadCallCandidates(cfg, new Date('2026-11-01T06:30:00Z')))).toEqual(['A']); // 01:30 CDT
    expect(selectHotLeadCallCandidates(cfg, new Date('2026-11-01T07:00:00Z'))).toEqual([]); // 01:00 CST
    expect(ids(selectHotLeadCallCandidates(cfg, new Date('2026-11-01T07:30:00Z')))).toEqual(['A']); // 01:30 CST
    expect(selectHotLeadCallCandidates(cfg, new Date('2026-11-01T08:30:00Z'))).toEqual([]); // 02:30 CST
  });
  it('the day after the change uses the new offset', () => {
    const cfg = configOf([member('A', [{ days: [1], start: '09:00', end: '10:00' }])], wide);
    expect(ids(selectHotLeadCallCandidates(cfg, new Date('2026-11-02T15:30:00Z')))).toEqual(['A']); // 09:30 CST
    expect(selectHotLeadCallCandidates(cfg, new Date('2026-11-02T14:30:00Z'))).toEqual([]); // 08:30 CST
  });
});

describe('who is skipped', () => {
  const A = member('A', [daily('09:00', '17:00')]);
  const B = member('B', [daily('09:00', '17:00')]);
  const C = member('C', [daily('09:00', '17:00')], { verifiedAt: undefined });
  const cfg = configOf([A, C, B]);

  it('skips unverified members', () => {
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('10:00')))).toEqual(['A', 'B']);
  });
  it('skips members in the exclude list but keeps the order of the rest', () => {
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('10:00'), [A.id]))).toEqual(['B']);
    expect(selectHotLeadCallCandidates(cfg, chicago('10:00'), [A.id, B.id])).toEqual([]);
  });
  it('ignores exclude ids that are not on the team', () => {
    expect(ids(selectHotLeadCallCandidates(cfg, chicago('10:00'), ['mzzzzzzz']))).toEqual(['A', 'B']);
  });
  it('does not mutate the config', () => {
    const before = JSON.stringify(cfg);
    selectHotLeadCallCandidates(cfg, chicago('10:00'), [A.id]);
    previewHotLeadCallCandidates(cfg, chicago('10:00'));
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe('memberAvailableAt', () => {
  const A = member('A', [{ days: [1], start: '09:00', end: '10:00' }]);
  it('uses the given timezone', () => {
    expect(memberAvailableAt(A, TZ, chicago('09:30'))).toBe(true);
    expect(memberAvailableAt(A, 'America/Los_Angeles', chicago('09:30'))).toBe(false); // 07:30 there
    expect(memberAvailableAt(A, 'America/New_York', chicago('08:30'))).toBe(true); // 09:30 there
  });
});

describe('previewHotLeadCallCandidates', () => {
  const A = member('A', [daily('09:00', '12:00')]);
  const B = member('B', [daily('13:00', '15:00')]);
  const C = member('C', [daily('09:00', '17:00')], { verifiedAt: undefined });
  const cfg = configOf([A, B, C]);
  const reasons = (at: Date, exclude?: string[]) => previewHotLeadCallCandidates(cfg, at, exclude).map(e => e.reason ?? null);

  it('lists every member in team order with the reason each is skipped', () => {
    expect(reasons(chicago('10:00'))).toEqual([null, 'outside_window', 'unverified']);
    expect(previewHotLeadCallCandidates(cfg, chicago('10:00')).map(e => e.member.id)).toEqual([A.id, B.id, C.id]);
  });
  it('reports excluded members', () => {
    expect(reasons(chicago('10:00'), [A.id])).toEqual(['excluded', 'outside_window', 'unverified']);
  });
  it('reports the calling hours as the reason for everyone who is verified when they are closed', () => {
    expect(reasons(chicago('08:00'))).toEqual(['outside_calling_hours', 'outside_calling_hours', 'unverified']);
    expect(reasons(chicago('18:30'))).toEqual(['outside_calling_hours', 'outside_calling_hours', 'unverified']);
  });
  it('agrees with selectHotLeadCallCandidates at every minute of a day', () => {
    for (let min = 0; min < 24 * 60; min += 5) {
      const at = new Date(chicago('00:00').getTime() + min * 60_000);
      const viaPreview = previewHotLeadCallCandidates(cfg, at).filter(e => !e.reason).map(e => e.member.id);
      expect(selectHotLeadCallCandidates(cfg, at).map(m => m.id)).toEqual(viaPreview);
    }
  });
});

describe('properties', () => {
  // Deterministic generator so a failure reproduces.
  let seed = 20261020;
  const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  function randomWindow(): HotLeadCallWindow {
    const start = rand(23 * 60);
    const end = start + 1 + rand(24 * 60 - start - 1 + 1);
    const days = ALL_DAYS.filter(() => rand(2) === 0);
    return { days: days.length ? days : [rand(7)], start: hhmm(start), end: end >= 1440 ? '24:00' : hhmm(end) };
  }
  function randomConfig(): HotLeadCallConfig {
    const team = Array.from({ length: 1 + rand(10) }, (_, i) => member(String.fromCharCode(97 + i), Array.from({ length: 1 + rand(3) }, randomWindow), rand(3) === 0 ? { verifiedAt: undefined } : {}));
    const start = rand(12 * 60);
    return configOf(team, { start: hhmm(start), end: hhmm(start + 60 + rand(11 * 60)) });
  }

  it('never returns an unverified, excluded or out-of-window member, and keeps team order', () => {
    for (let run = 0; run < 60; run++) {
      const cfg = randomConfig();
      const at = new Date(Date.UTC(2026, rand(12), 1 + rand(28), rand(24), rand(60)));
      const exclude = cfg.team.filter(() => rand(4) === 0).map(m => m.id);
      const picked = selectHotLeadCallCandidates(cfg, at, exclude);
      const order = cfg.team.map(m => m.id);
      let last = -1;
      for (const m of picked) {
        expect(m.verifiedAt).toBeDefined();
        expect(exclude).not.toContain(m.id);
        expect(memberAvailableAt(m, TZ, at)).toBe(true);
        const pos = order.indexOf(m.id);
        expect(pos).toBeGreaterThan(last);
        last = pos;
      }
      // Complete as well as sound: everyone who qualifies on their own is returned.
      const expectedCount = cfg.team.filter(m => m.verifiedAt && !exclude.includes(m.id) && memberAvailableAt(m, TZ, at)).length;
      const open = isWithinCallWindow(cfg.callingHours, at);
      expect(picked.length).toBe(open ? expectedCount : 0);
    }
  });

  it('returns nobody when no member is verified', () => {
    const cfg = configOf([member('A', [daily('00:00', '24:00')], { verifiedAt: undefined })], { start: '00:00', end: '23:59' });
    for (let h = 0; h < 24; h++) expect(selectHotLeadCallCandidates(cfg, chicago(`${String(h).padStart(2, '0')}:30`))).toEqual([]);
  });
});
