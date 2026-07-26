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
  // Real converter behind a jest.fn wrapper: the ENG-316 parrot tests assert actual markdown
  // rendering + escaping, while the converter-failure test can still override per call.
  mdToFeaturebaseHtml: jest.fn((md: string) => jest.requireActual('../services/featurebaseService').mdToFeaturebaseHtml(md)),
}));
jest.mock('../services/linearService', () => ({
  listOpenBugCanonicals: jest.fn().mockResolvedValue([]),
  listRecentlyResolvedBugCanonicals: jest.fn().mockResolvedValue([]),
  createInternalLinearIssue: jest.fn(),
  addIssueComment: jest.fn(),
  raiseIssueTriage: jest.fn(),
  reopenIssue: jest.fn(),
  listOpenIssuesByLabel: jest.fn(),
  escalateIssue: jest.fn(),
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
  // One comment fetch (getIssueCommentsDetailed) feeds both the reporter parse and the @Emma
  // parrot since ENG-316. This helper shapes plain bodies for reporter-parse-focused tests.
  const c = (body: string) => ({ body, createdAt: '2026-07-01T00:00:00.000Z' });
  afterEach(() => jest.clearAllMocks());

  it('reads [reporter-ticket #N <email>] from the canonical comments and EMAILs + flips each card', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      c('Customer-reported bug...\nAffected user: a@e.com'),
      c('[reporter-ticket #10 a@e.com] Affected user: a@e.com on 2026-06-29.\nSession: s1'),
      c('[reporter-ticket #11 b@e.com] Affected user: b@e.com on 2026-06-29.\nSession: s2'),
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
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #10 a@e.com] x')]);
    await notifyCanonicalResolved('issue-uuid', '<script>alert(1)</script>');
    const html = resend.sendSystemEmail.mock.calls[0][0].html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('no reporter-ticket comments -> no-op (not a bug canonical)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([c('just a normal comment'), c('another')]);
    const r = await notifyCanonicalResolved('issue-uuid');
    expect(r.ticketNumbers).toEqual([]);
    expect(resend.sendSystemEmail).not.toHaveBeenCalled();
    expect(fb.getTicketStatusId).not.toHaveBeenCalled();
  });

  it('dedupes repeated ticket numbers across comments', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #7 x@e.com] x'), c('[reporter-ticket #7 x@e.com] x again')]);
    const r = await notifyCanonicalResolved('issue-uuid');
    expect(r.ticketNumbers).toEqual([7]);
    expect(resend.sendSystemEmail).toHaveBeenCalledTimes(1);
  });

  it('one reporter failing is best-effort -> the others still get notified', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #10 a@e.com] a'), c('[reporter-ticket #11 b@e.com] b')]);
    resend.sendSystemEmail.mockImplementation((p: any) => (p.to === 'a@e.com' ? Promise.reject(new Error('down')) : Promise.resolve()));
    const r = await notifyCanonicalResolved('issue-uuid');
    expect(r.ticketNumbers).toEqual([11]); // 10 failed, 11 succeeded
    expect(fb.patchTicketStatus).toHaveBeenCalledWith(11, 'status-completed');
  });

  it('pings each reporter on Slack beside the email (kind bug, canonical id as the idempotency key)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      c('[reporter-ticket #10 a@e.com] a'),
      c('[reporter-ticket #11 b@e.com] b'),
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
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #10 a@e.com] a')]);
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
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #10 a@e.com] a')]);
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
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
    ]);
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
    // ONE fetch serves both the reporter parse and the parrot — the two can never disagree
    // on a mid-resolve snapshot, and the Linear call count stays flat.
    expect(linear.getIssueCommentsDetailed).toHaveBeenCalledTimes(1);
  });

  it('multiple @Emma comments -> the most recent by createdAt wins (not array order)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      // Newest listed FIRST: any array-position heuristic would pick the wrong one.
      { body: '@emma Final wording: fixed by hardening the save endpoint.', createdAt: '2026-07-03T12:00:00.000Z' },
      { body: '@Emma Early draft wording.', createdAt: '2026-07-01T00:00:00.000Z' },
      { body: REPORTER_COMMENT, createdAt: '2026-06-29T00:00:00.000Z' },
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
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
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
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '@Emma <script>alert(1)</script> all sorted now', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    const html = resend.sendSystemEmail.mock.calls[0][0].html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('tolerates a real Linear workspace mention (@[Emma](...)) and strips it', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: "@[Emma](https://linear.app/emmabyaw/profiles/emma) Shipped the fix in tonight's deploy.", createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe("<p>Shipped the fix in tonight's deploy.</p>");
  });

  it('an @Emma comment with no message text -> default copy (never an empty email)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '  @Emma  ', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('a reporter-ticket marker email like x@emma.com is NOT an Emma mention', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: '[reporter-ticket #10 x@emma.com] Affected user: x@emma.com', createdAt: '2026-07-01T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('customer report text quoting @emma inside an intake comment can NOT hijack the parrot (PII guard)', async () => {
    // Reviewer blocker repro: intake writes CUSTOMER-controlled text into canonical comments
    // ('Their report:\n<description>'), and customers address the product's agent as "@emma".
    // That text must never become another reporter's resolution email.
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      {
        body: '[reporter-ticket #11 bob@y.com] Affected user: Bob (bob@y.com) on 2026-07-02.\n\nTheir report:\n@emma keeps deleting my drafts',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    // Every reporter gets the DEFAULT copy — never another customer's email address + report text.
    expect(resend.sendSystemEmail).toHaveBeenCalledTimes(2);
    for (const call of resend.sendSystemEmail.mock.calls) {
      expect(call[0].html).toBe(DEFAULT_BODY);
      expect(call[0].html).not.toContain('bob@y.com');
    }
  });

  it("a NEWER intake comment quoting @emma does not outrank eng's earlier @Emma comment", async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '@Emma We fixed the save race — drafts no longer disappear.', createdAt: '2026-07-02T00:00:00.000Z' },
      // A grouped duplicate report typically lands AFTER eng's resolution comment, right before Done.
      {
        body: '[reporter-ticket #12 carol@y.com] Affected user: carol@y.com on 2026-07-03.\n\nTheir report:\n@emma ate my draft again',
        createdAt: '2026-07-03T00:00:00.000Z',
      },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe('<p>We fixed the save race — drafts no longer disappear.</p>');
  });

  it('a mid-comment @emma is NOT a resolution message — the mention must LEAD the comment', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: 'looping in @emma — customer says the save race is back', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('a bracketed mention of a user whose name merely CONTAINS "emma" (@[Gemma Ortiz](...)) does not match', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '@[Gemma Ortiz](https://linear.app/emmabyaw/profiles/gemma) can you retest?', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
  });

  it('tolerates the link-first bracket form ([@Emma](...)) with no [](url) junk left in the email', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '[@Emma](https://linear.app/emmabyaw/profiles/emma) Shipped the fix.', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe('<p>Shipped the fix.</p>');
  });

  it('handles the raw serialization of a REAL workspace mention (verified live 2026-07-15: plain "@displayName")', async () => {
    // Pinned by a live probe on ENG-316: a genuine mention node (bodyData `suggestion_userMentions`)
    // serializes in the GraphQL comment `body` as plain "@harsha" — so for an "emma" user the raw
    // form is exactly this fixture. The bracketed forms tested above do NOT occur in raw bodies;
    // they are tolerated for hand-written markdown mentions only.
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '@emma The webhook race is fixed — retries no longer double-send.', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    await notifyCanonicalResolved('issue-uuid', 'T');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe('<p>The webhook race is fixed — retries no longer double-send.</p>');
  });

  it('comments fetch failure propagates — without the comments there is nobody to notify (webhook route catches + logs)', async () => {
    linear.getIssueCommentsDetailed.mockRejectedValue(new Error('linear down'));
    await expect(notifyCanonicalResolved('issue-uuid', 'Save button crashes')).rejects.toThrow('linear down');
    expect(resend.sendSystemEmail).not.toHaveBeenCalled();
  });

  it('converter blowing up is best-effort -> reporters still get the default email', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValue([
      { body: REPORTER_COMMENT, createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '@Emma We fixed it.', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    fb.mdToFeaturebaseHtml.mockImplementationOnce(() => { throw new Error('converter bug'); });
    const r = await notifyCanonicalResolved('issue-uuid', 'Save button crashes');
    expect(resend.sendSystemEmail.mock.calls[0][0].html).toBe(DEFAULT_BODY);
    expect(r.ticketNumbers).toEqual([10]);
  });
});

