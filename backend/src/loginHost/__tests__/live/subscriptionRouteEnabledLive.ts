/**
 * ENG-2113 PR A: MANUAL live check of the one path subscriptionRouteLive.ts cannot reach: the feature flag really ON.
 * It temporarily writes the REAL Dev funding-flags row (`eng1816_funding_flags`, Dev-AW-Settings) with the feature enabled for synthetic
 * users only (ids start with `zz-live-route-`), then runs the plan-route decision with the REAL default dependencies (no injected flag answer)
 * against throwaway connection rows in the real Dev table, and restores the flags row to exactly what it was (or deletes it if there was none).
 * NODE_ENV must be development. The row is restored on success, failure and SIGINT/SIGTERM.
 */
import AWS from "aws-sdk";
import { settingsService } from "../../../services/settingsService";
import { FUNDING_FLAGS_SETTING_NAME, __resetFundingFlagsCacheForTests, isClaudeSubscriptionEnabledFor } from "../../../services/funding/fundingFlags";
import { LLM_CONNECTIONS_TABLE, LlmConnectionDb, type LlmConnectionRecord } from "../../../services/funding/llmConnectionDb";
import { resolveSubscriptionRoute, type RouteInput } from "../../../services/funding/subscriptionRoute";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const SONNET = "openrouter/anthropic/claude-sonnet-5.5";
const NOW_ISO = new Date().toISOString();
const NOW_MS = Date.now();
const created: string[] = [];

const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const db = new LlmConnectionDb();
const settingsTable = settingsService.getTableName();

let original: Record<string, unknown> | null | undefined; // undefined = not read yet, null = row did not exist
let restored = false;

