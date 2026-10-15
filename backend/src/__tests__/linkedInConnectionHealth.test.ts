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
  SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS,
  __resetSiteWideUnknownTrackingForTests,
} from '../services/linkedInConnectionHealth';
import { PROMPT_REVISIONS_BUDGET_BYTES, estimateDynamoItemBytes } from '../utils/dynamoItemBudget';

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([]),
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
  scheduleDb: { getSchedulesByUserId: jest.fn().mockResolvedValue([]), updateSchedule: jest.fn() },
}));

const {
  getAccountsByUserId,
  getAccountsByUserIdIncludingOrgShared,
  updateAccountConfig,
} = require('../services/connectedAccountsDb');
const { emailService } = require('../services/emailService');
const { sendAgentModeOncallAlert } = require('../utils/agentModeAlerts');
const { userDb, scheduleDb } = require('../services/db');

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
  delete process.env.LINKEDIN_DISCONNECT_NOTIFY; // default is ON
  getAccountsByUserIdIncludingOrgShared.mockResolvedValue([]);
  updateAccountConfig.mockResolvedValue(undefined);
  userDb.getUserById.mockResolvedValue({ email: 'jennifer.sun@tfaconnect.com' });
  scheduleDb.getSchedulesByUserId.mockResolvedValue([]);
  __resetSiteWideUnknownTrackingForTests();
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

  it('persists nothing for an account with no owner (site-wide/shared)', async () => {
    const outcome = await recordUnipileAccountHealth({
      accountId: 'mLJm4hlsQ2eVsqqA6mlTVA',
      ownerUserId: undefined,
      state: 'disconnected',
      now: NOW,
    });

    // No user record to write to and nobody whose inbox this belongs in.
    expect(outcome).toBe('no-op');
    expect(getAccountsByUserId).not.toHaveBeenCalled();
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });

  it('still pages oncall for an ownerless account — nobody to email is not nobody to tell', async () => {
    // These are the widest-blast-radius accounts: discovery for many customers runs
    // through them. Returning before the alert meant one could die and emit no signal
    // at all — no flag, no page, no gate — which is the same blind spot this module
    // exists to close.
    await recordUnipileAccountHealth({
      accountId: 'mLJm4hlsQ2eVsqqA6mlTVA',
      ownerUserId: undefined,
      state: 'disconnected',
      now: NOW,
    });

    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    expect(sendAgentModeOncallAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'linkedin-disconnected-ownerless:mLJm4hlsQ2eVsqqA6mlTVA',
      }),
    );
  });

  it('does not page oncall for an ownerless account on a merely indeterminate probe', async () => {
    await recordUnipileAccountHealth({
      accountId: 'mLJm4hlsQ2eVsqqA6mlTVA',
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW,
    });

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

describe('recordUnipileAccountHealth — sustained-unknown alert for ownerless accounts (ENG-2182)', () => {
  const SITE_WIDE_ID = 'mLJm4hlsQ2eVsqqA6mlTVA';

  it('does not page oncall the moment an ownerless account first goes unknown', async () => {
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW,
    });

    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('still does not page oncall just before the sustained-unknown threshold elapses', async () => {
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID, ownerUserId: undefined, state: 'unknown', now: NOW,
    });
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW + SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS - 1,
    });

    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('pages oncall once an ownerless account has stayed unknown past the threshold (reproduces ENG-2182: 3+ days silent)', async () => {
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID, ownerUserId: undefined, state: 'unknown', now: NOW,
    });
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW + SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS,
    });

    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    expect(sendAgentModeOncallAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: `linkedin-sitewide-unknown:${SITE_WIDE_ID}`,
        context: expect.objectContaining({ accountId: SITE_WIDE_ID, state: 'unknown' }),
      }),
    );
  });

  it('measures sustained-unknown from the FIRST unknown reading, not the most recent one', async () => {
    // Three cron cycles into the outage, still under threshold...
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID, ownerUserId: undefined, state: 'unknown', now: NOW,
    });
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID, ownerUserId: undefined, state: 'unknown', now: NOW + 10 * 60 * 1000,
    });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();

    // ...then crosses the threshold measured from the very first observation, not this call's `now`.
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW + SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS + 1,
    });
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('resets the clock once the account is confirmed connected again', async () => {
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID, ownerUserId: undefined, state: 'unknown', now: NOW,
    });
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'connected',
      now: NOW + SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS - 1000,
    });
    // Unknown again right after recovery — must not inherit the pre-recovery clock.
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW + SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS + 1000,
    });

    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('does not let a proven disconnect and a later unknown reading share one clock', async () => {
    // A proven disconnect fires its own immediate alert and must not seed the
    // separate sustained-unknown timer.
    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID, ownerUserId: undefined, state: 'disconnected', now: NOW,
    });
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    (sendAgentModeOncallAlert as jest.Mock).mockClear();

    await recordUnipileAccountHealth({
      accountId: SITE_WIDE_ID,
      ownerUserId: undefined,
      state: 'unknown',
      now: NOW + SITE_WIDE_UNKNOWN_ALERT_THRESHOLD_MS,
    });

    // Freshly starts its own clock from this first 'unknown' observation — not yet due.
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
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
    });
    // Never stamped on the transition: no owner email goes out here, and the stamp
    // means "last time we emailed the owner".
    expect(updates).not.toHaveProperty('disconnect_notified_at');
    // Oncall is immediate; the customer's copy waits for confirmation so a
    // transient 401 cannot produce an un-sendable false alarm.
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
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
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false'; // explicit kill switch
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
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false'; // explicit kill switch
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
    // ENG-2363: the reminder carries the same stable per-account Alert Class as the first
    // alert, so intake folds it onto the account's open canonical instead of filing anew.
    expect(sendAgentModeOncallAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ 'Alert Class': `unipile-disconnected:${ACCOUNT_ID}`, 'Alert Legacy Key': `accountId: ${ACCOUNT_ID}` }),
        dedupeKey: `unipile_disconnected:${ACCOUNT_ID}`,
        dedupeWindowMs: 12 * 60 * 60 * 1000,
      }),
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

  it('writes nothing when the account is no longer on the user record', async () => {
    // A reconnect callback can race a disconnect that removed the row entirely.
    getAccountsByUserId.mockResolvedValue([]);

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(updateAccountConfig).not.toHaveBeenCalled();
  });

  it('swallows a write failure rather than breaking the reconnect callback', async () => {
    givenAccount({ needs_reconnect: true });
    updateAccountConfig.mockRejectedValue(new Error('ConnectedAccountChanged'));

    await expect(clearDisconnectFlag(OWNER, ACCOUNT_ID)).resolves.toBeUndefined();
  });

  it('repoints a stale account_id inside a schedule prompt on reconnect (ENG-1366)', async () => {
    // ACCOUNT_ID is the account reconnecting; OLD_ID is a previous, now-dead
    // account still lingering on the user record with a schedule that
    // hardcodes it — the exact shape found on Jennifer Sun's real schedule.
    const OLD_ID = 'tMgX8uZJTZWTG_mFY1aI2A_stale';
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'Jennifer Sun', config: { unipile_account_id: ACCOUNT_ID } },
      { platform: 'unipile', account_id: OLD_ID, account_name: 'Jennifer Sun (old)', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'sched-1', status: 'active', startingMessage: `Use LinkedIn account_id ${OLD_ID} for all actions.` },
    ]);

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(scheduleDb.updateSchedule).toHaveBeenCalledWith(
      'sched-1',
      expect.objectContaining({ startingMessage: `Use LinkedIn account_id ${ACCOUNT_ID} for all actions.` }),
      expect.anything(),
    );
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

