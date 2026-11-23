import { chatbotDb } from '../services/chatbotService';
import { interactiveShareAllowsSensitiveActions, interactiveShareControl, interactiveShareIsLive, SHARE_DIALOG_LIFETIMES_DAYS } from '../utils/interactiveShare';

/**
 * ENG-3170: the owner's per-link choice "allow sensitive actions".
 *
 * Two things are pinned here: how a stored link READS (including every link made before the setting existed), and how links are
 * WRITTEN (every new link stores an explicit choice, off unless the owner's share dialog said otherwise; an explicit choice is
 * applied to a link that is already there; a caller with no choice never touches it).
 */
/** A link as it was stored before the setting existed: shared on 2026-11-01, living `days` days. */
const SHARED_AT = '2026-11-01T00:00:00.000Z';
const lived = (days: number, extra: Record<string, unknown> = {}) => ({
  sharedAt: SHARED_AT,
  expiresAt: new Date(Date.parse(SHARED_AT) + days * 86_400_000).toISOString(),
  ...extra,
});

describe('interactiveShareAllowsSensitiveActions (how a stored link reads)', () => {
  it('an explicit choice wins, whatever else is on the link', () => {
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: true })).toBe(true);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: false })).toBe(false);
    // an explicit off beats a dialog lifetime, an explicit on beats a missing one or an admin 45-day one
    expect(interactiveShareAllowsSensitiveActions(lived(7, { allowSensitiveActions: false }))).toBe(false);
    expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: true })).toBe(true);
    expect(interactiveShareAllowsSensitiveActions(lived(45, { allowSensitiveActions: true }))).toBe(true);
  });

  describe('a link made BEFORE the setting existed (no choice stored)', () => {
    it.each(SHARE_DIALOG_LIFETIMES_DAYS)('made on purpose in the share dialog (%i days): keeps today\'s behaviour (on)', (days) => {
      expect(interactiveShareAllowsSensitiveActions(lived(days))).toBe(true);
    });

    it('the lifetimes are exactly the ones the share dialog offers', () => {
      expect([...SHARE_DIALOG_LIFETIMES_DAYS]).toEqual([1, 3, 7, 14, 30, 90, 365]);
    });

    it('made by the admin Chat History tab (45 days): OFF. 890 of the 921 live timed links on 2026-11-23 were of this kind', () => {
      expect(interactiveShareAllowsSensitiveActions(lived(45))).toBe(false);
    });

    it.each([0, 2, 5, 10, 44, 46, 60, 100, 366, 400])('any other lifetime nobody can account for (%i days) is OFF', (days) => {
      expect(interactiveShareAllowsSensitiveActions(lived(days))).toBe(false);
    });

    it('rounds to the nearest whole day (the two timestamps are taken a moment apart), not further', () => {
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: SHARED_AT, expiresAt: new Date(Date.parse(SHARED_AT) + 7 * 86_400_000 + 5_000).toISOString() })).toBe(true);
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: SHARED_AT, expiresAt: new Date(Date.parse(SHARED_AT) + 7 * 86_400_000 - 5_000).toISOString() })).toBe(true);
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: SHARED_AT, expiresAt: new Date(Date.parse(SHARED_AT) + 7.6 * 86_400_000).toISOString() })).toBe(false);
    });

    it('a link with no expiry (auto-made plan, emailed or Slack-posted, or very old) is OFF', () => {
      expect(interactiveShareAllowsSensitiveActions({})).toBe(false);
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: SHARED_AT })).toBe(false);
      expect(interactiveShareAllowsSensitiveActions({ expiresAt: '' })).toBe(false);
    });

    it('a link whose dates can not be read or compared is OFF', () => {
      expect(interactiveShareAllowsSensitiveActions({ expiresAt: '2026-11-08T00:00:00.000Z' })).toBe(false); // no sharedAt
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: 'not a date', expiresAt: '2026-11-08T00:00:00.000Z' })).toBe(false);
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: SHARED_AT, expiresAt: 'soon' })).toBe(false);
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: 20261101, expiresAt: 20261108 })).toBe(false);
      expect(interactiveShareAllowsSensitiveActions({ sharedAt: '2026-11-08T00:00:00.000Z', expiresAt: SHARED_AT })).toBe(false); // ends before it starts
    });
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

  it('a non-boolean choice is never believed AND never falls back to the lifetime rule: something stored that is not a boolean reads OFF', () => {
    for (const bad of ['true', 'false', 1, 0, {}, [], 'yes']) {
      expect(interactiveShareAllowsSensitiveActions(lived(7, { allowSensitiveActions: bad }))).toBe(false);
      expect(interactiveShareAllowsSensitiveActions(lived(45, { allowSensitiveActions: bad }))).toBe(false);
      expect(interactiveShareAllowsSensitiveActions({ allowSensitiveActions: bad })).toBe(false);
    }
    // null and undefined are "nothing stored" (an old link): the lifetime rule applies
    expect(interactiveShareAllowsSensitiveActions(lived(7, { allowSensitiveActions: null }))).toBe(true);
    expect(interactiveShareAllowsSensitiveActions(lived(7, { allowSensitiveActions: undefined }))).toBe(true);
  });
});

