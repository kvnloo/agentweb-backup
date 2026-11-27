/**
 * ENG-2840 (W2-8): knowledge-base files carry Google Cloud Storage signed links that expire in the year 2500 (bearer links that
 * cannot be revoked). No MCP tool answers one: list_knowledge_bases, emma_get_brand_profile (knowledge_base_files), list_tasks
 * and manage_task (every action). Unit tests for isSignedStorageLink / withoutSignedStorageLinks, then each tool through the
 * registry with mcpFetch mocked.
 */
const mockMcpFetch = jest.fn();
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: (...args: any[]) => mockMcpFetch(...args),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';
import '../mcp/server/workflowTools';
import { isSignedStorageLink, withoutSignedStorageLinks } from '../mcp/server/knowledgeBaseParams';

// A V2 link as @google-cloud/storage getSignedUrl({ action: 'read', expires: '03-01-2500' }) mints it.
const V2 = (bucket: string, path: string) =>
  `https://storage.googleapis.com/${bucket}/${path}?GoogleAccessId=kb-signer%40proj.iam.gserviceaccount.com&Expires=16725225600&Signature=AbC%2Bdef%2F123%3D%3D`;
// V4 form.
const V4 = (bucket: string, path: string) =>
  `https://storage.googleapis.com/${bucket}/${path}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=kb-signer%40proj.iam.gserviceaccount.com%2F20261126%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261126T000000Z&X-Goog-Expires=604800&X-Goog-SignedHeaders=host&X-Goog-Signature=0a1b2c3d4e5f`;
// Virtual-hosted form.
const VHOST = (bucket: string, path: string) =>
  `https://${bucket}.storage.googleapis.com/${path}?GoogleAccessId=x%40y.iam.gserviceaccount.com&Expires=16725225600&Signature=zzz`;

describe('isSignedStorageLink', () => {
  it.each([
    ['V2 path-style', V2('aw-kb', 'tasks/t1/knowledge-base.txt')],
    ['V4 path-style', V4('aw-kb', 'tasks/t1/knowledge-base-files/0_notes.md')],
    ['virtual-hosted', VHOST('aw-kb', 'tasks/t1/a.pdf')],
    ['V4 virtual-hosted', `https://aw-kb.storage.googleapis.com/a.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=ff`],
    ['Signature as the first query param', 'https://storage.googleapis.com/b/o?Signature=abc&Expires=1'],
    ['upper-case host', 'https://STORAGE.GOOGLEAPIS.COM/b/o?GoogleAccessId=a&Expires=1&Signature=s'],
    ['surrounding whitespace', `  ${V2('b', 'o.txt')}\n`],
  ])('true for a GCS signed link (%s)', (_label, url) => {
    expect(isSignedStorageLink(url)).toBe(true);
  });

  it.each([
    ['unsigned GCS path-style', 'https://storage.googleapis.com/aw-kb/tasks/t1/a.pdf'],
    ['unsigned GCS virtual-hosted', 'https://aw-kb.storage.googleapis.com/tasks/t1/a.pdf'],
    ['GCS with unrelated query', 'https://storage.googleapis.com/aw-kb/a.pdf?alt=media&generation=1'],
    ['gs:// URI', 'gs://aw-kb/tasks/t1/a.pdf'],
    [
      'S3 presigned (V4)',
      'https://agentweb-user-files.s3.us-west-2.amazonaws.com/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc',
    ],
    ['S3 presigned (V2, Signature=)', 'https://agentweb-user-files.s3.amazonaws.com/a.png?AWSAccessKeyId=AK&Expires=1&Signature=abc'],
    ['look-alike host', 'https://storage.googleapis.com.evil.com/b/o?Signature=abc'],
    ['look-alike host 2', 'https://evilstorage.googleapis.com.attacker.net/b/o?Signature=abc'],
    ['other host with Signature', 'https://example.com/file?Signature=abc'],
    ['plain text', 'notes.md'],
    ['empty', ''],
  ])('false for %s', (_label, url) => {
    expect(isSignedStorageLink(url)).toBe(false);
  });

  it.each([[undefined], [null], [42], [{ url: V2('b', 'o') }], [[V2('b', 'o')]], [true]])('false for the non-string %p', (v) => {
    expect(isSignedStorageLink(v)).toBe(false);
  });
});

