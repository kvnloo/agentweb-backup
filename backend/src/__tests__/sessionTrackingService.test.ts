/**
 * ENG-2327 — enableSessionTrackingForPage / disableSessionTrackingForPage / autoEnableSessionTracking.
 *
 * The GitHub boundary (axios + commitFilesToRepoMain), the CRM list store and the landing-page record
 * writers are mocked; nothing here reaches GitHub, Vercel, v0 or DynamoDB. The fake repo is stateful so
 * the tests assert on what ends up on `main`, not just on which calls were made.
 */
const mockAxiosGet = jest.fn();
const mockCommit = jest.fn();
const mockClaim = jest.fn();
const mockGetPage = jest.fn();
const mockListPages = jest.fn();
const mockLiveUrl = jest.fn();
const mockUpdateState = jest.fn();
const mockCreateList = jest.fn();
const mockGetList = jest.fn();
const mockUpdateList = jest.fn();
const mockDeleteList = jest.fn();

jest.mock('axios', () => ({ __esModule: true, default: { get: (...a: any[]) => mockAxiosGet(...a) } }));
const mockOrgToken = jest.fn();
jest.mock('../utils/secretsManager', () => ({ getGitHubOrgToken: (...a: any[]) => mockOrgToken(...a) }));
jest.mock('../services/db', () => ({
  crmDb: {
    createLeadList: (...a: any[]) => mockCreateList(...a),
    getLeadListById: (...a: any[]) => mockGetList(...a),
    updateLeadList: (...a: any[]) => mockUpdateList(...a),
    deleteLeadList: (...a: any[]) => mockDeleteList(...a),
  },
}));
jest.mock('../services/v0Service', () => ({
  claimLandingPageSessionTrackingList: (...a: any[]) => mockClaim(...a),
  commitFilesToRepoMain: (...a: any[]) => mockCommit(...a),
  getLandingPageById: (...a: any[]) => mockGetPage(...a),
  listLandingPages: (...a: any[]) => mockListPages(...a),
  resolveLandingPageLiveUrl: (...a: any[]) => mockLiveUrl(...a),
  updateLandingPageSessionTracking: (...a: any[]) => mockUpdateState(...a),
}));

import {
  SessionTrackingError,
  autoEnableSessionTracking,
  deriveAllowedOrigins,
  disableSessionTrackingForPage,
  enableSessionTrackingForPage,
  isAutoSessionTrackingEnabled,
} from '../services/sessionTrackingService';
import { extractInstalledListId, injectSessionTrackingIntoLayout } from '../utils/sessionTrackingInjection';

const LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="x" content="y" />
      </head>
      <body>{children}</body>
    </html>
  )
}
`;
const HTML = `<!doctype html>\n<html>\n<head>\n  <title>t</title>\n</head>\n<body></body>\n</html>\n`;

const page = (extra: Record<string, any> = {}): any => ({
  id: 'p1', userId: 'owner1', name: 'Spring Offer', status: 'deployed', slug: 'spring',
  githubRepoUrl: 'https://github.com/AgentWebPro/lp-spring-1234abcd',
  deployedUrl: 'https://lp-spring.vercel.app',
  customDomainUrl: 'https://spring.agentwebforms.com',
  ...extra,
});

let files: Record<string, string>;
let mainSha: number;
let lists: Record<string, any>;
let listSeq: number;
let githubUrls: string[];
let treeTruncated: boolean;

beforeEach(() => {
  jest.resetAllMocks();
  files = { 'app/layout.tsx': LAYOUT };
  mainSha = 0;
  lists = {};
  listSeq = 0;
  githubUrls = [];
  treeTruncated = false;
  delete process.env.AUTO_SESSION_TRACKING;
  mockOrgToken.mockResolvedValue({ token: 'gh-test-token' });

  mockAxiosGet.mockImplementation(async (url: string) => {
    githubUrls.push(url);
    if (url.endsWith('/git/ref/heads/main')) return { data: { object: { sha: `sha${mainSha}` } } };
    if (url.includes('/git/trees/')) {
      return { data: { truncated: treeTruncated, tree: Object.keys(files).map((path) => ({ path, type: 'blob', size: files[path].length })) } };
    }
    const m = /\/contents\/([^?]+)\?ref=/.exec(url);
    if (m) {
      const path = decodeURIComponent(m[1]);
      if (!(path in files)) throw Object.assign(new Error('nf'), { response: { status: 404 } });
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from(files[path]).toString('base64') } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  mockCommit.mockImplementation(async (_repo: string, _h: any, toCommit: Array<{ path: string; content: Buffer }>) => {
    for (const f of toCommit) files[f.path] = f.content.toString('utf-8');
    mainSha += 1;
    return { pushedCommitSha: `sha${mainSha}`, pushTimestampMs: Date.now() };
  });
  mockCreateList.mockImplementation(async (userId: string, name: string, _d: string, alertEvents: any[], ...rest: any[]) => {
    const init = rest[rest.length - 1];
    const list = { listId: `list_test_${++listSeq}_aaaa`, userId, name, alertEvents, listType: rest[5], isSystemManaged: rest[6], ...init };
    lists[list.listId] = list;
    return list;
  });
  mockGetList.mockImplementation(async (id: string) => lists[id] ?? null);
  mockUpdateList.mockImplementation(async (id: string, patch: any) => { lists[id] = { ...lists[id], ...patch }; return lists[id]; });
  mockDeleteList.mockResolvedValue(undefined);
  mockClaim.mockResolvedValue(true);
  mockGetPage.mockResolvedValue(null);
  mockListPages.mockResolvedValue([]);
  mockLiveUrl.mockImplementation(async (p: any) => p.customDomainUrl || p.deployedUrl || '');
  mockUpdateState.mockResolvedValue(undefined);
});

describe('deriveAllowedOrigins', () => {
  it('uses exact https origins of custom domain, deployed url and live url, de-duplicated', async () => {
    const o = await deriveAllowedOrigins(page({ customDomainUrl: 'https://Spring.Example.com/lp', deployedUrl: 'https://lp-spring.vercel.app' }));
    expect(o).toEqual(['https://spring.example.com', 'https://lp-spring.vercel.app']);
  });
  it('adds the *.agentwebforms.com live URL when Vercel resolves one that differs', async () => {
    mockLiveUrl.mockResolvedValue('https://live.agentwebforms.com/spring');
    const o = await deriveAllowedOrigins(page({ customDomainUrl: 'https://custom.example.com' }));
    expect(o).toEqual(['https://custom.example.com', 'https://lp-spring.vercel.app', 'https://live.agentwebforms.com']);
  });
  it('drops plain http, junk and wildcard-looking hosts; accepts a bare host as https', async () => {
    mockLiveUrl.mockResolvedValue('');
    expect(await deriveAllowedOrigins(page({ customDomainUrl: 'http://insecure.example.com', deployedUrl: 'lp.vercel.app' }))).toEqual(['https://lp.vercel.app']);
    expect(await deriveAllowedOrigins(page({ customDomainUrl: '*.example.com', deployedUrl: 'not a url' }))).toEqual([]);
  });
  it('survives the live-url lookup throwing', async () => {
    mockLiveUrl.mockRejectedValue(new Error('vercel down'));
    expect(await deriveAllowedOrigins(page())).toEqual(['https://spring.agentwebforms.com', 'https://lp-spring.vercel.app']);
  });
});

describe('enableSessionTrackingForPage — first run', () => {
  it('creates the list, commits the tag to the layout, records the result', async () => {
    const r = await enableSessionTrackingForPage(page());
    expect(mockCreateList).toHaveBeenCalledTimes(1);
    const [userId, name, , alertEvents, , , , , , listType, isSystemManaged, , init] = mockCreateList.mock.calls[0];
    expect(userId).toBe('owner1');                          // owner = page owner
    expect(name).toBe('LP Sessions - Spring Offer');
    expect(alertEvents).toEqual([]);
    expect(listType).toBe('session');
    expect(isSystemManaged).toBe(true);
    expect(init.publicAccessEnabled).toBe(true);
    expect(init.trackingConfig).toEqual({
      allowedOrigins: ['https://spring.agentwebforms.com', 'https://lp-spring.vercel.app'],
      pageLabel: 'Spring Offer',
    });

    expect(mockClaim).toHaveBeenCalledWith('p1', r.listId, undefined);
    expect(mockCommit).toHaveBeenCalledTimes(1);
    const [repo, headers, toCommit, message, attempts, branch] = mockCommit.mock.calls[0];
    expect(repo).toBe('AgentWebPro/lp-spring-1234abcd');
    expect(headers.Authorization).toBe('Bearer gh-test-token');
    expect(toCommit.map((f: any) => f.path)).toEqual(['app/layout.tsx']);
    expect(message).toContain(r.listId);
    expect(branch).toBe('main');
    expect(attempts).toBe(4);

    expect(extractInstalledListId(files['app/layout.tsx'], 'layout')).toBe(r.listId);
    expect(r).toMatchObject({ installed: true, alreadyInstalled: false, listCreated: true, path: 'app/layout.tsx' });
    expect(r.embedSnippet).toContain(`data-aw-list="${r.listId}"`);
    expect(r.commitUrl).toBe('https://github.com/AgentWebPro/lp-spring-1234abcd/commit/sha1');
    expect(mockUpdateState).toHaveBeenCalledWith('p1', { installed: true, listId: r.listId });
  });

  it('only ever talks to the page\'s own repo and commits only the layout (never .github/)', async () => {
    await enableSessionTrackingForPage(page());
    expect(githubUrls.length).toBeGreaterThan(0);
    for (const u of githubUrls) expect(u.startsWith('https://api.github.com/repos/AgentWebPro/lp-spring-1234abcd/')).toBe(true);
    for (const call of mockCommit.mock.calls) {
      for (const f of call[2]) expect(f.path.startsWith('.github/')).toBe(false);
      expect(call[0]).toBe('AgentWebPro/lp-spring-1234abcd');
    }
  });

  it('creates the list and records it BEFORE the commit touches the repo', async () => {
    const order: string[] = [];
    const baseCreate = mockCreateList.getMockImplementation()!;
    mockCreateList.mockImplementation(async (...a: any[]) => { order.push('create'); return baseCreate(...a); });
    mockClaim.mockImplementation(async () => { order.push('claim'); return true; });
    const baseCommit = mockCommit.getMockImplementation()!;
    mockCommit.mockImplementation(async (...a: any[]) => { order.push('commit'); return baseCommit(...a); });
    await enableSessionTrackingForPage(page());
    expect(order).toEqual(['create', 'claim', 'commit']);
  });
});

describe('enableSessionTrackingForPage — idempotency', () => {
  it('a second run reuses the list, commits nothing and reports alreadyInstalled', async () => {
    const first = await enableSessionTrackingForPage(page());
    mockCreateList.mockClear(); mockCommit.mockClear(); mockClaim.mockClear();
    const second = await enableSessionTrackingForPage(page({ sessionTrackingListId: first.listId, sessionTrackingInstalled: true }));
    expect(second.listId).toBe(first.listId);
    expect(second).toMatchObject({ installed: true, alreadyInstalled: true, listCreated: false });
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(second.commitUrl).toBeUndefined();
  });

  it('a retry after a failed commit reuses the list (idempotency by sessionTrackingListId) and then commits', async () => {
    mockCommit.mockRejectedValueOnce(new Error('GitHub 502'));
    await expect(enableSessionTrackingForPage(page())).rejects.toThrow('GitHub 502');
    expect(mockCreateList).toHaveBeenCalledTimes(1);
    const listId = Object.keys(lists)[0];
    // the failure is recorded on the page, with the list kept
    expect(mockUpdateState).toHaveBeenCalledWith('p1', { installed: false, listId, error: 'GitHub 502' });
    expect(files['app/layout.tsx']).toBe(LAYOUT); // page untouched

    const r = await enableSessionTrackingForPage(page({ sessionTrackingListId: listId }));
    expect(mockCreateList).toHaveBeenCalledTimes(1); // still one list
    expect(r).toMatchObject({ listId, installed: true, listCreated: false, alreadyInstalled: false });
    expect(extractInstalledListId(files['app/layout.tsx'], 'layout')).toBe(listId);
  });

  it('merges new page origins into a reused list (never removes one) so a later domain works', async () => {
    const first = await enableSessionTrackingForPage(page());
    lists[first.listId].trackingConfig.allowedOrigins.push('https://hand-added.example.com');
    mockUpdateList.mockClear();
    await enableSessionTrackingForPage(page({ sessionTrackingListId: first.listId, customDomainUrl: 'https://new-domain.example.com' }));
    expect(lists[first.listId].trackingConfig.allowedOrigins).toEqual([
      'https://spring.agentwebforms.com', 'https://lp-spring.vercel.app', 'https://hand-added.example.com', 'https://new-domain.example.com',
    ]);
  });

  it('caps a reused list at 10 origins', async () => {
    const first = await enableSessionTrackingForPage(page());
    lists[first.listId].trackingConfig.allowedOrigins = Array.from({ length: 10 }, (_, i) => `https://h${i}.example.com`);
    await enableSessionTrackingForPage(page({ sessionTrackingListId: first.listId }));
    expect(lists[first.listId].trackingConfig.allowedOrigins).toHaveLength(10);
  });

  it('adopts the list the repo already points at (record lost) without creating or committing', async () => {
    const tagged = injectSessionTrackingIntoLayout(LAYOUT, 'list_existing_999');
    files['app/layout.tsx'] = tagged;
    lists['list_existing_999'] = { listId: 'list_existing_999', userId: 'owner1', listType: 'session', trackingConfig: { allowedOrigins: ['https://spring.agentwebforms.com', 'https://lp-spring.vercel.app'] } };
    const r = await enableSessionTrackingForPage(page());
    expect(r).toMatchObject({ listId: 'list_existing_999', alreadyInstalled: true, listCreated: false });
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockUpdateState).toHaveBeenCalledWith('p1', { installed: true, listId: 'list_existing_999' });
  });

  it('refuses to adopt a tag pointing at a list the page owner does not own', async () => {
    files['app/layout.tsx'] = injectSessionTrackingIntoLayout(LAYOUT, 'list_someone_else');
    lists['list_someone_else'] = { listId: 'list_someone_else', userId: 'intruder', listType: 'session' };
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'list_mismatch', httpStatus: 409 });
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('a recorded list that no longer exists is replaced (claim names the dead id)', async () => {
    const r = await enableSessionTrackingForPage(page({ sessionTrackingListId: 'list_deleted_000' }));
    expect(mockCreateList).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledWith('p1', r.listId, 'list_deleted_000');
  });

  it('a recorded id that is not a session list (or not the owner\'s) is never reused', async () => {
    lists['list_sales_0001'] = { listId: 'list_sales_0001', userId: 'owner1', listType: 'sales' };
    const r = await enableSessionTrackingForPage(page({ sessionTrackingListId: 'list_sales_0001' }));
    expect(r.listId).not.toBe('list_sales_0001');
  });

  it('loses a concurrent claim: deletes its surplus list and uses the winner\'s', async () => {
    lists['list_winner_0001'] = { listId: 'list_winner_0001', userId: 'owner1', listType: 'session', trackingConfig: { allowedOrigins: [] } };
    mockClaim.mockResolvedValueOnce(false);
    mockGetPage.mockResolvedValueOnce({ id: 'p1', sessionTrackingListId: 'list_winner_0001' });
    const r = await enableSessionTrackingForPage(page());
    expect(r.listId).toBe('list_winner_0001');
    expect(r.listCreated).toBe(false);
    expect(mockDeleteList).toHaveBeenCalledTimes(1);
    expect(mockDeleteList).toHaveBeenCalledWith('list_test_1_aaaa');
    expect(extractInstalledListId(files['app/layout.tsx'], 'layout')).toBe('list_winner_0001');
  });

  it('two concurrent calls for one repo are serialised: one list, one commit', async () => {
    // Emulate the record: the second call sees what the first claimed.
    let recorded: string | undefined;
    mockClaim.mockImplementation(async (_id: string, listId: string) => { if (recorded) return false; recorded = listId; return true; });
    mockGetPage.mockImplementation(async () => ({ id: 'p1', sessionTrackingListId: recorded }));
    const [a, b] = await Promise.all([enableSessionTrackingForPage(page()), enableSessionTrackingForPage(page())]);
    expect(a.listId).toBe(b.listId);
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect((files['app/layout.tsx'].match(/AgentWeb Session Tracking \*\//g) ?? []).length).toBe(2); // start + end of ONE block
  });
});

describe('enableSessionTrackingForPage — refusals leave nothing behind', () => {
  const expectUntouched = () => {
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  };

  it('refuses a layout that already carries a tracker (no list, no commit)', async () => {
    files['app/layout.tsx'] = LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'existing_tracker', httpStatus: 409 });
    expectUntouched();
  });

  it('refuses a static page with a bespoke tracker (the DramaBreak shape)', async () => {
    files = { 'public/index.html': HTML.replace('</head>', '<script>localStorage.aw_sess_x = 1</script></head>') };
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'existing_tracker' });
    expectUntouched();
  });

  it('an explicit override installs despite an existing tracker', async () => {
    files['app/layout.tsx'] = LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    const r = await enableSessionTrackingForPage(page(), { overrideExistingTracker: true });
    expect(r.installed).toBe(true);
    expect(files['app/layout.tsx']).toContain('aw_sess_');
    expect(extractInstalledListId(files['app/layout.tsx'], 'layout')).toBe(r.listId);
  });

  it('refuses a layout shape the injector does not understand', async () => {
    files['app/layout.tsx'] = 'export default function RootLayout({ children }) { return children }\n';
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'unsupported_shape' });
    expectUntouched();
  });

  it('refuses when there is neither a layout nor a static page', async () => {
    files = { 'README.md': '# x' };
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'no_target_file' });
    expectUntouched();
  });

  it.each([
    ['external record', { sourceType: 'external' }, 'external_page'],
    ['generating', { status: 'generating' }, 'not_deployed'],
    ['deploying', { status: 'deploying' }, 'not_deployed'],
    ['failed build', { status: 'failed' }, 'not_deployed'],
    ['no repo', { githubRepoUrl: undefined }, 'no_repo'],
    ['unparseable repo', { githubRepoUrl: 'https://example.com/x' }, 'invalid_repo'],
    ['repo with odd characters', { githubRepoUrl: 'https://github.com/org/re po' }, 'invalid_repo'],
  ])('refuses %s', async (_n, extra, code) => {
    await expect(enableSessionTrackingForPage(page(extra))).rejects.toMatchObject({ code });
    expectUntouched();
    expect(githubUrls).toEqual([]);
  });

  it('refuses a page with no https address (nothing to allow)', async () => {
    mockLiveUrl.mockResolvedValue('');
    await expect(enableSessionTrackingForPage(page({ customDomainUrl: undefined, deployedUrl: undefined }))).rejects.toMatchObject({ code: 'no_origins' });
    expectUntouched();
  });

  it.each(['.github/x.html', 'public/../secret.html', '/etc/passwd.html', 'app/layout.tsx', 'public/a.js', 'public\\x.html'])(
    'rejects htmlPath %p',
    async (htmlPath) => {
      await expect(enableSessionTrackingForPage(page(), { htmlPath })).rejects.toMatchObject({ code: 'invalid_path' });
      expectUntouched();
    },
  );

  it('does not edit a file it cannot read whole (>1MB Contents API response)', async () => {
    mockAxiosGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/git/ref/heads/main')) return { data: { object: { sha: 'sha0' } } };
      return { data: { type: 'file', encoding: 'none', content: '' } };
    });
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'too_large' });
    expectUntouched();
  });
});

