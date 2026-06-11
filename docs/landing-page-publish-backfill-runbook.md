# Landing Page "Revert Publish" Backfill — Admin Runbook

This runbook backfills the `lastPublish` field on **already-deployed** landing pages so the **"Revert last publish"** capability (UI button + the `revert_landing_page_publish` Emma tool) becomes available on pages that were published **before** publish-history recording shipped (PR #1811).

> **New publishes do not need this runbook.** As of PR #1811, every publish records `lastPublish` automatically, so any page published after the deploy is revertable for free. This runbook is **only** for pages that already existed at deploy time and therefore have no recorded pre-publish SHA.

Script: `backend/src/scripts/backfill-landing-page-publish.ts`

---

## What the script does

The revert force-resets a repo's `main` ref back to a recorded `preMergeSha`. To backfill that safely on existing pages, the script — per landing-page GitHub repo:

1. Reads `main`'s **most recent commit** and its **first parent** via the GitHub API.
2. Maps that commit to the **single page** it corresponds to:
   - a `(/slug)` in the commit message matched to a page's `slug` (sub-pages), or
   - the lone page in a single-page repo when the message has no slug.
3. Writes `lastPublish = { preMergeSha: <HEAD^>, mergeSha: <HEAD>, branch: "(backfilled)", publishedAt: <commit date> }` for that one page.

Reverting a backfilled page therefore rolls `main` back exactly one commit (to `HEAD^`) and redeploys — a genuine undo of the most recent change, not a no-op.

### Why only one page per repo

Landing pages frequently **share one repo** (one Vercel project, many `/slug` sub-pages) with a single shared `main` history. A revert resets that shared ref, so only the page sitting at the tip of `main` can be rolled back without silently discarding newer sibling pages. The script deliberately backfills **at most one page per repo** — the one at HEAD.

### What it skips (by design)

- **Chore commits** at HEAD (`chore: inject/remove GTM container`, subdomain routing, etc.) — config tweaks, not content publishes. Backfilling these would surface a button that strips a user's GTM tag.
- **Initial commits** (no parent) — nothing to revert to.
- **Multi-page repos whose HEAD commit has no slug** — can't confidently attribute the commit to one page.
- **Pages that already have a `lastPublish`** — never clobbered (also enforced at the DB layer via a conditional write).

---

## Safety properties

- **Dry-run by default.** Running with no flags only *prints* what it would do. The `--apply` flag is required to write.
- **Conditional write:** `attribute_not_exists(lastPublish)` — a real publish that lands mid-run is never overwritten.
- **Idempotent:** re-running after an apply writes 0 (everything already has a record).
- **Read-only against GitHub/Vercel:** the script never touches git or triggers deploys — it only writes the DynamoDB `lastPublish` field. (Actual reverts happen later, only when a user clicks the button.)

---

## Procedure (run once per environment)

Run from inside a checkout of the agentweb repo, in `backend/`.

1. **Confirm the right environment.** `NODE_ENV` selects the table (`Dev-AW-LandingPages` in development, `AW-LandingPages` otherwise).
   ```bash
   aws sts get-caller-identity            # confirm account
   aws configure get region               # expect us-west-2
   ```

2. **Dry run first — always.** Review every "WOULD BACKFILL" line and confirm the page↔commit mapping looks right.
   ```bash
   cd backend
   # dev:
   NODE_ENV=development npx ts-node src/scripts/backfill-landing-page-publish.ts
   # prod:
   NODE_ENV=production  npx ts-node src/scripts/backfill-landing-page-publish.ts
   ```

3. **Apply.**
   ```bash
   NODE_ENV=<development|production> npx ts-node src/scripts/backfill-landing-page-publish.ts --apply
   ```

4. **Verify.** Spot-check a backfilled record and confirm idempotency.
   ```bash
   aws dynamodb get-item --table-name <Dev-AW-LandingPages|AW-LandingPages> --region us-west-2 \
     --key '{"id":{"S":"<pageId>"}}' \
     --query 'Item.lastPublish.M'
   # re-running the dry run should now report "Would backfill: 0"
   ```

The summary at the end reports: repos processed, backfilled, skipped (already had record), skipped (no confident match), and repo errors.

---

## Rollback

The script only adds a `lastPublish` attribute; it changes no git/Vercel state. To undo a backfill on a page, remove the attribute:

```bash
aws dynamodb update-item --table-name <table> --region us-west-2 \
  --key '{"id":{"S":"<pageId>"}}' \
  --update-expression "REMOVE lastPublish"
```

This simply hides the "Revert last publish" button again; the live site is unaffected.

---

## Status

- **Dev:** applied 2026-06-10 — 4 pages backfilled, 2 repos correctly skipped (1 already had a record, 1 HEAD was a chore commit). 0 errors.
- **Prod:** not yet run. Run as a deliberate post-deploy step after PR #1811 ships.