describe('withoutSignedStorageLinks', () => {
  it('removes every key whose value is a signed link, at any depth, and keeps everything else', () => {
    const input = {
      taskId: 't1',
      knowledgeBase: V2('aw-kb', 'tasks/t1/knowledge-base.txt'),
      knowledgeBaseFiles: [
        { filename: 'notes.md', url: V4('aw-kb', 'n.md'), key: 'tasks/t1/knowledge-base-files/0_notes.md', size: 3 },
        { filename: 'deck.pdf', url: VHOST('aw-kb', 'd.pdf'), size: 0 },
      ],
      nested: { a: { b: { c: { d: { link: V2('b', 'deep'), keep: 'yes', n: 0, f: false, z: null } } } } },
      unsigned: 'https://storage.googleapis.com/aw-kb/public.png',
      s3: 'https://agentweb-user-files.s3.amazonaws.com/a.png?AWSAccessKeyId=AK&Expires=1&Signature=abc',
    };

    expect(withoutSignedStorageLinks(input)).toEqual({
      taskId: 't1',
      knowledgeBaseFiles: [
        { filename: 'notes.md', key: 'tasks/t1/knowledge-base-files/0_notes.md', size: 3 },
        { filename: 'deck.pdf', size: 0 },
      ],
      nested: { a: { b: { c: { d: { keep: 'yes', n: 0, f: false, z: null } } } } },
      unsigned: 'https://storage.googleapis.com/aw-kb/public.png',
      s3: 'https://agentweb-user-files.s3.amazonaws.com/a.png?AWSAccessKeyId=AK&Expires=1&Signature=abc',
    });
  });

  it('removes signed-link strings from arrays (top level and nested), keeping other items in order', () => {
    expect(withoutSignedStorageLinks([V2('b', '1'), 'a', V4('b', '2'), 3, null, { links: [VHOST('b', '3'), 'x'] }])).toEqual([
      'a',
      3,
      null,
      { links: ['x'] },
    ]);
  });

  it('does not mutate the input', () => {
    const input = { file: { name: 'a.txt', url: V2('b', 'a.txt') }, list: [V2('b', 'x'), 'y'] };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = withoutSignedStorageLinks(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.file).not.toBe(input.file);
    expect(out.list).not.toBe(input.list);
  });

  it('passes primitives through unchanged', () => {
    expect(withoutSignedStorageLinks(null)).toBeNull();
    expect(withoutSignedStorageLinks(undefined)).toBeUndefined();
    expect(withoutSignedStorageLinks(7)).toBe(7);
    expect(withoutSignedStorageLinks('plain')).toBe('plain');
  });

  it('is cycle-safe: a self-referencing object does not hang or throw', () => {
    const a: any = { name: 'a', url: V2('b', 'a') };
    a.self = a;
    const arr: any[] = ['x'];
    arr.push(arr);
    expect(() => withoutSignedStorageLinks(a)).not.toThrow();
    expect(() => withoutSignedStorageLinks(arr)).not.toThrow();
    const out: any = withoutSignedStorageLinks(a);
    expect(out.name).toBe('a');
    expect(out).not.toHaveProperty('url');
  });

  // A shared or cyclic object maps to one filtered copy: no original (with its link) is ever handed back.
  it('removes the link from an object that appears twice (shared reference, no cycle)', () => {
    const shared = { name: 'shared.pdf', url: V2('b', 'shared.pdf') };
    const out: any = withoutSignedStorageLinks({ first: shared, second: shared });
    expect(JSON.stringify(out)).not.toContain('Signature=');
  });

  it('a cyclic input: the link is gone from the copy everywhere it can be reached', () => {
    const a: any = { name: 'a', url: V2('b', 'a') };
    a.self = a;
    const out: any = withoutSignedStorageLinks(a);
    expect(out.self).not.toHaveProperty('url');
  });

  // Deeper than MAX_DEPTH (40) is dropped, never returned unchecked.
  it('removes a link nested deeper than 40 levels', () => {
    let deep: any = { url: V2('b', 'deep'), name: 'deep.txt' };
    for (let i = 0; i < 45; i += 1) deep = { child: deep };
    expect(JSON.stringify(withoutSignedStorageLinks(deep))).not.toContain('Signature=');
  });
});

