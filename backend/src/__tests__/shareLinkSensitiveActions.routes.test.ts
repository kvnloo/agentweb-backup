/**
 * ENG-3170: the owner's per-link switch "allow sensitive actions", as the owner's share dialog meets it.
 *
 *  - POST /conversable-share carries the owner's choice and answers with what is STORED;
 *  - GET  /session/:id/conversable-share says what the link means now (including a link made before the setting existed);
 *  - PATCH /session/:id/conversable-share changes it on the link that already exists.
 *
 * All three are the owner's: the session must be theirs. A visitor's token never reaches them (they need the owner's login).
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getChatSessionRecord: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    setInteractiveShareAllowSensitiveActions: jest.fn(),
  },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { getDefaultModel: jest.fn().mockResolvedValue('test-model'), getSkillsForDisplay: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn().mockResolvedValue(null) } }));

import { chatbotDb } from '../services/chatbotService';
import { agentModeController } from '../controllers/agentModeController';

const OWNER = { userId: 'owner-1', email: 'owner@example.com' };
const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
};
const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, user: OWNER, ...over }) as unknown as Request;
const URL_WITH_TOKEN = 'http://localhost:5174/ishare/s1?conversable=tok123';
const share = (extra: Record<string, unknown> = {}) => ({ isActive: true, token: 'tok123', sharedAt: '2026-11-01T00:00:00.000Z', ...extra });
const session = (interactiveShareMetadata: unknown, userId = OWNER.userId) => ({ sessionId: 's1', userId, interactiveShareMetadata });

beforeEach(() => {
  jest.resetAllMocks();
  (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(URL_WITH_TOKEN);
  (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue({});
  (chatbotDb.setInteractiveShareAllowSensitiveActions as jest.Mock).mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('POST /conversable-share (createConversableShare)', () => {
  const create = async (body: Record<string, unknown>, user: unknown = OWNER) => {
    const res = makeRes();
    await agentModeController.createConversableShare(req({ body, user }), res);
    return res;
  };

  it('passes the owner\'s explicit ON to the link and answers with the STORED value', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true, expiresAt: '2026-12-01T00:00:00.000Z' })));
    const res = await create({ sessionId: 's1', expirationDays: 7, allowSensitiveActions: true });
    expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('s1', 7, { allowSensitiveActions: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ conversableToken: 'tok123', allowSensitiveActions: true }));
  });

  it('answers with the STORED expiry: a permanent link that was reused is not shown as expiring (final review)', async () => {
    // a link first made by an email or alert path never expires; the owner asks for 7 days + Full control from a dialog that did not know that
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true })));
    const res = await create({ sessionId: 's1', expirationDays: 7, allowSensitiveActions: true });
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toEqual(expect.objectContaining({ conversableToken: 'tok123', allowSensitiveActions: true }));
    expect(body).not.toHaveProperty('expiresAt');
  });

  it('answers with the stored expiry when there is one (it is what the link really has, not what was asked for)', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: false, expiresAt: '2026-12-30T00:00:00.000Z' })));
    const res = await create({ sessionId: 's1', expirationDays: 1, allowSensitiveActions: false });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: '2026-12-30T00:00:00.000Z' }));
    // and the same for a request that sends no choice
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ expiresAt: '2026-12-30T00:00:00.000Z' })));
    const res2 = await create({ sessionId: 's1', expirationDays: 1 });
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: '2026-12-30T00:00:00.000Z' }));
  });

  it('a read-back that fails says nothing about the expiry rather than guessing one', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await create({ sessionId: 's1', expirationDays: 7 });
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toEqual(expect.objectContaining({ allowSensitiveActions: false }));
    expect(body).not.toHaveProperty('expiresAt');
  });

  it('passes an explicit OFF too', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: false })));
    const res = await create({ sessionId: 's1', expirationDays: 7, allowSensitiveActions: false });
    expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('s1', 7, { allowSensitiveActions: false });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ allowSensitiveActions: false }));
  });

  it('says so, and does not show a switch that is not true, when the owner\'s choice did not persist', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: false })));
    const res = await create({ sessionId: 's1', expirationDays: 7, allowSensitiveActions: true });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('sensitive-actions') });
  });

  it('an old client that sends no choice: the call has no third argument, a NEW link answers OFF', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
    const res = await create({ sessionId: 's1', expirationDays: 7 });
    expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('s1', 7);
    expect((chatbotDb.createOrReuseInteractiveShare as jest.Mock).mock.calls[0]).toHaveLength(2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ allowSensitiveActions: false }));
  });

  it('a request with no choice on an EXISTING link answers with what that link already was (read back, consistently) and changes nothing', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true })));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true })));
    const res = await create({ sessionId: 's1', expirationDays: 7 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ allowSensitiveActions: true }));
    expect(chatbotDb.getChatSessionRecord).toHaveBeenCalledWith('s1', true);
    expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
  });

  it('a request with no choice, on a full-control link that expired and was REPLACED by an off link, answers what is stored now: OFF', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true, expiresAt: '2020-01-01T00:00:00.000Z' })));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: false })));
    const res = await create({ sessionId: 's1', expirationDays: 7 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ allowSensitiveActions: false }));
  });

  it('a request with no choice whose read-back fails answers OFF, never a guess', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true })));
    (chatbotDb.getChatSessionRecord as jest.Mock).mockRejectedValue(new Error('throttled'));
    const res = await create({ sessionId: 's1', expirationDays: 7 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ allowSensitiveActions: false }));
  });

  it.each([['the text "true"', 'true'], ['the number 1', 1], ['an object', {}], ['null', null]])(
    'only a real boolean is a choice: %s counts as no choice',
    async (_label, value) => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined));
      await create({ sessionId: 's1', expirationDays: 7, allowSensitiveActions: value });
      expect((chatbotDb.createOrReuseInteractiveShare as jest.Mock).mock.calls[0]).toEqual(['s1', 7]);
    },
  );

  it('is the owner\'s: another user\'s session is not found, and nothing is written', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(undefined, 'someone-else'));
    const res = await create({ sessionId: 's1', expirationDays: 7, allowSensitiveActions: true });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
  });

  it('a sandbox account still gets no link at all', async () => {
    const res = await create({ sessionId: 's1', allowSensitiveActions: true }, { userId: 'eval_test' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
  });
});

describe('GET /session/:id/conversable-share (getConversableShareSettings)', () => {
  const read = async (record: unknown, user: unknown = OWNER) => {
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(record);
    const res = makeRes();
    await agentModeController.getConversableShareSettings(req({ params: { sessionId: 's1' }, user }), res);
    return res;
  };

  it('reads the owner\'s stored choice (a consistent read)', async () => {
    const res = await read(session(share({ allowSensitiveActions: true })));
    expect(chatbotDb.getChatSessionRecord).toHaveBeenCalledWith('s1', true);
    expect(res.json).toHaveBeenCalledWith({ allowSensitiveActions: true, explicit: true });
    const off = await read(session(share({ allowSensitiveActions: false, expiresAt: '2027-01-01T00:00:00.000Z' })));
    expect(off.json).toHaveBeenCalledWith({ allowSensitiveActions: false, explicit: true });
  });

  it('says what a link made BEFORE the setting existed means: a share-dialog length is on, a 45-day admin one and a no-expiry one are off, and that it was not chosen', async () => {
    const timed = await read(session(share({ expiresAt: '2026-11-08T00:00:00.000Z' }))); // shared 2026-11-01, 7 days: the share dialog's length
    expect(timed.json).toHaveBeenCalledWith({ allowSensitiveActions: true, explicit: false });
    const adminMade = await read(session(share({ expiresAt: '2026-12-16T00:00:00.000Z' }))); // 45 days: the admin Chat History tab's length
    expect(adminMade.json).toHaveBeenCalledWith({ allowSensitiveActions: false, explicit: false });
    const noExpiry = await read(session(share()));
    expect(noExpiry.json).toHaveBeenCalledWith({ allowSensitiveActions: false, explicit: false });
  });

  it('is the owner\'s: another user\'s session, a missing session and a session with no active link are all not found', async () => {
    for (const record of [session(share(), 'someone-else'), null, session(undefined), session(share({ isActive: false }))]) {
      const res = await read(record);
      expect(res.status).toHaveBeenCalledWith(404);
    }
  });

  it('a read failure is an error, never a guessed value', async () => {
    (chatbotDb.getChatSessionRecord as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    const res = makeRes();
    await agentModeController.getConversableShareSettings(req({ params: { sessionId: 's1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('a request carrying a visitor\'s restriction claim never changes the owner\'s setting (ENG-3170 review, defence in depth)', () => {
  // The claim is set only from a verified self-call token of a visitor's turn (middleware/auth.ts); no tool reaches these routes today.
  const claimed = (over: Record<string, unknown>) => req({ ...over, restrictionProfile: 'share_visitor' });

  it.each(['share_visitor', 'share_visitor_schedule'])('POST create with the %s claim: 403, nothing created, nothing read', async (profile) => {
    const res = makeRes();
    await agentModeController.createConversableShare(req({ body: { sessionId: 's1', expirationDays: 7, allowSensitiveActions: true }, restrictionProfile: profile }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });

  it('DELETE (stop sharing) with the claim: 403, nothing read, nothing stopped', async () => {
    const res = makeRes();
    await agentModeController.stopConversableShare(claimed({ params: { sessionId: 's1' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
  });

  it('PATCH with the claim: 403, nothing written', async () => {
    const res = makeRes();
    await agentModeController.updateConversableShareSettings(claimed({ params: { sessionId: 's1' }, body: { allowSensitiveActions: true } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(chatbotDb.setInteractiveShareAllowSensitiveActions).not.toHaveBeenCalled();
    expect(chatbotDb.getChatSessionRecord).not.toHaveBeenCalled();
  });
});

describe('PATCH /session/:id/conversable-share (updateConversableShareSettings)', () => {
  const patch = async (body: unknown, records: unknown[], user: unknown = OWNER) => {
    const read = chatbotDb.getChatSessionRecord as jest.Mock;
    records.forEach((r) => read.mockResolvedValueOnce(r));
    const res = makeRes();
    await agentModeController.updateConversableShareSettings(req({ params: { sessionId: 's1' }, body, user }), res);
    return res;
  };

  it('turns it ON for the existing link, writing ONLY the choice (never a copy of the rest of the link), and answers with the stored value', async () => {
    const res = await patch(
      { allowSensitiveActions: true },
      [session(share({ expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: false })), session(share({ expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: true }))],
    );
    expect(chatbotDb.setInteractiveShareAllowSensitiveActions).toHaveBeenCalledWith('s1', true);
    expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ allowSensitiveActions: true, explicit: true });
  });

  it('turns it OFF, and can make an explicit choice on a link made before the setting existed', async () => {
    const res = await patch({ allowSensitiveActions: false }, [session(share({ expiresAt: '2027-01-01T00:00:00.000Z' })), session(share({ expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: false }))]);
    expect(chatbotDb.setInteractiveShareAllowSensitiveActions).toHaveBeenCalledWith('s1', false);
    expect(res.json).toHaveBeenCalledWith({ allowSensitiveActions: false, explicit: true });
  });

  it.each([['missing', {}], ['the text "true"', { allowSensitiveActions: 'true' }], ['the number 1', { allowSensitiveActions: 1 }], ['null', { allowSensitiveActions: null }], ['no body', undefined]])(
    'refuses anything but a real boolean (%s) with nothing written',
    async (_label, body) => {
      const res = await patch(body, []);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(chatbotDb.setInteractiveShareAllowSensitiveActions).not.toHaveBeenCalled();
    },
  );

  it('is the owner\'s: another user\'s session, a missing session and a session with no active link are all not found, nothing written', async () => {
    for (const record of [session(share(), 'someone-else'), null, session(undefined), session(share({ isActive: false }))]) {
      const res = await patch({ allowSensitiveActions: true }, [record]);
      expect(res.status).toHaveBeenCalledWith(404);
    }
    expect(chatbotDb.setInteractiveShareAllowSensitiveActions).not.toHaveBeenCalled();
  });

  it('a sandbox account can not change it', async () => {
    const res = await patch({ allowSensitiveActions: true }, [], { userId: 'eval_test' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(chatbotDb.setInteractiveShareAllowSensitiveActions).not.toHaveBeenCalled();
  });

  it('does not claim a change that did not persist', async () => {
    const res = await patch({ allowSensitiveActions: true }, [session(share({ allowSensitiveActions: false })), session(share({ allowSensitiveActions: false }))]);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('a failed write is an error', async () => {
    (chatbotDb.setInteractiveShareAllowSensitiveActions as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    const res = await patch({ allowSensitiveActions: true }, [session(share({ allowSensitiveActions: false }))]);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
