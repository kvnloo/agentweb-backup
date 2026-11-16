jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
import { orgDb } from '../services/db';
import {
  applyHotLeadCallSettings, getHotLeadCallSettings, hotLeadCallRevisionOf, previewHotLeadCallSettings, updateHotLeadCallSettings,
  BLOCKER_NO_CALLABLE_COUNTRY, BLOCKER_NO_HOURS, BLOCKER_NO_LEAD_OVERLAP, BLOCKER_NO_NUMBER, OWNER_MONTHLY_LIMIT_REFUSAL, WARNING_CANADA_NOT_CALLED, BLOCKER_NO_VERIFIED_PERSON, BLOCKER_NOT_ENTITLED, BLOCKER_UNVERIFIED,
} from '../services/hotLeadCallSettingsService';
import {
  ConflictError, ForbiddenError, NotEntitledError, RevisionRequiredError, UnattendedRunError, ValidationError,
} from '../services/hotLeadCallErrors';
import { hotLeadCallConfigOf } from '../services/hotLeadCallConfig';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { cloneJson, installFakeOrgTable, type FakeOrgTable } from './helpers/fakeOrgTable';
import { EVERY_DAY, storedConfigFixture, teamMember } from './helpers/hotLeadCallFixtures';

const OWNER = { userId: 'owner', orgRole: 'owner' };
const A = 'maaaaaaa';
const B = 'mbbbbbbb';
const PHONE_A = '+14155550100';
const PHONE_B = '+14155550122';
const SID = 'PN' + 'b'.repeat(32);
const WEEKDAYS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

const stored = (extra: Record<string, unknown> = {}) => storedConfigFixture(extra, [
  teamMember(PHONE_A), teamMember(PHONE_B, { id: B, name: 'Sam Ortiz', verifiedAt: undefined, windows: [WEEKDAYS] }),
]);

let table: FakeOrgTable;
// A snapshot, as a handler would have read it: later changes to the table must not alter what the service holds.
const org = () => cloneJson(table.org) as never;
const rev = () => hotLeadCallRevisionOf(table.org.hotLeadCall);
const put = (body: Record<string, unknown>, caller: Record<string, unknown> = OWNER) =>
  updateHotLeadCallSettings(org(), caller as never, { _revision: rev(), ...body });
const storedTeam = () => (table.org.hotLeadCall as { team: Array<Record<string, unknown>> }).team;
const fieldErrorsOf = async (promise: Promise<unknown>) => {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors ?? {};
};
const member = (over: Record<string, unknown> = {}) => ({ name: 'Kim Park', phone: '+14155550133', windows: [WEEKDAYS], ...over });

beforeEach(() => {
  jest.clearAllMocks();
  setHotLeadCallEntitledOverride(true);
  table = { org: { orgId: 'org-a', ownerUserId: 'owner', hotLeadCall: stored() }, writes: [], beforeWrite: null };
  installFakeOrgTable(orgDb as never, table);
});
afterEach(() => setHotLeadCallEntitledOverride(null));

