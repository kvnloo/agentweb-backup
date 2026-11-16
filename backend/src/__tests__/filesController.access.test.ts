/**
 * ENG-2988: /api/files/presign, /presign-batch, /content and /html used to act on any key of the bucket for any signed-in user (user B could
 * read, or overwrite, user A's file). Driven over HTTP with the real access policy and the real URL parsing; only storage and the database are
 * faked. Fixtures: `me` and `mate` share an organisation, `other` is in another one, `root` is an admin.
 */
// Login is faked from headers (x-user, x-admin, x-delegated, x-selfcall); isRealAdmin is the real function.
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const userId = req.headers['x-user'];
    if (!userId) return res.status(401).json({ message: 'No token provided' });
    req.user = { userId, email: `${userId}@example.com`, isAdmin: req.headers['x-admin'] === '1' };
    if (req.headers['x-delegated'] === '1') req.delegateInfo = { isDelegated: true };
    if (req.headers['x-selfcall'] === '1') req.isSelfCall = true;
    next();
  },
  isRealAdmin: jest.requireActual('../middleware/auth').isRealAdmin,
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: { getTaskById: jest.fn(), getTaskExecutionOwnerById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn().mockImplementation(() => ({ clearSearchableTextByUrl: jest.fn().mockResolvedValue(undefined) })),
  chatbotDb: { getChatSessionRecord: jest.fn() },
}));

const mockGetStream = jest.fn();
const mockGetMetadata = jest.fn();
const mockUpload = jest.fn();
const mockSign = jest.fn();
jest.mock('../utils/s3Utils', () => {
  const actual = jest.requireActual('../utils/s3Utils');
  return {
    ...actual,
    getS3ObjectStream: (...a: any[]) => mockGetStream(...a),
    getS3ObjectMetadata: (...a: any[]) => mockGetMetadata(...a),
    uploadFileToS3WithPath: (...a: any[]) => mockUpload(...a),
    generatePresignedUrl: (...a: any[]) => mockSign(...a),
  };
});

import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { userDb, taskDb, orgDb } from '../services/db';
import { getPresignedFileUrl, batchPresignUrls, getFileContent, saveHtmlContent } from '../controllers/filesController';
import { authenticateToken } from '../middleware/auth';

const HOST = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com';
const OWN = 'users/me/files/1/abc/mine.html';
const MATE = 'users/mate/files/1/abc/theirs.html';
const OTHER = 'users/other/files/1/abc/secret.html';

const users: Record<string, any> = {
  me: { userId: 'me', orgId: 'orgA', orgRole: 'member' },
  mate: { userId: 'mate', orgId: 'orgA', orgRole: 'member' },
  other: { userId: 'other', orgId: 'orgB', orgRole: 'member' },
  root: { userId: 'root' },
};

let app: express.Application;
const as = (user: string, extra: Record<string, string> = {}) => ({ 'x-user': user, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => users[id]);
  (taskDb.getTaskById as jest.Mock).mockResolvedValue(undefined);
  (taskDb.getTaskExecutionOwnerById as jest.Mock).mockResolvedValue(undefined);
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: 'orgA', ownerUserId: 'boss', shareSettings: {} });
  mockSign.mockImplementation((key: string) => `https://signed.example.com/${encodeURIComponent(key)}`);
  mockGetMetadata.mockResolvedValue({ ContentType: 'text/html' });
  mockGetStream.mockImplementation(() => Readable.from([Buffer.from('<html>content</html>')]));
  // like the real uploader: the last key segment is rewritten by the real sanitiser
  mockUpload.mockImplementation(async (_c: string, filename: string, _t: string, path: string) => {
    const key = `${path}/${jest.requireActual('../utils/s3Utils').sanitizeS3Filename(filename)}`;
    return { success: true, key, url: `${HOST}/${key}` };
  });

  app = express();
  app.use(express.json());
  app.get('/api/files/content', authenticateToken, getFileContent);
  app.post('/api/files/html', authenticateToken, saveHtmlContent);
  app.get('/api/files/presign', authenticateToken, getPresignedFileUrl);
  app.post('/api/files/presign-batch', authenticateToken, batchPresignUrls);
});