describe('enableSessionTrackingForPage — static HTML', () => {
  it('tags public/<slug>.html when there is no layout', async () => {
    files = { 'public/spring.html': HTML, 'public/index.html': HTML };
    const r = await enableSessionTrackingForPage(page());
    expect(r.path).toBe('public/spring.html');
    expect(files['public/spring.html']).toContain(`data-aw-list="${r.listId}"`);
    expect(files['public/index.html']).toBe(HTML);
    expect(mockCommit.mock.calls[0][2].map((f: any) => f.path)).toEqual(['public/spring.html']);
  });
  it('falls back to public/index.html, and honours an explicit htmlPath', async () => {
    files = { 'public/index.html': HTML, 'public/offer.html': HTML };
    expect((await enableSessionTrackingForPage(page({ slug: undefined }))).path).toBe('public/index.html');
    const r = await enableSessionTrackingForPage(page(), { htmlPath: 'public/offer.html' });
    expect(r.path).toBe('public/offer.html');
  });
  it('does not sync siblings for a static page (the tag is per file)', async () => {
    files = { 'public/index.html': HTML };
    mockListPages.mockResolvedValue([page(), page({ id: 'p2' })]);
    await enableSessionTrackingForPage(page());
    expect(mockListPages).not.toHaveBeenCalled();
  });
});

