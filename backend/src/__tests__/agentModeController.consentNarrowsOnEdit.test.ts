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

/** The edit and its consent narrowing are ONE write, so both live in the same payload. */
const written = () => (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][1] as any;
const edited = written;
const narrowingCondition = () => (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][2];

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
      requiredFunctionCalls: ['read_brand_guidelines', 'post_on_connected_account'],
    });
  });

  // ENG-827 (Greptile, seventh pass): the narrowing is derived from the required tools
  // as well as from the consent, so asserting only the consent leaves a concurrent edit
  // free to move those tools underneath it — the grant would then be narrowed, or
  // dropped, against a list that is no longer the schedule's.
  it('binds the narrowing to the required tools it was derived against', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      res()
    );

    expect(narrowingCondition()).toEqual(
      expect.objectContaining({
        requiredFunctionCalls: ['read_brand_guidelines', 'post_on_connected_account'],
      })
    );
  });

  it('re-derives against the tools that actually landed when a concurrent edit moved them', async () => {
    mockScheduleDb.getScheduleById
      .mockResolvedValueOnce(existing() as any)
      // A concurrent edit swapped which publishing tool this schedule uses, and the
      // owner's grant now covers that one.
      .mockResolvedValueOnce(
        existing({
          requiredFunctionCalls: ['read_brand_guidelines', 'publish_blog_article'],
          autopublishAuthorizedTools: ['publish_blog_article'],
        }) as any
      );

    const conditionFailure: any = new Error('The conditional request failed');
    conditionFailure.name = 'ConditionalCheckFailedException';
    mockScheduleDb.updateSchedule
      .mockRejectedValueOnce(conditionFailure)
      .mockResolvedValueOnce({} as any);

    const r = res();
    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      r
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
    const retry = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[1];
    // Narrowed against the grant that is actually stored now.
    expect(retry[1].autopublishAuthorizedTools).toEqual([]);
    expect(retry[1].autopublishAuthorized).toBe(false);
    expect(retry[2]).toEqual({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['publish_blog_article'],
      requiredFunctionCalls: ['read_brand_guidelines', 'publish_blog_article'],
    });
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Scheduled chat updated successfully' })
    );
  });

  // ENG-827 (Greptile, fourth pass). Two failures were on the table and they pull in
  // opposite directions: fold the narrowing into the edit's write unconditionally and a
  // grant made in between is clobbered; split them and acknowledge the edit first, and
  // any failure of the follow-up leaves the edit sitting next to a grant scoped to the
  // tool it just removed. One conditional write plus a retry is what satisfies both —
  // nothing partial is ever acknowledged, and a racing consent change is re-read rather
  // than either overwritten or given up on.
  it('re-derives the narrowing against the consent that actually won the race', async () => {
    mockScheduleDb.getScheduleById
      // The read that authorizes the request: a grant covering one tool.
      .mockResolvedValueOnce(existing() as any)
      // The re-read after the condition fails: the owner re-granted in between, this
      // time covering both tools. Narrowing the STALE single-tool grant against this
      // edit would empty out and revoke a grant they had just made.
      .mockResolvedValueOnce(
        existing({
          autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
        }) as any
      );

    const conditionFailure: any = new Error('The conditional request failed');
    conditionFailure.name = 'ConditionalCheckFailedException';
    mockScheduleDb.updateSchedule
      .mockRejectedValueOnce(conditionFailure)
      .mockResolvedValueOnce({} as any);

    const r = res();
    await agentModeController.updateScheduledChat(
      req({ scheduleName: 'Renamed', requiredFunctionCalls: ['publish_blog_article'] }),
      r
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
    const retry = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[1];
    // The edit and the narrowing land TOGETHER, in the retry.
    expect(retry[1].scheduleName).toBe('Renamed');
    expect(retry[1].autopublishAuthorizedTools).toEqual(['publish_blog_article']);
    expect(retry[1]).not.toHaveProperty('autopublishAuthorized');
    // Bound to the consent that won, not the one the handler opened with.
    expect(retry[2]).toEqual({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
      requiredFunctionCalls: ['read_brand_guidelines', 'post_on_connected_account'],
    });
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Scheduled chat updated successfully' })
    );
  });

  // The point of the retry is convergence, not infinity. When it does not converge the
  // one thing that must not happen is acknowledging a save that did not occur.
  it('reports a conflict rather than acknowledging an edit it could not write', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    const conditionFailure: any = new Error('The conditional request failed');
    conditionFailure.name = 'ConditionalCheckFailedException';
    mockScheduleDb.updateSchedule.mockRejectedValue(conditionFailure);

    const r = res();
    await agentModeController.updateScheduledChat(
      req({ scheduleName: 'Renamed', requiredFunctionCalls: ['read_brand_guidelines'] }),
      r
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(3);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('nothing was saved') })
    );
    expect(r.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Scheduled chat updated successfully' })
    );
  });

  // An ordinary edit must not be made to fail because somebody touched consent at the
  // same moment: with nothing to narrow there is no condition to lose.
  it('asserts nothing about consent when there is no grant to narrow', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      existing({ autopublishAuthorized: undefined, autopublishAuthorizedTools: undefined }) as any
    );

    await agentModeController.updateScheduledChat(
      req({ requiredFunctionCalls: ['read_brand_guidelines'] }),
      res()
    );

    expect(narrowingCondition()).toBeUndefined();
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
