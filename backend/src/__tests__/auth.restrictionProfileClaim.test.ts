/**
 * ENG-2816 (step 3): the restriction claim of a self-call.
 *
 * A share-link visitor acts under the OWNER's userId, so the self-call an MCP tool makes on their behalf is signed as the owner. The
 * route on the far side can only tell a visitor's schedule write from the owner's if the visitor's restriction rides along. It travels
 * ctx() -> mcpFetch -> the `_rp` claim of the self-call JWT -> authenticateToken -> `req.restrictionProfile`, and is trusted ONLY from
 * a verified `_svc` token (which only mcpFetch mints, signed with the server secret).
 */
import jwt from 'jsonwebtoken';

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(async (id: string) => ({ userId: id, email: 'owner@example.com', isAdmin: false, roles: ['customer'] })) },
}));

import { authenticateToken, restrictionProfileOfToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { generateSelfCallToken, mcpFetch } from '../mcp/server/httpClient';
import { ctx } from '../mcp/server/toolHelpers';

const owner = { userId: 'owner-1', email: 'owner@example.com', isAdmin: false } as any;

async function authenticate(token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  await authenticateToken(req, res, next);
  return { req, next, res };
}
const decode = (token: string) => jwt.decode(token) as Record<string, unknown>;
const signed = (claims: Record<string, unknown>, secret = getJwtSecret()) => jwt.sign({ userId: 'owner-1', email: 'owner@example.com', ...claims }, secret, { expiresIn: '5m' });

describe('the self-call token carries the restriction (generateSelfCallToken -> authenticateToken)', () => {
  it.each(['share_visitor', 'share_visitor_schedule'] as const)('a %s claim round-trips to req.restrictionProfile', async (profile) => {
    const token = generateSelfCallToken(owner, profile);
    expect(decode(token)._rp).toBe(profile);
    const { req, next } = await authenticate(token);
    expect(next).toHaveBeenCalled();
    expect(req.isSelfCall).toBe(true);
    expect(req.restrictionProfile).toBe(profile);
  });

  it('an unrestricted self-call token is byte-for-byte what it always was: no claim, no profile', async () => {
    const token = generateSelfCallToken(owner);
    expect(decode(token)).not.toHaveProperty('_rp');
    const { req } = await authenticate(token);
    expect(req.isSelfCall).toBe(true);
    expect(req.restrictionProfile).toBeUndefined();
  });

  it('is ignored on a token that is not a self-call token (an ordinary login cannot set it)', async () => {
    const { req, next } = await authenticate(signed({ _rp: 'share_visitor' }));
    expect(next).toHaveBeenCalled();
    expect(req.isSelfCall).toBe(false);
    expect(req.restrictionProfile).toBeUndefined();
  });

  it('is ignored on a delegate token, even one that also says _svc', () => {
    const delegate = { _svc: true, _rp: 'share_visitor', delegateAccess: { adminUserId: 'a', adminEmail: 'a@x', targetUserId: 'owner-1', targetEmail: 'owner@example.com' } } as any;
    expect(restrictionProfileOfToken(delegate)).toBeUndefined();
  });

  it('a token signed with the wrong secret authenticates nothing, so no claim can be forged', async () => {
    const forged = signed({ _svc: true, _rp: 'share_visitor' }, 'not-the-server-secret');
    const { req, next, res } = await authenticate(forged);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.restrictionProfile).toBeUndefined();
  });

  it('a claim that is present but not a known profile reads as the strictest profile, never as no claim', async () => {
    for (const value of ['something-new', 'constructor', 7, true, {}]) {
      const { req } = await authenticate(signed({ _svc: true, _rp: value }));
      expect(req.restrictionProfile).toBe('share_visitor');
    }
  });

  it('an empty or null claim is no claim', async () => {
    for (const value of ['', null, false]) {
      const { req } = await authenticate(signed({ _svc: true, _rp: value }));
      expect(req.restrictionProfile).toBeUndefined();
    }
  });
});

