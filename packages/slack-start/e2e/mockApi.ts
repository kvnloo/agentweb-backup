import type { Page, Route } from '@playwright/test';
import { TEST_CONFIG } from '../src/__tests__/testConfig';

export interface Recorded {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

/** Mocks https://api.mock.test/api/onboarding/slack-start/* for one page. */
export async function mockSlackStartApi(page: Page) {
  const calls: Recorded[] = [];
  const answers: Record<string, unknown> = {};
  let furthest = 1;
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, Authorization, Idempotency-Key',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await page.route('https://api.mock.test/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    calls.push({ method: req.method(), path: url.pathname, body, headers: await req.allHeaders() });
    const p = '/api/onboarding/slack-start';
    if (url.pathname === `${p}/config`) return json(route, 200, TEST_CONFIG);
    if (req.method() === 'POST' && url.pathname === p) return json(route, 202, { intakeId: 'e2e-intake', intakeToken: 'e2e-token', status: 'open' });
    if (req.headers().authorization !== 'Bearer e2e-token') return json(route, 404, { code: 'not_found' });
    if (req.method() === 'GET' && url.pathname === `${p}/e2e-intake`)
      return json(route, 200, { intakeId: 'e2e-intake', status: 'open', answers, furthestStep: furthest, email: 'sam@acme.co', website: 'https://acme.co' });
    if (req.method() === 'PATCH') {
      Object.assign(answers, body.answers);
      furthest = Math.max(furthest, body.step);
      return json(route, 200, { intakeId: 'e2e-intake', answers, furthestStep: furthest });
    }
    if (url.pathname.endsWith('/complete')) return json(route, 200, { intakeId: 'e2e-intake', status: 'pending', slackConnectStatus: 'disabled' });
    return json(route, 404, { code: 'not_found' });
  });
  return calls;
}
