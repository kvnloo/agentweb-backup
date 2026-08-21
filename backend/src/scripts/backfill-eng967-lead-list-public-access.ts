/**
 * ENG-967 remediation — repair EXISTING landing pages bound to a lead list that
 * cannot receive their submissions.
 *
 * The code fix (ensureLeadListAcceptsPublicSubmissions in routes/landingPageGeneration.ts)
 * only runs on a FUTURE bind: /generate, PATCH /generated/:id/lead-list and
 * /generated/:id/duplicate. Every page bound before that shipped keeps whatever state it
 * has, so a page wired to a `publicAccessEnabled !== true` list goes on 403ing at
 * /api/webhooks/forward-lead (webhooks.ts) while the visitor is shown a success screen.
 * This script is the one-time repair for that class.
 *
 * ⚠ IT DOES NOT REPAIR EITHER LIST ENG-967 NAMES, and an earlier revision of this comment
 * claimed it repaired one of them. Checked against production 2026-08-21:
 * "LP Leads - 2026 State of AI Marketing" (list_1779584823329_md99qvwnk) is private, but NO
 * AW-LandingPages record names it (Scan of all 167), no code in the org references it, and
 * hireemma.ai/2026-state-of-ai-marketing returns 404 — so this script never enumerates it,
 * and flipping it public would change nothing, because nothing posts to it. The other list
 * is covered below. Both need CRM cleanup, not this script.
 *
 * ── What it changes ────────────────────────────────────────────────────────
 * ONLY `publicAccessEnabled: true`, and ONLY on a lead list that some landing page
 * record already names in its `leadListId`. It never creates, deletes, or repoints
 * anything, and it never touches a list no page is bound to — a private list that no
 * lander posts to is private on purpose and is none of this script's business.
 *
 * Enabling public access on a page-bound list is not a new policy decision: /generate has
 * done exactly this on the list it binds since ENG-449, and the ENG-967 fix now does it on
 * the other two bind paths. This script only brings pre-existing binds up to that same
 * invariant.
 *
 * NOTE (CLAUDE.md data-plane gate): this is a bulk mutation of production data and needs
 * Harsha's approval before anyone runs it with --apply.
 *
 * ── What it deliberately does NOT fix ──────────────────────────────────────
 * A list that is ALREADY public and still has zero leads is NOT explained by this bug at
 * all — ENG-967's other list, "LP Leads - Emma Partner Network"
 * (list_1779822422539_l5yvansu2), is publicAccessEnabled=true in prod and still reports 0
 * leads. Its cause was found and is not repairable here: the live /emma-partner-network form
 * posts through /api/partner-capture -> PARTNER_LEAD_LIST_ID ->
 * LANDERS['/emma-partner-network'].listId = list_1780522372186_ve7ebuzp8 ("Partner Network
 * Briefs"), read from lib/landers.ts in agentweb-landing-page. The AW-LandingPages record
 * names the other list; the form never did. That repo's own LANDERS.md already calls
 * l5yvansu2 a duplicate and says to delete it.
 *
 * So the script reports every such list under NEEDS DIAGNOSIS with each bound page's
 * status/URL/repo, which is what separates "no page bound" from "bound but never deployed"
 * from "bound, deployed, posting somewhere else". Lists referenced by a page but missing
 * from AW-LeadLists (a live lander POSTing into a 404) are reported the same way.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npx ts-node src/scripts/backfill-eng967-lead-list-public-access.ts                  # DRY RUN, all pages
 *   npx ts-node src/scripts/backfill-eng967-lead-list-public-access.ts --list=list_x    # DRY RUN, one list
 *   npx ts-node src/scripts/backfill-eng967-lead-list-public-access.ts --list=list_x --apply
 *   npx ts-node src/scripts/backfill-eng967-lead-list-public-access.ts --apply          # write, ALL bound lists
 *
 * Run the dry run first and read the report — it is also the diagnostic instrument for the
 * NEEDS DIAGNOSIS class above. Then make the first real write a single list with
 * --list=<id> before ever running --apply across the fleet.
 */
import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";
import { crmDb } from "../services/db";

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
const LIST_FILTER = process.argv.find((a) => a.startsWith("--list="))?.slice("--list=".length);

interface LpItem {
  id: string;
  name?: string;
  status?: string;
  leadListId?: string;
  deployedUrl?: string;
  githubRepoUrl?: string;
}

/** A lead list as this script needs to see it — null when no such record exists. */
export interface BoundList {
  publicAccessEnabled?: boolean;
  leadCount?: number;
}

export type BoundListAction =
  /** Private list a page is bound to — the ENG-967 failure. Flip it public. */
  | "repair"
  /** Already accepts public submissions and has leads — nothing to do. */
  | "ok"
  /** Public but still empty, or referenced but missing. Not repairable here. */
  | "needs-diagnosis";

