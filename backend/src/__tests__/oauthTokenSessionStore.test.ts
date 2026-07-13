import { storeTokenSession, retrieveTokenSession } from '../services/oauthTokenSessionStore';
import { settingsService } from '../services/settingsService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    deleteSetting: jest.fn(),
  },
}));

const mockGet = settingsService.getSetting as jest.Mock;
const mockSet = settingsService.setSetting as jest.Mock;
const mockDelete = settingsService.deleteSetting as jest.Mock;

const payload = {
  tokens: { access_token: 'a', refresh_token: 'r', expires_in: 3600, granted_scopes: ['Mail.Send'] },
  profile: { email: 'habeb@baldwin.com', name: 'Habeb' },
};

beforeEach(() => {
  jest.clearAllMocks();
  // bare jest.fn() returns undefined; these are awaited/`.catch()`ed, so they must be promises
  mockSet.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockGet.mockResolvedValue(null);
});

describe('oauthTokenSessionStore — must survive a different instance (ENG-301)', () => {
  it('persists the session to the shared store, not process memory', async () => {
    const sessionId = await storeTokenSession('u1', 'outlook', payload.tokens, payload.profile);

    expect(sessionId).toEqual(expect.any(String));
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [settingName, settingValue] = mockSet.mock.calls[0];
    expect(settingName).toContain(sessionId);
    // The whole point: another EB instance can read this back.
    const stored = JSON.parse(settingValue);
    expect(stored.userId).toBe('u1');
    expect(stored.provider).toBe('outlook');
    expect(stored.tokens.access_token).toBe('a');
  });

  it('round-trips a session stored by a "different instance"', async () => {
    mockGet.mockResolvedValue({
      settingValue: JSON.stringify({
        userId: 'u1',
        provider: 'outlook',
        tokens: payload.tokens,
        profile: payload.profile,
        expires: Date.now() + 60_000,
      }),
    });

    const session = await retrieveTokenSession('sess-1', 'u1', 'outlook');
    expect(session?.profile.email).toBe('habeb@baldwin.com');
    expect(session?.tokens.refresh_token).toBe('r');
  });
});

describe('oauthTokenSessionStore — security properties', () => {
  it('is one-time use: the session is deleted on retrieval', async () => {
    mockGet.mockResolvedValue({
      settingValue: JSON.stringify({
        userId: 'u1', provider: 'outlook', ...payload, expires: Date.now() + 60_000,
      }),
    });

    await retrieveTokenSession('sess-1', 'u1', 'outlook');
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('refuses a session belonging to a different user', async () => {
    mockGet.mockResolvedValue({
      settingValue: JSON.stringify({
        userId: 'someone-else', provider: 'outlook', ...payload, expires: Date.now() + 60_000,
      }),
    });

    expect(await retrieveTokenSession('sess-1', 'u1', 'outlook')).toBeNull();
    expect(mockDelete).toHaveBeenCalled(); // and burn it
  });

  it('refuses a session issued for a different provider', async () => {
    mockGet.mockResolvedValue({
      settingValue: JSON.stringify({
        userId: 'u1', provider: 'gmail', ...payload, expires: Date.now() + 60_000,
      }),
    });

    expect(await retrieveTokenSession('sess-1', 'u1', 'outlook')).toBeNull();
  });

  it('refuses an expired session', async () => {
    mockGet.mockResolvedValue({
      settingValue: JSON.stringify({
        userId: 'u1', provider: 'outlook', ...payload, expires: Date.now() - 1,
      }),
    });

    expect(await retrieveTokenSession('sess-1', 'u1', 'outlook')).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('returns null for an unknown session', async () => {
    mockGet.mockResolvedValue(null);
    expect(await retrieveTokenSession('nope', 'u1', 'outlook')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt record', async () => {
    mockGet.mockResolvedValue({ settingValue: '{not json' });
    expect(await retrieveTokenSession('sess-1', 'u1', 'outlook')).toBeNull();
  });

  it('issues unpredictable session ids', async () => {
    const a = await storeTokenSession('u1', 'outlook', payload.tokens, payload.profile);
    const b = await storeTokenSession('u1', 'outlook', payload.tokens, payload.profile);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
