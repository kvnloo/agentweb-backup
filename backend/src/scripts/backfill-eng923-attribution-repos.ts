/**
 * Backfill ENG-923's attribution-capture pipeline into RankAI's and Haven's EXISTING landing
 * page repos. Both were generated before the attribution pipeline (d3914f1ad, 2026-07-02;
 * ENG-449, merged 2026-07-26) existed and were never resynced — confirmed by reading their
 * live GitHub repo content directly this session, not by inferring from DB timestamps (which
 * turned out to be an unreliable proxy: a page's `updatedAt` can be recent while its repo's
 * committed files are months stale, since only certain actions — lead-list attach, pixel
 * attach, new page — trigger a resync).
 *
 * Same root cause ENG-501 already hit once: "a repo that never gets a sync event ships stale
 * files indefinitely" (see backfill-eng501-middleware-fix.ts). This script follows that
 * script's shape (dry-run by default, --repo=/--apply flags) but is NOT a fleet-wide tool —
 * it holds a small hardcoded target list for two known clients, not a table scan. A fleet-wide
 * drift detector is a deliberately separate, follow-up piece of work (see ENG-923's ticket).
 *
 * RankAI gets the WIDE sync (syncLeadCaptureFilesToRepo): its repo uses the standard template
 * shape (app/api/capture/route.ts exists but is stale, no middleware.ts at all), so the actual
 * capture route content itself needs regenerating.
 *
 * Haven gets the NARROW sync ONLY (syncMiddlewareAndTrackingHelper): its repo is bespoke —
 * app/api/lead/route.ts dual-writes to the CRM webhook AND directly to HubSpot. That function
 * is structurally incapable of reading or writing app/api/capture/route.ts (or anything
 * HubSpot-related) — by construction, not by care taken at this call site — so it's safe to
 * run here without risking Haven's live HubSpot integration. It only adds middleware.ts (so
 * the aw_first_touch cookie starts being stamped) and lib/agentweb-track.ts. A SEPARATE, hand
 * authored patch to Haven's own app/api/lead/route.ts (outside this codebase) is required to
 * actually read that cookie and forward it — not part of this script.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npx ts-node src/scripts/backfill-eng923-attribution-repos.ts                       # DRY RUN, both targets
 *   npx ts-node src/scripts/backfill-eng923-attribution-repos.ts --repo=lp-free-ai-seo-geo-audit-37343865   # DRY RUN, one target
 *   npx ts-node src/scripts/backfill-eng923-attribution-repos.ts --repo=lp-free-ai-seo-geo-audit-37343865 --apply  # write, one target
 *   npx ts-node src/scripts/backfill-eng923-attribution-repos.ts --apply               # write, BOTH targets
 *
 * Per this repo's CLAUDE.md, this is a production-data-repair backfill — requires Harsha's
 * sign-off before merge, independent of who owns ENG-885/ENG-923 in Linear. Use --repo= to make
 * the first real write against RankAI alone, observable and reviewable, before ever running
 * --apply without --repo.
 */
import dotenv from "dotenv";
import path from "path";
import "../config/aws";
import {
  getLandingPagesByOwner,
  syncLeadCaptureFilesToRepo,
  syncMiddlewareAndTrackingHelper,
  GeneratedLandingPage,
} from "../services/v0Service";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export interface BackfillTarget {
  client: string;
  ownerUserId: string;
  repo: string; // "owner/name"
  mode: "wide" | "narrow";
}

// One-off, hardcoded — NOT a general-purpose tool. Every.io is deliberately absent: its repo
// already has the current pipeline (verified this session), so it needs no backfill.
export const TARGETS: BackfillTarget[] = [
  {
    client: "RankAI",
    ownerUserId: "4e29ce4e-8661-45bd-9881-3075d9a76971",
    repo: "AgentWebPro/lp-free-ai-seo-geo-audit-37343865",
    mode: "wide",
  },
  {
    client: "Haven",
    ownerUserId: "a3917669-1c7d-45ed-8ef9-f454de109b6f",
    repo: "AgentWebPro/v0-haven-ai-landing-page",
    mode: "narrow",
  },
];

function parseRepoFullName(githubRepoUrl: string): string | null {
  const m = githubRepoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
}

