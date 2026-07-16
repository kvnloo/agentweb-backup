/**
 * ENG-187 — funnel-status triage enrichment at the intake seam (Linear-side only).
 *
 * Behavioral contract (human-written on ENG-187, comment "Design settled + behavioral contract
 * (Harsha, 2026-07-07)") covered here:
 *  #1 Retention-stage bug -> stage labels + Urgent + Todo + default assignee (Harshit)
 *  #2 Trial-stage bug (Account Setup … Payment Conversion) -> stage labels + High
 *  #3 Missing/unknown funnel status -> STILL Todo + default assignee + Medium (bugs never rot)
 *  #5 Zero funnel leakage to the user: Featurebase ticket/post payloads + reporter-facing email
 *     carry no funnel/stage string
 *  #6 Dedup upgrade: an additional reporter unions stage labels + raises (never lowers) priority
 * (#4 feature-request Linear enrichment has no code seam in this repo — see the PR body; #7 loud
 *  label resolution is covered in linearService.test.ts.)
 */
import { fileUserIssue, notifyCanonicalResolved } from '../services/intakeService';

jest.mock('../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../services/dedupService', () => ({ findDuplicate: jest.fn(), MAX_CANDIDATES: 30 }));
jest.mock('../services/featurebaseService', () => ({
  listOpenPosts: jest.fn().mockResolvedValue([]),
  createPost: jest.fn(),
  addComment: jest.fn(),
  addVoter: jest.fn(),
  createTicket: jest.fn(),
  getTicketStatusId: jest.fn().mockResolvedValue('status-completed'),
  patchTicketStatus: jest.fn(),
}));
jest.mock('../services/linearService', () => ({
  listOpenBugCanonicals: jest.fn().mockResolvedValue([]),
  createInternalLinearIssue: jest.fn(),
  addIssueComment: jest.fn(),
  raiseIssueTriage: jest.fn(),
  getIssueCommentsDetailed: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/resendService', () => ({ resendService: { sendSystemEmail: jest.fn() } }));
jest.mock('../services/shipNotifyService', () => ({ notifyReporterShipped: jest.fn().mockResolvedValue('sent') }));

const dedup = require('../services/dedupService');
const fb = require('../services/featurebaseService');
const linear = require('../services/linearService');
const resend = require('../services/resendService').resendService;

const HARSHIT = '4c29baa4-7778-42d9-8b35-045e4d9ec0b0';
// Every spelling a leak could take. "Status:" catches the stage labels; the coarse-bucket words
// catch the tags; "funnel" catches the raw field.
const FUNNEL_MARKERS = ['funnel', 'Status:', 'User Status', 'Retention', 'Setup', 'Activated', 'Parked', 'Paid / Retention Handoff'];
const expectNoFunnelStrings = (payload: unknown) => {
  const s = JSON.stringify(payload);
  for (const marker of FUNNEL_MARKERS) expect(s).not.toContain(marker);
};

describe('fileUserIssue bug triage — funnel-derived labels, priority, state, assignee (ENG-187)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenBugCanonicals.mockResolvedValue([]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-100', url: 'lin', id: 'uuid-100' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
  });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  // Contract #1
  it('Paid / Retention Handoff reporter -> Bug + Customer Reported + stage labels, Urgent, Todo, Harshit', async () => {
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'on save', userEmail: 'u@e.com', funnelStatus: 'paid_retention_handoff' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      labelNames: ['Bug', 'Customer Reported', 'Status: Paid / Retention Handoff', 'Retention'],
      priority: 1, // Urgent
      stateName: 'Todo',
      assigneeId: HARSHIT,
    }));
  });

  // Contract #2 — trial stages (Account Setup … Payment Conversion) -> High
  it('Account Setup reporter -> stage labels + High', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com', funnelStatus: 'account_setup' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      labelNames: ['Bug', 'Customer Reported', 'Status: Account Setup', 'Setup'],
      priority: 2, // High
      stateName: 'Todo',
      assigneeId: HARSHIT,
    }));
  });

  it('Payment Conversion reporter (end of the trial range) -> stage labels + High', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com', funnelStatus: 'payment_conversion' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      labelNames: ['Bug', 'Customer Reported', 'Status: Payment Conversion', 'Activated'],
      priority: 2,
    }));
  });

  it('sales-stage reporter -> stage labels + Medium (coarse tag Sales)', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com', funnelStatus: 'sales_conversation' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      labelNames: ['Bug', 'Customer Reported', 'Status: Sales Conversation', 'Sales'],
      priority: 3, // Medium
    }));
  });

  // Contract #3 — missing/unknown funnel status: bugs still never rot
  it('MISSING funnel status -> still Todo + default assignee + Medium, base labels only', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      labelNames: ['Bug', 'Customer Reported'],
      priority: 3,
      stateName: 'Todo',
      assigneeId: HARSHIT,
    }));
  });

  it('UNKNOWN funnel status value -> still Todo + default assignee + Medium', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com', funnelStatus: 'mystery_stage' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      // The unmapped stage still gets its Status label (resolution loudness is Linear-side);
      // no coarse tag exists, so priority falls back to Medium.
      labelNames: ['Bug', 'Customer Reported', 'Status: mystery_stage'],
      priority: 3,
      stateName: 'Todo',
      assigneeId: HARSHIT,
    }));
  });
});

