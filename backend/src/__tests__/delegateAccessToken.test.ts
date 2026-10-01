/**
 * Tests for services/delegateAccessToken.ts — extracted from routes/admin.ts's
 * `/users/:userId/delegate-access` handler (ENG-1596) so the MCP tool layer
 * (adminClientScope.ts) can mint the same shape of token internally, per tool
 * call, without a browser-session round trip. admin.delegateAccess.test.ts
 * already pins the route's end-to-end behavior post-extraction; this file
 * pins the minter itself in isolation.
 */

import jwt from 'jsonwebtoken';
import { mintDelegateToken } from '../services/delegateAccessToken';

describe('mintDelegateToken', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  const adminUser = { userId: 'admin-1', email: 'admin@example.com' };
  const targetUser = {
    userId: 'target-1',
    email: 'customer@example.com',
    roles: ['customer'],
    delegateTokenEpoch: 2,
    sessionVersion: 5,
  };

  it('ENG-1870 never mints delegated credentials to or from an evaluation identity', () => {
    expect(() => mintDelegateToken(adminUser, { ...targetUser, userId: 'eval_test' }, 300)).toThrow();
    expect(() => mintDelegateToken({ ...adminUser, userId: 'eval_test' }, targetUser, 300)).toThrow();
  });

  it('mints a token whose active identity is the TARGET, not the admin', () => {
    const token = mintDelegateToken(adminUser, targetUser, 300);
    const decoded = jwt.verify(token, 'test-secret') as any;

    expect(decoded.userId).toBe('target-1');
    expect(decoded.email).toBe('customer@example.com');
    expect(decoded.roles).toEqual(['customer']);
  });

  it('never grants isAdmin, even when the target happens to be an admin', () => {
    const adminTarget = { ...targetUser, roles: ['customer', 'admin'] };
    const token = mintDelegateToken(adminUser, adminTarget, 300);
    const decoded = jwt.verify(token, 'test-secret') as any;

    expect(decoded.isAdmin).toBe(false);
  });

  it('carries the delegateAccess block identifying both admin and target', () => {
    const token = mintDelegateToken(adminUser, targetUser, 300);
    const decoded = jwt.verify(token, 'test-secret') as any;

    expect(decoded.delegateAccess).toEqual({
      adminUserId: 'admin-1',
      adminEmail: 'admin@example.com',
      targetUserId: 'target-1',
      targetEmail: 'customer@example.com',
    });
  });

  it('stamps the target\'s revocation counters (dte/sv), not the admin\'s', () => {
    const token = mintDelegateToken(adminUser, targetUser, 300);
    const decoded = jwt.verify(token, 'test-secret') as any;

    expect(decoded.dte).toBe(2);
    expect(decoded.sv).toBe(5);
  });

  it('defaults dte/sv to 0 when the target has no counters yet', () => {
    const freshTarget = { userId: 'fresh-1', email: 'fresh@example.com', roles: ['customer'] };
    const token = mintDelegateToken(adminUser, freshTarget, 300);
    const decoded = jwt.verify(token, 'test-secret') as any;

    expect(decoded.dte).toBe(0);
    expect(decoded.sv).toBe(0);
  });

  it('honors a numeric TTL (seconds)', () => {
    const token = mintDelegateToken(adminUser, targetUser, 300);
    const decoded = jwt.verify(token, 'test-secret') as any;

    const secondsUntilExpiry = decoded.exp - decoded.iat;
    expect(secondsUntilExpiry).toBe(300);
  });

  it('honors a string TTL (e.g. "8h"), matching the real delegate-access route', () => {
    const token = mintDelegateToken(adminUser, targetUser, '8h');
    const decoded = jwt.verify(token, 'test-secret') as any;

    const hoursUntilExpiry = (decoded.exp - decoded.iat) / 3600;
    expect(hoursUntilExpiry).toBe(8);
  });
});