describe('reminder cadence is independent of the owner-email flag', () => {
  it('still reminds oncall when customer email is suppressed', async () => {
    // Gating the whole reminder branch on the flag meant that at its production
    // default a permanently-dead account produced ONE alert ever and then silence —
    // the exact 38-day blind spot this exists to close.
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false'; // explicit kill switch
    const old = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    givenAccount({ needs_reconnect: true, disconnected_at: old, disconnect_notified_at: old });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('reminded');
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });

  it('does NOT stamp disconnect_notified_at while the owner email is suppressed', async () => {
    // The stamp means "last time we emailed the OWNER". Writing it when no email
    // went out costs the customer a full reminder window: the stamp lands seconds
    // after the disconnect, so whoever later enables the flag finds the reminder
    // "not due" and the customer hears nothing for a week.
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false'; // explicit kill switch
    givenAccount({ needs_reconnect: true, disconnected_at: '2026-08-13T23:44:00.000Z' });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('reminded');
    expect(updateAccountConfig).not.toHaveBeenCalled();
  });

  it('reaches the customer on the first cycle after the flag is enabled', async () => {
    // The end-to-end consequence: an account that went dead while suppressed must
    // be emailed as soon as the flag flips, not a window later.
    delete process.env.LINKEDIN_DISCONNECT_NOTIFY; // default ON
    givenAccount({ needs_reconnect: true, disconnected_at: '2026-08-13T23:44:00.000Z' });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('reminded');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledTimes(1);
    expect(applyMutation({}).updates.disconnect_notified_at).toBe('2026-08-17T12:00:00.000Z');
  });
});

