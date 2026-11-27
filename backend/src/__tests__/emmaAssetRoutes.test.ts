/**
 * ENG-2840 (W2-10): the two /api/emma routes behind the MCP tools `search_user_assets` and `inspect_linkedin_account`
 * (routes/emmaAssetRoutes.ts). Each checks the body by name and value and reads as `req.user.userId` only: the asset search calls the
 * session search and the task-run read with `{ backfill: false, warm: false, sessions: false }` (tasks.assetWarmOption.test.ts drives the real task read);
 * the account read runs Emma's own tool through her registry with `{ userId }` only, and her "not connected" answer becomes a fixed
 * refusal that does not repeat the id. The router here stands in for emmaApi's (its auth and budget middleware have their own tests).
 */
import express, { Router } from 'express';
import request from 'supertest';

const mockExecute = jest.fn();
const mockSearch = jest.fn();
const mockExecutions = jest.fn();
const mockEnforce = jest.fn();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { execute: (...args: unknown[]) => mockExecute(...args) } }));
jest.mock('../emma/linkedInAccountRevokeTools', () => ({}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { searchUserAssets: (...args: unknown[]) => mockSearch(...args) } }));
jest.mock('../routes/tasks', () => ({ getExecutionsWithAssets: (...args: unknown[]) => mockExecutions(...args) }));
jest.mock('../services/evaluationPolicy', () => ({
  ...jest.requireActual('../services/evaluationPolicy'),
  enforceEvaluationTool: (...args: unknown[]) => mockEnforce(...args),
}));

import { registerAssetAndOutreachAccountRoutes, NO_SUCH_OUTREACH_ACCOUNT_MESSAGE } from '../routes/emmaAssetRoutes';
import { EvaluationDenied } from '../services/evaluationPolicy';

let requestExtras: Record<string, unknown> = {};
const router = Router();
router.use((req: any, _res: any, next: any) => {
  req.user = { userId: 'caller-1', email: 'caller@example.com', isAdmin: true };
  Object.assign(req, requestExtras);
  next();
});
registerAssetAndOutreachAccountRoutes(router);
const app = express();
app.use(express.json());
app.use('/api/emma', router);

const post = (path: string, body: unknown) => request(app).post(`/api/emma/${path}`).send(body as any);
const ch = (code: number) => String.fromCharCode(code);

const sessionAsset = (over: Record<string, unknown> = {}) => ({
  url: 'https://bucket.s3.amazonaws.com/u/a.png', filename: 'a.png', assetType: 'image', generatedAt: '2026-11-01T00:00:00Z',
  sessionId: 'sess-secret', sessionTitle: 'Launch', isFavorited: true, ...over,
});
const taskResult = (files: unknown[], over: Record<string, unknown> = {}) => ({
  t1: { taskId: 't1', taskName: 'Weekly report', source: 'task', executions: [{ executionId: 'e1', startTime: '2026-11-05T00:00:00Z', result_files: files }], ...over },
});

beforeEach(() => {
  mockExecute.mockReset();
  mockSearch.mockReset().mockResolvedValue([]);
  mockExecutions.mockReset().mockResolvedValue({});
  mockEnforce.mockReset().mockResolvedValue(undefined);
  requestExtras = {};
});

