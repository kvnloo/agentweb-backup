#!/usr/bin/env node
// ENG-2951 (slice of ENG-2934): read-only verifier for a group-email campaign's durable
// pending-batch record (groupEmailPendingBatchService.ts, ENG-265 / ENG-2929).
//
// Polls `groupEmailPendingBatch:<listId>` in AW-Configs (Dev- prefix outside production)
// until the campaign is terminal, then reports sent count. It ONLY reads (GetItem); it never
// writes, resumes or deletes anything.
//
// Terminal:  record absent (completed and cleared)  -> pass
//            skippedLeadIds empty and no live background run -> pass
//            leads remain and no live background run -> "stalled" (exit 2; e.g. daily cap hit)
// Invariant breaks (exit 1): sentSoFar > totalOriginal, sentSoFar + remaining > totalOriginal
// (over-send / duplicate signal), sentSoFar decreasing between polls, expected-total mismatch.
//
// Usage: node scripts/verify-group-email-batch.mjs --user-id U --list-id L
//          [--expected-total N] [--timeout-s 1800] [--interval-s 15]

// Mirrors BACKGROUND_RUN_STALE_MS in routes/crm.ts.
export const BACKGROUND_RUN_STALE_MS = 2 * 60 * 1000;

export function configsTable(env = process.env) {
  return `${env.NODE_ENV === "production" ? "" : "Dev-"}AW-Configs`;
}

export function configId(listId) {
  return `groupEmailPendingBatch:${listId}`;
}

export function backgroundRunLive(rec, now) {
  if (!rec?.backgroundRunId || !rec.backgroundHeartbeatAt) return false;
  const t = new Date(rec.backgroundHeartbeatAt).getTime();
  return Number.isFinite(t) && now - t < BACKGROUND_RUN_STALE_MS;
}

/** Returns a list of invariant violations for one snapshot (and the previous one, if any). */
export function checkInvariants(rec, prev, expectedTotal) {
  const errs = [];
  if (!rec) return errs;
  const sent = Number(rec.sentSoFar ?? 0);
  const total = Number(rec.totalOriginal ?? 0);
  const remaining = Array.isArray(rec.skippedLeadIds) ? rec.skippedLeadIds.length : 0;
  if (sent > total) errs.push(`sentSoFar ${sent} exceeds totalOriginal ${total}`);
  if (sent + remaining > total) errs.push(`sentSoFar ${sent} + remaining ${remaining} exceeds totalOriginal ${total} (possible duplicate send)`);
  if (prev && Number(prev.sentSoFar ?? 0) > sent) errs.push(`sentSoFar decreased ${prev.sentSoFar} -> ${sent}`);
  if (expectedTotal != null && total !== expectedTotal) errs.push(`totalOriginal ${total} != expected ${expectedTotal}`);
  if (remaining && new Set(rec.skippedLeadIds).size !== remaining) errs.push("skippedLeadIds contains duplicates");
  return errs;
}

/**
 * @param {object} o
 * @param {(userId: string, configId: string) => Promise<object|null>} o.getItem read-only fetch
 */
export async function run({
  userId,
  listId,
  expectedTotal = null,
  timeoutS = 1800,
  intervalS = 15,
  getItem,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
}) {
  if (!userId || !listId) throw new Error("--user-id and --list-id are required");
  const deadline = now() + timeoutS * 1000;
  let prev = null;
  let lastSent = null;
  for (;;) {
    const rec = await getItem(userId, configId(listId));
    const errs = checkInvariants(rec, prev, expectedTotal);
    if (errs.length) {
      for (const e of errs) log(`FAIL ${e}`);
      return { status: "fail", errors: errs, sentSoFar: rec?.sentSoFar ?? null };
    }
    if (!rec) {
      const msg = prev
        ? `PASS record cleared (campaign complete); last seen sentSoFar=${prev.sentSoFar}/${prev.totalOriginal}`
        : "PASS no pending batch record (campaign complete or never deferred)";
      log(msg);
      return { status: "complete", sentSoFar: lastSent, totalOriginal: prev?.totalOriginal ?? null };
    }
    const remaining = rec.skippedLeadIds?.length ?? 0;
    const live = backgroundRunLive(rec, now());
    log(`poll sentSoFar=${rec.sentSoFar}/${rec.totalOriginal} remaining=${remaining} backgroundLive=${live}`);
    lastSent = Number(rec.sentSoFar ?? 0);
    if (!live) {
      if (remaining === 0) {
        log(`PASS terminal: sent ${lastSent}/${rec.totalOriginal}`);
        return { status: "complete", sentSoFar: lastSent, totalOriginal: rec.totalOriginal };
      }
      log(`STALLED ${remaining} leads remain with no live background run (daily cap or dead run)`);
      return { status: "stalled", sentSoFar: lastSent, totalOriginal: rec.totalOriginal, remaining };
    }
    if (now() >= deadline) {
      log(`TIMEOUT after ${timeoutS}s; sentSoFar=${lastSent}/${rec.totalOriginal}`);
      return { status: "timeout", sentSoFar: lastSent, totalOriginal: rec.totalOriginal, remaining };
    }
    prev = rec;
    await sleep(intervalS * 1000);
  }
}

export const EXIT = { complete: 0, fail: 1, stalled: 2, timeout: 3 };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    out[k] = argv[i + 1];
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const { default: AWS } = await import("aws-sdk");
  const doc = new AWS.DynamoDB.DocumentClient();
  const table = configsTable();
  const getItem = async (userId, cid) =>
    (await doc.get({ TableName: table, Key: { userId, configId: cid } }).promise()).Item ?? null;
  const r = await run({
    userId: a["user-id"],
    listId: a["list-id"],
    expectedTotal: a["expected-total"] != null ? Number(a["expected-total"]) : null,
    timeoutS: Number(a["timeout-s"] ?? 1800),
    intervalS: Number(a["interval-s"] ?? 15),
    getItem,
  });
  console.log(JSON.stringify(r));
  process.exit(EXIT[r.status] ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
