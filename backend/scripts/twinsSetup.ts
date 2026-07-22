/**
 * Reusable Arga twin provisioner (ENG-402) — `npm run test:twins:setup`.
 *
 * Provisions ONE session holding BOTH the slack + stripe twins (seeded from the
 * "E-commerce Checkout" preset, which bundles Stripe + Slack), parses the
 * provision JSON, and writes the coordinates to `.env.twins.json` so
 * `npm run test:twins` can REUSE the same twin across many runs instead of
 * burning a fresh provision (and free-tier quota) per test. Tear down with
 * `npm run test:twins:teardown`.
 *
 * LIVE BEHAVIOR UNVERIFIED — first run must be validated when Arga quota is
 * available (the account was at 0/10 for the month as of 2026-07-20, so
 * `provision` 403s). The CLI flags and JSON field names below mirror exactly what
 * `stripe.twin.test.ts` / `slack.twin.test.ts` already parse — `base_url`,
 * `admin_url`, `proxy_token`, `run_id`, `env_vars.SLACK_BOT_TOKEN` — so the SHAPE
 * is known from the existing suites; the end-to-end provision run is NOT yet
 * exercised. The "E-commerce Checkout" scenario id in particular is a placeholder
 * (see SCENARIO_ID) — confirm it from `arga previews twins list --json` on the
 * first quota-available run.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import {
  resolveConfigPath,
  resolveTwinRunner,
  TwinConfig,
} from '../src/__tests__/twins/twinSession';

// The "E-commerce Checkout" preset bundles a Stripe + Slack twin. Its saved
// scenario id must be confirmed from `arga previews twins list --json` once quota
// is available; override without code edits via ARGA_TWIN_SCENARIO_ID.
// UNVERIFIED placeholder — do NOT assume this id is correct until a live run confirms it.
const SCENARIO_ID = process.env.ARGA_TWIN_SCENARIO_ID || 'ecommerce-checkout';
const TWINS = 'slack,stripe';
// TTL in minutes. Free-tier twins cap at ~10 min; override via ARGA_TWIN_TTL.
const TTL_MINUTES = process.env.ARGA_TWIN_TTL || '10';

function main(): void {
  const { arga, skipReason } = resolveTwinRunner();
  if (!arga || skipReason) {
    // Fail loud: setup is an explicit, human-run action — never a silent no-op.
    throw new Error(
      `Cannot provision reusable twin: ${skipReason ?? 'Arga CLI not found (run `arga login`)'}\n` +
        'Free plan = 10 ephemeral provisions/month at ~10-min TTL each. Wait for the monthly ' +
        'quota reset or upgrade to an Arga Team plan for long-running scenario agents.',
    );
  }

  const args = [
    'previews',
    'twins',
    'provision',
    '--twins',
    TWINS,
    '--scenario-id',
    SCENARIO_ID,
    '--ttl',
    TTL_MINUTES,
    '--wait',
    '--timeout',
    '180',
    '--json',
  ];
  // eslint-disable-next-line no-console
  console.log(`[twinsSetup] arga ${args.join(' ')}`);
  const out = execFileSync(arga, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const json = JSON.parse(out);

  if (json.status !== 'ready' || !json.run_id) {
    throw new Error(`Twin session not ready: ${out.slice(0, 500)}`);
  }

  const stripeTwin = json.twins?.stripe;
  const slackTwin = json.twins?.slack;
  if (!stripeTwin?.base_url) {
    throw new Error(`Provision response missing stripe twin base_url: ${out.slice(0, 500)}`);
  }
  if (!slackTwin?.base_url || !slackTwin?.admin_url) {
    throw new Error(`Provision response missing slack twin base_url/admin_url: ${out.slice(0, 500)}`);
  }
  const botToken = slackTwin.env_vars?.SLACK_BOT_TOKEN;
  if (!botToken) {
    throw new Error(`Provision response missing seeded SLACK_BOT_TOKEN: ${out.slice(0, 500)}`);
  }
  if (!json.proxy_token) {
    throw new Error(`Provision response missing proxy_token for admin API: ${out.slice(0, 500)}`);
  }

  const config: TwinConfig = {
    runId: json.run_id,
    twins: {
      stripe: { baseUrl: stripeTwin.base_url },
      slack: {
        baseUrl: slackTwin.base_url,
        adminUrl: slackTwin.admin_url,
        proxyToken: json.proxy_token,
        botToken,
      },
    },
  };

  const configPath = resolveConfigPath();
  // 0o600: the file carries a bot token + admin proxy JWT — keep it owner-only.
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  // eslint-disable-next-line no-console
  console.log(`[twinsSetup] Wrote ${configPath} (runId=${config.runId}).`);
  // eslint-disable-next-line no-console
  console.log('[twinsSetup] Now run: npm run test:twins   (resets to baseline between tests)');
  // eslint-disable-next-line no-console
  console.log(
    `[twinsSetup] NOTE: free-tier twins expire after ~${TTL_MINUTES} min — re-run setup per working session.`,
  );
}

main();
