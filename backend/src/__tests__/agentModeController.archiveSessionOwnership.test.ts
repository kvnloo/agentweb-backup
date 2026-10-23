import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb, updateTaskExecutionStatus } from '../services/chatbotService';

jest.mock('../services/chatbotService', () => ({
  ...jest.requireActual('../services/chatbotService'),
  chatbotDb: { getChatSessionRecord: jest.fn(), archiveSession: jest.fn() },
  updateTaskExecutionStatus: jest.fn(),
}));

const getRecord = chatbotDb.getChatSessionRecord as jest.Mock;
const archive = chatbotDb.archiveSession as jest.Mock;
const updateTask = updateTaskExecutionStatus as jest.Mock;

const res = () => {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
};
const req = (user: any, params: Record<string, string> = { sessionId: 's1' }, body: any = {}) => ({ user, params, body }) as any;

describe('ENG-2644: session-scoped mutations require owner or admin', () => {
  beforeEach(() => { getRecord.mockReset(); archive.mockReset(); updateTask.mockReset(); });

  it('archives the caller\'s own session', async () => {
    getRecord.mockResolvedValue({ sessionId: 's1', userId: 'u1' });
    const r = res();
    await agentModeController.archiveSession(req({ userId: 'u1' }), r);
    expect(archive).toHaveBeenCalledWith('s1');
    expect(r.status).not.toHaveBeenCalled();
  });

  it('404s and does not archive another user\'s session', async () => {
    getRecord.mockResolvedValue({ sessionId: 's1', userId: 'victim' });
    const r = res();
    await agentModeController.archiveSession(req({ userId: 'attacker' }), r);
    expect(archive).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(404);
  });

  it('404s for an unknown session id (no ghost row)', async () => {
    getRecord.mockResolvedValue(null);
    const r = res();
    await agentModeController.archiveSession(req({ userId: 'u1' }), r);
    expect(archive).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(404);
  });

  it('lets an admin archive any session', async () => {
    getRecord.mockResolvedValue({ sessionId: 's1', userId: 'victim' });
    const r = res();
    await agentModeController.archiveSession(req({ userId: 'admin', isAdmin: true }), r);
    expect(archive).toHaveBeenCalledWith('s1');
  });

  it('maps a ConditionalCheckFailed race (deleted between read and write) to 404', async () => {
    getRecord.mockResolvedValue({ sessionId: 's1', userId: 'u1' });
    archive.mockRejectedValue(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }));
    const r = res();
    await agentModeController.archiveSession(req({ userId: 'u1' }), r);
    expect(r.status).toHaveBeenCalledWith(404);
  });

  it('updateTaskStatus rejects a non-owner', async () => {
    getRecord.mockResolvedValue({ sessionId: 's1', userId: 'victim' });
    const r = res();
    await agentModeController.updateTaskStatus(
      req({ userId: 'attacker' }, { sessionId: 's1', taskId: 't', executionId: 'e' }, { status: 'done' }), r);
    expect(updateTask).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(404);
  });
});
