/**
 * ENG-2962: the auth middleware marks requests made with a self-call token (`_svc`, minted only by mcpFetch for MCP tools) so
 * routes can tell an MCP tool acting on someone's behalf from a person in the app.
 */
import jwt from 'jsonwebtoken';

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async (id: string) => ({ userId: id, email: 'u@example.com', isAdmin: false, roles: ['customer'] })) } }));

import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { generateSelfCallToken } from '../mcp/server/httpClient';

async function authenticate(token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  await authenticateToken(req, res, next);
  return { req, next, res };
}

describe('authenticateToken isSelfCall', () => {
  it('is true for a self-call token minted by mcpFetch', async () => {
    const { req, next } = await authenticate(generateSelfCallToken({ userId: 'u-1', email: 'u@example.com', isAdmin: false } as any));
    expect(next).toHaveBeenCalled();
    expect(req.isSelfCall).toBe(true);
  });

  it('is false for a normal app login', async () => {
    const { req, next } = await authenticate(jwt.sign({ userId: 'u-1', email: 'u@example.com' }, getJwtSecret(), { expiresIn: '1h' }));
    expect(next).toHaveBeenCalled();
    expect(req.isSelfCall).toBe(false);
  });
});