describe('intakeService.fileAutoIssue', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('auto issues always use Linear even when the customer-intake migration flag is off', async () => {
    process.env.FEATUREBASE_INTAKE = 'false';
    linear.listOpenIssuesByLabel.mockResolvedValue([]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-6', url: 'u' });
    const r = await fileAutoIssue({ title: 't', description: 'd', source: 'Context limit' });
    expect(notion.createOncallItem).not.toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({ labelNames: ['Auto'] }),
    );
    expect(r.tracker).toBe('Linear');
  });

  it('maps the autofix execution route to an executable Todo owned by Manan', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenIssuesByLabel.mockResolvedValue([]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-8', url: 'u' });

    await fileAutoIssue({
      title: 'tool schema regression',
      description: 'd',
      source: 'AgentMode loop',
      executionRoute: 'autofix',
    } as any);

    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labelNames: ['Auto', 'Bug', 'autofix'],
        stateName: 'Todo',
        assigneeId: 'cabadf7c-b95d-4455-b9ec-df11d5d83f5f',
      }),
    );
  });

  it('maps the human-triage route to Needs PM and Harsha without autofix', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    linear.listOpenIssuesByLabel.mockResolvedValue([]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'u' });

    await fileAutoIssue({
      title: 'unknown product behavior',
      description: 'd',
      source: 'Onboarding loop',
      executionRoute: 'human-triage',
    } as any);

    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labelNames: ['Auto', 'Bug', 'Needs PM'],
        stateName: 'Todo',
        assigneeId: '142fef82-4d45-4070-99be-c5debe565ac6',
      }),
    );
    expect(linear.createInternalLinearIssue.mock.calls[0][0].labelNames).not.toContain('autofix');
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

