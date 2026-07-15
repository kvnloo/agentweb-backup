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
  // Real converter: the ENG-316 parrot tests assert actual markdown rendering + escaping.
  mdToFeaturebaseHtml: jest.requireActual('../services/featurebaseService').mdToFeaturebaseHtml,
}));
jest.mock('../services/linearService', () => ({
  listOpenBugCanonicals: jest.fn().mockResolvedValue([]),
  listRecentlyResolvedBugCanonicals: jest.fn().mockResolvedValue([]),
  createInternalLinearIssue: jest.fn(),
  addIssueComment: jest.fn(),
  raiseIssueTriage: jest.fn(),
  reopenIssue: jest.fn(),
  listOpenIssuesByLabel: jest.fn(),
  getIssueComments: jest.fn(),
  getIssueCommentsDetailed: jest.fn().mockResolvedValue([]),
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
    // Visible Linear confirmation (ENG-289): the canonical issue link is surfaced, not discarded.
    expect(r.canonicalUrl).toBe('lin');
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
    // Deduped reports return the SAME canonical link (ENG-289) — built from the matched canonical's identifier.
    expect(r.canonicalUrl).toBe('https://linear.app/emmabyaw/issue/ENG-5');
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

describe('fileUserIssue — bug priority mapping (ENG-231: stated priority becomes the Linear field, blended with the funnel tier)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenBugCanonicals.mockResolvedValue([]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
  });
  afterEach(() => {
    process.env.FEATUREBASE_INTAKE = realFlag;
    jest.clearAllMocks();
  });

  it('stated High -> priority field 2, still Todo + default assignee (no-rot defaults hold)', async () => {
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'd', userEmail: 'u@e.com', priority: 'High' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      priority: 2,
      stateName: 'Todo',
      assigneeId: expect.any(String),
    }));
  });

  it('stated Urgent -> priority field 1', async () => {
    await fileUserIssue({ type: 'bug', title: 'down', description: 'd', userEmail: 'u@e.com', priority: 'Urgent' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ priority: 1 }));
  });

  it('stated Low never downgrades below the funnel-tier default (unknown funnel -> Medium 3)', async () => {
    await fileUserIssue({ type: 'bug', title: 'nit', description: 'd', userEmail: 'u@e.com', priority: 'low' });
    expect(linear.createInternalLinearIssue.mock.calls[0][0].priority).toBe(3);
  });

  it('funnel tier wins upward over a weaker stated priority (Retention + stated Medium -> Urgent 1)', async () => {
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'd', userEmail: 'u@e.com', priority: 'Medium', funnelStatus: 'paid_retention_handoff' });
    expect(linear.createInternalLinearIssue.mock.calls[0][0].priority).toBe(1);
  });

  it('no stated priority -> funnel default (Medium 3), never "No priority"', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(linear.createInternalLinearIssue.mock.calls[0][0].priority).toBe(3);
  });

  it('unrecognized priority text -> funnel default (Medium 3), does not crash', async () => {
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com', priority: 'ASAP!!' });
    expect(linear.createInternalLinearIssue.mock.calls[0][0].priority).toBe(3);
  });

  it('grouped onto an existing canonical -> no new issue; the blended priority feeds the raise-only triage upgrade', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([{ identifier: 'ENG-5', issueId: 'uuid-5', title: 'crash', description: 'x' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'ENG-5', title: 'crash', description: 'x' });
    await fileUserIssue({ type: 'bug', title: 'crash', description: 'd', userEmail: 'u@e.com', priority: 'High' });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-5', expect.objectContaining({ priority: 2 }));
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

describe('intakeService.notifyCanonicalResolved — @Emma comment parrot (ENG-316)', () => {
  const { notifyCanonicalResolved } = require('../services/intakeService');
  const REPORTER_COMMENT = '[reporter-ticket #10 a@e.com] Affected user: a@e.com on 2026-06-29.';
  // The pre-ENG-316 hardcoded copy — the fallback must stay BYTE-IDENTICAL to this.
  const DEFAULT_BODY =
    "<p>Good news — the issue you reported (<strong>Save button crashes</strong>) has been resolved. Thanks for flagging it!</p><p>If you still run into it, just reply to this email and we'll take another look.</p>";

  beforeEach(() => {
    // Pin implementations installed by earlier describes (jest.clearAllMocks clears calls, not impls).
    resend.sendSystemEmail.mockImplementation(() => Promise.resolve());
    linear.getIssueComments.mockResolvedValue([REPORTER_COMMENT]);
    linear.getIssueCommentsDetailed.mockResolvedValue([]);
  });
  afterEach(() => jest.clearAllMocks());

  it('parrots the @Emma comment as the email body (rendered), not the default copy — reporter parse untouched', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '@Emma We fixed the save race — drafts no longer disappear.', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    const r = await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@e.com', subject: 'Resolved: Save button crashes' }),
    );
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe('<p>We fixed the save race — drafts no longer disappear.</p>');
    // The [reporter-ticket #N] parse + card flip are untouched by the parrot path.
    expect(r.ticketNumbers).toEqual([10]);
    expect(fb.patchTicketStatus).toHaveBeenCalledWith(10, 'status-completed');
  });

  it('multiple @Emma comments -> the most recent by createdAt wins (not array order)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      // Newest listed FIRST: any array-position heuristic would pick the wrong one.
      { body: '@emma Final wording: fixed by hardening the save endpoint.', createdAt: '2026-07-03T12:00:00.000Z' },
      { body: '@Emma Early draft wording.', createdAt: '2026-07-01T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe('<p>Final wording: fixed by hardening the save endpoint.</p>');
  });

  it('no @Emma comment -> the default email body, byte-identical to the historical copy', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: 'internal eng note without any mention', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('renders the comment markdown to email HTML (bold + lists)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: '@Emma **Fixed!**\n\n- saving is instant now\n- drafts survive a refresh', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    const html = resend.sendSystemEmail.mock.calls[0][0].html;
    expect(html).toContain('<strong>Fixed!</strong>');
    expect(html).toContain('<li>saving is instant now</li>');
    expect(html).toContain('<li>drafts survive a refresh</li>');
  });

  it('escapes HTML in the @Emma comment — Linear comments are untrusted email input', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: '@Emma <script>alert(1)</script> all sorted now', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    const html = resend.sendSystemEmail.mock.calls[0][0].html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('tolerates a real Linear workspace mention (@[Emma](...)) and strips it', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: "@[Emma](https://linear.app/emmabyaw/profiles/emma) Shipped the fix in tonight's deploy.", createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe("<p>Shipped the fix in tonight's deploy.</p>");
  });

  it('an @Emma comment with no message text -> default copy (never an empty email)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: '  @Emma  ', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('a reporter-ticket marker email like x@emma.com is NOT an Emma mention', async () => {
    linear.getIssueComments.mockResolvedValue(['[reporter-ticket #10 x@emma.com] Affected user: x@emma.com']);
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: '[reporter-ticket #10 x@emma.com] Affected user: x@emma.com', createdAt: '2026-07-01T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('comment lookup failing is best-effort -> reporters still get the default email', async () => {
    linear.getIssueCommentsDetailed.mockRejectedValue(new Error('linear down'));
    const r = await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
    expect(r.ticketNumbers).toEqual([10]);
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

describe('intakeService.fileAutoIssue — idempotency-key dedup (ENG-240)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => { process.env.FEATUREBASE_INTAKE = 'true'; });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  // AC #1: a zero-output run trips BOTH the scheduled-chat filer and the oncall alert. They carry the
  // same Schedule ID; the second (oncall) must land on the first's issue, not create a twin — even
  // though the oncall alert's title differs ("Oncall alert" wording vs the scheduled-chat title).
  it('second filer sharing the Schedule ID groups onto the first issue despite a different title', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-145', issueId: 'uuid-145', title: 'Scheduled Chat Zero Assistant Output: WACAP', description: 'Error: x\n- Schedule ID: sched-wacap\n- Session ID: sess-1' },
    ]);
    const r = await fileAutoIssue({
      title: 'Oncall: WACAP zero output', // deliberately different wording from the existing issue
      description: 'd',
      source: 'Oncall alert',
      notionContext: { 'Schedule ID': 'sched-wacap', 'Session ID': 'sess-1' },
    });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-145', expect.stringContaining('Recurred on'));
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ pageId: 'ENG-145', deduped: true, tracker: 'Linear' });
  });

  // AC #2: a SECOND failure of the same schedule (new session, so a different Session ID) while the
  // issue is open must group by Schedule ID — zero new issues, one occurrence comment.
  it('a later failure of the same schedule (new session) groups by Schedule ID', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-180', issueId: 'uuid-180', title: 'Scheduled Chat Error: xCures', description: 'Error\n- Schedule ID: sched-xcures\n- Session ID: 64ebbde3' },
    ]);
    const r = await fileAutoIssue({
      title: 'Scheduled Chat Error: xCures',
      description: 'd',
      source: 'Scheduled chat (error)',
      notionContext: { 'Schedule ID': 'sched-xcures', 'Session ID': 'new-session-abc' },
    });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true });
  });

  // Root cause 2: a second analyzer re-files the SAME failing session days later (different title, no
  // Schedule ID in context) — it must still match on the Session ID printed in the existing body.
  it('re-file of the same session by a second analyzer groups on the Session ID', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-180', issueId: 'uuid-180', title: 'Scheduled Chat Zero Assistant Output: xCures', description: 'body\n- Session ID: 64ebbde3\n- Schedule ID: sched-xcures' },
    ]);
    const r = await fileAutoIssue({
      title: 'Scheduled run crashed with no assistant response (xCures)',
      description: 'systemic pattern report',
      source: 'Daily audit',
      notionContext: { 'Session ID': '64ebbde3' },
    });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ pageId: 'ENG-180', deduped: true });
  });

  // Placeholder ids ("N/A") must never collide across unrelated events.
  it('a placeholder Session ID does not falsely match another placeholder issue', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-9', issueId: 'uuid-9', title: 'Some other error', description: 'body\n- Session ID: N/A' },
    ]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-10', url: 'u' });
    const r = await fileAutoIssue({
      title: 'A totally different error',
      description: 'd',
      source: 'Scheduled chat (error)',
      notionContext: { 'Session ID': 'N/A', 'Schedule ID': 'sched-unique-xyz' },
    });
    expect(linear.createInternalLinearIssue).toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: false });
  });

  // AC #4: replaying the six evidence events (3 distinct schedules, each filed by two paths, plus a
  // late re-file) yields 3 issues, not 9. Models the gate against a live in-memory Auto-issue store.
  it('replaying the Jul 1-6 evidence sequence yields 3 issues, not 9', async () => {
    const store: any[] = [];
    let seq = 0;
    linear.listOpenIssuesByLabel.mockImplementation(async () => store.slice());
    linear.createInternalLinearIssue.mockImplementation(async (input: any) => {
      seq += 1;
      const identifier = `ENG-${100 + seq}`;
      store.push({ identifier, issueId: `uuid-${seq}`, title: input.title, description: input.description });
      return { identifier, url: `u/${identifier}`, id: `uuid-${seq}` };
    });
    linear.addIssueComment.mockResolvedValue(undefined);

    // Each schedule's failure event fires twice (scheduled-chat filer + oncall) and once more via a
    // late daily-audit re-file that only knows the Session ID.
    const schedules = [
      { name: 'WACAP', scheduleId: 'sched-wacap', sessionId: 'sess-wacap' },
      { name: 'xCures', scheduleId: 'sched-xcures', sessionId: 'sess-xcures' },
      { name: 'Token Usage', scheduleId: 'sched-token', sessionId: 'sess-token' },
    ];
    for (const s of schedules) {
      // scheduled-chat filer
      await fileAutoIssue({ title: `Scheduled Chat Zero Assistant Output: ${s.name}`, description: 'err', source: 'Scheduled chat (error)', notionContext: { 'Schedule ID': s.scheduleId, 'Session ID': s.sessionId } });
      // oncall alert (different wording, same event)
      await fileAutoIssue({ title: `Oncall: ${s.name} down`, description: 'err', source: 'Oncall alert', notionContext: { 'Schedule ID': s.scheduleId, 'Session ID': s.sessionId } });
      // daily audit re-file days later (only the Session ID)
      await fileAutoIssue({ title: `Scheduled run crashed (${s.name})`, description: 'audit', source: 'Daily audit', notionContext: { 'Session ID': s.sessionId } });
    }

    expect(linear.createInternalLinearIssue).toHaveBeenCalledTimes(3);
    expect(store).toHaveLength(3);
  });
});

