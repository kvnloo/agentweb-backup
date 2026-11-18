/**
 * ENG-2988: the pieces the other file tests fake, run for real:
 *  - the real login middleware (a normal login, an admin, a delegated admin session, an in-process tool call with a self-call token) in front
 *    of the real file routes, so "who counts as a real admin" is proven end to end;
 *  - the real uploader (only the AWS client is faked), so what /html authorises is compared with the key the upload really writes.
 */
const mockUpload = jest.fn();
const mockGetSignedUrl = jest.fn();
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  return {
    ...actual,
    S3: jest.fn(() => ({
      upload: (...a: any[]) => ({ promise: async () => mockUpload(...a) }),
      getSignedUrl: (...a: any[]) => mockGetSignedUrl(...a),
      getObject: jest.fn(() => ({ createReadStream: () => require('stream').Readable.from([Buffer.from('<html>content</html>')]) })),
      headObject: jest.fn(() => ({ promise: async () => ({ ContentType: 'text/html' }) })),
    })),
  };
});
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: { getTaskById: jest.fn(), getTaskExecutionOwnerById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn().mockImplementation(() => ({ clearSearchableTextByUrl: jest.fn().mockResolvedValue(undefined) })),
  chatbotDb: { getChatSessionRecord: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { userDb, taskDb, orgDb } from '../services/db';
import { getPresignedFileUrl, getFileContent, saveHtmlContent } from '../controllers/filesController';
import { authenticateToken } from '../middleware/auth';

const HOST = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com';
const OWN = 'users/me/files/1/abc/mine.html';
const OTHER = 'users/other/files/1/abc/secret.html';

const users: Record<string, any> = {
  me: { userId: 'me', email: 'me@example.com', isAdmin: false, roles: ['customer'], orgId: 'orgA', orgRole: 'member' },
  other: { userId: 'other', email: 'other@example.com', isAdmin: false, roles: ['customer'], orgId: 'orgB', orgRole: 'member' },
  root: { userId: 'root', email: 'root@example.com', isAdmin: true, roles: ['partner'] },
};
const secret = () => process.env.JWT_SECRET!;
const loginToken = (userId: string) => jwt.sign({ userId, email: users[userId].email }, secret());
/** A token an in-process tool call carries: the claims are trusted as they are, and may say isAdmin. */
const selfCallToken = (userId: string, isAdmin: boolean) => jwt.sign({ userId, email: users[userId].email, isAdmin, _svc: true }, secret());
/** An admin session acting as another user (the real delegation shape). */
const delegatedToken = (adminId: string, targetId: string) =>
  jwt.sign({ userId: adminId, email: users[adminId].email, delegateAccess: { adminUserId: adminId, adminEmail: users[adminId].email, targetUserId: targetId, targetEmail: users[targetId].email }, dte: 0, sv: 0 }, secret());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let app: express.Application;
beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => users[id]);
  (taskDb.getTaskById as jest.Mock).mockResolvedValue(undefined);
  (taskDb.getTaskExecutionOwnerById as jest.Mock).mockResolvedValue(undefined);
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: 'orgA', ownerUserId: 'boss', shareSettings: {} });
  mockGetSignedUrl.mockImplementation((_op: string, params: any) => `https://signed.example.com/${encodeURIComponent(params.Key)}`);
  mockUpload.mockImplementation((params: any) => ({ Location: `${HOST}/${params.Key}`, Key: params.Key }));
  app = express();
  app.use(express.json());
  app.get('/api/files/presign', authenticateToken, getPresignedFileUrl);
  app.get('/api/files/content', authenticateToken, getFileContent);
  app.post('/api/files/html', authenticateToken, saveHtmlContent);
});
afterEach(() => jest.restoreAllMocks());

describe('who counts as a real admin, through the real login middleware', () => {
  const presign = (token: string, key: string) => request(app).get('/api/files/presign').set(bearer(token)).query({ key });

  it('a normal login reads its own file and not another organisation\'s', async () => {
    expect((await presign(loginToken('me'), OWN)).status).toBe(200);
    expect((await presign(loginToken('me'), OTHER)).status).toBe(404);
  });

  it('a real admin login reads anyone\'s file', async () => {
    expect((await presign(loginToken('root'), OTHER)).status).toBe(200);
  });

  it('a delegated admin session is the target user and has no admin power', async () => {
    const asMe = delegatedToken('root', 'me');
    expect((await presign(asMe, OWN)).status).toBe(200);
    expect((await presign(asMe, OTHER)).status).toBe(404);
    expect((await request(app).get('/api/files/content').set(bearer(asMe)).query({ url: `${HOST}/${OTHER}` })).status).toBe(404);
  });

  it('an in-process tool call is not an admin even when its token says isAdmin (a delegated session mints such tokens)', async () => {
    const tool = selfCallToken('root', true);
    expect((await presign(tool, OTHER)).status).toBe(404);
    expect((await request(app).get('/api/files/content').set(bearer(tool)).query({ url: `${HOST}/${OTHER}` })).status).toBe(404);
    expect((await request(app).post('/api/files/html').set(bearer(tool)).send({ url: `${HOST}/${OTHER}`, content: 'x' })).status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('an in-process tool call still reaches its own user\'s files', async () => {
    expect((await presign(selfCallToken('me', false), OWN)).status).toBe(200);
  });
});

describe('the key /html authorises is the key the real uploader writes', () => {
  const save = (userId: string, url: string) => request(app).post('/api/files/html').set(bearer(loginToken(userId))).send({ url, content: '<html>new</html>' });

  it.each([
    ['a plain name', 'mine.html', 'users/me/files/1/abc/mine.html'],
    ['spaces, accents and an escaped #', 'my%20r%C3%A9sum%C3%A9%20%231.html', 'users/me/files/1/abc/my_resume__1.html'],
    ['a name with a quote and a percent', 'a%22b%25c.html', 'users/me/files/1/abc/a_b_c.html'],
    ['non-ASCII letters', '%E6%97%A5%E6%9C%AC.html', 'users/me/files/1/abc/__.html'],
  ])('%s: writes %s to %s', async (_name, fileName, expectedKey) => {
    const res = await save('me', `${HOST}/users/me/files/1/abc/${fileName}`);
    expect(res.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][0].Key).toBe(expectedKey);
    expect(res.body.key).toBe(expectedKey);
  });

  it('never writes under another owner, whatever the file name is rewritten into', async () => {
    for (const fileName of ['mine.html', 'my%20r%C3%A9sum%C3%A9.html', '%E2%80%A4%E2%80%A4']) {
      const res = await save('me', `${HOST}/users/other/files/1/abc/${fileName}`);
      expect(res.status).toBe(404);
    }
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('refuses a name that the uploader would rewrite into a dot segment', async () => {
    const res = await save('me', `${HOST}/users/me/files/1/abc/%E2%80%A4%E2%80%A4`); // two "one dot leader" characters normalise to ".."
    expect(res.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('writes nothing for a key that is not one well-formed key', async () => {
    for (const url of [`${HOST}/users/me/%2e%2e/other/files/1/abc/x.html`, `${HOST}/users//me/files/x.html`, `${HOST}/${'a/'.repeat(600)}x.html`]) {
      const res = await save('me', url);
      expect([404, 400]).toContain(res.status);
    }
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