// ─── The tools, through the registry ────────────────────────────────────────

const CALLER = { userId: 'user-1', agentUserId: 'user-1', sessionId: 'sess-1' };

async function call(name: string, args: any, context: any = CALLER): Promise<string> {
  const tool = mcpToolRegistry.getTool(name);
  if (!tool) throw new Error(`${name} is not registered`);
  const result: any = await tool.execute(args, context);
  return result.content.map((c: any) => c.text).join('\n');
}

function expectNoSignedLink(text: string) {
  expect(text).not.toContain('storage.googleapis.com');
  expect(text).not.toContain('Signature=');
  expect(text).not.toContain('X-Goog-Signature');
  expect(text).not.toContain('GoogleAccessId');
}

/** A task as GET /api/tasks/:id returns it, carrying the year-2500 links. */
const TASK = () => ({
  taskId: 'task-1',
  name: 'Brand KB',
  userId: 'user-1',
  knowledgeBase: V2('aw-kb', 'tasks/task-1/knowledge-base.txt'),
  knowledgeBaseSize: 120,
  knowledgeBaseFiles: [
    { filename: 'pricing.pdf', key: 'tasks/task-1/knowledge-base-files/0_pricing.pdf', url: V2('aw-kb', 'p.pdf'), size: 10 },
    { filename: 'faq.md', key: 'tasks/task-1/knowledge-base-files/1_faq.md', url: V4('aw-kb', 'f.md'), size: 5 },
  ],
});

/**
 * GET /api/emma/knowledge-bases, in the shape emma/impl/knowledgeBase.ts listKnowledgeBaseFiles builds: own + another tenant's
 * public KB, each file (including the default knowledge-base.txt) with a signed url.
 */
const KB_LIST = () => ({
  success: true,
  knowledgeBases: [
    {
      identifier: 'kb-own',
      name: 'Own KB',
      type: 'private',
      updatedAt: '2026-11-20T00:00:00Z',
      files: [
        { fileName: 'knowledge-base.txt', fileSize: 1, url: V2('aw-kb', 'tasks/kb-own/knowledge-base.txt') },
        { fileName: 'roadmap.docx', fileSize: 2, url: VHOST('aw-kb', 'tasks/kb-own/r.docx') },
        { fileName: 'never-uploaded.txt', fileSize: 0, url: null },
      ],
    },
    {
      identifier: 'kb-public-other-tenant',
      name: 'Someone else public KB',
      type: 'public',
      updatedAt: '2026-11-21T00:00:00Z',
      files: [{ fileName: 'their-secret.pdf', fileSize: 3, url: V4('aw-kb', 'tasks/kb-public-other-tenant/s.pdf') }],
    },
  ],
  googleDriveFiles: [{ id: 'drive-1', name: 'Drive doc', webViewLink: 'https://docs.google.com/document/d/abc' }],
});

beforeEach(() => {
  mockMcpFetch.mockReset();
});

describe('list_knowledge_bases never answers a signed link', () => {
  it('drops every file url, keeps names, ids and other links', async () => {
    mockMcpFetch.mockResolvedValueOnce(KB_LIST());

    const text = await call('list_knowledge_bases', {});

    expectNoSignedLink(text);
    for (const kept of ['kb-own', 'kb-public-other-tenant', 'knowledge-base.txt', 'roadmap.docx', 'their-secret.pdf', 'drive-1', 'Drive doc']) {
      expect(text).toContain(kept);
    }
    expect(text).toContain('https://docs.google.com/document/d/abc');
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/emma/knowledge-bases' }));
  });

  it('with kb_type and paging args too', async () => {
    mockMcpFetch.mockResolvedValueOnce(KB_LIST());
    const text = await call('list_knowledge_bases', { kb_type: 'private', limit: 10 });
    expectNoSignedLink(text);
    expect(text).toContain('roadmap.docx');
  });
});