describe('notification delivery failures', () => {
  it('still records the flag when the owner has no email on file', async () => {
    givenAccount({});
    userDb.getUserById.mockResolvedValue({ email: undefined });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    // The state change is what the schedule gate and the cron read; it must not
    // depend on our being able to reach the owner.
    expect(outcome).toBe('marked-disconnected');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('still emails the owner when the oncall alert fails', async () => {
    givenAccount({
      needs_reconnect: true,
      disconnected_at: new Date(NOW - 30 * 60 * 1000).toISOString(), // past confirmation
    });
    sendAgentModeOncallAlert.mockRejectedValue(new Error('notion down'));

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('reminded');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledTimes(1);
  });

  it('still notifies when the owner lookup itself fails', async () => {
    givenAccount({});
    userDb.getUserById.mockRejectedValue(new Error('dynamo unavailable'));

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID,
      ownerUserId: OWNER,
      state: 'disconnected',
      now: NOW,
    });

    expect(outcome).toBe('marked-disconnected');
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });
});

describe('owner notification default', () => {
  it('emails the owner when the env var is unset', async () => {
    // Default flipped ON (2026-08-17): a disconnect is a total outage of the thing
    // the customer pays for, and one email per disconnect EVENT is not the
    // 2026-06-03 flood shape (one per connection, thousands at once).
    delete process.env.LINKEDIN_DISCONNECT_NOTIFY;
    givenAccount({
      needs_reconnect: true,
      disconnected_at: new Date(NOW - 30 * 60 * 1000).toISOString(), // past confirmation
    });

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledTimes(1);
  });

  it('is still killable with an explicit false', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'false';
    givenAccount({});

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });
});

