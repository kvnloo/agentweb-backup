/**
 * ENG-2327: characterization of POST /api/tracking/session-lists (ENG-2315), written BEFORE the
 * list-creation logic was extracted into services/sessionTrackingService.ts. It pins the exact
 * createLeadList call and the response shape, so the extraction is provably behaviour-neutral.
 */
const mockCreateLeadList = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: { createLeadList: (...a: any[]) => mockCreateLeadList(...a) },
  userDb: {},
  orgDb: {},
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'u1' }; next(); },
}));

import request from 'supertest';
import express from 'express';
import trackingRouter, { buildEmbedSnippet, SESSION_LIST_DISPLAY_FIELDS } from '../routes/tracking';

const app = express();
app.use(express.json());
app.use('/api/tracking', trackingRouter);

describe('POST /api/tracking/session-lists', () => {
  const prevBackend = process.env.BACKEND_URL;
  beforeEach(() => {
    process.env.BACKEND_URL = 'https://api.example.test/';
    mockCreateLeadList.mockImplementation(async (userId: string, name: string) => ({ listId: 'list_abc123', userId, name }));
  });
  afterAll(() => { process.env.BACKEND_URL = prevBackend; });

  it('creates a system-managed public session list with the exact createLeadList arguments', async () => {
    const res = await request(app)
      .post('/api/tracking/session-lists')
      .send({ name: ' My LP ', allowedOrigins: ['https://Example.com'], pageLabel: 'home' });
    expect(res.status).toBe(201);
    expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
    expect(mockCreateLeadList).toHaveBeenCalledWith(
      'u1', 'My LP', '',
      [],
      null, false, undefined, undefined, undefined,
      'session',
      true,
      undefined,
      {
        publicAccessEnabled: true,
        displayFields: SESSION_LIST_DISPLAY_FIELDS,
        trackingConfig: { allowedOrigins: ['https://example.com'], pageLabel: 'home' },
      },
    );
    expect(res.body.trackingConfig).toEqual({ allowedOrigins: ['https://example.com'], pageLabel: 'home' });
    expect(res.body.embedSnippet).toBe(
      '<script src="https://api.example.test/sdk/v1/aw.js" data-aw-list="list_abc123" async></script>',
    );
    expect(res.body.embedSnippet).toBe(buildEmbedSnippet('list_abc123'));
  });

  it.each([
    [{ name: 'x', allowedOrigins: [] }, 'origins_required'],
    [{ allowedOrigins: ['https://a.com'] }, 'invalid_name'],
    [{ name: 'x', allowedOrigins: ['https://a.com'], bogus: 1 }, 'unknown_field'],
    [{ name: 'x', allowedOrigins: ['http://a.com'] }, 'invalid_origin'],
  ])('rejects %j with 400 %s and writes nothing', async (body, code) => {
    const res = await request(app).post('/api/tracking/session-lists').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(mockCreateLeadList).not.toHaveBeenCalled();
  });
});
