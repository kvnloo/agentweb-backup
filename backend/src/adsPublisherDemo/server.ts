/**
 * ENG-2430 — mock HTTP endpoint for the Ads Auto Publisher demo.
 * POST /v1/publish -> planPublish(); dryRun is always forced on (a client
 * sending dryRun:false still gets a dry run). Local demo only; not mounted in app.ts.
 *
 *   npx ts-node src/adsPublisherDemo/server.ts   # listens on 127.0.0.1:4430
 */
import http from 'http';
import { planPublish } from './planner';

export function handlePublish(body: string): { status: number; json: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, json: { dryRun: true, valid: false, errors: ['body must be valid JSON'], objects: [] } };
  }
  const spec =
    parsed && typeof parsed === 'object' && 'spec' in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>).spec
      : parsed;
  const result = planPublish(spec);
  return { status: result.valid ? 200 : 422, json: result };
}

export function createDemoServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/publish') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'only POST /v1/publish is available' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      const { status, json } = handlePublish(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json, null, 2));
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 4430);
  createDemoServer().listen(port, '127.0.0.1', () => {
    console.log(`Ads Auto Publisher demo (dry-run) on http://127.0.0.1:${port}/v1/publish`);
  });
}
