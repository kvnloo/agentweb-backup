const handlers = new Map<string, any>();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { register: (tool: any) => handlers.set(tool.name, tool) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
import { orgDb, userDb } from '../services/db';
import '../emma/leadNotificationTools';
const get = (args: any = {}, context: any = { userId: 'owner' }) => handlers.get('get_lead_notification_settings').execute(args, context);
const update = (args: any, context: any = { userId: 'owner' }) => handlers.get('update_lead_notification_settings').execute(args, context);
let org: any;
beforeEach(() => {
  jest.clearAllMocks();
  org = { orgId: 'org-a', ownerUserId: 'owner', leadNotifications: {
    enabled: true, slackChannelId: 'C123', sources: ['inbound'], maskPhone: true, mentions: ['U123'],
  }, connected_accounts: [{ config: { access_token: 'secret' } }] };
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-a', orgRole: 'owner' });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue(org);
});
it('returns effective defaults and all descriptions without credentials', async () => {
  const result = await get();
  expect(result).toMatchObject({ leadTypes: ['form_fill', 'booking'], enabled: true, channel: 'C123', mentions: ['U123'], sources: ['inbound'], maskPhone: true });
  expect(result.availableOptions).toHaveLength(6);
  expect(result.availableOptions.every((option: any) => option.description.length > 0)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('reports an unconfigured org as disabled with default types', async () => {
  delete org.leadNotifications;
  expect(await get()).toMatchObject({ enabled: false, channel: null, leadTypes: ['form_fill', 'booking'] });
});
it('replaces types and optional mentions/enabled while preserving other settings', async () => {
  const result = await update({ leadTypes: ['linkedin'], enabled: false, mentions: [] });
  expect(result).toMatchObject({ leadTypes: ['linkedin'], enabled: false, mentions: [], sources: ['inbound'], maskPhone: true });
  expect(orgDb.updateOrg).toHaveBeenCalledWith('org-a', { leadNotifications: { ...org.leadNotifications, leadTypes: ['linkedin'], enabled: false, mentions: [] } }, expect.objectContaining({ condition: expect.objectContaining({ values: { ':previousNotifications': org.leadNotifications } }) }));
});
it('can re-enable disabled settings and accepts an empty selection', async () => {
  org.leadNotifications.enabled = false;
  expect(await update({ leadTypes: [], enabled: true })).toMatchObject({ enabled: true, leadTypes: [] });
});
it('treats null optional enabled/mentions as omitted', async () => {
  expect(await update({ leadTypes: ['form_fill'], enabled: null, mentions: null })).toMatchObject({ leadTypes: ['form_fill'], enabled: true, mentions: ['U123'] });
});
it.each([
  {}, { leadTypes: 'linkedin' }, { leadTypes: ['unknown'] }, { leadTypes: [null] },
  { leadTypes: ['linkedin', 'linkedin'] }, { leadTypes: null },
  { leadTypes: [], enabled: 'true' }, { leadTypes: [], mentions: ['<!channel>'] },
  { leadTypes: [], mentions: [123] }, { leadTypes: [], mentions: 'U123' },
{ leadTypes: [], mentions: Array(51).fill('U123') },
  { leadTypes: [], orgId: 'org-b' }, { leadTypes: [], userId: 'victim' },
  { leadTypes: [], slackChannelId: 'COTHER' }, null, [],
])('rejects invalid or scope-changing arguments %j', async args => {
  await expect(update(args)).rejects.toThrow();
  expect(orgDb.updateOrg).not.toHaveBeenCalled();
});
it.each([{}, { userId: '' }, { userId: 123 }])('requires authentication %j', async context => {
  await expect(get({}, context)).rejects.toThrow('Authentication');
  await expect(update({ leadTypes: [] }, context)).rejects.toThrow('Authentication');
});
it('allows org members to read but refuses writes even for global admins', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'member', orgId: 'org-a', orgRole: 'member', isAdmin: true });
  expect((await get({}, { userId: 'member' })).success).toBe(true);
  await expect(update({ leadTypes: [] }, { userId: 'member' })).rejects.toThrow('Only org owners and admins can update lead notification settings');
  expect(orgDb.updateOrg).not.toHaveBeenCalled();
});
it('allows an org admin to write', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'admin', orgId: 'org-a', orgRole: 'admin' });
  expect((await update({ leadTypes: ['form_fill'] }, { userId: 'admin' })).success).toBe(true);
});
it('rejects cross-org lookup results and caller-supplied org overrides', async () => {
  org.orgId = 'org-b';
  await expect(get()).rejects.toThrow('Organization not found');
  await expect(update({ leadTypes: [] })).rejects.toThrow('Organization not found');
  await expect(get({ orgId: 'org-b' })).rejects.toThrow('Invalid');
  expect(orgDb.updateOrg).not.toHaveBeenCalled();
});
it('rejects missing or mismatched persisted user identity', async () => {
  for (const user of [null, { userId: 'victim', orgId: 'org-a' }, { userId: 'owner' }]) {
    (userDb.getUserById as jest.Mock).mockResolvedValue(user);
    await expect(update({ leadTypes: [] })).rejects.toThrow('membership');
  }
  expect(orgDb.updateOrg).not.toHaveBeenCalled();
});
it('fails closed on malformed stored config and missing channel', async () => {
  org.leadNotifications.leadTypes = 'linkedin';
  await expect(get()).rejects.toThrow('invalid');
  await expect(update({ leadTypes: [] })).rejects.toThrow('Configure');
  delete org.leadNotifications;
  await expect(update({ leadTypes: [], enabled: true })).rejects.toThrow('Configure');
  expect(orgDb.updateOrg).not.toHaveBeenCalled();
});
it('does not report success when a concurrent edit rejects the conditional write', async () => {
  (orgDb.updateOrg as jest.Mock).mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));
  await expect(update({ leadTypes: ['linkedin'] })).rejects.toThrow('ConditionalCheckFailedException');
});
it('Opslane: toggling enabled alone keeps the stored lead types (off then on)', async () => {
  org.leadNotifications.leadTypes = ['form_fill', 'booking', 'linkedin', 'manual'];
  (orgDb.updateOrg as jest.Mock).mockImplementation(async (_id: string, patch: any) => { org.leadNotifications = patch.leadNotifications; });
  expect(await update({ enabled: false })).toMatchObject({ enabled: false, leadTypes: ['form_fill', 'booking', 'linkedin', 'manual'] });
  expect(await update({ enabled: true })).toMatchObject({ enabled: true, leadTypes: ['form_fill', 'booking', 'linkedin', 'manual'] });
  expect(org.leadNotifications.leadTypes).toEqual(['form_fill', 'booking', 'linkedin', 'manual']);
});
it('Opslane: omitting leadTypes on an org with default types does not persist an explicit list', async () => {
  const result = await update({ enabled: false });
  expect(result).toMatchObject({ enabled: false, leadTypes: ['form_fill', 'booking'] });
  expect((orgDb.updateOrg as jest.Mock).mock.calls[0][1].leadNotifications).not.toHaveProperty('leadTypes');
});
it('Opslane: the tool schema no longer requires leadTypes and tells the model to omit it when turning off', () => {
  const def = handlers.get('update_lead_notification_settings').definition;
  expect(def.inputSchema.required ?? []).not.toContain('leadTypes');
  expect(def.description).toMatch(/omit leadTypes/i);
});