describe('ctx() hands the tool context\'s restriction to mcpFetch', () => {
  it('copies restrictionProfile (a field left out of this whitelist is a claim lost)', () => {
    expect(ctx({ userId: 'u', restrictionProfile: 'share_visitor' }).restrictionProfile).toBe('share_visitor');
    expect(ctx({ userId: 'u', restrictionProfile: 'share_visitor_schedule' }).restrictionProfile).toBe('share_visitor_schedule');
  });
  it('carries nothing for an unrestricted caller', () => {
    expect(ctx({ userId: 'u' }).restrictionProfile).toBeUndefined();
    expect(ctx(undefined).restrictionProfile).toBeUndefined();
  });
});

describe('mcpFetch signs the claim into the token it sends, end to end', () => {
  const realFetch = global.fetch;
  let sentAuthorization: string | undefined;
  let sentUrl: string | undefined;

  beforeEach(() => {
    sentAuthorization = undefined;
    sentUrl = undefined;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      sentUrl = url;
      sentAuthorization = init?.headers?.Authorization;
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    });
  });
  afterEach(() => { (global as any).fetch = realFetch; });

  const sentToken = () => String(sentAuthorization).replace('Bearer ', '');

  it('ctx -> mcpFetch -> JWT -> authenticateToken -> req.restrictionProfile', async () => {
    await mcpFetch({
      method: 'POST',
      path: '/api/agent-mode/scheduled-chats',
      context: ctx({ userId: 'owner-1', restrictionProfile: 'share_visitor', sessionId: 'sess-1' }),
      body: { scheduleName: 'x' },
    });
    expect(decode(sentToken())._rp).toBe('share_visitor');
    const { req } = await authenticate(sentToken());
    expect(req.restrictionProfile).toBe('share_visitor');
    expect(req.isSelfCall).toBe(true);
  });

  it('an unrestricted caller sends a token with no claim', async () => {
    await mcpFetch({ method: 'POST', path: '/api/agent-mode/scheduled-chats', context: ctx({ userId: 'owner-1' }), body: {} });
    expect(decode(sentToken())).not.toHaveProperty('_rp');
  });

  it('an unrecognised profile on the context is signed as the strictest one, not dropped', async () => {
    await mcpFetch({ method: 'POST', path: '/api/agent-mode/scheduled-chats', context: { userId: 'owner-1', restrictionProfile: 'weird' } as any, body: {} });
    expect(decode(sentToken())._rp).toBe('share_visitor');
  });

  describe('a pre-minted override token cannot carry the claim, so a restricted caller may not use it to change schedules', () => {
    const overrideToken = 'pre-minted-delegate-token';

    it('refuses a restricted schedule WRITE and sends nothing', async () => {
      for (const [method, path] of [
        ['POST', '/api/agent-mode/scheduled-chats'],
        ['PUT', '/api/agent-mode/scheduled-chats/abc'],
        ['PATCH', '/api/agent-mode/scheduled-chats/abc/toggle'],
        ['POST', '/api/agent-mode/schedule-templates/t1/use'],
      ] as const) {
        await expect(
          mcpFetch({ method, path, context: { userId: 'owner-1', restrictionProfile: 'share_visitor', overrideToken }, body: {} })
        ).rejects.toThrow(/restricted caller cannot change schedules/);
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still lets a restricted caller READ with an override token (that is how list_scheduled_chats client_id works)', async () => {
      await mcpFetch({ method: 'GET', path: '/api/agent-mode/scheduled-chats', context: { userId: 'owner-1', restrictionProfile: 'share_visitor', overrideToken } });
      expect(sentAuthorization).toBe(`Bearer ${overrideToken}`);
    });

    it('leaves an UNRESTRICTED override call untouched, writes included', async () => {
      await mcpFetch({ method: 'POST', path: '/api/agent-mode/scheduled-chats', context: { userId: 'owner-1', overrideToken }, body: {} });
      expect(sentAuthorization).toBe(`Bearer ${overrideToken}`);
    });

    it('a restricted override call to a route that is not a schedule write is untouched', async () => {
      await mcpFetch({ method: 'POST', path: '/api/crm/lists', context: { userId: 'owner-1', restrictionProfile: 'share_visitor', overrideToken }, body: {} });
      expect(sentUrl).toContain('/api/crm/lists');
    });
  });
});
