// ENG-2816: only the share link's OWN logged-in owner is recognised; everything else stays a visitor.
jest.mock('../middleware/auth', () => ({ getUserFromToken: jest.fn() }));

import { getUserFromToken } from '../middleware/auth';
import { isSessionOwnerRequest } from '../services/shareViewerIdentity';

const mockGetUserFromToken = getUserFromToken as jest.Mock;
const OWNER = 'owner-user-id';
const BEARER = 'Bearer some.jwt.value';
const reqWith = (authorization?: unknown) => ({ headers: authorization === undefined ? {} : { authorization } }) as never;

describe('isSessionOwnerRequest', () => {
  beforeEach(() => jest.resetAllMocks());

  it('recognises the owner: a verified normal login whose user is the session owner', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER, email: 'o@x.com', isAdmin: false }, decoded: { userId: OWNER } });
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(true);
  });

  it('hands the request itself (the same object) to the shared verifier, the one every other route uses', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER } });
    const req = reqWith(BEARER);
    await isSessionOwnerRequest(req, OWNER);
    expect(mockGetUserFromToken.mock.calls[0][0]).toBe(req);
  });

  it('a logged-in colleague (a different user) stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague-id' }, decoded: { userId: 'colleague-id' } });
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(false);
  });

  it('an admin acting as the owner through a delegate token is not the owner', async () => {
    // getUserFromToken resolves a delegate token to the TARGET user, so the userId matches; the claim must still refuse it.
    mockGetUserFromToken.mockResolvedValue({
      user: { userId: OWNER },
      decoded: { userId: 'admin-id', delegateAccess: { adminUserId: 'admin-id', adminEmail: 'a@x.com', targetUserId: OWNER, targetEmail: 'o@x.com' } },
    });
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(false);
  });

  it('a service self-call token is not the owner', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER, _svc: true } });
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(false);
  });

  it('a token the verifier rejects (expired, bad signature, revoked session version) stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: null });
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(false);
  });

  it('a verifier that returns a user without a decoded payload stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER } });
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(false);
  });

  it('a verifier that throws never produces an error, only a visitor', async () => {
    mockGetUserFromToken.mockRejectedValue(new Error('db down'));
    await expect(isSessionOwnerRequest(reqWith(BEARER), OWNER)).resolves.toBe(false);
  });

  it.each([undefined, '', null, ['Bearer a', 'Bearer b']])('no usable header (%p) stays a visitor and never calls the verifier', async (header) => {
    await expect(isSessionOwnerRequest(reqWith(header), OWNER)).resolves.toBe(false);
    expect(mockGetUserFromToken).not.toHaveBeenCalled();
  });

  it('an empty owner id never matches', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: '' }, decoded: { userId: '' } });
    await expect(isSessionOwnerRequest(reqWith(BEARER), '')).resolves.toBe(false);
    expect(mockGetUserFromToken).not.toHaveBeenCalled();
  });
});
