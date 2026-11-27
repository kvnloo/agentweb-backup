import ts from 'typescript';
import { buildCaptureRoute } from '../v0Service';

// ENG-3178: execute the GENERATED capture route with next/* mocked, so the test pins the
// behaviour a visitor actually gets rather than the source text.
async function submit(listByPath: Record<string, string>, cookie: Record<string, string>, referer?: string) {
  const js = ts.transpileModule(buildCaptureRoute(listByPath, 'https://api.test'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  const nextServer = { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } };
  const nextHeaders = {
    cookies: async () => ({ get: (k: string) => (k in cookie ? { value: cookie[k] } : undefined) }),
    headers: async () => new Map(referer ? [['referer', referer]] : []),
  };
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const req = (m: string) => (m === 'next/server' ? nextServer : m === 'next/headers' ? nextHeaders : require(m));
  new Function('require', 'module', 'exports', 'fetch', js)(req, mod, mod.exports, fetchMock);
  const POST = mod.exports.POST as (r: unknown) => Promise<{ status: number }>;
  const res = await POST({ json: async () => ({ email: 'a@b.co' }), headers: new Map() });
  const forwarded = fetchMock.mock.calls[0] ? JSON.parse(fetchMock.mock.calls[0][1].body) : undefined;
  return { res, forwarded };
}

describe('generated capture route list resolution (ENG-3178)', () => {
  it('files to the only list when the page path cannot be resolved', async () => {
    const { res, forwarded } = await submit({ '/': 'list_only' }, {});
    expect(res.status).not.toBe(422);
    expect(forwarded.leadListId ?? JSON.stringify(forwarded)).toContain('list_only');
  });

  it('files to the only list when the resolved path is unconfigured', async () => {
    const { forwarded } = await submit({ '/': 'list_only' }, { aw_page: '/other' });
    expect(JSON.stringify(forwarded)).toContain('list_only');
  });

  it('still fails loudly on a multi-list site with an unresolvable path', async () => {
    const { res, forwarded } = await submit({ '/': 'list_a', '/pricing': 'list_b' }, {});
    expect(res.status).toBe(422);
    expect(forwarded).toBeUndefined();
  });

  it('uses the stamped path on a multi-list site', async () => {
    const { forwarded } = await submit({ '/': 'list_a', '/pricing': 'list_b' }, { aw_page: '/pricing' });
    expect(JSON.stringify(forwarded)).toContain('list_b');
    expect(JSON.stringify(forwarded)).not.toContain('list_a');
  });
});
