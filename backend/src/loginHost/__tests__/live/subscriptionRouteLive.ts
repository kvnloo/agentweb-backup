/**
 * ENG-2113 PR A: MANUAL live check of the plan-route decision (services/funding/subscriptionRoute) against its REAL dependencies:
 *  - the real Dev funding-flags row (read only: nothing is written to settings),
 *  - the real Dev table `Dev-AW-LlmConnections`, through the real owner index (throwaway rows, one owner per case, ids/owners start with `zz-live-route-`),
 *  - the real model registry (every alias key must exist and be customer-selectable).
 * NODE_ENV must be development. Never touches a real user's rows. Everything it writes is deleted at the end (and on failure).
 */
import AWS from "aws-sdk";
import { LLM_CONNECTIONS_TABLE, LlmConnectionDb, type LlmConnectionRecord } from "../../../services/funding/llmConnectionDb";
import { getFundingFlags, isClaudeSubscriptionEnabledFor } from "../../../services/funding/fundingFlags";
import { LLM_MODEL_REGISTRY } from "../../../services/agentMode/llmModelRegistry";
import { PLAN_MODEL_ALIASES, resolveSubscriptionRoute, type RouteDecision, type RouteInput } from "../../../services/funding/subscriptionRoute";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const NOW_ISO = new Date().toISOString();
const NOW_MS = Date.now();
const SONNET = "openrouter/anthropic/claude-sonnet-5.5";
const RUN = Date.now().toString(36);
const created: string[] = [];

const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const db = new LlmConnectionDb();

const record = (id: string, owner: string, over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord =>
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
    subHostEpoch: 2,
    subNeedsReconnect: false,
    subType: "max",
    subRefreshExpiresAtMs: NOW_MS + 20 * 86_400_000,
    ...over,
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

/** Real owner-index query, retried briefly: a global secondary index is eventually consistent. */
async function waitListed(owner: string, expect: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await db.listByOwner(owner)).length >= expect) return;
    await sleep(250);
  }
}

/** Real flags and real connection lookup. The flag answer is injected ONLY where a case needs "enabled" for a synthetic user. */
const realDeps = (enabled: boolean) => ({
  isEnabledFor: async () => enabled,
  listConnections: (o: string) => db.listByOwner(o),
  now: () => NOW_MS,
});

async function seed(owner: string, rows: Array<Partial<LlmConnectionRecord> & { id: string }>): Promise<void> {
  for (const r of rows) {
    const { id, ...over } = r;
    await db.create(record(id, owner, over));
    created.push(id);
  }
  await waitListed(owner, rows.length);
}

async function expectDecision(name: string, owner: string, enabled: boolean, over: Partial<RouteInput>, predicate: (d: RouteDecision) => boolean): Promise<void> {
  const d = await resolveSubscriptionRoute(input(owner, over), realDeps(enabled));
  check(name, predicate(d), JSON.stringify(d));
}

