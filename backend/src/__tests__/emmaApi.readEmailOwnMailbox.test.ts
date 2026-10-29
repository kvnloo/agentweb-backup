/**
 * POST /api/emma/email with `own_mailbox_only` (set by the external-MCP
 * read_email tool): a teammate's org-shared mailbox is refused server-side,
 * the caller's own mailbox is served, and the internal path (no flag) is
 * unchanged.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const USERS: Record<string, any> = {
  'caller-1': { userId: 'caller-1', email: 'caller@example.com', isAdmin: false, roles: ['customer'] },
};

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(async (id: string) => USERS[id] ?? null) },
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0,
    effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  }),
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

const mockListEmails = jest.fn();
const mockSendEmail = jest.fn();
const mockResolveEmailAccount = jest.fn();
jest.mock('../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn().mockResolvedValue(undefined),
  resolveEmailAccount: (...args: any[]) => mockResolveEmailAccount(...args),
  withAccessGuard: (_u: any, _r: any, _o: any, read: () => any) => read(),
}));

import emmaApiRoutes from '../routes/emmaApi';

const SECRET = 'read-email-own-mailbox-secret';
const PROVIDER = { listEmails: mockListEmails, sendEmail: mockSendEmail };
const accountOwnedBy = (ownerUserId: string) => ({ platform: 'gmail', provider: PROVIDER, accountId: 'acct-1', ownerUserId });

let app: express.Application;
const token = () => jwt.sign({ userId: 'caller-1', email: 'caller@example.com', isAdmin: false }, SECRET, { expiresIn: 300 });
const post = (body: Record<string, unknown>) =>
  request(app).post('/api/emma/email').set('Authorization', `Bearer ${token()}`).send(body);

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  app = express();
  app.use(express.json());
  app.use('/api/emma', emmaApiRoutes);
});
afterAll(() => { delete process.env.JWT_SECRET; });
beforeEach(() => {
  jest.clearAllMocks();
  mockListEmails.mockResolvedValue([{ id: 'm1' }]);
});

describe('POST /api/emma/email own_mailbox_only', () => {
  it('refuses a teammate-shared mailbox for external read_email and never calls the provider', async () => {
    mockResolveEmailAccount.mockResolvedValue(accountOwnedBy('teammate-9'));
    const res = await post({ account_id: 'acct-1', action: 'list', own_mailbox_only: true });
    expect(res.status).toBe(403);
    expect(mockListEmails).not.toHaveBeenCalled();
  });

  it("serves the caller's own mailbox for external read_email", async () => {
    mockResolveEmailAccount.mockResolvedValue(accountOwnedBy('caller-1'));
    const res = await post({ account_id: 'acct-1', action: 'list', own_mailbox_only: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emails: [{ id: 'm1' }], count: 1 });
  });

  it('leaves the internal path (no flag) unchanged: teammate-shared read still served', async () => {
    mockResolveEmailAccount.mockResolvedValue(accountOwnedBy('teammate-9'));
    const res = await post({ account_id: 'acct-1', action: 'list' });
    expect(res.status).toBe(200);
    expect(mockListEmails).toHaveBeenCalledWith('teammate-9', 'acct-1', 'INBOX', 20);
  });

  it('rejects a get with more than 50 message_ids before calling the provider', async () => {
    const mockGetEmails = jest.fn().mockResolvedValue([]);
    mockResolveEmailAccount.mockResolvedValue({ ...accountOwnedBy('caller-1'), provider: { ...PROVIDER, getEmails: mockGetEmails } });
    const ids = Array.from({ length: 51 }, (_, i) => `m${i}`);
    const res = await post({ account_id: 'acct-1', action: 'get', message_ids: ids, own_mailbox_only: true });
    expect(res.status).toBe(400);
    expect(mockGetEmails).not.toHaveBeenCalled();

    const ok = await post({ account_id: 'acct-1', action: 'get', message_ids: ids.slice(0, 50), own_mailbox_only: true });
    expect(ok.status).toBe(200);
    expect(mockGetEmails).toHaveBeenCalledTimes(1);
  });
});
