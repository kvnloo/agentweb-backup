type Tool = { name: string; definition: { description: string; inputSchema: { properties: object } }; execute: (args: unknown, context: unknown) => Promise<Record<string, unknown>> };
const handlers = new Map<string, Tool>();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { register: (tool: Tool) => handlers.set(tool.name, tool) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
import { readFileSync } from 'fs';
import { join } from 'path';
import { orgDb, userDb } from '../services/db';
import '../emma/hotLeadCallTools';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

const get = (args: unknown = {}, context: unknown = { userId: 'owner' }) => handlers.get('get_hot_lead_call_settings')!.execute(args, context);
const update = (args: unknown, context: unknown = { userId: 'owner' }) => handlers.get('update_hot_lead_call_settings')!.execute(args, context);
const lastWrite = () => (orgDb.updateOrg as jest.Mock).mock.calls[0];
const SID = 'PN' + 'b'.repeat(32);

let org: { orgId: string; hotLeadCall?: ReturnType<typeof stored> & { destinationVerifiedAt?: string }; [k: string]: unknown };
const stored = () => ({
  enabled: true, destinationPhone: '+14155550100', destinationVerifiedAt: '2026-01-01T00:00:00.000Z',
  twilioNumber: '+14155550111', twilioNumberSid: SID, leadTypes: ['form_fill'], maxAgeMinutes: 10, maxCallsPerHour: 6,
  maxCallsPerDay: 20, ownerCooldownMinutes: 2, announcedName: 'Acme Plumbing',
  quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' }, allowedCountries: ['US', 'CA'],
});
beforeEach(() => {
  jest.clearAllMocks();
  org = { orgId: 'org-a', ownerUserId: 'owner', hotLeadCall: stored(), connected_accounts: [{ config: { access_token: 'secret' } }] };
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-a', orgRole: 'owner' });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue(org);
});

describe('get_hot_lead_call_settings', () => {
  it('masks the phone and hides system identifiers and credentials', async () => {
    const result = await get();
    expect(result).toMatchObject({ success: true, enabled: true, destinationPhone: '***0100', destinationVerified: true, callerNumberAssigned: true, maxAgeMinutes: 10 });
    const json = JSON.stringify(result);
    for (const leak of ['+14155550100', '4155550100', '+14155550111', SID, 'secret']) expect(json).not.toContain(leak);
  });
  it('reports an unconfigured org as disabled with default limits', async () => {
    delete org.hotLeadCall;
    expect(await get()).toMatchObject({ configured: false, enabled: false, destinationPhone: null, maxCallsPerHour: 6 });
  });
  it('fails closed on malformed stored config', async () => {
    org.hotLeadCall.maxCallsPerDay = 9999;
    await expect(get()).rejects.toThrow('invalid');
  });
  it('allows plain org members to read', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'm', orgId: 'org-a', orgRole: 'member' });
    expect((await get({}, { userId: 'm' })).success).toBe(true);
  });
});

