import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

/**
 * ENG-827 — an edit cannot leave consent pointing at a tool the schedule no longer uses.
 *
 * Consent is granted against a SPECIFIC publishing tool, which is the whole reason the
 * grant records a scope. Editing the schedule's required functions moves that set, so
 * a grant left untouched keeps authorizing a tool the owner has since removed.
 *
 * Narrowing only, in both directions that matter:
 *   - a publishing tool REMOVED drops out of the approved scope
 *   - a publishing tool ADDED does not inherit consent, because the owner approved the
 *     old set and never saw this one
 *   - a scope that empties out is not an authorization, so the grant goes with it
 */

jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn() },
  chatDb: { getChatSession: jest.fn() },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const SCHEDULE_ID = 'sc-1';
const OWNER = 'user-1';

const existing = (over: any = {}) => ({
  scheduleId: SCHEDULE_ID,
  userId: OWNER,
  type: 'scheduled_chat',
  scheduleName: 'Daily LinkedIn Post',
  startingMessage: 'Post today’s update',
  frequency: 'daily',
  nextRunTime: '2026-09-01T10:00:00.000Z',
  timezone: 'UTC',
  requiredFunctionCalls: ['read_brand_guidelines', 'post_on_connected_account'],
  autopublishAuthorized: true,
  autopublishAuthorizedTools: ['post_on_connected_account'],
  autopublishAuthorizedAt: '2026-08-01T00:00:00.000Z',
  autopublishAuthorizedBy: OWNER,
  emailNotifications: ['owner@example.com'],
  ...over,
});

const req = (body: any) =>
  ({ params: { scheduleId: SCHEDULE_ID }, body, user: { userId: OWNER } } as any);

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