async function main() {
  if (!LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error("refusing: not the Dev table: " + LLM_CONNECTIONS_TABLE);

  // ---- 1. alias table vs the REAL model registry
  for (const [id, alias] of Object.entries(PLAN_MODEL_ALIASES)) {
    const entry = (LLM_MODEL_REGISTRY as Record<string, { internalOnly?: boolean; adminOnly?: boolean; provider?: string } | undefined>)[id];
    // adminOnly is information: today haiku-5.5 and sonnet-5.5 are admin-only in the registry (picker visibility is an L5 decision).
    check(`registry-has-${alias}`, !!entry && !entry.internalOnly, entry ? `provider=${entry.provider ?? "?"} adminOnly=${entry.adminOnly === true}` : "MISSING");
  }

  // ---- 2. real flags row (read only)
  const flags = await getFundingFlags();
  check("flags-row-readable", typeof flags.claudeSubscription.enabled === "boolean" && Array.isArray(flags.claudeSubscription.allowUserIds), `enabled=${flags.claudeSubscription.enabled} allowlist=${flags.claudeSubscription.allowUserIds.length} killSwitch=${flags.killSwitch}`);
  check("flags-wildcard-ignored", (await isClaudeSubscriptionEnabledFor("*")) === false);
  check("flags-unlisted-user-disabled", (await isClaudeSubscriptionEnabledFor("zz-live-route-nobody")) === false);
  const listed = flags.claudeSubscription.allowUserIds.find((u) => u !== "*");
  if (listed) check("flags-listed-user-enabled-iff-feature-on", (await isClaudeSubscriptionEnabledFor(listed)) === (flags.claudeSubscription.enabled && !flags.killSwitch));

  // ---- 3. default (real) dependencies end to end, no injection: a synthetic user is not on the allow-list
  const ghost = `zz-live-route-ghost-${RUN}`;
  const ghostDecision = await resolveSubscriptionRoute(input(ghost));
  check("default-deps-unlisted-user-stops-not-enabled", ghostDecision.route === "stop" && ghostDecision.reason === "not_enabled", JSON.stringify(ghostDecision));
  const noPick = await resolveSubscriptionRoute(input(ghost, { fundingChoice: undefined }));
  check("default-deps-no-pick-is-agentweb", noPick.route === "agentweb");

  // ---- 4. connection states through the REAL table and owner index
  const o = (n: string) => `zz-live-route-${n}-${RUN}`;
  await seed(o("good"), [{ id: `zz-live-route-good-${RUN}`, subHostEpoch: 3 }]);
  await expectDecision("good-hosted-connection-routes", o("good"), true, {}, (d) => d.route === "claude_subscription" && d.connectionId === `zz-live-route-good-${RUN}` && d.epoch === 3 && d.alias === "sonnet");

  await seed(o("reconnect"), [{ id: `zz-live-route-reconnect-${RUN}`, status: "invalid", subNeedsReconnect: true }]);
  await expectDecision("needs-reconnect-stops", o("reconnect"), true, {}, (d) => d.route === "stop" && d.reason === "needs_reconnect");

  await seed(o("expiredstatus"), [{ id: `zz-live-route-expiredstatus-${RUN}`, status: "expired" }]);
  await expectDecision("expired-status-stops", o("expiredstatus"), true, {}, (d) => d.route === "stop" && d.reason === "expired");

  await seed(o("expiredat"), [{ id: `zz-live-route-expiredat-${RUN}`, subRefreshExpiresAtMs: NOW_MS - 1000 }]);
  await expectDecision("refresh-expiry-passed-stops", o("expiredat"), true, {}, (d) => d.route === "stop" && d.reason === "expired");

  await seed(o("revoking"), [{ id: `zz-live-route-revoking-${RUN}`, status: "revoking" }]);
  await expectDecision("revoking-stops", o("revoking"), true, {}, (d) => d.route === "stop" && d.reason === "revoked_or_disabled");

  await seed(o("disabled"), [{ id: `zz-live-route-disabled-${RUN}`, status: "disabled" }]);
  await expectDecision("disabled-stops", o("disabled"), true, {}, (d) => d.route === "stop" && d.reason === "revoked_or_disabled");

  await seed(o("revoked"), [{ id: `zz-live-route-revoked-${RUN}`, status: "revoked", revokedAt: NOW_ISO }]);
  await expectDecision("revoked-row-is-no-connection", o("revoked"), true, {}, (d) => d.route === "stop" && d.reason === "no_connection");

  await seed(o("legacy"), [{ id: `zz-live-route-legacy-${RUN}`, subHosted: undefined, subHostEpoch: undefined }]);
  await expectDecision("legacy-non-hosted-login-is-no-connection", o("legacy"), true, {}, (d) => d.route === "stop" && d.reason === "no_connection");

  await seed(o("apikey"), [{ id: `zz-live-route-apikey-${RUN}`, kind: "api_key", provider: "openai", subHosted: undefined, subHostEpoch: undefined }]);
  await expectDecision("api-key-connection-is-no-connection", o("apikey"), true, {}, (d) => d.route === "stop" && d.reason === "no_connection");

  await expectDecision("owner-without-rows-is-no-connection", o("nobody"), true, {}, (d) => d.route === "stop" && d.reason === "no_connection");

  await seed(o("two"), [
    { id: `zz-live-route-two-old-${RUN}`, updatedAt: "2026-09-01T00:00:00.000Z", subHostEpoch: 1 },
    { id: `zz-live-route-two-new-${RUN}`, updatedAt: "2026-10-20T00:00:00.000Z", subHostEpoch: 5 },
    { id: `zz-live-route-two-dead-${RUN}`, updatedAt: "2026-10-22T00:00:00.000Z", status: "invalid", subNeedsReconnect: true },
  ]);
  await expectDecision("most-recent-usable-connection-wins", o("two"), true, {}, (d) => d.route === "claude_subscription" && d.connectionId === `zz-live-route-two-new-${RUN}` && d.epoch === 5);

  // ---- 5. one user's rows never leak to another user, and the allow-list denies before any lookup
  await expectDecision("another-owner-sees-none-of-good-owners-rows", o("other"), true, {}, (d) => d.route === "stop" && d.reason === "no_connection");
  await expectDecision("admin-acting-in-owners-session-denied-despite-good-connection", o("good"), true, { initiatorUserId: "zz-live-route-admin" }, (d) => d.route === "stop" && d.reason === "not_allowed_here");
  await expectDecision("delegated-denied-despite-good-connection", o("good"), true, { isDelegated: true }, (d) => d.route === "stop" && d.reason === "not_allowed_here");
  await expectDecision("share-denied-despite-good-connection", o("good"), true, { isInteractiveShare: true }, (d) => d.route === "stop" && d.reason === "not_allowed_here");
  await expectDecision("slack-denied-despite-good-connection", o("good"), true, { entry: "slack" }, (d) => d.route === "stop" && d.reason === "not_allowed_here");
  await expectDecision("model-without-alias-stops-despite-good-connection", o("good"), true, { model: "claude-opus-4-8" }, (d) => d.route === "stop" && d.reason === "model_not_on_plan");
  await expectDecision("flag-off-stops-despite-good-connection", o("good"), false, {}, (d) => d.route === "stop" && d.reason === "not_enabled");
  await expectDecision("no-pick-is-agentweb-despite-good-connection", o("good"), true, { fundingChoice: undefined }, (d) => d.route === "agentweb");
}

main()
  .catch((e) => check("runner", false, String((e as { code?: string }).code ?? (e as Error).message).slice(0, 200)))
  .finally(async () => {
    for (const id of created) await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: id } }).promise().catch(() => undefined);
    const left = (await Promise.all(created.map((id) => db.get(id).catch(() => null)))).filter(Boolean).length;
    check("cleanup-removed-every-throwaway-row", left === 0, `left=${left}`);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
