// ENG-2816: only the share link's OWN logged-in owner is recognised; everything else stays a visitor.
jest.mock('../middleware/auth', () => ({ getUserFromToken: jest.fn() }));

import { getUserFromToken } from '../middleware/auth';
import { isSessionOwnerAuthorization } from '../services/shareViewerIdentity';

const mockGetUserFromToken = getUserFromToken as jest.Mock;
const OWNER = 'owner-user-id';
const BEARER = 'Bearer some.jwt.value';

describe('isSessionOwnerAuthorization', () => {
  beforeEach(() => jest.resetAllMocks());

  it('recognises the owner: a verified normal login whose user is the session owner', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER, email: 'o@x.com', isAdmin: false }, decoded: { userId: OWNER } });
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(true);
  });

  it('hands the header on to the shared verifier as an Authorization header', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER } });
    await isSessionOwnerAuthorization(BEARER, OWNER);
    expect(mockGetUserFromToken).toHaveBeenCalledWith({ headers: { authorization: BEARER } });
  });

  it('a logged-in colleague (a different user) stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague-id' }, decoded: { userId: 'colleague-id' } });
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(false);
  });

  it('an admin acting as the owner through a delegate token is not the owner', async () => {
    // getUserFromToken resolves a delegate token to the TARGET user, so the userId matches; the claim must still refuse it.
    mockGetUserFromToken.mockResolvedValue({
      user: { userId: OWNER },
      decoded: { userId: 'admin-id', delegateAccess: { adminUserId: 'admin-id', adminEmail: 'a@x.com', targetUserId: OWNER, targetEmail: 'o@x.com' } },
    });
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(false);
  });

  it('a service self-call token is not the owner', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER, _svc: true } });
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(false);
  });

  it('a token the verifier rejects (expired, bad signature, revoked session version) stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: null });
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(false);
  });

  it('a verifier that returns a user without a decoded payload stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER } });
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(false);
  });

  it('a verifier that throws never produces an error, only a visitor', async () => {
    mockGetUserFromToken.mockRejectedValue(new Error('db down'));
    await expect(isSessionOwnerAuthorization(BEARER, OWNER)).resolves.toBe(false);
  });

  it.each([undefined, '', null as unknown as string])('no usable header (%p) stays a visitor and never calls the verifier', async (header) => {
    await expect(isSessionOwnerAuthorization(header as string | undefined, OWNER)).resolves.toBe(false);
    expect(mockGetUserFromToken).not.toHaveBeenCalled();
  });

  it('an empty owner id never matches', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: '' }, decoded: { userId: '' } });
    await expect(isSessionOwnerAuthorization(BEARER, '')).resolves.toBe(false);
    expect(mockGetUserFromToken).not.toHaveBeenCalled();
  });
});
