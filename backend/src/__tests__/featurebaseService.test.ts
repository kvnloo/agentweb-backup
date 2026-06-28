import { createFeaturebasePost, _resetFeaturebaseBoardCache } from '../services/featurebaseService';

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'sk_test', appId: 'app123' })),
}));

const BOARDS = [
  { id: 'board_feat', name: 'Feature Request' },
  { id: 'board_bug', name: 'Bugs' },
];

function jsonRes(body: any, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as any);
}

/** Route a mocked fetch by URL + method. Order: boards, voters, search (/posts?), create (/posts). */
function routeFetch(handlers: {
  search?: any[];
  onCreate?: () => any;
  onVote?: () => any;
  createNotOk?: { status: number; message: string };
  searchThrows?: boolean;
}) {
  return (url: string, opts: any = {}) => {
    const u = String(url);
    if (u.endsWith('/boards')) return jsonRes(BOARDS);
    if (u.includes('/voters')) return handlers.onVote ? handlers.onVote() : jsonRes({ ok: true });
    if (u.includes('/posts?')) {
      if (handlers.searchThrows) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ message: 'boom' }) } as any);
      return jsonRes({ data: handlers.search || [] });
    }
    if (u.endsWith('/posts') && opts.method === 'POST') {
      if (handlers.createNotOk) return Promise.resolve({ ok: false, status: handlers.createNotOk.status, json: () => Promise.resolve({ message: handlers.createNotOk!.message }) } as any);
      return handlers.onCreate ? handlers.onCreate() : jsonRes({ id: 'post_new', postUrl: 'https://agentweb.featurebase.app/p/new' });
    }
    return jsonRes({}, false, 404);
  };
}

describe('featurebaseService.createFeaturebasePost', () => {
  const realEnv = process.env.NODE_ENV;
  beforeEach(() => {
    _resetFeaturebaseBoardCache();
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = realEnv;
    jest.clearAllMocks();
  });

  it('creates a PUBLIC feature-request post on the Feature Request board, attributed to the user', async () => {
    (global.fetch as any) = jest.fn(routeFetch({ search: [] }));
    const r = await createFeaturebasePost({ type: 'feature_request', title: 'Disney character', description: 'add one', userEmail: 'u@e.com', userName: 'U' });
    expect(r).toEqual({ id: 'post_new', url: 'https://agentweb.featurebase.app/p/new', deduped: false });
    const createCall = (global.fetch as jest.Mock).mock.calls.find(c => String(c[0]).endsWith('/posts') && c[1]?.method === 'POST');
    const body = JSON.parse(createCall![1].body);
    expect(body.author.email).toBe('u@e.com');
    expect(body.visibility).toBe('public');
    expect(body.boardId).toBe('board_feat');
  });

  it('UPVOTES an existing near-duplicate instead of creating a new post (dedup -> vote)', async () => {
    (global.fetch as any) = jest.fn(routeFetch({ search: [{ id: 'post_existing', title: 'Disney character feature', postUrl: 'https://x/p/e' }] }));
    const r = await createFeaturebasePost({ type: 'feature_request', title: 'Disney character', description: 'd', userEmail: 'u@e.com' });
    expect(r.deduped).toBe(true);
    expect(r.id).toBe('post_existing');
    const voteCall = (global.fetch as jest.Mock).mock.calls.find(c => String(c[0]).includes('/voters'));
    expect(JSON.parse(voteCall![1].body).email).toBe('u@e.com');
    const didCreate = (global.fetch as jest.Mock).mock.calls.some(c => String(c[0]).endsWith('/posts') && c[1]?.method === 'POST');
    expect(didCreate).toBe(false);
  });

  it('files a BUG as author-only on the Bugs board', async () => {
    (global.fetch as any) = jest.fn(routeFetch({ search: [], onCreate: () => jsonRes({ id: 'bug_1', postUrl: 'https://x/p/bug' }) }));
    await createFeaturebasePost({ type: 'bug', title: 'crash on save', description: 'd', userEmail: 'u@e.com' });
    const createCall = (global.fetch as jest.Mock).mock.calls.find(c => String(c[0]).endsWith('/posts') && c[1]?.method === 'POST');
    const body = JSON.parse(createCall![1].body);
    expect(body.visibility).toBe('authorOnly');
    expect(body.boardId).toBe('board_bug');
  });

  it('still files when the dedup search fails (best-effort dedup never blocks the filing)', async () => {
    (global.fetch as any) = jest.fn(routeFetch({ searchThrows: true, onCreate: () => jsonRes({ id: 'post_fallback', postUrl: 'u' }) }));
    const r = await createFeaturebasePost({ type: 'feature_request', title: 't', description: 'd', userEmail: 'u@e.com' });
    expect(r.id).toBe('post_fallback');
    expect(r.deduped).toBe(false);
  });

  it('throws when the create call returns a non-OK response', async () => {
    (global.fetch as any) = jest.fn(routeFetch({ search: [], createNotOk: { status: 400, message: 'bad' } }));
    await expect(
      createFeaturebasePost({ type: 'feature_request', title: 't', description: 'd', userEmail: 'u@e.com', dedupe: false }),
    ).rejects.toThrow(/Featurebase API error 400/);
  });
});
