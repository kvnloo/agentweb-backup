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

const written = () => (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][1] as any;

describe('ENG-827 — publish consent narrows when an edit changes the required tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(w.autopublishAuthorized).toBe(true);
    expect(w.autopublishAuthorizedTools).toEqual(['publish_blog_article']);
  });
});