describe('graceful-failure mitigations', () => {
  const { resumeSchedulesPausedForAccount, DISCONNECT_CONFIRM_MS } =
    require('../services/linkedInConnectionHealth');

  it('does not email the customer on a single blip', async () => {
    // A transient Unipile 401 must never tell a paying customer their account is
    // broken — an email cannot be unsent. The flag and oncall still fire at once.
    givenAccount({});

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(outcome).toBe('marked-disconnected');
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });

  it('emails once the disconnect is confirmed on a later observation', async () => {
    givenAccount({
      needs_reconnect: true,
      disconnected_at: new Date(NOW - DISCONNECT_CONFIRM_MS - 1000).toISOString(),
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(outcome).toBe('reminded');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledTimes(1);
  });

  it('stays silent while still inside the confirmation window', async () => {
    givenAccount({
      needs_reconnect: true,
      disconnected_at: new Date(NOW - 60_000).toISOString(),
    });

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(outcome).toBe('no-op');
    expect(emailService.sendLinkedInAccountDisconnectedEmail).not.toHaveBeenCalled();
  });

  it('resumes only the schedules this gate paused, for this account', async () => {
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', status: 'paused', pausedReason: 'linkedin_disconnected', startingMessage: `use ${ACCOUNT_ID}` },
      { scheduleId: 'b', status: 'paused', pausedReason: undefined, startingMessage: `use ${ACCOUNT_ID}` },      // human-paused
      { scheduleId: 'c', status: 'paused', pausedReason: 'linkedin_disconnected', startingMessage: 'use other-acct' },
      { scheduleId: 'd', status: 'active', pausedReason: 'linkedin_disconnected', startingMessage: `use ${ACCOUNT_ID}` },
    ]);

    const resumed = await resumeSchedulesPausedForAccount(OWNER, ACCOUNT_ID);

    expect(resumed).toBe(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledWith('a', expect.objectContaining({ status: 'active' }));
  });

  it('never breaks the reconnect callback when resuming fails', async () => {
    scheduleDb.getSchedulesByUserId.mockRejectedValue(new Error('dynamo down'));

    await expect(resumeSchedulesPausedForAccount(OWNER, ACCOUNT_ID)).resolves.toBe(0);
  });
});

describe('repointStaleAccountReferences (ENG-1366)', () => {
  const { repointStaleAccountReferences } = require('../services/linkedInConnectionHealth');
  const NEW_ACCOUNT_ID = 'ofGscnIrR5qZYZ00ovNsTQ';

  it('repoints every occurrence of a stale account id in a schedule prompt, leaving the rest of the text untouched', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'Jennifer Sun', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'Jennifer Sun (old)', config: { needs_reconnect: true } },
    ]);
    const originalMessage = `Use ${ACCOUNT_ID} first, then ${ACCOUNT_ID} again, then ${ACCOUNT_ID} once more. Target list X.`;
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: originalMessage },
    ]);

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({
        startingMessage: `Use ${NEW_ACCOUNT_ID} first, then ${NEW_ACCOUNT_ID} again, then ${NEW_ACCOUNT_ID} once more. Target list X.`,
      }),
      expect.anything(),
    );
  });

  it('repoints across multiple stale ids on the same user in one pass', async () => {
    const OLD_ID_2 = 'anotherOldId1234567X';
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
      { platform: 'unipile', account_id: OLD_ID_2, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: `first use ${ACCOUNT_ID}, later use ${OLD_ID_2}` },
    ]);

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ startingMessage: `first use ${NEW_ACCOUNT_ID}, later use ${NEW_ACCOUNT_ID}` }),
      expect.anything(),
    );
  });

  it('snapshots the pre-repoint text into promptRevisions, so an unwanted rewrite is always recoverable (ENG-1366 review)', async () => {
    // A blind substring replace has no understanding of context — if a prompt
    // ever narrated an old account rather than directing live use of it, the
    // rewrite could read strangely. Rather than try to detect that (fragile,
    // and risks silently under-fixing genuine stale references), preserve
    // exactly what a human's own edit already preserves: the prior text, so
    // any surprising rewrite is visible and reversible, not silently lost.
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    const originalMessage = `Use ${ACCOUNT_ID} for all actions.`;
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: originalMessage, promptRevisions: [{ startingMessage: 'even older text', updatedAt: '2026-01-01T00:00:00.000Z' }] },
    ]);

    await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    const [, updates] = scheduleDb.updateSchedule.mock.calls[0];
    expect(updates.promptRevisions).toHaveLength(2);
    expect(updates.promptRevisions[0]).toEqual({ startingMessage: 'even older text', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(updates.promptRevisions[1]).toMatchObject({ startingMessage: originalMessage });
  });

  it('caps promptRevisions at the same limit the customer-facing edit uses, dropping the oldest first', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    const existingRevisions = Array.from({ length: 10 }, (_, i) => ({
      startingMessage: `revision ${i}`,
      updatedAt: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
    }));
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: `use ${ACCOUNT_ID}`, promptRevisions: existingRevisions },
    ]);

    await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    const [, updates] = scheduleDb.updateSchedule.mock.calls[0];
    expect(updates.promptRevisions).toHaveLength(10);
    expect(updates.promptRevisions[0].startingMessage).toBe('revision 1');
    expect(updates.promptRevisions[9]).toMatchObject({ startingMessage: `use ${ACCOUNT_ID}` });
  });

  it('passes an optimistic-concurrency expectation so a write cannot clobber a concurrent edit', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    const originalMessage = `use ${ACCOUNT_ID}`;
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: originalMessage },
    ]);

    await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(scheduleDb.updateSchedule).toHaveBeenCalledWith(
      'a',
      expect.anything(),
      { startingMessage: originalMessage },
    );
  });

  it('treats a lost race on one schedule as a skip, not a failure, and still processes the rest', async () => {
    // Two near-simultaneous reconnects (or a human editing at the same moment)
    // can both read the same stale text before either writes. The loser's
    // conditional write is rejected by DynamoDB rather than silently
    // overwriting — that must not abort repointing this user's OTHER,
    // unrelated schedules.
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: `use ${ACCOUNT_ID}` },
      { scheduleId: 'b', startingMessage: `also use ${ACCOUNT_ID}` },
    ]);
    const conditionalCheckError = Object.assign(new Error('conditional check failed'), {
      code: 'ConditionalCheckFailedException',
    });
    scheduleDb.updateSchedule
      .mockRejectedValueOnce(conditionalCheckError)
      .mockResolvedValueOnce(undefined);

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
  });

  it('still fails open (resolves to 0) on a genuine, non-conditional write error', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: `use ${ACCOUNT_ID}` },
    ]);
    scheduleDb.updateSchedule.mockRejectedValue(new Error('dynamo down'));

    await expect(repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID)).resolves.toBe(0);
  });

  // ENG-1672: a flat count cap alone still let promptRevisions alone approach
  // DynamoDB's item ceiling from a handful of large prompts, the same gap the
  // customer-facing edit path had. Bound by bytes too, and never erase the
  // newest entry (the pre-repoint text this rewrite must stay reversible against)
  // even when it alone exceeds the budget.
  it('keeps the newest revision even when it alone exceeds the byte budget', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    const originalMessage = `use ${ACCOUNT_ID} for all actions. ` + 'p'.repeat(160000); // alone exceeds the 150KB budget
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: originalMessage, promptRevisions: [] },
    ]);
    scheduleDb.updateSchedule.mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    const [, updates] = scheduleDb.updateSchedule.mock.calls[0];
    expect(updates.promptRevisions).toHaveLength(1);
    expect(updates.promptRevisions[0].startingMessage).toBe(originalMessage);
    // No existing history means nothing was literally "dropped" — but this
    // schedule's very first revision already sits over the byte sub-budget,
    // which is exactly the condition this observability exists to flag. Must
    // not stay silent just because there was nothing to trim away.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('kept the newest promptRevisions entry even though it alone exceeds the byte budget — no older entries existed to drop')
    );
  });

  // ENG-1672 (code review follow-up): the combined case the above test doesn't
  // cover — the newest entry is oversized AND older history already exists. The
  // guard still keeps only the newest (same as above), but the log's wording must
  // not claim it "fits the budget" when it still doesn't — the surviving entry is
  // kept anyway specifically because it doesn't fit and there's nothing smaller to
  // fall back to.
  it('logs the fallback wording (not "dropped to fit") when the newest entry alone still exceeds the budget after dropping older history', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    const existingRevisions = [
      { startingMessage: 'small revision one', updatedAt: '2026-01-01T00:00:00.000Z' },
      { startingMessage: 'small revision two', updatedAt: '2026-01-02T00:00:00.000Z' },
    ];
    const originalMessage = `use ${ACCOUNT_ID} for all actions. ` + 'p'.repeat(160000); // alone exceeds the 150KB budget
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: originalMessage, promptRevisions: existingRevisions },
    ]);
    scheduleDb.updateSchedule.mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    const [, updates] = scheduleDb.updateSchedule.mock.calls[0];
    // Both small existing revisions are gone; only the oversized newest survives.
    expect(updates.promptRevisions).toHaveLength(1);
    expect(updates.promptRevisions[0].startingMessage).toBe(originalMessage);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('kept only the newest promptRevisions entry — it alone still exceeds the byte budget after dropping 2 older entries')
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('dropped to fit'));
  });

  // ENG-1672: the ordinary partial-trim case — several old revisions dropped so
  // the total fits the budget, the newest (including the one this repoint just
  // created) survives untouched. The other two ENG-1672 tests above/below only
  // cover the edges (a single oversized entry, and a rejection past this trim);
  // this covers the common in-between case. Sizes below are verified (not
  // guessed) to force exactly 2 of 4 existing revisions dropped, via the same
  // trimListToItemBudget the implementation calls.
  it('drops the oldest revisions to fit the byte budget, leaving the newest (including this repoint) untouched', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    const existingRevisions = Array.from({ length: 4 }, (_, i) => ({
      startingMessage: 'p'.repeat(60000),
      updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    }));
    const originalMessage = `use ${ACCOUNT_ID}`;
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: originalMessage, promptRevisions: existingRevisions },
    ]);
    scheduleDb.updateSchedule.mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    const [, updates] = scheduleDb.updateSchedule.mock.calls[0];
    const revisionBytes = estimateDynamoItemBytes({ promptRevisions: updates.promptRevisions });
    expect(revisionBytes).toBeLessThanOrEqual(PROMPT_REVISIONS_BUDGET_BYTES);
    // Exactly the two oldest existing revisions are dropped; the two newest
    // existing ones AND the just-created repoint snapshot survive, in order —
    // not just "some entries, some budget", but the SPECIFIC right ones.
    expect(updates.promptRevisions).toEqual([
      existingRevisions[2],
      existingRevisions[3],
      expect.objectContaining({ startingMessage: originalMessage }),
    ]);
    // The trim is otherwise invisible (no UI reads promptRevisions) — confirm the
    // one trace it leaves actually fires, with the count this scenario produces.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped 2 of 5 entries to fit'));
  });

  // ENG-1672: an item-size rejection is a property of the ONE schedule that hit
  // it (e.g. its own history is already huge), not a reason to abandon repointing
  // this user's OTHER, unrelated schedules — the old code's bare `throw` aborted
  // the whole loop, silently leaving every schedule after the oversized one still
  // pinned to the dead account.
  it('skips a schedule at the item-size ceiling without aborting repointing this user\'s other schedules', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: `use ${ACCOUNT_ID}` },
      { scheduleId: 'b', startingMessage: `also use ${ACCOUNT_ID}` },
    ]);
    const itemSizeError = Object.assign(new Error('Item size has exceeded the maximum allowed size'), {
      code: 'ValidationException',
    });
    scheduleDb.updateSchedule
      .mockRejectedValueOnce(itemSizeError)
      .mockResolvedValueOnce(undefined);

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(1);
    expect(scheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
    expect(scheduleDb.updateSchedule).toHaveBeenNthCalledWith(
      2,
      'b',
      expect.objectContaining({ startingMessage: `also use ${NEW_ACCOUNT_ID}` }),
      expect.anything(),
    );
  });

  it('is a no-op and writes nothing when no schedule references any stale id', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: 'use a totally unrelated account' },
    ]);

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(0);
    expect(scheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('is a no-op and never queries schedules when the user has no stale accounts at all', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { scheduleId: 'a', startingMessage: `use ${ACCOUNT_ID}` },
    ]);

    const repointed = await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(repointed).toBe(0);
    expect(scheduleDb.getSchedulesByUserId).not.toHaveBeenCalled();
    expect(scheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('scopes the schedule lookup to the reconnecting user only', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockResolvedValue([]);

    await repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID);

    expect(scheduleDb.getSchedulesByUserId).toHaveBeenCalledWith(OWNER);
  });

  it('swallows a store failure and resolves to 0 rather than throwing', async () => {
    getAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: NEW_ACCOUNT_ID, account_name: 'x', config: {} },
      { platform: 'unipile', account_id: ACCOUNT_ID, account_name: 'x', config: { needs_reconnect: true } },
    ]);
    scheduleDb.getSchedulesByUserId.mockRejectedValue(new Error('dynamo down'));

    await expect(repointStaleAccountReferences(OWNER, NEW_ACCOUNT_ID)).resolves.toBe(0);
  });
});

