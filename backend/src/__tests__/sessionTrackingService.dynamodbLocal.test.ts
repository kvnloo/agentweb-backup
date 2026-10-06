/**
 * ENG-2327 — session-tracking list creation + record update against REAL DynamoDB semantics.
 *
 * Opt-in: runs only when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local (e.g.
 *   docker run -d --rm -p 127.0.0.1:8123:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8123 npx jest src/__tests__/sessionTrackingService.dynamodbLocal.test.ts
 * ), otherwise the suite is skipped, so CI never needs a database.
 *
 * Real here: crmDb.createLeadList, the conditional claim and state writes in v0Service, getLeadListById,
 * getLandingPageById, commitFilesToRepoMain (against a small in-memory fake of the GitHub git API).
 * Mocked: GitHub's HTTP surface (axios) and the org token. Nothing reaches GitHub, Vercel or v0.
 */
// backend/__mocks__ would stub aws-sdk for every test; this suite needs the real SDK.
jest.unmock('aws-sdk');

// A module (not a global script), so its top-level names cannot collide with other test files under tsc.
export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

// ── fake GitHub (git data API + contents API), one repo ──────────────────────────────────────
const gh = { head: 'c0', commits: {} as Record<string, Record<string, string>>, blobs: {} as Record<string, string>, trees: {} as Record<string, Record<string, string>>, seq: 0 };
const files = () => gh.commits[gh.head];
const mockFakeGhAxios = {
  get: jest.fn(async (url: string) => {
    if (url.endsWith('/git/ref/heads/main')) return { data: { object: { sha: gh.head } } };
    const m = /\/contents\/([^?]+)\?ref=/.exec(url);
    if (m) {
      const f = files()[decodeURIComponent(m[1])];
      if (f === undefined) throw Object.assign(new Error('nf'), { response: { status: 404 } });
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from(f).toString('base64') } };
    }
    throw new Error(`unexpected GET ${url}`);
  }),
  post: jest.fn(async (url: string, body: any) => {
    if (url.endsWith('/git/blobs')) { const sha = `b${++gh.seq}`; gh.blobs[sha] = Buffer.from(body.content, 'base64').toString('utf-8'); return { data: { sha } }; }
    if (url.endsWith('/git/trees')) {
      const tree = { ...files() };
      for (const it of body.tree) tree[it.path] = gh.blobs[it.sha];
      const sha = `t${++gh.seq}`; gh.trees[sha] = tree; return { data: { sha } };
    }
    if (url.endsWith('/git/commits')) { const sha = `c${++gh.seq}`; gh.commits[sha] = gh.trees[body.tree]; return { data: { sha } }; }
    throw new Error(`unexpected POST ${url}`);
  }),
  patch: jest.fn(async (_url: string, body: any) => { gh.head = body.sha; return { data: {} }; }),
};
jest.mock('axios', () => ({ __esModule: true, default: mockFakeGhAxios, ...mockFakeGhAxios, isAxiosError: () => false }));
jest.mock('../utils/secretsManager', () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: 'gh-test-token' }),
  getV0ApiKey: jest.fn().mockResolvedValue('x'),
}));

const LAYOUT = `export default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <head>\n        <meta charSet="utf-8" />\n      </head>\n      <body>{children}</body>\n    </html>\n  )\n}\n`;