describe('getHotLeadCallSettings', () => {
  it('returns exactly the contract fields with masked phones and no full number anywhere', async () => {
    const dto = await getHotLeadCallSettings(org(), OWNER);
    expect(Object.keys(dto).sort()).toEqual(['_revision', 'blockers', 'callingHours', 'canEnable', 'enabled', 'entitled', 'limits', 'maxAttemptsPerLead', 'maxCallsPerMonth', 'warnings', 'announcedName', 'team', 'twilioNumberMasked'].sort());
    expect(dto).toMatchObject({
      entitled: true, enabled: true, canEnable: true, blockers: [], maxAttemptsPerLead: 3, announcedName: 'Acme Plumbing', twilioNumberMasked: '***0111',
      callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
      team: [
        { id: A, name: 'Dana Lee', phoneMasked: '***0100', verified: true, windows: [EVERY_DAY] },
        { id: B, name: 'Sam Ortiz', phoneMasked: '***0122', verified: false, windows: [WEEKDAYS] },
      ],
      limits: { maxTeamSize: 10, maxWindowsPerMember: 7, minAttempts: 1, maxAttempts: 5, nameMaxLength: 40 },
    });
    expect(Object.keys(dto.team[0]).sort()).toEqual(['id', 'name', 'phoneMasked', 'verified', 'windows']);
    const json = JSON.stringify(dto);
    for (const leak of ['4155550100', '4155550122', '4155550111', SID, 'verifiedAt']) expect(json).not.toContain(leak);
  });

  it('answers 200-shaped defaults for an org with no settings', async () => {
    delete table.org.hotLeadCall;
    expect(await getHotLeadCallSettings(org(), OWNER)).toMatchObject({
      enabled: false, team: [], callingHours: null, canEnable: false, entitled: true, announcedName: '', twilioNumberMasked: null,
      blockers: [BLOCKER_NO_VERIFIED_PERSON, BLOCKER_NO_HOURS, BLOCKER_NO_NUMBER],
    });
  });

  it('explains in plain English what blocks enabling, one reason per missing requirement', async () => {
    setHotLeadCallEntitledOverride(false);
    table.org.hotLeadCall = stored({ enabled: false, team: [teamMember(PHONE_A, { verifiedAt: undefined })], twilioNumber: undefined, twilioNumberSid: undefined, callingHours: undefined });
    const dto = await getHotLeadCallSettings(org(), OWNER);
    expect(dto).toMatchObject({ entitled: false, canEnable: false, blockers: [BLOCKER_NOT_ENTITLED, BLOCKER_UNVERIFIED, BLOCKER_NO_HOURS, BLOCKER_NO_NUMBER] });
    expect(BLOCKER_NOT_ENTITLED).toBe('Your plan does not include hot-lead calls');
    expect(BLOCKER_NO_NUMBER).toBe('A phone number for calls has not been set up yet (ask Emma)');
  });

  it('refuses callers without org:configure, including global admins', async () => {
    await expect(getHotLeadCallSettings(org(), { userId: 'm', orgRole: 'member' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getHotLeadCallSettings(org(), { userId: 'm' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getHotLeadCallSettings(org(), { userId: 'a', orgRole: 'admin' })).resolves.toBeDefined();
  });

  it('fails closed on a stored config that no longer validates', async () => {
    (table.org.hotLeadCall as Record<string, unknown>).maxCallsPerDay = 9999;
    await expect(getHotLeadCallSettings(org(), OWNER)).rejects.toThrow('invalid');
  });

  it('derives the revision from the canonical JSON: key order is irrelevant, any stored change is not', () => {
    const base = stored();
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(hotLeadCallRevisionOf(reordered)).toBe(hotLeadCallRevisionOf(base));
    expect(hotLeadCallRevisionOf(stored({ maxCallsPerDay: 21 }))).not.toBe(hotLeadCallRevisionOf(base));
    expect(hotLeadCallRevisionOf(undefined)).toBe(hotLeadCallRevisionOf(null));
    expect(hotLeadCallRevisionOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('updateHotLeadCallSettings: revision and concurrency', () => {
  it('requires the revision', async () => {
    await expect(updateHotLeadCallSettings(org(), OWNER, { maxAttemptsPerLead: 2 })).rejects.toBeInstanceOf(RevisionRequiredError);
    expect(table.writes).toEqual([]);
  });
  it('refuses a stale revision without writing', async () => {
    await expect(updateHotLeadCallSettings(org(), OWNER, { _revision: 'f'.repeat(64), maxAttemptsPerLead: 2 })).rejects.toBeInstanceOf(ConflictError);
    expect(table.writes).toEqual([]);
  });
  it('a verification landing after the copy was read makes the old revision stale', async () => {
    const before = rev();
    storedTeam()[1].verifiedAt = '2026-02-02T00:00:00.000Z';
    await expect(updateHotLeadCallSettings(org(), OWNER, { _revision: before, maxAttemptsPerLead: 2 })).rejects.toBeInstanceOf(ConflictError);
  });
  it('returns a fresh revision that matches the stored value, so a second save can follow', async () => {
    const first = await put({ maxAttemptsPerLead: 2 });
    expect(first._revision).toBe(rev());
    const second = await updateHotLeadCallSettings(org(), OWNER, { _revision: first._revision, maxAttemptsPerLead: 4 });
    expect(second.maxAttemptsPerLead).toBe(4);
  });
  it('a concurrent editor between the read and the write loses cleanly: the conditional write fails and nothing is clobbered', async () => {
    table.beforeWrite = () => { (table.org.hotLeadCall as Record<string, unknown>).maxCallsPerDay = 50; };
    await expect(put({ maxAttemptsPerLead: 2 })).rejects.toBeInstanceOf(ConflictError);
    expect((table.org.hotLeadCall as Record<string, unknown>).maxCallsPerDay).toBe(50);
    expect((table.org.hotLeadCall as Record<string, unknown>).maxAttemptsPerLead).toBe(3);
  });
  it('writes conditionally on the stored config as it was read', async () => {
    const before = cloneJson(table.org.hotLeadCall);
    await put({ maxAttemptsPerLead: 2 });
    expect(table.writes[0].condition!.expression).toBe('#previousHotLeadCall = :previousHotLeadCall');
    expect(table.writes[0].condition!.values![':previousHotLeadCall']).toEqual(before);
  });
});

describe('updateHotLeadCallSettings: team semantics', () => {
  it('the order of team is the priority order', async () => {
    const dto = await put({ team: [{ id: B, name: 'Sam Ortiz', windows: [WEEKDAYS] }, { id: A, name: 'Dana Lee', windows: [EVERY_DAY] }] });
    expect(dto.team.map(m => m.id)).toEqual([B, A]);
    expect(storedTeam().map(m => m.id)).toEqual([B, A]);
  });
  it('removes ids missing from the array and drops their verification record, keeping the org-wide counter', async () => {
    table.org.hotLeadCallVerification = {
      members: {
        [A]: { phone: PHONE_A, codeHash: null, expiresAt: 0, attempts: 0, startedAt: [1000] },
        [B]: { phone: PHONE_B, codeHash: 'a'.repeat(64), expiresAt: Date.now() + 1e6, attempts: 0, startedAt: [2000] },
      },
      orgStartedAt: [1000, 2000],
    };
    await put({ team: [{ id: A, name: 'Dana Lee', windows: [EVERY_DAY] }] });
    expect(storedTeam().map(m => m.id)).toEqual([A]);
    expect(Object.keys((table.org.hotLeadCallVerification as { members: object }).members)).toEqual([A]);
    expect((table.org.hotLeadCallVerification as { orgStartedAt: number[] }).orgStartedAt).toEqual([1000, 2000]);
    expect(table.writes[0].condition!.expression).toContain('previousHotLeadCallVerification');
  });
  it('gives a new person a server-generated id, never a client-chosen one, and requires their phone', async () => {
    const dto = await put({ team: [{ id: A, windows: [EVERY_DAY], name: 'Dana Lee' }, member()] });
    expect(dto.team[1].id).toMatch(/^m[a-z0-9]{7}$/);
    expect(dto.team[1]).toMatchObject({ name: 'Kim Park', phoneMasked: '***0133', verified: false });
    expect(storedTeam()[1].phone).toBe('+14155550133');
    const errors = await fieldErrorsOf(put({ team: [{ id: A, name: 'Dana Lee', windows: [EVERY_DAY] }, member({ id: 'mzzzzzzz' })] }));
    expect(errors).toHaveProperty(['team.1.id']);
    const noPhone = await fieldErrorsOf(put({ team: [{ id: A, name: 'Dana Lee', windows: [EVERY_DAY] }, member({ phone: undefined })] }));
    expect(noPhone).toHaveProperty(['team.1.phone']);
  });
  it('a phone left out of an existing entry is unchanged and stays verified', async () => {
    await put({ team: [{ id: A, name: 'Dana L', windows: [EVERY_DAY] }] });
    expect(storedTeam()[0]).toMatchObject({ id: A, name: 'Dana L', phone: PHONE_A, verifiedAt: '2026-01-01T00:00:00.000Z' });
  });
  it('re-sending the same phone in another format keeps it verified', async () => {
    await put({ team: [{ id: A, name: 'Dana Lee', phone: '(415) 555-0100', windows: [EVERY_DAY] }] });
    expect(storedTeam()[0].verifiedAt).toBe('2026-01-01T00:00:00.000Z');
  });
  it('a changed phone clears that person\'s verification and the code in flight, but keeps the start history', async () => {
    table.org.hotLeadCallVerification = {
      members: { [A]: { phone: PHONE_A, codeHash: 'a'.repeat(64), expiresAt: Date.now() + 1e6, attempts: 2, callSid: 'CA1', startedAt: [1000] } },
      orgStartedAt: [1000],
    };
    await put({ enabled: false, team: [{ id: A, name: 'Dana Lee', phone: '+16475550123', windows: [EVERY_DAY] }] });
    expect(storedTeam()[0]).not.toHaveProperty('verifiedAt');
    expect(storedTeam()[0].phone).toBe('+16475550123');
    expect((table.org.hotLeadCallVerification as { members: Record<string, unknown> }).members[A]).toEqual({
      phone: '+16475550123', codeHash: null, expiresAt: 0, attempts: 0, startedAt: [1000],
    });
  });
  it('turns calling off, instead of leaving it on and broken, when the only verified phone changes', async () => {
    storedTeam().splice(1, 1);
    const dto = await put({ team: [{ id: A, name: 'Dana Lee', phone: '+16475550123', windows: [EVERY_DAY] }] });
    expect(dto.enabled).toBe(false);
    expect((table.org.hotLeadCall as { enabled: boolean }).enabled).toBe(false);
  });
  it('but an explicit enabled:true on such an edit is an error naming the blocker', async () => {
    storedTeam().splice(1, 1);
    const errors = await fieldErrorsOf(put({ enabled: true, team: [{ id: A, name: 'Dana Lee', phone: '+16475550123', windows: [EVERY_DAY] }] }));
    expect(errors.enabled).toContain(BLOCKER_UNVERIFIED);
    expect(table.writes).toEqual([]);
  });
  it('cannot set verification from the body, nor system fields', async () => {
    const errors = await fieldErrorsOf(put({ team: [{ id: A, name: 'Dana Lee', windows: [EVERY_DAY], verifiedAt: '2026-05-05T00:00:00.000Z' }] }));
    expect(errors).toHaveProperty(['team.0.verifiedAt']);
    await expect(put({ twilioNumber: '+14155550999' })).rejects.toThrow('managed by the system');
    await expect(put({ bogus: 1 })).rejects.toThrow('Unknown setting');
    expect(table.writes).toEqual([]);
  });
  it('rejects duplicate people, duplicate phones and the calling number as a person\'s phone, each at its position', async () => {
    expect(await fieldErrorsOf(put({ team: [{ id: A, name: 'x', windows: [EVERY_DAY] }, { id: A, name: 'y', windows: [EVERY_DAY] }] }))).toHaveProperty(['team.1.id']);
    expect(await fieldErrorsOf(put({ team: [member(), member({ name: 'Other' })] }))).toHaveProperty(['team.1.phone']);
    expect(await fieldErrorsOf(put({ team: [member({ phone: '+14155550111' })] }))).toHaveProperty(['team.0.phone']);
  });
  it('enforces the size limits: 10 people, 7 windows each', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => member({ name: `P ${i}`, phone: `+1415555${String(1000 + i)}` }));
    expect(await fieldErrorsOf(put({ team: eleven }))).toHaveProperty('team');
    expect(await fieldErrorsOf(put({ team: [] }))).toHaveProperty('team');
    expect(await fieldErrorsOf(put({ team: [member({ windows: Array.from({ length: 8 }, () => WEEKDAYS) })] }))).toHaveProperty(['team.0.windows']);
    expect(await fieldErrorsOf(put({ team: [member({ windows: [] })] }))).toHaveProperty(['team.0.windows']);
    const ten = Array.from({ length: 10 }, (_, i) => member({ name: `P ${i}`, phone: `+1415555${String(1000 + i)}` }));
    expect((await put({ enabled: false, team: ten })).team).toHaveLength(10);
  });
});

describe('updateHotLeadCallSettings: field errors by position', () => {
  it('keys every problem by its path in the submitted body', async () => {
    const errors = await fieldErrorsOf(put({
      announcedName: '<Say>',
      maxAttemptsPerLead: 9,
      callingHours: { start: '8am', end: '18:00', timezone: 'UTC' },
      team: [
        { id: A, name: 'Dana Lee', windows: [EVERY_DAY] },
        { name: '', phone: 'abc', windows: [{ days: [], start: '9', end: '25:00' }, { days: [1], start: '10:00', end: '09:00' }] },
      ],
    }));
    expect(Object.keys(errors).sort()).toEqual([
      'announcedName', 'callingHours.start', 'callingHours.timezone', 'maxAttemptsPerLead',
      'team.1.name', 'team.1.phone', 'team.1.windows.0.days', 'team.1.windows.1.end',
    ].sort());
  });
  it('accepts a body of only the revision and the enable switch', async () => {
    table.org.hotLeadCall = stored({ enabled: false });
    expect((await updateHotLeadCallSettings(org(), OWNER, { _revision: rev(), enabled: true })).enabled).toBe(true);
  });
  describe('the paid add-on (HOT_LEAD_CALL_BILLING_REQUIRED) on the portal save, which has no purchase hook', () => {
    afterEach(() => { delete process.env.HOT_LEAD_CALL_BILLING_REQUIRED; });
    it('refuses turning calling on while required and not active, with the way to subscribe', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      table.org.hotLeadCall = stored({ enabled: false });
      await expect(updateHotLeadCallSettings(org(), OWNER, { _revision: rev(), enabled: true })).rejects.toThrow(/add-on/);
      expect((table.org.hotLeadCall as { enabled: boolean }).enabled).toBe(false);
    });
    it('allows it once the add-on is active, and always allows saving without turning calling on', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      table.org.hotLeadCall = stored({ enabled: false });
      expect((await updateHotLeadCallSettings(org(), OWNER, { _revision: rev(), maxAttemptsPerLead: 2 })).enabled).toBe(false);
      table.org.hotLeadCallBilling = { itemId: 'si_1', status: 'active', updatedAt: 'x' };
      expect((await updateHotLeadCallSettings(org(), OWNER, { _revision: rev(), enabled: true })).enabled).toBe(true);
    });
  });
  describe('the portal read-out when the plan has the feature but the add-on is not active', () => {
    afterEach(() => { delete process.env.HOT_LEAD_CALL_BILLING_REQUIRED; });
    it('stays entitled, and says how to get the add-on instead of "your plan does not include it"', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      table.org.hotLeadCall = stored({ enabled: false });
      const dto = await getHotLeadCallSettings(org(), OWNER);
      expect(dto.entitled).toBe(true);
      expect(dto.canEnable).toBe(false);
      expect(dto.blockers.join(' ')).toMatch(/add-on.*Ask Emma/);
      expect(dto.blockers).not.toContain('Your plan does not include hot-lead calls');
    });
    it('shows the add-on blocker to an org that is already on, so an enabled org that cannot call sees why', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      table.org.hotLeadCall = stored({ enabled: true });
      table.org.hotLeadCallBilling = { itemId: 'si_1', status: 'past_due', updatedAt: 'x' };
      expect((await getHotLeadCallSettings(org(), OWNER)).blockers.join(' ')).toMatch(/add-on/);
    });
    it('has no add-on blocker once the add-on is active, or when billing is not required', async () => {
      table.org.hotLeadCall = stored({ enabled: false });
      expect((await getHotLeadCallSettings(org(), OWNER)).blockers.join(' ')).not.toMatch(/add-on/);
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      table.org.hotLeadCallBilling = { itemId: 'si_1', status: 'active', updatedAt: 'x' };
      expect((await getHotLeadCallSettings(org(), OWNER)).blockers.join(' ')).not.toMatch(/add-on/);
    });
  });
  it('does not require calling hours until calling is enabled', async () => {
    delete table.org.hotLeadCall;
    const dto = await updateHotLeadCallSettings(org(), OWNER, { _revision: rev(), team: [member()], announcedName: 'New Co', maxAttemptsPerLead: 2 });
    expect(dto).toMatchObject({ enabled: false, callingHours: null, maxAttemptsPerLead: 2, team: [{ verified: false }] });
    expect(hotLeadCallConfigOf(table.org.hotLeadCall)).not.toBeNull();
  });
  it('a first save needs a team and a business name', async () => {
    delete table.org.hotLeadCall;
    const errors = await fieldErrorsOf(updateHotLeadCallSettings(org(), OWNER, { _revision: rev(), enabled: false }));
    expect(Object.keys(errors).sort()).toEqual(['announcedName', 'team']);
  });
  it('normalises the timezone case', async () => {
    const dto = await put({ callingHours: { start: '09:00', end: '18:00', timezone: 'AMERICA/NEW_YORK' } });
    expect(dto.callingHours).toEqual({ start: '09:00', end: '18:00', timezone: 'America/New_York' });
  });
});

describe('updateHotLeadCallSettings: enabling', () => {
  beforeEach(() => { table.org.hotLeadCall = stored({ enabled: false }); });
  it('is refused when the plan does not include hot-lead calls, with a typed error', async () => {
    setHotLeadCallEntitledOverride(false);
    await expect(put({ enabled: true })).rejects.toBeInstanceOf(NotEntitledError);
    expect(table.writes).toEqual([]);
    expect((await put({ maxAttemptsPerLead: 2 })).enabled).toBe(false);
  });
  it('an org already on keeps being editable after losing its plan', async () => {
    table.org.hotLeadCall = stored();
    setHotLeadCallEntitledOverride(false);
    expect((await put({ enabled: true, maxAttemptsPerLead: 2 })).maxAttemptsPerLead).toBe(2);
  });
  it.each([
    ['no verified person', { team: [teamMember(PHONE_A, { verifiedAt: undefined })] }, BLOCKER_UNVERIFIED],
    ['no caller number', { twilioNumber: undefined, twilioNumberSid: undefined }, BLOCKER_NO_NUMBER],
    ['no calling hours', { callingHours: undefined }, BLOCKER_NO_HOURS],
  ])('is refused with %s', async (_label, over, blocker) => {
    table.org.hotLeadCall = stored({ enabled: false, ...over });
    const errors = await fieldErrorsOf(put({ enabled: true }));
    expect(errors.enabled).toContain(blocker);
    expect(table.writes).toEqual([]);
  });
  it('succeeds when every requirement is met', async () => {
    expect(await put({ enabled: true })).toMatchObject({ enabled: true, canEnable: true });
  });
});

describe('updateHotLeadCallSettings: unattended runs', () => {
  const unattended = { ...OWNER, unattended: true };
  it.each([
    ['raising a daily cap', { maxCallsPerDay: 100 }],
    ['raising attempts per lead', { maxAttemptsPerLead: 5 }],
    ['shortening the member pause', { memberCooldownMinutes: 1 }],
    ['widening the calling hours', { callingHours: { start: '07:00', end: '21:00', timezone: 'America/Chicago' } }],
    ['moving the calling hours to another zone', { callingHours: { start: '08:00', end: '21:00', timezone: 'America/New_York' } }],
    ['editing the team', { team: [{ id: A, name: 'Dana Lee', windows: [EVERY_DAY] }] }],
    ['changing the business name read aloud', { announcedName: 'Somebody Else Ltd' }],
    ['turning calling on', { enabled: true }],
  ])('refuses %s', async (_label, body) => {
    if (_label === 'turning calling on') table.org.hotLeadCall = stored({ enabled: false });
    await expect(put(body, unattended)).rejects.toBeInstanceOf(UnattendedRunError);
    expect(table.writes).toEqual([]);
  });
  it('still allows lowering limits, narrowing hours and turning calling off', async () => {
    const dto = await put({ enabled: false, maxCallsPerDay: 5, callingHours: { start: '09:00', end: '20:00', timezone: 'America/Chicago' } }, unattended);
    expect(dto).toMatchObject({ enabled: false, callingHours: { start: '09:00', end: '20:00' } });
  });
  it('a wrapping calling window is compared by the minutes it covers', async () => {
    table.org.hotLeadCall = stored({ callingHours: { start: '22:00', end: '06:00', timezone: 'America/Chicago' } });
    await expect(put({ callingHours: { start: '21:00', end: '06:00', timezone: 'America/Chicago' } }, unattended)).rejects.toBeInstanceOf(UnattendedRunError);
    await expect(put({ callingHours: { start: '23:00', end: '05:00', timezone: 'America/Chicago' } }, unattended)).resolves.toBeDefined();
  });
});

describe('applyHotLeadCallSettings', () => {
  it('returns the stored config alongside the DTO', async () => {
    const { config, dto } = await applyHotLeadCallSettings(org(), OWNER, { _revision: rev(), maxAttemptsPerLead: 2 });
    expect(config.maxAttemptsPerLead).toBe(2);
    expect(dto.maxAttemptsPerLead).toBe(2);
  });
});

describe('applyHotLeadCallSettings: beforeTurningOn', () => {
  const apply = (body: Record<string, unknown>, hook: jest.Mock, caller: Record<string, unknown> = OWNER) =>
    applyHotLeadCallSettings(org(), caller as never, { _revision: rev(), ...body }, hook);
  beforeEach(() => { table.org.hotLeadCall = stored({ enabled: false }); });

  it('runs once, with the config about to be written, when calling is turned on, and before the write', async () => {
    const hook = jest.fn().mockImplementation(async () => { expect(table.writes).toEqual([]); });
    await apply({ enabled: true }, hook);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({ enabled: true, twilioNumber: '+14155550111' });
    expect(table.writes).toHaveLength(1);
  });
  it('sees the team as it will be after the edit, with the new names and verification', async () => {
    const hook = jest.fn();
    await apply({ enabled: true, team: [{ id: A, name: 'Dana L. Lee', windows: [EVERY_DAY] }] }, hook);
    expect(hook.mock.calls[0][0].team).toMatchObject([{ id: A, name: 'Dana L. Lee', phone: PHONE_A, verifiedAt: expect.any(String) }]);
  });
  it('stops the write when it throws', async () => {
    const hook = jest.fn().mockRejectedValue(new Error('halt'));
    await expect(apply({ enabled: true }, hook)).rejects.toThrow('halt');
    expect(table.writes).toEqual([]);
  });
  it.each([
    ['turning calling off', { enabled: false }, true],
    ['another edit while off', { maxAttemptsPerLead: 2 }, false],
    ['enabled:true while already on', { enabled: true }, true],
    ['another edit while on', { maxAttemptsPerLead: 2 }, true],
  ])('does not run for %s', async (_label, body, on) => {
    table.org.hotLeadCall = stored({ enabled: on });
    const hook = jest.fn();
    await apply(body, hook);
    expect(hook).not.toHaveBeenCalled();
  });
  it.each([
    ['an unattended run', { ...OWNER, unattended: true }, UnattendedRunError, {}],
    ['a plan without the feature', OWNER, NotEntitledError, { entitled: false }],
    ['a setup that cannot be turned on', OWNER, ValidationError, { twilioNumber: undefined, twilioNumberSid: undefined }],
  ])('runs after the refusals: not for %s', async (_label, caller, error, over) => {
    if ('entitled' in over) setHotLeadCallEntitledOverride(false);
    else table.org.hotLeadCall = stored({ enabled: false, ...over });
    const hook = jest.fn();
    await expect(apply({ enabled: true }, hook, caller)).rejects.toBeInstanceOf(error);
    expect(hook).not.toHaveBeenCalled();
  });
  it('is optional: without it (the REST path) calling is turned on directly', async () => {
    expect((await put({ enabled: true })).enabled).toBe(true);
  });
});

describe('previewHotLeadCallSettings', () => {
  // Tuesday 2026-10-20 11:00 in Chicago (UTC-5 in October) is 16:00Z.
  const at = new Date('2026-10-20T16:00:00Z');
  it('lists candidates in call order and explains the exclusions with the two contract reasons', async () => {
    const dto = await previewHotLeadCallSettings(org(), OWNER, at);
    expect(dto).toEqual({
      at: at.toISOString(), timezone: 'America/Chicago', outsideCallingHours: false, outsideLeadHours: true, skipReason: 'outside_lead_hours',
      warnings: ['Canadian numbers are not called yet; leads with a Canadian number are skipped even though Canada is allowed here'],
      candidates: [{ id: A, name: 'Dana Lee' }],
      excluded: [{ id: B, name: 'Sam Ortiz', reason: 'unverified' }],
    });
  });
  it('is closed outside the calling hours and nobody is a candidate', async () => {
    const dto = await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T04:00:00Z'));
    expect(dto).toMatchObject({ outsideCallingHours: true, candidates: [] });
    expect(dto.excluded).toEqual([{ id: A, name: 'Dana Lee', reason: 'outside_window' }, { id: B, name: 'Sam Ortiz', reason: 'unverified' }]);
  });
  it('answers for an org with no settings', async () => {
    delete table.org.hotLeadCall;
    expect(await previewHotLeadCallSettings(org(), OWNER, at)).toEqual({ at: at.toISOString(), timezone: null, outsideCallingHours: true, outsideLeadHours: true, skipReason: 'outside_calling_hours', warnings: [], candidates: [], excluded: [] });
  });
  it('needs org:configure', async () => {
    await expect(previewHotLeadCallSettings(org(), { userId: 'm', orgRole: 'member' }, at)).rejects.toBeInstanceOf(ForbiddenError);
  });
});


// ---- ENG-2783: monthly cap on the owner routes ------------------------------------------------------------------

describe('maxCallsPerMonth on the owner routes', () => {
  it('shows the default of 150 for a config stored without the field', async () => {
    delete (table.org.hotLeadCall as Record<string, unknown>).maxCallsPerMonth;
    expect((await getHotLeadCallSettings(org(), OWNER)).maxCallsPerMonth).toBe(150);
  });
  it.each([1, 150, 200])('accepts %i', async value => {
    expect((await put({ maxCallsPerMonth: value })).maxCallsPerMonth).toBe(value);
    expect((table.org.hotLeadCall as Record<string, unknown>).maxCallsPerMonth).toBe(value);
  });
  it.each([201, 1500, 2000])('refuses %i with the support message, and writes nothing', async value => {
    const errors = await fieldErrorsOf(put({ maxCallsPerMonth: value }));
    expect(errors.maxCallsPerMonth).toBe(OWNER_MONTHLY_LIMIT_REFUSAL);
    expect(table.writes).toEqual([]);
  });
  it('words the refusal for the owner', () => {
    expect(OWNER_MONTHLY_LIMIT_REFUSAL).toBe('Higher monthly limits are set by AgentWeb support');
  });
  it.each([0, 2001, 1.5, '50', null])('refuses the invalid value %j', async value => {
    expect(Object.keys(await fieldErrorsOf(put({ maxCallsPerMonth: value })))).toContain('maxCallsPerMonth');
  });

  describe('a value an operator stored above 200', () => {
    beforeEach(() => { table.org.hotLeadCall = stored({ maxCallsPerMonth: 1500 }); });
    it('is displayed', async () => {
      expect((await getHotLeadCallSettings(org(), OWNER)).maxCallsPerMonth).toBe(1500);
    });
    it('is preserved when the owner edits other fields', async () => {
      const dto = await put({ announcedName: 'New Co', maxAttemptsPerLead: 2, callingHours: { start: '09:00', end: '20:00', timezone: 'America/Chicago' } });
      expect(dto.maxCallsPerMonth).toBe(1500);
      expect((table.org.hotLeadCall as Record<string, unknown>).maxCallsPerMonth).toBe(1500);
    });
    it('survives a round trip of the displayed value, but cannot be changed to another value above 200', async () => {
      expect((await put({ maxCallsPerMonth: 1500, announcedName: 'Same Co' })).maxCallsPerMonth).toBe(1500);
      expect((await fieldErrorsOf(put({ maxCallsPerMonth: 1501 }))).maxCallsPerMonth).toBe(OWNER_MONTHLY_LIMIT_REFUSAL);
    });
    it('can be lowered by the owner', async () => {
      expect((await put({ maxCallsPerMonth: 100 })).maxCallsPerMonth).toBe(100);
    });
  });

  it('an unattended run cannot raise it', async () => {
    table.org.hotLeadCall = stored({ maxCallsPerMonth: 100 });
    await expect(updateHotLeadCallSettings(org(), { ...OWNER, unattended: true }, { _revision: rev(), maxCallsPerMonth: 150 })).rejects.toBeInstanceOf(UnattendedRunError);
  });
});

// ---- ENG-2783: honest read-out ----------------------------------------------------------------------------------

describe('read-out: Canada while Canadian calling is off', () => {
  it('warns when the stored countries include Canada alongside the US, and still allows enabling', async () => {
    const dto = await getHotLeadCallSettings(org(), OWNER);
    expect(dto.warnings).toEqual([WARNING_CANADA_NOT_CALLED]);
    expect(dto).toMatchObject({ canEnable: true, blockers: [] });
  });
  it('has no warning for US only', async () => {
    table.org.hotLeadCall = stored({ allowedCountries: ['US'] });
    expect(await getHotLeadCallSettings(org(), OWNER)).toMatchObject({ warnings: [], canEnable: true, blockers: [] });
  });
  it('has no warning for an org without settings', async () => {
    delete table.org.hotLeadCall;
    expect((await getHotLeadCallSettings(org(), OWNER)).warnings).toEqual([]);
  });
  it('blocks, for an org whose only country is Canada, in canEnable and blockers, enabled or not', async () => {
    for (const enabled of [false, true]) {
      table.org.hotLeadCall = stored({ enabled, allowedCountries: ['CA'] });
      const dto = await getHotLeadCallSettings(org(), OWNER);
      expect(dto.canEnable).toBe(false);
      expect(dto.blockers).toEqual([BLOCKER_NO_CALLABLE_COUNTRY]);
      expect(dto.warnings).toEqual([WARNING_CANADA_NOT_CALLED]);
    }
  });
  it('refuses to turn calling on with only Canada, and writes nothing', async () => {
    table.org.hotLeadCall = stored({ enabled: false, allowedCountries: ['CA'] });
    expect((await fieldErrorsOf(put({ enabled: true }))).enabled).toContain(BLOCKER_NO_CALLABLE_COUNTRY);
    expect(table.writes).toEqual([]);
  });
  it('refuses to turn calling on in the same save that sets only Canada', async () => {
    table.org.hotLeadCall = stored({ enabled: false });
    expect((await fieldErrorsOf(put({ enabled: true, allowedCountries: ['CA'] }))).enabled).toContain(BLOCKER_NO_CALLABLE_COUNTRY);
  });
  it('lets an org that is already on keep it through an unrelated edit, and keeps showing the blocker', async () => {
    table.org.hotLeadCall = stored({ allowedCountries: ['CA'] });
    expect(await put({ announcedName: 'Other Co' })).toMatchObject({ enabled: true, canEnable: false, blockers: [BLOCKER_NO_CALLABLE_COUNTRY] });
  });
  it('shows the warning in the preview', async () => {
    expect((await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T19:00:00Z'))).warnings).toEqual([WARNING_CANADA_NOT_CALLED]);
  });
});

describe('read-out: calling hours that never meet the lead window', () => {
  it('words the blocker with the Eastern hours the owner must include', () => {
    expect(BLOCKER_NO_LEAD_OVERLAP).toContain('13:00 and 18:00 Eastern');
  });
  const hours = (start: string, end: string, timezone = 'America/Chicago') => ({ callingHours: { start, end, timezone } });
  it('the default 08:00-21:00 hours and the fixture hours pass', async () => {
    for (const tz of ['America/Chicago', 'America/New_York', 'America/Los_Angeles']) {
      table.org.hotLeadCall = stored(hours('08:00', '21:00', tz));
      expect((await getHotLeadCallSettings(org(), OWNER)).blockers).toEqual([]);
    }
  });
  it.each([
    ['early morning only (Chicago 06:00-09:00)', '06:00', '09:00', 'America/Chicago'],
    ['overnight (Chicago 22:00-04:00)', '22:00', '04:00', 'America/Chicago'],
    ['ends exactly when the lead window opens (Chicago 08:00-12:00 = 13:00 Eastern)', '08:00', '12:00', 'America/Chicago'],
    ['starts exactly when the lead window closes (Chicago 17:00-20:00 = 18:00 Eastern)', '17:00', '20:00', 'America/Chicago'],
    ['evening Eastern', '19:00', '23:00', 'America/New_York'],
    ['Pacific morning (06:00-09:59 = 09:00-12:59 Eastern)', '06:00', '09:59', 'America/Los_Angeles'],
  ])('is a blocker for %s', async (_n, start, end, tz) => {
    table.org.hotLeadCall = stored({ enabled: false, ...hours(start, end, tz) });
    const dto = await getHotLeadCallSettings(org(), OWNER);
    expect(dto).toMatchObject({ canEnable: false, blockers: [BLOCKER_NO_LEAD_OVERLAP] });
    expect((await fieldErrorsOf(put({ enabled: true }))).enabled).toContain(BLOCKER_NO_LEAD_OVERLAP);
    expect(table.writes).toEqual([]);
  });
  it.each([
    ['a wide valid window (00:00-23:59)', '00:00', '23:59', 'America/Chicago'],
    ['a wrapping window that covers the afternoon (14:00-02:00)', '14:00', '02:00', 'America/Chicago'],
    ['one 15-minute slot inside the lead window (Chicago 12:00-12:15 = 13:00 Eastern)', '12:00', '12:15', 'America/Chicago'],
    ['a 2-minute window inside the lead window (Chicago 12:04-12:06)', '12:04', '12:06', 'America/Chicago'],
    ['a 1-minute window at the last minute of the lead window (New York 17:59-18:00)', '17:59', '18:00', 'America/New_York'],
    ['the last minute before the lead window closes (Chicago 16:45-17:00)', '16:45', '17:00', 'America/Chicago'],
    ['Pacific afternoon (10:00-15:00)', '10:00', '15:00', 'America/Los_Angeles'],
    ['a zone far from the US (Europe/London 18:00-23:00 = 13:00-18:00 Eastern in winter)', '18:00', '23:00', 'Europe/London'],
  ])('is not a blocker for %s', async (_n, start, end, tz) => {
    table.org.hotLeadCall = stored({ enabled: false, ...hours(start, end, tz) });
    expect(await getHotLeadCallSettings(org(), OWNER)).toMatchObject({ canEnable: true, blockers: [] });
    expect((await put({ enabled: true })).enabled).toBe(true);
  });
  it('is shown for an org that is already on, and an unrelated edit does not turn it off', async () => {
    table.org.hotLeadCall = stored(hours('06:00', '09:00'));
    expect(await getHotLeadCallSettings(org(), OWNER)).toMatchObject({ enabled: true, canEnable: false, blockers: [BLOCKER_NO_LEAD_OVERLAP] });
    expect(await put({ announcedName: 'Other Co' })).toMatchObject({ enabled: true, blockers: [BLOCKER_NO_LEAD_OVERLAP] });
  });
  it('is gone once the hours are fixed', async () => {
    table.org.hotLeadCall = stored({ enabled: false, ...hours('06:00', '09:00') });
    expect(await put({ callingHours: { start: '09:00', end: '20:00', timezone: 'America/Chicago' }, enabled: true })).toMatchObject({ enabled: true, blockers: [] });
  });
  it('is not reported when there are no hours at all (the missing-hours blocker covers it)', async () => {
    table.org.hotLeadCall = stored({ enabled: false, callingHours: undefined });
    expect((await getHotLeadCallSettings(org(), OWNER)).blockers).toEqual([BLOCKER_NO_HOURS]);
  });
});

describe('preview: the lead window', () => {
  it('says the lead window is open, with no skip reason, when both gates are open', async () => {
    // 19:00Z on 2026-10-20 = 14:00 EDT = 11:00 PDT; Chicago 14:00 is inside 08:00-21:00.
    expect(await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T19:00:00Z'))).toMatchObject({ outsideCallingHours: false, outsideLeadHours: false, skipReason: null });
  });
  it('names outside_lead_hours when only the lead window is closed', async () => {
    // 15:00Z = 11:00 EDT, before the lead window; Chicago 10:00 is inside the org hours.
    expect(await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T15:00:00Z'))).toMatchObject({ outsideCallingHours: false, outsideLeadHours: true, skipReason: 'outside_lead_hours' });
  });
  it('names outside_calling_hours first when the org hours are closed', async () => {
    expect(await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T04:00:00Z'))).toMatchObject({ outsideCallingHours: true, outsideLeadHours: true, skipReason: 'outside_calling_hours' });
  });
  it('closes the lead window at 18:00 Eastern', async () => {
    expect((await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T21:59:00Z'))).outsideLeadHours).toBe(false);
    expect((await previewHotLeadCallSettings(org(), OWNER, new Date('2026-10-20T22:00:00Z'))).outsideLeadHours).toBe(true);
  });
});
