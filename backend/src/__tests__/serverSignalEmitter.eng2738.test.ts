import { emitAppSignal, DEFAULT_HIREEMMA_SIGNAL_LIST_ID } from '../services/serverSignalEmitter';

const user = { userId: 'u-1', createdAt: '2026-10-29T00:00:00.000Z' };
const deps = (over: Record<string, any> = {}) => ({
  getList: jest.fn().mockResolvedValue({ listId: DEFAULT_HIREEMMA_SIGNAL_LIST_ID, listType: 'session', userId: 'owner' }),
  ingest: jest.fn().mockResolvedValue({}),
  findUserById: jest.fn().mockResolvedValue(user),
  now: () => 1_800_000_000_000,
  logger: { warn: jest.fn(), error: jest.fn() },
  ...over,
});

describe('ENG-2738 registration_completed signal', () => {
  it('emits registration_completed with the signup method to the hireemma.ai session list', async () => {
    const d = deps();
    await expect(emitAppSignal(user, 'registration_completed', { method: 'password' }, d as any)).resolves.toBe(true);
    expect(d.ingest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(d.ingest.mock.calls[0][0])).toContain('registration_completed');
    expect(JSON.stringify(d.ingest.mock.calls[0][0])).toContain('password');
  });

  it('never throws when ingest fails (registration must not be affected)', async () => {
    const d = deps({ ingest: jest.fn().mockRejectedValue(new Error('ddb down')) });
    await expect(emitAppSignal(user, 'registration_completed', { method: 'google' }, d as any)).resolves.toBe(false);
  });
});
