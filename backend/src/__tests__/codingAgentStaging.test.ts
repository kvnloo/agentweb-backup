import { runCodingAgent, _setOpenRouterClientForTest, _setDeploymentSleepForTest } from '../services/codingAgentService';
import { mcpFetch } from '../mcp/server/httpClient';
import { checkCodingAgentSyntax } from '../services/codingAgentSyntax';

jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { getCodingAgentDefaultModel: async () => 'anthropic.claude-sonnet-4-6' } }));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));
jest.mock('../services/usageRecorderService', () => ({ recordUsage: jest.fn() }));
jest.mock('../utils/llmClients', () => ({ normalizeAnthropicCacheCreation: jest.fn() }));
jest.mock('../services/v0Service', () => ({ getLandingPageById: async () => undefined }));
jest.mock('../services/codingAgentRunService', () => ({
  createCodingAgentRun: async () => ({ runId: 'test-run' }), updateCodingAgentRun: jest.fn(),
}));

const fetchMock = mcpFetch as jest.Mock;
const model = jest.fn();
const context = { pageId: 'page', userId: 'owner', sessionId: 'session', llmModel: 'anthropic.claude-sonnet-4-6', draftBranch: 'draft/test' };
const call = (name: string, input: any = {}) => ({
  stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `call-${name}`, name, input }],
});
const edit = (file_path: string, search: string, replace: string) => call('edit_file', { file_path, edits: [{ search, replace }] });
const report = () => call('report_to_user', { status: 'success', message: 'Done' });
const writes = () => fetchMock.mock.calls.filter(([req]) => req.method === 'PUT');
const feedback = () => JSON.stringify(model.mock.calls[model.mock.calls.length - 1]?.[0].messages);

beforeEach(() => {
  model.mockReset();
  fetchMock.mockReset();
  _setOpenRouterClientForTest({ messages: { create: model } } as any);
  _setDeploymentSleepForTest(async () => {});
  fetchMock.mockImplementation(async (req: any) => {
    if (req.path.endsWith('/files')) return { files: [{ path: 'app/page.tsx', size: 30 }] };
    if (req.path.endsWith('/file-content')) return { content: 'export const title = "Old";' };
    if (req.path.endsWith('/update-files')) return { success: true, commit_url: `https://github.com/o/r/commit/${'a'.repeat(40)}` };
    if (req.path.endsWith('/preview-url')) return { buildStatus: 'success', previewUrl: 'https://preview.example' };
    throw new Error(`Unexpected request: ${req.path}`);
  });
});

afterEach(() => _setOpenRouterClientForTest(null));

test('separate edit calls and repeated edits produce one atomic commit of the final contents', async () => {
  model.mockResolvedValueOnce(edit('app/page.tsx', 'Old', 'First'))
    .mockResolvedValueOnce(edit('components/title.tsx', 'Old', 'Second'))
    .mockResolvedValueOnce(edit('app/page.tsx', 'First', 'Final'))
    .mockImplementationOnce(async () => {
      expect(writes()).toHaveLength(0);
      return call('check_deployment');
    }).mockResolvedValueOnce(report());
  const result = await runCodingAgent('Edit both files', context, 5);
  expect(result.success).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toMatchObject({ path: expect.stringContaining('/update-files'), body: { files: [
    { file_path: 'app/page.tsx', content: 'export const title = "Final";' },
    { file_path: 'components/title.tsx', content: 'export const title = "Second";' },
  ] } });
});

test('parse errors block the commit and reach the model before it repairs and checks again', async () => {
  model.mockResolvedValueOnce(edit('app/page.tsx', '"Old"', ';'))
    .mockResolvedValueOnce(call('check_deployment'))
    .mockImplementationOnce(async () => {
      expect(writes()).toHaveLength(0);
      expect(feedback()).toMatch(/app\/page.tsx.*Expression expected/s);
      return edit('app/page.tsx', '= ;;', '= "Fixed";');
    }).mockResolvedValueOnce(call('check_deployment')).mockResolvedValueOnce(report());
  expect((await runCodingAgent('Fix page', context, 5)).success).toBe(true);
  expect(writes()).toHaveLength(1);
});

test('report_to_user cannot finish successfully with invalid staged syntax', async () => {
  model.mockResolvedValueOnce(edit('app/page.tsx', '"Old"', ';')).mockResolvedValue(report());
  expect((await runCodingAgent('Edit page', context, 3)).success).toBe(false);
  expect(writes()).toHaveLength(0);
  expect(feedback()).toMatch(/Expression expected/);
});

test('a read-only session creates no commit', async () => {
  model.mockResolvedValueOnce(call('read_file', { file_path: 'app/page.tsx' })).mockResolvedValueOnce(report());
  expect((await runCodingAgent('Read page', context, 2)).success).toBe(true);
  expect(writes()).toHaveLength(0);
});

test.each(['ts', 'tsx', 'js', 'jsx', 'css'])('rejects malformed %s and accepts valid source', ext => {
  const invalid = ext === 'css' ? 'body { color: red;' : 'export const value = ;';
  const valid = ext === 'css' ? '@tailwind utilities; body { color: var(--brand); }' : 'export const value = 1;';
  expect(checkCodingAgentSyntax(`file.${ext}`, invalid)).toEqual([expect.stringMatching(/file\..*:\d+:\d+:/)]);
  expect(checkCodingAgentSyntax(`file.${ext}`, valid)).toEqual([]);
});

