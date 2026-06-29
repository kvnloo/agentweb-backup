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
}));
jest.mock('../services/linearService', () => ({
  listOpenBugCanonicals: jest.fn().mockResolvedValue([]),
  createInternalLinearIssue: jest.fn(),
  addIssueComment: jest.fn(),
  listOpenIssuesByLabel: jest.fn(),
}));

const notion = require('../services/notionService');
const dedup = require('../services/dedupService');
const fb = require('../services/featurebaseService');
const linear = require('../services/linearService');

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

describe('fileUserIssue — bug (private own-card ticket + Linear canonical)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  beforeEach(() => { process.env.FEATUREBASE_INTAKE = 'true'; linear.listOpenBugCanonicals.mockResolvedValue([]); });
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('no canonical -> creates a private Linear canonical + the reporter own-card ticket + reporter-ticket comment', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
    const r = await fileUserIssue({ type: 'bug', title: 'crash', description: 'on save', userEmail: 'u@e.com', userName: 'U', sessionId: 'sess-2' });
    expect(linear.createInternalLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ labelNames: ['Bug', 'Customer Reported'] }));
    expect(fb.createTicket).toHaveBeenCalledWith(expect.objectContaining({ title: 'crash', content: 'on save', authorEmail: 'u@e.com', authorName: 'U' }));
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-9', expect.stringContaining('[reporter-ticket #7]'));
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-9', expect.stringContaining('Session: sess-2'));
    expect(r).toMatchObject({ pageId: '7', deduped: false, tracker: 'Featurebase', userUrl: 'https://fb/t/7' });
  });

  it('matches an existing canonical -> still its OWN new ticket, comments on the existing canonical, deduped=true', async () => {
    linear.listOpenBugCanonicals.mockResolvedValue([{ identifier: 'ENG-5', issueId: 'uuid-5', title: 'crash', description: 'x' }]);
    dedup.findDuplicate.mockResolvedValue({ ref: 'ENG-5', title: 'crash', description: 'x' });
    fb.createTicket.mockResolvedValue({ id: 'tk2', number: 8, url: 'https://fb/t/8' });
    const r = await fileUserIssue({ type: 'bug', title: 'crashes too', description: 'also on save', userEmail: 'u2@e.com', sessionId: 'sess-3' });
    expect(linear.createInternalLinearIssue).not.toHaveBeenCalled();
    expect(fb.createTicket).toHaveBeenCalled();
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-5', expect.stringContaining('[reporter-ticket #8]'));
    // For a duplicate, the reporter's own text is folded into the canonical comment (eng sees it).
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-5', expect.stringContaining('also on save'));
    expect(r).toMatchObject({ pageId: '8', deduped: true, tracker: 'Featurebase', userUrl: 'https://fb/t/8' });
  });

  it('createTicket throws -> PROPAGATES (no Notion fallback)', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockRejectedValue(new Error('FB tickets down'));
    await expect(fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' })).rejects.toThrow('FB tickets down');
    expect(notion.createOncallItem).not.toHaveBeenCalled();
  });

  it('canonical comment failure is best-effort -> ticket still returned', async () => {
    dedup.findDuplicate.mockResolvedValue(null);
    linear.createInternalLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'lin', id: 'uuid-9' });
    fb.createTicket.mockResolvedValue({ id: 'tk', number: 7, url: 'https://fb/t/7' });
    linear.addIssueComment.mockRejectedValue(new Error('comment down'));
    const r = await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(r).toMatchObject({ pageId: '7', deduped: false });
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
