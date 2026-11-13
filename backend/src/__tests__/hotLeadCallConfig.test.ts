import { randomInt } from 'crypto';
import {
  hotLeadCallConfigOf, callableLeadPhone, generateMemberId, HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_LIMIT_FIELDS, HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH,
  HOT_LEAD_CALL_MAX_TEAM_SIZE, HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER, HOT_LEAD_CALL_MEMBER_NAME_MAX, type HotLeadCallConfig,
} from '../services/hotLeadCallConfig';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomInt: jest.fn(actual.randomInt) };
});

const SID = 'PN' + 'a'.repeat(32);
const VERIFIED = '2026-01-01T00:00:00.000Z';
const WINDOW = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
const member = (over: Record<string, unknown> = {}) => ({ id: 'mabcdef1', name: 'Dana Lee', phone: '+14155550100', windows: [WINDOW], ...over });
const base = (over: Record<string, unknown> = {}) => ({ enabled: false, team: [member()], announcedName: 'Acme Plumbing', ...over });
const enabledBase = (over: Record<string, unknown> = {}) => base({
  enabled: true, team: [member({ verifiedAt: VERIFIED })], twilioNumber: '+14155550111',
  callingHours: { timezone: 'America/Chicago' }, ...over,
});
const teamOfSize = (n: number) => Array.from({ length: n }, (_, i) => member({ id: `m000000${i}`, phone: `+1415555${String(1000 + i)}` }));

