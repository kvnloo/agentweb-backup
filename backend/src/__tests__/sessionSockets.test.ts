/**
 * Tests for disconnectStaleUserSockets — the password-change live-socket sweep.
 *
 * The connect-time gate can't drop already-open sockets, so on a sessionVersion
 * bump we must disconnect a user's sockets that still carry an older `sv`, and
 * leave any socket already on the new version connected.
 */

import { disconnectStaleUserSockets, registerIo } from '../services/sessionSockets';

const mockFetchSockets = jest.fn();
const mockIn = jest.fn(() => ({ fetchSockets: mockFetchSockets }));

function fakeSocket(sv: number | undefined) {
  return {
    data: sv === undefined ? {} : { user: { sv } },
    disconnect: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  registerIo({ in: mockIn } as any);
});

describe('disconnectStaleUserSockets', () => {
  it('targets the per-user room', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    await disconnectStaleUserSockets('user-1', 3);
    expect(mockIn).toHaveBeenCalledWith('user:user-1');
  });

  it('disconnects only sockets behind the new session version', async () => {
    const staleA = fakeSocket(1);
    const staleB = fakeSocket(2);
    const current = fakeSocket(3);
    mockFetchSockets.mockResolvedValueOnce([staleA, current, staleB]);

    const n = await disconnectStaleUserSockets('user-1', 3);

    expect(n).toBe(2);
    expect(staleA.disconnect).toHaveBeenCalledWith(true);
    expect(staleB.disconnect).toHaveBeenCalledWith(true);
    expect(current.disconnect).not.toHaveBeenCalled();
  });

  it('treats a socket with no sv as version 0 (stale)', async () => {
    const noSv = fakeSocket(undefined);
    mockFetchSockets.mockResolvedValueOnce([noSv]);

    const n = await disconnectStaleUserSockets('user-1', 1);

    expect(n).toBe(1);
    expect(noSv.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects nothing when all sockets are current', async () => {
    const a = fakeSocket(5);
    const b = fakeSocket(5);
    mockFetchSockets.mockResolvedValueOnce([a, b]);

    const n = await disconnectStaleUserSockets('user-1', 5);

    expect(n).toBe(0);
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(b.disconnect).not.toHaveBeenCalled();
  });

  it('never throws — returns 0 if the socket layer errors', async () => {
    mockFetchSockets.mockRejectedValueOnce(new Error('io down'));

    const n = await disconnectStaleUserSockets('user-1', 2);

    expect(n).toBe(0);
  });

  it('returns 0 when io has not been registered', async () => {
    registerIo(undefined as any);
    const n = await disconnectStaleUserSockets('user-1', 2);
    expect(n).toBe(0);
    expect(mockIn).not.toHaveBeenCalled();
  });
});
