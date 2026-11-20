/**
 * ENG-3152 follow-up: "Organization membership required" used to be a plain Error thrown straight from the first read of the
 * user record. That read goes through the UserIdIndex GSI, which is eventually consistent, so a user who had just joined an org
 * (or whose record had just changed) could be refused with a message that reads as "you have no org" even though they do.
 * The refusal is now thrown only after a consistent re-read, and as a typed error so telemetry can tell it from a bug.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
import { orgDb, userDb } from '../services/db';
import { callerIdentity, OrgMembershipRequiredError } from '../emma/orgCaller';

const getUserById = userDb.getUserById as jest.Mock;
const consistent = userDb.getUserByIdConsistent as jest.Mock;
const getOrgById = orgDb.getOrgById as jest.Mock;
const ctx = { userId: 'u1' };

beforeEach(() => {
  jest.clearAllMocks();
  getOrgById.mockResolvedValue({ orgId: 'org-a' });
});

it('does not re-read when the first read already shows the org (the normal path costs nothing extra)', async () => {
  getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org-a', orgRole: 'member' });
  const { org, caller } = await callerIdentity(ctx, 'lead notification settings');
  expect(org.orgId).toBe('org-a');
  expect(caller).toMatchObject({ userId: 'u1', orgRole: 'member' });
  expect(consistent).not.toHaveBeenCalled();
});

it('uses a consistent re-read when the indexed row is stale (just joined an org)', async () => {
  getUserById.mockResolvedValue({ userId: 'u1' }); // stale: no orgId yet
  consistent.mockResolvedValue({ userId: 'u1', orgId: 'org-a', orgRole: 'owner' });
  const { org, caller } = await callerIdentity(ctx, 'lead notification settings');
  expect(consistent).toHaveBeenCalledWith('u1');
  expect(org.orgId).toBe('org-a');
  expect(caller.orgRole).toBe('owner');
});

it('uses a consistent re-read when the indexed row is missing entirely', async () => {
  getUserById.mockResolvedValue(undefined);
  consistent.mockResolvedValue({ userId: 'u1', orgId: 'org-a', orgRole: 'member' });
  await expect(callerIdentity(ctx, 'x')).resolves.toBeDefined();
});

it('throws the typed refusal, with the same message, only after the consistent re-read also shows no org', async () => {
  getUserById.mockResolvedValue({ userId: 'u1' });
  consistent.mockResolvedValue({ userId: 'u1' });
  const err = await callerIdentity(ctx, 'x').catch(e => e);
  expect(err).toBeInstanceOf(OrgMembershipRequiredError);
  expect(err.name).toBe('OrgMembershipRequired');
  expect(err.message).toBe('Organization membership required');
  expect(consistent).toHaveBeenCalledTimes(1);
});

it('throws the typed refusal for a blank orgId and for a user that does not exist', async () => {
  getUserById.mockResolvedValue({ userId: 'u1', orgId: '  ' });
  consistent.mockResolvedValue(undefined);
  await expect(callerIdentity(ctx, 'x')).rejects.toBeInstanceOf(OrgMembershipRequiredError);
});

it('does not mask a failed re-read as "no org" (a database error surfaces as itself)', async () => {
  getUserById.mockResolvedValue({ userId: 'u1' });
  consistent.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
  await expect(callerIdentity(ctx, 'x')).rejects.toThrow('ProvisionedThroughputExceeded');
});

it('keeps the unrelated refusals as plain errors', async () => {
  await expect(callerIdentity({}, 'x')).rejects.toThrow('Authentication required');
  getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org-a' });
  getOrgById.mockResolvedValue(undefined);
  const err = await callerIdentity(ctx, 'x').catch(e => e);
  expect(err.message).toBe('Organization not found');
  expect(err).not.toBeInstanceOf(OrgMembershipRequiredError);
});
