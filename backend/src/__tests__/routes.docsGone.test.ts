/**
 * AC1 (ENG-163): the retired hand-rolled docs endpoints — the API-docs array
 * (`/api/docs/api`) and the Notion user-guide sync (`/api/docs/user-guide*`) —
 * must be gone. They now return 410 Gone (docs consolidated on Mintlify).
 *
 * Sibling routes on the docs router are mocked so this isolates the docs router.
 */
jest.mock('../routes/release', () => {
  const express = require('express');
  const r = express.Router();
  r.get('/', (_req: any, res: any) => res.status(200).json({ ok: true }));
  return { __esModule: true, default: r };
});

jest.mock('../controllers/docsController', () => ({
  getUserReleaseNotes: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));

import express from 'express';
import request from 'supertest';
import docsRoutes from '../routes/docs';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/docs', docsRoutes);
  return a;
}

describe('retired legacy docs endpoints return 410 (ENG-163)', () => {
  it('GET /api/docs/api → 410 Gone', async () => {
    const res = await request(app()).get('/api/docs/api');
    expect(res.status).toBe(410);
    expect(res.body.message).toContain('docs.agentweb.pro');
  });

  it('GET /api/docs/user-guide → 410 Gone', async () => {
    const res = await request(app()).get('/api/docs/user-guide');
    expect(res.status).toBe(410);
  });

  it('POST /api/docs/user-guide/sync → 410 Gone (sync engine removed)', async () => {
    const res = await request(app())
      .post('/api/docs/user-guide/sync')
      .send({ direction: 'dev-to-prod' });
    expect(res.status).toBe(410);
  });

  it('GET /api/docs/user-guide/sync-status → 410 Gone', async () => {
    const res = await request(app()).get('/api/docs/user-guide/sync-status');
    expect(res.status).toBe(410);
  });

  it('still serves surviving docs routes (user-release)', async () => {
    const res = await request(app()).get('/api/docs/user-release');
    expect(res.status).toBe(200);
  });
});