describe('intakeService.fileBugReport — exact-reference short-circuit (fix for AGW false-new-duplicate, ENG-329 incident)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  // The exact-ref scan reads comments through the same detailed helper as the resolve bridge.
  const c = (body: string) => ({ body, createdAt: '2026-07-01T00:00:00.000Z' });
  beforeEach(() => {
    process.env.FEATUREBASE_INTAKE = 'true';
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 121, url: 'https://fb/t/121' });
    linear.getIssueCommentsDetailed.mockResolvedValue([]);
  });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('no ticket reference in text -> fuzzy dedup runs exactly as before, the comment scan never fires', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-9', issueId: 'uuid-9', title: 'Unrelated bug', description: 'unrelated' },
    ]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-10', url: 'lin', id: 'uuid-10' });

    await fileUserIssue({ type: 'bug', title: 'Save button crashes', description: 'clicking save throws', userEmail: 'u@e.com' });

    expect(dedup.findDuplicate).toHaveBeenCalled();
    expect(linear.getIssueCommentsDetailed).not.toHaveBeenCalled();
  });

  it('reference present but no candidate comment matches it -> falls through to fuzzy dedup, no throw', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-9', issueId: 'uuid-9', title: 'Unrelated bug', description: 'unrelated' },
    ]);
    linear.getIssueCommentsDetailed.mockResolvedValue([c('some unrelated comment'), c('[reporter-ticket #999 other@e.com] Affected user: other@e.com')]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-10', url: 'lin', id: 'uuid-10' });

    const r = await fileUserIssue({
      type: 'bug',
      title: 'AGW-112 follow-up: something',
      description: 'evidence text',
      userEmail: 'u@e.com',
    });

    expect(dedup.findDuplicate).toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: false });
  });

  it('a literal "ENG-N" mention in the text does NOT deterministically match by identifier alone (avoids false positives on casual mentions)', async () => {
    // Regression guard for the design refinement: unlike AGW-N, ENG-N is never matched by a bare
    // identifier compare — only AGW-N (via the private reporter-ticket comment marker) triggers
    // the deterministic short-circuit. A report merely naming an ENG-N id in passing must still go
    // through the fuzzy judge, exactly as today.
    linear.listOpenBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-312', issueId: 'uuid-312', title: 'final_url_suffix silently fails', description: 'old report' },
    ]);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-999', url: 'lin', id: 'uuid-999' });

    const r = await fileUserIssue({
      type: 'bug',
      title: 'New unrelated bug (mentions ENG-312 loosely)',
      description: 'not actually the same thing',
      userEmail: 'u@e.com',
    });

    expect(linear.getIssueCommentsDetailed).not.toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: false });
  });

  it('comment fetch throws for one candidate -> scan skips it, continues, never throws out of fileBugReport', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-8', issueId: 'uuid-8', title: 'Other bug', description: 'x' },
      { identifier: 'ENG-312', issueId: 'uuid-312', title: 'final_url_suffix silently fails', description: 'old report' },
    ]);
    linear.getIssueCommentsDetailed
      .mockRejectedValueOnce(new Error('Linear API error'))
      .mockResolvedValueOnce([c('[reporter-ticket #112 emongiovi@xcures.com] Affected user: emongiovi@xcures.com')]);
    dedup.findDuplicate.mockResolvedValue(null);

    const r = await fileUserIssue({
      type: 'bug',
      title: 'AGW-112 follow-up: intermittent behavior',
      description: 'evidence',
      userEmail: 'emongiovi@xcures.com',
    });

    expect(linear.getIssueCommentsDetailed).toHaveBeenCalledTimes(2);
    expect(dedup.findDuplicate).not.toHaveBeenCalled(); // exact match found on the 2nd candidate
    expect(r).toMatchObject({ deduped: true, canonicalUrl: expect.stringContaining('ENG-312') });
  });

  it('comment fetch resolves with a non-array value (unmocked/malformed) -> caught, never throws out of fileBugReport', async () => {
    // Regression guard for the Greptile-flagged structural issue: bodies.some(...) must be
    // covered by the same try/catch as the await — a resolved-but-non-array value (e.g. an
    // unmocked jest.fn() defaulting to `undefined`, or any real malformed API response) must
    // degrade gracefully, not throw a TypeError that escapes findExactCanonicalMatch.
    linear.listOpenBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-312', issueId: 'uuid-312', title: 'final_url_suffix silently fails', description: 'old report' },
    ]);
    linear.getIssueCommentsDetailed.mockResolvedValue(undefined as any);
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-999', url: 'lin', id: 'uuid-999' });

    const r = await fileUserIssue({
      type: 'bug',
      title: 'AGW-112 follow-up: something',
      description: 'evidence text',
      userEmail: 'u@e.com',
    });

    expect(dedup.findDuplicate).toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: false });
  });

  it('report citing AGW-112 matches an OPEN canonical by its reporter-ticket comment -> groups directly, fuzzy judge never called (ENG-329 incident scenario)', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-312', issueId: 'uuid-312', title: 'final_url_suffix silently fails', description: 'old report' },
    ]);
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #112 emongiovi@xcures.com] Affected user: emongiovi@xcures.com (Edward Mongiovi)')]);

    const r = await fileUserIssue({
      type: 'bug',
      title: 'AGW-112 follow-up: Google Ads campaign final_url_suffix UPDATE is INTERMITTENT',
      description: 'UPDATE to AGW-112 evidence: ... same session, same tool ...',
      userEmail: 'emongiovi@xcures.com',
    });

    expect(dedup.findDuplicate).not.toHaveBeenCalled();
    expect(linear.raiseIssueTriage).toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true, canonicalUrl: expect.stringContaining('ENG-312') });
  });

  it('report citing AGW-112 whose reporter-ticket comment is on a RESOLVED (not open) canonical -> reopens it, fuzzy judge never called', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([]);
    linear.listRecentlyResolvedBugCanonicals.mockResolvedValue([
      { identifier: 'ENG-312', issueId: 'uuid-312', title: 'final_url_suffix silently fails', description: 'old report' },
    ]);
    linear.getIssueCommentsDetailed.mockResolvedValue([c('[reporter-ticket #112 emongiovi@xcures.com] Affected user: emongiovi@xcures.com')]);

    const r = await fileUserIssue({
      type: 'bug',
      title: 'AGW-112 follow-up: Google Ads campaign final_url_suffix UPDATE is INTERMITTENT',
      description: 'evidence text',
      userEmail: 'emongiovi@xcures.com',
    });

    // The open-canonical check still invokes the fuzzy judge once with an EMPTY candidate list
    // (pre-existing behavior — findDuplicate self-short-circuits on an empty array); the real
    // invariant this test protects is that it's never invoked with the actual resolved candidate.
    expect(dedup.findDuplicate).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.objectContaining({ ref: 'ENG-312' })]));
    expect(linear.reopenIssue).toHaveBeenCalledWith('uuid-312', 'Todo');
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-312', expect.stringContaining('Reopened by a new report'));
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true });
  });
});

