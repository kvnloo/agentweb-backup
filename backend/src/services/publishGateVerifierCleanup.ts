/**
 * ENG-2795 (ENG-1496.2): dry-run cleanup selector for the publish-gate verifier fixture.
 *
 * The verifier (ENG-2794, services/publishGateVerifier.ts) only touches pages tagged
 * `publish-gate-verifier`. This module decides which fixture artefacts a cleanup run would
 * delete. It is pure and performs no deletes: callers pass in candidate pages and get back a
 * plan. Lifecycle, ownership and cost limits: docs/publish-gate-verifier-fixture.md.
 */

/** Must equal VERIFIER_OWNED_TAG in publishGateVerifier.ts (ENG-2794). */
export const VERIFIER_FIXTURE_TAG = "publish-gate-verifier";

/** Draft branches the verifier creates are namespaced so cleanup never matches a customer branch. */
export const VERIFIER_BRANCH_PREFIX = "verifier/publish-gate-";

export interface CleanupCandidatePage {
  id: string;
  tags?: string[];
  organizationId?: string;
  branches?: string[];
  createdAt?: string;
}

export interface CleanupOptions {
  /** The single org that owns the fixture. Pages outside it are never selected, even if tagged. */
  fixtureOrganizationId: string;
  /** Only select pages older than this many ms (default 24h) so an in-flight run is not cut. */
  minAgeMs?: number;
  now?: Date;
}

export interface CleanupPlanItem {
  pageId: string;
  branches: string[];
}

export interface CleanupPlan {
  dryRun: true;
  delete: CleanupPlanItem[];
  skipped: { pageId: string; reason: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isVerifierOwnedPage(page: CleanupCandidatePage, fixtureOrganizationId: string): boolean {
  return (
    !!fixtureOrganizationId &&
    page.organizationId === fixtureOrganizationId &&
    Array.isArray(page.tags) &&
    page.tags.includes(VERIFIER_FIXTURE_TAG)
  );
}

/** Build a dry-run plan. Never mutates anything; deletion is a separate, human-reviewed step. */
export function planVerifierCleanup(pages: CleanupCandidatePage[], options: CleanupOptions): CleanupPlan {
  const now = (options.now ?? new Date()).getTime();
  const minAgeMs = options.minAgeMs ?? DAY_MS;
  const plan: CleanupPlan = { dryRun: true, delete: [], skipped: [] };

  for (const page of pages) {
    if (!isVerifierOwnedPage(page, options.fixtureOrganizationId)) {
      plan.skipped.push({ pageId: page.id, reason: "not_verifier_owned" });
      continue;
    }
    const created = page.createdAt ? Date.parse(page.createdAt) : NaN;
    if (!Number.isFinite(created) || now - created < minAgeMs) {
      plan.skipped.push({ pageId: page.id, reason: "too_recent_or_unknown_age" });
      continue;
    }
    plan.delete.push({
      pageId: page.id,
      branches: (page.branches ?? []).filter((b) => b.startsWith(VERIFIER_BRANCH_PREFIX)),
    });
  }
  return plan;
}
