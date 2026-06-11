/**
 * Backfill `lastPublish` on already-deployed landing pages so the
 * "Revert last publish" capability (UI button + revert_landing_page_publish
 * tool) becomes available for pages that were published BEFORE the publish
 * flow started recording publish history.
 *
 * ── Why this is non-trivial ────────────────────────────────────────────────
 * Multiple landing pages commonly share ONE GitHub repo (one repo == one
 * Vercel project, with each page living at a /slug route). A revert force-
 * resets the SHARED `main` ref, so we must NOT blindly give every page in a
 * repo a revertable record — reverting one page would silently roll back an
 * unrelated sibling page's change.
 *
 * ── Safe strategy (what this script does) ──────────────────────────────────
 * Per repo, look at `main`'s most recent commit. Our publish/add-page commits
 * embed the page slug, e.g. "Add new page: RetryFix Demo (/retryfix-demo)" or
 * "Publish landing page changes from draft/...". We only backfill the SINGLE
 * page that the latest commit actually corresponds to:
 *   - preMergeSha = first parent of HEAD  (the state before that commit)
 *   - mergeSha    = HEAD                   (so the revert guard "main is still
 *                                           at mergeSha" passes)
 * Pages we can't confidently map to the latest commit are left untouched
 * (they simply won't show the button until their next real publish, where an
 * accurate rollback target is recorded automatically).
 *
 * Matching rules for the latest commit → page:
 *   1. A "(/slug)" in the message matched against a page's slug (sub-pages).
 *   2. A root-page commit (no slug in message) matched to the repo's root page
 *      ONLY when the repo has exactly one page.
 * Chore commits (GTM inject/remove) and ambiguous cases are skipped.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npx ts-node src/scripts/backfill-landing-page-publish.ts            # DRY RUN (default)
 *   npx ts-node src/scripts/backfill-landing-page-publish.ts --apply    # write changes
 */
import AWS from "aws-sdk";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";
import { getGitHubOrgToken } from "../utils/secretsManager";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;
const GITHUB_TIMEOUT_MS = 30_000;

const APPLY = process.argv.includes("--apply");

interface LpItem {
  id: string;
  name?: string;
  slug?: string;
  status?: string;
  isRootPage?: boolean;
  githubRepoUrl?: string;
  lastPublish?: unknown;
}

