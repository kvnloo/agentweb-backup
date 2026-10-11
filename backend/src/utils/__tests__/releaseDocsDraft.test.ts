import { buildReleaseDocsDraft, isCustomerFacing, slugify } from '../releaseDocsDraft';

const pr = {
  number: 42,
  title: 'feat: Google Docs read/write (ENG-15)',
  body: 'adds docs tools',
  mergeCommitSha: 'abc123',
  url: 'https://github.com/AgentWebPro/agentweb/pull/42',
  labels: [],
  changedFiles: ['backend/src/emma/googleDocsTools.ts'],
};
const issue = {
  identifier: 'ENG-15',
  title: 'Native Google Docs read/write integration',
  description: '# Heading\n\nEmma can now read and edit Google Docs you share with her.\n\nMore detail.',
  labels: ['Feature'],
  url: 'https://linear.app/x/issue/ENG-15',
  requester: { name: 'Jane Doe', company: 'xCures', email: 'jane@example.com' },
};

describe('buildReleaseDocsDraft (ENG-131)', () => {
  it('builds a draft docs entry and an unsent CSM note for a customer-facing feature', () => {
    const r = buildReleaseDocsDraft(pr, issue);
    expect(r.customerFacing).toBe(true);
    expect(r.docsEntry).toMatchObject({
      idempotencyKey: 'ENG-15:abc123',
      slug: 'native-google-docs-read-write-integration',
      summary: 'Emma can now read and edit Google Docs you share with her.',
      status: 'draft',
    });
    expect(r.csmNote).toMatchObject({ sendable: false, status: 'draft_unsent', subject: 'Now live: Native Google Docs read/write integration' });
    expect(r.csmNote!.body).toContain('Hi Jane,');
  });

  it('is deterministic: same release input yields the same idempotency key and output', () => {
    expect(buildReleaseDocsDraft(pr, issue)).toEqual(buildReleaseDocsDraft(pr, issue));
  });

  it('skips non-customer-facing work (no docs, no note)', () => {
    const r = buildReleaseDocsDraft(pr, { ...issue, labels: ['Infra', 'Feature'] });
    expect(r).toEqual({ customerFacing: false, skipReason: 'not customer-facing' });
    expect(buildReleaseDocsDraft(pr, { ...issue, labels: ['Bug'] }).customerFacing).toBe(false);
  });

  it('treats test/ci-only diffs as internal', () => {
    expect(isCustomerFacing({ ...pr, changedFiles: ['.github/workflows/deploy.yml', 'backend/src/x.test.ts'] }, issue)).toBe(false);
  });

  it('internal/infra labels win over an explicit customer-facing label', () => {
    expect(isCustomerFacing(pr, { ...issue, labels: ['customer-facing', 'internal'] })).toBe(false);
    expect(isCustomerFacing({ ...pr, labels: ['Infra'] }, { ...issue, labels: ['Customer Facing'] })).toBe(false);
    expect(isCustomerFacing(pr, { ...issue, labels: ['customer-facing'] })).toBe(true);
  });

  it('treats nested __tests__ directories as internal', () => {
    expect(isCustomerFacing({ ...pr, changedFiles: ['backend/src/utils/__tests__/fixture.ts'] }, issue)).toBe(false);
  });

  it('omits the CSM note when no requester is linked', () => {
    const r = buildReleaseDocsDraft(pr, { ...issue, requester: null });
    expect(r.docsEntry).toBeDefined();
    expect(r.csmNote).toBeUndefined();
  });

  it('rejects unmerged PRs', () => {
    expect(() => buildReleaseDocsDraft({ ...pr, mergeCommitSha: '' }, issue)).toThrow(/merged/);
  });

  it('slugify strips ENG refs and punctuation', () => {
    expect(slugify('Add X/Y support (ENG-9)!')).toBe('add-x-y-support');
  });
});
