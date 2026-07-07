import { fileUserIssue, fileAutoIssue } from '../services/intakeService';

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'notion-1', notionUrl: 'https://notion.so/notion-1' }),
}));
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
  listOpenIssuesByLabel: jest.fn(),
  getIssueComments: jest.fn(),
}));
jest.mock('../services/resendService', () => ({ resendService: { sendSystemEmail: jest.fn() } }));
jest.mock('../services/shipNotifyService', () => ({ notifyReporterShipped: jest.fn().mockResolvedValue('sent') }));

const notion = require('../services/notionService');
const dedup = require('../services/dedupService');
const fb = require('../services/featurebaseService');
const linear = require('../services/linearService');
const resend = require('../services/resendService').resendService;
const shipNotify = require('../services/shipNotifyService');

describe('fileUserIssue — flag off', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('files to Notion (migration default, not a fallback)', async () => {
    process.env.FEATUREBASE_INTAKE = 'false';
    const r = await fileUserIssue({ type: 'bug', title: 't', description: 'd', userEmail: 'u@e.com' });
    expect(notion.createOncallItem).toHaveBeenCalled();
    expect(r.tracker).toBe('Notion');
    expect(dedup.findDuplicate).not.toHaveBeenCalled();
  });
});

describe('fileUserIssue — feature_request (public post)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => { process.env.FEATUREBASE_INTAKE = 'true'; fb.listOpenPosts.mockResolvedValue([]); });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('no match -> creates a public post authored by the filer + a private eng note', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    fb.createPost.mockResolvedValue({ id: 'post9', url: 'https://fb/p/new' });
    const r = await fileUserIssue({ type: 'feature_request', title: 'new thing', description: 'd', userEmail: 'u@e.com', userName: 'U', sessionId: 'sess-1' });
    expect(fb.createPost).toHaveBeenCalledWith(expect.objectContaining({ title: 'new thing', authorEmail: 'u@e.com', authorName: 'U' }));
    expect(fb.addComment).toHaveBeenCalledWith('post9', expect.stringContaining('Session: sess-1'), true);
    expect(fb.createTicket).not.toHaveBeenCalled();
    expect(r).toMatchObject({ pageId: 'post9', deduped: false, tracker: 'Featurebase', userUrl: 'https://fb/p/new' });
  });

  it('match -> stacks a voter + private comment, no new post', async () => {
    fb.listOpenPosts.mockResolvedValue([{ id: 'post5', title: 'Dark mode', description: 'd', url: 'https://fb/p/dark' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'post5', title: 'Dark mode', description: 'd' });
    const r = await fileUserIssue({ type: 'feature_request', title: 'night mode', description: 'd', userEmail: 'u@e.com', userName: 'U' });
    expect(fb.addVoter).toHaveBeenCalledWith('post5', 'u@e.com', 'U');
    expect(fb.addComment).toHaveBeenCalledWith('post5', expect.stringContaining('Also reported by u@e.com'), true);
    expect(fb.createPost).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true, tracker: 'Featurebase', userUrl: 'https://fb/p/dark' });
  });
});

describe('fileUserIssue — bug (private own-card + one canonical listing affected users)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => { process.env.FEATUREBASE_INTAKE = 'true'; linear.listOpenBugCanonicals.mockResolvedValue([]); });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('no canonical -> creates the card + ONE canonical Linear ticket (lists affected user) + a reporter-ticket comment', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
    const r = await fileUserIssue({ type: 'bug', title: 'crash', description: 'on save', userEmail: 'u@e.com', userName: 'U', sessionId: 'sess-2' });
    // reporter's own private card = their words
    expect(fb.createTicket).toHaveBeenCalledWith(expect.objectContaining({ title: 'crash', content: 'on save', authorEmail: 'u@e.com', authorName: 'U' }));
    // ONE canonical, listing the affected user
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ labelNames: ['Bug', 'Customer Reported'] }));
    expect(linear.createInternalLinearIssue.mock.calls[0][0].description).toContain('Affected user: u@e.com');
    // reporter-ticket comment (bridge contract + affected user + session). Marker embeds the
    // reporter email so the resolve bridge can email them directly.
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-9', expect.stringContaining('[reporter-ticket #7 u@e.com]'));
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-9', expect.stringContaining('Session: sess-2'));
    expect(r).toMatchObject({ pageId: '7', deduped: false, tracker: 'Featurebase', userUrl: 'https://fb/t/7' });
  });

  it('matches an existing canonical -> its OWN new card, groups onto the existing canonical, deduped=true', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([{ identifier: 'ENG-5', issueId: 'uuid-5', title: 'crash', description: 'x' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'ENG-5', title: 'crash', description: 'x' });
    fb.createTicket.mockResolvedValue({ id: 'tk2', number: 8, url: 'https://fb/t/8' });
    const r = await fileUserIssue({ type: 'bug', title: 'crashes too', description: 'also on save', userEmail: 'u2@e.com', sessionId: 'sess-3' });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled(); // grouped onto the existing canonical
    expect(fb.createTicket).toHaveBeenCalled(); // still gets its own card
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-5', expect.stringContaining('[reporter-ticket #8 u2@e.com]'));
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-5', expect.stringContaining('also on save')); // dup folds their text in
    expect(r).toMatchObject({ pageId: '8', deduped: true, tracker: 'Featurebase', userUrl: 'https://fb/t/8' });
  });

  it('createTicket throws -> PROPAGATES (no Notion fallback)', async () => {
    fb.createTicket.mockRejectedValue(new Error('FB tickets down'));
    await expect(fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' })).rejects.toThrow('FB tickets down');
    expect(notion.createOncallItem).not.toHaveBeenCalled();
  });

  it('canonical comment failure is best-effort -> the card is still returned', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
    linear.addIssueComment.mockRejectedValue(new Error('comment down'));
    const r = await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(r).toMatchObject({ pageId: '7', deduped: false });
  });
});