describe('intakeService.fileAutoIssue — alert-class clustering (ENG-358)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => { process.env.FEATUREBASE_INTAKE = 'true'; });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  const V0_CONTEXT = {
    'Plan': 'v0-team',
    'Total spendable': '$59.15',
    'Warn level': 'low',
    'Alert Class': 'v0-credits',
    'Alert Priority': 'high',
  };

  // AC #1: an open canonical for the same alert class owns every occurrence — a moved balance
  // (different title AND different body numbers) must append, never file a new issue.
  it('AC1: occurrence with a different balance groups onto the open canonical carrying the same Alert Class', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-337', issueId: 'uuid-337', title: 'v0 credits LOW — $58.51 spendable', description: 'body\n* Warn level: low\n* Alert Class: v0-credits' },
    ]);
    const r = await fileAutoIssue({
      title: 'v0 credits LOW — $59.15 spendable',
      description: 'd',
      source: 'Oncall alert',
      extraLabels: ['Oncall'],
      notionContext: V0_CONTEXT,
    });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-337', expect.stringContaining('Recurred on'));
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ pageId: 'ENG-337', deduped: true, tracker: 'Linear' });
  });

  // AC #2: no open issue for the class -> exactly ONE new issue, carrying the class marker in its
  // body (so the next occurrence matches) and the mapped priority (so it never lands "No priority").
  it('AC2: no open issue for the class -> creates exactly one issue with the class marker + priority', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-400', id: 'uuid-400', url: 'u' });
    const r = await fileAutoIssue({
      title: 'v0 credits LOW — $20.00 spendable',
      description: 'd',
      source: 'Oncall alert',
      extraLabels: ['Oncall'],
      notionContext: V0_CONTEXT,
    });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      labelNames: ['Auto', 'Oncall'],
      priority: 2, // 'high'
      description: expect.stringContaining('Alert Class: v0-credits'),
    }));
    expect(r).toMatchObject({ deduped: false, tracker: 'Linear' });
  });

  // AC #3: warn-level escalation (low -> critical) on an existing open canonical updates its
  // priority/title in place — no new issue.
  it('AC3: low -> critical escalation updates the open canonical title + priority, files nothing new', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-337', issueId: 'uuid-337', title: 'v0 credits LOW — $58.51 spendable', description: 'body\n* Alert Class: v0-credits' },
    ]);
    const r = await fileAutoIssue({
      title: 'v0 credits CRITICAL — $9.10 spendable',
      description: 'd',
      source: 'Oncall alert',
      extraLabels: ['Oncall'],
      notionContext: { ...V0_CONTEXT, 'Warn level': 'critical', 'Alert Priority': 'urgent' },
    });
    expect(linear.escalateIssue).toHaveBeenCalledWith('uuid-337', { title: 'v0 credits CRITICAL — $9.10 spendable', priority: 1 });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true });
  });

  // AC #4: a closed canonical is not a candidate (listOpenIssuesByLabel is open-only, and as of
  // ENG-358 excludes duplicate-state issues too) -> ONE fresh canonical, never a reopen storm.
  it('AC4: closed canonical + new occurrence -> one fresh issue, no reopen', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([]); // closed/duplicate issues are filtered upstream
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-401', id: 'uuid-401', url: 'u' });
    const r = await fileAutoIssue({
      title: 'v0 credits LOW — $21.00 spendable',
      description: 'd',
      source: 'Oncall alert',
      notionContext: V0_CONTEXT,
    });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: false });
  });

  // Migration: the pre-ENG-358 open canonical (ENG-337) carries NO class marker in its body. The
  // amount-insensitive title match must still group onto it instead of filing a parallel canonical.
  it('legacy open canonical without the class marker still matches when titles differ only by the amount', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-337', issueId: 'uuid-337', title: 'v0 credits LOW — $58.51 spendable', description: 'no class marker here' },
    ]);
    const r = await fileAutoIssue({
      title: 'v0 credits LOW — $59.15 spendable',
      description: 'd',
      source: 'Oncall alert',
      notionContext: V0_CONTEXT,
    });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ pageId: 'ENG-337', deduped: true });
  });

  // Needle specificity: a different alert class must never absorb this class's occurrences.
  it('a candidate carrying a DIFFERENT Alert Class does not match', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-390', issueId: 'uuid-390', title: 'Meta token refresh failing', description: 'body\n* Alert Class: meta-token-refresh' },
    ]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-402', id: 'uuid-402', url: 'u' });
    const r = await fileAutoIssue({
      title: 'v0 credits LOW — $22.00 spendable',
      description: 'd',
      source: 'Oncall alert',
      notionContext: V0_CONTEXT,
    });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ deduped: false });
  });

  // Prefix collision (Greptile P2 on #2107): a class name that extends this one ("v0-credits" vs
  // "v0-credits-backup") must not cross-match in EITHER direction — the needle is anchored at
  // end-of-line, not a bare substring.
  it('class names where one is a prefix of the other never cross-match', async () => {
    // Direction 1: filing "v0-credits" must NOT land on a canonical classed "v0-credits-backup".
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-391', issueId: 'uuid-391', title: 'v0 credits backup exhausted', description: 'body\n* Alert Class: v0-credits-backup\n* Plan: v0-team' },
    ]);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-403', id: 'uuid-403', url: 'u' });
    const r1 = await fileAutoIssue({
      title: 'v0 credits LOW — $23.00 spendable',
      description: 'd',
      source: 'Oncall alert',
      notionContext: V0_CONTEXT,
    });
    expect(linear.addIssueComment).not.toHaveBeenCalled();
    expect(linear.createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ deduped: false });

    jest.clearAllMocks();

    // Direction 2: filing "v0-credits-backup" must NOT land on a canonical classed "v0-credits" —
    // and the anchored match still finds its own class when that line is mid-body, not last.
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-337', issueId: 'uuid-337', title: 'v0 credits LOW — $58.51 spendable', description: 'body\n* Alert Class: v0-credits\n* Plan: v0-team' },
      { identifier: 'ENG-392', issueId: 'uuid-392', title: 'v0 backup credits LOW', description: 'body\n* Alert Class: v0-credits-backup\n* Plan: v0-team' },
    ]);
    const r2 = await fileAutoIssue({
      title: 'v0 backup credits LOW — $5.00 spendable',
      description: 'd',
      source: 'Oncall alert',
      notionContext: { ...V0_CONTEXT, 'Alert Class': 'v0-credits-backup' },
    });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-392', expect.stringContaining('Recurred on'));
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ pageId: 'ENG-392', deduped: true });
  });

  // Escalation is best-effort: a Linear hiccup on the escalate call must not break the dedupe
  // result (the occurrence comment + grouped return still stand, next occurrence retries).
  it('escalateIssue failure is best-effort — the grouped result still returns', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-337', issueId: 'uuid-337', title: 't', description: '* Alert Class: v0-credits' },
    ]);
    linear.escalateIssue.mockRejectedValueOnce(new Error('linear 500'));
    const r = await fileAutoIssue({
      title: 'v0 credits CRITICAL — $9.00 spendable',
      description: 'd',
      source: 'Oncall alert',
      notionContext: { ...V0_CONTEXT, 'Alert Priority': 'urgent' },
    });
    expect(r).toMatchObject({ deduped: true });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
  });

  // Behavior preservation: an unclassed filer (no Alert Class in context) keeps today's exact
  // semantics — normalized-title match still requires the SAME numbers, so distinct amounts in
  // otherwise-identical titles of unclassed issues keep their pre-ENG-358 grouping behavior via
  // the amount-insensitive norm (deliberate: amounts are occurrence data, not identity).
  it('unclassed occurrence still groups by title (existing behavior unchanged)', async () => {
    linear.listOpenIssuesByLabel.mockResolvedValue([
      { identifier: 'ENG-7', issueId: 'uuid-7', title: 'Context limit reached', description: 'body' },
    ]);
    const r = await fileAutoIssue({ title: 'context limit reached', description: 'd', source: 'Context limit' });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-7', expect.stringContaining('Recurred on'));
    expect(linear.escalateIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true });
  });
});