export function parseRepo(githubRepoUrl: string): { owner: string; repo: string } | null {
  const m = githubRepoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

/** Extract a "(/slug)" path from a commit message, returning the bare slug. */
export function slugFromCommitMessage(message: string): string | null {
  const m = message.match(/\((\/[a-zA-Z0-9_-]+)\)/);
  if (!m) return null;
  return m[1].replace(/^\//, "");
}

/** True for commits that aren't content publishes (GTM inject/remove, etc.). */
export function isChoreCommit(messageFirstLine: string): boolean {
  return /^chore[:(]/i.test(messageFirstLine.trim());
}

/**
 * Decide which single page (if any) the repo's latest `main` commit should
 * make revertable. Pure — no I/O — so the matching policy is unit-tested.
 *
 * Returns the chosen page plus a reason, or { target: null, reason } when the
 * commit can't be confidently mapped (chore, no parent, no slug match, or an
 * ambiguous multi-page repo). Callers skip null targets.
 */
export function chooseBackfillTarget(
  pages: Pick<LpItem, "id" | "name" | "slug" | "lastPublish">[],
  head: { sha: string; message: string; parentSha?: string }
): { target: LpItem | null; reason: string } {
  const firstLine = head.message.split("\n")[0];

  if (!head.parentSha) {
    return { target: null, reason: "no-parent" };
  }
  if (isChoreCommit(firstLine)) {
    return { target: null, reason: "chore" };
  }

  const slug = slugFromCommitMessage(head.message);
  let target: LpItem | undefined;
  if (slug) {
    target = pages.find((p) => p.slug === slug) as LpItem | undefined;
  } else if (pages.length === 1) {
    // No slug + single-page repo → that page is unambiguously the target.
    target = pages[0] as LpItem;
  }

  if (!target) return { target: null, reason: "no-match" };
  if (target.lastPublish) return { target, reason: "already-has-record" };
  return { target, reason: "ok" };
}

async function backfill() {
  console.log("Backfill landing-page lastPublish with configuration:", {
    environment: process.env.NODE_ENV || "production",
    region: process.env.AWS_REGION,
    tableName: TABLE_NAME,
    mode: APPLY ? "APPLY (will write)" : "DRY RUN (no writes — pass --apply to write)",
  });

  // ── Pass 1: collect all deployed pages, grouped by repo ──────────────────
  const byRepo = new Map<string, LpItem[]>();
  let totalScanned = 0;
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const res = await dynamodb
      .scan({ TableName: TABLE_NAME, Limit: 100, ExclusiveStartKey: lastKey })
      .promise();
    lastKey = res.LastEvaluatedKey;
    for (const item of (res.Items ?? []) as LpItem[]) {
      totalScanned++;
      if (item.status !== "deployed" || !item.githubRepoUrl) continue;
      const arr = byRepo.get(item.githubRepoUrl) ?? [];
      arr.push(item);
      byRepo.set(item.githubRepoUrl, arr);
    }
  } while (lastKey);

  console.log(`\nScanned ${totalScanned} records; ${byRepo.size} repos with deployed pages.\n`);

  const { token } = await getGitHubOrgToken();
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };

  let backfilled = 0;
  let skippedHasRecord = 0;
  let skippedNoMatch = 0;
  let repoErrors = 0;

  // ── Pass 2: per repo, map HEAD commit → one page, backfill it ────────────
  for (const [repoUrl, pages] of byRepo) {
    const parsed = parseRepo(repoUrl);
    if (!parsed) {
      console.log(`  REPO ${repoUrl}: unparseable URL — skipping ${pages.length} page(s)`);
      repoErrors++;
      continue;
    }
    const { owner, repo } = parsed;

    let head: { sha: string; message: string; date: string; parentSha?: string };
    try {
      const res = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repo}/commits/main`,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      head = {
        sha: res.data.sha,
        message: res.data.commit?.message ?? "",
        date: res.data.commit?.committer?.date || res.data.commit?.author?.date || new Date().toISOString(),
        parentSha: res.data.parents?.[0]?.sha,
      };
    } catch (err: any) {
      console.log(`  REPO ${owner}/${repo}: failed to read main HEAD (${err.message}) — skipping`);
      repoErrors++;
      continue;
    }

    const head7 = head.sha.substring(0, 7);
    const firstLine = head.message.split("\n")[0];
    const { target, reason } = chooseBackfillTarget(pages, head);

    if (reason === "no-parent") {
      console.log(`  REPO ${owner}/${repo}: HEAD ${head7} has no parent (initial commit) — nothing to revert to, skipping`);
      skippedNoMatch += pages.length;
      continue;
    }
    if (reason === "chore") {
      // Config tweaks (GTM inject/remove) aren't content publishes — surfacing
      // a "Revert last publish" button that would strip a user's GTM tag is
      // surprising. Such pages get an accurate record on their next publish.
      console.log(`  REPO ${owner}/${repo}: latest commit ${head7} is a chore (${JSON.stringify(firstLine)}) — not a publish, skipping`);
      skippedNoMatch += pages.length;
      continue;
    }
    if (reason === "no-match" || !target) {
      console.log(
        `  REPO ${owner}/${repo}: latest commit ${head7} ${JSON.stringify(firstLine)} ` +
        `→ no confident page match (${pages.length} page(s) in repo) — skipping`
      );
      skippedNoMatch += pages.length;
      continue;
    }
    if (reason === "already-has-record") {
      console.log(`  REPO ${owner}/${repo}: target "${target.name}" already has lastPublish — skipping`);
      skippedHasRecord++;
      continue;
    }

    // reason === "ok" guarantees a parent exists (chooseBackfillTarget returns
    // "no-parent" otherwise), but narrow it explicitly for the type checker.
    const parentSha = head.parentSha as string;
    const record = {
      preMergeSha: parentSha,
      mergeSha: head.sha,
      branch: "(backfilled)",
      publishedAt: head.date,
    };

    console.log(
      `  ${APPLY ? "BACKFILL" : "WOULD BACKFILL"} "${target.name}" (${target.id}) in ${owner}/${repo}: ` +
      `revert ${head7} → ${parentSha.substring(0, 7)}`
    );

    if (APPLY) {
      try {
        await dynamodb
          .update({
            TableName: TABLE_NAME,
            Key: { id: target.id },
            UpdateExpression: "SET lastPublish = :lp, updatedAt = :now",
            // Only write if still absent — avoids clobbering a real publish that
            // may have landed between the scan and now.
            ConditionExpression: "attribute_not_exists(lastPublish)",
            ExpressionAttributeValues: { ":lp": record, ":now": new Date().toISOString() },
          })
          .promise();
        backfilled++;
      } catch (err: any) {
        if (err.code === "ConditionalCheckFailedException") {
          console.log(`    (skipped — lastPublish appeared concurrently)`);
          skippedHasRecord++;
        } else {
          console.error(`    ERROR writing ${target.id}: ${err.message}`);
          repoErrors++;
        }
      }
    } else {
      backfilled++;
    }
  }

  console.log("\n=== Backfill " + (APPLY ? "Complete" : "Dry Run Complete") + " ===");
  console.log(`Repos processed:            ${byRepo.size}`);
  console.log(`${APPLY ? "Backfilled" : "Would backfill"}:               ${backfilled}`);
  console.log(`Skipped (already had record): ${skippedHasRecord}`);
  console.log(`Skipped (no confident match): ${skippedNoMatch}`);
  console.log(`Repo errors:                ${repoErrors}`);
  if (!APPLY) console.log("\nThis was a DRY RUN. Re-run with --apply to write these records.");
}

// Only auto-run when invoked directly (ts-node/node), not when imported by
// tests for the pure helper functions above.
if (require.main === module) {
  backfill().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
