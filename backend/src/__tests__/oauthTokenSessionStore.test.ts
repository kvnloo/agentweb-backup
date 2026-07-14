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

const tokens = { access_token: 'a', refresh_token: 'r', expires_in: 3600, granted_scopes: ['Mail.Send'] };
const profile = { email: 'habeb@baldwin.com', name: 'Habeb' };

/** Simulate the row another instance would read back. */
const storedRow = (over: any = {}) => ({
  settingValue: JSON.stringify({
    sessionId: 'the-secret',
    userId: 'u1',
    provider: 'outlook',
    tokens,
    profile,
    expires: Date.now() + 60_000,
    ...over,
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockGet.mockResolvedValue(null);
});

describe('oauthTokenSessionStore — must survive a different instance (ENG-301)', () => {
  it('persists the session to the shared store, not process memory', async () => {
    const sessionId = await storeTokenSession('u1', 'outlook', tokens, profile);

    expect(sessionId).toEqual(expect.any(String));
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [, settingValue] = mockSet.mock.calls[0];
    const stored = JSON.parse(settingValue);
    expect(stored.userId).toBe('u1');
    expect(stored.provider).toBe('outlook');
    expect(stored.tokens.access_token).toBe('a');
  });

  it('round-trips a session stored by a "different instance"', async () => {
    mockGet.mockResolvedValue(storedRow());

    const session = await retrieveTokenSession('the-secret', 'u1', 'outlook');
    expect(session?.profile.email).toBe('habeb@baldwin.com');
    expect(session?.tokens.refresh_token).toBe('r');
  });
});

// AW-Settings has no DynamoDB TTL, and the in-memory version's sweeper did not survive the
// move. If each attempt wrote its own row, an abandoned popup would leave live access and
// refresh tokens behind FOREVER, and every retry would add another. Keying by user+provider
// makes the row self-overwriting, which bounds that to one stale row per provider.
describe('oauthTokenSessionStore — abandoned popups must not accumulate token material', () => {
  it('writes to a deterministic key per user+provider, so a retry OVERWRITES the previous attempt', async () => {
    await storeTokenSession('u1', 'outlook', tokens, profile);
    await storeTokenSession('u1', 'outlook', tokens, profile);
    await storeTokenSession('u1', 'outlook', tokens, profile);

    const keys = new Set(mockSet.mock.calls.map((c) => c[0]));
    expect(keys.size).toBe(1); // three abandoned attempts -> ONE row, not three
  });

  it('keeps different providers and different users in separate rows', async () => {
    await storeTokenSession('u1', 'outlook', tokens, profile);
    await storeTokenSession('u1', 'gmail', tokens, profile);
    await storeTokenSession('u2', 'outlook', tokens, profile);

    const keys = new Set(mockSet.mock.calls.map((c) => c[0]));
    expect(keys.size).toBe(3);
  });

  it('does not put the session id in the KEY (it is a secret, checked on read)', async () => {
    const sessionId = await storeTokenSession('u1', 'outlook', tokens, profile);
    const [key] = mockSet.mock.calls[0];
    expect(key).not.toContain(sessionId);
  });
});

describe('oauthTokenSessionStore — security properties', () => {
  it('is one-time use: the row is deleted on retrieval', async () => {
    mockGet.mockResolvedValue(storedRow());
    await retrieveTokenSession('the-secret', 'u1', 'outlook');
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('refuses a WRONG session id, and burns the row anyway', async () => {
    mockGet.mockResolvedValue(storedRow());
    expect(await retrieveTokenSession('not-the-secret', 'u1', 'outlook')).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('refuses an empty session id', async () => {
    mockGet.mockResolvedValue(storedRow());
    expect(await retrieveTokenSession('', 'u1', 'outlook')).toBeNull();
  });

  it('refuses a session belonging to a different user', async () => {
    mockGet.mockResolvedValue(storedRow({ userId: 'someone-else' }));
    expect(await retrieveTokenSession('the-secret', 'u1', 'outlook')).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('refuses a session issued for a different provider', async () => {
    mockGet.mockResolvedValue(storedRow({ provider: 'gmail' }));
    expect(await retrieveTokenSession('the-secret', 'u1', 'outlook')).toBeNull();
  });

  it('refuses an expired session', async () => {
    mockGet.mockResolvedValue(storedRow({ expires: Date.now() - 1 }));
    expect(await retrieveTokenSession('the-secret', 'u1', 'outlook')).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('returns null for an unknown session', async () => {
    mockGet.mockResolvedValue(null);
    expect(await retrieveTokenSession('the-secret', 'u1', 'outlook')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt row', async () => {
    mockGet.mockResolvedValue({ settingValue: '{not json' });
    expect(await retrieveTokenSession('the-secret', 'u1', 'outlook')).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('issues unpredictable session ids', async () => {
    const a = await storeTokenSession('u1', 'outlook', tokens, profile);
    const b = await storeTokenSession('u1', 'outlook', tokens, profile);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
