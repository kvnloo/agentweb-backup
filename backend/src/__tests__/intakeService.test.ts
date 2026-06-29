import { fileUserIssue, fileAutoIssue } from '../services/intakeService';

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'notion-1', notionUrl: 'https://notion.so/notion-1' }),
}));
jest.mock('../services/dedupService', () => ({ findDuplicateCanonical: jest.fn() }));
jest.mock('../services/featurebaseService', () => ({ findPostByTitle: jest.fn(), addVoter: jest.fn() }));
jest.mock('../services/linearService', () => ({
  createLinearIssue: jest.fn(),
  addIssueComment: jest.fn(),
  createInternalLinearIssue: jest.fn(),
  listOpenIssuesByLabel: jest.fn(),
}));

const notion = require('../services/notionService');
const dedup = require('../services/dedupService');
const fb = require('../services/featurebaseService');
const linear = require('../services/linearService');

describe('intakeService.fileUserIssue', () => {
  const realFlag = process.env.FEATUREBASE_INTAKE;
  afterEach(() => { process.env.FEATUREBASE_INTAKE = realFlag; jest.clearAllMocks(); });

  it('flag OFF -> files to Notion (migration default, not a fallback)', async () => {
    process.env.FEATUREBASE_INTAKE = 'false';
    const r = await fileUserIssue({ type: 'bug', title: 't', description: 'd', userEmail: 'u@e.com' });
    expect(notion.createOncallItem).toHaveBeenCalled();
    expect(r.tracker).toBe('Notion');
    expect(dedup.findDuplicateCanonical).not.toHaveBeenCalled();
  });

  it('flag ON + match -> stacks (comment + upvote), no new issue, deduped=true', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ identifier: 'ENG-5', issueId: 'uuid-5', title: 'Dark mode', featurebasePostUrl: 'https://fb/p/dark' });
    fb.findPostByTitle.mockResolvedValue({ id: 'post5' });
    const r = await fileUserIssue({ type: 'feature_request', title: 'night mode', description: 'd', userEmail: 'u@e.com', userName: 'U' });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-5', expect.stringContaining('Also reported by u@e.com'));
    expect(fb.addVoter).toHaveBeenCalledWith('post5', 'u@e.com', 'U');
    expect(linear.createLinearIssue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deduped: true, tracker: 'Linear', userUrl: 'https://fb/p/dark' });
  });

  it('flag ON + match -> dedup comment carries the reporter full text + session id (not lossy)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ identifier: 'ENG-5', issueId: 'uuid-5', title: 'X', featurebasePostUrl: 'u' });
    fb.findPostByTitle.mockResolvedValue(null);
    await fileUserIssue({ type: 'bug', title: 'x', description: 'the export button does nothing on CRM', userEmail: 'u2@e.com', userName: 'Two', sessionId: 'sess-abc' });
    const body = linear.addIssueComment.mock.calls[0][1];
    expect(body).toContain('Also reported by u2@e.com (Two)');
    expect(body).toContain('Session: sess-abc');
    expect(body).toContain('the export button does nothing on CRM');
  });

  it('flag ON + delegated match -> comment notes the admin', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ identifier: 'ENG-5', issueId: 'uuid-5', title: 'X', featurebasePostUrl: 'u' });
    fb.findPostByTitle.mockResolvedValue(null);
    await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'cust@e.com', reportedByAdmin: 'admin@a.com' });
    expect(linear.addIssueComment).toHaveBeenCalledWith('uuid-5', expect.stringContaining('via admin@a.com acting on their behalf'));
  });

  it('flag ON + no match -> creates a canonical, deduped=false, userUrl=board', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue(null);
    linear.createLinearIssue.mockResolvedValue({ identifier: 'ENG-9', url: 'https://linear/ENG-9' });
    const r = await fileUserIssue({ type: 'feature_request', title: 'new thing', description: 'd', userEmail: 'u@e.com' });
    expect(linear.createLinearIssue).toHaveBeenCalled();
    expect(r).toMatchObject({ pageId: 'ENG-9', deduped: false, tracker: 'Linear', userUrl: 'https://agentweb.featurebase.app/' });
  });

  it('flag ON + match but upvote/comment throw -> still deduped (best-effort, no duplicate)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue({ identifier: 'ENG-5', issueId: 'uuid-5', title: 'X', featurebasePostUrl: 'u' });
    linear.addIssueComment.mockRejectedValue(new Error('comment down'));
    fb.findPostByTitle.mockRejectedValue(new Error('fb down'));
    const r = await fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' });
    expect(r.deduped).toBe(true);
    expect(linear.createLinearIssue).not.toHaveBeenCalled();
  });

  it('flag ON + create throws -> PROPAGATES (no Notion fallback)', async () => {
    process.env.FEATUREBASE_INTAKE = 'true';
    dedup.findDuplicateCanonical.mockResolvedValue(null);
    linear.createLinearIssue.mockRejectedValue(new Error('Linear down'));
    await expect(fileUserIssue({ type: 'bug', title: 'x', description: 'd', userEmail: 'u@e.com' })).rejects.toThrow('Linear down');
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
