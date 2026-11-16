/**
 * ENG-131 follow-up slice: pure release manifest for the deploy-triggered docs job.
 * Maps the merged PRs in one production deploy's commit range to their ENG issues,
 * one entry per issue, keyed by the deploy workflow run id so a re-run of the same
 * deploy cannot produce duplicate docs or CSM drafts.
 * No network, no publish, no send. See docs/architecture/deploy-triggered-docs.md.
 */

export interface ManifestPr {
  number: number;
  title: string;
  body?: string | null;
  mergeCommitSha: string;
  url: string;
}

export interface ReleaseManifestInput {
  deployRunId: string;
  fromSha: string;
  toSha: string;
  mergedPrs: ManifestPr[];
  /** Commit SHAs in fromSha..toSha. When given, PRs merged outside it are ignored. */
  rangeShas?: string[];
}

export interface ReleaseManifestEntry {
  issueId: string;
  prNumbers: number[];
  mergeCommitShas: string[];
  prUrls: string[];
  idempotencyKey: string;
}

export interface ReleaseManifest {
  deployRunId: string;
  fromSha: string;
  toSha: string;
  entries: ReleaseManifestEntry[];
  /** PR numbers in range with no ENG reference, surfaced rather than dropped. */
  unlinkedPrs: number[];
}

const ISSUE_RE = /(?<![A-Za-z0-9_])eng-(\d+)(?![A-Za-z0-9_])/gi;

export function extractIssueIds(title: string, body?: string | null): string[] {
  const out: string[] = [];
  for (const text of [title, body ?? '']) {
    for (const m of text.matchAll(ISSUE_RE)) {
      const id = `ENG-${Number(m[1])}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

const issueNum = (id: string) => Number(id.slice(4));

export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  if (!input?.deployRunId) throw new Error('deployRunId is required (idempotency anchor)');
  const range = input.rangeShas ? new Set(input.rangeShas) : null;
  const prs = [...input.mergedPrs]
    .filter((p) => !range || range.has(p.mergeCommitSha))
    .sort((a, b) => a.number - b.number);

  const byIssue = new Map<string, ReleaseManifestEntry>();
  const unlinkedPrs: number[] = [];
  for (const pr of prs) {
    const ids = extractIssueIds(pr.title, pr.body);
    if (ids.length === 0) {
      unlinkedPrs.push(pr.number);
      continue;
    }
    for (const issueId of ids) {
      const e = byIssue.get(issueId) ?? {
        issueId,
        prNumbers: [],
        mergeCommitShas: [],
        prUrls: [],
        idempotencyKey: `${input.deployRunId}:${issueId}`,
      };
      e.prNumbers.push(pr.number);
      e.mergeCommitShas.push(pr.mergeCommitSha);
      e.prUrls.push(pr.url);
      byIssue.set(issueId, e);
    }
  }

  return {
    deployRunId: input.deployRunId,
    fromSha: input.fromSha,
    toSha: input.toSha,
    entries: [...byIssue.values()].sort((a, b) => issueNum(a.issueId) - issueNum(b.issueId)),
    unlinkedPrs,
  };
}