async function restoreFlags(): Promise<void> {
  if (restored || original === undefined) return;
  if (original === null) await dc.delete({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  else await dc.put({ TableName: settingsTable, Item: original }).promise();
  restored = true;
  __resetFundingFlagsCacheForTests();
}

async function setFlags(value: unknown): Promise<void> {
  await settingsService.setSetting(FUNDING_FLAGS_SETTING_NAME, JSON.stringify(value), "ENG-2113 live check (temporary)", "live-check");
  __resetFundingFlagsCacheForTests();
}

const flags = (over: { enabled?: boolean; allow?: string[]; killSwitch?: boolean }) => ({
  byok: { enabled: false, allowUserIds: [] },
  claudeSubscription: { enabled: over.enabled ?? true, allowUserIds: over.allow ?? [] },
  killSwitch: over.killSwitch ?? false,
});

const record = (id: string, owner: string): LlmConnectionRecord =>
  ({
    connectionId: id,
    ownerUserId: owner,
    kind: "claude_subscription",
    provider: "anthropic",
    status: "active",
    keyLast4: "",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    subHosted: true,
    subHostEpoch: 4,
    subNeedsReconnect: false,
    subType: "max",
    subRefreshExpiresAtMs: NOW_MS + 20 * 86_400_000,
  }) as LlmConnectionRecord;

const input = (owner: string, over: Partial<RouteInput> = {}): RouteInput => ({
  initiatorUserId: owner,
  sessionOwnerUserId: owner,
  entry: "owner_chat",
  isDelegated: false,
  isInteractiveShare: false,
  model: SONNET,
  fundingChoice: "claude_subscription",
  ...over,
});

async function main() {
  if (!settingsTable.startsWith("Dev-") || !LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error(`refusing: not Dev tables (${settingsTable}, ${LLM_CONNECTIONS_TABLE})`);

  const listed = `zz-live-route-listed-${RUN}`;
  const unlisted = `zz-live-route-unlisted-${RUN}`;
  const noConn = `zz-live-route-noconn-${RUN}`;

  const existing = await dc.get({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  original = (existing.Item as Record<string, unknown> | undefined) ?? null;
  console.log(`flags row before: ${original === null ? "absent" : "present (will be restored byte for byte)"}`);

  // throwaway connections: the listed user and an unlisted user both have a good hosted connection
  for (const owner of [listed, unlisted]) {
    const id = `zz-live-route-conn-${owner.slice(14)}`;
    await db.create(record(id, owner));
    created.push(id);
  }
  for (let i = 0; i < 40 && ((await db.listByOwner(listed)).length < 1 || (await db.listByOwner(unlisted)).length < 1); i++) await sleep(250);

  // 1. ON for the listed user only: the real default dependencies (real flags, real table) route it
  await setFlags(flags({ allow: [listed, noConn] }));
  check("real-flag-sees-listed-user-enabled", (await isClaudeSubscriptionEnabledFor(listed)) === true);
  const on = await resolveSubscriptionRoute(input(listed));
  check("enabled-listed-user-with-good-connection-routes-to-subscription", on.route === "claude_subscription" && on.alias === "sonnet" && on.epoch === 4, JSON.stringify(on));
  const noRows = await resolveSubscriptionRoute(input(noConn));
  check("enabled-listed-user-without-connection-stops-no_connection", noRows.route === "stop" && noRows.reason === "no_connection", JSON.stringify(noRows));
  const other = await resolveSubscriptionRoute(input(unlisted));
  check("enabled-but-unlisted-user-stops-not_enabled-despite-good-connection", other.route === "stop" && other.reason === "not_enabled", JSON.stringify(other));
  const noPick = await resolveSubscriptionRoute(input(listed, { fundingChoice: undefined }));
  check("enabled-listed-user-without-pick-stays-agentweb", noPick.route === "agentweb", JSON.stringify(noPick));
  const admin = await resolveSubscriptionRoute(input(listed, { initiatorUserId: "zz-live-route-admin" }));
  check("enabled-listed-owner-via-other-initiator-denied", admin.route === "stop" && admin.reason === "not_allowed_here", JSON.stringify(admin));

  // 2. wildcard never enables anyone
  await setFlags(flags({ allow: ["*"] }));
  const wild = await resolveSubscriptionRoute(input(unlisted));
  check("wildcard-allowlist-does-not-enable", wild.route === "stop" && wild.reason === "not_enabled", JSON.stringify(wild));

  // 3. kill switch beats an enabled, listed user
  await setFlags(flags({ allow: [listed], killSwitch: true }));
  const killed = await resolveSubscriptionRoute(input(listed));
  check("kill-switch-stops-an-enabled-listed-user", killed.route === "stop" && killed.reason === "not_enabled", JSON.stringify(killed));

  // 4. feature off beats a listed user
  await setFlags(flags({ allow: [listed], enabled: false }));
  const off = await resolveSubscriptionRoute(input(listed));
  check("feature-off-stops-a-listed-user", off.route === "stop" && off.reason === "not_enabled", JSON.stringify(off));

  // 5. restore, then prove the original state is back
  await restoreFlags();
  const after = await dc.get({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  const same = original === null ? !after.Item : JSON.stringify(after.Item) === JSON.stringify(original);
  check("flags-row-restored-exactly", same, original === null ? `row absent: ${!after.Item}` : "");
  const back = await resolveSubscriptionRoute(input(listed));
  check("after-restore-listed-user-stops-not_enabled-again", back.route === "stop" && back.reason === "not_enabled", JSON.stringify(back));
}

const onSignal = () => {
  restoreFlags().finally(() => process.exit(130));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

main()
  .catch((e) => check("runner", false, String((e as { code?: string }).code ?? (e as Error).message).slice(0, 200)))
  .finally(async () => {
    await restoreFlags().catch((e) => check("RESTORE-FAILED-FIX-BY-HAND", false, String((e as Error).message).slice(0, 200)));
    for (const id of created) await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: id } }).promise().catch(() => undefined);
    const left = (await Promise.all(created.map((id) => db.get(id).catch(() => null)))).filter(Boolean).length;
    check("cleanup-removed-every-throwaway-row", left === 0, `left=${left}`);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
