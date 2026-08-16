/**
 * ENG-720: hard email bounces must surface as a durable account flag, and
 * active accounts with non-resolving email domains must be detectable by a
 * sweep. Behavioral contract (human-written, from the Linear issue):
 *  1. A hard bounce (5.x.x) on a customer-facing send flags the account as
 *     undeliverable — durable and reachable without anyone's personal inbox.
 *  2. The flag is visible where support/CS acts on the customer (admin list).
 *  3. Detection does not depend on a forwarded mailer-daemon message.
 *  4. A sweep reports currently-active accounts whose email domain fails MX
 *     resolution — report only, no repair.
 *  5. Soft/transient bounces are not treated as hard; one bounce never
 *     silently disables a working account.
 */

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import {
  classifyResendBounce,
  flagUserEmailUndeliverable,
  handleHardBounceRecipients,
  sweepUndeliverableDomains,
} from '../services/emailDeliverabilityService';
import { userDb } from '../services/db';

const mockGetUserByEmail = userDb.getUserByEmail as jest.Mock;
const mockGetAllUsers = userDb.getAllUsers as jest.Mock;
const mockUpdateUser = userDb.updateUser as jest.Mock;

beforeEach(() => jest.clearAllMocks());

// ─── classifyResendBounce — pure classifier ──────────────────────────────────

describe('classifyResendBounce', () => {
  it('classifies a 5.x.x reason as hard', () => {
    expect(
      classifyResendBounce({ reason: 'smtp; 550 5.1.2 Recipient address rejected' })
    ).toBe('hard');
  });

  it('classifies a Permanent subType as hard even without a status code', () => {
    expect(classifyResendBounce({ type: 'Permanent', reason: 'General' })).toBe('hard');
    expect(classifyResendBounce({ subType: 'Permanent' } as any)).toBe('hard');
  });

  it('classifies Transient / 4.x.x as soft (AC5)', () => {
    expect(classifyResendBounce({ type: 'Transient', reason: 'MailboxFull' })).toBe('soft');
    expect(classifyResendBounce({ reason: '451 4.7.1 greylisted, try later' })).toBe('soft');
  });

  it('classifies a missing or unrecognized bounce object as unknown', () => {
    expect(classifyResendBounce(undefined)).toBe('unknown');
    expect(classifyResendBounce({ reason: 'something odd' })).toBe('unknown');
  });
});

// ─── flagUserEmailUndeliverable ──────────────────────────────────────────────

