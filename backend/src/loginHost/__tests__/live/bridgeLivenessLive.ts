/**
 * ENG-2113 PR B: MANUAL live check of the bridge's per-call liveness check against the REAL Dev tables: throwaway connection rows
 * (`zz-live-liveness-*`, Dev-AW-LlmConnections) and the REAL Dev funding-flags row, which is written temporarily and restored byte for byte
 * (or deleted if there was none) on success, failure and SIGINT/SIGTERM. NODE_ENV must be development. No tokens, no credentials.
 * Proves what the unit tests only mock: the real connection read, and `readFundingFlagsFresh` against the real settings row (a write sees a
 * flag change immediately; a read may use the 60 s cache; a malformed row throws for a write).
 */
import AWS from "aws-sdk";
import { settingsService } from "../../../services/settingsService";
import { FUNDING_FLAGS_SETTING_NAME, __resetFundingFlagsCacheForTests } from "../../../services/funding/fundingFlags";
import { LLM_CONNECTIONS_TABLE, LlmConnectionDb, type LlmConnectionRecord } from "../../../services/funding/llmConnectionDb";
import { createSubscriptionIsLive } from "../../../services/funding/bridgeLiveness";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const NOW_ISO = new Date().toISOString();
const NOW_MS = Date.now();
const created: string[] = [];

const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const db = new LlmConnectionDb();
const settingsTable = settingsService.getTableName();

let original: Record<string, unknown> | null | undefined;
let restored = false;
async function restoreFlags(): Promise<void> {
  if (restored || original === undefined) return;
  if (original === null) await dc.delete({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  else await dc.put({ TableName: settingsTable, Item: original }).promise();
  restored = true;
  __resetFundingFlagsCacheForTests();
}
async function setFlags(value: unknown, reset = true): Promise<void> {
  await settingsService.setSetting(FUNDING_FLAGS_SETTING_NAME, typeof value === "string" ? value : JSON.stringify(value), "ENG-2113 liveness live check (temporary)", "live-check");
  if (reset) __resetFundingFlagsCacheForTests();
}
const flags = (over: { enabled?: boolean; allow?: string[]; killSwitch?: boolean }) => ({
  byok: { enabled: false, allowUserIds: [] },
  claudeSubscription: { enabled: over.enabled ?? true, allowUserIds: over.allow ?? [] },
  killSwitch: over.killSwitch ?? false,
});

const owner = `zz-live-liveness-owner-${RUN}`;
const record = (suffix: string, over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord =>
  ({
    connectionId: `zz-live-liveness-${suffix}-${RUN}`,
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
    ...over,
  }) as LlmConnectionRecord;

async function main() {
  if (!settingsTable.startsWith("Dev-") || !LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error(`refusing: not Dev tables (${settingsTable}, ${LLM_CONNECTIONS_TABLE})`);
  const existing = await dc.get({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  original = (existing.Item as Record<string, unknown> | undefined) ?? null;
  console.log(`flags row before: ${original === null ? "absent" : "present (will be restored byte for byte)"}`);

  const rows = {
    good: record("good"),
    revoked: record("revoked", { revokedAt: NOW_ISO }),
    reconnect: record("reconnect", { subNeedsReconnect: true }),
    invalid: record("invalid", { status: "invalid" }),
    expired: record("expired", { subRefreshExpiresAtMs: NOW_MS - 1000 }),
    other: record("other", { ownerUserId: `${owner}-someone-else` }),
  };
  for (const r of Object.values(rows)) {
    await db.create(r);
    created.push(r.connectionId);
  }
  for (let i = 0; i < 40 && !(await db.get(rows.other.connectionId)); i++) await sleep(250);

  const isLive = createSubscriptionIsLive({ getConnection: (id) => db.get(id) });
  const run = (r: LlmConnectionRecord, epoch = 4) => ({ runId: "r", userId: owner, sessionId: "s", connectionId: r.connectionId, epoch });
  const W = { write: true };
  const R = { write: false };

  await setFlags(flags({ allow: [owner] }));
  check("good connection + feature on: live for a write", (await isLive(run(rows.good), W)) === true);
  check("good connection + feature on: live for a read", (await isLive(run(rows.good), R)) === true);
  check("revoked connection: not live", (await isLive(run(rows.revoked), W)) === false);
  check("needs-reconnect connection: not live", (await isLive(run(rows.reconnect), W)) === false);
  check("invalid connection: not live", (await isLive(run(rows.invalid), W)) === false);
  check("expired login: not live", (await isLive(run(rows.expired), W)) === false);
  check("another owner's connection: not live", (await isLive(run(rows.other), W)) === false);
  check("host epoch moved on (run epoch 3, record epoch 4): not live", (await isLive(run(rows.good, 3), W)) === false);
  check("connection that does not exist: not live", (await isLive({ runId: "r", userId: owner, sessionId: "s", connectionId: `zz-live-liveness-missing-${RUN}`, epoch: 4 }, W)) === false);
  check("a run with no connection has nothing to check", (await isLive({ runId: "r", userId: owner, sessionId: "s" }, W)) === true);

  // A write must see a flag change at once; a read may still use the cache.
  await setFlags(flags({ allow: [owner] }));
  check("warm the cache: read live", (await isLive(run(rows.good), R)) === true);
  await setFlags(flags({ allow: [owner], killSwitch: true }), false); // changed in the table, cache NOT reset
  check("kill switch flipped in the table: the very next WRITE is not live (fresh read, no cache)", (await isLive(run(rows.good), W)) === false);
  check("same moment: a READ may still answer from the 60 s cache (documented)", (await isLive(run(rows.good), R)) === true);
  __resetFundingFlagsCacheForTests();
  check("after the cache expires a read follows the kill switch too", (await isLive(run(rows.good), R)) === false);

  await setFlags(flags({ allow: [owner], enabled: false }));
  check("feature off: write not live", (await isLive(run(rows.good), W)) === false);
  await setFlags(flags({ allow: ["*"] }));
  check("wildcard allowlist does not enable: write not live", (await isLive(run(rows.good), W)) === false);

  await setFlags("{\"nope\":true}");
  let threw = false;
  try {
    await isLive(run(rows.good), W);
  } catch {
    threw = true;
  }
  check("malformed flags row: a write THROWS (bridge answers retryably) instead of treating it as off or last-good", threw);

  // row absent = definite all-off
  await dc.delete({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  __resetFundingFlagsCacheForTests();
  check("flags row absent: write not live (definite all-off)", (await isLive(run(rows.good), W)) === false);

  await restoreFlags();
  const after = await dc.get({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  const same = original === null ? !after.Item : JSON.stringify(after.Item) === JSON.stringify(original);
  check("flags row restored exactly", same);
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
    check("cleanup removed every throwaway row", left === 0, `left=${left}`);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
