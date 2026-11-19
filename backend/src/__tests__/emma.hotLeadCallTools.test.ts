type Tool = { name: string; definition: { description: string; inputSchema: { properties: object } }; execute: (args: unknown, context: unknown) => Promise<Record<string, unknown>> };
const handlers = new Map<string, Tool>();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { register: (tool: Tool) => handlers.set(tool.name, tool) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn(), claimMetaWriteManifestDigest: jest.fn() } }));
import { readFileSync } from 'fs';
import { join } from 'path';
import { orgDb, userDb } from '../services/db';
import '../emma/hotLeadCallTools';
import { ConflictError } from '../services/hotLeadCallErrors';
import { teamMember, MEMBER_ID, EVERY_DAY, storedConfigFixture, STORED_NUMBER_SID } from './helpers/hotLeadCallFixtures';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

const get = (args: unknown = {}, context: unknown = { userId: 'owner' }) => handlers.get('get_hot_lead_call_settings')!.execute(args, context);
const update = (args: unknown, context: unknown = { userId: 'owner' }) => handlers.get('update_hot_lead_call_settings')!.execute(args, context);
const lastWrite = () => (orgDb.updateOrg as jest.Mock).mock.calls[0];
const SID = STORED_NUMBER_SID;

let org: { orgId: string; hotLeadCall?: Record<string, unknown>; [k: string]: unknown };
const cfg = (): Record<string, unknown> => {
  if (!org.hotLeadCall) throw new Error('test org has no stored hotLeadCall');
  return org.hotLeadCall;
};
const stored = () => storedConfigFixture();
const team = () => cfg().team as Array<Record<string, unknown>>;
beforeEach(() => {
  // The consistent re-read (ENG-3152) answers what the indexed read answers in these tests.
  (userDb.getUserByIdConsistent as jest.Mock).mockImplementation((id: string) => (userDb.getUserById as jest.Mock)(id));
  jest.clearAllMocks();
  setHotLeadCallEntitledOverride(true);
  org = { orgId: 'org-a', ownerUserId: 'owner', hotLeadCall: stored(), connected_accounts: [{ config: { access_token: 'secret' } }] };
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-a', orgRole: 'owner' });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue(org);
});

describe('get_hot_lead_call_settings', () => {
  it('masks the phone and hides system identifiers and credentials', async () => {
    const result = await get();
    expect(result).toMatchObject({
      success: true, enabled: true, callerNumberAssigned: true, maxAgeMinutes: 10, maxAttemptsPerLead: 3, memberCooldownMinutes: 2,
      team: [{ id: MEMBER_ID, name: 'Dana Lee', phoneMasked: '***0100', verified: true, windows: [EVERY_DAY] }],
      callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
    });
    const json = JSON.stringify(result);
    for (const leak of ['+14155550100', '4155550100', '+14155550111', SID, 'secret']) expect(json).not.toContain(leak);
  });
  it('reports an unconfigured org as disabled with default limits', async () => {
    delete org.hotLeadCall;
    expect(await get()).toMatchObject({ configured: false, enabled: false, team: [], callingHours: null, maxCallsPerHour: 6, maxAttemptsPerLead: 3 });
  });
  it('fails closed on malformed stored config', async () => {
    cfg().maxCallsPerDay = 9999;
    await expect(get()).rejects.toThrow('invalid');
  });
  it('shows the portal view: entitlement, blockers and no revision token', async () => {
    const result = await get();
    expect(result).toMatchObject({ entitled: true, canEnable: true, blockers: [], twilioNumberMasked: '***0111', announcedName: 'Acme Plumbing' });
    expect(result).not.toHaveProperty('_revision');
  });
  it('is for org owners and admins only, like the team view of the REST API', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'm', orgId: 'org-a', orgRole: 'member' });
    await expect(get({}, { userId: 'm' })).rejects.toThrow('owners and admins');
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'a', orgId: 'org-a', orgRole: 'admin' });
    expect((await get({}, { userId: 'a' })).success).toBe(true);
  });
});

