/**
 * WhatsApp number-ownership verification (ENG-273).
 *
 * A destination is not messaged until the person has proven they control it, by
 * messaging AgentWeb a one-time code. What this suite defends is the consent and
 * abuse-resistance of that step — the reason it exists at all:
 *
 *  - the number that gets connected is the SENDER's, never one that was typed;
 *  - a code is single-use even under a race between two deliveries;
 *  - a crash between consuming a code and saving the channel is RETRYABLE, not lost;
 *  - expiry is decided from a stored timestamp, because DynamoDB TTL reaps late;
 *  - guessing is throttled per sender, and a STOPped number stays blocked;
 *  - the code (a short-lived credential) never reaches a log.
 *
 * It also carries the two Greptile P1 invariants forward from the old PUT route: saving
 * WhatsApp must not freeze the user's Slack routing, and must not drop other channels.
 */

import crypto from 'crypto';

// ── In-memory stand-ins with the semantics that matter ─────────────────────

type Row = { settingValue: string; ttl?: number };
const store = new Map<string, Row>();
const users = new Map<string, any>();

const conditionalFailure = () =>
  Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    deleteSetting: jest.fn(),
    setSettingIfValueMatches: jest.fn(),
  },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/whatsappService', () => ({
  toE164: jest.requireActual('../services/whatsappService').toE164,
  redactPhone: jest.requireActual('../services/whatsappService').redactPhone,
  isOptedOut: jest.fn(),
  sendMessage: jest.fn(),
  bindPhoneToUser: jest.fn(),
  unbindPhone: jest.fn(),
}));

const { settingsService } = require('../services/settingsService');
const { userDb } = require('../services/db');
const whatsapp = require('../services/whatsappService');

import {
  startVerification,
  completeVerification,
  getVerificationStatus,
  handleVerificationMessage,
  parseVerificationMessage,
} from '../services/whatsappVerificationService';
import { resolveDestination } from '../services/messagingChannelService';

const PHONE = '+14155550123';
const OTHER = '+14155559999';
const ACK = '2026-09-21T12:00:00.000Z';
const TEN_MIN = 10 * 60 * 1000;

let clock: number;
let logSpies: jest.SpyInstance[];

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rowFor = (code: string) => {
  const raw = store.get(`whatsapp:verify:${sha(code)}`)?.settingValue;
  return raw ? JSON.parse(raw) : undefined;
};