describe('enableSessionTrackingForPage — siblings and races', () => {
  it('re-points every other record on the same repo (shared layout), best-effort', async () => {
    mockListPages.mockResolvedValue([
      page(), page({ id: 'p2' }), page({ id: 'p3', githubRepoUrl: 'https://github.com/AgentWebPro/other-repo' }),
      page({ id: 'p4', sourceType: 'external' }),
    ]);
    mockUpdateState.mockImplementation(async (id: string) => { if (id === 'p2') throw new Error('ddb'); });
    const r = await enableSessionTrackingForPage(page());
    const ids = mockUpdateState.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(ids).not.toContain('p3');
    expect(ids).not.toContain('p4');
    expect(r.installed).toBe(true); // a failed sibling write never fails the call
  });

  it('recomputes from a fresh read when main moves while the edit is being prepared', async () => {
    let reads = 0;
    mockAxiosGet.mockImplementation(async (url: string) => {
      githubUrls.push(url);
      if (url.endsWith('/git/ref/heads/main')) { reads++; return { data: { object: { sha: reads === 3 ? 'moved' : `sha${mainSha}` } } }; }
      if (url.includes('/git/trees/')) return { data: { truncated: false, tree: Object.keys(files).map((path) => ({ path, type: 'blob', size: 1 })) } };
      const m = /\/contents\/([^?]+)\?ref=/.exec(url)!;
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from(files[decodeURIComponent(m[1])]).toString('base64') } };
    });
    const r = await enableSessionTrackingForPage(page());
    expect(r.installed).toBe(true);
    expect(mockCommit).toHaveBeenCalledTimes(1);
    // probe read + the first (abandoned) attempt + the redo = three reads of the layout, not two
    expect(githubUrls.filter((u) => u.includes('/contents/app/layout.tsx')).length).toBeGreaterThanOrEqual(3);
  });

  it('records a failure and throws when the commit cannot be confirmed on main', async () => {
    mockCommit.mockImplementation(async () => ({ pushedCommitSha: 'shaX', pushTimestampMs: 1 })); // claims success, writes nothing
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'verify_failed' });
    expect(mockUpdateState).toHaveBeenCalledWith('p1', expect.objectContaining({ installed: false, error: expect.stringContaining('could not be confirmed') }));
    expect(mockUpdateState).not.toHaveBeenCalledWith('p1', { installed: true, listId: expect.any(String) });
  });
});

