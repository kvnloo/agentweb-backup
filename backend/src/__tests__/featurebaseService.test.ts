import {
  addVoter,
  createPost,
  listOpenPosts,
  addComment,
  getDefaultBoardId,
  _resetBoardCache,
  getCustomerTicketCategoryId,
  createTicket,
  patchTicketStatus,
  getTicketStatusId,
  replyToTicket,
  _resetTicketCategoryCache,
  _resetTicketStatusCache,
  _resetAdminCache,
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
  beforeEach(() => { _resetBoardCache(); _resetTicketCategoryCache(); _resetTicketStatusCache(); _resetAdminCache(); });
  afterEach(() => jest.clearAllMocks());

  describe('getTicketStatusId', () => {
    it('resolves a status by name + caches the lookup (one fetch)', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes([
        { id: 's-rev', name: 'In Review', type: 'reviewing' },
        { id: 's-done', name: 'Completed', type: 'completed' },
      ]));
      const a = await getTicketStatusId('Completed');
      const b = await getTicketStatusId('In Review');
      expect(a).toBe('s-done');
      expect(b).toBe('s-rev');
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    });

    it('throws when the status name is unknown', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes([{ id: 's1', name: 'In Review' }]));
      await expect(getTicketStatusId('Nope')).rejects.toThrow(/no ticket status named/);
    });
  });

  describe('replyToTicket', () => {
    it('resolves an admin id then POSTs an admin reply (type/adminId/body) that notifies the reporter', async () => {
      (global.fetch as any) = jest.fn((url: any) =>
        String(url).includes('/admins') ? jsonRes({ data: [{ id: 'admin-1', name: 'Harsha' }] }) : jsonRes({ id: 'r1' }));
      await replyToTicket(12, 'resolved!');
      const replyCall = (global.fetch as jest.Mock).mock.calls.find((c) => String(c[0]).includes('/reply'));
      expect(String(replyCall[0])).toContain('/tickets/12/reply');
      expect(JSON.parse(replyCall[1].body)).toEqual({ type: 'admin', adminId: 'admin-1', body: 'resolved!' });
    });
  });

  describe('getCustomerTicketCategoryId', () => {
    it('matches the "Bug Report" category by name + caches it (one fetch)', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes([
        { id: 'cat-tracker', name: 'Tracked Issue' },
        { id: 'cat-bug', name: 'Bug Report' },
      ]));
      const a = await getCustomerTicketCategoryId();
      const b = await getCustomerTicketCategoryId();
      expect(a).toBe('cat-bug');
      expect(b).toBe('cat-bug');
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    });
  });

  describe('createTicket', () => {
    it('creates a ticket in the customer category authored by the reporter; returns id+number+url', async () => {
      (global.fetch as any) = jest.fn((url: any) =>
        String(url).includes('/tickets/categories')
          ? jsonRes([{ id: 'cat-bug', name: 'Bug Report' }])
          : jsonRes({ id: 'hex1', ticketNumber: 12, ticketUrl: 'https://fb/t/12' }));
      const r = await createTicket({ title: 't', content: 'd', authorEmail: 'u@e.com', authorName: 'U' });
      expect(r).toEqual({ id: 'hex1', number: 12, url: 'https://fb/t/12' });
      const postCall = (global.fetch as jest.Mock).mock.calls.find((c) => String(c[0]).endsWith('/tickets'));
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({ ticketCategoryId: 'cat-bug', title: 't', content: 'd', author: { email: 'u@e.com', name: 'U' } });
    });

    it('throws when the API does not return id+number', async () => {
      (global.fetch as any) = jest.fn((url: any) =>
        String(url).includes('/tickets/categories') ? jsonRes([{ id: 'cat-bug', name: 'Bug Report' }]) : jsonRes({ id: 'hex1' }));
      await expect(createTicket({ title: 't', content: 'd', authorEmail: 'u@e.com' })).rejects.toThrow(/did not return id\+number/);
    });
  });

  describe('patchTicketStatus', () => {
    it('PATCHes the ticket by NUMBER with the statusId', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ ok: true }));
      await patchTicketStatus(12, 'status-done');
      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
      expect(String(url)).toContain('/tickets/12');
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body)).toEqual({ statusId: 'status-done' });
    });
  });

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

  describe('addVoter', () => {
    it('POSTs the voter (email + name) with Bearer auth + version header', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ ok: true }));
      await addVoter('post123', 'u@e.com', 'U');
      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
      expect(String(url)).toContain('/posts/post123/voters');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ email: 'u@e.com', name: 'U' });
      expect(opts.headers.Authorization).toBe('Bearer sk_test');
      expect(opts.headers['Featurebase-Version']).toBe('2026-01-01.nova');
    });

    it('throws on a non-OK response', async () => {
      (global.fetch as any) = jest.fn(() => jsonRes({ message: 'bad' }, false, 400));
      await expect(addVoter('p', 'u@e.com')).rejects.toThrow(/Featurebase API error 400/);
    });
  });
});
