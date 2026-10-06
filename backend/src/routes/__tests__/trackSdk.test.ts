/** ENG-2315 — GET /sdk/v1/aw.js is public, cross-origin loadable and cacheable. */
import request from 'supertest';
import express from 'express';
import { sdkRouter } from '../trackSdk';

const makeApp = () => { const app = express(); app.use('/sdk/v1', sdkRouter); return app; };

describe('GET /sdk/v1/aw.js', () => {
  it('serves JS with CORS *, 5-minute public cache and an ETag; 304 on a matching If-None-Match', async () => {
    const app = makeApp();
    const res = await request(app).get('/sdk/v1/aw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/javascript/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(res.text).toContain('AgentWeb tracker v1');

    const again = await request(app).get('/sdk/v1/aw.js').set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
  });
});
