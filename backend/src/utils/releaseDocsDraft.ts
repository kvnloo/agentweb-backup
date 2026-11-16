/**
 * ENG-131 slice: pure transform from a merged PR + its Linear issue into a
 * draft docs entry and a draft (UNSENT) CSM note. No network, no publish, no
 * send — the release job that consumes these objects is a follow-up issue.
 * See docs/architecture/deploy-triggered-docs.md.
 */

export interface MergedPrPayload {
  number: number;
  title: string;
  body?: string | null;
  mergeCommitSha: string;
  url: string;
  labels?: string[];
  changedFiles?: string[];
}

export interface LinearIssuePayload {
  identifier: string; // e.g. ENG-15
  title: string;
  description?: string | null;
  labels?: string[];
  url: string;
  requester?: { name?: string | null; company?: string | null; email?: string | null } | null;
}

export interface DraftDocsEntry {
  idempotencyKey: string;
  issueId: string;
  slug: string;
  title: string;
  summary: string;
  sourcePrUrl: string;
  sourceIssueUrl: string;
  status: 'draft';
}

export interface DraftCsmNote {
  idempotencyKey: string;
  issueId: string;
  requester: { name: string | null; company: string | null; email: string | null };
  subject: string;
  body: string;
  /** Always false: a human CSM sends. This module never sends anything. */
  sendable: false;
  status: 'draft_unsent';
}

export interface ReleaseDocsDraftResult {
  customerFacing: boolean;
  skipReason?: string;
  docsEntry?: DraftDocsEntry;
  csmNote?: DraftCsmNote;
}

const CUSTOMER_FACING_LABELS = new Set(['feature', 'customer-facing', 'customer facing']);
const INTERNAL_LABELS = new Set(['infra', 'internal', 'chore', 'ci', 'tech debt']);
const INTERNAL_PATH = /^(\.github\/|docs\/|scripts\/|infra\/)|(__tests__\/|\.test\.[tj]sx?$)/;

function norm(labels?: string[]): string[] {
  return (labels ?? []).map((l) => l.trim().toLowerCase());
}

export function isCustomerFacing(pr: MergedPrPayload, issue: LinearIssuePayload): boolean {
  const labels = [...norm(pr.labels), ...norm(issue.labels)];
  if (!labels.some((l) => CUSTOMER_FACING_LABELS.has(l))) return false;
  if (labels.some((l) => INTERNAL_LABELS.has(l))) return false;
  if (labels.some((l) => l === 'customer-facing' || l === 'customer facing')) return true;
  const files = pr.changedFiles ?? [];
  if (files.length > 0 && files.every((f) => INTERNAL_PATH.test(f))) return false;
  return true;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(eng-\d+\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** First non-heading paragraph of the issue description, bounded. */
export function summarize(description?: string | null, fallback = ''): string {
  const paras = (description ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#') && !p.startsWith('```') && !/^[-*|]/.test(p));
  const text = (paras[0] ?? fallback).replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

export function buildReleaseDocsDraft(
  pr: MergedPrPayload,
  issue: LinearIssuePayload
): ReleaseDocsDraftResult {
  if (!pr?.mergeCommitSha) throw new Error('mergeCommitSha is required (PR must be merged)');
  if (!issue?.identifier) throw new Error('Linear issue identifier is required');

  if (!isCustomerFacing(pr, issue)) {
    return { customerFacing: false, skipReason: 'not customer-facing' };
  }

  const idempotencyKey = `${issue.identifier}:${pr.mergeCommitSha}`;
  const title = issue.title.trim();
  const summary = summarize(issue.description, title);

  const docsEntry: DraftDocsEntry = {
    idempotencyKey,
    issueId: issue.identifier,
    slug: slugify(title) || issue.identifier.toLowerCase(),
    title,
    summary,
    sourcePrUrl: pr.url,
    sourceIssueUrl: issue.url,
    status: 'draft',
  };

  const result: ReleaseDocsDraftResult = { customerFacing: true, docsEntry };

  const r = issue.requester;
  if (r && (r.name || r.email || r.company)) {
    const greeting = r.name ? `Hi ${r.name.split(' ')[0]},` : 'Hi,';
    result.csmNote = {
      idempotencyKey,
      issueId: issue.identifier,
      requester: { name: r.name ?? null, company: r.company ?? null, email: r.email ?? null },
      subject: `Now live: ${title}`,
      body: [
        greeting,
        '',
        `The feature you asked for is now live: ${title}.`,
        '',
        summary,
        '',
        'Docs link: [to be added after the docs page is published]',
      ].join('\n'),
      sendable: false,
      status: 'draft_unsent',
    };
  }

  return result;
}