test('plain-text completion cannot bypass syntax validation', async () => {
  model.mockResolvedValueOnce(edit('app/page.tsx', '"Old"', ';'))
    .mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] });
  expect((await runCodingAgent('Edit page', context, 3)).success).toBe(false);
  expect(writes()).toHaveLength(0);
  expect(feedback()).toMatch(/Expression expected/);
});

test('a Vercel ERROR reaches the model and a repair is committed as a second complete batch', async () => {
  const originalFetch = fetchMock.getMockImplementation()!;
  let previews = 0;
  fetchMock.mockImplementation(async req => {
    if (req.path.endsWith('/preview-url') && ++previews === 1) {
      return { buildStatus: 'error', buildError: 'Event handlers cannot be passed to Client Component props' };
    }
    return originalFetch(req);
  });
  model.mockResolvedValueOnce(edit('app/page.tsx', 'Old', 'New'))
    .mockResolvedValueOnce(call('check_deployment'))
    .mockImplementationOnce(async () => {
      expect(feedback()).toContain('Event handlers cannot be passed');
      return edit('app/page.tsx', 'Old', 'Fixed');
    }).mockResolvedValueOnce(call('check_deployment')).mockResolvedValueOnce(report());
  expect((await runCodingAgent('Edit page', context, 5)).success).toBe(true);
  expect(writes()).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
    path: expect.stringContaining('/preview-url'), queryParams: { branch: context.draftBranch, commitSha: 'a'.repeat(40) },
  }));
});

test('reads, search, listing, deletion and revert share the staged view until one commit', async () => {
  const originalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async req => req.path.endsWith('/file-at-commit') ? { content: 'export const title = "Restored";' } : originalFetch(req));
  model.mockResolvedValueOnce(edit('app/page.tsx', 'Old', 'Staged'))
    .mockResolvedValueOnce(call('read_file', { file_path: 'app/page.tsx' }))
    .mockImplementationOnce(async () => {
      expect(feedback()).toContain('Staged');
      return call('search_in_file', { file_path: 'app/page.tsx', pattern: 'Staged' });
    }).mockResolvedValueOnce(call('edit_files', { files: [{ file_path: 'app/page.tsx', deleted: true }] }))
    .mockResolvedValueOnce(call('list_files'))
    .mockImplementationOnce(async () => {
      expect(feedback()).toContain('No files found.');
      return call('revert_file', { file_path: 'app/page.tsx', commit_sha: 'base' });
    }).mockResolvedValueOnce(call('check_deployment')).mockResolvedValueOnce(report());
  expect((await runCodingAgent('Edit and restore', context, 8)).success).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0].body.files).toEqual([{ file_path: 'app/page.tsx', content: 'export const title = "Restored";' }]);
});

test.each(['read_file', 'search_in_file', 'edit_file', 'revert_file'])('%s refuses wrong-type repository content', async name => {
  fetchMock.mockResolvedValue({ content: { unexpected: true } });
  model.mockResolvedValueOnce(call(name, { file_path: 'app/page.tsx', pattern: 'x', commit_sha: 'base', edits: [{ search: 'x', replace: 'y' }] }))
    .mockResolvedValueOnce(call('report_to_user', { status: 'error', message: 'Invalid content' }));
  expect((await runCodingAgent('Edit page', context, 2)).success).toBe(false);
  expect(writes()).toHaveLength(0);
  expect(feedback()).toMatch(/Invalid file content|Could not read/);
});

test('a successful build closes the edit batch and repeated checks do not recommit', async () => {
  model.mockResolvedValueOnce(edit('app/page.tsx', 'Old', 'New'))
    .mockResolvedValueOnce(call('check_deployment'))
    .mockResolvedValueOnce(edit('app/page.tsx', 'Old', 'Unexpected'))
    .mockResolvedValueOnce(call('check_deployment')).mockResolvedValueOnce(report());
  expect((await runCodingAgent('Edit once', context, 5)).success).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(feedback()).toContain('further edits are allowed only to repair a failed build');
});

test('creating and then deleting a new file produces no commit', async () => {
  const originalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async req => {
    if (req.path.endsWith('/file-content')) throw new Error('API error (404): Missing');
    return originalFetch(req);
  });
  model.mockResolvedValueOnce(edit('new.ts', '', 'export const x = 1;'))
    .mockResolvedValueOnce(call('edit_files', { files: [{ file_path: 'new.ts', deleted: true }] }))
    .mockResolvedValueOnce(report());
  expect((await runCodingAgent('Create then undo', context, 3)).success).toBe(true);
  expect(writes()).toHaveLength(0);
});

test('an error report discards uncommitted edits', async () => {
  model.mockResolvedValueOnce(edit('app/page.tsx', 'Old', 'New'))
    .mockResolvedValueOnce(call('report_to_user', { status: 'error', message: 'Cannot finish' }));
  expect((await runCodingAgent('Edit', context, 2)).success).toBe(false);
  expect(writes()).toHaveLength(0);
});
