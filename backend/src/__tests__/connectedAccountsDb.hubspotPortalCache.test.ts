/**
 * ENG-2605: getUserIdByHubSpotPortalId used to read every user (a ~4 MB AW-Users scan) for EVERY changed
 * contact in a webhook delivery. It now shares one snapshot of portal -> owner per instance, rebuilt at
 * most once per TTL, hit or miss. The mapping semantics (first holder wins, strict id equality) are unchanged.
 */
let mockUsers: any[] = [];
const mockGetAllUsers = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: (...a: any[]) => mockGetAllUsers(...a),
    getUserById: (...a: any[]) => mockGetUserById(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
}));

import { clearHubSpotPortalCache, createAccount, getUserIdByHubSpotPortalId } from '../services/connectedAccountsDb';

const hs = (hubId: unknown) => ({ platform: 'hubspot', account_id: String(hubId), account_name: `P${hubId}`, config: { hub_id: hubId } });
const user = (userId: string, ...accounts: any[]) => ({ userId, connected_accounts: accounts });
const TTL = 5 * 60 * 1000;
const MISS_REFRESH = 30 * 1000;

let now = 1_700_000_000_000;
beforeEach(() => {
  jest.resetAllMocks();
  clearHubSpotPortalCache();
  now = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockUsers = [user('u1', hs(111)), user('u2', hs(222))];
  mockGetAllUsers.mockImplementation(async () => mockUsers);
});
afterEach(() => jest.restoreAllMocks());

describe('getUserIdByHubSpotPortalId', () => {
  it('resolves the owner and reads the users only once for repeat lookups', async () => {
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(await getUserIdByHubSpotPortalId(222)).toBe('u2');
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
  });

  it('a delivery with many contacts is ONE scan: 50 concurrent lookups share a rebuild', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => getUserIdByHubSpotPortalId(i % 2 ? 111 : 222)));
    expect(results.filter(r => r === 'u1')).toHaveLength(25);
    expect(results.filter(r => r === 'u2')).toHaveLength(25);
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
  });

  it('a portal nobody here owns is a cached miss: it does not rescan on every event', async () => {
    for (let i = 0; i < 30; i++) expect(await getUserIdByHubSpotPortalId(999)).toBeNull();
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after the TTL, so a newly connected portal and a disconnect are seen', async () => {
    expect(await getUserIdByHubSpotPortalId(333)).toBeNull();
    mockUsers = [user('u1', hs(111)), user('u3', hs(333))];
    now += MISS_REFRESH - 1;
    expect(await getUserIdByHubSpotPortalId(333)).toBeNull();
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
    now += TTL;
    expect(await getUserIdByHubSpotPortalId(333)).toBe('u3');
    expect(await getUserIdByHubSpotPortalId(222)).toBeNull();
    expect(mockGetAllUsers).toHaveBeenCalledTimes(2);
  });

  it('a MISS on a snapshot older than 30s rebuilds ONCE, so a portal connected on another instance is found in seconds', async () => {
    expect(await getUserIdByHubSpotPortalId(333)).toBeNull();
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
    mockUsers = [user('u1', hs(111)), user('u3', hs(333))];
    now += MISS_REFRESH + 1;
    expect(await getUserIdByHubSpotPortalId(333)).toBe('u3');
    expect(mockGetAllUsers).toHaveBeenCalledTimes(2);
  });

  it('...and a portal that is still unknown does not rescan again until the next 30s has passed', async () => {
    expect(await getUserIdByHubSpotPortalId(999)).toBeNull();
    now += MISS_REFRESH + 1;
    for (let i = 0; i < 20; i++) expect(await getUserIdByHubSpotPortalId(999)).toBeNull();
    expect(mockGetAllUsers).toHaveBeenCalledTimes(2);
  });

  it('a HIT never triggers a rebuild before the TTL, however old the snapshot is', async () => {
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    now += TTL - 1;
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
  });

  it('a rebuild that was already reading users when a HubSpot account is connected does NOT publish its stale view', async () => {
    let release!: (u: any[]) => void;
    mockGetAllUsers.mockImplementationOnce(() => new Promise(res => { release = res; }));
    const pending = getUserIdByHubSpotPortalId(444);
    await new Promise(r => setImmediate(r));
    mockGetUserById.mockResolvedValue({ userId: 'u9', connected_accounts: [] });
    await createAccount('u9', 'hubspot' as any, { account_id: '444', account_name: 'P444', config: { hub_id: 444 } } as any);
    release([user('u1', hs(111))]);                      // the pre-connection view (no 444)
    expect(await pending).toBeNull();                    // that caller got the stale answer...
    mockUsers = [user('u1', hs(111)), user('u9', hs(444))];
    expect(await getUserIdByHubSpotPortalId(444)).toBe('u9'); // ...but it was not cached for 5 minutes
  });

  it('when two users hold the same portal the FIRST one wins, as the per-event scan did', async () => {
    mockUsers = [user('first', hs(111)), user('second', hs(111))];
    expect(await getUserIdByHubSpotPortalId(111)).toBe('first');
  });

  it('keeps strict id equality: a numeric hub_id is not matched by its string form', async () => {
    expect(await getUserIdByHubSpotPortalId('111' as any)).toBeNull();
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
  });

  it('ignores non-HubSpot accounts and accounts with no hub_id', async () => {
    mockUsers = [user('u1', { platform: 'attio', account_id: '111', config: { hub_id: 111 } }, { platform: 'hubspot', account_id: 'x', config: {} })];
    expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
  });

  it("one malformed user record does not hide everyone else's portals", async () => {
    mockUsers = [{ userId: 'bad', connected_accounts: 5 }, user('u2', hs(222))];
    expect(await getUserIdByHubSpotPortalId(222)).toBe('u2');
  });

  it('a failed rebuild with no snapshot returns null, is logged, and is NOT cached (the next call retries)', async () => {
    mockGetAllUsers.mockRejectedValueOnce(new Error('throttled'));
    expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('Error resolving HubSpot Portal ID to User ID:', expect.any(Error));
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockGetAllUsers).toHaveBeenCalledTimes(2);
  });

  it('a failed rebuild after the TTL still answers from the stale snapshot', async () => {
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    now += TTL + 1;
    mockGetAllUsers.mockRejectedValueOnce(new Error('throttled'));
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
  });

  it('connecting a HubSpot account drops the snapshot at once; another platform does not', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u9', connected_accounts: [] });
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    await createAccount('u9', 'attio' as any, { account_id: 'w1', account_name: 'W', config: {} } as any);
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockGetAllUsers).toHaveBeenCalledTimes(1);
    await createAccount('u9', 'hubspot' as any, { account_id: '444', account_name: 'P444', config: { hub_id: 444 } } as any);
    mockUsers = [...mockUsers, user('u9', hs(444))];
    expect(await getUserIdByHubSpotPortalId(444)).toBe('u9');
    expect(mockGetAllUsers).toHaveBeenCalledTimes(2);
  });
});
