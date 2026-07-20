/**
 * Slack API twin suite (ENG-402 · Phase 2 of the Arga integration, OPS-8).
 *
 * OPT-IN, NEVER A REQUIRED CHECK. Excluded from the default Jest run via
 * `testPathIgnorePatterns` (jest.config.js). Run explicitly:
 *
 *     npm run test:twins -- --testPathPattern=slack
 *
 * It provisions a live Arga Slack twin (needs `arga login` on the box) and points
 * our real `slackService` WebClient at it THROUGH our production seam
 * (`resolveSlackApiUrl` honoring `SLACK_API_BASE`). Because the WebClient is a
 * module-load-time singleton, we set the env and (re)require the service inside
 * `beforeAll` so the client is built against the twin.
 *
 * SKIPS cleanly (never red, never a merge gate) when the twin cannot be
 * provisioned: Arga not authenticated, OR the free-plan monthly validation-run
 * quota is exhausted (provisioning is metered against it — `arga whoami` reports
 * "Validation runs: N/10 remaining"). A dev without Arga — or an account out of
 * runs — is never blocked. Any OTHER provisioning failure throws (fails loud).
 *
 * Why a twin and not `jest.mock('@slack/web-api')`: every assertion here depends
 * on STATE the twin actually keeps (a message that persists across calls) or on
 * the REAL error ENVELOPE Slack returns (`missing_scope` with `needed`/`provided`).
 * A hand mock can only return what its author already believed — exactly how a
 * wrong-shape assumption gets frozen into the suite.
 */
import { execFileSync } from 'child_process';
import axios from 'axios';
import { resolveTwinRunner } from './twinAvailability';

// Arga CLI + free-plan validation-run quota (shared guard). SKIPS cleanly when
// Arga is unauthenticated or the monthly quota is exhausted — never red, never a gate.
const { arga: ARGA, skipReason } = resolveTwinRunner();
const describeTwin = skipReason ? describe.skip : describe;
if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(
    `[slack.twin] SKIPPED — ${skipReason}. This suite is opt-in and never gates a merge.`,
  );
}

interface SlackTwin {
  runId: string;
  /** Public base URL; Slack methods are served at `<baseUrl>/api/<method>`. */
  baseUrl: string;
  /** Admin base URL (no `pub-` prefix); Bearer `proxyToken`. */
  adminUrl: string;
  /** Seeded bot token that carries `chat:write` (`xoxb-…`). */
  botToken: string;
  /** JWT bearer for the twin's `/admin/*` endpoints. */
  proxyToken: string;
}

function provisionSlackTwin(bin: string): SlackTwin {
  const out = execFileSync(
    bin,
    ['previews', 'twins', 'provision', '--twins', 'slack', '--ttl', '10', '--wait', '--timeout', '180', '--json'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const json = JSON.parse(out);
  const twin = json.twins?.slack;
  if (json.status !== 'ready' || !twin?.base_url || !twin?.admin_url) {
    throw new Error(`Slack twin not ready: ${out.slice(0, 500)}`);
  }
  const botToken = twin.env_vars?.SLACK_BOT_TOKEN;
  if (!botToken) {
    throw new Error(`Slack twin missing seeded SLACK_BOT_TOKEN: ${out.slice(0, 500)}`);
  }
  if (!json.proxy_token) {
    throw new Error(`Slack twin missing proxy_token for admin API: ${out.slice(0, 500)}`);
  }
  return {
    runId: json.run_id,
    baseUrl: twin.base_url,
    adminUrl: twin.admin_url,
    botToken,
    proxyToken: json.proxy_token,
  };
}

function teardownTwin(bin: string, runId: string): void {
  try {
    execFileSync(bin, ['previews', 'twins', 'teardown', runId], { stdio: 'ignore' });
  } catch {
    /* twin auto-expires on its 10-min TTL regardless */
  }
}

/**
 * Revoke a Slack OAuth scope on the live twin, mid-session, via its admin API.
 * The effect is verified by the subsequent Slack call failing with missing_scope,
 * not by this response — the twin returns 200 here even though the scope is now
 * disabled (matching how the config is applied server-side).
 */
async function revokeScope(twin: SlackTwin, scope: string): Promise<void> {
  await axios.patch(
    `${twin.adminUrl}/admin/config`,
    { disabled_scopes: [scope] },
    { headers: { Authorization: `Bearer ${twin.proxyToken}` }, timeout: 15_000 },
  );
}

type SlackService = typeof import('../../services/slackService');

describeTwin('Slack twin — real API behavior our jest.mock cannot express', () => {
  let twin: SlackTwin;
  let slackService: SlackService;
  let channelId: string;
  const savedBase = process.env.SLACK_API_BASE;
  const savedToken = process.env.SLACK_BOT_TOKEN;

  beforeAll(async () => {
    twin = provisionSlackTwin(ARGA as string);

    // Drive our WebClient through OUR production seam — this is the code under test.
    // The WebClient joins the method onto slackApiUrl, so it must end in `/api/`
    // (mirrors Slack's own default `https://slack.com/api/`).
    process.env.SLACK_API_BASE = `${twin.baseUrl}/api/`;
    process.env.SLACK_BOT_TOKEN = twin.botToken;

    // slackService builds its WebClient at module-load time, so re-require it now
    // that the twin env is set. jest.resetModules() forces a fresh instance.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    slackService = require('../../services/slackService') as SlackService;

    const channels = await slackService.getSlackChannels();
    if (channels.length === 0) {
      throw new Error('Slack twin seeded no member channels to post into');
    }
    channelId = channels[0].id;
  }, 200_000);

  afterAll(() => {
    if (twin) teardownTwin(ARGA as string, twin.runId);
    if (savedBase === undefined) delete process.env.SLACK_API_BASE;
    else process.env.SLACK_API_BASE = savedBase;
    if (savedToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedToken;
  });

  it('posts a message through our seam and reads it back from persisted twin state', async () => {
    const marker = `eng-402 twin smoke ${Date.now()}`;

    const posted = await slackService.postSlackMessage(channelId, marker);
    expect(posted.ts).toBeTruthy(); // a real ts minted by the twin
    expect(posted.channel).toBeTruthy();

    // The point a jest.mock can't make: re-reading returns the persisted message.
    const messages = await slackService.getRecentChannelMessages(channelId);
    expect(messages.some((m) => m.ts === posted.ts)).toBe(true);
    expect(messages.some((m) => m.text.includes(marker))).toBe(true);
  }, 60_000);

  // AC3 — kept LAST: it revokes chat:write on the shared twin, which must not
  // affect earlier tests.
  it('AC3: revoking chat:write mid-session surfaces missing_scope to the caller (no swallow, no fallback)', async () => {
    // Revoke chat:write on the live twin, mid-session.
    await revokeScope(twin, 'chat:write');

    // Our posting code must FAIL LOUD: the missing_scope error propagates to the
    // caller — postSlackMessage neither swallows it nor returns a degraded success.
    // expect.assertions guarantees the catch ran (a silent success would fail the test).
    expect.assertions(3);
    try {
      await slackService.postSlackMessage(channelId, 'should be rejected — chat:write revoked');
    } catch (err) {
      const e = err as { code?: string; data?: { ok?: boolean; error?: string } };
      expect(e.code).toBe('slack_webapi_platform_error');
      expect(e.data?.ok).toBe(false);
      expect(e.data?.error).toBe('missing_scope');
    }
  }, 60_000);
});