describe('emma_get_brand_profile: the knowledge_base_files section carries no signed link', () => {
  it('drops the links, keeps the file names and the other sections', async () => {
    mockMcpFetch.mockImplementation(async ({ path }: any) => {
      if (path === '/api/brand/guidelines') return { brandData: { brandName: 'Acme', tone: 'friendly' } };
      if (path === '/api/market-strategy') return { data: { targetAudience: 'SMBs' } };
      if (path === '/api/emma/knowledge-bases') return KB_LIST();
      throw new Error(`unexpected ${path}`);
    });

    const text = await call('emma_get_brand_profile', {});
    const body = JSON.parse(text);

    expectNoSignedLink(text);
    expect(JSON.stringify(body.knowledge_base_files)).toContain('roadmap.docx');
    expect(JSON.stringify(body.knowledge_base_files)).toContain('kb-own');
    expect(JSON.stringify(body.knowledge_base_files)).toContain('their-secret.pdf');
    expect(body.brand_guidelines).toEqual({ brandData: { brandName: 'Acme', tone: 'friendly' } });
    expect(body.market_strategy).toEqual({ data: { targetAudience: 'SMBs' } });
  });
});

describe('list_tasks never answers a signed link', () => {
  it('drops knowledgeBase and every knowledgeBaseFiles[].url, keeps ids, names and keys', async () => {
    mockMcpFetch.mockResolvedValueOnce([TASK(), { taskId: 'task-2', name: 'No KB' }]);

    const text = await call('list_tasks', {});

    expectNoSignedLink(text);
    for (const kept of ['task-1', 'task-2', 'Brand KB', 'pricing.pdf', 'faq.md', 'tasks/task-1/knowledge-base-files/0_pricing.pdf']) {
      expect(text).toContain(kept);
    }
    const body = JSON.parse(text);
    expect(body[0]).not.toHaveProperty('knowledgeBase');
    expect(body[0].knowledgeBaseSize).toBe(120);
    expect(body[0].knowledgeBaseFiles.map((f: any) => f.filename)).toEqual(['pricing.pdf', 'faq.md']);
  });

  it('also when the route wraps the list ({ tasks: [...] })', async () => {
    mockMcpFetch.mockResolvedValueOnce({ tasks: [TASK()], count: 1 });
    const text = await call('list_tasks', {});
    expectNoSignedLink(text);
    expect(text).toContain('pricing.pdf');
  });
});

describe('manage_task never answers a signed link, for every action', () => {
  it.each([
    ['create', { action: 'create', name: 'Brand KB', prompt: 'p' }, 'POST', '/api/tasks'],
    ['get', { action: 'get', task_id: 'task-1' }, 'GET', '/api/tasks/task-1'],
    ['update', { action: 'update', task_id: 'task-1', name: 'Renamed' }, 'PUT', '/api/tasks/task-1'],
  ])('%s', async (_label, args, method, path) => {
    mockMcpFetch.mockResolvedValueOnce(TASK());

    const text = await call('manage_task', args);

    expectNoSignedLink(text);
    expect(text).toContain('task-1');
    expect(text).toContain('pricing.pdf');
    expect(text).toContain('faq.md');
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({ method, path }));
  });

  it('delete (the route echoes the deleted task)', async () => {
    mockMcpFetch.mockResolvedValueOnce({ message: 'Task deleted', task: TASK() });

    const text = await call('manage_task', { action: 'delete', task_id: 'task-1' });

    expectNoSignedLink(text);
    expect(text).toContain('Task deleted');
    expect(text).toContain('pricing.pdf');
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/api/tasks/task-1' }));
  });

  it('update: a wrapped response ({ task: {...} }) is cleaned too', async () => {
    mockMcpFetch.mockResolvedValueOnce({ success: true, task: TASK() });
    const text = await call('manage_task', { action: 'update', task_id: 'task-1', status: 'active' });
    expectNoSignedLink(text);
    expect(text).toContain('faq.md');
  });
});