describe('hotLeadCallConfigOf', () => {
  it('fills defaults for a minimal disabled config', () => {
    expect(hotLeadCallConfigOf(base())).toEqual({
      enabled: false, team: [member()], announcedName: 'Acme Plumbing', leadTypes: ['form_fill'],
      maxAgeMinutes: 10, maxCallsPerHour: 6, maxCallsPerDay: 20, maxCallsPerMonth: 150, memberCooldownMinutes: 2, maxAttemptsPerLead: 3,
      allowedCountries: ['US', 'CA'],
    });
  });

  it('accepts a fully populated enabled config and defaults calling hours to 08:00-21:00', () => {
    const config = hotLeadCallConfigOf(enabledBase({ twilioNumberSid: SID, leadTypes: ['form_fill', 'booking'], allowedCountries: ['US'] })) as HotLeadCallConfig;
    expect(config.enabled).toBe(true);
    expect(config.callingHours).toEqual({ start: '08:00', end: '21:00', timezone: 'America/Chicago' });
    expect(config.twilioNumberSid).toBe(SID);
    expect(config.team[0].verifiedAt).toBe(VERIFIED);
  });

  it('trims announcedName and accepts a bare ampersand (the TwiML builder must XML-escape it)', () => {
    expect(hotLeadCallConfigOf(base({ announcedName: '  O\'Brien & Sons, Inc.  ' }))?.announcedName).toBe("O'Brien & Sons, Inc.");
  });

  it('is idempotent: validating its own output returns an equal config', () => {
    const once = hotLeadCallConfigOf(enabledBase({ team: [member({ verifiedAt: VERIFIED, name: '  Dana Lee ' }), member({ id: 'mzzzzzz2', phone: '+14155550101' })] }));
    expect(once).not.toBeNull();
    expect(hotLeadCallConfigOf(once)).toEqual(once);
  });

  it.each(['+19002223333', '+18005550199', '+15335551234', '+15005550006', '+16005550123'])('rejects premium-rate, toll-free, personal and VOIP numbers (toll fraud): %s', phone => {
    expect(hotLeadCallConfigOf(base({ team: [member({ phone })] }))).toBeNull();
    expect(hotLeadCallConfigOf(base({ twilioNumber: phone }))).toBeNull();
  });
  it.each(['+14155550100', '+12125550123', '+16475550123', '+14165550123'])('still accepts ordinary US and CA numbers: %s', phone => {
    expect(hotLeadCallConfigOf(base({ team: [member({ phone })] }))?.team[0].phone).toBe(phone);
  });
  it('rejects a member phone equal to the caller number, whichever member it is', () => {
    expect(hotLeadCallConfigOf(base({ twilioNumber: '+14155550100' }))).toBeNull();
    const team = [member(), member({ id: 'mzzzzzz2', phone: '+14155550101' })];
    expect(hotLeadCallConfigOf(base({ team, twilioNumber: '+14155550101' }))).toBeNull();
    expect(hotLeadCallConfigOf(base({ team, twilioNumber: '+14155550111' }))).not.toBeNull();
  });

  it.each([
    ['no slash', 'UTC'],
    ['unknown zone', 'Mars/Olympus'],
    ['Etc area (any case)', 'ETC/UTC'],
    ['offset', '+05:00'],
    ['trailing whitespace', 'America/Chicago '],
    ['non-string', 5],
  ])('rejects timezone: %s', (_reason, timezone) => {
    expect(hotLeadCallConfigOf(base({ callingHours: { timezone } }))).toBeNull();
  });
  // Intl folds case and resolves aliases; the resolved name is what gets stored.
  it.each([
    ['America/Chicago', 'America/Chicago'],
    ['america/chicago', 'America/Chicago'],
    ['AMERICA/CHICAGO', 'America/Chicago'],
    ['America/Los_Angeles', 'America/Los_Angeles'],
    ['US/Eastern', 'America/New_York'],
    ['Canada/Eastern', 'America/Toronto'],
    ['America/Indiana/Indianapolis', 'America/Indianapolis'],
    ['America/Montreal', 'America/Toronto'],
    ['Australia/NSW', 'Australia/Sydney'],
    ['America/Port-au-Prince', 'America/Port-au-Prince'],
  ])('stores timezone %s as %s', (input, stored) => {
    const once = hotLeadCallConfigOf(base({ callingHours: { timezone: input } }));
    expect(once?.callingHours?.timezone).toBe(stored);
    expect(hotLeadCallConfigOf(once)?.callingHours?.timezone).toBe(stored);
  });

  it.each([null, undefined, 'x', 5, [], base({ enabled: 'true' }), base({ enabled: undefined })])('rejects non-object or bad enabled %j', raw => {
    expect(hotLeadCallConfigOf(raw)).toBeNull();
  });

  it.each([
    ['unknown key', { extra: 1 }],
    ['unknown key shaped like an org override', { orgId: 'org-b' }],
    ['the removed destinationPhone', { destinationPhone: '+14155550100' }],
    ['the removed destinationVerifiedAt', { destinationVerifiedAt: VERIFIED }],
    ['the removed quietHours', { quietHours: { timezone: 'America/Chicago' } }],
    ['the removed ownerCooldownMinutes', { ownerCooldownMinutes: 2 }],
    ['bad twilioNumber', { twilioNumber: '12345' }],
    ['bad sid', { twilioNumberSid: 'PN123' }],
    ['uppercase sid', { twilioNumberSid: 'PN' + 'A'.repeat(32) }],
    ['unknown lead type', { leadTypes: ['spam'] }],
    ['duplicate lead types', { leadTypes: ['form_fill', 'form_fill'] }],
    ['empty lead types', { leadTypes: [] }],
    ['null lead types', { leadTypes: null }],
    ['missing announcedName', { announcedName: undefined }],
    ['blank announcedName', { announcedName: '   ' }],
    ['61-char announcedName', { announcedName: 'a'.repeat(61) }],
    ['angle brackets in name', { announcedName: 'Acme <Say>' }],
    ['TwiML tag injection', { announcedName: 'Acme </Say><Dial>' }],
    ['entity-style injection', { announcedName: 'Acme &lt;Say&gt;' }],
    ['newline in name', { announcedName: 'Acme\nPlumbing' }],
    ['control char in name', { announcedName: 'Acme\u0007' }],
    ['quote in name', { announcedName: 'Acme "x"' }],
    ['semicolon in name', { announcedName: 'Acme; drop' }],
    ['non-string name', { announcedName: 5 }],
    ['unknown country', { allowedCountries: ['MX'] }],
    ['empty countries', { allowedCountries: [] }],
    ['duplicate countries', { allowedCountries: ['US', 'US'] }],
    ['calling hours without timezone', { callingHours: { start: '08:00', end: '21:00' } }],
    ['calling hours bad time', { callingHours: { start: '8:00', timezone: 'America/Chicago' } }],
    ['calling hours 24:00', { callingHours: { end: '24:00', timezone: 'America/Chicago' } }],
    ['calling hours start == end', { callingHours: { start: '09:00', end: '09:00', timezone: 'America/Chicago' } }],
    ['calling hours unknown key', { callingHours: { timezone: 'America/Chicago', x: 1 } }],
    ['calling hours not object', { callingHours: '08:00-21:00' }],
  ])('rejects %s', (_label, over) => {
    expect(hotLeadCallConfigOf(base(over))).toBeNull();
  });

  describe('team', () => {
    const withMember = (over: Record<string, unknown>) => base({ team: [member(over)] });

    it('is required and bounded to 1..10 members', () => {
      expect(hotLeadCallConfigOf(base({ team: undefined }))).toBeNull();
      expect(hotLeadCallConfigOf(base({ team: [] }))).toBeNull();
      expect(hotLeadCallConfigOf(base({ team: 'x' }))).toBeNull();
      expect(hotLeadCallConfigOf(base({ team: teamOfSize(HOT_LEAD_CALL_MAX_TEAM_SIZE) }))?.team).toHaveLength(HOT_LEAD_CALL_MAX_TEAM_SIZE);
      expect(hotLeadCallConfigOf(base({ team: teamOfSize(HOT_LEAD_CALL_MAX_TEAM_SIZE + 1) }))).toBeNull();
    });
    it('keeps the stored order, which is the priority', () => {
      const team = [member({ id: 'mzzzzzz1', phone: '+14155550101' }), member({ id: 'maaaaaa1', phone: '+14155550102' })];
      expect(hotLeadCallConfigOf(base({ team }))?.team.map(m => m.id)).toEqual(['mzzzzzz1', 'maaaaaa1']);
    });
    it.each([
      ['unknown member key', { extra: 1 }],
      ['missing id', { id: undefined }],
      ['id without the m prefix', { id: 'xabcdefg' }],
      ['id too short', { id: 'mabcdef' }],
      ['id too long', { id: 'mabcdefgh' }],
      ['uppercase id', { id: 'mABCDEFG' }],
      ['non-string id', { id: 12345678 }],
      ['missing name', { name: undefined }],
      ['blank name', { name: '   ' }],
      ['non-string name', { name: 5 }],
      ['over-long name', { name: 'a'.repeat(HOT_LEAD_CALL_MEMBER_NAME_MAX + 1) }],
      ['markup in name', { name: 'Dana <b>' }],
      ['newline in name', { name: 'Dana\nLee' }],
      ['quote in name', { name: 'Dana "x"' }],
      ['missing phone', { phone: undefined }],
      ['non-E.164 phone', { phone: '(415) 555-0100' }],
      ['non US/CA phone', { phone: '+442071838750' }],
      ['non US/CA NANP phone', { phone: '+18765550100' }],
      ['non-string phone', { phone: 4155550100 }],
      ['bad verifiedAt', { verifiedAt: 'yesterday' }],
      ['non-canonical verifiedAt', { verifiedAt: '2026-01-01' }],
      ['non-string verifiedAt', { verifiedAt: 5 }],
      ['missing windows', { windows: undefined }],
      ['empty windows', { windows: [] }],
      ['non-array windows', { windows: WINDOW }],
      ['8 windows', { windows: Array.from({ length: HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER + 1 }, () => WINDOW) }],
    ])('rejects %s', (_label, over) => {
      expect(hotLeadCallConfigOf(withMember(over))).toBeNull();
    });
    it('accepts a name at the length bound and with the allowed punctuation', () => {
      expect(hotLeadCallConfigOf(withMember({ name: 'a'.repeat(HOT_LEAD_CALL_MEMBER_NAME_MAX) }))).not.toBeNull();
      expect(hotLeadCallConfigOf(withMember({ name: "O'Brien-Lee & Sons, Jr." }))).not.toBeNull();
      expect(hotLeadCallConfigOf(withMember({ name: 'Zoë Ñandú 2' }))).not.toBeNull();
    });
    it('accepts the maximum of 7 windows', () => {
      const windows = Array.from({ length: HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER }, () => WINDOW);
      expect(hotLeadCallConfigOf(withMember({ windows }))?.team[0].windows).toHaveLength(7);
    });
    it('rejects duplicate ids and duplicate phones inside the team', () => {
      const a = member();
      expect(hotLeadCallConfigOf(base({ team: [a, member({ phone: '+14155550101' })] }))).toBeNull();
      expect(hotLeadCallConfigOf(base({ team: [a, member({ id: 'mzzzzzz2' })] }))).toBeNull();
      expect(hotLeadCallConfigOf(base({ team: [a, member({ id: 'mzzzzzz2', phone: '+14155550101' })] }))).not.toBeNull();
    });
    it.each([null, 'x', 5, [member()]])('rejects a member that is not an object: %j', bad => {
      expect(hotLeadCallConfigOf(base({ team: [bad] }))).toBeNull();
    });
  });

  describe('windows', () => {
    const withWindow = (over: Record<string, unknown>) => base({ team: [member({ windows: [{ ...WINDOW, ...over }] })] });

    it.each([
      ['unknown key', { extra: 1 }],
      ['missing days', { days: undefined }],
      ['empty days', { days: [] }],
      ['8 days', { days: [0, 1, 2, 3, 4, 5, 6, 0] }],
      ['duplicate days', { days: [1, 1] }],
      ['day 7', { days: [7] }],
      ['negative day', { days: [-1] }],
      ['fractional day', { days: [1.5] }],
      ['string day', { days: ['1'] }],
      ['days not an array', { days: 1 }],
      ['missing start', { start: undefined }],
      ['unpadded start', { start: '9:00' }],
      ['start 24:00', { start: '24:00' }],
      ['hour 25', { end: '25:00' }],
      ['minute 60', { end: '12:60' }],
      ['end 24:01', { end: '24:01' }],
      ['non-string end', { end: 17 }],
      ['start == end', { start: '09:00', end: '09:00' }],
      ['start after end (a wrapping window)', { start: '22:00', end: '06:00' }],
      ['start after end by a minute', { start: '09:01', end: '09:00' }],
    ])('rejects %s', (_label, over) => {
      expect(hotLeadCallConfigOf(withWindow(over))).toBeNull();
    });
    it('rejects a window that is not an object', () => {
      expect(hotLeadCallConfigOf(base({ team: [member({ windows: ['09:00-17:00'] })] }))).toBeNull();
      expect(hotLeadCallConfigOf(base({ team: [member({ windows: [null] })] }))).toBeNull();
    });
    it('accepts 24:00 as an end, a one-minute window and all seven days including 0 and 6', () => {
      expect(hotLeadCallConfigOf(withWindow({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }))).not.toBeNull();
      expect(hotLeadCallConfigOf(withWindow({ start: '09:00', end: '09:01' }))).not.toBeNull();
      expect(hotLeadCallConfigOf(withWindow({ start: '23:59', end: '24:00' }))).not.toBeNull();
    });
    it('does not alias the caller input', () => {
      const raw = withWindow({});
      const config = hotLeadCallConfigOf(raw) as HotLeadCallConfig;
      config.team[0].windows[0].days.push(6);
      expect(raw.team[0].windows[0].days).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe.each(HOT_LEAD_CALL_LIMIT_FIELDS)('%s bounds', field => {
    const { min, max, default: dflt } = HOT_LEAD_CALL_LIMITS[field];
    it('accepts the bounds and defaults when absent', () => {
      expect(hotLeadCallConfigOf(base({ [field]: min }))?.[field]).toBe(min);
      expect(hotLeadCallConfigOf(base({ [field]: max }))?.[field]).toBe(max);
      expect(hotLeadCallConfigOf(base())?.[field]).toBe(dflt);
    });
    it.each([min - 1, max + 1, 1.5, '5', null, NaN])('rejects %j', value => {
      expect(hotLeadCallConfigOf(base({ [field]: value }))).toBeNull();
    });
  });
  it('bounds maxCallsPerMonth to 1..2000 with a default of 150 (the included allowance), and a config without it reads as 150', () => {
    expect(HOT_LEAD_CALL_LIMITS.maxCallsPerMonth).toEqual({ default: 150, min: 1, max: 2000 });
    expect(hotLeadCallConfigOf(base())?.maxCallsPerMonth).toBe(150);
    expect(HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH).toBe(200); // owners may still raise it to 200
    expect(hotLeadCallConfigOf(base({ maxCallsPerMonth: 2000 }))?.maxCallsPerMonth).toBe(2000);
    expect(hotLeadCallConfigOf(base({ maxCallsPerMonth: 1500 }))?.maxCallsPerMonth).toBe(1500);
    for (const bad of [0, 2001, 1.5, '200', null, NaN]) expect(hotLeadCallConfigOf(base({ maxCallsPerMonth: bad }))).toBeNull();
  });
  it('bounds maxAttemptsPerLead to 1..5 with a default of 3', () => {
    expect(HOT_LEAD_CALL_LIMITS.maxAttemptsPerLead).toEqual({ default: 3, min: 1, max: 5 });
  });

  describe('enabled requires a verified member, a caller number and calling hours', () => {
    it('accepts the complete enabled config', () => expect(hotLeadCallConfigOf(enabledBase())).not.toBeNull());
    it.each(['team', 'twilioNumber', 'callingHours'])('rejects enabled without %s', field => {
      const raw = field === 'team' ? enabledBase({ team: [member()] }) : enabledBase({ [field]: undefined });
      expect(hotLeadCallConfigOf(raw)).toBeNull();
    });
    it('rejects enabled when no member is verified, however many there are', () => {
      expect(hotLeadCallConfigOf(enabledBase({ team: [member(), member({ id: 'mzzzzzz2', phone: '+14155550101' })] }))).toBeNull();
    });
    it('accepts enabled when only one of several members is verified', () => {
      const team = [member(), member({ id: 'mzzzzzz2', phone: '+14155550101', verifiedAt: VERIFIED })];
      expect(hotLeadCallConfigOf(enabledBase({ team }))).not.toBeNull();
    });
    it('allows the same incomplete config when disabled', () => {
      expect(hotLeadCallConfigOf(enabledBase({ enabled: false, team: [member()], twilioNumber: undefined, callingHours: undefined }))).not.toBeNull();
    });
  });
});

describe('generateMemberId', () => {
  it('returns a prefixed 7-character lowercase base36 id that the validator accepts', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateMemberId();
      expect(id).toMatch(/^m[a-z0-9]{7}$/);
      expect(hotLeadCallConfigOf(base({ team: [member({ id })] }))).not.toBeNull();
    }
  });
  it('does not repeat in a large sample', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateMemberId()));
    expect(ids.size).toBe(500);
  });
  it('draws again when the id is already on the team', () => {
    const mocked = randomInt as jest.Mock;
    const actual = jest.requireActual('crypto').randomInt;
    mocked.mockReset();
    mocked.mockImplementation(() => 0);
    const taken = 'm0000000';
    // Every draw of a constant 0 yields the taken id; from the second draw on the generator is released.
    let draws = 0;
    mocked.mockImplementation((max: number) => (draws++ < 7 ? 0 : actual(max)));
    const id = generateMemberId([taken]);
    expect(id).not.toBe(taken);
    expect(draws).toBeGreaterThan(7);
    mocked.mockImplementation(actual);
  });
});

describe('callableLeadPhone', () => {
  const both = { allowedCountries: ['US', 'CA'] as Array<'US' | 'CA'> };
  it.each(['(415) 555-0123', '+14155550123', '415-555-0123'])('returns the E.164 number for %s', (raw) => {
    expect(callableLeadPhone(raw, both)).toEqual({ phone: '+14155550123' });
  });
  it.each([undefined, null, 5, '', 'not a number', '+442071838750', '+18005550123'])('refuses %j as invalid_phone', (raw) => {
    expect(callableLeadPhone(raw, both)).toEqual({ reason: 'invalid_phone' });
  });
  it.each(['+14165550123', '+16475550123'])('refuses Canadian %s as country_not_allowed even when allowedCountries includes CA (ENG-2783)', (raw) => {
    expect(callableLeadPhone(raw, both)).toEqual({ reason: 'country_not_allowed' });
  });
  it('refuses a country outside the org allowedCountries', () => {
    expect(callableLeadPhone('+14155550123', { allowedCountries: ['CA'] })).toEqual({ reason: 'country_not_allowed' });
  });
});