describe('createOrReuseInteractiveShare (how links are written)', () => {
  let getSessionSpy: jest.SpyInstance;
  let updateSpy: jest.SpyInstance;
  // an existing link is changed at ATTRIBUTE level (only the choice, only the expiry), never by writing back a copy of the whole link
  let setChoiceSpy: jest.SpyInstance;
  let stripSpy: jest.SpyInstance;

  beforeEach(() => {
    getSessionSpy = jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue({ sessionId: 's1', interactiveShareMetadata: undefined } as any);
    updateSpy = jest.spyOn(chatbotDb, 'updateSessionInteractiveShareMetadata').mockResolvedValue({} as any);
    setChoiceSpy = jest.spyOn(chatbotDb, 'setInteractiveShareAllowSensitiveActions').mockResolvedValue(undefined);
    stripSpy = jest.spyOn(chatbotDb, 'removeInteractiveShareExpiry').mockResolvedValue(undefined);
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

    it('applies an explicit choice from the dialog to the existing link, by writing ONLY the choice (one token per session, so reuse must not drop it)', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: false }));
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(setChoiceSpy).toHaveBeenCalledTimes(1);
      expect(setChoiceSpy).toHaveBeenCalledWith('s1', true);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('applies an explicit choice to a link made before the setting existed', async () => {
      getSessionSpy.mockResolvedValue(existing());
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: false });
      expect(setChoiceSpy).toHaveBeenCalledWith('s1', false);
    });

    it('leaves the link\'s own expiry alone when an explicit choice is applied on a timed request (nothing else is written)', async () => {
      getSessionSpy.mockResolvedValue(existing({ expiresAt: '2027-02-01T00:00:00.000Z' }));
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(setChoiceSpy).toHaveBeenCalledWith('s1', true);
      expect(stripSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('writes the explicit choice even when the copy it read already says that: the copy is eventually consistent and may be stale', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: true }));
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(setChoiceSpy).toHaveBeenCalledTimes(1);
      expect(setChoiceSpy).toHaveBeenCalledWith('s1', true);
      expect(updateSpy).not.toHaveBeenCalled(); // still never a whole-link write
    });

    it('a caller with NO choice never touches the setting: an email or alert can not switch an owner\'s "on" back to "off"', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: true }));
      await chatbotDb.createOrReuseInteractiveShare('s1');
      await chatbotDb.createOrReuseInteractiveShare('s1', null);
      await chatbotDb.createOrReuseInteractiveShare('s1', 7, {});
      expect(setChoiceSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('a no-expiry caller strips ONLY the expiry: a stale copy of the link is never written back over the owner\'s choice', async () => {
      getSessionSpy.mockResolvedValue(existing({ expiresAt: '2027-02-01T00:00:00.000Z', allowSensitiveActions: false }));
      await chatbotDb.createOrReuseInteractiveShare('s1');
      expect(stripSpy).toHaveBeenCalledTimes(1);
      expect(stripSpy).toHaveBeenCalledWith('s1');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(setChoiceSpy).not.toHaveBeenCalled();
    });

    it('a link whose owner turned on FULL CONTROL keeps the expiry the owner chose: an alert or email that reuses it cannot make it permanent', async () => {
      getSessionSpy.mockResolvedValue(existing({ expiresAt: '2027-02-01T00:00:00.000Z', allowSensitiveActions: true }));
      const url = await chatbotDb.createOrReuseInteractiveShare('s1'); // an alert: no expiry, no choice
      await chatbotDb.createOrReuseInteractiveShare('s1', null);
      expect(url).toContain('conversable=');
      expect(stripSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(setChoiceSpy).not.toHaveBeenCalled();
    });

    it('an old link with no stored choice, and an explicit OFF link, are still made permanent by a mailed reuse (the outage fix)', async () => {
      for (const stored of [{}, { allowSensitiveActions: false }]) {
        stripSpy.mockClear();
        getSessionSpy.mockResolvedValue(existing({ expiresAt: '2027-02-01T00:00:00.000Z', ...stored }));
        await chatbotDb.createOrReuseInteractiveShare('s1');
        expect(stripSpy).toHaveBeenCalledTimes(1);
      }
    });

    it('a link made before the setting existed, with a share-dialog lifetime (so it reads as ON), reads as OFF once a mailed or posted reuse has removed the expiry', () => {
      // the intended outcome, pinned: a link that was sent out to recipients is not one the owner made on purpose for a delegate
      const before = { isActive: true, token: 't', ...lived(7) };
      const { expiresAt: _removed, ...after } = before;
      expect(interactiveShareAllowsSensitiveActions(before as Record<string, unknown>)).toBe(true);
      expect(interactiveShareAllowsSensitiveActions(after as Record<string, unknown>)).toBe(false);
    });

    it('a failed write of an explicit choice is not swallowed as success: the caller gets the login fallback, not the share link', async () => {
      getSessionSpy.mockResolvedValue(existing({ allowSensitiveActions: false }));
      setChoiceSpy.mockRejectedValue(new Error('dynamo down'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const url = await chatbotDb.createOrReuseInteractiveShare('s1', 7, { allowSensitiveActions: true });
      expect(url).toContain('/agent-mode/s1');
      expect(url).not.toContain('conversable=');
    });
  });
});

