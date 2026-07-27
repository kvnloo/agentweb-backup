/**
 * Backfill ENG-501's middleware fix (aw_page cookie clobbered by sub-resource requests) —
 * and, as a side effect of reusing the same sync, ENG-449's lib/agentweb-track.ts backfill —
 * into every EXISTING generated-site repo.
 *
 * Both fixes only land in a repo the next time something triggers a lead-capture sync (new
 * page added, pixel/lead-list attached, etc — the ENG-483 mechanism). A repo that never gets
 * one of those events keeps shipping the OLD middleware.ts/lib/agentweb-track.ts indefinitely.
 * This script proactively triggers a sync for every repo, once.
 *
 * Deliberately uses syncMiddlewareAndTrackingHelper, NOT the wider syncLeadCaptureFilesToRepo
 * (ENG-310/483) — that function also rewrites app/api/capture/route.ts's LIST_BY_PATH map,
 * which is correct for its own callers (something about THIS page's own lead-list state just
 * changed) but is unrelated risk here: a bulk sweep across every existing repo has no business
 * touching real lead-routing data to fix a bug that lives entirely in middleware.ts. This
 * script therefore does NOT need to scan/group pages by leadListId or resolve pixelId at all —
 * it only needs the distinct set of repos.
 *
 * syncMiddlewareAndTrackingHelper is idempotent and safe to call broadly: it reads each
 * file's current content first and only commits (and only the files that actually differ) if
 * something doesn't match what the platform would write today. A repo already up to date
 * makes no commit at all — no needless redeploy.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npx ts-node src/scripts/backfill-eng501-middleware-fix.ts                        # DRY RUN, all repos
 *   npx ts-node src/scripts/backfill-eng501-middleware-fix.ts --repo=owner/name      # DRY RUN, one repo
 *   npx ts-node src/scripts/backfill-eng501-middleware-fix.ts --repo=owner/name --apply   # write, one repo
 *   npx ts-node src/scripts/backfill-eng501-middleware-fix.ts --apply                # write, ALL repos
 *
 * The actual write path (a real GitHub commit via this script) has not been exercised for
 * real anywhere yet — only against mocked GitHub in tests, and dry-run against real DynamoDB
 * data. Use --repo=<owner>/<name> to make the FIRST real write a single, observable repo you
 * can check by hand (commit history + a live page load), before ever running --apply without
 * --repo against the full fleet.
 */
import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";
import { syncMiddlewareAndTrackingHelper } from "../services/v0Service";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

const APPLY = process.argv.includes("--apply");
const REPO_FILTER = process.argv.find((a) => a.startsWith("--repo="))?.slice("--repo=".length);

interface LpItem {
  githubRepoUrl?: string;
}

function parseRepoFullName(githubRepoUrl: string): string | null {
  const m = githubRepoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
}

async function main() {
  console.log("ENG-501 middleware backfill", {
    region: process.env.AWS_REGION,
    tableName: TABLE_NAME,
    mode: APPLY ? "APPLY (will write)" : "DRY RUN (no writes — pass --apply to write)",
    repoFilter: REPO_FILTER ?? "(none — all repos)",
  });

  // ── Pass 1: collect the distinct set of repos across ALL pages, any status ───────────────
  // Deliberately not filtered by status: a page whose DB status is stale (e.g. "failed" after
  // a botched iteration attempt that didn't actually touch what's live) must not cause its
  // repo to be silently skipped — and since this script never rebuilds LIST_BY_PATH (see file
  // header), there's no risk in including a repo whose page data is imperfect. Worst case for
  // an unparseable/dead repo is a harmless per-repo failure, logged and skipped.
  const repos = new Set<string>();
  let totalScanned = 0;
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const res = await dynamodb
      .scan({ TableName: TABLE_NAME, Limit: 100, ExclusiveStartKey: lastKey })
      .promise();
    lastKey = res.LastEvaluatedKey;
    for (const item of (res.Items ?? []) as LpItem[]) {
      totalScanned++;
      if (item.githubRepoUrl) repos.add(item.githubRepoUrl);
    }
  } while (lastKey);

  const targetRepos = REPO_FILTER ? new Set([...repos].filter((r) => r.includes(REPO_FILTER))) : repos;
  console.log(`\nScanned ${totalScanned} records; ${repos.size} distinct repos` + (REPO_FILTER ? `; ${targetRepos.size} match --repo=${REPO_FILTER}.\n` : `.\n`));

  let synced = 0;
  let upToDate = 0;
  let failed = 0;

  // ── Pass 2: sync middleware.ts + lib/agentweb-track.ts only, per repo ────────────────────
  for (const repoUrl of targetRepos) {
    const repoFullName = parseRepoFullName(repoUrl);
    if (!repoFullName) {
      console.log(`  REPO ${repoUrl}: unparseable URL — skipping`);
      failed++;
      continue;
    }

    if (!APPLY) {
      console.log(`  [DRY RUN] ${repoFullName}: would sync middleware.ts + lib/agentweb-track.ts`);
      continue;
    }

    const result = await syncMiddlewareAndTrackingHelper(repoFullName);
    if (result.committed) {
      console.log(`  ${repoFullName}: synced (commit ${result.pushedCommitSha?.substring(0, 7)})`);
      synced++;
    } else if (result.reason === "up-to-date") {
      upToDate++;
    } else {
      console.log(`  ${repoFullName}: sync failed — ${result.reason}`);
      failed++;
    }
  }

  console.log(`\nDone. synced=${synced} upToDate=${upToDate} failed=${failed} totalRepos=${targetRepos.size}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