describe('identity: req.user.userId only', () => {
  it('the asset search reads only the caller\'s records, with backfill and warm off, whatever else the request carries', async () => {
    requestExtras = { delegateInfo: { adminUserId: 'admin-9', isDelegated: true }, isSelfCall: true };
    const res = await post('user-assets', { type: 'htmlReports', query: 'deck', limit: 10 });
    expect(res.status).toBe(200);
    expect(mockEnforce).toHaveBeenCalledWith('caller-1', 'search_user_assets');
    expect(mockSearch.mock.calls).toStrictEqual([['caller-1', 'htmlReports', 'deck', false, false]]);
    expect(mockExecutions.mock.calls).toStrictEqual([['caller-1', 'html-reports', '', { backfill: false, warm: false, sessions: false }]]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('the account read runs Emma\'s tool with { userId } and nothing else', async () => {
    requestExtras = { delegateInfo: { adminUserId: 'admin-9', isDelegated: true } };
    mockExecute.mockResolvedValue({ accounts: [] });
    await post('linkedin-outreach-account', {});
    await post('linkedin-outreach-account', { account_id: 'acc_1-X' });
    expect(mockExecute.mock.calls).toStrictEqual([
      ['inspect_linkedin_account', {}, { userId: 'caller-1' }],
      ['inspect_linkedin_account', { account_id: 'acc_1-X' }, { userId: 'caller-1' }],
    ]);
  });

  it('refuses any identity field in the body by name (400), reading nothing', async () => {
    for (const [path, body] of [
      ['user-assets', { userId: 'victim' }],
      ['user-assets', { user_id: 'victim', type: 'all' }],
      ['user-assets', { session_id: 's1' }],
      ['linkedin-outreach-account', { userId: 'victim' }],
      ['linkedin-outreach-account', { account_id: 'a1', owner_user_id: 'victim' }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not an input/);
    }
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockExecutions).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('bad input is refused (400) before anything runs', () => {
  it.each<[string, unknown, RegExp]>([
    ['user-assets', { type: 'image' }, /type must be one of images, videos, htmlReports, all/],
    ['user-assets', { type: 'ALL' }, /type must be one of/],
    ['user-assets', { type: 3 }, /type must be one of/],
    ['user-assets', { query: 'q'.repeat(101) }, /query must be text of at most 100 characters/],
    ['user-assets', { query: 12 }, /query must be text/],
    ['user-assets', { query: `a${ch(0)}b` }, /without control or invisible characters/],
    ['user-assets', { query: `a${ch(10)}b` }, /without control or invisible characters/],
    ['user-assets', { query: `a${ch(0x200b)}b` }, /without control or invisible characters/],
    ['user-assets', { query: `a${ch(0x202e)}b` }, /without control or invisible characters/],
    ['user-assets', { favorites_only: 'true' }, /favorites_only must be true or false/],
    ['user-assets', { approved_only: 1 }, /approved_only must be true or false/],
    ['user-assets', { limit: 0 }, /limit must be a whole number from 1 to 100/],
    ['user-assets', { limit: 101 }, /limit must be a whole number from 1 to 100/],
    ['user-assets', { limit: 2.5 }, /limit must be/],
    ['user-assets', { limit: '10' }, /limit must be/],
    ['user-assets', [1], /must be an object/],
    ['linkedin-outreach-account', { account_id: '' }, /account_id must be the id of one of your LinkedIn Outreach accounts/],
    ['linkedin-outreach-account', { account_id: 'a'.repeat(65) }, /account_id must be/],
    ['linkedin-outreach-account', { account_id: '../acc' }, /account_id must be/],
    ['linkedin-outreach-account', { account_id: 'acc 1' }, /account_id must be/],
    ['linkedin-outreach-account', { account_id: 'acc.1' }, /account_id must be/],
    ['linkedin-outreach-account', { account_id: 42 }, /account_id must be/],
    ['linkedin-outreach-account', { account_id: ['acc'] }, /account_id must be/],
  ])('%s %j', async (path, body, re) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(re);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockExecutions).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a refused account_id is never repeated back', async () => {
    const res = await post('linkedin-outreach-account', { account_id: 'evil<script>id' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/evil|script/);
  });
});

describe('search_user_assets', () => {
  it('maps type to the task-run read as Emma does: all or none -> html-reports only; favorites or approved -> no task files', async () => {
    for (const body of [{}, { type: 'all' }, { type: 'htmlReports' }, { type: 'images' }, { type: 'videos' }]) await post('user-assets', body);
    expect(mockExecutions.mock.calls.map((c) => c[1])).toEqual(['html-reports', 'html-reports', 'html-reports', 'images', 'videos']);
    expect(mockSearch.mock.calls.map((c) => c[1])).toEqual([undefined, 'all', 'htmlReports', 'images', 'videos']);
    mockExecutions.mockClear();
    await post('user-assets', { favorites_only: true });
    await post('user-assets', { approved_only: true, type: 'images' });
    expect(mockExecutions).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls.slice(-2)).toStrictEqual([['caller-1', undefined, undefined, true, false], ['caller-1', 'images', undefined, false, true]]);
  });

  it('answers fixed fields newest first, task files filtered by query, no session id, searchable text, feedback or token', async () => {
    mockSearch.mockResolvedValue([
      sessionAsset({ url: 'https://bucket.s3.amazonaws.com/u/deck-old.html', filename: 'deck-old.html', assetType: 'htmlReport', generatedAt: '2026-10-01T00:00:00Z', isFavorited: false }),
      sessionAsset({ url: 'https://bucket.s3.amazonaws.com/u/deck.html', filename: 'deck.html', assetType: 'htmlReport', generatedAt: '2026-11-09T00:00:00Z', approvalStatus: 'approved' }),
    ]);
    mockExecutions.mockResolvedValue({
      ...taskResult([
        { url: 'https://bucket.s3.amazonaws.com/u/deck-task.html', filename: 'deck-task.html', token: 'tok-secret', searchableText: 'secret text', feedback: { userId: 'x' } },
        { url: 'https://bucket.s3.amazonaws.com/u/other.html', filename: 'other.html' },
        { s3_url: 'https://bucket.s3.amazonaws.com/u/deck-s3.html' },
      ]),
      'agent-mode-s1': { source: 'agent-mode', sessionId: 'sess-secret', executions: [{ result_files: [{ url: 'https://bucket.s3.amazonaws.com/u/deck-agent.html', filename: 'deck-agent.html' }] }] },
    });
    const res = await post('user-assets', { query: '  deck ' });
    expect(mockSearch.mock.calls[0][2]).toBe('deck');
    expect(res.body).toStrictEqual({
      success: true, total: 4, count: 4,
      assets: [
        { url: 'https://bucket.s3.amazonaws.com/u/deck.html', filename: 'deck.html', asset_type: 'htmlReport', generated_at: '2026-11-09T00:00:00Z', session_title: 'Launch', is_favorited: true, approval_status: 'approved' },
        { url: 'https://bucket.s3.amazonaws.com/u/deck-task.html', filename: 'deck-task.html', asset_type: 'htmlReport', generated_at: '2026-11-05T00:00:00Z', session_title: 'Weekly report', is_favorited: false },
        { url: 'https://bucket.s3.amazonaws.com/u/deck-s3.html', filename: 'deck-s3.html', asset_type: 'htmlReport', generated_at: '2026-11-05T00:00:00Z', session_title: 'Weekly report', is_favorited: false },
        { url: 'https://bucket.s3.amazonaws.com/u/deck-old.html', filename: 'deck-old.html', asset_type: 'htmlReport', generated_at: '2026-10-01T00:00:00Z', session_title: 'Launch', is_favorited: false },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/sess-secret|sessionId|session_id|tok-secret|secret text|feedback|deck-agent/);
  });

  it('applies limit (default 50) after sorting; total counts every match', async () => {
    mockSearch.mockResolvedValue(Array.from({ length: 120 }, (_, i) => sessionAsset({ url: `https://b.s3.amazonaws.com/u/${i}.png`, filename: `${i}.png`, generatedAt: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z` })));
    const a = await post('user-assets', { type: 'images' });
    expect(a.body).toMatchObject({ total: 120, count: 50 });
    expect(a.body.assets).toHaveLength(50);
    const b = await post('user-assets', { type: 'images', limit: 100 });
    expect(b.body).toMatchObject({ total: 120, count: 100 });
    const c = await post('user-assets', { type: 'images', limit: 3 });
    expect(c.body.assets.map((x: any) => x.generated_at)).toEqual(['2026-11-01T00:00:59Z', '2026-11-01T00:00:59Z', '2026-11-01T00:00:58Z']);
  });

  it('leaves out anything that is not a plain http(s) link, and cuts long texts', async () => {
    mockSearch.mockResolvedValue([
      sessionAsset({ url: 'javascript:alert(1)' }),
      sessionAsset({ url: 'https://b.s3.amazonaws.com/u/a b.png' }),
      sessionAsset({ url: `https://b.s3.amazonaws.com/u/${ch(0x202e)}gnp.exe` }),
      sessionAsset({ url: `https://b.s3.amazonaws.com/${'x'.repeat(2100)}` }),
      sessionAsset({ url: 'https://b.s3.amazonaws.com/u/ok.png', filename: 'f'.repeat(500), sessionTitle: 't'.repeat(500), generatedAt: undefined }),
    ]);
    const res = await post('user-assets', {});
    expect(res.body.total).toBe(1);
    const [only] = res.body.assets;
    expect(only.url).toBe('https://b.s3.amazonaws.com/u/ok.png');
    expect(only.filename).toBe(`${'f'.repeat(300)}… [cut at 300 characters]`);
    expect(only.session_title).toBe(`${'t'.repeat(300)}… [cut at 300 characters]`);
    expect(only.generated_at).toBeUndefined();
  });

  it('an unexpected failure is a 500 with a fixed text; a sandbox refusal is a 403 and reads nothing', async () => {
    mockSearch.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded at arn:aws:dynamodb:secret'));
    const res = await post('user-assets', {});
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ message: 'Your assets could not be read' });
    mockSearch.mockClear();
    mockEnforce.mockRejectedValueOnce(new EvaluationDenied('expired'));
    const denied = await post('user-assets', {});
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/sandbox workspace/);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockExecutions).not.toHaveBeenCalled();
  });
});

describe('inspect_linkedin_account', () => {
  const emmaAccounts = [
    { accountId: 'acc_1', name: 'Jane Doe', sharedWithOrg: true, connectedAt: '2026-10-01T00:00:00Z', access_token: 'tok-secret' },
    { accountId: 'acc_2', name: 'Team', sharedWithOrg: false, connectedAt: 1767225600000 },
  ];

  it('lists the caller\'s accounts in fixed fields only (no tokens)', async () => {
    mockExecute.mockResolvedValueOnce({ accounts: emmaAccounts });
    const res = await post('linkedin-outreach-account', {});
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      accounts: [
        { account_id: 'acc_1', name: 'Jane Doe', shared_with_org: true, connected_at: '2026-10-01T00:00:00Z' },
        { account_id: 'acc_2', name: 'Team', shared_with_org: false, connected_at: '1767225600000' },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/tok-secret|access_token/);
  });

  it('with an account of the caller: its queued actions in fixed fields', async () => {
    mockExecute.mockResolvedValueOnce({
      accounts: emmaAccounts, accountId: 'acc_1',
      queuedActions: [
        { scheduleId: 'sch-1', actionType: 'comment', targetType: 'post', postId: 'urn:li:activity:1', nextRunTime: '2026-11-28T00:00:00Z', role: 'owner+engager', variableValues: { comment: 'secret text' } },
        { scheduleId: 'sch-2', actionType: 'like', targetType: 'post', postId: 'urn:li:activity:2', nextRunTime: '2026-11-29T00:00:00Z' },
      ],
    });
    const res = await post('linkedin-outreach-account', { account_id: 'acc_1' });
    expect(res.body.account_id).toBe('acc_1');
    expect(res.body.queued_actions).toStrictEqual([
      { schedule_id: 'sch-1', action_type: 'comment', target_type: 'post', post_id: 'urn:li:activity:1', next_run_time: '2026-11-28T00:00:00Z', role: 'owner+engager' },
      { schedule_id: 'sch-2', action_type: 'like', target_type: 'post', post_id: 'urn:li:activity:2', next_run_time: '2026-11-29T00:00:00Z' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/secret text|variableValues/);
  });

  it('an account that is not the caller\'s is a fixed refusal that does not repeat the id', async () => {
    mockExecute.mockResolvedValueOnce({ accounts: emmaAccounts, error: 'No LinkedIn Outreach account other_tenant_acc is connected to this user.' });
    const res = await post('linkedin-outreach-account', { account_id: 'other_tenant_acc' });
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ success: false, message: NO_SUCH_OUTREACH_ACCOUNT_MESSAGE });
    expect(JSON.stringify(res.body)).not.toMatch(/other_tenant_acc|acc_1/);
  });

  it('an answer without an account list, or a failure, is a 500 with a fixed text; a sandbox refusal is a 403', async () => {
    mockExecute.mockResolvedValueOnce({ deferred: true, message: 'Sign in to use inspect_linkedin_account' });
    const a = await post('linkedin-outreach-account', {});
    expect(a.status).toBe(500);
    expect(a.body).toStrictEqual({ message: 'Your LinkedIn Outreach accounts could not be read' });
    mockExecute.mockRejectedValueOnce(new Error('Authentication required: no user context at /var/app'));
    const b = await post('linkedin-outreach-account', { account_id: 'acc_1' });
    expect(b.status).toBe(500);
    expect(JSON.stringify(b.body)).not.toMatch(/var\/app|acc_1/);
    mockExecute.mockRejectedValueOnce(new EvaluationDenied('Tool "inspect_linkedin_account" is not available in this sandbox workspace'));
    const c = await post('linkedin-outreach-account', {});
    expect(c.status).toBe(403);
  });
});
