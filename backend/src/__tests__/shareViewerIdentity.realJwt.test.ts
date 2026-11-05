// ENG-2816: the owner check against REAL signed tokens and the real getUserFromToken (only the user table is faked),
// so "a forged, revoked, deleted or wrong-kind token is never the owner" is proven here, not assumed from a mock.
import jwt from 'jsonwebtoken';

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), getUserByEmailConsistent: jest.fn() },
}));

import { userDb } from '../services/db';
import { isSessionOwnerRequest } from '../services/shareViewerIdentity';

const mockUserDb = userDb as unknown as { getUserById: jest.Mock };
const SECRET = process.env.JWT_SECRET as string;
const OWNER = 'owner-user-id';
const ADMIN = 'admin-user-id';
const sign = (payload: object, secret = SECRET) => jwt.sign(payload, secret, { expiresIn: '1h' });
const reqWith = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;

const users: Record<string, any> = {
  [OWNER]: { userId: OWNER, email: 'o@x.com', isAdmin: false, roles: ['customer'], sessionVersion: 0 },
  [ADMIN]: { userId: ADMIN, email: 'a@x.com', isAdmin: true, roles: ['partner'], sessionVersion: 0 },
  'colleague-id': { userId: 'colleague-id', email: 'c@x.com', isAdmin: false, sessionVersion: 0 },
};

describe('isSessionOwnerRequest with real tokens (ENG-2816)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserDb.getUserById.mockImplementation(async (id: string) => users[id] ?? null);
  });

  it("the owner's own signed login is the owner", async () => {
    await expect(isSessionOwnerRequest(reqWith(sign({ userId: OWNER, email: 'o@x.com', sv: 0 })), OWNER)).resolves.toBe(true);
  });

  it('a token signed with a different secret is a visitor', async () => {
    await expect(isSessionOwnerRequest(reqWith(sign({ userId: OWNER, email: 'o@x.com' }, 'some-other-secret')), OWNER)).resolves.toBe(false);
  });

  it('an unsigned (alg none) token claiming the owner is a visitor', async () => {
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ userId: OWNER, email: 'o@x.com' })).toString('base64url') + '.';
    await expect(isSessionOwnerRequest(reqWith(none), OWNER)).resolves.toBe(false);
  });

  it('an expired login is a visitor', async () => {
    const expired = jwt.sign({ userId: OWNER, email: 'o@x.com' }, SECRET, { expiresIn: -10 });
    await expect(isSessionOwnerRequest(reqWith(expired), OWNER)).resolves.toBe(false);
  });

  it('a login from before a password change (session version behind the server) is a visitor', async () => {
    users[OWNER].sessionVersion = 3;
    try {
      await expect(isSessionOwnerRequest(reqWith(sign({ userId: OWNER, email: 'o@x.com', sv: 1 })), OWNER)).resolves.toBe(false);
    } finally {
      users[OWNER].sessionVersion = 0;
    }
  });

  it('a login for a user that no longer exists is a visitor', async () => {
    await expect(isSessionOwnerRequest(reqWith(sign({ userId: 'ghost-id', email: 'g@x.com' })), 'ghost-id')).resolves.toBe(false);
  });

  it('a deleted account (userId prefixed deleted_) is a visitor', async () => {
    users['deleted_owner'] = { userId: 'deleted_owner', email: 'd@x.com', sessionVersion: 0 };
    await expect(isSessionOwnerRequest(reqWith(sign({ userId: 'deleted_owner', email: 'd@x.com' })), 'deleted_owner')).resolves.toBe(false);
  });

  it("a colleague's valid login is a visitor on the owner's link", async () => {
    await expect(isSessionOwnerRequest(reqWith(sign({ userId: 'colleague-id', email: 'c@x.com' })), OWNER)).resolves.toBe(false);
  });

  it('an admin delegate token into the owner account (which resolves to the owner) is a visitor', async () => {
    const delegate = sign({
      userId: ADMIN, email: 'a@x.com', sv: 0, dte: 0,
      delegateAccess: { adminUserId: ADMIN, adminEmail: 'a@x.com', targetUserId: OWNER, targetEmail: 'o@x.com' },
    });
    await expect(isSessionOwnerRequest(reqWith(delegate), OWNER)).resolves.toBe(false);
  });

  it('a service self-call token for the owner is a visitor', async () => {
    await expect(isSessionOwnerRequest(reqWith(sign({ userId: OWNER, email: 'o@x.com', isAdmin: false, _svc: true })), OWNER)).resolves.toBe(false);
  });

  it('a garbage string is a visitor and never throws', async () => {
    await expect(isSessionOwnerRequest(reqWith('not.a.jwt'), OWNER)).resolves.toBe(false);
  });
});