/**
 * Decide what to do with one page-bound lead list. Pure — no I/O — so the policy that
 * governs a bulk production mutation is unit-tested rather than inferred from a dry run.
 *
 * `leadCount` is only ever used to route an already-public list into the report; it never
 * gates a write. A public list with leads and a public list without both stay untouched.
 */
export function classifyBoundList(list: BoundList | null | undefined): {
  action: BoundListAction;
  reason: string;
} {
  if (!list) {
    // A page names a list that isn't in AW-LeadLists: forward-lead answers 404 and the
    // lander swallows it. Repointing a page at a different list is a judgement call, not
    // a backfill.
    return { action: "needs-diagnosis", reason: "list-missing" };
  }
  if (list.publicAccessEnabled !== true) {
    return { action: "repair", reason: "private-list-bound-to-page" };
  }
  if (!list.leadCount) {
    // Public and empty — ENG-967's list_1779822422539_l5yvansu2 class. Public access was
    // never the blocker here, so flipping anything would be a no-op dressed up as a fix.
    return { action: "needs-diagnosis", reason: "already-public-but-empty" };
  }
  return { action: "ok", reason: "already-public" };
}

async function main() {
  console.log("ENG-967 lead-list public-access backfill", {
    region: process.env.AWS_REGION,
    tableName: TABLE_NAME,
    mode: APPLY ? "APPLY (will write)" : "DRY RUN (no writes — pass --apply to write)",
    listFilter: LIST_FILTER ?? "(none — every page-bound list)",
  });

  // ── Pass 1: every page-bound lead list, with the pages that bind it ──────────────────
  // Not filtered by page status, for the same reason backfill-eng501-middleware-fix.ts
  // isn't: a stale/failed DB status doesn't mean the deployed page stopped taking form
  // submissions, and skipping it would leave exactly the silent drop we're repairing.
  const pagesByList = new Map<string, LpItem[]>();
  let totalScanned = 0;
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const res = await dynamodb
      .scan({ TableName: TABLE_NAME, Limit: 100, ExclusiveStartKey: lastKey })
      .promise();
    lastKey = res.LastEvaluatedKey;
    for (const item of (res.Items ?? []) as LpItem[]) {
      totalScanned++;
      if (!item.leadListId) continue;
      if (LIST_FILTER && item.leadListId !== LIST_FILTER) continue;
      const pages = pagesByList.get(item.leadListId) ?? [];
      pages.push(item);
      pagesByList.set(item.leadListId, pages);
    }
  } while (lastKey);

  console.log(
    `\nScanned ${totalScanned} landing pages; ${pagesByList.size} distinct bound lead lists` +
      (LIST_FILTER ? ` matching --list=${LIST_FILTER}` : "") +
      ".\n"
  );

  // ── Pass 2: classify each list, repair the private ones ─────────────────────────────
  let repaired = 0;
  let ok = 0;
  let failed = 0;
  const needsDiagnosis: Array<{ listId: string; reason: string; pages: LpItem[] }> = [];

  for (const [listId, pages] of pagesByList) {
    let list: BoundList | null = null;
    try {
      list = (await crmDb.getLeadListById(listId)) as BoundList | null;
    } catch (err) {
      console.log(`  LIST ${listId}: read failed — ${(err as Error).message}`);
      failed++;
      continue;
    }

    const { action, reason } = classifyBoundList(list);

    if (action === "ok") {
      ok++;
      continue;
    }
    if (action === "needs-diagnosis") {
      needsDiagnosis.push({ listId, reason, pages });
      continue;
    }

    if (!APPLY) {
      console.log(
        `  [DRY RUN] ${listId}: would set publicAccessEnabled=true (${reason}; ` +
          `bound by ${pages.length} page(s): ${pages.map((p) => p.name || p.id).join(", ")})`
      );
      repaired++;
      continue;
    }

    try {
      await crmDb.updateLeadList(listId, { publicAccessEnabled: true });
      console.log(`  ${listId}: publicAccessEnabled=true (${pages.length} bound page(s))`);
      repaired++;
    } catch (err) {
      console.log(`  ${listId}: write failed — ${(err as Error).message}`);
      failed++;
    }
  }

  // ── Report: what this script cannot fix ─────────────────────────────────────────────
  // Printed even when empty, so a clean run can't be misread as "everything is captured".
  console.log(`\nNEEDS DIAGNOSIS (${needsDiagnosis.length}) — not repairable by this script:`);
  for (const { listId, reason, pages } of needsDiagnosis) {
    console.log(`  ${listId} — ${reason}`);
    for (const p of pages) {
      console.log(
        `      page ${p.id} "${p.name ?? "(unnamed)"}" status=${p.status ?? "?"} ` +
          `url=${p.deployedUrl ?? "(none)"} repo=${p.githubRepoUrl ?? "(none)"}`
      );
    }
  }

  console.log(
    `\nDone. ${APPLY ? "repaired" : "wouldRepair"}=${repaired} alreadyOk=${ok} ` +
      `needsDiagnosis=${needsDiagnosis.length} failed=${failed} boundLists=${pagesByList.size}`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