describe('is the link live, and what may a visitor do on it right now (ENG-3170 review)', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const live = (extra: Record<string, unknown> = {}) => ({ isActive: true, sharedAt: '2026-11-22T12:00:00.000Z', ...extra });

  it('an empty expiry means "never expires", as the route reads it: the link is live', () => {
    expect(interactiveShareIsLive(live({ expiresAt: '' }), NOW)).toBe(true);
    expect(interactiveShareIsLive(live({ expiresAt: null }), NOW)).toBe(true);
    expect(interactiveShareControl(live({ expiresAt: '', allowSensitiveActions: true }), NOW)).toEqual({ sensitive: true, full: true });
  });

  it('live means switched on and not past its expiry; anything unreadable is not live', () => {
    expect(interactiveShareIsLive(live(), NOW)).toBe(true);
    expect(interactiveShareIsLive(live({ expiresAt: '2026-11-24T12:00:00.000Z' }), NOW)).toBe(true);
    expect(interactiveShareIsLive(live({ expiresAt: '2026-11-23T11:59:59.000Z' }), NOW)).toBe(false);
    expect(interactiveShareIsLive(live({ expiresAt: '2026-11-23T12:00:00.000Z' }), NOW)).toBe(false); // the instant itself is over
    expect(interactiveShareIsLive(live({ isActive: false }), NOW)).toBe(false);
    expect(interactiveShareIsLive({ sharedAt: 'x' }, NOW)).toBe(false);
    expect(interactiveShareIsLive(live({ expiresAt: 'not a date' }), NOW)).toBe(false);
    expect(interactiveShareIsLive(live({ expiresAt: 12345 }), NOW)).toBe(false);
    expect(interactiveShareIsLive(null, NOW)).toBe(false);
    expect(interactiveShareIsLive(undefined, NOW)).toBe(false);
  });

  it('an explicit choice on a live link: sensitive and full both follow it', () => {
    expect(interactiveShareControl(live({ allowSensitiveActions: true }), NOW)).toEqual({ sensitive: true, full: true });
    expect(interactiveShareControl(live({ allowSensitiveActions: false }), NOW)).toEqual({ sensitive: false, full: false });
  });

  it('a link made before the setting existed (a dialog lifetime) may run the sensitive tools but never has FULL control', () => {
    const legacy = live({ sharedAt: '2026-11-22T12:00:00.000Z', expiresAt: '2026-11-29T12:00:00.000Z' }); // 7 days
    expect(interactiveShareControl(legacy, NOW)).toEqual({ sensitive: true, full: false });
    // and a legacy link of any other lifetime or none has neither
    expect(interactiveShareControl(live({ expiresAt: '2027-01-06T12:00:00.000Z' }), NOW)).toEqual({ sensitive: false, full: false });
    expect(interactiveShareControl(live(), NOW)).toEqual({ sensitive: false, full: false });
  });

  it('a link that is not live has neither, whatever it says', () => {
    expect(interactiveShareControl(live({ isActive: false, allowSensitiveActions: true }), NOW)).toEqual({ sensitive: false, full: false });
    expect(interactiveShareControl(live({ expiresAt: '2026-11-23T11:00:00.000Z', allowSensitiveActions: true }), NOW)).toEqual({ sensitive: false, full: false });
    expect(interactiveShareControl(null, NOW)).toEqual({ sensitive: false, full: false });
  });

  it('only the real boolean true is full control', () => {
    for (const bad of ['true', 1, {}, [], 'yes']) expect(interactiveShareControl(live({ allowSensitiveActions: bad }), NOW).full).toBe(false);
  });
});

