/**
 * ENG-1197 — persisted Unipile session health and the edge-triggered owner alert.
 *
 * The cases that matter most here are the ones that must NOT notify: an
 * indeterminate probe, a losing racer, and a level that is already recorded. A
 * disconnect is observed 288 times a day per instance, so anything that notifies on
 * the level rather than the edge turns one outage into a mail flood.
 */

import {
  recordUnipileAccountHealth,
  clearDisconnectFlag,
  getUnipileHealth,
  DISCONNECT_REMINDER_MS,
  VERIFY_STAMP_INTERVAL_MS,
} from '../services/linkedInConnectionHealth';

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  updateAccountConfig: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendLinkedInAccountDisconnectedEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

const { getAccountsByUserId, updateAccountConfig } = require('../services/connectedAccountsDb');
const { emailService } = require('../services/emailService');
const { sendAgentModeOncallAlert } = require('../utils/agentModeAlerts');
const { userDb } = require('../services/db');

const ACCOUNT_ID = 'tMgX8uZJTZWTG_mFY1aI2A';
const OWNER = 'owner-user-id';
const NOW = Date.parse('2026-08-17T12:00:00.000Z');

/** Seed the stored account with a given Unipile config. */
function givenAccount(config: Record<string, any>) {
  getAccountsByUserId.mockResolvedValue([
    {
      platform: 'unipile',
      account_id: ACCOUNT_ID,
      account_name: 'Jennifer Sun',
      config: { unipile_account_id: ACCOUNT_ID, ...config },
    },
  ]);
}

/**
 * Run the mutation function the code passed to updateAccountConfig against a given
 * "fresh read", which is how a CAS retry (or a lost race) is simulated.
 */
function applyMutation(freshConfig: Record<string, any>) {
  const mutation = updateAccountConfig.mock.calls[0][3];
  return typeof mutation === 'function' ? mutation(freshConfig) : { updates: mutation };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';
  updateAccountConfig.mockResolvedValue(undefined);
  userDb.getUserById.mockResolvedValue({ email: 'jennifer.sun@tfaconnect.com' });
});

afterEach(() => {
  delete process.env.LINKEDIN_DISCONNECT_NOTIFY;
});

describe('recordUnipileAccountHealth — signals that must not flag an account', () => {
  it('ignores an indeterminate probe entirely', async () => {
    givenAccount({});

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'unknown',
      now: NOW,
    });

    // A timeout or 5xx proves nothing. Persisting it would suppress a live account
    // until someone noticed, which is strictly worse than the late 401 it replaces.
    expect(outcome).toBe('no-op');
    expect(updateAccountConfig).not.toHaveBeenCalled();
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });

  it('ignores an account with no owner (site-wide/shared)', async () => {
    const outcome = await recordUnipileAccountHealth({
      accountId: 'mLJm4hlsQ2eVsqqA6mlTVA',
      ownerUserId: undefined,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(getAccountsByUserId).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('ignores an account id the owner does not actually hold', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'meta', account_id: 'act_123', config: {} },
    ]);

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(updateAccountConfig).not.toHaveBeenCalled();
  });

  it('does not throw or notify when the store read fails', async () => {
    getAccountsByUserId.mockRejectedValue(new Error('dynamo unavailable'));

    await expect(
      recordUnipileAccountHealth({
        accountId: ACCOUNT_ID,
        ownerUserId: OWNER,
        state: 'disconnected',
        now: NOW,
      }),
    ).resolves.toBe('no-op');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });
});