describe('what the customer actually reads (ENG-1197 review round 2)', () => {
  const { DISCONNECT_CONFIRM_MS } = require('../services/linkedInConnectionHealth');

  // The transition branch never emails the customer — it only flags and pages
  // oncall, because a single blip must not reach a paying customer. So the FIRST
  // customer email is sent by the reminder branch, one cron cycle later. Hard-coding
  // isReminder there made that first email arrive as
  // "Still disconnected after 0 days".
  it('does not label the first owner email as a reminder', async () => {
    givenAccount({
      needs_reconnect: true,
      disconnected_at: new Date(NOW - DISCONNECT_CONFIRM_MS - 1000).toISOString(),
      // disconnect_notified_at absent: the owner has never been emailed.
    });

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledWith(
      ['jennifer.sun@tfaconnect.com'],
      expect.objectContaining({ isReminder: false, daysDisconnected: 0 }),
    );
  });

  it('does label a later email as a reminder, with the elapsed days', async () => {
    const disconnectedAt = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    givenAccount({
      needs_reconnect: true,
      disconnected_at: disconnectedAt,
      disconnect_notified_at: disconnectedAt, // emailed once, 8 days ago
    });

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: OWNER, state: 'disconnected', now: NOW,
    });

    expect(emailService.sendLinkedInAccountDisconnectedEmail).toHaveBeenCalledWith(
      ['jennifer.sun@tfaconnect.com'],
      expect.objectContaining({ isReminder: true, daysDisconnected: 8 }),
    );
  });
});