suite('session tracking against DynamoDB Local', () => {
  let AWS: any;
  let ddb: any;
  let svc: typeof import('../services/sessionTrackingService');
  let v0: typeof import('../services/v0Service');
  let crmDb: any;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.AWS_REGION = 'us-west-2';
    AWS = require('aws-sdk');
    AWS.config.update({ region: 'us-west-2', endpoint: ENDPOINT, accessKeyId: 'local', secretAccessKey: 'local' });
    const raw = new AWS.DynamoDB();
    const dropIfExists = async (TableName: string) => { try { await raw.deleteTable({ TableName }).promise(); } catch { /* absent */ } };
    await dropIfExists('AW-LeadLists'); await dropIfExists('AW-LandingPages');
    await raw.createTable({
      TableName: 'AW-LeadLists', BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'listId', AttributeType: 'S' }, { AttributeName: 'userId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'listId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{ IndexName: 'userId-index', KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } }],
    }).promise();
    await raw.createTable({
      TableName: 'AW-LandingPages', BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }, { AttributeName: 'userId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{ IndexName: 'UserIdIndex', KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } }],
    }).promise();
    ddb = new AWS.DynamoDB.DocumentClient();
    ({ crmDb } = require('../services/db'));
    v0 = require('../services/v0Service');
    svc = require('../services/sessionTrackingService');
  }, 60_000);

  afterAll(async () => {
    const raw = new AWS.DynamoDB();
    await raw.deleteTable({ TableName: 'AW-LeadLists' }).promise().catch(() => undefined);
    await raw.deleteTable({ TableName: 'AW-LandingPages' }).promise().catch(() => undefined);
  });

  const seedPage = async (id: string, extra: Record<string, any> = {}) => {
    const item = {
      id, userId: 'owner-1', name: `Page ${id}`, status: 'deployed', iterations: 0, prompt: 'p',
      githubRepoUrl: 'https://github.com/AgentWebPro/lp-demo-1234abcd',
      deployedUrl: 'https://lp-demo.vercel.app', customDomainUrl: 'https://demo.agentwebforms.com',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
    };
    await ddb.put({ TableName: 'AW-LandingPages', Item: item }).promise();
    return item;
  };
  const resetRepo = () => { gh.head = 'c0'; gh.commits = { c0: { 'app/layout.tsx': LAYOUT } }; jest.clearAllMocks(); };

  it('enable: persists a real session list + page record, commits the tag, and a second run is a no-op', async () => {
    resetRepo();
    const page = await seedPage('pg-1');
    const r = await svc.enableSessionTrackingForPage(page as any);
    expect(r).toMatchObject({ installed: true, alreadyInstalled: false, listCreated: true });

    const list = (await ddb.get({ TableName: 'AW-LeadLists', Key: { listId: r.listId } }).promise()).Item;
    expect(list).toMatchObject({
      userId: 'owner-1', name: 'LP Sessions - Page pg-1', listType: 'session', isSystemManaged: true,
      publicAccessEnabled: true, alertEvents: [],
    });
    expect(list.trackingConfig.allowedOrigins.sort()).toEqual(['https://demo.agentwebforms.com', 'https://lp-demo.vercel.app']);

    const rec = await v0.getLandingPageById('pg-1');
    expect(rec).toMatchObject({ sessionTrackingListId: r.listId, sessionTrackingInstalled: true });
    expect(rec!.sessionTrackingError).toBeUndefined();
    expect(files()['app/layout.tsx']).toContain(`data-aw-list="${r.listId}"`);
    const commitsAfterFirst = Object.keys(gh.commits).length;

    const again = await svc.enableSessionTrackingForPage(rec as any);
    expect(again).toMatchObject({ listId: r.listId, alreadyInstalled: true, listCreated: false });
    expect(Object.keys(gh.commits).length).toBe(commitsAfterFirst); // no new commit
    const lists = await crmDb.getLeadListsByUserId('owner-1');
    expect(lists.filter((l: any) => l.listType === 'session')).toHaveLength(1); // no second list
  });

  it('claim is conditional: the second claimant loses and the page keeps the first list', async () => {
    await seedPage('pg-2');
    expect(await v0.claimLandingPageSessionTrackingList('pg-2', 'list_first_0001')).toBe(true);
    expect(await v0.claimLandingPageSessionTrackingList('pg-2', 'list_second_0002')).toBe(false);
    expect((await v0.getLandingPageById('pg-2'))!.sessionTrackingListId).toBe('list_first_0001');
    // a dead recorded id may be replaced, but only by naming it
    expect(await v0.claimLandingPageSessionTrackingList('pg-2', 'list_third_0003', 'list_wrong_0000')).toBe(false);
    expect(await v0.claimLandingPageSessionTrackingList('pg-2', 'list_third_0003', 'list_first_0001')).toBe(true);
    expect((await v0.getLandingPageById('pg-2'))!.sessionTrackingListId).toBe('list_third_0003');
  });

  it('state writes never create a ghost record for a page that does not exist', async () => {
    await expect(v0.updateLandingPageSessionTracking('no-such-page', { installed: true, listId: 'list_x_000001' })).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(await v0.claimLandingPageSessionTrackingList('no-such-page', 'list_x_000001')).toBe(false);
    expect((await ddb.get({ TableName: 'AW-LandingPages', Key: { id: 'no-such-page' } }).promise()).Item).toBeUndefined();
  });

  it('a failed commit records the error on the page, keeps the list, and the retry clears the error', async () => {
    resetRepo();
    const page = await seedPage('pg-3');
    mockFakeGhAxios.patch.mockRejectedValueOnce(Object.assign(new Error('GitHub 422'), { response: { status: 422 } }));
    await expect(svc.enableSessionTrackingForPage(page as any)).rejects.toThrow('GitHub 422');
    const failed = await v0.getLandingPageById('pg-3');
    expect(failed).toMatchObject({ sessionTrackingInstalled: false, sessionTrackingError: 'GitHub 422' });
    expect(failed!.sessionTrackingListId).toBeDefined();
    expect(files()['app/layout.tsx']).toBe(LAYOUT); // repo untouched

    const retry = await svc.enableSessionTrackingForPage(failed as any);
    expect(retry.listId).toBe(failed!.sessionTrackingListId);
    expect(retry.listCreated).toBe(false);
    const ok = await v0.getLandingPageById('pg-3');
    expect(ok).toMatchObject({ sessionTrackingInstalled: true });
    expect(ok!.sessionTrackingError).toBeUndefined();
  });

  it('siblings sharing the repo are re-pointed; disable keeps the list and flips installed to false', async () => {
    resetRepo();
    const root = await seedPage('pg-4', { githubRepoUrl: 'https://github.com/AgentWebPro/lp-shared-9999abcd' });
    await seedPage('pg-4b', { githubRepoUrl: 'https://github.com/AgentWebPro/lp-shared-9999abcd', slug: 'sub' });
    await seedPage('pg-4c', { githubRepoUrl: 'https://github.com/AgentWebPro/some-other-repo' });
    const r = await svc.enableSessionTrackingForPage(root as any);
    expect((await v0.getLandingPageById('pg-4b'))).toMatchObject({ sessionTrackingListId: r.listId, sessionTrackingInstalled: true });
    expect((await v0.getLandingPageById('pg-4c'))!.sessionTrackingListId).toBeUndefined();

    const off = await svc.disableSessionTrackingForPage((await v0.getLandingPageById('pg-4')) as any);
    expect(off).toMatchObject({ removed: true, listId: r.listId });
    expect(files()['app/layout.tsx']).toBe(LAYOUT);
    expect((await v0.getLandingPageById('pg-4b'))).toMatchObject({ sessionTrackingInstalled: false, sessionTrackingListId: r.listId });
    expect((await ddb.get({ TableName: 'AW-LeadLists', Key: { listId: r.listId } }).promise()).Item).toBeDefined(); // list kept
  });

  it('a refused page (bespoke tracker) leaves NO list behind', async () => {
    resetRepo();
    gh.commits.c0['app/layout.tsx'] = LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    const page = await seedPage('pg-5', { githubRepoUrl: 'https://github.com/AgentWebPro/lp-bespoke-0000abcd' });
    const before = (await crmDb.getLeadListsByUserId('owner-1')).length;
    await expect(svc.enableSessionTrackingForPage(page as any)).rejects.toMatchObject({ code: 'existing_tracker' });
    expect((await crmDb.getLeadListsByUserId('owner-1')).length).toBe(before);
    expect((await v0.getLandingPageById('pg-5'))!.sessionTrackingListId).toBeUndefined();
  });
});
