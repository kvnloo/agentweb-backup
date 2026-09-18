/**
 * ENG-1004 — tranche 2 of the workflow layer (landing pages).
 *
 * Two tools that each complete a job an agent would otherwise assemble from
 * several granular calls. Assertions are about call collapsing and the shape
 * an agent sees, mirroring the ENG-982 suite's contract style: assert which
 * REST paths were hit AND what was sent / how the response was read.
 */

const mockMcpFetch = jest.fn();
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: (...args: any[]) => mockMcpFetch(...args),
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';
import { LANDING_WORKFLOW_TOOL_NAMES } from '../mcp/server/landingWorkflowTools';

const CALLER = { userId: 'user-1', sessionId: 'sess-1' };

function tool(name: string) {
  const t = mcpToolRegistry.getTool(name);
  if (!t) throw new Error(`${name} is not registered`);
  return t;
}

function paths(): string[] {
  return mockMcpFetch.mock.calls.map(c => c[0]?.path);
}

describe('ENG-1004: landing workflow tools are registered and externally visible', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers both tools under the emma_ namespace', () => {
    for (const name of LANDING_WORKFLOW_TOOL_NAMES) {
      expect(mcpToolRegistry.getTool(name)).toBeDefined();
      expect(name.startsWith('emma_')).toBe(true);
    }
  });

  it('exposes them to external clients and requires a user account', () => {
    const listed = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
    for (const name of LANDING_WORKFLOW_TOOL_NAMES) {
      expect(listed).toContain(name);
      expect((tool(name) as any).requiresUserAccount).toBe(true);
    }
  });

  it('takes no action enum and names tools for outcomes, not resource CRUD', () => {
    // Tranche-1 rule, restated for the two names Harsha approved on 2026-08-09:
    // `emma_create_landing_page` / `emma_edit_landing_page` are verb+object
    // outcome names (generate-and-deploy / revise-and-preview), not
    // resource-manager names — and neither hides verbs behind an action enum.
    for (const name of LANDING_WORKFLOW_TOOL_NAMES) {
      expect(name).not.toMatch(/^emma_(manage|list|get_all)_/);
      const props = (tool(name).definition as any).inputSchema?.properties ?? {};
      expect(Object.keys(props)).not.toContain('action');
    }
  });
});

describe('ENG-1004: emma_create_landing_page generates, waits, and returns a live URL', () => {
  beforeEach(() => jest.clearAllMocks());

  it('generate -> deployment-status happen inside the single tool call', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ id: 'page-1', status: 'deploying' })
      .mockResolvedValueOnce({ status: 'deployed', deployedUrl: 'https://page-1.vercel.app', launchReadiness: { ready: true, reasons: [] } });

    const res: any = await tool('emma_create_landing_page').execute(
      { description: 'a launch page', name: 'Launch' },
      CALLER,
    );

    expect(paths()).toEqual([
      '/api/landing-pages/v0/generate',
      '/api/landing-pages/v0/generated/page-1/deployment-status',
    ]);
    const body = JSON.parse(res.content[0].text);
    expect(body.url).toBe('https://page-1.vercel.app');
    expect(body.status).toBe('deployed');
  });

  it('a failed deploy is reported as failed, loudly — never a URL that 404s', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ id: 'page-2', status: 'deploying' })
      .mockResolvedValueOnce({ status: 'failed', buildStatus: 'error', buildError: 'out of memory', launchReadiness: { ready: false, reasons: ['build failed'] } });

    const res: any = await tool('emma_create_landing_page').execute(
      { description: 'a launch page', name: 'Launch' },
      CALLER,
    );

    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe('failed');
    expect(body.url ?? null).toBeNull();
    expect(JSON.stringify(body)).toMatch(/out of memory|build failed/i);
  });

  it('sends prompt + name, the fields /generate requires', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ id: 'page-3', status: 'deploying' })
      .mockResolvedValueOnce({ status: 'deployed', deployedUrl: 'https://page-3.vercel.app', launchReadiness: { ready: true, reasons: [] } });

    await tool('emma_create_landing_page').execute(
      { description: 'a launch page', name: 'Launch' },
      CALLER,
    );

    const generate = mockMcpFetch.mock.calls.find(c => c[0]?.path === '/api/landing-pages/v0/generate');
    expect(generate[0]?.method).toBe('POST');
    expect(generate[0]?.body?.prompt).toMatch(/a launch page/);
    expect(generate[0]?.body?.name).toBe('Launch');
  });
});

describe('ENG-1004: emma_edit_landing_page revises, previews, publishes only when asked', () => {
  beforeEach(() => jest.clearAllMocks());

  it('revise -> preview complete in one call; nothing goes live by default', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ previewUrl: 'https://preview-abc.vercel.app' });

    const res: any = await tool('emma_edit_landing_page').execute(
      { page_id: 'page-9', instructions: 'make the CTA bigger' },
      CALLER,
    );

    expect(paths()).toEqual([
      '/api/landing-pages/v0/generated/page-9/iterate',
      '/api/landing-pages/v0/generated/page-9/preview-url?branch=draft%2Fagentweb-preview',
    ]);
    expect(paths()).not.toContain('/api/landing-pages/v0/generated/page-9/publish');
    const body = JSON.parse(res.content[0].text);
    expect(body.preview_url).toBe('https://preview-abc.vercel.app');
    expect(body.published ?? false).toBe(false);
  });

  it('publishes only when publish:true is explicit', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ previewUrl: 'https://preview-abc.vercel.app' })
      .mockResolvedValueOnce({ ok: true, deployed_url: 'https://live.vercel.app' });

    await tool('emma_edit_landing_page').execute(
      { page_id: 'page-9', instructions: 'ship it', publish: true, branch: 'draft/agentweb-preview' },
      CALLER,
    );

    expect(paths()).toContain('/api/landing-pages/v0/generated/page-9/publish');
  });

  it('rollback is reachable through the tool', async () => {
    mockMcpFetch.mockResolvedValueOnce({ ok: true, message: 'Reverted the last publish.' });

    const res: any = await tool('emma_edit_landing_page').execute(
      { page_id: 'page-9', revert_last_publish: true },
      CALLER,
    );

    expect(paths()).toEqual(['/api/landing-pages/v0/generated/page-9/revert-publish']);
    expect(JSON.parse(res.content[0].text).reverted).toBe(true);
  });

  it('all calls go through mcpFetch (IDOR boundary + quota gate still apply)', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ previewUrl: 'https://preview-abc.vercel.app' });

    await tool('emma_edit_landing_page').execute(
      { page_id: 'page-9', instructions: 'tweak' },
      CALLER,
    );

    // Every REST call carries the caller context — that is what enforces the
    // IDOR boundary and the ENG-973 quota gate inside mcpFetch.
    for (const call of mockMcpFetch.mock.calls) {
      expect(call[0]?.context).toBeDefined();
    }
  });

  it('edit without instructions fails loudly and calls nothing', async () => {
    const res: any = await tool('emma_edit_landing_page').execute(
      { page_id: 'page-9' },
      CALLER,
    );

    expect(mockMcpFetch).not.toHaveBeenCalled();
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe('failed');
    expect(body.error).toMatch(/instructions is required/);
  });

  it('page_id is encoded in every generated path', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ previewUrl: 'https://preview-abc.vercel.app' });

    await tool('emma_edit_landing_page').execute(
      { page_id: 'page 9/x', instructions: 'tweak' },
      CALLER,
    );

    for (const p of paths()) {
      expect(p).toContain('/generated/page%209%2Fx/');
    }
  });
});