describe('disableSessionTrackingForPage', () => {
  it('removes the tag, keeps the list, records installed:false', async () => {
    const on = await enableSessionTrackingForPage(page());
    mockCommit.mockClear(); mockUpdateState.mockClear();
    const r = await disableSessionTrackingForPage(page({ sessionTrackingListId: on.listId }));
    expect(r).toMatchObject({ removed: true, alreadyRemoved: false, listId: on.listId, path: 'app/layout.tsx' });
    expect(files['app/layout.tsx']).toBe(LAYOUT);
    expect(mockDeleteList).not.toHaveBeenCalled();
    expect(lists[on.listId]).toBeDefined();
    expect(mockUpdateState).toHaveBeenCalledWith('p1', { installed: false });
  });
  it('is a no-op when the tag is not there', async () => {
    const r = await disableSessionTrackingForPage(page());
    expect(r).toMatchObject({ removed: false, alreadyRemoved: true });
    expect(mockCommit).not.toHaveBeenCalled();
  });
  it('removes only OUR block and leaves a page\'s own tracker alone', async () => {
    const own = LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    files['app/layout.tsx'] = own;
    expect((await disableSessionTrackingForPage(page())).alreadyRemoved).toBe(true);
    expect(files['app/layout.tsx']).toBe(own);
  });
  it('enable → disable → enable reuses the same list', async () => {
    const a = await enableSessionTrackingForPage(page());
    await disableSessionTrackingForPage(page({ sessionTrackingListId: a.listId }));
    const b = await enableSessionTrackingForPage(page({ sessionTrackingListId: a.listId }));
    expect(b.listId).toBe(a.listId);
    expect(mockCreateList).toHaveBeenCalledTimes(1);
  });
  it('refuses external / not-deployed pages like enable does', async () => {
    await expect(disableSessionTrackingForPage(page({ sourceType: 'external' }))).rejects.toBeInstanceOf(SessionTrackingError);
    expect(mockCommit).not.toHaveBeenCalled();
  });
});