describe('the two attribute-level writes, as DynamoDB receives them (a spy on the method would pass whatever the expression said)', () => {
  const calls: any[] = [];
  beforeEach(() => {
    calls.length = 0;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes the choice alone, and only onto a link that exists', async () => {
    const { dynamodb } = require('../services/chatbotService');
    const spy = jest.spyOn(dynamodb, 'update').mockImplementation((params: any) => { calls.push(params); return { promise: async () => ({}) } as any; });
    await chatbotDb.setInteractiveShareAllowSensitiveActions('s1', true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].Key).toEqual({ sessionId: 's1' });
    expect(calls[0].UpdateExpression).toBe('SET interactiveShareMetadata.allowSensitiveActions = :allow');
    expect(calls[0].ExpressionAttributeValues).toEqual({ ':allow': true });
    expect(calls[0].ConditionExpression).toBe('attribute_exists(interactiveShareMetadata.#token)');
    expect(calls[0].ExpressionAttributeNames).toEqual({ '#token': 'token' });
  });

  it('removes the expiry alone, and only from a link that exists', async () => {
    const { dynamodb } = require('../services/chatbotService');
    jest.spyOn(dynamodb, 'update').mockImplementation((params: any) => { calls.push(params); return { promise: async () => ({}) } as any; });
    await chatbotDb.removeInteractiveShareExpiry('s1');
    expect(calls[0].UpdateExpression).toBe('REMOVE interactiveShareMetadata.expiresAt');
    expect(calls[0].ConditionExpression).toBe('attribute_exists(interactiveShareMetadata.#token)');
    expect(calls[0].ExpressionAttributeValues).toBeUndefined(); // it writes no value: nothing of the choice can be carried along
  });

  it('a failed write is thrown (the route that made the choice answers 500 rather than showing a switch that is not true)', async () => {
    const { dynamodb } = require('../services/chatbotService');
    jest.spyOn(dynamodb, 'update').mockImplementation(() => ({ promise: async () => { throw new Error('ConditionalCheckFailedException'); } }) as any);
    await expect(chatbotDb.setInteractiveShareAllowSensitiveActions('s1', false)).rejects.toThrow('ConditionalCheckFailed');
    await expect(chatbotDb.removeInteractiveShareExpiry('s1')).rejects.toThrow('ConditionalCheckFailed');
  });
});
