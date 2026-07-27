import { storeTokenSession, retrieveTokenSession } from '../services/oauthTokenSessionStore';
import { settingsService } from '../services/settingsService';

// Back the settings table with an in-memory map so the read-modify-write behaviour of the
// store is exercised for real, rather than asserted against mock call arguments.
const table = new Map<string, string>();

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    deleteSetting: jest.fn(),
  },
}));

const ttlArgOf = (call: any[]) => call[4];

const mockGet = settingsService.getSetting as jest.Mock;
const mockSet = settingsService.setSetting as jest.Mock;
const mockDelete = settingsService.deleteSetting as jest.Mock;

const tokens = { access_token: 'a', refresh_token: 'r', expires_in: 3600, granted_scopes: ['Mail.Send'] };
const profile = { email: 'habeb@baldwin.com', name: 'Habeb' };

const rowsWithTokens = () =>
  [...table.entries()].filter(([, v]) => v.includes('access_token'));

beforeEach(() => {
  jest.clearAllMocks();
  table.clear();
  mockGet.mockImplementation(async (name: string) => {
    const settingValue = table.get(name);
    return settingValue ? { settingName: name, settingValue } : null;
  });
  mockSet.mockImplementation(async (name: string, value: string) => {
    table.set(name, value);
  });
  mockDelete.mockImplementation(async (name: string) => {
    table.delete(name);
  });
});

describe('oauthTokenSessionStore — must survive a different instance (ENG-301)', () => {
  it('round-trips a session through the shared store, not process memory', async () => {
    const sessionId = await storeTokenSession('u1', 'outlook', tokens, profile);

    // A "different instance" reads it back purely from the table.
    const session = await retrieveTokenSession(sessionId, 'u1', 'outlook');
    expect(session?.profile.email).toBe('habeb@baldwin.com');
    expect(session?.tokens.refresh_token).toBe('r');
  });
});

// AW-Settings has no DynamoDB TTL, and the in-memory version's sweeper did not survive the
// move. If each attempt wrote its own row, an abandoned popup would leave live access and
// refresh tokens behind forever, and every retry would add another.
describe('oauthTokenSessionStore — abandoned popups must not accumulate token material', () => {
  it('keeps abandoned attempts in ONE row, not one row each', async () => {
    await storeTokenSession('u1', 'outlook', tokens, profile);
    await storeTokenSession('u1', 'outlook', tokens, profile);
    await storeTokenSession('u1', 'outlook', tokens, profile);

    expect(rowsWithTokens()).toHaveLength(1);
  });

  it('prunes expired sessions on the next write, so tokens do not linger', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T10:00:00Z'));
    await storeTokenSession('u1', 'outlook', tokens, profile); // abandoned

    // 11 minutes later (TTL is 10), the user tries again.
    jest.setSystemTime(new Date('2026-07-13T10:11:00Z'));
    await storeTokenSession('u1', 'outlook', tokens, profile);

    const row = JSON.parse(table.get('oauth_token_session_outlook_u1')!);
    expect(row.sessions).toHaveLength(1); // the abandoned one is gone
    jest.useRealTimers();
  });

  it('caps the row even if something retries in a loop', async () => {
    for (let i = 0; i < 12; i++) await storeTokenSession('u1', 'outlook', tokens, profile);

    const row = JSON.parse(table.get('oauth_token_session_outlook_u1')!);
    expect(row.sessions.length).toBeLessThanOrEqual(5);
  });

  it('deletes the row entirely once the last session is consumed', async () => {
    const id = await storeTokenSession('u1', 'outlook', tokens, profile);
    await retrieveTokenSession(id, 'u1', 'outlook');

    expect(table.has('oauth_token_session_outlook_u1')).toBe(false);
  });

  it('keeps different providers and different users in separate rows', async () => {
    await storeTokenSession('u1', 'outlook', tokens, profile);
    await storeTokenSession('u1', 'gmail', tokens, profile);
    await storeTokenSession('u2', 'outlook', tokens, profile);

    expect(rowsWithTokens()).toHaveLength(3);
  });

  it('does not put the session id in the KEY (it is a secret, checked on read)', async () => {
    const sessionId = await storeTokenSession('u1', 'outlook', tokens, profile);
    expect([...table.keys()].some((k) => k.includes(sessionId))).toBe(false);
  });
});

// Greptile (PR review, ENG-266): app-level `expires` alone means an abandoned popup's row
// physically outlives its own "expiry" in DynamoDB forever unless the same user retries the
// same provider. Writing a real DynamoDB TTL attribute closes that — DynamoDB deletes the
// row itself once every session in it is actually expired.
describe('oauthTokenSessionStore — DynamoDB TTL attribute', () => {
  it('passes a ttl to setSetting matching the furthest-out session expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T10:00:00Z'));
    await storeTokenSession('u1', 'outlook', tokens, profile);
    jest.useRealTimers();

    const ttl = ttlArgOf(mockSet.mock.calls[0]);
    const expectedTtl = Math.floor(new Date('2026-07-13T10:10:00Z').getTime() / 1000); // TTL is 10 min
    expect(ttl).toBe(expectedTtl);
  });

  it('advances the ttl to the newest session when a second popup is opened later', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T10:00:00Z'));
    await storeTokenSession('u1', 'outlook', tokens, profile);

    jest.setSystemTime(new Date('2026-07-13T10:05:00Z'));
    await storeTokenSession('u1', 'outlook', tokens, profile);
    jest.useRealTimers();

    const ttl = ttlArgOf(mockSet.mock.calls[mockSet.mock.calls.length - 1]);
    const expectedTtl = Math.floor(new Date('2026-07-13T10:15:00Z').getTime() / 1000);
    expect(ttl).toBe(expectedTtl);
  });

  it('does not call setSetting with a ttl when the row is emptied (deleteSetting path)', async () => {
    const id = await storeTokenSession('u1', 'outlook', tokens, profile);
    mockSet.mockClear();
    await retrieveTokenSession(id, 'u1', 'outlook');

    expect(mockDelete).toHaveBeenCalledWith('oauth_token_session_outlook_u1');
    expect(mockSet).not.toHaveBeenCalled();
  });
});

