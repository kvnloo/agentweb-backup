/**
 * ENG-818: the three timeout layers in front of agent-mode must be strictly ordered
 * app < nginx < ALB.
 *
 * They were all set to exactly 600s. The app's own cap (withGenerationTimeout) fires at
 * T=600s and then still needs time to reject the promise, unwind, run the ENG-510
 * continuation logic, persist a message and serialize JSON — but nginx and the ALB hit
 * their deadline at that same instant and tore the connection down first. The client got
 * nginx's raw HTML 504 and never the application's structured response, which is why the
 * graceful-degradation work from ENG-190/287/317/472/510 was unreachable in production.
 *
 * Each layer needs strictly more headroom than the one it wraps, so the app always wins
 * the race and its answer can actually get out. This test asserts that ordering against
 * the real config files, so a future edit that collapses them fails loudly here rather
 * than silently in prod.
 *
 * Note this does NOT let anything run longer: the app still gives up at 600s. It only
 * guarantees the response has room to be delivered.
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../..');

const NGINX_CONF = path.join(
  BACKEND_ROOT,
  '.platform/nginx/conf.d/agent-mode-timeout.conf',
);
const EB_CONF = path.join(BACKEND_ROOT, '.ebextensions/timeout.config');
const CONTROLLER = path.join(BACKEND_ROOT, 'src/controllers/agentModeController.ts');

/** Seconds for a directive like `proxy_read_timeout 660s;` */
function nginxTimeoutSeconds(conf: string, directive: string): number {
  const m = conf.match(new RegExp(`^\\s*${directive}\\s+(\\d+)s?\\s*;`, 'm'));
  if (!m) throw new Error(`${directive} not found in agent-mode-timeout.conf`);
  return parseInt(m[1], 10);
}

describe('ENG-818 — timeout layer ordering', () => {
  const nginxConf = fs.readFileSync(NGINX_CONF, 'utf8');
  const ebConf = fs.readFileSync(EB_CONF, 'utf8');
  const controller = fs.readFileSync(CONTROLLER, 'utf8');

  /**
   * The app-level cap, read from source so the test can't drift from the real default.
   *
   * The controller resolves this as `process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || '600000'`,
   * so a deployment that sets the env var moves the value the infra layers have to clear.
   * We therefore assert against the EFFECTIVE cap — the override when one is present, the
   * source default otherwise — rather than only the literal in the file. Otherwise raising
   * the cap in an environment would silently re-create the exact collision this guards.
   *
   * Verified 2026-08-01: `Agentweb-backend-env-prod-3` sets no override, so the 600000
   * default is what actually runs in production today.
   */
  const appCapMatch = controller.match(
    /AGENT_MODE_GENERATION_TIMEOUT_MS\s*\|\|\s*'(\d+)'/,
  );
  const appDefaultMs = parseInt(appCapMatch![1], 10);
  const appEffectiveMs = parseInt(
    process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || String(appDefaultMs),
    10,
  );
  const appSeconds = Math.round(appEffectiveMs / 1000);

  const albMatch = ebConf.match(/IdleTimeout:\s*(\d+)/);
  const albSeconds = parseInt(albMatch![1], 10);

  const proxyRead = nginxTimeoutSeconds(nginxConf, 'proxy_read_timeout');
  const proxySend = nginxTimeoutSeconds(nginxConf, 'proxy_send_timeout');

  it('parses a real value from each of the three layers', () => {
    expect(appCapMatch).not.toBeNull();
    expect(albMatch).not.toBeNull();
    expect(appSeconds).toBeGreaterThan(0);
    expect(proxyRead).toBeGreaterThan(0);
    expect(albSeconds).toBeGreaterThan(0);
  });

  it('gives nginx strictly more headroom than the app generation cap', () => {
    expect(proxyRead).toBeGreaterThan(appSeconds);
    expect(proxySend).toBeGreaterThan(appSeconds);
  });

  it('gives the ALB strictly more headroom than every nginx proxy timeout', () => {
    // Both proxy timeouts, not just read: proxy_send_timeout raised above the ALB idle
    // timeout would re-create the collision on the request path instead of the response
    // path, and an assertion that only covered proxy_read would not notice.
    expect(albSeconds).toBeGreaterThan(proxyRead);
    expect(albSeconds).toBeGreaterThan(proxySend);
  });

  it('does not drain an instance before an in-flight request can finish', () => {
    // DeregistrationDelay governs how long the ALB holds connections on a
    // deregistering instance. Shorter than the longest possible request means a
    // deploy severs in-flight agent-mode runs — the same collision one layer over.
    const deregMatch = ebConf.match(/DeregistrationDelay:\s*(\d+)/);
    expect(deregMatch).not.toBeNull();
    expect(parseInt(deregMatch![1], 10)).toBeGreaterThanOrEqual(albSeconds);
  });
});