/**
 * path -> leadListId for every page of the owner's site that lives in the target repo and has
 * a lead list attached. Same convention syncLeadCaptureForPage (landingPageGeneration.ts) uses.
 * Unlike that function, there is no "page we just wrote" special case here — this is a pure
 * resync of already-persisted state, not a reaction to a single page's lead-list change.
 */
export async function buildListByPathForRepo(
  ownerUserId: string,
  repoFullName: string
): Promise<Record<string, string>> {
  const pages = await getLandingPagesByOwner(ownerUserId);
  const listByPath: Record<string, string> = {};
  for (const p of pages) {
    if (!p.githubRepoUrl) continue;
    if (parseRepoFullName(p.githubRepoUrl) !== repoFullName) continue;
    if (!p.leadListId) continue;
    listByPath[p.slug ? `/${p.slug}` : "/"] = p.leadListId;
  }
  return listByPath;
}

/**
 * The site-root record within the target repo — the one carrying metaPixelId/metaAdAccountId
 * (site-level config, may live on a different page than any given lead list). Root = a page
 * whose own id equals its siteId (falling back to isRootPage for older records, same as
 * syncLeadCaptureForPage's own resolution), scoped to pages that actually live in this repo.
 */
export function resolveRootRecord(
  pages: GeneratedLandingPage[],
  repoFullName: string
): GeneratedLandingPage | undefined {
  return pages.find((p) => {
    if (!p.githubRepoUrl || parseRepoFullName(p.githubRepoUrl) !== repoFullName) return false;
    const siteId = p.siteId ?? p.id;
    return siteId === p.id || p.isRootPage === true;
  });
}

export async function runBackfillForTarget(
  target: BackfillTarget,
  apply: boolean
): Promise<{ committed: boolean; reason?: string; pushedCommitSha?: string }> {
  if (!apply) {
    console.log(`  [DRY RUN] ${target.client} (${target.repo}): would run ${target.mode} sync`);
    return { committed: false, reason: "dry-run" };
  }

  if (target.mode === "narrow") {
    // Structurally cannot touch app/api/capture/route.ts or app/api/lead/route.ts — safe for
    // Haven's bespoke HubSpot dual-write repo by construction.
    return await syncMiddlewareAndTrackingHelper(target.repo);
  }

  // Wide mode: fetch fresh (not reused across a hypothetical retry — matches
  // syncLeadCaptureFilesToRepo's own ENG-485 contract of re-deriving on every attempt).
  const pages = await getLandingPagesByOwner(target.ownerUserId);
  const root = resolveRootRecord(pages, target.repo);
  return await syncLeadCaptureFilesToRepo(
    target.repo,
    () => buildListByPathForRepo(target.ownerUserId, target.repo),
    root?.metaPixelId,
    root?.metaAdAccountId
  );
}

const APPLY = process.argv.includes("--apply");
const REPO_FILTER = process.argv.find((a) => a.startsWith("--repo="))?.slice("--repo=".length);

async function main() {
  console.log("ENG-923 attribution-capture backfill", {
    mode: APPLY ? "APPLY (will write)" : "DRY RUN (no writes — pass --apply to write)",
    repoFilter: REPO_FILTER ?? "(none — all targets)",
  });

  const targets = REPO_FILTER ? TARGETS.filter((t) => t.repo.includes(REPO_FILTER)) : TARGETS;
  console.log(`\n${targets.length} target(s): ${targets.map((t) => `${t.client} (${t.mode})`).join(", ")}\n`);

  let synced = 0;
  let upToDate = 0;
  let failed = 0;

  for (const target of targets) {
    const result = await runBackfillForTarget(target, APPLY);
    if (!APPLY) continue;
    if (result.committed) {
      console.log(`  ${target.client} (${target.repo}): synced (commit ${result.pushedCommitSha?.substring(0, 7)})`);
      synced++;
    } else if (result.reason === "up-to-date") {
      console.log(`  ${target.client} (${target.repo}): already up to date`);
      upToDate++;
    } else {
      console.log(`  ${target.client} (${target.repo}): FAILED — ${result.reason}`);
      failed++;
    }
  }

  if (APPLY) {
    console.log(`\nDone. synced=${synced} upToDate=${upToDate} failed=${failed} totalTargets=${targets.length}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