describe('intakeService.fileBugReport — reopen, not refile (ENG-240 contract #3)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenBugCanonicals.mockResolvedValue([]);
    linear.listRecentlyResolvedBugCanonicals.mockResolvedValue([]);
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 58, url: 'https://fb/t/58' });
  });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('a regression report referencing a resolved canonical REOPENS it instead of filing a new one', async () => {
    // No OPEN canonical, but the report names AGW-58 and a recently-RESOLVED canonical matches.
    linear.listRecentlyResolvedBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-179', issueId: 'uuid-179', title: 'Google Ads connection fails after OAuth', description: 'old report' },
    ]);
    // First dedup pass (OPEN canonicals, empty) -> no match; second pass (RESOLVED set) -> match.
    dedup.findDuplicate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: 'ENG-179', title: 'Google Ads connection fails after OAuth', description: 'old report' });
    const r = await fileUserIssue({
      type: 'bug',
      title: 'FOLLOW-UP / REGRESSION on AGW-58',
      description: 'Marked resolved but Google Ads connection still fails after OAuth',
      userEmail: 'u@e.com',
    });
    expect(linear.reopenIssue).toHaveBeenCalledWith('uuid-179', 'Todo');
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-179', expect.stringContaining('Reopened by a new report'));
    expect(r).toMatchObject({ deduped: true });
  });

  it('a FAILED reopen still groups the reporter but never stamps the misleading "Reopened" banner', async () => {
    // Same regression match, but the reopen state change throws (best-effort, swallowed). The report
    // must still fold onto the canonical (deduped, no new issue) WITHOUT claiming a reopen that the
    // ticket — still sitting in Done — never actually got.
    linear.listRecentlyResolvedBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-179', issueId: 'uuid-179', title: 'Google Ads connection fails after OAuth', description: 'old report' },
    ]);
    dedup.findDuplicate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: 'ENG-179', title: 'Google Ads connection fails after OAuth', description: 'old report' });
    linear.reopenIssue.mockRejectedValueOnce(new Error('state "Todo" not found'));
    const r = await fileUserIssue({
      type: 'bug',
      title: 'FOLLOW-UP / REGRESSION on AGW-58',
      description: 'still failing after OAuth',
      userEmail: 'u@e.com',
    });
    expect(linear.reopenIssue).toHaveBeenCalledWith('uuid-179', 'Todo');
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-179', expect.not.stringContaining('Reopened by a new report'));
    expect(r).toMatchObject({ deduped: true });
  });

  it('a report that names no canonical never queries the resolved set (fresh bug -> new canonical)', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    await fileUserIssue({ type: 'bug', title: 'Save button crashes', description: 'clicking save throws', userEmail: 'u@e.com' });
    expect(linear.listRecentlyResolvedBugCanonicals).not.toHaveBeenCalled();
    expect(linear.reopenIssue).not.toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalled();
  });

  it('references a canonical but no resolved match -> files a fresh canonical (no reopen)', async () => {
    dedup.findDuplicate.mockResolvedValue(null); // neither open nor resolved matches
    linear.listRecentlyResolvedBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-500', issueId: 'uuid-500', title: 'unrelated', description: 'x' },
    ]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    const r = await fileUserIssue({ type: 'bug', title: 'New unrelated bug (mentions ENG-500 loosely)', description: 'd', userEmail: 'u@e.com' });
    expect(linear.reopenIssue).not.toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: false });
  });
});
