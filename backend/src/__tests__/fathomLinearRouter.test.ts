/**
 * Tests for the Fathom → Linear canonical reconciliation engine (ENG-259).
 *
 * The Fathom + Linear boundaries are fully mocked via a MockLinearPort — the engine is the
 * PURE decision core. Each block maps to an ENG-259 / PRD acceptance criterion.
 */

import {
  routeMeetingToLinear,
  routeMeetingsBatch,
  matchCanonical,
  isDistinctFollowOn,
  fathomKey,
  fathomKeyMarker,
  buildSearchQuery,
  ALL_TEAMS,
  FathomMeetingRef,
  ExtractedActionItem,
  LinearCandidateIssue,
  LinearPort,
  RunReport,
  RunReportEntry,
} from '../services/fathomLinearRouter';

// ---------------------------------------------------------------------------
// Mock Linear boundary
// ---------------------------------------------------------------------------

const MARKER_RE = /\[\[fathom-key:([^\]]+)\]\]/;

class MockLinearPort implements LinearPort {
  candidates: LinearCandidateIssue[] = [];
  byKey: Record<string, LinearCandidateIssue> = {};
  created: Array<{ team: string; title: string; description: string }> = [];
  comments: Array<{ issueId: string; body: string }> = [];
  relations: Array<{ issueId: string; relatedIssueId: string }> = [];
  searchCalls = 0;
  findKeyCalls: string[] = [];
  throwOnCreate = false;
  throwOnRelate = false;
  private nextId = 1;

  async findByFathomKey(key: string): Promise<LinearCandidateIssue | null> {
    this.findKeyCalls.push(key);
    return this.byKey[key] || null;
  }

  async searchIssues(params: { teams: string[]; query: string; limit?: number }): Promise<LinearCandidateIssue[]> {
    this.searchCalls++;
    // Record the last query for assertions.
    (this as any).lastQuery = params.query;
    (this as any).lastTeams = params.teams;
    return this.candidates;
  }

  async createIssue(params: { team: string; title: string; description: string }): Promise<LinearCandidateIssue> {
    if (this.throwOnCreate) throw new Error('Linear issueCreate failed');
    this.created.push(params);
    const n = this.nextId++;
    const issue: LinearCandidateIssue = {
      id: `uuid-${n}`,
      identifier: `${params.team}-${100 + n}`,
      team: params.team as any,
      title: params.title,
      description: params.description,
      url: `https://linear.app/emmabyaw/issue/${params.team}-${100 + n}`,
    };
    // Simulate the real port's marker-indexed lookup so a re-run is idempotent.
    const m = params.description.match(MARKER_RE);
    if (m) this.byKey[m[1]] = issue;
    return issue;
  }

  async addComment(params: { issueId: string; body: string }): Promise<void> {
    this.comments.push(params);
  }