describe('fileUserIssue bug dedup — triage upgrade on the existing canonical (ENG-187 contract #6)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenBugCanonicals.mockResolvedValue([{ identifier: 'ENG-5', issueId: 'uuid-5', title: 'crash', description: 'x' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'ENG-5', title: 'crash', description: 'x' });
    fb.createTicket.mockResolvedValue({ id: 'tk2', number: 8, url: 'https://fb/t/8' });
  });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('a paying (Retention) reporter on an existing canonical -> unions stage labels + raises to Urgent', async () => {
    await fileUserIssue({ type: 'bug', title: 'crashes too', description: 'also on save', userEmail: 'paying@e.com', funnelStatus: 'paid_retention_handoff' });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled(); // grouped, no new canonical
    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-5', {
      addLabelNames: ['Status: Paid / Retention Handoff', 'Retention'],
      priority: 1,
    });
    // raiseIssueTriage is raise-only by contract — a lower-tier reporter can never lower the
    // priority; that invariant is unit-tested in linearService.test.ts.
  });

  it('a reporter with no funnel status on an existing canonical -> raise attempt is Medium floor, no stage labels', async () => {
    await fileUserIssue({ type: 'bug', title: 'crashes too', description: 'd', userEmail: 'u@e.com' });
    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-5', { addLabelNames: [], priority: 3 });
  });

  it('triage upgrade failure is best-effort — the filing still succeeds', async () => {
    linear.raiseIssueTriage.mockRejectedValue(new Error('linear down'));
    const r = await fileUserIssue({ type: 'bug', title: 'crashes too', description: 'd', userEmail: 'u@e.com', funnelStatus: 'paid_retention_handoff' });
    expect(r).toMatchObject({ pageId: '8', deduped: true });
    expect(linear.addIssueComment).toHaveBeenCalled(); // reporter still recorded on the canonical
  });
});

describe('funnel privacy — zero leakage to Featurebase or reporter-facing email (ENG-187 contract #5)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  const funnelContext = {
    'User Name': 'U', 'User Email': 'u@e.com', 'Page URL': '/x',
    'User Status': 'Paid / Retention Handoff', // what the call sites put in notionContext
  };
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenBugCanonicals.mockResolvedValue([]);
    fb.listOpenPosts.mockResolvedValue([]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-100', url: 'lin', id: 'uuid-100' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
    fb.createPost.mockResolvedValue({ id: 'post9', url: 'https://fb/p/new' });
  });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('bug: the Featurebase TICKET creation payload carries no funnel/stage string', async () => {
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'on save', userEmail: 'u@e.com', funnelStatus: 'paid_retention_handoff', notionContext: funnelContext });
    expect(fb.createTicket).toHaveBeenCalledTimes(1);
    expectNoFunnelStrings(fb.createTicket.mock.calls[0]);
    // …while the Linear canonical (eng-only) DOES carry the context line.
    expect(linear.createInternalLinearIssue.mock.calls[0][0].description).toContain('User Status');
  });

  it('feature request: the Featurebase POST creation payload carries no funnel/stage string', async () => {
    await fileUserIssue({ type: 'feature_request', title: 'new thing', description: 'd', userEmail: 'u@e.com', funnelStatus: 'paid_retention_handoff', notionContext: funnelContext });
    expect(fb.createPost).toHaveBeenCalledTimes(1);
    expectNoFunnelStrings(fb.createPost.mock.calls[0]);
  });

  it('feature request: even the PRIVATE Featurebase eng note is scrubbed of the funnel context line', async () => {
    await fileUserIssue({ type: 'feature_request', title: 'new thing', description: 'd', userEmail: 'u@e.com', funnelStatus: 'paid_retention_handoff', notionContext: funnelContext });
    expect(fb.addComment).toHaveBeenCalled();
    for (const call of fb.addComment.mock.calls) {
      expect(String(call[1])).not.toContain('User Status');
      expect(String(call[1])).not.toContain('Paid / Retention Handoff');
    }
    // Non-funnel context still flows through for eng.
    expect(fb.addComment.mock.calls[0][1]).toContain('Page URL');
  });

  it('feature request dedup: the stacked private comment is scrubbed too', async () => {
    fb.listOpenPosts.mockResolvedValue([{ id: 'post5', title: 'Dark mode', description: 'd', url: 'https://fb/p/dark' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'post5', title: 'Dark mode', description: 'd' });
    await fileUserIssue({ type: 'feature_request', title: 'night mode', description: 'd', userEmail: 'u@e.com', funnelStatus: 'paid_retention_handoff', notionContext: funnelContext });
    expect(fb.addComment).toHaveBeenCalledWith('post5', expect.not.stringContaining('User Status'), true);
    expect(fb.addComment).toHaveBeenCalledWith('post5', expect.not.stringContaining('Paid / Retention Handoff'), true);
  });

  it('reporter-facing resolve email carries no funnel/stage string', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: '[reporter-ticket #10 a@e.com] Affected user: a@e.com', createdAt: '2026-07-01T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('uuid-canonical', 'Save button crashes');
    expect(resend.sendSystemEmail).toHaveBeenCalledTimes(1);
    expectNoFunnelStrings(resend.sendSystemEmail.mock.calls[0]);
  });
});
