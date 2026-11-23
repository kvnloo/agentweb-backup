import { chatbotDb } from '../services/chatbotService';
import { interactiveShareAllowsSensitiveActions } from '../utils/interactiveShare';

/**
 * ENG-3170: the owner's per-link choice "allow sensitive actions".
 *
 * Two things are pinned here: how a stored link READS (including every link made before the setting existed), and how links are
 * WRITTEN (every new link stores an explicit choice, off unless the owner's share dialog said otherwise; an explicit choice is
 * applied to a link that is already there; a caller with no choice never touches it).
 */
describe('interactiveShareAllowsSensitiveActions (how a stored link reads)', () => {
  it('an explicit choice wins, whatever else is on the link', () => {
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: true })).toBe(true);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: false })).toBe(false);
    // an explicit off beats an expiry date, an explicit on beats a missing one
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: false, expiresAt: '2027-01-01T00:00:00.000Z' })).toBe(false);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: true })).toBe(true);
  });

  it('a link made before the setting existed: a timed (dialog) link keeps working, a no-expiry link is off', () => {
    expect(interactiveShareAllowsSensitiveActions({ expiresAt: '2027-01-01T00:00:00.000Z' })).toBe(true);
    expect(interactiveShareAllowsSensitiveActions({})).toBe(false);
    expect(interactiveShareAllowsSensitiveActions({ expiresAt: '' })).toBe(false);
  });

  it('nothing readable is off (fails closed)', () => {
    expect(interactiveShareAllowsSensitiveActions(undefined)).toBe(false);
    expect(interactiveShareAllowsSensitiveActions(null)).toBe(false);
    expect(interactiveShareAllowsSensitiveActions('yes' as any)).toBe(false);
    // only a real boolean is a choice; "true" as text, 1, or an object is not
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: 'true' })).toBe(false);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: 1 })).toBe(false);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: {} })).toBe(false);
  });

  it('a non-boolean choice falls back to the expiry rule rather than being believed', () => {
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: 'true', expiresAt: '2027-01-01T00:00:00.000Z' })).toBe(true);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: 'true' })).toBe(false);
  });
});

describe('createOrReuseInteractiveShare (how links are written)', () => {
  let getSessionSpy: jest.SpyInstance;
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    getSessionSpy = jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue({ sessionId: 's1', interactiveShareMetadata: undefined } as any);
    updateSpy = jest.spyOn(chatbotDb, 'updateSessionInteractiveShareMetadata').mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a NEW link', () => {
    it.each([
      ['an email, Slack or alert caller (no arguments)', [] as any[]],
      ['a caller that passes an expiry but no choice', [30]],
      ['a caller that passes null', [null]],
      ['a caller that passes an empty options object', [30, {}]],
      ['a caller that passes a non-boolean choice', [30, { allowSensitiveActions: 'true' as any }]],
    ])('stores an explicit OFF for %s', async (_label, args) => {
      await (chatbotDb as any).createOrReuseInteractiveShare('s1', ...args);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0][1].allowSensitiveActions).toBe(false);
    });

    it('stores ON only when the caller passes the real boolean true', async () => {
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(updateSpy.mock.calls[0][1].allowSensitiveActions).toBe(true);
    });

    it('stores an explicit OFF when the dialog passes false', async () => {
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: false });
      expect(updateSpy.mock.calls[0][1].allowSensitiveActions).toBe(false);
    });

    it('does not change anything else about a new link (still an expiry only for a timed request)', async () => {
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      const written = updateSpy.mock.calls[0][1];
      expect(written.isActive).toBe(true);
      expect(written.token).toEqual(expect.any(String));
      expect(written.expiresAt).toEqual(expect.any(String));
      updateSpy.mockClear();
      await chatbotDb.createOrReuseInteractiveShare('s1');
      expect(updateSpy.mock.calls[0][1]).not.toHaveProperty('expiresAt');
    });
  });

  describe('a link that ALREADY exists', () => {
    const existing = (extra: Record<string, unknown> = {}) => ({
      sessionId: 's1',
      interactiveShareMetadata: { isActive: true, token: 'the-token', sharedAt: '2026-11-01T00:00:00.000Z', ...extra },
    } as any);

    it('keeps the same token and returns the same link', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: false }));
      const url = await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(url).toContain('/ishare/s1?conversable=the-token');
    });

    it('applies an explicit choice from the dialog to the existing link (one token per session, so reuse must not drop the choice)', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: false }));
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0][1]).toMatchObject({ isActive: true, token: 'the-token', allowSensitiveActions: true });
    });

    it('applies an explicit choice to a link made before the setting existed', async () => {
      getSessionSpy.mockResolvedValue(existing());
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: false });
      expect(updateSpy.mock.calls[0][1]).toMatchObject({ token: 'the-token', allowSensitiveActions: false });
    });

    it('keeps the link\'s own expiry when an explicit choice is applied on a timed request', async () => {
      getSessionSpy.mockResolvedValue(existing({ expiresAt: '2027-02-01T00:00:00.000Z' }));
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(updateSpy.mock.calls[0][1]).toMatchObject({ expiresAt: '2027-02-01T00:00:00.000Z', allowSensitiveActions: true });
    });

    it('writes nothing when the explicit choice is already what is stored', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: true }));
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('a caller with NO choice never touches the setting: an email or alert can not switch an owner\'s "on" back to "off"', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: true }));
      await chatbotDb.createOrReuseInteractiveShare('s1');
      await chatbotDb.createOrReuseInteractiveShare('s1', null);
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, {});
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('a no-expiry caller still strips the expiry and keeps the stored choice (the strip must not lose it)', async () => {
      getSessionSpy.mockResolvedValue(existing({ expiresAt: '2027-02-01T00:00:00.000Z', allowSensitiveActions: true }));
      await chatbotDb.createOrReuseInteractiveShare('s1');
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const written = updateSpy.mock.calls[0][1];
      expect(written).not.toHaveProperty('expiresAt');
      expect(written.allowSensitiveActions).toBe(true);
    });

    it('a failed write of an explicit choice is not swallowed as success: the caller gets the login fallback, not the share link', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: false }));
      updateSpy.mockRejectedValue(new Error('dynamo down'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const url = await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(url).toContain('/agent-mode/s1');
      expect(url).not.toContain('conversable=');
    });
  });
});