  async relateIssues(params: { issueId: string; relatedIssueId: string }): Promise<void> {
    if (this.throwOnRelate) throw new Error('Linear relation failed');
    this.relations.push(params);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const meeting = (over: Partial<FathomMeetingRef> = {}): FathomMeetingRef => ({
  recordingId: 'rec-747768521',
  title: 'Baldwin Weekly Sync',
  url: 'https://fathom.video/calls/747768521?timestamp=1806',
  date: '2026-07-16T18:00:00Z',
  participants: ['harsha@agentweb.pro', 'client@baldwin.com'],
  ...over,
});

const item = (over: Partial<ExtractedActionItem> = {}): ExtractedActionItem => ({
  id: 'ai-1',
  action: 'Add SSO login support for Acme',
  team: 'ENG',
  actionable: true,
  ...over,
});

const grow6 = (): LinearCandidateIssue => ({
  id: 'uuid-grow6',
  identifier: 'GROW-6',
  team: 'GROW',
  title: 'Baldwin onboarding workflow',
  description: 'Canonical customer workflow for Baldwin onboarding and weekly reporting cadence.',
  url: 'https://linear.app/emmabyaw/issue/GROW-6',
  owner: 'Harsha',
});

function allEntries(r: RunReport): RunReportEntry[] {
  return [...r.created, ...r.enriched, ...r.related, ...r.duplicatesAvoided, ...r.notFiled, ...r.needsPm, ...r.errors];
}

// ---------------------------------------------------------------------------

describe('fathomLinearRouter — create (distinct new work, no canonical)', () => {
  it('creates a correctly-routed issue with a timestamped Fathom link + idempotency marker', async () => {
    const port = new MockLinearPort();
    port.candidates = [];
    const m = meeting();
    const it = item({ team: 'ENG', customer: 'Acme', action: 'Add SSO login support for Acme' });

    const report = await routeMeetingToLinear(m, [it], port);

    expect(port.created).toHaveLength(1);
    expect(port.created[0].team).toBe('ENG');
    expect(port.created[0].description).toContain(m.url); // meeting link recorded (grounding)
    expect(port.created[0].description).toContain(fathomKeyMarker(fathomKey(m.recordingId, it.id)));
    expect(port.comments).toHaveLength(0);
    expect(port.relations).toHaveLength(0);
    expect(report.created).toHaveLength(1);
    expect(report.created[0].identifier).toBe('ENG-101');
    expect(report.mode).toBe('live');
  });

  it('searches all four boards before creating', async () => {
    const port = new MockLinearPort();
    await routeMeetingToLinear(meeting(), [item()], port);
    expect(port.searchCalls).toBe(1);
    expect((port as any).lastTeams).toEqual(ALL_TEAMS);
  });
});

describe('fathomLinearRouter — enrich (matching canonical, same unit of work)', () => {
  it('adds a source-linked comment to the canonical instead of creating', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()];
    const m = meeting();
    const it = item({
      team: 'GROW',
      customer: 'Baldwin',
      action: 'Baldwin onboarding weekly report follow-up',
      workflowNouns: ['onboarding', 'weekly report'],
    });

    const report = await routeMeetingToLinear(m, [it], port);

    expect(port.created).toHaveLength(0);
    expect(port.comments).toHaveLength(1);
    expect(port.comments[0].issueId).toBe('uuid-grow6');
    expect(port.comments[0].body).toContain(m.url); // enrichment carries the meeting link
    expect(report.enriched).toHaveLength(1);
    expect(report.enriched[0].identifier).toBe('GROW-6');
  });
});

describe('fathomLinearRouter — cross-board dedup (the Baldwin / GROW-6 lesson)', () => {
  it('a CS-shaped follow-up for an existing GROW customer workflow enriches the GROW canonical, no CS duplicate', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()]; // canonical lives on GROW
    const it = item({
      team: 'CS', // the follow-up looks CS-shaped...
      customer: 'Baldwin',
      action: 'Baldwin onboarding weekly report follow-up',
      workflowNouns: ['onboarding', 'weekly report'],
    });

    const report = await routeMeetingToLinear(meeting(), [it], port);

    // ...but it enriches GROW-6 rather than opening a CS clone.
    expect(port.created).toHaveLength(0);
    expect(report.related).toHaveLength(0);
    expect(report.enriched).toHaveLength(1);
    expect(report.enriched[0].identifier).toBe('GROW-6');
  });

  it('creates + relates when the follow-up has a distinct owner, next action, and completion criteria', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()]; // canonical owner: Harsha
    const it = item({
      team: 'CS',
      customer: 'Baldwin',
      action: 'Schedule Baldwin live account review',
      workflowNouns: ['onboarding'],
      owner: 'Fangfang', // distinct owner
      nextAction: 'Book a live account-review call with Baldwin',
      doneCriteria: 'Review call completed and notes filed',
    });

    const report = await routeMeetingToLinear(meeting(), [it], port);

    expect(port.created).toHaveLength(1);
    expect(port.created[0].team).toBe('CS'); // the follow-on lands on its own board...
    expect(port.relations).toHaveLength(1); // ...but is RELATED to the canonical, not cloned
    expect(port.relations[0].relatedIssueId).toBe('uuid-grow6');
    expect(report.related).toHaveLength(1);
    expect(report.related[0].canonicalIdentifier).toBe('GROW-6');
    expect(report.enriched).toHaveLength(0);
  });
});