// The previous (single-session-per-row) design broke this: a second popup overwrote the
// first, and the first /connect then failed. A user connecting two mailboxes is legitimate.
describe('oauthTokenSessionStore — concurrent popups must not invalidate each other', () => {
  it('honours BOTH sessions when two popups are open for the same provider', async () => {
    const first = await storeTokenSession('u1', 'gmail', tokens, { email: 'one@x.com', name: 'One' });
    const second = await storeTokenSession('u1', 'gmail', tokens, { email: 'two@x.com', name: 'Two' });

    // Finish them out of order, for good measure.
    const b = await retrieveTokenSession(second, 'u1', 'gmail');
    const a = await retrieveTokenSession(first, 'u1', 'gmail');

    expect(b?.profile.email).toBe('two@x.com');
    expect(a?.profile.email).toBe('one@x.com');
  });

  it('consuming one session does not burn its siblings', async () => {
    const first = await storeTokenSession('u1', 'gmail', tokens, profile);
    const second = await storeTokenSession('u1', 'gmail', tokens, profile);

    await retrieveTokenSession(first, 'u1', 'gmail');

    const row = JSON.parse(table.get('oauth_token_session_gmail_u1')!);
    expect(row.sessions).toHaveLength(1);
    expect(await retrieveTokenSession(second, 'u1', 'gmail')).not.toBeNull();
  });
});

describe('oauthTokenSessionStore — security properties', () => {
  it('is one-time use: the same session id cannot be replayed', async () => {
    const id = await storeTokenSession('u1', 'outlook', tokens, profile);

    expect(await retrieveTokenSession(id, 'u1', 'outlook')).not.toBeNull();
    expect(await retrieveTokenSession(id, 'u1', 'outlook')).toBeNull();
  });

  it('refuses a WRONG session id', async () => {
    await storeTokenSession('u1', 'outlook', tokens, profile);
    expect(await retrieveTokenSession('not-the-secret', 'u1', 'outlook')).toBeNull();
  });

  it('refuses an empty session id', async () => {
    await storeTokenSession('u1', 'outlook', tokens, profile);
    expect(await retrieveTokenSession('', 'u1', 'outlook')).toBeNull();
  });

  it('refuses another user presenting a valid session id', async () => {
    const id = await storeTokenSession('u1', 'outlook', tokens, profile);
    expect(await retrieveTokenSession(id, 'attacker', 'outlook')).toBeNull();
  });

  it('refuses a session issued for a different provider', async () => {
    const id = await storeTokenSession('u1', 'gmail', tokens, profile);
    expect(await retrieveTokenSession(id, 'u1', 'outlook')).toBeNull();
  });

  it('refuses an expired session', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T10:00:00Z'));
    const id = await storeTokenSession('u1', 'outlook', tokens, profile);

    jest.setSystemTime(new Date('2026-07-13T10:11:00Z')); // TTL is 10 minutes
    expect(await retrieveTokenSession(id, 'u1', 'outlook')).toBeNull();
    jest.useRealTimers();
  });

  it('returns null for an unknown session', async () => {
    expect(await retrieveTokenSession('nope', 'u1', 'outlook')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt row', async () => {
    table.set('oauth_token_session_outlook_u1', '{not json');
    expect(await retrieveTokenSession('anything', 'u1', 'outlook')).toBeNull();
  });

  it('issues unpredictable session ids', async () => {
    const a = await storeTokenSession('u1', 'outlook', tokens, profile);
    const b = await storeTokenSession('u1', 'outlook', tokens, profile);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe('oauthTokenSessionStore — persistence failures stay explicit', () => {
  it('fails closed when the shared store cannot be read', async () => {
    mockGet.mockRejectedValueOnce(new Error('Dynamo read failed'));
    await expect(retrieveTokenSession('session-id', 'u1', 'outlook'))
      .rejects.toThrow('Dynamo read failed');
  });

  it('fails closed when a pending session cannot be written', async () => {
    mockSet.mockRejectedValueOnce(new Error('Dynamo write failed'));
    await expect(storeTokenSession('u1', 'outlook', tokens, profile))
      .rejects.toThrow('Dynamo write failed');
  });

  it('does not return token material when one-time-use deletion fails', async () => {
    const id = await storeTokenSession('u1', 'outlook', tokens, profile);
    mockDelete.mockRejectedValueOnce(new Error('Dynamo delete failed'));

    await expect(retrieveTokenSession(id, 'u1', 'outlook'))
      .rejects.toThrow('Dynamo delete failed');
  });
});
