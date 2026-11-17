/**
 * ENG-3084: the client-health routes must hand the service the client name or
 * email exactly as the caller sent it. Express has already decoded route
 * params, so a second decodeURIComponent turned a literal "%" into a 500 and
 * silently rewrote escape-shaped text such as "%41".
 */

jest.mock('../services/clientHealthService', () => ({
  assessClientHealth: jest.fn(),
  listAllClients: jest.fn(),
  readClientMetaActivity: jest.fn(),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import clientHealthRoutes from '../routes/clientHealth';
import { assessClientHealth, readClientMetaActivity } from '../services/clientHealthService';

const mockAssess = assessClientHealth as jest.Mock;
const mockActivity = readClientMetaActivity as jest.Mock;

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { userId: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true };
    next();
  });
  app.use('/api/client-health', clientHealthRoutes);
  return app;
}

describe('client-health routes pass the client name through unchanged (ENG-3084)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssess.mockResolvedValue({ success: true });
    mockActivity.mockResolvedValue({ success: true });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('GET /:clientEmail passes a name containing a literal % to assessClientHealth', async () => {
    const res = await request(buildApp()).get(`/api/client-health/${encodeURIComponent('Acme 50% Off')}`);

    expect(res.status).toBe(200);
    expect(mockAssess).toHaveBeenCalledWith('admin-1', 'Acme 50% Off', true);
  });

  it('GET /:clientEmail/meta-activity passes a name containing a literal % to readClientMetaActivity', async () => {
    const res = await request(buildApp()).get(
      `/api/client-health/${encodeURIComponent('Acme 50% Off')}/meta-activity`,
    );

    expect(res.status).toBe(200);
    expect(mockActivity).toHaveBeenCalledWith('admin-1', 'Acme 50% Off', expect.any(Object), true);
  });

  it('does not rewrite escape-shaped text in the name', async () => {
    const app = buildApp();
    await request(app).get(`/api/client-health/${encodeURIComponent('Promo %41 Team')}`);
    await request(app).get(`/api/client-health/${encodeURIComponent('Promo %41 Team')}/meta-activity`);

    expect(mockAssess).toHaveBeenCalledWith('admin-1', 'Promo %41 Team', true);
    expect(mockActivity).toHaveBeenCalledWith('admin-1', 'Promo %41 Team', expect.any(Object), true);
  });

  it('ordinary emails, including one with +, resolve as before', async () => {
    const app = buildApp();
    await request(app).get(`/api/client-health/${encodeURIComponent('client@example.com')}`);
    await request(app).get(`/api/client-health/${encodeURIComponent('jane+ads@example.com')}`);
    await request(app).get(`/api/client-health/${encodeURIComponent('jane+ads@example.com')}/meta-activity`);

    expect(mockAssess).toHaveBeenNthCalledWith(1, 'admin-1', 'client@example.com', true);
    expect(mockAssess).toHaveBeenNthCalledWith(2, 'admin-1', 'jane+ads@example.com', true);
    expect(mockActivity).toHaveBeenCalledWith('admin-1', 'jane+ads@example.com', expect.any(Object), true);
  });
});
