import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

/**
 * ENG-827 — the shape of publish consent in the schedule LIST response.
 *
 * Every schedule created before this feature has no `autopublishAuthorized` attribute at
 * all, so spreading the stored item leaves the key absent on the wire. That hands the
 * portal a three-state flag (true / false / missing) for what is a two-state permission,
 * and the two ways to read "missing" fail in opposite directions:
 *
 *   - read it as GRANTED  → editing an unrelated field revokes a setting nobody touched
 *   - read it as OFF      → a stored grant survives the user unticking the box, and the
 *                           schedule keeps publishing unreviewed while the UI says it
 *                           does not
 *
 * The second is the dangerous one, and neither is acceptable. So the list normalizes:
 * the key is always present and always a boolean, and the client never has to guess.
 */

jest.mock('../services/db', () => ({
  scheduleDb: { getSchedulesByUserId: jest.fn(), getRunResults: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const USER = 'user-1';

const req = () => ({ user: { userId: USER } } as any);

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const schedule = (over: any = {}) => ({
  scheduleId: 'sc-1',
  userId: USER,
  type: 'scheduled_chat',
  scheduleName: 'Daily LinkedIn Post',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const listed = (r: any) => r.json.mock.calls[0][0];

describe('ENG-827 — getScheduledChats normalizes publish consent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits false, not undefined, for a schedule that predates the feature', async () => {
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([schedule()] as any);
    const r = res();
    await agentModeController.getScheduledChats(req(), r);

    const [row] = listed(r);
    expect(row).toHaveProperty('autopublishAuthorized');
    expect(row.autopublishAuthorized).toBe(false);
  });

  it('preserves a real grant', async () => {
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
      schedule({ autopublishAuthorized: true }),
    ] as any);
    const r = res();
    await agentModeController.getScheduledChats(req(), r);

    expect(listed(r)[0].autopublishAuthorized).toBe(true);
  });

  it('preserves an explicit revocation', async () => {
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
      schedule({ autopublishAuthorized: false }),
    ] as any);
    const r = res();
    await agentModeController.getScheduledChats(req(), r);

    expect(listed(r)[0].autopublishAuthorized).toBe(false);
  });

  it('does not let a truthy-but-not-true stored value read as consent', async () => {
    // A half-written or hand-edited item must not be able to imply a grant the owner
    // never gave — only the boolean true counts.
    for (const stored of ['true', 1, {}, 'yes']) {
      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        schedule({ autopublishAuthorized: stored }),
      ] as any);
      const r = res();
      await agentModeController.getScheduledChats(req(), r);

      expect(listed(r)[0].autopublishAuthorized).toBe(false);
    }
  });

  it('normalizes every row, not just the first', async () => {
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
      schedule({ scheduleId: 'sc-1', autopublishAuthorized: true }),
      schedule({ scheduleId: 'sc-2' }),
      schedule({ scheduleId: 'sc-3', autopublishAuthorized: false }),
    ] as any);
    const r = res();
    await agentModeController.getScheduledChats(req(), r);

    expect(listed(r).map((s: any) => [s.scheduleId, s.autopublishAuthorized])).toEqual([
      ['sc-1', true],
      ['sc-2', false],
      ['sc-3', false],
    ]);
  });
});
