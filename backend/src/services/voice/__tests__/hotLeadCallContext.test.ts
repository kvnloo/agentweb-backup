jest.mock('../../db', () => ({
  crmDb: { getLeadListById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
import { crmDb, orgDb, userDb } from '../../db';
import { resolveHotLeadCallContext } from '../hotLeadCallContext';

const mock = (fn: unknown) => fn as jest.Mock;
const stored = {
  enabled: true,
  destinationPhone: '+14155550100',
  destinationVerifiedAt: '2026-01-01T00:00:00.000Z',
  twilioNumber: '+14155550111',
  announcedName: 'Acme Plumbing',
  quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};

beforeEach(() => {
  jest.resetAllMocks();
  mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a', userId: 'owner-a' });
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
  mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: stored });
});

describe('resolveHotLeadCallContext', () => {
  it('resolves org, owner and the validated config from list ownership', async () => {
    const ctx = await resolveHotLeadCallContext('list-a');
    expect(ctx).toMatchObject({ orgId: 'org-a', ownerUserId: 'owner-a' });
    expect(ctx?.config.destinationPhone).toBe('+14155550100');
    expect(crmDb.getLeadListById).toHaveBeenCalledWith('list-a', { consistentRead: true });
  });

  it.each([
    ['unknown list', () => mock(crmDb.getLeadListById).mockResolvedValue(null)],
    ['list id mismatch', () => mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'other', userId: 'owner-a' })],
    ['list without an owner', () => mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a' })],
    ['session list', () => mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a', userId: 'owner-a', listType: 'session' })],
    ['unknown owner', () => mock(userDb.getUserById).mockResolvedValue(null)],
    ['owner id mismatch', () => mock(userDb.getUserById).mockResolvedValue({ userId: 'x', orgId: 'org-a' })],
    ['owner without an org', () => mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a' })],
    ['unknown org', () => mock(orgDb.getOrgById).mockResolvedValue(null)],
    ['org id mismatch', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-b', hotLeadCall: stored })],
    ['no config', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a' })],
    ['invalid config', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...stored, maxCallsPerDay: 9999 } })],
    ['disabled config', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...stored, enabled: false } })],
  ])('returns null for %s', async (_name, arrange) => {
    arrange();
    expect(await resolveHotLeadCallContext('list-a')).toBeNull();
  });
});