describe('fileUserIssue — bug priority mapping (ENG-231: stated priority becomes the Linear field, High+ lands in Todo assigned)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  const realAssignee = process.env.LINEAR_BUG_DEFAULT_ASSIGNEE_ID;
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenBugCanonicals.mockResolvedValue([]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
  });
  afterEach(() => {
    process.env.FEATUREBASE_INTAKE = realFlag;
    if (realAssignee === undefined) delete process.env.LINEAR_BUG_DEFAULT_ASSIGNEE_ID;
    else process.env.LINEAR_BUG_DEFAULT_ASSIGNEE_ID = realAssignee;
    jest.clearAllMocks();
  });

  it('High -> priority field 2 + lands in Todo + assigned to the default bug assignee', async () => {
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'd', userEmail: 'u@e.com', priority: 'High' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      priority: 2,
      startInTodo: true,
      assigneeId: expect.any(String),
    }));
  });

  it('Urgent -> priority field 1 + Todo + assignee', async () => {
    await fileUserIssue({ type: 'bug', title: 'down', description: 'd', userEmail: 'u@e.com', priority: 'Urgent' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ priority: 1, startInTodo: true }));
  });

  it('Low -> priority field 4, stays in Backlog unassigned (no escalation)', async () => {
    await fileUserIssue({ type: 'bug', title: 'nit', description: 'd', userEmail: 'u@e.com', priority: 'low' });
    const input = linear.createInternalLinearIssue.mock.calls[0][0];
    expect(input.priority).toBe(4);
    expect(input.startInTodo).toBeUndefined();
    expect(input.assigneeId).toBeUndefined();
  });

  it('no stated priority -> Medium (3), never "No priority"; no escalation', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    const input = linear.createInternalLinearIssue.mock.calls[0][0];
    expect(input.priority).toBe(3);
    expect(input.startInTodo).toBeUndefined();
  });

  it('unrecognized priority text -> Medium (3), does not crash or escalate', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com', priority: 'ASAP!!' });
    const input = linear.createInternalLinearIssue.mock.calls[0][0];
    expect(input.priority).toBe(3);
    expect(input.startInTodo).toBeUndefined();
  });

  it('LINEAR_BUG_DEFAULT_ASSIGNEE_ID env overrides the built-in default assignee', async () => {
    process.env.LINEAR_BUG_DEFAULT_ASSIGNEE_ID = 'usr-override';
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'd', userEmail: 'u@e.com', priority: 'High' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: 'usr-override' }));
  });

  it('grouped onto an existing canonical -> no new issue, so no priority escalation either', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([{ identifier: 'ENG-5', issueId: 'uuid-5', title: 'crash', description: 'x' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'ENG-5', title: 'crash', description: 'x' });
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'd', userEmail: 'u@e.com', priority: 'High' });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
  });
});