describe('flagUserEmailUndeliverable', () => {
  it('flags a matching active account with a durable reason (AC1/AC3)', async () => {
    mockGetUserByEmail.mockResolvedValue({ userId: 'u1', email: 'kevin@nxdomain.com' });
    mockUpdateUser.mockResolvedValue({});

    const flagged = await flagUserEmailUndeliverable(
      'kevin@nxdomain.com',
      'smtp; 550 5.1.2 bad destination',
      'resend-webhook'
    );

    expect(flagged).toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [userId, updates] = mockUpdateUser.mock.calls[0];
    expect(userId).toBe('u1');
    expect(updates.emailUndeliverable).toBe(true);
    expect(updates.emailUndeliverableReason).toContain('5.1.2');
    expect(updates.emailUndeliverableSource).toBe('resend-webhook');
    expect(typeof updates.emailUndeliverableAt).toBe('string');
  });

  it('does nothing when no account matches the recipient', async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    const flagged = await flagUserEmailUndeliverable('lead@example.com', '550 5.1.1', 'resend-webhook');
    expect(flagged).toBe(false);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('is idempotent — an already-flagged account is not re-written', async () => {
    mockGetUserByEmail.mockResolvedValue({
      userId: 'u1',
      email: 'kevin@nxdomain.com',
      emailUndeliverable: true,
    });
    const flagged = await flagUserEmailUndeliverable('kevin@nxdomain.com', '550 5.1.1', 'resend-webhook');
    expect(flagged).toBe(false);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('never deactivates the account — only flags it (AC5)', async () => {
    mockGetUserByEmail.mockResolvedValue({ userId: 'u1', email: 'kevin@nxdomain.com' });
    mockUpdateUser.mockResolvedValue({});
    await flagUserEmailUndeliverable('kevin@nxdomain.com', '550 5.1.1', 'resend-webhook');
    const [, updates] = mockUpdateUser.mock.calls[0];
    expect(updates.isActive).toBeUndefined();
  });
});

// ─── handleHardBounceRecipients — the webhook wire-in ────────────────────────

describe('handleHardBounceRecipients', () => {
  it('flags only on hard bounces, not soft (AC5)', async () => {
    mockGetUserByEmail.mockResolvedValue({ userId: 'u1', email: 'a@b.com' });
    mockUpdateUser.mockResolvedValue({});

    await handleHardBounceRecipients(['a@b.com'], { type: 'Transient', reason: '451 4.2.2 mailbox full' });
    expect(mockUpdateUser).not.toHaveBeenCalled();

    await handleHardBounceRecipients(['a@b.com'], { reason: '550 5.1.2 no such domain' });
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('survives a lookup error for one recipient, continues to the rest, and reports the failure', async () => {
    mockGetUserByEmail
      .mockRejectedValueOnce(new Error('dynamo blip'))
      .mockResolvedValueOnce({ userId: 'u2', email: 'c@d.com' });
    mockUpdateUser.mockResolvedValue({});

    const result = await handleHardBounceRecipients(
      ['a@b.com', 'c@d.com'],
      { reason: '550 5.1.1 unknown user' }
    );
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(result.failedRecipients).toEqual(['a@b.com']);
  });
});

// ─── sweepUndeliverableDomains — MX sweep (AC4) ──────────────────────────────

describe('sweepUndeliverableDomains', () => {
  const users = [
    { userId: 'u1', email: 'kevin@nxdomain.com', isActive: true },
    { userId: 'u2', email: 'ok@resolves.com', isActive: true },
    { userId: 'u3', email: 'gone@nxdomain.com', isActive: true },
    { userId: 'u4', email: 'inactive@dead.com', isActive: false },
    { userId: 'u5', email: 'flaky@timeout.com', isActive: true },
  ];

  const resolver = jest.fn(async (domain: string) => {
    if (domain === 'resolves.com') return [{ exchange: 'mx.resolves.com', priority: 10 }];
    if (domain === 'nxdomain.com') {
      const err: any = new Error('queryMx ENOTFOUND nxdomain.com');
      err.code = 'ENOTFOUND';
      throw err;
    }
    const err: any = new Error('queryMx ETIMEOUT timeout.com');
    err.code = 'ETIMEOUT';
    throw err;
  });

  it('reports active accounts on non-resolving domains, grouped by domain', async () => {
    mockGetAllUsers.mockResolvedValue(users);
    const report = await sweepUndeliverableDomains({ resolveMx: resolver });

    const bad = report.undeliverable.find((d) => d.domain === 'nxdomain.com');
    expect(bad).toBeDefined();
    expect(bad!.users.map((u) => u.userId).sort()).toEqual(['u1', 'u3']);
    expect(report.undeliverable.some((d) => d.domain === 'resolves.com')).toBe(false);
  });

  it('excludes inactive accounts and does not repeat MX lookups per user', async () => {
    mockGetAllUsers.mockResolvedValue(users);
    const report = await sweepUndeliverableDomains({ resolveMx: resolver });
    expect(report.undeliverable.some((d) => d.domain === 'dead.com')).toBe(false);
    const nxCalls = resolver.mock.calls.filter(([d]) => d === 'nxdomain.com');
    expect(nxCalls.length).toBe(1);
  });

  it('treats transient DNS errors as errors, not undeliverable (AC5)', async () => {
    mockGetAllUsers.mockResolvedValue(users);
    const report = await sweepUndeliverableDomains({ resolveMx: resolver });
    expect(report.undeliverable.some((d) => d.domain === 'timeout.com')).toBe(false);
    expect(report.errors.some((e) => e.domain === 'timeout.com')).toBe(true);
  });

  it('reports the sweep totals so the report is self-describing', async () => {
    mockGetAllUsers.mockResolvedValue(users);
    const report = await sweepUndeliverableDomains({ resolveMx: resolver });
    expect(report.activeUsersChecked).toBe(4);
    expect(report.domainsChecked).toBe(3); // nxdomain.com, resolves.com, timeout.com — dead.com is inactive-only
  });
});
