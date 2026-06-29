import { fileUserIssue, fileAutoIssue } from '../services/intakeService';

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'notion-1', notionUrl: 'https://notion.so/notion-1' }),
}));
jest.mock('../services/dedupService', () => ({ findDuplicateCanonical: jest.fn() }));
jest.mock('../services/featurebaseService', () => ({ createPost: jest.fn(), addComment: jest.fn(), addVoter: jest.fn() }));
jest.mock('../services/linearService', () => ({
  addIssueComment: jest.fn(),
  createInternalLinearIssue: jest.fn(),
  listOpenIssuesByLabel: jest.fn(),
}));

const notion = require('../services/notionService');
const dedup = require('../services/dedupService');
const fb = require('../services/featurebaseService');
const linear = require('../services/linearService');

describe('intakeService.fileUserIssue (Featurebase-first)', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('flag OFF -> files to Notion (migration default, not a fallback)', async () => {
    process.env.FEATUREBASE_INTAKE = 'false';
    const r = await fileUserIssue({ type: 'bug', title: 't', description: 'd', userEmail: 'u@e.com' });
    expect(notion.createOncallItem).toHaveBeenCalled();
    expect(r.tracker).toBe('Notion');
    expect(dedup.findDuplicateCanonical).not.toHaveBeenCalled();
  });

  it('flag ON + no match -> creates a public post authored by the filer + a private eng note', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue(null);
    fb.createPost.mockResolvedValue({ id: 'post9', url: 'https://fb/p/new' });
    const r = await fileUserIssue({ type: 'feature_request', title: 'new thing', description: 'd', userEmail: 'u@e.com', userName: 'U', sessionId: 'sess-1' });
    expect(fb.createPost).toHaveBeenCalledWith(expect.objectContaining({ title: 'new thing', description: 'd', authorEmail: 'u@e.com', authorName: 'U' }));
    // private (eng-only) note carries the session — NOT in the public post body
    expect(fb.addComment).toHaveBeenCalledWith('post9', expect.stringContaining('Session: sess-1'), true);
    expect(r).toMatchObject({ pageId: 'post9', deduped: false, tracker: 'Featurebase', userUrl: 'https://fb/p/new' });
  });

  it('flag ON + match -> stacks (private comment + voter), no new post, deduped=true', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ postId: 'post5', title: 'Dark mode', url: 'https://fb/p/dark' });
    const r = await fileUserIssue({ type: 'feature_request', title: 'night mode', description: 'd', userEmail: 'u@e.com', userName: 'U' });
    expect(fb.addComment).toHaveBeenCalledWith('post5', expect.stringContaining('Also reported by u@e.com'), true);
    expect(fb.addVoter).toHaveBeenCalledWith('post5', 'u@e.com', 'U');
    expect(fb.createPost).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true, tracker: 'Featurebase', userUrl: 'https://fb/p/dark' });
  });

  it('flag ON + match -> private comment carries the reporter full text + session id (not lossy)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ postId: 'post5', title: 'X', url: 'u' });
    await fileUserIssue({ type: 'bug', title: 'x', description: 'the export button does nothing on CRM', userEmail: 'u2@e.com', userName: 'Two', sessionId: 'sess-abc' });
    const [postId, body, isPrivate] = fb.addComment.mock.calls[0];
    expect(postId).toBe('post5');
    expect(body).toContain('Also reported by u2@e.com (Two)');
    expect(body).toContain('Session: sess-abc');
    expect(body).toContain('the export button does nothing on CRM');
    expect(isPrivate).toBe(true);
  });

  it('flag ON + delegated match -> comment notes the admin', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ postId: 'post5', title: 'X', url: 'u' });
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'cust@e.com', reportedByAdmin: 'admin@a.com' });
    expect(fb.addComment).toHaveBeenCalledWith('post5', expect.stringContaining('via admin@a.com acting on their behalf'), true);
  });

  it('flag ON + match but comment/vote throw -> still deduped (best-effort, no duplicate post)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ postId: 'post5', title: 'X', url: 'u' });
    fb.addComment.mockRejectedValue(new Error('comment down'));
    fb.addVoter.mockRejectedValue(new Error('vote down'));
    const r = await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(r.deduped).toBe(true);
    expect(fb.createPost).not.toHaveBeenCalled();
  });

  it('flag ON + no match + private note throws -> still filed (best-effort note)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue(null);
    fb.createPost.mockResolvedValue({ id: 'post9', url: 'u' });
    fb.addComment.mockRejectedValue(new Error('note down'));
    const r = await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(r).toMatchObject({ deduped: false, pageId: 'post9' });
  });

  it('flag ON + createPost throws -> PROPAGATES (no Notion fallback)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue(null);
    fb.createPost.mockRejectedValue(new Error('FB down'));
    await expect(fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' })).rejects.toThrow('FB down');
    expect(notion.createOncallItem).not.toHaveBeenCalled();
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
