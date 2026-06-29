import {
  findPostByTitle,
  addVoter,
  createPost,
  listOpenPosts,
  addComment,
  getDefaultBoardId,
  _resetBoardCache,
} from '../services/featurebaseService';

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'sk_test', appId: 'app123' })),
}));

function jsonRes(body: any, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as any);
}

/** Route a fetch mock by path: /boards -> boards, everything else -> `other`. */
function routed(boards: any, other: any) {
  return jest.fn((url: any) => (String(url).includes('/boards') ? jsonRes(boards) : jsonRes(other)));
}

describe('featurebaseService', () => {
  beforeEach(() => { _resetBoardCache(); });
  afterEach(() => jest.clearAllMocks());

  describe('getDefaultBoardId', () => {
    it('resolves + caches the board id (one /boards fetch)', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes([{ id: 'b1', name: 'Feature Request' }]));
      const a = await getDefaultBoardId();
      const b = await getDefaultBoardId();
      expect(a).toBe('b1');
      expect(b).toBe('b1');
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    });
  });

  describe('createPost', () => {
    it('creates a post with integrations.linear:true + author, returns id + url', async () => {
      (global.fetch as any) = routed([{ id: 'board1', name: 'Feature Request' }], { id: 'post1', postUrl: 'https://fb/p/x' });
      const r = await createPost({ title: 't', description: 'd', authorEmail: 'u@e.com', authorName: 'U' });
      expect(r).toEqual({ id: 'post1', url: 'https://fb/p/x' });
      const postCall = (global.fetch as jest.Mock).mock.calls.find((c) => String(c[0]).endsWith('/posts'));
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        title: 't',
        content: 'd',
        boardId: 'board1',
        author: { email: 'u@e.com', name: 'U' },
        integrations: { linear: true },
      });
    });

    it('throws when the API does not return a post id', async () => {
      (global.fetch as any) = routed([{ id: 'b1' }], { nope: true });
      await expect(createPost({ title: 't', description: 'd', authorEmail: 'u@e.com' })).rejects.toThrow(/did not return a post id/);
    });
  });

  describe('listOpenPosts', () => {
    it('lists open posts and excludes completed/canceled', async () => {
      (global.fetch as any) = routed([{ id: 'b1', name: 'X' }], {
        data: [
          { id: 'p1', title: 'Open one', content: 'desc1', postUrl: 'u1', postStatus: { type: 'active' } },
          { id: 'p2', title: 'Done one', content: 'd2', postUrl: 'u2', postStatus: { type: 'completed' } },
          { id: 'p3', title: 'Rejected one', content: 'd3', postUrl: 'u3', postStatus: { type: 'canceled' } },
        ],
      });
      const posts = await listOpenPosts(10);
      expect(posts).toEqual([{ id: 'p1', title: 'Open one', description: 'desc1', url: 'u1' }]);
    });
  });

  describe('addComment', () => {
    it('POSTs a private (eng-only) comment by default', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ id: 'c1' }));
      await addComment('post1', 'internal note');
      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
      expect(String(url)).toContain('/comments');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ postId: 'post1', content: 'internal note', isPrivate: true });
    });

    it('can post a public comment when isPrivate=false', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ id: 'c2' }));
      await addComment('post1', 'public', false);
      expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).isPrivate).toBe(false);
    });
  });

  describe('findPostByTitle', () => {
    it('prefers an exact (case-insensitive) title match', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ data: [
        { id: 'p1', title: 'Dark mode-ish', postUrl: 'u1' },
        { id: 'p2', title: 'Add Dark Mode', postUrl: 'u2' },
      ] }));
      const post = await findPostByTitle('add dark mode');
      expect(post).toEqual({ id: 'p2', title: 'Add Dark Mode', url: 'u2' });
    });

    it('returns null when there are no posts', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ data: [] }));
      expect(await findPostByTitle('x')).toBeNull();
    });

    it('uses Bearer auth + the version header', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ data: [] }));
      await findPostByTitle('x');
      const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer sk_test');
      expect(headers['Featurebase-Version']).toBe('2026-01-01.nova');
    });
  });

  describe('addVoter', () => {
    it('POSTs the voter (email + name) to the post voters endpoint', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ ok: true }));
      await addVoter('post123', 'u@e.com', 'U');
      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
      expect(String(url)).toContain('/posts/post123/voters');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ email: 'u@e.com', name: 'U' });
    });

    it('throws on a non-OK response', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ message: 'bad' }, false, 400));
      await expect(addVoter('p', 'u@e.com')).rejects.toThrow(/Featurebase API error 400/);
    });
  });
});
