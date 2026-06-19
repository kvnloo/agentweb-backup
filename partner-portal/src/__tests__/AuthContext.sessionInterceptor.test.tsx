import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../contexts/AuthContext';

// `../config` reads import.meta.env (not available under ts-jest); stub it.
jest.mock('../config', () => ({
  buildApiUrl: (endpoint: string) => `http://localhost:3001${endpoint}`,
}));

// Mock axios so we can capture the response-interceptor handler the AuthProvider
// registers on mount, then drive it directly with synthetic errors.
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(() => 1), eject: jest.fn() },
    },
  },
}));

import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

const Consumer = () => {
  const { isAuthenticated, user } = useAuth();
  return (
    <div>
      <div data-testid="auth">{String(isAuthenticated())}</div>
      <div data-testid="user">{user?.email || 'none'}</div>
    </div>
  );
};

// The token a failed request carried, vs. the one this tab currently holds.
const error = (status: number, code?: string, failedToken = 'valid-token') => ({
  response: { status, data: code ? { code } : {} },
  config: { headers: { Authorization: `Bearer ${failedToken}` } },
});

const getOnRejected = () =>
  (mockedAxios.interceptors.response.use as jest.Mock).mock.calls[0][1] as (
    e: any
  ) => Promise<any>;

const fire = async (err: any) => {
  const onRejected = getOnRejected();
  await expect(onRejected(err)).rejects.toBe(err);
};

const renderLoggedIn = async () => {
  localStorage.setItem('token', 'valid-token');
  mockedAxios.get.mockResolvedValue({
    data: {
      userId: 'admin-1',
      email: 'admin@example.com',
      roles: ['partner'],
      isAdmin: true,
    },
  } as any);
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
  await waitFor(() => {
    expect(screen.getByTestId('auth').textContent).toBe('true');
  });
};

const tokenRemovals = (spy: jest.SpyInstance) =>
  spy.mock.calls.filter((c) => c[0] === 'token').length;

describe('Partner portal — global 401 session interceptor', () => {
  let removeItemSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    removeItemSpy = jest.spyOn(Storage.prototype, 'removeItem');
  });

  afterEach(() => {
    removeItemSpy.mockRestore();
  });

  it('logs out on a session_invalid 401 (dead app session) and clears the token', async () => {
    await renderLoggedIn();

    await fire(error(401, 'session_invalid'));

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('false');
      expect(screen.getByTestId('user').textContent).toBe('none');
    });
    expect(tokenRemovals(removeItemSpy)).toBe(1);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('logs out only ONCE when several requests fail with session_invalid at once', async () => {
    await renderLoggedIn();

    await fire(error(401, 'session_invalid'));
    await fire(error(401, 'session_invalid'));
    await fire(error(401, 'session_invalid'));
    await fire(error(401, 'session_invalid'));
    await fire(error(401, 'session_invalid'));

    // After the first logout clears the token, currentToken is null so the rest
    // are no-ops — removeItem('token') runs exactly once.
    expect(tokenRemovals(removeItemSpy)).toBe(1);
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('false');
    });
  });

  it('does NOT log out on a 401 from a disconnected third-party integration (no code)', async () => {
    await renderLoggedIn();

    await fire(error(401));

    expect(tokenRemovals(removeItemSpy)).toBe(0);
    expect(screen.getByTestId('auth').textContent).toBe('true');
  });

  it('does NOT log out on a 401 carrying a non-session code', async () => {
    await renderLoggedIn();

    await fire(error(401, 'invalid_credentials'));

    expect(tokenRemovals(removeItemSpy)).toBe(0);
    expect(screen.getByTestId('auth').textContent).toBe('true');
  });

  it('does NOT log out the current tab when an already-rotated (stale) token 401s', async () => {
    // Admin changed their OWN password here; we adopted the new token
    // ('valid-token'). A request still in flight with the OLD token now 401s —
    // this must NOT log the current, still-valid session out.
    await renderLoggedIn();

    await fire(error(401, 'session_invalid', 'old-rotated-token'));

    expect(tokenRemovals(removeItemSpy)).toBe(0);
    expect(screen.getByTestId('auth').textContent).toBe('true');
  });

  it('ignores a 403 (authorization) — left for callers to handle', async () => {
    await renderLoggedIn();

    await fire(error(403, 'session_invalid'));

    expect(tokenRemovals(removeItemSpy)).toBe(0);
    expect(screen.getByTestId('auth').textContent).toBe('true');
  });

  it('adopts the new token in storage BEFORE /me resolves (closes self-logout race)', async () => {
    // Regression for the setToken race: the new token must be written to
    // localStorage before the /me round-trip, so a stale old-token 401 in flight
    // during validation no longer matches the stored (current) token.
    localStorage.setItem('token', 'old-token');

    let tokenSeenAtMeCall: string | null = '<unset>';
    let setTokenFn: (t: string) => Promise<void>;
    const Capture = () => {
      setTokenFn = useAuth().setToken;
      return null;
    };
    mockedAxios.get.mockImplementation(async () => {
      // Captured at the moment /me is invoked — must already be the new token.
      tokenSeenAtMeCall = localStorage.getItem('token');
      return {
        data: { userId: 'u1', email: 'u1@example.com', roles: ['partner'], isAdmin: true },
      };
    });

    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>
    );

    await waitFor(() => expect(setTokenFn).toBeDefined());
    await setTokenFn!('new-token');

    expect(tokenSeenAtMeCall).toBe('new-token');
    expect(localStorage.getItem('token')).toBe('new-token');
  });
});
