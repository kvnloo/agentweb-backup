/**
 * ENG-1506 — a delegate token must be revocable.
 *
 * `POST /api/admin/users/:userId/delegate-access` mints a token that lets an
 * admin or contractor act as a customer. Before this, the only bound on one was
 * its 90-day expiry: there was no way to cut off a token that leaked, and the
 * branch that validates it returned before the sessionVersion check, so even the
 * customer changing their password did not end the session.
 *
 * These tests drive the real getUserFromToken with real signed JWTs — only the
 * user lookup is mocked. Asserting against a hand-rolled reimplementation of the
 * comparison would prove nothing about the branch that actually runs.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

import jwt from 'jsonwebtoken';
import { getUserFromToken } from '../middleware/auth';
import { userDb } from '../services/db';

const ADMIN = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true, roles: [] };

function reqWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` } };
}

function delegateToken(claims: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      userId: 'target-1',
      email: 'customer@example.com',
      roles: ['customer'],
      isAdmin: false,
      dte: 0,
      sv: 0,
      delegateAccess: {
        adminUserId: 'admin-1',
        adminEmail: 'admin@example.com',
        targetUserId: 'target-1',
        targetEmail: 'customer@example.com',
      },
      ...claims,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '8h' },
  );
}

/** Target user as stored, with whatever counters the case needs. */
function target(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'target-1',
    email: 'customer@example.com',
    roles: ['customer'],
    isAdmin: false,
    ...overrides,
  };
}

function lookup(targetUser: any) {
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) =>
    id === 'admin-1' ? ADMIN : targetUser,
  );
}

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-eng-1506';
});
beforeEach(() => jest.clearAllMocks());

describe('ENG-1506 — delegate tokens are revocable', () => {
  it('accepts a token whose epoch matches the stored one', async () => {
    lookup(target({ delegateTokenEpoch: 2, sessionVersion: 0 }));
    const result = await getUserFromToken(reqWith(delegateToken({ dte: 2 })));
    expect(result.user?.userId).toBe('target-1');
    expect(result.adminUser?.userId).toBe('admin-1');
  });

  // The kill switch. This is the case that had no answer before.
  it('rejects a token minted before the epoch was bumped', async () => {
    lookup(target({ delegateTokenEpoch: 3 }));
    const result = await getUserFromToken(reqWith(delegateToken({ dte: 2 })));
    expect(result.user).toBeNull();
  });

  // Revoking support access must not log the customer out of their own devices,
  // which is exactly why this is a separate counter from sessionVersion.
  it('leaves the customer\'s own sessions alone when only the delegate epoch moves', async () => {
    lookup(target({ delegateTokenEpoch: 5, sessionVersion: 0 }));
    const ownToken = jwt.sign(
      { userId: 'target-1', email: 'customer@example.com', roles: ['customer'], sv: 0 },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    );
    const result = await getUserFromToken(reqWith(ownToken));
    expect(result.user?.userId).toBe('target-1');
  });

  // This branch used to return before reaching the sessionVersion check, so a
  // delegate token outlived the password change meant to end every session.
  it('rejects a delegate token issued before the customer changed their password', async () => {
    lookup(target({ sessionVersion: 4 }));
    const result = await getUserFromToken(reqWith(delegateToken({ sv: 3 })));
    expect(result.user).toBeNull();
  });

  it('accepts a delegate token minted after that password change', async () => {
    lookup(target({ sessionVersion: 4 }));
    const result = await getUserFromToken(reqWith(delegateToken({ sv: 4 })));
    expect(result.user?.userId).toBe('target-1');
  });

  // getUserById reads an eventually-consistent GSI, so a token can legitimately
  // carry a value the read has not caught up to. `<` tolerates that; `!==` would
  // reject the token the admin just minted.
  it('tolerates a token ahead of a stale read rather than rejecting it', async () => {
    lookup(target({ delegateTokenEpoch: 1, sessionVersion: 1 }));
    const result = await getUserFromToken(reqWith(delegateToken({ dte: 2, sv: 2 })));
    expect(result.user?.userId).toBe('target-1');
  });

  // Tokens minted before this change carry neither claim. They must keep working
  // against a user who has never been revoked — a deploy is not a mass logout.
  it('treats a pre-existing token with no counters as epoch 0', async () => {
    lookup(target({}));
    const token = jwt.sign(
      {
        userId: 'target-1',
        email: 'customer@example.com',
        roles: ['customer'],
        delegateAccess: {
          adminUserId: 'admin-1',
          adminEmail: 'admin@example.com',
          targetUserId: 'target-1',
          targetEmail: 'customer@example.com',
        },
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '8h' },
    );
    const result = await getUserFromToken(reqWith(token));
    expect(result.user?.userId).toBe('target-1');
  });

  // ...but a legacy token must still die once that user is actually revoked,
  // otherwise every token predating the fix is permanently un-revocable.
  it('still revokes a legacy token once the epoch is bumped', async () => {
    lookup(target({ delegateTokenEpoch: 1 }));
    const token = jwt.sign(
      {
        userId: 'target-1',
        email: 'customer@example.com',
        roles: ['customer'],
        delegateAccess: {
          adminUserId: 'admin-1',
          adminEmail: 'admin@example.com',
          targetUserId: 'target-1',
          targetEmail: 'customer@example.com',
        },
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '8h' },
    );
    const result = await getUserFromToken(reqWith(token));
    expect(result.user).toBeNull();
  });
});