describe('autoEnableSessionTracking (generation hook)', () => {
  it.each([undefined, '', '0', 'false', 'off', 'yes'])('flag %p = OFF: does nothing at all', async (v) => {
    if (v !== undefined) process.env.AUTO_SESSION_TRACKING = v;
    expect(isAutoSessionTrackingEnabled()).toBe(false);
    expect(await autoEnableSessionTracking(page())).toBeNull();
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it.each(['true', '1', ' TRUE '])('flag %p = ON: enables tracking', async (v) => {
    process.env.AUTO_SESSION_TRACKING = v;
    expect(isAutoSessionTrackingEnabled()).toBe(true);
    const r = await autoEnableSessionTracking(page());
    expect(r).toMatchObject({ installed: true });
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  it('NEVER throws when enablement fails: logs, records the error on the page, returns null', async () => {
    process.env.AUTO_SESSION_TRACKING = 'true';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCommit.mockRejectedValue(new Error('github exploded'));
    await expect(autoEnableSessionTracking(page())).resolves.toBeNull();
    expect(mockUpdateState).toHaveBeenCalledWith('p1', expect.objectContaining({ installed: false, error: 'github exploded' }));
    spy.mockRestore();
  });

  it('records a refusal that happened before any list existed, still without throwing', async () => {
    process.env.AUTO_SESSION_TRACKING = 'true';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    files['app/layout.tsx'] = LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    await expect(autoEnableSessionTracking(page())).resolves.toBeNull();
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockUpdateState).toHaveBeenCalledWith('p1', expect.objectContaining({ installed: false, error: expect.stringContaining('already carries its own tracker') }));
    spy.mockRestore();
  });

  it('survives even the failure-recording write failing', async () => {
    process.env.AUTO_SESSION_TRACKING = 'true';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCommit.mockRejectedValue(new Error('boom'));
    mockUpdateState.mockRejectedValue(new Error('ddb down'));
    await expect(autoEnableSessionTracking(page())).resolves.toBeNull();
    spy.mockRestore();
  });

  it('a sub-page inherits a tracked site\'s list with NO repo work', async () => {
    process.env.AUTO_SESSION_TRACKING = 'true';
    const r = await autoEnableSessionTracking(page({ id: 'sub1' }), { sessionTrackingListId: 'list_site_0001', sessionTrackingInstalled: true });
    expect(r).toEqual({ listId: 'list_site_0001', installed: true });
    expect(mockUpdateState).toHaveBeenCalledWith('sub1', { installed: true, listId: 'list_site_0001' });
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('a sub-page of a site that was never tracked does NOT start tracking the whole site', async () => {
    process.env.AUTO_SESSION_TRACKING = 'true';
    expect(await autoEnableSessionTracking(page({ id: 'sub1' }), {})).toBeNull();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockCreateList).not.toHaveBeenCalled();
  });
});

describe('enableSessionTrackingForPage — trackers elsewhere in the repo (DramaBreak shape)', () => {
  const BESPOKE_PAGE = HTML.replace('</head>', '<script>var s = "aw_sess_" + id; var t = session_start_ms;</script></head>');
  const BESPOKE_ROUTE = `export async function POST(req) { await fetch(process.env.BACKEND + '/api/webhooks/forward-lead', { body: JSON.stringify({ source: 'lp-session' }) }) }\n`;
  const expectNothingDone = () => {
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  };

  it('layout WITHOUT a tracker + static page WITH aw_sess_ + bespoke track route => 409 existing_tracker, no list, no commit', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/offer.html': BESPOKE_PAGE, 'app/api/track/route.ts': BESPOKE_ROUTE };
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'existing_tracker', httpStatus: 409 });
    expectNothingDone();
    expect(files['app/layout.tsx']).toBe(LAYOUT);
  });

  it('a static page with the tracker alone is enough to refuse', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/a/b/offer.html': BESPOKE_PAGE };
    const err: any = await enableSessionTrackingForPage(page()).catch((e) => e);
    expect(err.code).toBe('existing_tracker');
    expect(err.message).toContain('public/a/b/offer.html');
    expectNothingDone();
  });

  it('a bespoke track route alone (forward-lead + lp-session) is enough to refuse, wherever it lives under app/api', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/index.html': HTML, 'app/api/v2/collect/route.ts': BESPOKE_ROUTE };
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'existing_tracker' });
    expectNothingDone();
  });

  it('the platform\'s own capture route (forward-lead without lp-session) is not a tracker', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'app/api/capture/route.ts': "fetch('/api/webhooks/forward-lead')" };
    expect((await enableSessionTrackingForPage(page())).installed).toBe(true);
  });

  it('POSITIVE: layout + plain public html without a tracker still installs', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/offer.html': HTML, 'public/robots.txt': 'x' };
    const r = await enableSessionTrackingForPage(page());
    expect(r).toMatchObject({ installed: true, listCreated: true, path: 'app/layout.tsx' });
    expect(files['public/offer.html']).toBe(HTML); // other files untouched
    expect(mockCommit.mock.calls[0][2].map((f: any) => f.path)).toEqual(['app/layout.tsx']);
  });

  it('an explicit override installs despite a tracker elsewhere', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/offer.html': BESPOKE_PAGE };
    expect((await enableSessionTrackingForPage(page(), { overrideExistingTracker: true })).installed).toBe(true);
  });

  it('a truncated tree is refused conservatively (repo_too_large), nothing created', async () => {
    treeTruncated = true;
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'repo_too_large' });
    expectNothingDone();
  });

  it('more than 20 static pages (or routes) is refused conservatively (too_many_files)', async () => {
    files = { 'app/layout.tsx': LAYOUT };
    for (let i = 0; i < 21; i++) files[`public/p${i}.html`] = HTML;
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'too_many_files' });
    expectNothingDone();
    files = { 'app/layout.tsx': LAYOUT };
    for (let i = 0; i < 21; i++) files[`app/api/r${i}/route.ts`] = 'export {}';
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'too_many_files' });
  });

  it('exactly 20 clean pages is fine', async () => {
    files = { 'app/layout.tsx': LAYOUT };
    for (let i = 0; i < 20; i++) files[`public/p${i}.html`] = HTML;
    expect((await enableSessionTrackingForPage(page())).installed).toBe(true);
  });

  it('a file too big to read is refused, not skipped', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/huge.html': 'x'.repeat(900_001) };
    await expect(enableSessionTrackingForPage(page())).rejects.toMatchObject({ code: 'too_large' });
    expectNothingDone();
  });

  it('an idempotent re-run on an already-tagged page does not re-scan the repo (and never regresses to a refusal)', async () => {
    const first = await enableSessionTrackingForPage(page());
    files['public/late.html'] = BESPOKE_PAGE; // a tracker appears later; our tag is already installed
    githubUrls = [];
    const again = await enableSessionTrackingForPage(page({ sessionTrackingListId: first.listId }));
    expect(again.alreadyInstalled).toBe(true);
    expect(githubUrls.some((u) => u.includes('/git/trees/'))).toBe(false);
  });

  it('reads only inside the page\'s own repo, at the head sha it probed', async () => {
    files = { 'app/layout.tsx': LAYOUT, 'public/offer.html': HTML };
    await enableSessionTrackingForPage(page());
    const tree = githubUrls.find((u) => u.includes('/git/trees/'))!;
    expect(tree).toBe('https://api.github.com/repos/AgentWebPro/lp-spring-1234abcd/git/trees/sha0?recursive=1');
  });
});
