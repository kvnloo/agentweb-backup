/**
 * Protects a critical invariant per this repo's own test policy (auth/identity
 * resolution): never derive an Agentic Fabriq external-user id from anything
 * other than our own session, and never accept a bare positional string for
 * the explicit escape hatch.
 */
import {
  forUserFromRequest,
  forUserDangerouslyUsingRawUserId,
  forUserFromVerifiedWebhook,
} from '../identity';
import { AgenticFabriqIdentityError } from '../errors';

describe('forUserFromRequest', () => {
  it('resolves from req.user.userId (the real AuthenticatedRequest shape)', () => {
    expect(forUserFromRequest({ user: { userId: 'user_8412' } })).toBe('user_8412');
  });

  it('throws when there is no session identity anywhere', () => {
    expect(() => forUserFromRequest({})).toThrow(AgenticFabriqIdentityError);
  });

  it('ignores a request shaped only by query-string-derived fields (never a real source)', () => {
    // Simulates a request object that only has query/body-derived junk bolted
    // on — this module has no code path that even looks at req.query, but this
    // pins that a shape mimicking one still resolves to nothing, not to that value.
    const fakeReq: any = { query: { user_id: 'victim' }, body: { userId: 'victim' } };
    expect(() => forUserFromRequest(fakeReq)).toThrow(AgenticFabriqIdentityError);
  });
});

describe('forUserDangerouslyUsingRawUserId', () => {
  it('accepts the required wrapper shape', () => {
    expect(forUserDangerouslyUsingRawUserId({ dangerouslyUseRawUserId: 'user_8412' })).toBe('user_8412');
  });

  it('raises TypeError on a bare positional string', () => {
    expect(() => (forUserDangerouslyUsingRawUserId as any)('user_8412')).toThrow(TypeError);
  });

  it('raises TypeError on an empty-string id', () => {
    expect(() => forUserDangerouslyUsingRawUserId({ dangerouslyUseRawUserId: '' })).toThrow(TypeError);
  });

  it('raises TypeError on an extra-keys object (not the exact contract)', () => {
    expect(() =>
      (forUserDangerouslyUsingRawUserId as any)({ dangerouslyUseRawUserId: 'user_8412', extra: true }),
    ).toThrow(TypeError);
  });
});

describe('forUserFromVerifiedWebhook', () => {
  it('passes an already-verified subject_user through the same explicit-escape-hatch contract', () => {
    expect(forUserFromVerifiedWebhook('user_8412')).toBe('user_8412');
  });
});
