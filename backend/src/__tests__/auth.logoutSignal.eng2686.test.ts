jest.mock('../services/serverSignalEmitter', () => ({
  emitAppSignal: jest.fn().mockResolvedValue(true),
}));

import { logout } from '../controllers/auth';
import { emitAppSignal } from '../services/serverSignalEmitter';

const mockEmit = emitAppSignal as jest.Mock;
const createRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res;
};

describe('ENG-2686 logout signal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits logout once for the authenticated user and returns 204', async () => {
    const res = createRes();
    await logout({ user: { userId: 'u-1' } } as any, res);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('u-1', 'logout', { method: 'user' });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('does not emit for a delegated session', async () => {
    const res = createRes();
    await logout({ user: { userId: 'u-1' }, delegateInfo: { isDelegated: true } } as any, res);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('still returns 204 when the emitter rejects (non-blocking)', async () => {
    mockEmit.mockRejectedValueOnce(new Error('ingest down'));
    const res = createRes();
    await logout({ user: { userId: 'u-1' } } as any, res);
    await new Promise((r) => setImmediate(r));
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
