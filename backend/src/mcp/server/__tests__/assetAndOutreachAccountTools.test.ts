/**
 * ENG-2840 (W2-10): the MCP tools `search_user_assets` and `inspect_linkedin_account` (assetAndOutreachAccountTools.ts). What each sends
 * to its route, what is refused before anything is called (arguments by name and by value), the fixed-field answers and the 60 KB cap,
 * error handling, and the per-caller guards. No network: the self-call is a double; the routes have their own tests
 * (src/__tests__/emmaAssetRoutes.test.ts, src/__tests__/tasks.assetWarmOption.test.ts).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry, withToolAnnotations } from '../registry';
import { GUARDS, MAX_ANSWER_BYTES, TIMEOUTS_MS } from '../assetAndOutreachAccountTools';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true, authMethod: 'api_key' });
const call = (name: string, args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(name) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const answerBytes = (r: any) => Buffer.byteLength(r.content[0].text, 'utf8');
const ch = (code: number) => String.fromCharCode(code);
const TOOLS = ['search_user_assets', 'inspect_linkedin_account'] as const;

const asset = (i: number, over: Record<string, unknown> = {}) => ({
  url: `https://bucket.s3.amazonaws.com/u/${i}.png`, filename: `${i}.png`, asset_type: 'image', generated_at: '2026-11-01T00:00:00Z',
  session_title: 'Launch', is_favorited: false, ...over,
});

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(GUARDS).forEach((g) => g.reset());
});

describe('registration', () => {
  it('registers both tools under Emma\'s names, read-only, for user accounts; revoke is not exposed', () => {
    for (const name of TOOLS) {
      const tool = mcpToolRegistry.getTool(name) as any;
      expect(tool).toBeDefined();
      expect(tool.readOnly).toBe(true);
      expect(tool.requiresUserAccount).toBe(true);
      expect(tool.internal).toBeUndefined();
      expect(withToolAnnotations(tool).annotations.readOnlyHint).toBe(true);
      expect(tool.definition.description).toMatch(/Any other argument is refused by name/);
      expect(tool.definition.description).toMatch(/Read-only: nothing is/);
    }
    expect(mcpToolRegistry.getTool('revoke_linkedin_account')).toBeUndefined();
    const search = (mcpToolRegistry.getTool('search_user_assets') as any).definition;
    expect(search.description).toMatch(/The URLs are public links: anyone holding one can open the file/);
    expect(Object.keys(search.inputSchema.properties)).toEqual(['type', 'query', 'favorites_only', 'approved_only', 'limit']);
    expect(search.inputSchema.properties.type.enum).toEqual(['images', 'videos', 'htmlReports', 'all']);
    expect(Object.keys((mcpToolRegistry.getTool('inspect_linkedin_account') as any).definition.inputSchema.properties)).toEqual(['account_id']);
  });
});

describe('refusals before any call', () => {
  it('refuses unknown arguments by name on both tools (identity never comes from an argument)', async () => {
    for (const name of TOOLS) {
      for (const extra of [{ user_id: 'victim' }, { userId: 'victim' }, { session_id: 's' }, { confirm: true }]) {
        await expect(call(name, extra)).rejects.toThrow(new RegExp(`^${name}: "${Object.keys(extra)[0]}" is not an input`));
      }
      await expect(call(name, 'x')).rejects.toThrow(/must be an object/);
      await expect(call(name, [1])).rejects.toThrow(/must be an object/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('search_user_assets: type enum, query at most 100 characters without control or invisible characters, booleans, limit 1..100', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: 'image' }, /type must be one of images, videos, htmlReports, all/],
      [{ type: 'Images' }, /type must be one of/],
      [{ type: ['images'] }, /type must be one of/],
      [{ query: 'q'.repeat(101) }, /query must be text of at most 100 characters, without control or invisible characters/],
      [{ query: 7 }, /query must be text/],
      [{ query: `x${ch(0)}` }, /query must be text/],
      [{ query: `x${ch(9)}y` }, /query must be text/],
      [{ query: `x${ch(0x7f)}` }, /query must be text/],
      [{ query: `x${ch(0x85)}` }, /query must be text/],
      [{ query: `x${ch(0x200d)}y` }, /query must be text/],
      [{ query: `x${ch(0x2028)}y` }, /query must be text/],
      [{ query: `x${ch(0x2066)}y` }, /query must be text/],
      [{ query: `x${ch(0xfeff)}` }, /query must be text/],
      [{ favorites_only: 'yes' }, /favorites_only must be true or false/],
      [{ approved_only: 0 }, /approved_only must be true or false/],
      [{ limit: 0 }, /limit must be a whole number from 1 to 100/],
      [{ limit: 101 }, /limit must be a whole number from 1 to 100/],
      [{ limit: -5 }, /limit must be/],
      [{ limit: 1.5 }, /limit must be/],
      [{ limit: '50' }, /limit must be/],
      [{ limit: NaN }, /limit must be/],
      [{ limit: Infinity }, /limit must be/],
    ];
    for (const [args, re] of cases) {
      await expect(call('search_user_assets', args)).rejects.toThrow(new RegExp(`^search_user_assets: ${re.source}.*Nothing was changed\\.$`));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('inspect_linkedin_account: account_id 1 to 64 of letters, digits, - and _, and the refusal never repeats it', async () => {
    const bad: unknown[] = ['', 'a'.repeat(65), 'acc/1', '../acc', 'acc 1', 'acc.1', 'acc:1', `acc${ch(0)}`, `acc${ch(0x200b)}`, `${ch(0x430)}cc`, 'evil<script>', 42, true, ['acc'], { id: 'acc' }];
    for (const account_id of bad) {
      const err = await call('inspect_linkedin_account', { account_id }).catch((e: Error) => e);
      expect(err.message).toMatch(/^inspect_linkedin_account: account_id must be the id of one of your LinkedIn Outreach accounts/);
      if (typeof account_id === 'string' && account_id.length > 0) expect(err.message).not.toContain(account_id);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a refused argument does not use up a call', async () => {
    for (let i = 0; i < 40; i++) await expect(call('search_user_assets', { limit: 0 }, 'u9')).rejects.toThrow(/limit/);
    expect(GUARDS.search_user_assets.recent.get('u9')).toBeUndefined();
  });
});

describe('what is sent', () => {
  it('each tool POSTs only checked values to its own route, with its timeout and the caller\'s own context', async () => {
    mockFetch.mockResolvedValue({ success: true, assets: [], accounts: [] });
    await call('search_user_assets', { type: 'videos', query: '  launch  ', favorites_only: true, approved_only: false, limit: 20 });
    await call('search_user_assets', {});
    await call('search_user_assets', { query: '   ', type: null, limit: null });
    await call('inspect_linkedin_account', {});
    await call('inspect_linkedin_account', { account_id: 'acc_1-X' });
    await call('inspect_linkedin_account', { account_id: null });
    const sent = mockFetch.mock.calls.map((c) => c[0]);
    expect(sent.map((r) => [r.method, r.path, r.timeoutMs])).toEqual([
      ['POST', '/api/emma/user-assets', TIMEOUTS_MS.search_user_assets],
      ['POST', '/api/emma/user-assets', TIMEOUTS_MS.search_user_assets],
      ['POST', '/api/emma/user-assets', TIMEOUTS_MS.search_user_assets],
      ['POST', '/api/emma/linkedin-outreach-account', TIMEOUTS_MS.inspect_linkedin_account],
      ['POST', '/api/emma/linkedin-outreach-account', TIMEOUTS_MS.inspect_linkedin_account],
      ['POST', '/api/emma/linkedin-outreach-account', TIMEOUTS_MS.inspect_linkedin_account],
    ]);
    expect(sent.map((r) => r.body)).toStrictEqual([
      { type: 'videos', query: 'launch', favorites_only: true, approved_only: false, limit: 20 },
      { limit: 50 },
      { limit: 50 },
      {},
      { account_id: 'acc_1-X' },
      {},
    ]);
    for (const r of sent) {
      expect(r.context.userId).toBe('user-1');
      expect(r.context).not.toHaveProperty('apiKeyId');
      expect(JSON.stringify(r.body)).not.toMatch(/user/i);
    }
  });
});

describe('answers: fixed fields only', () => {
  it('search_user_assets answers url, filename, asset_type, generated_at, session_title, is_favorited, approval_status; nothing else', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true, total: 3, count: 3, status: 200,
      assets: [
        asset(1, { approval_status: 'approved', is_favorited: true, sessionId: 'sess-secret', session_id: 'sess-secret', searchableText: 'secret text', token: 'tok' }),
        asset(2, { url: 'javascript:alert(1)' }),
        asset(3, { asset_type: 'pdf' }),
        asset(4, { is_favorited: 'yes', generated_at: 12 }),
      ],
    });
    const a = parse(await call('search_user_assets', {}));
    expect(a).toStrictEqual({
      total: 3, count: 2,
      assets: [
        { url: 'https://bucket.s3.amazonaws.com/u/1.png', filename: '1.png', asset_type: 'image', generated_at: '2026-11-01T00:00:00Z', session_title: 'Launch', is_favorited: true, approval_status: 'approved' },
        { url: 'https://bucket.s3.amazonaws.com/u/4.png', filename: '4.png', asset_type: 'image', generated_at: '12', session_title: 'Launch', is_favorited: false },
      ],
    });
    expect(JSON.stringify(a)).not.toMatch(/sess-secret|secret text|tok|javascript|status":200/);
  });

  it('search_user_assets: never more than the limit sent, whatever the route answers; no matches is an empty list', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, total: 10, assets: Array.from({ length: 10 }, (_, i) => asset(i)) });
    const a = parse(await call('search_user_assets', { limit: 4 }));
    expect(a).toMatchObject({ total: 10, count: 4 });
    expect(a.assets).toHaveLength(4);
    mockFetch.mockResolvedValueOnce({ success: true, total: 0, count: 0, assets: [] });
    expect(parse(await call('search_user_assets', {}))).toStrictEqual({ total: 0, count: 0, assets: [] });
  });

  it('inspect_linkedin_account answers fixed account and queued-action fields only; the id appears only when it was asked for', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true,
      accounts: [{ account_id: 'acc_1', name: 'Jane', shared_with_org: true, connected_at: '2026-10-01T00:00:00Z', access_token: 'tok-secret', provider_id: 'p' }],
    });
    expect(parse(await call('inspect_linkedin_account', {}))).toStrictEqual({
      accounts_count: 1,
      accounts: [{ account_id: 'acc_1', name: 'Jane', shared_with_org: true, connected_at: '2026-10-01T00:00:00Z' }],
    });
    mockFetch.mockResolvedValueOnce({
      success: true, account_id: 'someone_else',
      accounts: [{ account_id: 'acc_1', name: 'Jane', shared_with_org: false }],
      queued_actions: [{ schedule_id: 's1', action_type: 'comment', target_type: 'post', post_id: 'urn:li:activity:1', next_run_time: '2026-11-28T00:00:00Z', role: 'owner+engager', comment: 'secret text' }],
    });
    const b = parse(await call('inspect_linkedin_account', { account_id: 'acc_1' }));
    expect(b).toStrictEqual({
      accounts_count: 1,
      accounts: [{ account_id: 'acc_1', name: 'Jane', shared_with_org: false }],
      account_id: 'acc_1',
      queued_actions_total: 1,
      queued_actions: [{ schedule_id: 's1', action_type: 'comment', target_type: 'post', post_id: 'urn:li:activity:1', next_run_time: '2026-11-28T00:00:00Z', role: 'owner+engager' }],
    });
    expect(JSON.stringify(b)).not.toMatch(/someone_else|secret text|tok-secret/);
  });

  it('inspect_linkedin_account: the route\'s fixed "not your account" refusal is an error', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'No LinkedIn Outreach account with that id is connected to your account. Call inspect_linkedin_account without account_id to list yours' });
    await expect(call('inspect_linkedin_account', { account_id: 'other_acc' })).rejects.toThrow(
      'inspect_linkedin_account: No LinkedIn Outreach account with that id is connected to your account. Call inspect_linkedin_account without account_id to list yours.',
    );
  });
});

describe('size cap', () => {
  it('search_user_assets: 100 assets with long URLs are cut to about 60 KB as sent, with truncated and a note; total kept', async () => {
    const assets = Array.from({ length: 100 }, (_, i) => asset(i, { url: `https://bucket.s3.amazonaws.com/u/${i}-${'p'.repeat(1900)}.png`, filename: 'f'.repeat(290), session_title: 't'.repeat(290) }));
    mockFetch.mockResolvedValueOnce({ success: true, total: 140, assets });
    const r = await call('search_user_assets', { limit: 100 });
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ total: 140, truncated: true });
    expect(a.truncated_note).toMatch(/narrow type or query/);
    expect(a.count).toBe(a.assets.length);
    expect(a.count).toBeGreaterThan(10);
    expect(a.count).toBeLessThan(100);
    expect(a.assets[0].url).toMatch(/\/u\/0-/);
  });

  it('one asset as large as the fields allow, written with 6-byte escapes, still fits (an answer with items is never empty)', async () => {
    const escaped = ch(1).repeat(400);
    mockFetch.mockResolvedValueOnce({ success: true, total: 2, assets: [asset(0, { url: `https://b.s3.amazonaws.com/${'\\'.repeat(2000)}`, filename: escaped, session_title: escaped, generated_at: escaped, approval_status: escaped }), asset(1)] });
    const r = await call('search_user_assets', {});
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    expect(parse(r).count).toBe(2);
  });

  it('inspect_linkedin_account: thousands of queued actions are cut to about 60 KB with truncated; queued_actions_total kept', async () => {
    const queued = Array.from({ length: 3000 }, (_, i) => ({ schedule_id: `sch-${i}`, action_type: 'comment', target_type: 'post', post_id: `urn:li:activity:${i}`, next_run_time: '2026-11-28T00:00:00Z' }));
    mockFetch.mockResolvedValueOnce({ success: true, accounts: [{ account_id: 'acc_1', name: 'Jane' }], queued_actions: queued });
    const r = await call('inspect_linkedin_account', { account_id: 'acc_1' });
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ accounts_count: 1, account_id: 'acc_1', queued_actions_total: 3000, truncated: true });
    expect(a.queued_actions.length).toBeGreaterThan(100);
    expect(a.queued_actions.length).toBeLessThan(3000);
  });
});

describe('errors', () => {
  it('a refusal (success: false) carries only the route\'s short message; no answer is a fixed text', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Nope.', stack: 'at x' });
    await expect(call('search_user_assets', {})).rejects.toThrow(/^search_user_assets: Nope\.$/);
    mockFetch.mockResolvedValueOnce(undefined);
    await expect(call('inspect_linkedin_account', {})).rejects.toThrow('inspect_linkedin_account: the service gave no answer.');
  });

  it('a 4xx passes through as it is (quota, a refused body, a sandbox refusal)', async () => {
    for (const message of ['API error (429): Monthly token quota reached', 'API error (400): limit must be a whole number from 1 to 100', 'API error (403): This tool is not available in this sandbox workspace']) {
      mockFetch.mockRejectedValueOnce(new Error(message));
      await expect(call('search_user_assets', {})).rejects.toThrow(message);
    }
  });

  it('a 5xx or an unreachable route is a fixed text that never carries the internal detail', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (500): Your assets could not be read at /var/app/current'));
    const e1 = await call('search_user_assets', {}).catch((e: Error) => e);
    expect(e1.message).toBe('search_user_assets: the service could not answer (HTTP 500). Try again later. Nothing was changed.');
    mockFetch.mockRejectedValueOnce(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3001'));
    const e2 = await call('inspect_linkedin_account', {}).catch((e: Error) => e);
    expect(e2.message).toBe('inspect_linkedin_account: the service could not be reached or did not answer in time. Try again later. Nothing was changed.');
  });
});

describe('guards', () => {
  it('caps: search_user_assets 2 at a time / 30 an hour, inspect_linkedin_account 4 / 120', () => {
    expect([GUARDS.search_user_assets.processMax, GUARDS.search_user_assets.perHour]).toEqual([2, 30]);
    expect([GUARDS.inspect_linkedin_account.processMax, GUARDS.inspect_linkedin_account.perHour]).toEqual([4, 120]);
  });

  it('one call at a time per caller, a process cap of 2 across callers, and the slot is freed after a failure', async () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = call('search_user_assets', {}, 'u1');
    await expect(call('search_user_assets', {}, 'u1')).rejects.toThrow(/another call of yours to this tool is still running/);
    // the other tool is its own guard
    mockFetch.mockResolvedValueOnce({ success: true, accounts: [] });
    await expect(call('inspect_linkedin_account', {}, 'u1')).resolves.toBeDefined();
    let release2!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release2 = resolve; }));
    const second = call('search_user_assets', {}, 'u2');
    await expect(call('search_user_assets', {}, 'u3')).rejects.toThrow(/this tool is busy/);
    release({ success: true, assets: [] });
    release2({ success: true, assets: [] });
    await Promise.all([first, second]);
    expect(GUARDS.search_user_assets.inFlight).toBe(0);
    mockFetch.mockRejectedValueOnce(new Error('API error (502): bad gateway'));
    await expect(call('search_user_assets', {}, 'u1')).rejects.toThrow(/HTTP 502/);
    expect(GUARDS.search_user_assets.callers.has('u1')).toBe(false);
  });

  it('inspect_linkedin_account allows 4 callers at once and refuses a fifth', async () => {
    const pending: Array<(v: unknown) => void> = [];
    mockFetch.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const running = ['a', 'b', 'c', 'd'].map((u) => call('inspect_linkedin_account', {}, u));
    await expect(call('inspect_linkedin_account', {}, 'e')).rejects.toThrow(/this tool is busy/);
    pending.forEach((r) => r({ success: true, accounts: [] }));
    await Promise.all(running);
  });

  it('an hourly cap per caller: the next call is refused before anything is called; another caller is not affected', async () => {
    mockFetch.mockResolvedValue({ success: true, assets: [] });
    for (let i = 0; i < 30; i++) await call('search_user_assets', {}, 'heavy');
    await expect(call('search_user_assets', {}, 'heavy')).rejects.toThrow(/you have made 30 calls to this tool in the last hour/);
    expect(mockFetch).toHaveBeenCalledTimes(30);
    await expect(call('search_user_assets', {}, 'light')).resolves.toBeDefined();
    mockFetch.mockResolvedValue({ success: true, accounts: [] });
    for (let i = 0; i < 120; i++) await call('inspect_linkedin_account', {}, 'heavy');
    await expect(call('inspect_linkedin_account', {}, 'heavy')).rejects.toThrow(/you have made 120 calls/);
  });
});
