/**
 * ENG-2110 PR 1c-ii: MANUAL check of the hosted-login DynamoDB writes against the REAL Dev table (Dev-AW-LlmConnections), because the
 * in-memory test double cannot catch real expression errors (reserved words, unused names/values, OR grouping). Writes only rows whose
 * ids start with `zz-live-hosted-` and the owner `zz-live-owner`, and deletes them at the end. NODE_ENV must be development.
 */
import AWS from "aws-sdk";
import { LLM_CONNECTIONS_TABLE, LlmConnectionDb, type LlmConnectionRecord } from "../../../services/funding/llmConnectionDb";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const NOW = new Date().toISOString();
const OWNER = "zz-live-owner";
const ids = ["zz-live-hosted-a", "zz-live-hosted-b", "zz-live-hosted-old"];

async function main() {
  if (!LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error("refusing: not the Dev table: " + LLM_CONNECTIONS_TABLE);
  const db = new LlmConnectionDb();
  const mk = (id: string, over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord => ({
    connectionId: id, ownerUserId: OWNER, kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "", createdAt: NOW, updatedAt: NOW,
    subHosted: true, subHostEpoch: 1, subNeedsReconnect: false, subType: "max", ...over,
  });
  check("create-hosted-row", await db.createWithinLimit(mk(ids[0]), 10));
  check("create-second-row", await db.createWithinLimit(mk(ids[1]), 10));
  await db.create(mk(ids[2], { subHosted: undefined, subHostEpoch: undefined }));

  check("advance-epoch", await db.hostedAdvanceEpoch(ids[0], 1, 2, NOW));
  check("advance-epoch-loser", !(await db.hostedAdvanceEpoch(ids[0], 1, 2, NOW)));
  check("needs-reconnect-wrong-epoch", !(await db.hostedMarkNeedsReconnect(ids[0], 1, "x", NOW)));
  check("needs-reconnect", await db.hostedMarkNeedsReconnect(ids[0], 2, "host_lost", NOW));
  const flagged = await db.get(ids[0]);
  check("row-after-needs-reconnect", flagged?.status === "invalid" && flagged.subNeedsReconnect === true && flagged.subReconnectReason === "host_lost");
  check("reconnected", await db.hostedMarkReconnected(ids[0], 2, { plan: "pro", refreshExpiresAtMs: Date.now() + 1e9, fingerprint: "fp" }, NOW));
  const back = await db.get(ids[0]);
  check("row-after-reconnect", back?.status === "active" && back.subNeedsReconnect === false && back.subType === "pro" && back.subReconnectReason === undefined);

  check("plain-revoke-refuses-hosted", !(await db.revoke(ids[0], { userId: OWNER }, NOW)));
  check("mark-revoked-needs-revoking", !(await db.hostedMarkRevoked(ids[0], NOW)));
  check("begin-revoke-started", (await db.hostedBeginRevoke(ids[0], 3, { userId: OWNER, adminId: "zz-admin" }, NOW)).result === "started");
  check("begin-revoke-already", (await db.hostedBeginRevoke(ids[0], 4, { userId: OWNER }, NOW)).result === "already");
  check("begin-revoke-not-hosted", (await db.hostedBeginRevoke(ids[2], 2, { userId: OWNER }, NOW)).result === "not_hosted");
  check("begin-revoke-missing", (await db.hostedBeginRevoke("zz-live-hosted-none", 2, { userId: OWNER }, NOW)).result === "missing");
  await db.hostedNoteRevokeAttempt(ids[0], NOW);
  await db.hostedNoteRevokeAttempt(ids[0], NOW);
  const revoking = await db.get(ids[0]);
  check("row-revoking", revoking?.status === "revoking" && revoking.subHostEpoch === 3 && revoking.subRevokeAttempts === 2 && revoking.revokedByAdminId === "zz-admin" && revoking.revokedAt === undefined);
  check("mark-revoked", await db.hostedMarkRevoked(ids[0], NOW));
  check("mark-revoked-twice", !(await db.hostedMarkRevoked(ids[0], NOW)));
  check("row-revoked", (await db.get(ids[0]))?.status === "revoked");
  const hostedList = (await db.listHosted()).map((r) => r.connectionId);
  const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  const counter = async () => ((await dc.get({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: `limit#${OWNER}` } }).promise()).Item?.activeCount as number | undefined) ?? -1;
  check("counter-two-slots", (await counter()) === 2);
  check("release-slot", (await db.hostedReleaseSlot(ids[0], OWNER)) === "released");
  check("release-slot-twice", (await db.hostedReleaseSlot(ids[0], OWNER)) === "already");
  check("counter-after-release", (await counter()) === 1, `count=${await counter()}`);
  check("release-flag-set", (await db.get(ids[0]))?.subSlotReleased === true);
  check("release-not-hosted-row", (await db.hostedReleaseSlot(ids[2], OWNER)) === "already" && (await counter()) === 1);
  check("reconnect-keeps-disabled", await (async () => {
    await db.hostedAdvanceEpoch(ids[1], 1, 2, NOW);
    const ok = await db.hostedMarkReconnected(ids[1], 2, { status: "disabled" }, NOW);
    return ok && (await db.get(ids[1]))?.status === "disabled";
  })());
  check("list-hosted", hostedList.includes(ids[0]) && hostedList.includes(ids[1]) && !hostedList.includes(ids[2]));
}

main()
  .catch((e) => check("runner", false, String((e as { code?: string }).code ?? (e as Error).message).slice(0, 160)))
  .finally(async () => {
    // Cleanup: only our own throwaway rows and the owner's slot counter.
    const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
    for (const id of [...ids, "zz-live-hosted-none", `limit#${OWNER}`]) {
      await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: id } }).promise().catch(() => undefined);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
