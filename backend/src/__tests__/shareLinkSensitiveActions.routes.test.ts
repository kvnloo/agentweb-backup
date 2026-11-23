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

  it('a request with no choice on an EXISTING link answers with what that link already was and changes nothing', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session(share({ allowSensitiveActions: true })));
    const res = await create({ sessionId: 's1', expirationDays: 7 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ allowSensitiveActions: true }));
    expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
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

  it('says what a link made BEFORE the setting existed means: a timed one is on, a no-expiry one is off, and that it was not chosen', async () => {
    const timed = await read(session(share({ expiresAt: '2027-01-01T00:00:00.000Z' })));
    expect(timed.json).toHaveBeenCalledWith({ allowSensitiveActions: true, explicit: false });
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

describe('PATCH /session/:id/conversable-share (updateConversableShareSettings)', () => {
  const patch = async (body: unknown, records: unknown[], user: unknown = OWNER) => {
    const read = chatbotDb.getChatSessionRecord as jest.Mock;
    records.forEach((r) => read.mockResolvedValueOnce(r));
    const res = makeRes();
    await agentModeController.updateConversableShareSettings(req({ params: { sessionId: 's1' }, body, user }), res);
    return res;
  };

  it('turns it ON for the existing link, changes nothing else about the link, and answers with the stored value', async () => {
    const res = await patch(
      { allowSensitiveActions: true },
      [session(share({ expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: false })), session(share({ expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: true }))],
    );
    expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith('s1', {
      isActive: true, token: 'tok123', sharedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ allowSensitiveActions: true, explicit: true });
  });

  it('turns it OFF, and can make an explicit choice on a link made before the setting existed', async () => {
    const res = await patch({ allowSensitiveActions: false }, [session(share({ expiresAt: '2027-01-01T00:00:00.000Z' })), session(share({ expiresAt: '2027-01-01T00:00:00.000Z', allowSensitiveActions: false }))]);
    expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith('s1', expect.objectContaining({ token: 'tok123', allowSensitiveActions: false }));
    expect(res.json).toHaveBeenCalledWith({ allowSensitiveActions: false, explicit: true });
  });

  it.each([['missing', {}], ['the text "true"', { allowSensitiveActions: 'true' }], ['the number 1', { allowSensitiveActions: 1 }], ['null', { allowSensitiveActions: null }], ['no body', undefined]])(
    'refuses anything but a real boolean (%s) with nothing written',
    async (_label, body) => {
      const res = await patch(body, []);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
    },
  );

  it('is the owner\'s: another user\'s session, a missing session and a session with no active link are all not found, nothing written', async () => {
    for (const record of [session(share(), 'someone-else'), null, session(undefined), session(share({ isActive: false }))]) {
      const res = await patch({ allowSensitiveActions: true }, [record]);
      expect(res.status).toHaveBeenCalledWith(404);
    }
    expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
  });

  it('a sandbox account can not change it', async () => {
    const res = await patch({ allowSensitiveActions: true }, [], { userId: 'eval_test' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
  });

  it('does not claim a change that did not persist', async () => {
    const res = await patch({ allowSensitiveActions: true }, [session(share({ allowSensitiveActions: false })), session(share({ allowSensitiveActions: false }))]);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('a failed write is an error', async () => {
    (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    const res = await patch({ allowSensitiveActions: true }, [session(share({ allowSensitiveActions: false }))]);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