describe('intakeService.notifyCanonicalResolved (resolve bridge)', () => {
  const { notifyCanonicalResolved } = require('../services/intakeService');
  afterEach(() => jest.clearAllMocks());

  it('reads [reporter-ticket #N <email>] from the canonical comments and EMAILs + flips each card', async () => {
    linear.getIssueComments.mockResolvedValue([
      'Customer-reported bug...\nAffected user: a@e.com',
      '[reporter-ticket #10 a@e.com] Affected user: a@e.com on 2026-06-29.\nSession: s1',
      '[reporter-ticket #11 b@e.com] Affected user: b@e.com on 2026-06-29.\nSession: s2',
    ]);
    const r = await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(r.ticketNumbers.sort()).toEqual([10, 11]);
    // The EMAIL is the notification — sent to each reporter's address, with the issue title.
    expect(resend.sendSystemEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@e.com', subject: 'Resolved: Save button crashes' }));
    expect(resend.sendSystemEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@e.com', subject: 'Resolved: Save button crashes' }));
    // The card status flip reflects the resolved state.
    expect(fb.patchTicketStatus).toHaveBeenCalledWith(10, 'status-completed');
    expect(fb.patchTicketStatus).toHaveBeenCalledWith(11, 'status-completed');
  });

  it('escapes HTML in the issue title in the email body (one reporter is emailed another reporter title)', async () => {
    linear.getIssueComments.mockResolvedValue(['[reporter-ticket #10 a@e.com] x']);
    await notifyCanonicalResolved('issue-uuid', '<script>alert(1)</script>');
    const html = resend.sendSystemEmail.mock.calls[0][0].html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('no reporter-ticket comments -> no-op (not a bug canonical)', async () => {
    linear.getIssueComments.mockResolvedValue(['just a normal comment', 'another']);
    const r = await notifyCanonicalResolved('issue-uuid');
    expect(r.ticketNumbers).toEqual([]);
    expect(resend.sendSystemEmail).not.toHaveBeenCalled();
    expect(fb.getTicketStatusId).not.toHaveBeenCalled();
  });

  it('dedupes repeated ticket numbers across comments', async () => {
    linear.getIssueComments.mockResolvedValue(['[reporter-ticket #7 x@e.com] x', '[reporter-ticket #7 x@e.com] x again']);
    const r = await notifyCanonicalResolved('issue-uuid');
    expect(r.ticketNumbers).toEqual([7]);
    expect(resend.sendSystemEmail).toHaveBeenCalledTimes(1);
  });

  it('one reporter failing is best-effort -> the others still get notified', async () => {
    linear.getIssueComments.mockResolvedValue(['[reporter-ticket #10 a@e.com] a', '[reporter-ticket #11 b@e.com] b']);
    resend.sendSystemEmail.mockImplementation((p: any) => (p.to === 'a@e.com' ? Promise.reject(new Error('down')) : Promise.resolve()));
    const r = await notifyCanonicalResolved('issue-uuid');
    expect(r.ticketNumbers).toEqual([11]); // 10 failed, 11 succeeded
    expect(fb.patchTicketStatus).toHaveBeenCalledWith(11, 'status-completed');
  });

  it('pings each reporter on Slack beside the email (kind bug, canonical id as the idempotency key)', async () => {
    linear.getIssueComments.mockResolvedValue([
      '[reporter-ticket #10 a@e.com] a',
      '[reporter-ticket #11 b@e.com] b',
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(shipNotify.notifyReporterShipped).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@e.com', itemId: 'issue-uuid', title: 'Save button crashes', kind: 'bug' }),
    );
    expect(shipNotify.notifyReporterShipped).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'b@e.com', kind: 'bug' }),
    );
    // Both notified: the EMAIL is still sent to each — Slack is additive, not a replacement.
    expect(resend.sendSystemEmail).toHaveBeenCalledTimes(2);
  });

  it('Slack notifier blowing up does not block the email or the card flip', async () => {
    linear.getIssueComments.mockResolvedValue(['[reporter-ticket #10 a@e.com] a']);
    // Pin the email mock: an earlier test installs a persistent per-address rejection
    // via mockImplementation, which jest.clearAllMocks() does not remove.
    resend.sendSystemEmail.mockImplementation(() => Promise.resolve());
    shipNotify.notifyReporterShipped.mockRejectedValueOnce(new Error('slack down'));
    const r = await notifyCanonicalResolved('issue-uuid', 'T');
    expect(r.ticketNumbers).toEqual([10]);
    expect(resend.sendSystemEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@e.com' }));
    expect(fb.patchTicketStatus).toHaveBeenCalledWith(10, 'status-completed');
  });

  it('email failure does not suppress the Slack ping (channels are independent)', async () => {
    linear.getIssueComments.mockResolvedValue(['[reporter-ticket #10 a@e.com] a']);
    resend.sendSystemEmail.mockRejectedValueOnce(new Error('resend down'));
    await notifyCanonicalResolved('issue-uuid', 'T');
    expect(shipNotify.notifyReporterShipped).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@e.com' }));
  });
});

describe('intakeService.fileAutoIssue', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('flag OFF -> Notion', async () => {
    process.env.FEATUREBASE_INTAKE = 'false';
    const r = await fileAutoIssue({ title: 't', description: 'd', source: 'Context limit' });
    expect(notion.createOncallItem).toHaveBeenCalled();
    expect(r.tracker).toBe('Notion');
  });

  it('flag ON + open Auto issue with same title -> groups (comment), no new issue', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenIssuesByLabel.mockResolvedValue([{ identifier: 'ENG-7', issueId: 'uuid-7', title: 'Context limit reached' }]);
    const r = await fileAutoIssue({ title: '  Context Limit Reached ', description: 'd', source: 'Context limit' });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-7', expect.stringContaining('Recurred on'));
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true, tracker: 'Linear' });
  });

  it('flag ON + no match -> creates a private internal issue with the Auto label', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenIssuesByLabel.mockResolvedValue([]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-8', url: 'u' });
    const r = await fileAutoIssue({ title: 'new auto', description: 'd', source: 'Scheduled chat', extraLabels: ['Scheduled Chat'] });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ labelNames: ['Auto', 'Scheduled Chat'] }));
    expect(r).toMatchObject({ deduped: false, tracker: 'Linear' });
  });
});
