/**
 * ENG-2782 S2 — the backend serves the generated widget bundle at
 * GET /embed/slack-start.js for script-tag embeds on any site.
 */
import express from 'express';
import request from 'supertest';
import slackStartEmbedRouter from '../../routes/slackStartEmbed';
import { SLACK_START_BUNDLE, SLACK_START_BUNDLE_SHA256 } from '../../embed/slackStartBundle.generated';

const app = () => {
  const a = express();
  a.use('/embed', slackStartEmbedRouter);
  return a;
};

it('serves the bundle as cacheable, sniff-proof JavaScript any site may load', async () => {
  const res = await request(app()).get('/embed/slack-start.js');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=86400');
  expect(res.headers['access-control-allow-origin']).toBe('*');
  expect(res.headers.etag).toBe(`"${SLACK_START_BUNDLE_SHA256}"`);
  expect(res.text).toBe(SLACK_START_BUNDLE);
});

it('answers 304 to a matching If-None-Match', async () => {
  const res = await request(app()).get('/embed/slack-start.js').set('If-None-Match', `"${SLACK_START_BUNDLE_SHA256}"`);
  expect(res.status).toBe(304);
});

it('ships an auto-binding bundle that targets the data attribute and stays within the 40 KB gzip budget', () => {
  expect(SLACK_START_BUNDLE).toContain('data-agentweb-slack-start');
  expect(require('zlib').gzipSync(SLACK_START_BUNDLE).length).toBeLessThanOrEqual(40 * 1024);
});