/** The owner's edit: always the first write, and it always lands. */
const edited = () => (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][1] as any;
/** The consent narrowing: a SEPARATE write, made only when there is a grant to narrow. */
const written = () => ((mockScheduleDb.updateSchedule as jest.Mock).mock.calls[1]?.[1] ?? {}) as any;
const narrowingCondition = () => (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[1]?.[2];

describe('ENG-827 — publish consent narrows when an edit changes the required tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks only calls mockClear, which does NOT drain queued `once` values.
    // A test that leaves one unconsumed would otherwise hand it to the next test.
    mockScheduleDb.updateSchedule.mockReset();
    mockScheduleDb.updateSchedule.mockResolvedValue({} as any);
  });

  it('revokes when the approved publishing tool is removed', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      res()
    );

    const w = written();
    expect(w.autopublishAuthorized).toBe(false);
    expect(w.autopublishAuthorizedTools).toEqual([]);
    // The audit trail of a grant that no longer exists must not linger.
    expect(w.autopublishAuthorizedAt).toBeNull();
    expect(w.autopublishAuthorizedBy).toBeNull();
  });

  it('does not let a newly added publishing tool inherit the old consent', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    // The owner swaps which platform this schedule publishes to. They approved the
    // old tool; nobody has approved the new one.
    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines', 'twitter_manage_post'] }),
      res()
    );

    const w = written();
    expect(w.autopublishAuthorized).toBe(false);
    expect(w.autopublishAuthorizedTools).toEqual([]);
  });

  it('keeps consent when the edit leaves the approved tool in place', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    await agentModeController.updateScheduledChat(
      req({ scheduleName: 'Renamed', requiredFunctionCalls: ['post_on_connected_account'] }),
      res()
    );

    const w = written();
    // Untouched: an edit that does not move the scope must not disturb the grant.
    expect(w.autopublishAuthorized).toBeUndefined();
    expect(w.autopublishAuthorizedTools).toBeUndefined();
  });

  it('leaves an ungranted schedule alone', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      existing({ autopublishAuthorized: false, autopublishAuthorizedTools: [] }) as any
    );

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      res()
    );

    const w = written();
    expect(w.autopublishAuthorized).toBeUndefined();
  });

  it('narrows a multi-tool grant to the tools that survive the edit', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      existing({
        requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
        autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
      }) as any
    );

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['publish_blog_article'] }),
      res()
    );

    const w = written();
    expect(w.autopublishAuthorizedTools).toEqual(['publish_blog_article']);
    // Greptile: NOT written as true. `narrowed` comes from a read taken earlier in
    // the handler, so writing the flag would let this edit restore a grant that a
    // revocation racing it had already withdrawn. Omitting the key preserves whatever
    // is stored, and the revoke then wins on its own.
    expect(w).not.toHaveProperty('autopublishAuthorized');
  });

  it('cannot resurrect a grant that was revoked while the edit was in flight', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      existing({
        requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
        autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
      }) as any
    );

    // The owner revokes between this handler's read and its write. The edit keeps
    // part of the approved scope, which is exactly the case that used to write
    // `autopublishAuthorized: true` back over the revocation.
    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['publish_blog_article'] }),
      res()
    );

    const w = written();
    expect(w).not.toHaveProperty('autopublishAuthorized');
    // Authorization needs the flag AND a non-empty scope, so a narrowed list alone
    // can never re-authorize anything.
    expect(w.autopublishAuthorizedTools).toEqual(['publish_blog_article']);
  });

  // ENG-827 (Greptile, second pass): narrowing may only ever correct a grant that is
  // actually STORED. A legacy row carries no consent field, so its scope is re-derived
  // from the required tools on every read — this edit moves those tools and the derived
  // scope follows on its own. There is nothing stale to correct, and writing `false`
  // would record a refusal the owner never gave, from an edit that never asked them.
  // It also converts a never-asked row into an explicit revocation, which is the exact
  // "decide for the owner" error the polarity deferral exists to avoid.
  it('does not stamp an explicit refusal on a legacy schedule that was never asked', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      existing({
        autopublishAuthorized: undefined,
        autopublishAuthorizedTools: undefined,
        autopublishAuthorizedAt: undefined,
        autopublishAuthorizedBy: undefined,
      }) as any
    );

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      res()
    );

    const w = written();
    expect(w).not.toHaveProperty('autopublishAuthorized');
    expect(w).not.toHaveProperty('autopublishAuthorizedTools');
    expect(w).not.toHaveProperty('autopublishAuthorizedAt');
    expect(w).not.toHaveProperty('autopublishAuthorizedBy');
  });

  // The narrowing is DERIVED from a read. The grant endpoint already binds its write to
  // its own read; this is the mirror. Without it a stale decision lands on top of a grant
  // the owner made in between and got a 200 for — their consent silently gone, later runs
  // draft-only, nothing anywhere saying so.
  it('binds the narrowing write to the consent state it read', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      res()
    );

    expect(narrowingCondition()).toEqual({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account'],
    });
  });

  // ENG-827 (Greptile, third pass): the ordering is what makes this consistent. Derived
  // from the read at the top of the handler, a grant that landed in between would either
  // be clobbered or skipped — and skipping it leaves a grant scoped to a tool this edit
  // just removed. Narrowing AFTER the edit, from a fresh read, has no such branch: the
  // grant endpoint conditions on the required tools it read, so a racing grant either
  // lands before the edit and is narrowed here, or after it and is already in scope.
  it('narrows the grant as it is NOW, not as it was when the handler started', async () => {
    mockScheduleDb.getScheduleById
      // The read that authorizes the request.
      .mockResolvedValueOnce(existing() as any)
      // By the time the edit has landed, the owner has granted again — this time
      // covering both tools. Narrowing the STALE single-tool grant against this edit
      // would empty out and revoke a grant they just made.
      .mockResolvedValueOnce(
        existing({
          autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
        }) as any
      );

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['publish_blog_article'] }),
      res()
    );

    const w = written();
    expect(w.autopublishAuthorizedTools).toEqual(['publish_blog_article']);
    expect(w).not.toHaveProperty('autopublishAuthorized');
    // Bound to the FRESH read, not the stale one.
    expect(narrowingCondition()).toEqual({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
    });
  });

  it('keeps the edit when the narrowing loses its race', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    // The edit lands; consent then changes again before the narrowing write, so its
    // condition fails. The narrowing is the derived consequence of a snapshot that is
    // now wrong, so it is what gets dropped — the owner's newer decision stands.
    const conditionFailure: any = new Error('The conditional request failed');
    conditionFailure.name = 'ConditionalCheckFailedException';
    mockScheduleDb.updateSchedule
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(conditionFailure);

    const r = res();
    await agentModeController.updateScheduledChat(
      req({ scheduleName: 'Renamed', requiredFunctionCalls: ['read_brand_guidelines'] }),
      r
    );

    // The edit was written first and unconditionally, so it cannot be lost to this.
    expect(edited().scheduleName).toBe('Renamed');
    expect(edited().requiredFunctionCalls).toEqual(['read_brand_guidelines']);
    expect(edited()).not.toHaveProperty('autopublishAuthorized');
    expect((mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][2]).toBeUndefined();
    // And the owner is told their edit worked, because it did.
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Scheduled chat updated successfully' })
    );
    expect(r.status).not.toHaveBeenCalledWith(500);
  });

  // The narrowing is best-effort — the edit is already applied and acknowledged, so a
  // failure there must not be reported as a failed edit. The EDIT's own write is not
  // best-effort and still surfaces.
  it('does not fail the edit when the narrowing write errors', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);
    mockScheduleDb.updateSchedule
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const r = res();
    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      r
    );

    expect(r.status).not.toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Scheduled chat updated successfully' })
    );
  });

  it('does not swallow a failure of the edit itself', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);
    mockScheduleDb.updateSchedule.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const r = res();
    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      r
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(r.status).toHaveBeenCalledWith(500);
  });
});
