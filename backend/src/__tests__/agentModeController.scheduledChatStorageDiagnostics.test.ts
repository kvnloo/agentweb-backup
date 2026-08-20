/**
 * ENG-1071 — GET /api/agent-mode/scheduled-chats/:scheduleId/storage-diagnostics
 *
 * Exercises the controller wiring on top of the pure `getScheduleStorageDiagnostics`
 * util (covered directly in dynamoItemBudget.storageDiagnostics.test.ts): ownership
 * enforcement, 404 on a missing/foreign schedule, and that the read-only diagnostic
 * is what actually reaches the response — no write path is touched.
 */

import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    updateSchedule: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatResultEmail: jest.fn(),
  },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const OWNER = { userId: 'owner-1', email: 'owner@example.com' };
const OTHER_USER = { userId: 'someone-else', email: 'stranger@example.com' };

const bigRevisions = (count = 10) => Array.from({ length: count }, (_, i) => ({
  startingMessage: 'p'.repeat(33000),
  updatedAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
}));

const nearLimitSchedule = {
  scheduleId: '98b99693-c68c-4d49-82b2-c35500dffed1',
  userId: OWNER.userId,
  scheduleName: 'S',
  startingMessage: 'p'.repeat(35000),
  frequency: 'daily',
  promptRevisions: bigRevisions(),
  runResults: [{ summary: 'r'.repeat(57000) }],
};

function mockReq(user: any, scheduleId = nearLimitSchedule.scheduleId) {
  return { user, params: { scheduleId } } as any;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('getScheduledChatStorageDiagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── FAIL: invalid inputs / boundary / error paths ────────────────────────

  it('404s when the schedule does not exist', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(undefined as any);
    const res = mockRes();

    await agentModeController.getScheduledChatStorageDiagnostics(mockReq(OWNER), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
  });

  it('404s (never leaks existence) when the schedule belongs to a different user', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(nearLimitSchedule as any);
    const res = mockRes();

    await agentModeController.getScheduledChatStorageDiagnostics(mockReq(OTHER_USER), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
  });

  it('500s with a generic message (never a raw DB error) if the read itself throws', async () => {
    mockScheduleDb.getScheduleById.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const res = mockRes();

    await agentModeController.getScheduledChatStorageDiagnostics(mockReq(OWNER), res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).not.toMatch(/ProvisionedThroughput/);
  });

  it('never calls updateSchedule — this endpoint is read-only', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(nearLimitSchedule as any);
    const res = mockRes();

    await agentModeController.getScheduledChatStorageDiagnostics(mockReq(OWNER), res);

    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  // ─── SUCCESS: the owner gets the real diagnostic ──────────────────────────

  it('returns the byte-usage breakdown and corrective action for the owner', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(nearLimitSchedule as any);
    const res = mockRes();

    await agentModeController.getScheduledChatStorageDiagnostics(mockReq(OWNER), res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.status).not.toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.fields).toMatchObject({
      currentPrompt: expect.any(Number),
      promptRevisions: expect.any(Number),
      runResults: expect.any(Number),
    });
    expect(body.dominantField).toBe('promptRevisions');
    expect(body.approachingLimit).toBe(true);
    expect(typeof body.correctiveAction).toBe('string');
    // No raw prompt/run content anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('p'.repeat(100));
    expect(JSON.stringify(body)).not.toContain('r'.repeat(100));
  });

  it('returns approachingLimit=false and correctiveAction=null for a small schedule', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-small',
      userId: OWNER.userId,
      scheduleName: 'S',
      startingMessage: 'Send me a daily summary.',
      frequency: 'daily',
      promptRevisions: [],
      runResults: [],
    } as any);
    const res = mockRes();

    await agentModeController.getScheduledChatStorageDiagnostics(mockReq(OWNER, 'sched-small'), res);

    const body = res.json.mock.calls[0][0];
    expect(body.approachingLimit).toBe(false);
    expect(body.correctiveAction).toBeNull();
  });
});
