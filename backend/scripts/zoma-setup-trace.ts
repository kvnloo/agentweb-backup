/**
 * ENG-2496 — print the timeline of a Zoma agent setup (device flow) for support.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node backend/scripts/zoma-setup-trace.ts <user_code|setup_id|email>
 *     user_code  the code the user saw, e.g. BCDF-GHJK (dash optional)
 *     setup_id   the 12-hex-char `setup_id` from a `zoma_setup` log line
 *     email      every setup bound to that AgentWeb account (newest first)
 *   --json       raw JSON instead of the table
 *
 * Read-only. Reads the AW-ZomaDeviceAuth device items' `events` lists (kept ~14 days past
 * expiry) and prints a CloudWatch Logs Insights query for the matching log lines. Never prints
 * codes, tokens, the PKCE verifier, or minted links.
 */
import { DynamoZomaDeviceStore, ZOMA_DEVICE_TABLE, type ZomaDeviceRecord } from '../src/mcp/zomaDeviceStore';
import { normalizeUserCode } from '../src/mcp/zomaDeviceFlow';
import { zomaSetupId } from '../src/mcp/zomaSetupLog';
import { userDb } from '../src/services/db';

const LOG_GROUP_HINT = '/aws/elasticbeanstalk/Agentweb-backend-env-prod-3/var/log/web.stdout.log';

async function findSetups(query: string, store: DynamoZomaDeviceStore): Promise<{ label: string; devices: ZomaDeviceRecord[] }> {
  if (query.includes('@')) {
    const user = await userDb.getUserByEmail(query.trim().toLowerCase());
    if (!user?.userId) return { label: `email ${query} (no AgentWeb account)`, devices: [] };
    const devices = (await store.scanDevices()).filter((d) => d.userId === user.userId);
    return { label: `email ${query} (user ${user.userId})`, devices };
  }
  if (/^[0-9a-f]{12}$/i.test(query)) {
    const devices = (await store.scanDevices()).filter((d) => zomaSetupId(d.deviceId) === query.toLowerCase());
    return { label: `setup_id ${query}`, devices };
  }
  const userCode = normalizeUserCode(query);
  if (!userCode) throw new Error('Pass a user_code (XXXX-XXXX), a 12-char setup_id, or an email.');
  const deviceId = await store.getDeviceIdByUserCode(userCode);
  const byLookup = deviceId ? await store.getDevice(deviceId) : null;
  // The user_code item can be gone after TTL; fall back to the code stored on the device item.
  const devices = byLookup ? [byLookup] : (await store.scanDevices()).filter((d) => d.userCode === userCode);
  return { label: 'user_code (redacted)', devices };
}

/** Only non-secret fields leave this script. */
function summarize(d: ZomaDeviceRecord) {
  return {
    setup_id: zomaSetupId(d.deviceId),
    user_id: d.userId ?? null,
    status: d.status,
    created_at: d.createdAt,
    expires_at: new Date(d.expiresAt).toISOString(),
    last_poll_at: d.lastPollAt ? new Date(d.lastPollAt).toISOString() : null,
    last_poll_outcome: d.lastPollOutcome ?? null,
    links_minted: Object.keys(d.links ?? {}),
    events: d.events ?? [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = args.find((a) => !a.startsWith('--'));
  if (!query) {
    console.error('Usage: zoma-setup-trace.ts <user_code|setup_id|email> [--json]');
    process.exit(2);
  }
  const store = new DynamoZomaDeviceStore();
  const { label, devices } = await findSetups(query, store);
  const setups = devices.map(summarize).sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (args.includes('--json')) {
    console.log(JSON.stringify({ table: ZOMA_DEVICE_TABLE, query: label, setups }, null, 2));
  } else {
    console.log(`Zoma setups for ${label} in ${ZOMA_DEVICE_TABLE}: ${setups.length}`);
    for (const s of setups) {
      console.log(`\n== setup ${s.setup_id}  status=${s.status}  user=${s.user_id ?? '-'}  created=${s.created_at}  expires=${s.expires_at}`);
      console.log(`   last poll ${s.last_poll_at ?? '-'} -> ${s.last_poll_outcome ?? '-'}; links minted: ${s.links_minted.join(', ') || 'none'}`);
      if (s.events.length === 0) console.log('   (no events recorded — setup predates ENG-2496 tracing)');
      for (const e of s.events) console.log(`   ${e.at}  ${e.step.padEnd(18)} ${e.outcome}${e.reason ? `  (${e.reason})` : ''}`);
    }
  }

  const ids = setups.map((s) => `"${s.setup_id}"`);
  console.log('\nCloudWatch Logs Insights (log group, e.g. ' + LOG_GROUP_HINT + '):');
  console.log(
    '  fields @timestamp, setup_id, user_id, step, outcome, reason\n' +
      `  | filter event = "zoma_setup"${ids.length ? ` and setup_id in [${ids.join(', ')}]` : ''}\n` +
      '  | sort @timestamp asc',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