describe('fathomLinearRouter — idempotency (retry safety)', () => {
  it('a re-run of the same meeting finds its own prior write and no-ops (no duplicate)', async () => {
    const port = new MockLinearPort();
    port.candidates = [];
    const m = meeting();
    const it = item({ customer: 'Acme', action: 'Add SSO login support for Acme' });

    const first = await routeMeetingToLinear(m, [it], port);
    expect(first.created).toHaveLength(1);
    expect(port.created).toHaveLength(1);

    // Same meeting + item reprocessed (createIssue registered the key marker).
    const second = await routeMeetingToLinear(m, [it], port);
    expect(port.created).toHaveLength(1); // still ONE issue
    expect(second.created).toHaveLength(0);
    expect(second.duplicatesAvoided).toHaveLength(1);
    expect(second.duplicatesAvoided[0].identifier).toBe('ENG-101');
  });

  it('never writes new work when the idempotency key already exists', async () => {
    const port = new MockLinearPort();
    const m = meeting();
    const it = item();
    port.byKey[fathomKey(m.recordingId, it.id)] = grow6();

    const report = await routeMeetingToLinear(m, [it], port);

    // A live-mode redelivery MAY search once (relation-repair check — see the
    // relation-durability block), but it must never create, comment, or relate
    // for a non-follow-on item: the outcome is a pure idempotent no-op.
    expect(port.created).toHaveLength(0);
    expect(port.comments).toHaveLength(0);
    expect(port.relations).toHaveLength(0);
    expect(report.duplicatesAvoided).toHaveLength(1);
  });

  it('does not even search on a shadow-mode idempotent hit', async () => {
    const port = new MockLinearPort();
    const m = meeting();
    const it = item();
    port.byKey[fathomKey(m.recordingId, it.id)] = grow6();

    const report = await routeMeetingToLinear(m, [it], port, { dryRun: true });

    expect(port.searchCalls).toBe(0);
    expect(port.created).toHaveLength(0);
    expect(report.duplicatesAvoided).toHaveLength(1);
  });
});

describe('fathomLinearRouter — hard-signals only', () => {
  it('does not file sentiment / speculative items (records them as not filed)', async () => {
    const port = new MockLinearPort();
    const it = item({ action: 'Customer seems generally happy with the product', actionable: false });

    const report = await routeMeetingToLinear(meeting(), [it], port);

    expect(port.created).toHaveLength(0);
    expect(port.searchCalls).toBe(0);
    expect(report.notFiled).toHaveLength(1);
    expect(report.notFiled[0].reason).toMatch(/not-actionable/);
  });

  it('routes an ambiguous customer to Needs PM with no Linear write', async () => {
    const port = new MockLinearPort();
    const it = item({ action: 'Follow up on the integration ask', customerAmbiguous: true });

    const report = await routeMeetingToLinear(meeting(), [it], port);

    expect(port.created).toHaveLength(0);
    expect(report.needsPm).toHaveLength(1);
    expect(report.needsPm[0].reason).toMatch(/ambiguous customer/);
  });
});

describe('fathomLinearRouter — fail well', () => {
  it('records a per-item port error and keeps processing the rest of the batch', async () => {
    const port = new MockLinearPort();
    port.candidates = [];
    port.throwOnCreate = true;
    const good = item({ id: 'ai-1', action: 'Not actionable chatter', actionable: false });
    const bad = item({ id: 'ai-2', action: 'Ship the export feature', customer: 'Acme' });

    const report = await routeMeetingToLinear(meeting(), [good, bad], port);

    expect(report.notFiled).toHaveLength(1); // the sentiment item still handled
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].itemId).toBe('ai-2');
    // The failed item is NOT mis-reported as created.
    expect(report.created).toHaveLength(0);
  });
});

describe('fathomLinearRouter — shadow / dry-run (PRD Phase 1)', () => {
  it('computes proposed actions without any mutating write, but still reads', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()];
    const create = item({ id: 'a', customer: 'Acme', action: 'Add SSO login for Acme' });
    const enrich = item({ id: 'b', team: 'GROW', customer: 'Baldwin', action: 'Baldwin onboarding weekly report follow-up', workflowNouns: ['onboarding', 'weekly report'] });

    // create's search returns grow6 too, but Acme doesn't anchor → no match → proposed create.
    const report = await routeMeetingsBatch([{ meeting: meeting(), items: [create, enrich] }], port, { dryRun: true });

    expect(report.mode).toBe('shadow');
    expect(port.created).toHaveLength(0);
    expect(port.comments).toHaveLength(0);
    expect(port.relations).toHaveLength(0);
    expect(port.searchCalls).toBe(2); // reads still happen
    expect(report.created).toHaveLength(1);
    expect(report.created[0].proposed).toBe(true);
    expect(report.created[0].identifier).toBe('(proposed)');
    expect(report.enriched).toHaveLength(1);
    expect(report.enriched[0].proposed).toBe(true);
    expect(report.enriched[0].identifier).toBe('GROW-6');
  });
});

