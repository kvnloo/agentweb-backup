import { findPostByTitle, addVoter } from '../services/featurebaseService';

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'sk_test', appId: 'app123' })),
}));

function jsonRes(body: any, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as any);
}

describe('featurebaseService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('findPostByTitle', () => {
    it('prefers an exact (case-insensitive) title match', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ data: [
        { id: 'p1', title: 'Dark mode-ish', postUrl: 'u1' },
        { id: 'p2', title: 'Add Dark Mode', postUrl: 'u2' },
      ] }));
      const post = await findPostByTitle('add dark mode');
      expect(post).toEqual({ id: 'p2', title: 'Add Dark Mode', url: 'u2' });
    });

    it('falls back to the first result when no exact match', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ data: [{ id: 'p9', title: 'Closest', postUrl: 'u9' }] }));
      const post = await findPostByTitle('something else');
      expect(post?.id).toBe('p9');
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