beforeEach(() => {
  jest.resetAllMocks();
  store.clear();
  users.clear();
  users.set('u1', { userId: 'u1', slackChannels: ['C1'] });
  clock = Date.parse('2026-09-21T12:00:00.000Z');
  jest.spyOn(Date, 'now').mockImplementation(() => clock);

  settingsService.getSetting.mockImplementation(async (k: string) =>
    store.has(k) ? { settingName: k, ...store.get(k) } : null,
  );
  settingsService.setSetting.mockImplementation(
    async (k: string, v: string, _d?: string, _u?: string, ttl?: number) => {
      store.set(k, { settingValue: v, ttl });
    },
  );
  settingsService.deleteSetting.mockImplementation(async (k: string) => {
    store.delete(k);
  });
  // Real compare-and-swap semantics: only writes if the row still holds what was read.
  settingsService.setSettingIfValueMatches.mockImplementation(
    async (k: string, v: string, expected: string, _d?: string, _u?: string, ttl?: number) => {
      if (store.get(k)?.settingValue !== expected) throw conditionalFailure();
      store.set(k, { settingValue: v, ttl });
    },
  );
  userDb.getUserById.mockImplementation(async (id: string) =>
    users.has(id) ? JSON.parse(JSON.stringify(users.get(id))) : null,
  );
  userDb.updateUser.mockImplementation(async (id: string, patch: any) => {
    users.set(id, { ...users.get(id), ...patch });
  });
  whatsapp.isOptedOut.mockResolvedValue(false);
  whatsapp.sendMessage.mockResolvedValue({ messageId: 'wamid.OUT' });

  logSpies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
    jest.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Start a verification for u1 and return its code. */
const begin = async (userId = 'u1') => (await startVerification(userId, ACK)).code;

// ── Codes ──────────────────────────────────────────────────────────────────

describe('startVerification', () => {
  it('issues an 8-character code that avoids look-alike characters', async () => {
    for (let i = 0; i < 200; i++) {
      const { code } = await startVerification('u1', ACK);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('does not repeat itself', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add((await startVerification('u1', ACK)).code);
    expect(seen.size).toBe(100);
  });

  it('keys the stored row on a hash, so the raw code never appears in a settings key', async () => {
    const { code } = await startVerification('u1', ACK);
    expect([...store.keys()].some((k) => k.includes(code))).toBe(false);
    expect(store.has(`whatsapp:verify:${sha(code)}`)).toBe(true);
  });

  it('stores who it is for, when consent was acknowledged, and a 10-minute expiry', async () => {
    const { code, expiresAt } = await startVerification('u1', ACK);
    const row = rowFor(code);
    expect(row).toMatchObject({ userId: 'u1', status: 'pending', acknowledgedAt: ACK });
    expect(Date.parse(row.expiresAt) - clock).toBe(TEN_MIN);
    expect(expiresAt).toBe(row.expiresAt);
    // And a DynamoDB TTL, so an unused code is eventually reaped.
    expect(store.get(`whatsapp:verify:${sha(code)}`)!.ttl).toBe(Math.floor((clock + TEN_MIN) / 1000));
  });

  it('invalidates the previous code when a new one is started', async () => {
    const first = await begin();
    const second = await begin();
    expect(await completeVerification(first, PHONE)).toBe('invalid');
    expect(await completeVerification(second, PHONE)).toBe('verified');
  });
});

describe('parseVerificationMessage', () => {
  it.each([
    ['Verify K7Q2M9XA', 'K7Q2M9XA'],
    ['verify k7q2m9xa', 'k7q2m9xa'],
    ['  Verify K7Q2-M9XA  ', 'K7Q2M9XA'],
    ['Verify K7Q2 M9XA', 'K7Q2M9XA'],
    ['VERIFY: K7Q2M9XA', 'K7Q2M9XA'],
  ])('recognises %j', (text, expected) => {
    expect(parseVerificationMessage(text)).toBe(expected);
  });

  it.each([
    'please verify my account today',
    'verify my number',
    'Verify K7Q2M9X', // one short
    'Verify K7Q2M9XAB', // one long
    'Verify K7Q2M9XA thanks',
    'K7Q2M9XA',
    'hello',
    '',
  ])('does not treat %j as a verification attempt', (text) => {
    // Anything not exactly this shape is ignored, so the channel is never a chat.
    expect(parseVerificationMessage(text)).toBeNull();
  });

  it('tolerates a missing body', () => {
    expect(parseVerificationMessage(undefined as unknown as string)).toBeNull();
  });
});

// ── Completing ─────────────────────────────────────────────────────────────

describe('completeVerification — the happy path', () => {
  it("connects the SENDER's number, recording consent and proof separately", async () => {
    const code = await begin();
    await expect(completeVerification(code, PHONE)).resolves.toBe('verified');

    const wa = users.get('u1').messagingChannels.find((c: any) => c.channel === 'whatsapp');
    expect(wa).toMatchObject({ destination: PHONE, enabled: true });
    expect(wa.optIn.at).toBe(ACK);
    expect(wa.optIn.source).toBe('inbound_verification');
    expect(typeof wa.optIn.verifiedAt).toBe('string');
  });

  it('makes the number resolvable for sending — and only now', async () => {
    const code = await begin();
    expect(await resolveDestination(users.get('u1'), 'whatsapp')).toBeNull();
    await completeVerification(code, PHONE);
    expect(await resolveDestination(users.get('u1'), 'whatsapp')).toBe(PHONE);
  });

  it('normalizes the code: case, spaces and hyphens', async () => {
    const code = await begin();
    const grouped = `${code.slice(0, 4)} - ${code.slice(4)}`.toLowerCase();
    await expect(completeVerification(grouped, PHONE)).resolves.toBe('verified');
  });

  it('stores the sender in canonical E.164, however it was formatted', async () => {
    const code = await begin();
    await completeVerification(code, '+1 (415) 555-0123');
    expect(users.get('u1').messagingChannels[0].destination).toBe(PHONE);
  });

  it('marks the row verified and reports it to the portal', async () => {
    const code = await begin();
    await completeVerification(code, PHONE);
    expect(rowFor(code)).toMatchObject({ status: 'verified', phone: PHONE });
    await expect(getVerificationStatus('u1')).resolves.toEqual({ state: 'verified', phone: PHONE });
  });
});

describe('completeVerification — does not disturb other channels (Greptile P1 invariants)', () => {
  it('does NOT copy a legacy Slack channel into messagingChannels', async () => {
    // Persisting the normalized list would write the user's CURRENT Slack destination in
    // as an explicit entry, and an explicit entry outranks the legacy field — so a later
    // admin re-mapping would be silently ignored. Connecting WhatsApp must not freeze Slack.
    await completeVerification(await begin(), PHONE);
    const saved = users.get('u1').messagingChannels;
    expect(saved.some((c: any) => c.channel === 'slack')).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it('leaves the Slack user still resolvable on Slack, following an admin re-map', async () => {
    await completeVerification(await begin(), PHONE);
    const remapped = { ...users.get('u1'), slackChannels: ['C-remapped-by-admin'] };
    expect(await resolveDestination(remapped, 'slack')).toBe('C-remapped-by-admin');
  });

  it('preserves an explicitly-configured non-WhatsApp entry', async () => {
    users.set('u1', {
      userId: 'u1',
      messagingChannels: [{ channel: 'slack', destination: 'C-explicit', enabled: true }],
    });
    await completeVerification(await begin(), PHONE);
    const saved = users.get('u1').messagingChannels;
    expect(saved.find((c: any) => c.channel === 'slack')?.destination).toBe('C-explicit');
  });

  it('replaces an existing WhatsApp entry rather than adding a second', async () => {
    users.set('u1', {
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550000', enabled: true }],
    });
    await completeVerification(await begin(), PHONE);
    const saved = users.get('u1').messagingChannels;
    expect(saved.filter((c: any) => c.channel === 'whatsapp')).toHaveLength(1);
    expect(saved[0].destination).toBe(PHONE);
  });
});

describe('completeVerification — a code is single-use', () => {
  it('refuses a second sender once the code has been used, leaving the first intact', async () => {
    const code = await begin();
    await completeVerification(code, PHONE);
    await expect(completeVerification(code, OTHER)).resolves.toBe('invalid');
    expect(users.get('u1').messagingChannels[0].destination).toBe(PHONE);
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
  });

  it('treats a redelivery from the same number as already handled, and does nothing again', async () => {
    const code = await begin();
    await completeVerification(code, PHONE);
    await expect(completeVerification(code, PHONE)).resolves.toBe('already_verified');
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of two racing senders win, and the other learns the code is gone', async () => {
    const code = await begin();
    // The other sender claims the row between our read and our compare-and-swap.
    settingsService.setSettingIfValueMatches.mockImplementationOnce(async (k: string) => {
      const row = JSON.parse(store.get(k)!.settingValue);
      store.set(k, { settingValue: JSON.stringify({ ...row, status: 'claimed', phone: OTHER }) });
      throw conditionalFailure();
    });
    await expect(completeVerification(code, PHONE)).resolves.toBe('invalid');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('treats a lost race against the SAME number as a duplicate delivery, not an error', async () => {
    const code = await begin();
    settingsService.setSettingIfValueMatches.mockImplementationOnce(async (k: string) => {
      const row = JSON.parse(store.get(k)!.settingValue);
      store.set(k, { settingValue: JSON.stringify({ ...row, status: 'claimed', phone: PHONE }) });
      throw conditionalFailure();
    });
    // No "invalid code" reply for a person whose verification is in fact succeeding.
    await expect(completeVerification(code, PHONE)).resolves.toBe('already_verified');
  });

  it('rethrows a compare-and-swap failure that is not a lost race', async () => {
    const code = await begin();
    settingsService.setSettingIfValueMatches.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(completeVerification(code, PHONE)).rejects.toThrow('dynamo down');
  });
});

describe('completeVerification — a crash mid-way is retryable, not lost', () => {
  it('resumes a claimed verification when the channel write failed the first time', async () => {
    const code = await begin();
    userDb.updateUser.mockRejectedValueOnce(new Error('dynamo down'));

    // Meta retries a webhook that returned 500 — the first attempt throws...
    await expect(completeVerification(code, PHONE)).rejects.toThrow('dynamo down');
    expect(rowFor(code)).toMatchObject({ status: 'claimed', phone: PHONE });
    expect(users.get('u1').messagingChannels).toBeUndefined();

    // ...and the retry finishes the job instead of finding a burned code.
    await expect(completeVerification(code, PHONE)).resolves.toBe('verified');
    expect(users.get('u1').messagingChannels[0].destination).toBe(PHONE);
    expect(rowFor(code).status).toBe('verified');
  });

  it('will not let a different number resume someone else’s claim', async () => {
    const code = await begin();
    userDb.updateUser.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(completeVerification(code, PHONE)).rejects.toThrow();
    await expect(completeVerification(code, OTHER)).resolves.toBe('invalid');
    expect(users.get('u1').messagingChannels).toBeUndefined();
  });

  it('propagates a storage failure so the webhook can answer 500', async () => {
    settingsService.getSetting.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(completeVerification('K7Q2M9XA', PHONE)).rejects.toThrow('dynamo down');
  });

  it('reports invalid, without writing, when the user has since been deleted', async () => {
    const code = await begin();
    users.delete('u1');
    await expect(completeVerification(code, PHONE)).resolves.toBe('invalid');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});

describe('completeVerification — bad codes', () => {
  it('rejects a code nobody issued, without touching any user', async () => {
    await begin();
    await expect(completeVerification('ZZZZZZZZ', PHONE)).resolves.toBe('invalid');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('rejects a code containing characters outside the alphabet', async () => {
    await expect(completeVerification('K7Q2M9X0', PHONE)).resolves.toBe('invalid'); // 0
    await expect(completeVerification('short', PHONE)).resolves.toBe('invalid');
  });

  it('rejects an expired code even though its row has not been reaped yet', async () => {
    // DynamoDB TTL deletion is asynchronous and promises no promptness, so the row is
    // still there — the stored timestamp must decide.
    const code = await begin();
    clock += TEN_MIN + 1;
    expect(store.has(`whatsapp:verify:${sha(code)}`)).toBe(true);
    await expect(completeVerification(code, PHONE)).resolves.toBe('invalid');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('still accepts a code right up to its expiry', async () => {
    const code = await begin();
    clock += TEN_MIN - 1;
    await expect(completeVerification(code, PHONE)).resolves.toBe('verified');
  });

  it('rejects a sender that is not a valid phone number', async () => {
    const code = await begin();
    await expect(completeVerification(code, 'not-a-number')).resolves.toBe('invalid');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('does not tell a user who is not the code holder anything about that user', async () => {
    const codeU1 = await begin('u1');
    users.set('u2', { userId: 'u2' });
    await completeVerification(codeU1, PHONE);
    expect(users.get('u2').messagingChannels).toBeUndefined();
  });
});

describe('completeVerification — throttling guesses', () => {
  const guess = (phone: string) => completeVerification('ZZZZZZZZ', phone);

  it('locks a sender out after five failures, even for a correct code', async () => {
    const code = await begin();
    for (let i = 0; i < 5; i++) await expect(guess(PHONE)).resolves.toBe('invalid');
    await expect(completeVerification(code, PHONE)).resolves.toBe('rate_limited');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('does not lock out a different sender', async () => {
    const code = await begin();
    for (let i = 0; i < 5; i++) await guess(PHONE);
    await expect(completeVerification(code, OTHER)).resolves.toBe('verified');
  });

  it('throttles before looking the code up, so a locked-out sender learns nothing', async () => {
    for (let i = 0; i < 5; i++) await guess(PHONE);
    settingsService.getSetting.mockClear();
    await completeVerification('ZZZZZZZZ', PHONE);
    // Only the counter was read — never a code row.
    expect(settingsService.getSetting.mock.calls.map((c: any[]) => c[0])).toEqual([
      `whatsapp:verify-fail:${PHONE}`,
    ]);
  });

  it('forgets failures after the window, via a TTL on the counter', async () => {
    await guess(PHONE);
    const row = store.get(`whatsapp:verify-fail:${PHONE}`)!;
    expect(row.ttl).toBe(Math.floor((clock + 60 * 60 * 1000) / 1000));
  });
});

describe('completeVerification — a STOPped number', () => {
  it('is not connected by messaging us, and the portal is told why', async () => {
    const code = await begin();
    whatsapp.isOptedOut.mockResolvedValue(true);

    await expect(completeVerification(code, PHONE)).resolves.toBe('opted_out');
    expect(userDb.updateUser).not.toHaveBeenCalled();
    await expect(getVerificationStatus('u1')).resolves.toMatchObject({ state: 'opted_out' });
  });

  it('can be connected with the same code once it has sent START', async () => {
    const code = await begin();
    whatsapp.isOptedOut.mockResolvedValue(true);
    await completeVerification(code, PHONE);

    whatsapp.isOptedOut.mockResolvedValue(false); // the webhook cleared the STOP row
    await expect(completeVerification(code, PHONE)).resolves.toBe('verified');
    expect(users.get('u1').messagingChannels[0].destination).toBe(PHONE);
  });

  it('does not count as a failed guess', async () => {
    const code = await begin();
    whatsapp.isOptedOut.mockResolvedValue(true);
    for (let i = 0; i < 6; i++) await completeVerification(code, PHONE);
    expect(store.has(`whatsapp:verify-fail:${PHONE}`)).toBe(false);
  });
});

// ── Status ─────────────────────────────────────────────────────────────────

describe('completeVerification — the phone -> user index', () => {
  it('writes the index so an inbound tap from this number resolves to its owner', async () => {
    const code = await begin();
    await completeVerification(code, PHONE);
    expect(whatsapp.bindPhoneToUser).toHaveBeenCalledWith(PHONE, 'u1');
  });

  it('clears the previous number when a user re-verifies with a different one', async () => {
    // Otherwise the old number keeps resolving to this account and could answer
    // approvals for a number the user no longer holds.
    users.set('u1', {
      userId: 'u1',
      messagingChannels: [
        {
          channel: 'whatsapp',
          destination: OTHER,
          enabled: true,
          optIn: { at: ACK, source: 'inbound_verification', verifiedAt: ACK },
        },
      ],
    });
    const code = await begin();
    await completeVerification(code, PHONE);

    expect(whatsapp.unbindPhone).toHaveBeenCalledWith(OTHER);
    expect(whatsapp.bindPhoneToUser).toHaveBeenCalledWith(PHONE, 'u1');
  });

  it('does not clear the index when the same number re-verifies', async () => {
    users.set('u1', {
      userId: 'u1',
      messagingChannels: [
        {
          channel: 'whatsapp',
          destination: PHONE,
          enabled: true,
          optIn: { at: ACK, source: 'inbound_verification', verifiedAt: ACK },
        },
      ],
    });
    const code = await begin();
    await completeVerification(code, PHONE);
    expect(whatsapp.unbindPhone).not.toHaveBeenCalled();
  });

  it('still verifies when the index write fails', async () => {
    // The index is a cache. Losing it degrades inbound actions; it must not fail a
    // verification the customer already completed.
    whatsapp.bindPhoneToUser.mockRejectedValueOnce(new Error('dynamo down'));
    const code = await begin();
    await expect(completeVerification(code, PHONE)).resolves.toBe('verified');
  });
});

describe('getVerificationStatus', () => {
  it('is none for a user who never started', async () => {
    await expect(getVerificationStatus('u1')).resolves.toEqual({ state: 'none' });
  });

  it('is pending, with its expiry, after start', async () => {
    const { expiresAt } = await startVerification('u1', ACK);
    await expect(getVerificationStatus('u1')).resolves.toEqual({ state: 'pending', expiresAt });
  });

  it('is expired once the code’s time is up, even before the row is reaped', async () => {
    await begin();
    clock += TEN_MIN + 1;
    await expect(getVerificationStatus('u1')).resolves.toEqual({ state: 'expired' });
  });

  it('shows a claimed, mid-flight verification as still pending', async () => {
    const code = await begin();
    userDb.updateUser.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(completeVerification(code, PHONE)).rejects.toThrow();
    await expect(getVerificationStatus('u1')).resolves.toMatchObject({ state: 'pending' });
  });

  it('never reveals another user’s verification', async () => {
    const code = await begin('u1');
    await completeVerification(code, PHONE);
    await expect(getVerificationStatus('u2')).resolves.toEqual({ state: 'none' });
  });

  it('does not hand a user a row that belongs to someone else', async () => {
    const code = await begin('u1');
    // A pointer that names u1's code but sits under u2 must not surface it.
    store.set('whatsapp:verify-user:u2', { settingValue: sha(code) });
    await expect(getVerificationStatus('u2')).resolves.toEqual({ state: 'expired' });
  });

  it('keeps reporting verified for a while after completion', async () => {
    const code = await begin();
    await completeVerification(code, PHONE);
    clock += TEN_MIN - 1;
    await expect(getVerificationStatus('u1')).resolves.toEqual({ state: 'verified', phone: PHONE });
  });
});

// ── Inbound entry point ────────────────────────────────────────────────────

describe('handleVerificationMessage', () => {
  it('ignores an ordinary message entirely — no lookup, no reply', async () => {
    await expect(handleVerificationMessage('hi, is anyone there?', PHONE)).resolves.toBe(false);
    expect(settingsService.getSetting).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('confirms a successful verification, naming the business and how to opt out', async () => {
    const code = await begin();
    await expect(handleVerificationMessage(`Verify ${code}`, PHONE)).resolves.toBe(true);
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    const sent = whatsapp.sendMessage.mock.calls[0][0];
    expect(sent.destination).toBe(PHONE);
    expect(sent.text).toContain('AgentWeb');
    expect(sent.text).toContain('STOP');
  });

  it('tells the sender a wrong code is not valid, and points them to a fresh one', async () => {
    await begin();
    await handleVerificationMessage('Verify ZZZZZZZZ', PHONE);
    expect(whatsapp.sendMessage.mock.calls[0][0].text).toMatch(/isn't valid or has expired/);
  });

  it('stays silent for a redelivery, which has already been answered', async () => {
    const code = await begin();
    await completeVerification(code, PHONE);
    await handleVerificationMessage(`Verify ${code}`, PHONE);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('stays silent to a STOPped number, which cannot be messaged anyway', async () => {
    const code = await begin();
    whatsapp.isOptedOut.mockResolvedValue(true);
    await handleVerificationMessage(`Verify ${code}`, PHONE);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('stays silent to a throttled sender, so a locked-out guesser learns nothing', async () => {
    for (let i = 0; i < 5; i++) await completeVerification('ZZZZZZZZ', PHONE);
    whatsapp.sendMessage.mockClear();
    await handleVerificationMessage('Verify ZZZZZZZZ', PHONE);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('commits the connection BEFORE attempting the reply', async () => {
    const code = await begin();
    await handleVerificationMessage(`Verify ${code}`, PHONE);
    expect(Math.min(...userDb.updateUser.mock.invocationCallOrder)).toBeLessThan(
      whatsapp.sendMessage.mock.invocationCallOrder[0],
    );
  });

  it('does not throw when the confirmation cannot be sent — the number is connected regardless', async () => {
    // A Meta hiccup after a successful verification must not make the webhook 500 and
    // have Meta retry a delivery that already did its job.
    const code = await begin();
    whatsapp.sendMessage.mockRejectedValue(new Error('Meta is down'));
    await expect(handleVerificationMessage(`Verify ${code}`, PHONE)).resolves.toBe(true);
    expect(users.get('u1').messagingChannels[0].destination).toBe(PHONE);
  });

  it('still propagates a storage failure, so Meta retries the delivery', async () => {
    settingsService.getSetting.mockRejectedValue(new Error('dynamo down'));
    await expect(handleVerificationMessage('Verify K7Q2M9XA', PHONE)).rejects.toThrow('dynamo down');
  });

  it('never puts the raw phone number in the reply-failure log', async () => {
    // beforeEach already spies on console.warn (logSpies[1]) — reuse it rather than
    // layering a second spy on top, which would restore to the wrong thing on cleanup.
    const code = await begin();
    whatsapp.sendMessage.mockRejectedValueOnce(new Error('Meta is down'));

    await handleVerificationMessage(`Verify ${code}`, PHONE);

    const logged = logSpies[1].mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('14155550123');
  });
});

// ── Hygiene ────────────────────────────────────────────────────────────────

describe('the code is a credential', () => {
  it('never reaches a log, on success, on failure or when the reply fails', async () => {
    const code = await begin();
    whatsapp.sendMessage.mockRejectedValueOnce(new Error('Meta is down'));
    await handleVerificationMessage(`Verify ${code}`, PHONE); // success + failed reply
    await handleVerificationMessage(`Verify ${code}`, OTHER); // already used
    await handleVerificationMessage(`Verify ${code}`, '+14155550001'); // and again

    const logged = logSpies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map(String).join(' '))
      .join('\n');
    expect(logged).not.toContain(code);
  });
});