describe('fathomLinearRouter — reconciliation invariant', () => {
  it('every item lands in exactly one bucket and nothing created is reported not-filed', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()];
    const items: ExtractedActionItem[] = [
      item({ id: '1', customer: 'Acme', action: 'Build the Acme export' }), // create
      item({ id: '2', team: 'GROW', customer: 'Baldwin', action: 'Baldwin onboarding weekly report follow-up', workflowNouns: ['onboarding', 'weekly report'] }), // enrich
      item({ id: '3', action: 'Everyone was aligned and happy', actionable: false }), // notFiled
      item({ id: '4', action: 'Chase the integration', customerAmbiguous: true }), // needsPm
    ];

    const report = await routeMeetingToLinear(meeting(), items, port);

    const entries = allEntries(report);
    expect(entries).toHaveLength(items.length); // exactly one bucket each
    const ids = entries.map((e) => e.itemId).sort();
    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(report.itemsScanned).toBe(4);

    // No item id appears in two buckets.
    expect(new Set(ids).size).toBe(ids.length);
    // Nothing created also appears as not filed.
    const notFiledIds = new Set(report.notFiled.map((e) => e.itemId));
    for (const c of report.created) expect(notFiledIds.has(c.itemId)).toBe(false);
  });
});

describe('fathomLinearRouter — batch across meetings', () => {
  it('reports meetingsScanned across a multi-meeting run', async () => {
    const port = new MockLinearPort();
    port.candidates = [];
    const report = await routeMeetingsBatch(
      [
        { meeting: meeting({ recordingId: 'r1' }), items: [item({ id: 'x', customer: 'Acme' })] },
        { meeting: meeting({ recordingId: 'r2' }), items: [item({ id: 'y', customer: 'Zeta' })] },
      ],
      port,
    );
    expect(report.meetingsScanned).toBe(2);
    expect(report.itemsScanned).toBe(2);
    expect(report.created).toHaveLength(2);
    expect(port.created).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unit-level: matching + distinctness helpers
// ---------------------------------------------------------------------------

describe('matchCanonical', () => {
  it('returns the explicitly-referenced issue even across boards', () => {
    const c = grow6();
    const it = item({ team: 'ENG', action: 'unrelated wording', relatedIssueIds: ['GROW-6'] });
    expect(matchCanonical(meeting(), it, [c])?.identifier).toBe('GROW-6');
  });

  it('binds a same-customer workflow match', () => {
    const it = item({ customer: 'Baldwin', action: 'Baldwin onboarding weekly report follow-up', workflowNouns: ['onboarding', 'weekly report'] });
    expect(matchCanonical(meeting(), it, [grow6()])?.identifier).toBe('GROW-6');
  });

  it('does NOT merge on title coincidence without a customer/meeting anchor (bias to new)', () => {
    const c: LinearCandidateIssue = {
      id: 'u', identifier: 'ENG-9', team: 'ENG',
      title: 'Add SSO login support for Acme',
      description: 'internal auth work, no customer context', url: 'x',
    };
    const it = item({ action: 'Add SSO login support for Acme' }); // no customer set
    expect(matchCanonical(meeting(), it, [c])).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(matchCanonical(meeting(), item(), [])).toBeNull();
  });
});

describe('isDistinctFollowOn', () => {
  it('is false when the item lacks a full owner/next-action/done triad (→ enrich)', () => {
    expect(isDistinctFollowOn(item({ owner: 'Fangfang' }), grow6())).toBe(false);
  });

  it('is true when the owner differs from the canonical (→ relate)', () => {
    const it = item({ owner: 'Fangfang', nextAction: 'book review', doneCriteria: 'call done' });
    expect(isDistinctFollowOn(it, grow6())).toBe(true); // canonical owner is Harsha
  });
});

describe('fathomKey / buildSearchQuery helpers', () => {
  it('produces a stable idempotency key + marker', () => {
    const k = fathomKey('rec1', 'ai-2');
    expect(k).toBe('fathom:rec1:ai-2');
    expect(fathomKeyMarker(k)).toBe('[[fathom-key:fathom:rec1:ai-2]]');
  });

  it('packs the dedup signals into the search query', () => {
    const q = buildSearchQuery(meeting(), item({ customer: 'Baldwin', workflowNouns: ['onboarding'], relatedIssueIds: ['GROW-6'], action: 'do the thing' }));
    expect(q).toContain('Baldwin');
    expect(q).toContain('onboarding');
    expect(q).toContain('GROW-6');
    expect(q).toContain('do the thing');
  });
});

// ---------------------------------------------------------------------------
// Relation durability — the create+relate two-phase must converge (Greptile P1)
// ---------------------------------------------------------------------------

describe('fathomLinearRouter — relation durability (create + relate two-phase)', () => {
  const distinctFollowOn = () =>
    item({
      team: 'CS',
      customer: 'Baldwin',
      action: 'Schedule Baldwin live account review',
      workflowNouns: ['onboarding'],
      owner: 'Fangfang',
      nextAction: 'Book a live account-review call with Baldwin',
      doneCriteria: 'Review call completed and notes filed',
    });

  it('reconciles a failed relation as an error carrying the created issue (never double-counted)', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()];
    port.throwOnRelate = true;

    const report = await routeMeetingToLinear(meeting(), [distinctFollowOn()], port);

    expect(port.created).toHaveLength(1); // the issue WAS created…
    expect(report.related).toHaveLength(0); // …but is not reported as successfully related
    expect(report.created).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].identifier).toBe('CS-101');
    expect(report.errors[0].canonicalIdentifier).toBe('GROW-6');
    expect(report.errors[0].reason).toMatch(/relat/i);
    expect(allEntries(report)).toHaveLength(1); // exactly one outcome bucket
  });

  it('re-asserts the missing relation on redelivery (created issue excluded from canonical search)', async () => {
    const port = new MockLinearPort();
    port.candidates = [grow6()];
    port.throwOnRelate = true;
    const first = await routeMeetingToLinear(meeting(), [distinctFollowOn()], port);
    expect(first.errors).toHaveLength(1);
    expect(port.relations).toHaveLength(0);

    // Redelivery: the marker now resolves, the relation write works again, and the
    // search returns BOTH the created issue itself and the canonical.
    port.throwOnRelate = false;
    const createdIssue = Object.values(port.byKey)[0];
    port.candidates = [createdIssue, grow6()];

    const second = await routeMeetingToLinear(meeting(), [distinctFollowOn()], port);

    expect(port.relations).toHaveLength(1);
    expect(port.relations[0]).toEqual({ issueId: createdIssue.id, relatedIssueId: 'uuid-grow6' });
    expect(second.duplicatesAvoided).toHaveLength(1);
    expect(second.duplicatesAvoided[0].reason).toMatch(/re-assert/i);
    expect(second.created).toHaveLength(0);
    expect(second.related).toHaveLength(0);
  });

  it('never writes the repair relation in shadow mode', async () => {
    const port = new MockLinearPort();
    const existing = grow6();
    port.byKey[fathomKey('rec-747768521', 'ai-1')] = existing;
    port.candidates = [grow6()];

    const report = await routeMeetingToLinear(meeting(), [distinctFollowOn()], port, { dryRun: true });

    expect(port.relations).toHaveLength(0);
    expect(report.duplicatesAvoided).toHaveLength(1);
  });

  it('stays a plain idempotent no-op when redelivery finds no canonical', async () => {
    const port = new MockLinearPort();
    port.byKey[fathomKey('rec-747768521', 'ai-1')] = grow6();
    port.candidates = [];

    const report = await routeMeetingToLinear(meeting(), [distinctFollowOn()], port);

    expect(port.relations).toHaveLength(0);
    expect(report.duplicatesAvoided).toHaveLength(1);
    expect(report.duplicatesAvoided[0].reason).toBe('already processed (idempotent)');
  });

  it('reports a failed re-assert as an error so a later redelivery can retry it', async () => {
    const port = new MockLinearPort();
    const created = { ...grow6(), id: 'uuid-created', identifier: 'CS-200' };
    port.byKey[fathomKey('rec-747768521', 'ai-1')] = created;
    port.candidates = [grow6()];
    port.throwOnRelate = true;

    const report = await routeMeetingToLinear(meeting(), [distinctFollowOn()], port);

    expect(report.duplicatesAvoided).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].reason).toMatch(/re-assert/i);
  });
});