describe('update_hot_lead_call_settings', () => {
  it('merges a partial update over the current config and preserves the rest', async () => {
    const result = await update({ maxCallsPerHour: 3, maxAttemptsPerLead: 5, callingHours: { start: '09:00' } });
    expect(result).toMatchObject({ maxCallsPerHour: 3, maxAttemptsPerLead: 5, enabled: true, callingHours: { start: '09:00', end: '21:00', timezone: 'America/Chicago' } });
    const [orgId, patch, options] = lastWrite();
    expect(orgId).toBe('org-a');
    expect(patch.hotLeadCall).toEqual({ ...stored(), maxCallsPerHour: 3, maxAttemptsPerLead: 5, callingHours: { start: '09:00', end: '21:00', timezone: 'America/Chicago' } });
    expect(options.condition.values[':previousHotLeadCall']).toEqual(stored());
    expect(options.condition.expression).toBe('#previousHotLeadCall = :previousHotLeadCall');
  });

  it('treats null optionals as omitted', async () => {
    await update({ enabled: null, maxCallsPerHour: 4, announcedName: null });
    expect(lastWrite()[1].hotLeadCall).toMatchObject({ enabled: true, maxCallsPerHour: 4, announcedName: 'Acme Plumbing' });
  });

  it('uses attribute_not_exists for the first write and creates a disabled config', async () => {
    delete org.hotLeadCall;
    const result = await update({ memberPhone: '(415) 555-0100', announcedName: 'New Co' });
    expect(result).toMatchObject({ enabled: false, team: [{ phoneMasked: '***0100', name: 'Team member', verified: false, windows: [EVERY_DAY] }], callerNumberAssigned: false });
    const options = lastWrite()[2];
    expect(options.condition.expression).toBe('attribute_not_exists(#previousHotLeadCall)');
    expect(options.condition.values).toBeUndefined();
    const [member] = lastWrite()[1].hotLeadCall.team;
    expect(member).toMatchObject({ phone: '+14155550100', name: 'Team member' });
    expect(member.id).toMatch(/^m[a-z0-9]{7}$/);
    expect(member).not.toHaveProperty('verifiedAt');
  });

  it('names the first member when memberName is sent', async () => {
    delete org.hotLeadCall;
    await update({ memberPhone: '+14155550100', memberName: '  Sam Ortiz ', announcedName: 'New Co' });
    expect(lastWrite()[1].hotLeadCall.team[0].name).toBe('Sam Ortiz');
  });

  it('refuses the first write without a member phone', async () => {
    delete org.hotLeadCall;
    await expect(update({ maxCallsPerHour: 3 })).rejects.toThrow('memberPhone is required');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('refuses the first write without an announced name', async () => {
    delete org.hotLeadCall;
    await expect(update({ memberPhone: '+14155550100' })).rejects.toThrow('Some settings are not valid');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('a first write that asks for enabled:true is refused, because the new phone is unverified', async () => {
    delete org.hotLeadCall;
    await expect(update({ memberPhone: '+14155550100', announcedName: 'New Co', enabled: true })).rejects.toThrow('Verify the phone');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('changing the phone clears verification and turns calling off', async () => {
    const result = await update({ memberPhone: '+16475550123' });
    const written = lastWrite()[1].hotLeadCall;
    expect(written.team).toEqual([{ id: MEMBER_ID, name: 'Dana Lee', phone: '+16475550123', windows: [EVERY_DAY] }]);
    expect(written.enabled).toBe(false);
    expect(written.twilioNumber).toBe('+14155550111');
    expect(result).toMatchObject({ enabled: false, team: [{ id: MEMBER_ID, verified: false, phoneMasked: '***0123' }] });
  });

  it('re-sending the same phone keeps verification and enabled state', async () => {
    await update({ memberPhone: '(415) 555-0100' });
    expect(lastWrite()[1].hotLeadCall).toMatchObject({ enabled: true, team: [{ id: MEMBER_ID, verifiedAt: '2026-01-01T00:00:00.000Z' }] });
  });

  it('can disable and cannot enable an unverified config', async () => {
    expect(await update({ enabled: false })).toMatchObject({ enabled: false });
    jest.clearAllMocks();
    delete team()[0].verifiedAt;
    cfg().enabled = false;
    await expect(update({ enabled: true })).rejects.toThrow('Verify the phone');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('refuses enabled:true when the org’s plan does not include hot lead calls, but still allows saving and disabling', async () => {
    setHotLeadCallEntitledOverride(false);
    cfg().enabled = false;
    await expect(update({ enabled: true })).rejects.toThrow('not included in your organization’s current plan');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
    expect(await update({ maxCallsPerHour: 4 })).toMatchObject({ enabled: false, maxCallsPerHour: 4 });
    expect(await update({ enabled: false })).toMatchObject({ enabled: false });
  });

  it('does not enable for an entitled org with a verified phone and a number without an attended chat to approve it', async () => {
    cfg().enabled = false;
    await expect(update({ enabled: true })).rejects.toThrow('attended chat session');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it.each(['+15555550100 x12', '(415) 555-0100 ext. 5', '+14155550100;ext=7'])('rejects a phone with an extension instead of dropping it: %s', async memberPhone => {
    await expect(update({ memberPhone })).rejects.toThrow('extension');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it.each(['+19002223333', '+18005550199'])('rejects toll-fraud member phone %s', async memberPhone => {
    await expect(update({ memberPhone })).rejects.toThrow('valid US or Canadian');
  });
  it.each(['08:00-21:00', 5, true, ['x']])('rejects a non-object callingHours %j instead of ignoring it', async callingHours => {
    await expect(update({ callingHours })).rejects.toThrow('callingHours must be an object');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it.each(['UTC', 'Mars/Olympus', 'Etc/UTC', '+05:00'])('names the timezone problem for %s', async timezone => {
    await expect(update({ callingHours: { timezone } })).rejects.toThrow(/callingHours\.timezone: Use a place name such as America\/Chicago/);
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('stores and echoes the normalised timezone, and re-sending the stored zone in another case still writes cleanly', async () => {
    const result = await update({ callingHours: { timezone: 'AMERICA/CHICAGO' } });
    expect(result.callingHours).toMatchObject({ timezone: 'America/Chicago' });
    expect(lastWrite()[1].hotLeadCall.callingHours.timezone).toBe('America/Chicago');
    expect(lastWrite()[2].condition.values[':previousHotLeadCall']).toEqual(stored());
    jest.clearAllMocks();
    await update({ callingHours: { timezone: 'US/Eastern' } });
    expect(lastWrite()[1].hotLeadCall.callingHours.timezone).toBe('America/New_York');
  });
  it('describes calling hours wrap, territory limits and the refused zones', () => {
    const def = handlers.get('update_hot_lead_call_settings')!.definition;
    expect(def.description).toMatch(/wraps past midnight/);
    expect(def.description).toMatch(/Puerto Rico/);
    expect(def.description).toMatch(/Etc\/ zones are refused/);
  });
  it('rejects a member phone equal to the assigned caller number', async () => {
    await expect(update({ memberPhone: '+14155550111' })).rejects.toThrow('Some settings are not valid');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it.each(['twilioNumber', 'twilioNumberSid'])('cannot set system field %s', async field => {
    await expect(update({ maxCallsPerHour: 3, [field]: field === 'twilioNumberSid' ? SID : '+14155550111' })).rejects.toThrow('managed by the system');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it.each([
    ['a whole team with a verification stamp', { team: [teamMember('+14155550100')] }, /team\.0\.verifiedAt: Verification is managed by the system/],
    ['a member verification time', { verifiedAt: '2026-02-02T00:00:00.000Z' }, /Invalid hot lead call settings arguments/],
    ['a member id', { memberId: 'mzzzzzzz' }, /Invalid hot lead call settings arguments/],
    ['windows', { windows: [EVERY_DAY] }, /Invalid hot lead call settings arguments/],
  ])('cannot smuggle in %s', async (_label, extra, message) => {
    await expect(update({ maxCallsPerHour: 3, ...extra })).rejects.toThrow(message);
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('tells the model the system fields are not settable', () => {
    const def = handlers.get('update_hot_lead_call_settings')!.definition;
    expect(def.description).toMatch(/managed by the system/);
    for (const f of ['verifiedAt', 'twilioNumber', 'twilioNumberSid']) expect(def.inputSchema.properties).not.toHaveProperty(f);
    const memberProps = (def.inputSchema.properties as { team: { items: { properties: object } } }).team.items.properties;
    expect(memberProps).not.toHaveProperty('verifiedAt');
  });

  const argsErr = 'settings arguments';
  const settingsErr = 'Some settings are not valid';
  it.each([
    [{}, 'provide at least one setting'], [null, argsErr], [[], argsErr], [{ orgId: 'org-b' }, argsErr], [{ userId: 'victim' }, argsErr],
    [{ enabled: 'yes' }, settingsErr], [{ leadTypes: [] }, settingsErr], [{ leadTypes: ['nope'] }, settingsErr],
    [{ maxCallsPerHour: 31 }, settingsErr], [{ maxAgeMinutes: 0 }, settingsErr], [{ announcedName: '<Say>hi</Say>' }, settingsErr],
    [{ announcedName: 'a'.repeat(61) }, settingsErr], [{ memberPhone: '+442071838750' }, 'valid US or Canadian'],
    [{ memberPhone: 'abc' }, 'valid US or Canadian'], [{ memberPhone: 5 }, 'valid US or Canadian'],
    [{ memberName: '' }, 'team.0.name'], [{ memberName: 'x'.repeat(41) }, 'team.0.name'], [{ memberName: 7 }, 'team.0.name'],
    [{ maxAttemptsPerLead: 6 }, settingsErr], [{ maxAttemptsPerLead: 0 }, settingsErr],
    [{ callingHours: { start: '25:00' } }, settingsErr],
    [{ allowedCountries: ['MX'] }, settingsErr],
  ])('rejects invalid arguments %j', async (args, message) => {
    await expect(update(args)).rejects.toThrow(message);
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  describe('with several team members', () => {
    beforeEach(() => {
      cfg().team = [teamMember('+14155550100'), teamMember('+14155550122', { id: 'mzzzzzz2', name: 'Sam Ortiz', verifiedAt: undefined })];
    });
    it('shows every member masked, in priority order', async () => {
      const result = await get();
      expect((result.team as Array<{ id: string; phoneMasked: string }>).map(m => [m.id, m.phoneMasked])).toEqual([[MEMBER_ID, '***0100'], ['mzzzzzz2', '***0122']]);
      expect(JSON.stringify(result)).not.toContain('4155550122');
    });
    it('still updates the other settings and keeps the team as stored', async () => {
      await update({ maxAttemptsPerLead: 2, callingHours: { end: '20:00' } });
      const written = lastWrite()[1].hotLeadCall;
      expect(written.team).toEqual((stored().team).slice(0, 1).concat([{ id: 'mzzzzzz2', name: 'Sam Ortiz', phone: '+14155550122', windows: [EVERY_DAY] }]));
      expect(written).toMatchObject({ enabled: true, maxAttemptsPerLead: 2 });
    });
    it.each([[{ memberPhone: '+14155550133' }], [{ memberName: 'Someone Else' }]])('refuses to edit a member through chat: %j', async args => {
      await expect(update(args)).rejects.toThrow('Several team members');
      expect(orgDb.updateOrg).not.toHaveBeenCalled();
    });
  });

  it('refuses members and global admins without org:configure', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'm', orgId: 'org-a', orgRole: 'member', isAdmin: true });
    await expect(update({ maxCallsPerHour: 3 }, { userId: 'm' })).rejects.toThrow('owners and admins');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('allows an org admin', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'a', orgId: 'org-a', orgRole: 'admin' });
    expect((await update({ maxCallsPerHour: 3 }, { userId: 'a' })).success).toBe(true);
  });

  it.each([{}, { userId: '' }, { userId: 123 }])('requires authentication %j', async context => {
    await expect(get({}, context)).rejects.toThrow('Authentication');
    await expect(update({ enabled: false }, context)).rejects.toThrow('Authentication');
  });

  it('cannot reach another org: lookup mismatch fails and an orgId argument is rejected', async () => {
    org.orgId = 'org-b';
    await expect(update({ enabled: false })).rejects.toThrow('Organization not found');
    org.orgId = 'org-a';
    await expect(update({ enabled: false, orgId: 'org-b' })).rejects.toThrow('Invalid');
    await expect(get({ orgId: 'org-b' })).rejects.toThrow('Invalid');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched persisted user identity', async () => {
    for (const user of [null, { userId: 'victim', orgId: 'org-a' }, { userId: 'owner' }]) {
      (userDb.getUserById as jest.Mock).mockResolvedValue(user);
      await expect(update({ enabled: false })).rejects.toThrow('membership');
    }
  });

  it('fails closed on malformed stored config', async () => {
    cfg().leadTypes = 'form_fill';
    await expect(update({ enabled: false })).rejects.toThrow('invalid');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('does not report success when the write fails', async () => {
    (orgDb.updateOrg as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await expect(update({ maxCallsPerHour: 3 })).rejects.toThrow('boom');
  });
});

describe('update_hot_lead_call_settings with team', () => {
  const NEW_PHONE = '+14155550133';
  const window = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
  beforeEach(() => {
    (cfg() as { team: unknown }).team = [teamMember('+14155550100'), teamMember('+14155550122', { id: 'mzzzzzz2', name: 'Sam Ortiz', verifiedAt: undefined })];
  });
  it('replaces the whole team in the order given, drops people left out and generates ids for new people', async () => {
    const result = await update({ team: [{ name: 'Kim Park', phone: NEW_PHONE, windows: [window] }, { id: 'mzzzzzz2', name: 'Sam Ortiz', windows: [window] }] });
    const written = lastWrite()[1].hotLeadCall.team;
    expect(written.map((m: { name: string }) => m.name)).toEqual(['Kim Park', 'Sam Ortiz']);
    expect(written[0].id).toMatch(/^m[a-z0-9]{7}$/);
    expect(written[1]).toMatchObject({ id: 'mzzzzzz2', phone: '+14155550122', windows: [window] });
    expect(written.some((m: { id: string }) => m.id === MEMBER_ID)).toBe(false);
    expect(result.team).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('4155550133');
  });
  it('is the same service as the REST PUT: field errors arrive as one readable message', async () => {
    await expect(update({ team: [{ name: 'Kim Park', phone: 'abc', windows: [window] }] })).rejects.toThrow('team.0.phone');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('cannot be combined with memberPhone or memberName', async () => {
    await expect(update({ team: [{ name: 'Kim', phone: NEW_PHONE, windows: [window] }], memberPhone: NEW_PHONE })).rejects.toThrow('not both');
  });
  it('rejects a smuggled verification stamp inside a team entry', async () => {
    await expect(update({ team: [{ id: MEMBER_ID, name: 'Dana', windows: [window], verifiedAt: '2026-02-02T00:00:00.000Z' }] })).rejects.toThrow('team.0.verifiedAt');
  });
  it('lets one person be edited through memberPhone on a team of one only', async () => {
    (cfg() as { team: unknown }).team = [teamMember('+14155550100')];
    await update({ memberName: 'Dana L' });
    expect(lastWrite()[1].hotLeadCall.team).toEqual([{ ...teamMember('+14155550100'), name: 'Dana L' }]);
  });
});

describe('update_hot_lead_call_settings in an unattended run', () => {
  const unattended = { userId: 'owner', isUnattendedRun: true };
  it.each([
    ['raising a cap', { maxCallsPerDay: 100 }],
    ['raising attempts per lead', { maxAttemptsPerLead: 5 }],
    ['widening the calling hours', { callingHours: { start: '06:00' } }],
    ['editing the team', { memberName: 'Someone Else' }],
    ['replacing the team', { team: [{ name: 'Kim', phone: '+14155550133', windows: [{ days: [1], start: '09:00', end: '17:00' }] }] }],
  ])('refuses %s without writing', async (_label, args) => {
    await expect(update(args, unattended)).rejects.toThrow('This needs a person to confirm in an interactive chat');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('refuses turning calling on', async () => {
    cfg().enabled = false;
    await expect(update({ enabled: true }, unattended)).rejects.toThrow('interactive chat');
  });
  it('still allows turning calling off and lowering a cap', async () => {
    expect(await update({ enabled: false, maxCallsPerDay: 5 }, unattended)).toMatchObject({ success: true, enabled: false, maxCallsPerDay: 5 });
  });
  it.each([false, undefined])('only an explicit true counts as unattended (%s)', async flag => {
    expect((await update({ maxCallsPerDay: 100 }, { userId: 'owner', isUnattendedRun: flag })).success).toBe(true);
  });
  it('a concurrent edit rejects the conditional write with a ConflictError instead of overwriting it', async () => {
    (orgDb.updateOrg as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' }));
    const err = await update({ maxCallsPerHour: 3 }).catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain('changed by someone else');
  });
});

describe('registration', () => {
  it('tools.ts imports the module so the tools are registered', () => {
    const source = readFileSync(join(__dirname, '../emma/tools.ts'), 'utf8');
    expect(source).toContain("import './hotLeadCallTools';");
  });
});

describe('shared-session blocking', () => {
  it.each(['get_hot_lead_call_settings', 'update_hot_lead_call_settings'])('%s is in the shared-session blocked set', name => {
    expect(SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS.has(name)).toBe(true);
  });
});


describe('ENG-2783: monthly cap and honest read-out through the Emma tools', () => {
  it('get shows the default 150 when the stored config has no value, and the stored value when an operator raised it', async () => {
    const without = storedConfigFixture();
    delete (without as Record<string, unknown>).maxCallsPerMonth;
    org.hotLeadCall = without;
    expect(await get()).toMatchObject({ maxCallsPerMonth: 150 });
    org.hotLeadCall = storedConfigFixture({ maxCallsPerMonth: 1500 });
    expect(await get()).toMatchObject({ maxCallsPerMonth: 1500 });
  });
  it('get carries the Canada warning and the blocker for a Canada-only org', async () => {
    expect(await get()).toMatchObject({ warnings: [expect.stringContaining('Canadian numbers are not called yet')], canEnable: true });
    org.hotLeadCall = storedConfigFixture({ allowedCountries: ['CA'] });
    expect(await get()).toMatchObject({ canEnable: false, blockers: [expect.stringContaining('None of the allowed countries can be called yet')] });
  });
  it('update sets a value from 1 to 200', async () => {
    expect(await update({ maxCallsPerMonth: 50 })).toMatchObject({ success: true, maxCallsPerMonth: 50 });
    expect(lastWrite()[1].hotLeadCall.maxCallsPerMonth).toBe(50);
  });
  it('update refuses a value above 200 with the plain support message and writes nothing', async () => {
    await expect(update({ maxCallsPerMonth: 201 })).rejects.toThrow('Higher monthly limits are set by AgentWeb support');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('the tool schema offers 1 to 200 only', () => {
    const props = handlers.get('update_hot_lead_call_settings')!.definition.inputSchema.properties as Record<string, { minimum: number; maximum: number }>;
    expect(props.maxCallsPerMonth).toMatchObject({ minimum: 1, maximum: 200 });
  });
  it('update keeps a stored 1500 when other fields change', async () => {
    org.hotLeadCall = storedConfigFixture({ maxCallsPerMonth: 1500 });
    expect(await update({ maxCallsPerHour: 3 })).toMatchObject({ success: true, maxCallsPerMonth: 1500 });
    expect(lastWrite()[1].hotLeadCall.maxCallsPerMonth).toBe(1500);
  });
});