describe('recordUnipileAccountHealth — the disconnect edge', () => {
  it('flags the account and notifies exactly once on the transition', async () => {
    givenAccount({});

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('marked-disconnected');
    const { updates } = applyMutation({});
    expect(updates).toMatchObject({
      needs_reconnect: true,
      disconnected_at: '2026-08-17T12:00:00.000Z',
      disconnect_notified_at: '2026-08-17T12:00:00.000Z',
    });
    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledWith(
      ['jennifer.sun@tfaconnect.com'],
      expect.objectContaining({ isReminder: false, accountName: 'Jennifer Sun' }),
    );
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when a concurrent instance already won the transition', async () => {
    // Both prod instances run the cron, so both observe the same disconnect in the
    // same window. The loser must re-read, see the flag set, and stay quiet.
    givenAccount({});
    updateAccountConfig.mockImplementation(async (_u: string, _p: string, _a: string, mutation: any) => {
      // Simulate the CAS retry re-reading a config the winner already updated.
      mutation({ needs_reconnect: true, disconnected_at: '2026-08-17T11:59:00.000Z' });
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('preserves the original disconnected_at when the flag is re-applied', async () => {
    givenAccount({});

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    const { updates } = applyMutation({ disconnected_at: '2026-08-13T23:44:00.000Z' });
    expect(updates.disconnected_at).toBe('2026-08-13T23:44:00.000Z');
  });

  it('stays silent on every later observation of the same outage', async () => {
    givenAccount({ needs_reconnect: true, disconnected_at: '2026-08-17T11:00:00.000Z',
      disconnect_notified_at: '2026-08-17T11:00:00.000Z' });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(updateAccountConfig).not.toHaveBeenCalled();
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });
});

describe('recordUnipileAccountHealth — owner notification kill-switch', () => {
  it('records the flag but suppresses the owner email when disabled', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false';
    givenAccount({});

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('marked-disconnected');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
    // Oncall is deliberately not gated — an unnoticed outage is the failure mode
    // that let one of these run for 38 days.
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('does not stamp disconnect_notified_at while suppressed', async () => {
    // Otherwise turning the flag on later would find a "recent notification" that
    // never happened, and the owner would hear nothing for a full reminder window.
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false';
    givenAccount({});

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    const { updates } = applyMutation({});
    expect(updates).not.toHaveProperty('disconnect_notified_at');
    expect(updates.needs_reconnect).toBe(true);
  });
});

describe('recordUnipileAccountHealth — reminders', () => {
  it('re-notifies once the reminder window has elapsed', async () => {
    const disconnectedAt = new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString();
    givenAccount({
      needs_reconnect: true,
      disconnected_at: disconnectedAt,
      disconnect_notified_at: disconnectedAt,
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('reminded');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledWith(
      ['jennifer.sun@tfaconnect.com'],
      expect.objectContaining({ isReminder: true, daysDisconnected: 9 }),
    );
  });

  it('does not remind before the window elapses', async () => {
    const justUnder = new Date(NOW - (DISCONNECT_REMINDER_MS - 60_000)).toISOString();
    givenAccount({
      needs_reconnect: true,
      disconnected_at: justUnder,
      disconnect_notified_at: justUnder,
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });

  it('sends one reminder, not two, when both instances are due at once', async () => {
    const old = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    givenAccount({ needs_reconnect: true, disconnected_at: old, disconnect_notified_at: old });
    updateAccountConfig.mockImplementation(async (_u: string, _p: string, _a: string, mutation: any) => {
      // The other instance already stamped it moments ago.
      mutation({ disconnect_notified_at: new Date(NOW - 1000).toISOString() });
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });
});

describe('recordUnipileAccountHealth — recovery', () => {
  it('clears every disconnect field when the session comes back', async () => {
    givenAccount({
      needs_reconnect: true,
      disconnected_at: '2026-08-13T23:44:00.000Z',
      disconnect_notified_at: '2026-08-13T23:44:00.000Z',
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'connected',
      now: NOW,
    });

    expect(outcome).toBe('cleared');
    const call = updateAccountConfig.mock.calls[0][3]({});
    // Unset rather than false: "recovered" and "never disconnected" must be
    // indistinguishable to every downstream reader.
    expect(call.unset).toEqual(
      expect.arrayContaining(['needs_reconnect', 'disconnected_at', 'disconnect_notified_at']),
    );
    expect(call.updates.last_verified_at).toBe('2026-08-17T12:00:00.000Z');
  });

  it('skips the write for a healthy account already verified recently', async () => {
    // Otherwise a healthy account costs a DynamoDB write on all 288 daily cycles
    // just to move a timestamp nobody reads that precisely.
    givenAccount({ last_verified_at: new Date(NOW - 60_000).toISOString() });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'connected',
      now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(updateAccountConfig).not.toHaveBeenCalled();
  });

  it('refreshes the stamp once it goes stale', async () => {
    givenAccount({
      last_verified_at: new Date(NOW - VERIFY_STAMP_INTERVAL_MS - 1000).toISOString(),
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'connected',
      now: NOW,
    });

    expect(outcome).toBe('verified');
    expect(updateAccountConfig).toHaveBeenCalledTimes(1);
  });
});

describe('clearDisconnectFlag', () => {
  it('clears a flagged account on reconnect', async () => {
    givenAccount({ needs_reconnect: true, disconnected_at: '2026-08-13T23:44:00.000Z' });

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(updateAccountConfig).toHaveBeenCalledTimes(1);
    const call = updateAccountConfig.mock.calls[0][3]({});
    expect(call.unset).toContain('needs_reconnect');
  });

  it('writes nothing when the account was never flagged', async () => {
    givenAccount({});

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(updateAccountConfig).not.toHaveBeenCalled();
  });

  it('swallows a write failure rather than breaking the reconnect callback', async () => {
    givenAccount({ needs_reconnect: true });
    updateAccountConfig.mockRejectedValue(new Error('ConnectedAccountChanged'));

    await expect(clearDisconnectFlag(OWNER, ACCOUNT_ID)).resolves.toBeUndefined();
  });
});

describe('getUnipileHealth', () => {
  it('resolves an account addressed by its config.unipile_account_id', async () => {
    // The sync cron derives its id list from either field, so lookup must accept both.
    getAccountsByUserId.mockResolvedValue([
      {
        platform: 'unipile',
        account_id: 'legacy-row-id',
        account_name: 'Jennifer Sun',
        config: { unipile_account_id: ACCOUNT_ID, needs_reconnect: true },
      },
    ]);

    await expect(getUnipileHealth(ACCOUNT_ID, OWNER)).resolves.toMatchObject({
      needs_reconnect: true,
    });
  });

  it('returns null instead of throwing when the store is unavailable', async () => {
    getAccountsByUserId.mockRejectedValue(new Error('dynamo unavailable'));

    await expect(getUnipileHealth(ACCOUNT_ID, OWNER)).resolves.toBeNull();
  });
});