describe('GET /api/files/presign', () => {
  it('requires a login', async () => {
    const res = await request(app).get('/api/files/presign').query({ key: OWN });
    expect(res.status).toBe(401);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('signs the caller\'s own key, exactly as checked', async () => {
    const res = await request(app).get('/api/files/presign').set(as('me')).query({ key: OWN });
    expect(res.status).toBe(200);
    expect(res.body.presignedUrl).toContain(encodeURIComponent(OWN));
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSign.mock.calls[0][0]).toBe(OWN);
  });

  it('refuses another organisation\'s file by key, by URL, and answers like a missing file', async () => {
    const byKey = await request(app).get('/api/files/presign').set(as('me')).query({ key: OTHER });
    const byUrl = await request(app).get('/api/files/presign').set(as('me')).query({ url: `${HOST}/${OTHER}` });
    for (const res of [byKey, byUrl]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'File not found.' });
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('lets a teammate read shared files, and a real admin read anything', async () => {
    const mate = await request(app).get('/api/files/presign').set(as('me')).query({ key: MATE });
    const admin = await request(app).get('/api/files/presign').set(as('root', { 'x-admin': '1' })).query({ key: OTHER });
    expect(mate.status).toBe(200);
    expect(admin.status).toBe(200);
  });

  it('gives a delegated admin the target user\'s access only', async () => {
    const own = await request(app).get('/api/files/presign').set(as('me', { 'x-admin': '1', 'x-delegated': '1' })).query({ key: OWN });
    const cross = await request(app).get('/api/files/presign').set(as('me', { 'x-admin': '1', 'x-delegated': '1' })).query({ key: OTHER });
    expect(own.status).toBe(200);
    expect(cross.status).toBe(404);
  });

  it.each([
    ['parent segment', 'users/me/../other/files/1/abc/secret.html'],
    ['backslash', 'users\\other\\files\\1\\abc\\secret.html'],
    ['query', `${OTHER}?x=${OWN}`],
    ['fragment', `${OTHER}#${OWN}`],
    ['leading slash', `/${OTHER}`],
    ['empty segment', 'users//other/files/1/abc/secret.html'],
    ['unknown shape', 'test.html'],
  ])('refuses a key that is not one well-formed key or shape (%s)', async (_n, key) => {
    const res = await request(app).get('/api/files/presign').set(as('me')).query({ key });
    expect(res.status).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('checks the path a URL really resolves to, so a dot-dot dressed as the caller\'s own folder does not pass', async () => {
    const res = await request(app)
      .get('/api/files/presign')
      .set(as('me'))
      .query({ url: `${HOST}/users/me/%2e%2e/other/files/1/abc/secret.html` });
    expect(res.status).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('ignores the query string of an already presigned URL and signs the decoded key (names with spaces now work)', async () => {
    const own = 'users/me/files/1/abc/my file.html';
    const res = await request(app)
      .get('/api/files/presign')
      .set(as('me'))
      .query({ url: `${HOST}/users/me/files/1/abc/my%20file.html?X-Amz-Signature=abc&X-Amz-Expires=3600` });
    expect(res.status).toBe(200);
    expect(mockSign.mock.calls[0][0]).toBe(own);
  });

  it('keeps the existing 400s for a URL outside the bucket and for no key at all', async () => {
    const outside = await request(app).get('/api/files/presign').set(as('me')).query({ url: 'https://evil.example.com/x.html' });
    const none = await request(app).get('/api/files/presign').set(as('me'));
    expect(outside.status).toBe(400);
    expect(none.status).toBe(400);
  });
});

describe('POST /api/files/presign-batch', () => {
  it('signs only the entries the caller may read and leaves the rest out', async () => {
    const urls = [`${HOST}/${OWN}`, `${HOST}/${MATE}`, `${HOST}/${OTHER}`, 'https://evil.example.com/x.html', `${HOST}/users/me/../other/files/1/abc/secret.html`];
    const res = await request(app).post('/api/files/presign-batch').set(as('me')).send({ urls });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.urls).sort()).toEqual([`${HOST}/${MATE}`, `${HOST}/${OWN}`].sort());
    const signed = mockSign.mock.calls.map((c) => c[0]);
    expect(signed).toEqual(expect.arrayContaining([OWN, MATE]));
    expect(signed).not.toContain(OTHER);
  });

  it('requires a login', async () => {
    const res = await request(app).post('/api/files/presign-batch').send({ urls: [`${HOST}/${OWN}`] });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/files/content', () => {
  it('returns the caller\'s own file and a teammate\'s shared file', async () => {
    const own = await request(app).get('/api/files/content').set(as('me')).query({ url: `${HOST}/${OWN}` });
    const mate = await request(app).get('/api/files/content').set(as('me')).query({ url: `${HOST}/${MATE}` });
    expect(own.status).toBe(200);
    expect(own.body.content).toBe('<html>content</html>');
    expect(mate.status).toBe(200);
    expect(mockGetStream.mock.calls.map((c) => c[0])).toEqual([OWN, MATE]);
  });

  it('refuses another organisation\'s file without ever opening it', async () => {
    const res = await request(app).get('/api/files/content').set(as('me')).query({ url: `${HOST}/${OTHER}` });
    expect(res.status).toBe(404);
    expect(mockGetStream).not.toHaveBeenCalled();
    expect(mockGetMetadata).not.toHaveBeenCalled();
  });

  it('still blocks URLs outside the bucket', async () => {
    const res = await request(app).get('/api/files/content').set(as('me')).query({ url: 'https://example.com/x.html' });
    expect(res.status).toBe(403);
  });

  it('lets a real admin read any file', async () => {
    const res = await request(app).get('/api/files/content').set(as('root', { 'x-admin': '1' })).query({ url: `${HOST}/${OTHER}` });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/files/html', () => {
  const body = (key: string) => ({ url: `${HOST}/${key}`, content: '<html>new</html>' });

  it('saves over the caller\'s own file', async () => {
    const res = await request(app).post('/api/files/html').set(as('me')).send(body(OWN));
    expect(res.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledWith('<html>new</html>', 'mine.html', 'text/html', 'users/me/files/1/abc');
  });

  it('refuses to overwrite another user\'s file, even a teammate\'s, and never uploads', async () => {
    const stranger = await request(app).post('/api/files/html').set(as('me')).send(body(OTHER));
    const teammate = await request(app).post('/api/files/html').set(as('me')).send(body(MATE));
    expect(stranger.status).toBe(404);
    expect(teammate.status).toBe(403); // may open it, may not change it
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('refuses a dot-dot that would land in another user\'s folder', async () => {
    const res = await request(app)
      .post('/api/files/html')
      .set(as('me'))
      .send({ url: `${HOST}/users/me/%2e%2e/other/files/1/abc/secret.html`, content: 'x' });
    expect(res.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('authorises the key the upload will really write (it rewrites odd characters in the file name)', async () => {
    const own = await request(app).post('/api/files/html').set(as('me')).send(body('users/me/files/1/abc/my report.html'));
    expect(own.status).toBe(200);
    const other = await request(app).post('/api/files/html').set(as('me')).send(body('users/other/files/1/abc/my report.html'));
    expect(other.status).toBe(404);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('lets a real admin save, and a delegated admin only inside the target\'s own space', async () => {
    const admin = await request(app).post('/api/files/html').set(as('root', { 'x-admin': '1' })).send(body(OTHER));
    expect(admin.status).toBe(200);
    const delegated = await request(app).post('/api/files/html').set(as('me', { 'x-admin': '1', 'x-delegated': '1' })).send(body(OTHER));
    expect(delegated.status).toBe(404);
  });
});

describe('ENG-2988 review follow-ups', () => {
  const warnings = () => (console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a path-style URL and escaped slashes name the same keys, and are checked the same way', async () => {
    const pathStyle = `https://s3.us-west-2.amazonaws.com/agentweb-user-files/${OWN}`;
    expect((await request(app).get('/api/files/presign').set(as('me')).query({ url: pathStyle })).status).toBe(200);
    const pathStyleOther = `https://s3.us-west-2.amazonaws.com/agentweb-user-files/${OTHER}`;
    expect((await request(app).get('/api/files/presign').set(as('me')).query({ url: pathStyleOther })).status).toBe(404);
    const escapedOwn = `${HOST}/${OWN.replace(/\//g, '%2F')}`;
    const escapedOther = `${HOST}/${OTHER.replace(/\//g, '%2F')}`;
    expect((await request(app).get('/api/files/presign').set(as('me')).query({ url: escapedOwn })).status).toBe(200);
    expect(mockSign.mock.calls.at(-1)![0]).toBe(OWN);
    expect((await request(app).get('/api/files/presign').set(as('me')).query({ url: escapedOther })).status).toBe(404);
  });

  it('an in-process tool call (self-call token) never gets admin power over other people\'s files', async () => {
    const asTool = as('root', { 'x-admin': '1', 'x-selfcall': '1' });
    expect((await request(app).get('/api/files/presign').set(asTool).query({ key: OTHER })).status).toBe(404);
    expect((await request(app).get('/api/files/content').set(asTool).query({ url: `${HOST}/${OTHER}` })).status).toBe(404);
    expect((await request(app).post('/api/files/html').set(asTool).send({ url: `${HOST}/${OTHER}`, content: 'x' })).status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('a teammate who may open a file but not change it is told so (403), a stranger gets "not found"', async () => {
    const teammate = await request(app).post('/api/files/html').set(as('me')).send({ url: `${HOST}/${MATE}`, content: 'x' });
    expect(teammate.status).toBe(403);
    expect(teammate.body).toEqual({ success: false, message: 'You can view this file, but only its owner can change it.' });
    const stranger = await request(app).post('/api/files/html').set(as('me')).send({ url: `${HOST}/${OTHER}`, content: 'x' });
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual({ success: false, message: 'File not found.' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when the access check itself cannot run, answers 503 "try again" instead of "not found", and a batch leaves the entry out', async () => {
    (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    const presign = await request(app).get('/api/files/presign').set(as('me')).query({ key: MATE });
    const content = await request(app).get('/api/files/content').set(as('me')).query({ url: `${HOST}/${MATE}` });
    const html = await request(app).post('/api/files/html').set(as('me')).send({ url: `${HOST}/${OWN.replace('mine', 'x')}`, content: 'x' });
    expect(presign.status).toBe(503);
    expect(content.status).toBe(503);
    expect(presign.body.message).toMatch(/try again/i);
    expect(html.status).toBe(200); // the caller's own key needs no lookup
    const batch = await request(app).post('/api/files/presign-batch').set(as('me')).send({ urls: [`${HOST}/${MATE}`, `${HOST}/${OWN}`] });
    expect(Object.keys(batch.body.urls)).toEqual([`${HOST}/${OWN}`]);
  });

  it('files of an anonymous visitor\'s plan session can be read by a signed-in user but not changed', async () => {
    const anon = `${HOST}/users/anon_3f2a9c/files/1/abc/plan.html`;
    expect((await request(app).get('/api/files/content').set(as('me')).query({ url: anon })).status).toBe(200);
    expect((await request(app).post('/api/files/html').set(as('me')).send({ url: anon, content: 'x' })).status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('an execution folder under the wrong task is refused for read and write', async () => {
    (taskDb.getTaskExecutionOwnerById as jest.Mock).mockResolvedValue({ executionId: 'e-me', userId: 'me', taskId: 't-me' });
    const wrong = `${HOST}/tasks/t-victim/executions/e-me/x.html`;
    expect((await request(app).get('/api/files/content').set(as('me')).query({ url: wrong })).status).toBe(404);
    expect((await request(app).post('/api/files/html').set(as('me')).send({ url: wrong, content: 'x' })).status).toBe(404);
    const right = `${HOST}/tasks/t-me/executions/e-me/x.html`;
    expect((await request(app).get('/api/files/content').set(as('me')).query({ url: right })).status).toBe(200);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('refuses a file name that the uploader would rewrite into a dot segment (two "one dot leader" characters normalise to "..")', async () => {
    const res = await request(app).post('/api/files/html').set(as('me')).send({ url: `${HOST}/users/me/files/1/abc/%E2%80%A4%E2%80%A4`, content: 'x' });
    expect(res.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('writes exactly the key it authorised (the real file-name rewriting is applied to both)', async () => {
    const res = await request(app).post('/api/files/html').set(as('me')).send({ url: `${HOST}/users/me/files/1/abc/my%20r%C3%A9sum%C3%A9%20%231.html`, content: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('users/me/files/1/abc/my_resume__1.html'); // accents dropped, the space and the # each become _
    const sameNameInOtherFolder = await request(app).post('/api/files/html').set(as('me')).send({ url: `${HOST}/users/other/files/1/abc/my%20r%C3%A9sum%C3%A9%20%231.html`, content: 'x' });
    expect(sameNameInOtherFolder.status).toBe(404);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('signs a key that contains an escaped # or ? as one object (it used to sign the wrong one)', async () => {
    const res = await request(app).get('/api/files/presign').set(as('me')).query({ url: `${HOST}/users/me/files/1/abc/Report%20%232%3F.pdf` });
    expect(res.status).toBe(200);
    expect(mockSign.mock.calls[0][0]).toBe('users/me/files/1/abc/Report #2?.pdf');
  });

  it('logs a refusal with the kind of file, the reason and the caller, never the key or the caller-chosen text', async () => {
    await request(app).get('/api/files/presign').set(as('me')).query({ key: 'users/other/files/1/abc/secret-name.html' });
    await request(app).get('/api/files/presign').set(as('me')).query({ key: 'attacker-chosen-segment/secret-name.html' });
    const logged = warnings();
    expect(logged).toContain('storage_access_denied');
    expect(logged).toContain('"shape":"users/*/files"');
    expect(logged).toContain('"shape":"other"');
    expect(logged).not.toContain('secret-name');
    expect(logged).not.toContain('attacker-chosen');
  });
});