describe('update_hot_lead_call_settings', () => {
  it('merges a partial update over the current config and preserves the rest', async () => {
    const result = await update({ maxCallsPerHour: 3, quietHours: { start: '09:00' } });
    expect(result).toMatchObject({ maxCallsPerHour: 3, enabled: true, quietHours: { start: '09:00', end: '21:00', timezone: 'America/Chicago' } });
    const [orgId, patch, options] = lastWrite();
    expect(orgId).toBe('org-a');
    expect(patch.hotLeadCall).toEqual({ ...stored(), maxCallsPerHour: 3, quietHours: { start: '09:00', end: '21:00', timezone: 'America/Chicago' } });
    expect(options.condition.values[':previousHotLeadCall']).toEqual(stored());
    expect(options.condition.expression).toBe('#previousHotLeadCall = :previousHotLeadCall');
  });

  it('treats null optionals as omitted', async () => {
    await update({ enabled: null, maxCallsPerHour: 4, announcedName: null });
    expect(lastWrite()[1].hotLeadCall).toMatchObject({ enabled: true, maxCallsPerHour: 4, announcedName: 'Acme Plumbing' });
  });

  it('uses attribute_not_exists for the first write and creates a disabled config', async () => {
    delete org.hotLeadCall;
    const result = await update({ destinationPhone: '(415) 555-0100', announcedName: 'New Co' });
    expect(result).toMatchObject({ enabled: false, destinationPhone: '***0100', destinationVerified: false, callerNumberAssigned: false });
    const options = lastWrite()[2];
    expect(options.condition.expression).toBe('attribute_not_exists(#previousHotLeadCall)');
    expect(options.condition.values).toBeUndefined();
    expect(lastWrite()[1].hotLeadCall.destinationPhone).toBe('+14155550100');
  });

  it('refuses the first write without a phone and name, and refuses enabling an unconfigured org', async () => {
    delete org.hotLeadCall;
    await expect(update({ maxCallsPerHour: 3 })).rejects.toThrow('destinationPhone');
    await expect(update({ destinationPhone: '+14155550100', enabled: true })).rejects.toThrow('Invalid');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('changing the phone clears verification and forces enabled:false, even if enabled:true is sent', async () => {
    const result = await update({ destinationPhone: '+16475550123', enabled: true });
    const written = lastWrite()[1].hotLeadCall;
    expect(written.destinationPhone).toBe('+16475550123');
    expect(written.enabled).toBe(false);
    expect(written).not.toHaveProperty('destinationVerifiedAt');
    expect(written.twilioNumber).toBe('+14155550111');
    expect(result).toMatchObject({ enabled: false, destinationVerified: false, destinationPhone: '***0123' });
  });

  it('re-sending the same phone keeps verification and enabled state', async () => {
    await update({ destinationPhone: '(415) 555-0100' });
    expect(lastWrite()[1].hotLeadCall).toMatchObject({ enabled: true, destinationVerifiedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('can disable and cannot enable an unverified config', async () => {
    expect(await update({ enabled: false })).toMatchObject({ enabled: false });
    jest.clearAllMocks();
    delete org.hotLeadCall.destinationVerifiedAt;
    org.hotLeadCall.enabled = false;
    await expect(update({ enabled: true })).rejects.toThrow('verified');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it.each(['+15555550100 x12', '(415) 555-0100 ext. 5', '+14155550100;ext=7'])('rejects a phone with an extension instead of dropping it: %s', async destinationPhone => {
    await expect(update({ destinationPhone })).rejects.toThrow('extension');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it.each(['+19002223333', '+18005550199'])('rejects toll-fraud destination %s', async destinationPhone => {
    await expect(update({ destinationPhone })).rejects.toThrow('valid US or Canadian');
  });
  it.each(['08:00-21:00', 5, true, ['x']])('rejects a non-object quietHours %j instead of ignoring it', async quietHours => {
    await expect(update({ quietHours })).rejects.toThrow('quietHours must be an object');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it.each(['UTC', 'EST', 'america/chicago', 'Mars/Olympus'])('names the timezone problem for %s', async timezone => {
    await expect(update({ quietHours: { timezone } })).rejects.toThrow(/timezone must be an IANA name such as America\/Chicago/);
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });
  it('accepts a valid timezone change and describes quiet hours and territory limits', async () => {
    await update({ quietHours: { timezone: 'America/Indiana/Indianapolis' } });
    expect(lastWrite()[1].hotLeadCall.quietHours.timezone).toBe('America/Indiana/Indianapolis');
    const def = handlers.get('update_hot_lead_call_settings')!.definition;
    expect(def.description).toMatch(/wraps past midnight/);
    expect(def.description).toMatch(/Puerto Rico/);
    expect(def.description).toMatch(/UTC and abbreviations/);
  });
  it('rejects a destination equal to the assigned caller number', async () => {
    await expect(update({ destinationPhone: '+14155550111' })).rejects.toThrow();
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it.each(['destinationVerifiedAt', 'twilioNumber', 'twilioNumberSid'])('cannot set system field %s', async field => {
    await expect(update({ maxCallsPerHour: 3, [field]: field === 'twilioNumberSid' ? SID : '2026-02-02T00:00:00.000Z' })).rejects.toThrow('managed by the system');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('tells the model the system fields are not settable', () => {
    const def = handlers.get('update_hot_lead_call_settings')!.definition;
    expect(def.description).toMatch(/managed by the system/);
    for (const f of ['destinationVerifiedAt', 'twilioNumber', 'twilioNumberSid']) expect(def.inputSchema.properties).not.toHaveProperty(f);
  });

  it.each([
    {}, null, [], { orgId: 'org-b' }, { userId: 'victim' }, { enabled: 'yes' }, { leadTypes: [] }, { leadTypes: ['nope'] },
    { maxCallsPerHour: 31 }, { maxAgeMinutes: 0 }, { announcedName: '<Say>hi</Say>' }, { announcedName: 'a'.repeat(61) },
    { destinationPhone: '+442071838750' }, { destinationPhone: 'abc' }, { destinationPhone: 5 },
    { quietHours: { timezone: 'Nope/Zone' } }, { quietHours: { start: '25:00' } }, { allowedCountries: ['MX'] },
  ])('rejects invalid arguments %j', async args => {
    await expect(update(args)).rejects.toThrow();
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
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
    org.hotLeadCall.leadTypes = 'form_fill';
    await expect(update({ enabled: false })).rejects.toThrow('invalid');
    expect(orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('does not report success when a concurrent edit rejects the conditional write', async () => {
    (orgDb.updateOrg as jest.Mock).mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));
    await expect(update({ maxCallsPerHour: 3 })).rejects.toThrow('ConditionalCheckFailedException');
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
