import { chatbotDb } from '../services/chatbotService';

/**
 * Regression: machine-generated interactive shares must NOT inherit a timed
 * expiry. Only callers that explicitly pass expirationDays (the human "share"
 * dialog) get an expiresAt. A 7-day default previously baked an expiry into
 * scheduled-chat / slack / email / alert links and silently 410'd them a week
 * after creation. See chatbotService.createOrReuseInteractiveShare.
 */
describe('createOrReuseInteractiveShare - expiry policy', () => {
  let getSessionSpy: jest.SpyInstance;
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    // No existing active share -> force the create branch.
    getSessionSpy = jest
      .spyOn(chatbotDb, 'getChatSession')
      .mockResolvedValue({ sessionId: 's1', interactiveShareMetadata: undefined } as any);
    updateSpy = jest
      .spyOn(chatbotDb, 'updateSessionInteractiveShareMetadata')
      .mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('omits expiresAt when called with no expirationDays (machine paths)', async () => {
    await chatbotDb.createOrReuseInteractiveShare('s1');

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1];
    expect(written.isActive).toBe(true);
    expect(written.token).toEqual(expect.any(String));
    expect(written.sharedAt).toEqual(expect.any(String));
    expect(written).not.toHaveProperty('expiresAt');
  });

  it('omits expiresAt when expirationDays is explicitly null', async () => {
    await chatbotDb.createOrReuseInteractiveShare('s1', null);

    const written = updateSpy.mock.calls[0][1];
    expect(written).not.toHaveProperty('expiresAt');
  });

  it('coerces 0 / negative expirationDays to no-expiry (never mints an instantly-expired link)', async () => {
    await chatbotDb.createOrReuseInteractiveShare('s1', 0);
    expect(updateSpy.mock.calls[0][1]).not.toHaveProperty('expiresAt');

    updateSpy.mockClear();
    await chatbotDb.createOrReuseInteractiveShare('s1', -5);
    expect(updateSpy.mock.calls[0][1]).not.toHaveProperty('expiresAt');
  });

  it('strips a stored expiry when a 0/negative caller reuses the token', async () => {
    getSessionSpy.mockResolvedValue({
      sessionId: 's1',
      interactiveShareMetadata: { isActive: true, token: 'shared-token', expiresAt: '2026-07-16T00:00:00.000Z' },
    } as any);

    await chatbotDb.createOrReuseInteractiveShare('s1', 0);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][1]).not.toHaveProperty('expiresAt');
  });

  it('writes a ~N-day expiresAt when expirationDays is provided (human dropdown)', async () => {
    const before = Date.now();
    await chatbotDb.createOrReuseInteractiveShare('s1', 30);
    const after = Date.now();

    const written = updateSpy.mock.calls[0][1];
    expect(written).toHaveProperty('expiresAt');
    const ms = new Date(written.expiresAt).getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 30 * 86400000 - 1000);
    expect(ms).toBeLessThanOrEqual(after + 30 * 86400000 + 1000);
  });

  it('reuses an existing active share (no stored expiry) without writing metadata', async () => {
    getSessionSpy.mockResolvedValue({
      sessionId: 's1',
      interactiveShareMetadata: { isActive: true, token: 'existing-token' },
    } as any);

    const url = await chatbotDb.createOrReuseInteractiveShare('s1');

    expect(updateSpy).not.toHaveBeenCalled();
    expect(url).toContain('conversable=existing-token');
  });

  it('strips a stored expiry when a no-expiry caller reuses the token (external send)', async () => {
    // Admin minted a 45d link first; a later external send must make it permanent.
    getSessionSpy.mockResolvedValue({
      sessionId: 's1',
      interactiveShareMetadata: {
        isActive: true,
        token: 'shared-token',
        sharedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-07-16T00:00:00.000Z',
      },
    } as any);

    const url = await chatbotDb.createOrReuseInteractiveShare('s1');

    expect(url).toContain('conversable=shared-token');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1];
    expect(written.token).toBe('shared-token');
    expect(written.sharedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(written).not.toHaveProperty('expiresAt');
  });

  it('still returns the working /ishare link if the strip write fails (best-effort)', async () => {
    // A failed strip must NOT propagate to the outer catch, which would downgrade
    // the link to a login-required /agent-mode URL.
    getSessionSpy.mockResolvedValue({
      sessionId: 's1',
      interactiveShareMetadata: { isActive: true, token: 'shared-token', expiresAt: '2026-07-16T00:00:00.000Z' },
    } as any);
    updateSpy.mockRejectedValue(new Error('dynamo down'));

    const url = await chatbotDb.createOrReuseInteractiveShare('s1');

    expect(updateSpy).toHaveBeenCalledTimes(1); // strip attempted
    expect(url).toContain('/ishare/');
    expect(url).toContain('conversable=shared-token');
    expect(url).not.toContain('/agent-mode/');
  });

  it('does NOT strip a stored expiry when the caller itself requested a timed expiry', async () => {
    getSessionSpy.mockResolvedValue({
      sessionId: 's1',
      interactiveShareMetadata: {
        isActive: true,
        token: 'shared-token',
        expiresAt: '2026-07-16T00:00:00.000Z',
      },
    } as any);

    await chatbotDb.createOrReuseInteractiveShare('s1', 45);

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
