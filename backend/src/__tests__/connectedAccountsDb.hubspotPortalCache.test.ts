/**
 * ENG-2605: getUserIdByHubSpotPortalId used to read every user (a ~4 MB AW-Users scan) for EVERY changed
 * contact in a webhook delivery. It now shares one snapshot of portal -> owner per instance, rebuilt at
 * most once per TTL, hit or miss. The mapping semantics (first holder wins, strict id equality) are unchanged.
 */
let mockUsers: any[] = [];
const mockScan = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    scanWithFilter: (...a: any[]) => mockScan(...a),
    getAllUsers: () => { throw new Error('the portal lookup must not call getAllUsers'); },
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
  mockScan.mockImplementation(async () => mockUsers);
  // A cached hit re-reads its owner by id; by default that is the same data the scan sees.
  mockGetUserById.mockImplementation(async (id: string) => mockUsers.find(u => u.userId === id));
});
afterEach(() => jest.restoreAllMocks());

describe('getUserIdByHubSpotPortalId', () => {
  it('resolves the owner and reads the users only once for repeat lookups', async () => {
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(await getUserIdByHubSpotPortalId(222)).toBe('u2');
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('a delivery with many contacts is ONE scan: 50 concurrent lookups share a rebuild', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => getUserIdByHubSpotPortalId(i % 2 ? 111 : 222)));
    expect(results.filter(r => r === 'u1')).toHaveLength(25);
    expect(results.filter(r => r === 'u2')).toHaveLength(25);
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('a portal nobody here owns is a cached miss: it does not rescan on every event', async () => {
    for (let i = 0; i < 30; i++) expect(await getUserIdByHubSpotPortalId(999)).toBeNull();
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after the TTL, so a newly connected portal and a disconnect are seen', async () => {
    expect(await getUserIdByHubSpotPortalId(333)).toBeNull();
    mockUsers = [user('u1', hs(111)), user('u3', hs(333))];
    now += MISS_REFRESH - 1;
    expect(await getUserIdByHubSpotPortalId(333)).toBeNull();
    expect(mockScan).toHaveBeenCalledTimes(1);
    now += TTL;
    expect(await getUserIdByHubSpotPortalId(333)).toBe('u3');
    expect(await getUserIdByHubSpotPortalId(222)).toBeNull();
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('a MISS on a snapshot older than 30s rebuilds ONCE, so a portal connected on another instance is found in seconds', async () => {
    expect(await getUserIdByHubSpotPortalId(333)).toBeNull();
    expect(mockScan).toHaveBeenCalledTimes(1);
    mockUsers = [user('u1', hs(111)), user('u3', hs(333))];
    now += MISS_REFRESH + 1;
    expect(await getUserIdByHubSpotPortalId(333)).toBe('u3');
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('...and a portal that is still unknown does not rescan again until the next 30s has passed', async () => {
    expect(await getUserIdByHubSpotPortalId(999)).toBeNull();
    now += MISS_REFRESH + 1;
    for (let i = 0; i < 20; i++) expect(await getUserIdByHubSpotPortalId(999)).toBeNull();
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('a HIT never triggers a rebuild before the TTL, however old the snapshot is', async () => {
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    now += TTL - 1;
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('a rebuild that was already reading users when a HubSpot account is connected does NOT publish its stale view', async () => {
    let release!: (u: any[]) => void;
    mockScan.mockImplementationOnce(() => new Promise(res => { release = res; }));
    const pending = getUserIdByHubSpotPortalId(444);
    await new Promise(r => setImmediate(r));
    mockGetUserById.mockImplementation(async (id: string) => (id === 'u9' ? { userId: 'u9', connected_accounts: [] } : mockUsers.find(u => u.userId === id)));
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

  it('rebuilds with the light connected_accounts scan, never the heavy getAllUsers', async () => {
    await getUserIdByHubSpotPortalId(111);
    expect(mockScan).toHaveBeenCalledWith('attribute_exists(connected_accounts)', {});
  });

  it('keeps the old population: evaluation users are excluded, a record with no string userId is skipped', async () => {
    mockUsers = [user('eval_sandbox', hs(111)), { connected_accounts: [hs(111)] }, user('real', hs(111))];
    expect(await getUserIdByHubSpotPortalId(111)).toBe('real');
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
    mockScan.mockRejectedValueOnce(new Error('throttled'));
    expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('Error resolving HubSpot Portal ID to User ID:', expect.any(Error));
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('a failed rebuild after the TTL still answers from the stale snapshot', async () => {
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    now += TTL + 1;
    mockScan.mockRejectedValueOnce(new Error('throttled'));
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
  });

  it('connecting a HubSpot account drops the snapshot at once; another platform does not', async () => {
    mockGetUserById.mockImplementation(async (id: string) => (id === 'u9' ? { userId: 'u9', connected_accounts: [] } : mockUsers.find(u => u.userId === id)));
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    await createAccount('u9', 'attio' as any, { account_id: 'w1', account_name: 'W', config: {} } as any);
    expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    expect(mockScan).toHaveBeenCalledTimes(1);
    await createAccount('u9', 'hubspot' as any, { account_id: '444', account_name: 'P444', config: { hub_id: 444 } } as any);
    mockUsers = [...mockUsers, user('u9', hs(444))];
    expect(await getUserIdByHubSpotPortalId(444)).toBe('u9');
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  describe('a cached HIT is verified against its owner (no waiting for the TTL)', () => {
    it('an EXPIRED snapshot whose rebuild fails does not serve an owner who no longer holds the portal', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      now += TTL + 1;                                           // expired: the hit-verification block is skipped
      mockUsers = [user('u1'), user('u5', hs(111))];            // 111 moved to u5
      mockScan.mockRejectedValue(new Error('throttled'));
      expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
    });

    it('...but if that verifying read also fails, the expired snapshot is trusted rather than dropping the event', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      now += TTL + 1;
      mockScan.mockRejectedValue(new Error('throttled'));
      mockGetUserById.mockRejectedValue(new Error('throttled too'));
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
    });

    it('a portal that MOVED to another user resolves to the new owner at once, with one rebuild', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u1'), user('u5', hs(111))];           // 111 moved from u1 to u5
      now += 1000;
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u5');
      expect(mockScan).toHaveBeenCalledTimes(2);
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u5'); // and the new answer is cached
      expect(mockScan).toHaveBeenCalledTimes(2);
    });

    it('a portal whose owner DISCONNECTED resolves to null at once', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u1'), user('u2', hs(222))];
      now += 1000;
      expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
    });

    it('an owner whose record is gone resolves to null', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u2', hs(222))];
      expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
    });

    it('an owner who now holds a DIFFERENT portal no longer owns this one (the check is on the portal id, not the platform)', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u1', hs(777)), user('u2', hs(222))];   // u1 reconnected to another portal
      expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
      expect(await getUserIdByHubSpotPortalId(777)).toBe('u1');
    });

    it('a rebuild already IN FLIGHT with a pre-move view is not joined: the stale owner forces a fresh read', async () => {
      const before = mockUsers;
      let releaseOld!: (u: any[]) => void;
      mockScan
        .mockImplementationOnce(async () => before)                                            // initial snapshot
        .mockImplementationOnce(() => new Promise(res => { releaseOld = res; }))                // slow rebuild, pre-move view
        .mockImplementation(async () => mockUsers);                                             // later reads see current data
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      now += MISS_REFRESH + 1;
      const slow = getUserIdByHubSpotPortalId(999);                                             // unknown portal: starts the slow rebuild
      await new Promise(r => setImmediate(r));
      mockUsers = [user('u1'), user('u5', hs(111))];                                            // 111 moves to u5 meanwhile
      const lookup = getUserIdByHubSpotPortalId(111);
      await new Promise(r => setImmediate(r));
      releaseOld(before);                                                                       // the slow rebuild finally returns its OLD view
      expect(await lookup).toBe('u5');
      await slow;
    });

    it('a pre-move rebuild that finishes LATE cannot overwrite the fresh snapshot that replaced it', async () => {
      const before = mockUsers;
      let releaseOld!: (u: any[]) => void;
      mockScan
        .mockImplementationOnce(async () => before)                                   // scan 1: initial snapshot
        .mockImplementationOnce(() => new Promise(res => { releaseOld = res; }))       // scan 2: slow, reads the PRE-move view
        .mockImplementation(async () => mockUsers);                                    // scan 3+: current data
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      now += MISS_REFRESH + 1;
      const slow = getUserIdByHubSpotPortalId(999);                                    // unknown portal: starts the slow rebuild
      await new Promise(r => setImmediate(r));
      mockUsers = [user('u1'), user('u5', hs(111))];                                   // 111 moves to u5
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u5');                        // scan 3 publishes the fresh snapshot
      releaseOld(before);                                                              // ...and THEN the old rebuild returns its pre-move view
      await slow;
      mockScan.mockClear();
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u5');                        // still the fresh snapshot: u5 verifies, no rescan
      expect(mockScan).not.toHaveBeenCalled();
    });

    it('a stale owner + a FAILED rebuild does not take the other portals down: they keep answering from the old snapshot', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u1'), user('u2', hs(222))];            // 111 disconnected; 222 untouched
      mockScan.mockRejectedValue(new Error('throttled'));
      expect(await getUserIdByHubSpotPortalId(111)).toBeNull(); // the stale portal is never served
      expect(await getUserIdByHubSpotPortalId(222)).toBe('u2'); // ...but 222 still resolves during the outage
    });

    it('many callers that all find the SAME owner stale cause ONE extra scan, not one each', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      expect(mockScan).toHaveBeenCalledTimes(1);
      mockUsers = [user('u1'), user('u5', hs(111))];            // 111 moved
      const results = await Promise.all(Array.from({ length: 12 }, () => getUserIdByHubSpotPortalId(111)));
      expect(results.every(r => r === 'u5')).toBe(true);
      expect(mockScan).toHaveBeenCalledTimes(2);
    });

    it('a rebuild that already published a FRESH snapshot is not thrown away by a late caller that saw the old one', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u1'), user('u5', hs(111))];
      let release!: () => void;
      const gate = new Promise<void>(res => { release = res; });
      const realVerify = mockGetUserById.getMockImplementation()!;
      // every verifier read waits on the gate, so all callers hold the OLD snapshot when they get their answer
      mockGetUserById.mockImplementation(async (id: string) => { await gate; return realVerify(id); });
      const calls = Array.from({ length: 6 }, () => getUserIdByHubSpotPortalId(111));
      await new Promise(r => setImmediate(r));
      release();
      const out = await Promise.all(calls);
      expect(out.every(r => r === 'u5')).toBe(true);
      expect(mockScan).toHaveBeenCalledTimes(2);
    });

    it('a verified hit costs ONE by-id read and no scan', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockGetUserById.mockClear();
      for (let i = 0; i < 5; i++) expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      expect(mockGetUserById).toHaveBeenCalledTimes(5);
      expect(mockScan).toHaveBeenCalledTimes(1);
    });

    it('if the verifying read FAILS the snapshot is trusted (a throttle must not drop events)', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockGetUserById.mockRejectedValue(new Error('throttled'));
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      expect(mockScan).toHaveBeenCalledTimes(1);
    });

    it('a stale owner is never served from the old snapshot even when the rebuild also fails', async () => {
      expect(await getUserIdByHubSpotPortalId(111)).toBe('u1');
      mockUsers = [user('u1'), user('u2', hs(222))];
      mockScan.mockRejectedValueOnce(new Error('throttled'));
      expect(await getUserIdByHubSpotPortalId(111)).toBeNull();
    });
  });
});