describe('an org-shared account belongs to its owner, not its user', () => {
  const TEAMMATE = 'teammate-user-id';

  // ENG-1198 shipped shared-account fallback, so a teammate can drive an account
  // they do not own. findUnipileAccount used to look only at the caller's OWN
  // accounts, find nothing, and return null — so a disconnect observed through a
  // borrowed account wrote no flag, paged nobody, and left the schedule gate blind.
  function givenSharedAccount(config: Record<string, any>) {
    getAccountsByUserId.mockResolvedValue([]); // the teammate owns nothing
    getAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      {
        platform: 'unipile',
        account_id: ACCOUNT_ID,
        account_name: 'Jennifer Sun',
        userId: OWNER, // the non-persisted owner marker the org-shared getter stamps
        config: { unipile_account_id: ACCOUNT_ID, ...config },
      },
    ]);
  }

  it('flags the OWNER record when a teammate observes the disconnect', async () => {
    givenSharedAccount({});

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: TEAMMATE, state: 'disconnected', now: NOW,
    });

    expect(outcome).toBe('marked-disconnected');
    // The config write must target the owner, or it lands on the wrong user record.
    expect(updateAccountConfig).toHaveBeenCalledWith(OWNER, 'unipile', ACCOUNT_ID, expect.any(Function));
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('emails the owner, not the teammate who happened to hit the dead session', async () => {
    givenSharedAccount({
      needs_reconnect: true,
      disconnected_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    });
    userDb.getUserById.mockResolvedValue({ email: 'jennifer.sun@tfaconnect.com' });

    await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: TEAMMATE, state: 'disconnected', now: NOW,
    });

    expect(userDb.getUserById).toHaveBeenCalledWith(OWNER);
  });

  it('declines rather than guessing when the shared row carries no owner marker', async () => {
    getAccountsByUserId.mockResolvedValue([]);
    getAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: ACCOUNT_ID, config: { unipile_account_id: ACCOUNT_ID } },
    ]);

    const outcome = await recordUnipileAccountHealth({
      accountId: ACCOUNT_ID, ownerUserId: TEAMMATE, state: 'disconnected', now: NOW,
    });

    // Writing to the caller's record would corrupt an unrelated user's account.
    expect(outcome).toBe('no-op');
    expect(updateAccountConfig).not.toHaveBeenCalled();
  });
});

