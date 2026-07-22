/**
 * Slack API twin suite (ENG-402 · Phase 2 of the Arga integration, OPS-8).
 *
 * OPT-IN, NEVER A REQUIRED CHECK. Excluded from the default Jest run via
 * `testPathIgnorePatterns` (jest.config.js). Run explicitly:
 *
 *     npm run test:twins -- --testPathPattern=slack
 *
 * REUSABLE-TWIN PATTERN (ENG-402): this suite no longer provisions a fresh twin
 * per run. It reads the coordinates of a persistent twin from `.env.twins.json`
 * (created once by `npm run test:twins:setup`) and points our real `slackService`
 * WebClient at it THROUGH our production seam (`resolveSlackApiUrl` honoring
 * `SLACK_API_BASE`). Because the WebClient is a module-load-time singleton, we set
 * the env and (re)require the service inside `beforeAll` so the client is built
 * against the twin. State is reset to baseline before each test for isolation.
 *
 * SKIPS cleanly (never red, never a merge gate) when no reusable twin is
 * configured. Any OTHER failure inside the suite throws (fails loud).
 *
 * Why a twin and not `jest.mock('@slack/web-api')`: every assertion here depends
 * on STATE the twin actually keeps (a message that persists across calls) or on
 * the REAL error ENVELOPE Slack returns (`missing_scope` with `needed`/`provided`).
 * A hand mock can only return what its author already believed — exactly how a
 * wrong-shape assumption gets frozen into the suite.
 */
import axios from 'axios';
import { getTwin, resetTwinToBaseline, resolveTwinSession, TwinCoords } from './twinSession';

// Reusable twin (from `.env.twins.json`). SKIPS cleanly when none is configured —
// never red, never a gate.
const { config: twinConfig, skipReason } = resolveTwinSession('slack');
const describeTwin = skipReason ? describe.skip : describe;
if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(
    `[slack.twin] SKIPPED — ${skipReason}. This suite is opt-in and never gates a merge.`,
  );
}

/**
 * Revoke a Slack OAuth scope on the live twin, mid-session, via its admin API.
 * The effect is verified by the subsequent Slack call failing with missing_scope,
 * not by this response — the twin returns 200 here even though the scope is now
 * disabled (matching how the config is applied server-side).
 */
async function revokeScope(twin: TwinCoords, scope: string): Promise<void> {
  await axios.patch(
    `${twin.adminUrl}/admin/config`,
    { disabled_scopes: [scope] },
    { headers: { Authorization: `Bearer ${twin.proxyToken}` }, timeout: 15_000 },
  );
}

type SlackService = typeof import('../../services/slackService');

describeTwin('Slack twin — real API behavior our jest.mock cannot express', () => {
  let twin: TwinCoords;
  let slackService: SlackService;
  let channelId: string;
  const savedBase = process.env.SLACK_API_BASE;
  const savedToken = process.env.SLACK_BOT_TOKEN;

  beforeAll(async () => {
    const coords = getTwin('slack');
    if (!coords || !coords.adminUrl || !coords.proxyToken || !coords.botToken) {
      throw new Error('slack twin missing required coords (baseUrl/adminUrl/proxyToken/botToken) in .env.twins.json');
    }
    twin = coords;

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

  // Reset the reusable twin to its baseline seed state before each test so
  // state-mutating tests (posting messages, revoking scopes) are isolated
  // (best-effort: a failed reset warns, not crashes).
  beforeEach(() => {
    if (twinConfig) resetTwinToBaseline(twinConfig.runId);
  });

  afterAll(() => {
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

  // AC3 — kept LAST: it revokes chat:write on the twin. With per-test baseline
  // resets this is isolated regardless of order, but the ordering is retained for
  // clarity (the revoke happens after the happy-path post/read-back).
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