describe('reconnect must resume a schedule the gate paused', () => {
  // The route calls `createAccount` BEFORE `clearDisconnectFlag`, and `createAccount`
  // replaces `config` wholesale — so by the time the flag is read it is already gone.
  // Guarding the resume on that flag meant an auto-paused schedule stayed paused
  // forever, which is the one state a reconnect could not undo on its own and the
  // entire reason the resume exists. The cron could not save it either: it derives
  // `wasDisconnected` from the same wiped flag.
  //
  // It was also non-deterministic — the account read goes through an eventually
  // consistent GSI, so a lagging read sometimes still saw the flag and did resume,
  // which is exactly how this survives a manual test.
  const PAUSED_SCHEDULE = {
    scheduleId: 'sched-1',
    status: 'paused',
    pausedReason: 'linkedin_disconnected',
    startingMessage: `Run outreach with ${ACCOUNT_ID}`,
  };

  it('resumes even when createAccount already wiped the flag', async () => {
    givenAccount({}); // config as it looks AFTER createAccount: no needs_reconnect
    scheduleDb.getSchedulesByUserId.mockResolvedValue([PAUSED_SCHEDULE]);

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(scheduleDb.updateSchedule).toHaveBeenCalledWith(
      'sched-1',
      expect.objectContaining({ status: 'active', pausedReason: null }),
    );
  });

  it('still clears the flag when it IS present', async () => {
    givenAccount({ needs_reconnect: true, disconnected_at: '2026-08-13T23:44:00.000Z' });
    scheduleDb.getSchedulesByUserId.mockResolvedValue([]);

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(updateAccountConfig).toHaveBeenCalledWith(
      OWNER, 'unipile', ACCOUNT_ID, expect.any(Function),
    );
  });

  it('does not touch a schedule a human paused deliberately', async () => {
    givenAccount({});
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { ...PAUSED_SCHEDULE, pausedReason: undefined },
    ]);

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(scheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('does not touch a schedule pinning a different account', async () => {
    givenAccount({});
    scheduleDb.getSchedulesByUserId.mockResolvedValue([
      { ...PAUSED_SCHEDULE, startingMessage: 'Run outreach with someOtherAccountId' },
    ]);

    await clearDisconnectFlag(OWNER, ACCOUNT_ID);

    expect(scheduleDb.updateSchedule).not.toHaveBeenCalled();
  });
});
