import { applySearchReplace, applyLineNumberEdit, runCodingAgent, CodingAgentContext, resolvePageScope, isSafeRepoPath, buildScopeSystemClause, LANDING_PAGE_PREVIEW_BRANCH, _isMissingGithubRefError, _describeGithubError, _previewBranchCommitsAheadOfMain, _setBedrockClientForTest, _setVertexClientForTest, _setBedrockBearerClientForTest, _setSleepFnForTest, _parseEventStreamFrames, _accumulateBedrockStream, _rollbackEditedFiles } from '../services/codingAgentService';
import { agentModeService } from '../services/agentModeService';

// Mock mcpFetch
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn()
}));

// Mock only axios's HTTP methods (used by the preview-branch reset) while
// preserving the rest of the module — other transitively-imported services
// (e.g. Slack's WebClient) rely on axios.create/axios.defaults at load time.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: {
      ...actual,
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    },
  };
});
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock the GitHub org token lookup so the reset path doesn't hit Secrets Manager.
jest.mock('../utils/secretsManager', () => ({
  ...jest.requireActual('../utils/secretsManager'),
  getGitHubOrgToken: jest.fn(async () => ({ token: 'gh-test-token', org: 'AgentWebPro' })),
}));

// Build an axios-style error carrying a GitHub response body.
const githubAxiosError = (status: number, data: any): any => {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
};

// Mock v0Service so scope resolution doesn't hit DynamoDB. By default both lookups
// return empty (page not found) → scope stays undefined → the agent runs
// unrestricted, matching the pre-scope behavior the bulk of these tests assert.
const mockGetLandingPageById = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockCanUserEditLandingPage = jest.fn();
jest.mock('../services/v0Service', () => ({
  getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
  getLandingPagesByOwner: (...a: any[]) => mockGetLandingPagesByOwner(...a),
  canUserEditLandingPage: (...a: any[]) => mockCanUserEditLandingPage(...a),
}));

import { mcpFetch } from '../mcp/server/httpClient';
const mockedMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

// Mock the AnthropicBedrock client
const mockCreate = jest.fn();
const mockClient = {
  messages: { create: mockCreate }
} as any;

describe('applySearchReplace', () => {
  // --- FAIL CASES ---

  test('returns error when search string is not found', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const edits = [{ search: 'function goodbye()', replace: 'function farewell()' }];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not found');
    expect(result.appliedCount).toBe(0);
    expect(result.result).toBe(content); // unchanged
  });

  test('returns error when search string is found multiple times (ambiguous)', () => {
    const content = 'const x = 1;\nconst y = 2;\nconst z = 1;\n';
    const edits = [{ search: 'const', replace: 'let' }];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('multiple');
    expect(result.appliedCount).toBe(0);
  });

  test('returns error for empty search string', () => {
    const content = 'hello world';
    const edits = [{ search: '', replace: 'something' }];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(1);
    expect(result.appliedCount).toBe(0);
  });

  // --- SUCCESS CASES ---

  test('applies a single edit correctly', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const edits = [{ search: 'return "world"', replace: 'return "universe"' }];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('function hello() {\n  return "universe";\n}');
  });

  test('applies multiple sequential edits', () => {
    const content = '<h1>Hello</h1>\n<p>World</p>\n<span>!</span>';
    const edits = [
      { search: '<h1>Hello</h1>', replace: '<h1>Hi</h1>' },
      { search: '<p>World</p>', replace: '<p>Earth</p>' }
    ];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(2);
    expect(result.result).toBe('<h1>Hi</h1>\n<p>Earth</p>\n<span>!</span>');
  });

  test('matches with whitespace normalization when exact match fails', () => {
    const content = 'function hello() {\n  return "world";  \n}';
    // Search string has no trailing spaces on line 2
    const edits = [{ search: 'function hello() {\n  return "world";\n}', replace: 'function hi() {\n  return "earth";\n}' }];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toContain('function hi()');
  });

  test('applies edits sequentially so later edits see earlier changes', () => {
    const content = 'const color = "red";\nconst bg = "blue";';
    const edits = [
      { search: 'const color = "red";', replace: 'const color = "green";' },
      { search: 'const color = "green";', replace: 'const color = "purple";' }
    ];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(2);
    expect(result.result).toContain('"purple"');
  });

  test('handles deletion (replace with empty string)', () => {
    const content = '// TODO: remove this\nconst x = 1;';
    const edits = [{ search: '// TODO: remove this\n', replace: '' }];

    const result = applySearchReplace(content, edits);

    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('const x = 1;');
  });
});

describe('runCodingAgent', () => {
  const mockContext: CodingAgentContext = {
    pageId: 'test-page-123',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-sonnet-4-6',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
    mockCreate.mockReset();
    _setBedrockClientForTest(mockClient);
    // Skip real sleep delays in all tests
    _setSleepFnForTest(async () => {});
  });

  afterAll(() => {
    _setBedrockClientForTest(null);
  });

  // --- FAIL CASES ---

  test('returns 403 authorization error immediately without running more LLM iterations', async () => {
    // Pre-flight list_files succeeds (view access works for the member)
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] });

    // LLM calls edit_file — which reads first, then writes
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
          file_path: 'app/page.tsx',
          edits: [{ search: '<h1>Old</h1>', replace: '<h1>New</h1>' }]
        }}
      ],
      stop_reason: 'tool_use'
    });
    // edit_file step 1: read file content (GET /file-content) — succeeds
    mockedMcpFetch.mockResolvedValueOnce({ content: '<h1>Old</h1>' });
    // edit_file step 2: write (PUT /github-edit) — throws 403
    mockedMcpFetch.mockRejectedValueOnce(new Error('API error (403): Not authorized to edit this landing page'));

    const result = await runCodingAgent('Change the heading', mockContext);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authorized|403|permission/i);
    // Should fail-fast: no second LLM call after the 403
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('403 on pre-flight list_files returns authorization error without LLM call', async () => {
    // The initial list_files read also fails with 403 (edge case: read access revoked)
    mockedMcpFetch.mockRejectedValueOnce(new Error('API error (403): Not authorized to edit this landing page'));

    const result = await runCodingAgent('Change the heading', mockContext);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authorized|403|permission/i);
    // Should NOT have called the LLM at all
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('preflight: denies up front when caller cannot edit the page (no LLM, no edit attempt)', async () => {
    // The page exists and is visible to the caller, but they lack edit rights
    // (plain org member viewing a shared page). The preflight must short-circuit.
    mockGetLandingPageById.mockResolvedValue({ id: 'test-page-123', userId: 'owner-999' });
    mockCanUserEditLandingPage.mockResolvedValue(false);

    const result = await runCodingAgent('Change the heading', mockContext);

    expect(result.success).toBe(false);
    expect(result.notAuthorized).toBe(true);
    expect(result.message).toMatch(/not authorized.*editor.*Org-wide Sharing/is);
    expect(result.iterations).toBe(0);
    // No LLM call and no GitHub edit call — fully short-circuited.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockedMcpFetch).not.toHaveBeenCalled();
    expect(mockCanUserEditLandingPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-999' }),
      'user-456',
    );
  });

  test('preflight: allows the run when caller can edit the page', async () => {
    mockGetLandingPageById.mockResolvedValue({ id: 'test-page-123', userId: 'user-456' });
    mockCanUserEditLandingPage.mockResolvedValue(true);
    // Agent immediately reports success — we only care that the preflight let it run.
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Done!', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('Change the heading', mockContext);

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('preflight: proceeds when the page record is missing (auth enforced downstream)', async () => {
    // getLandingPageById returns undefined → preflight skipped → behaves as before.
    mockGetLandingPageById.mockResolvedValue(undefined);
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Done!', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('Change the heading', mockContext);

    expect(result.success).toBe(true);
    expect(mockCanUserEditLandingPage).not.toHaveBeenCalled();
  });

  test('returns structured failure info when max iterations reached', async () => {
    // LLM always returns a tool call, never terminates
    mockCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} }
      ],
      stop_reason: 'tool_use'
    });
    mockedMcpFetch.mockResolvedValue({ files: [{ path: 'app/page.tsx', size: 1000 }] });

    const result = await runCodingAgent('edit the page', mockContext, 3);

    expect(result.success).toBe(false);
    expect(result.message).toContain('iteration limit');
    expect(result.message).toContain('list_files');
    expect(result.message).toContain('No files were edited');
    expect(result.iterations).toBe(3);
  });

  // --- PER-USER USAGE ACCOUNTING ---
  // The coding agent runs a self-contained multi-turn LLM loop whose token spend is
  // invisible to the parent agent-mode meter. runCodingAgent must surface the summed
  // usage so the caller can charge it to the per-user token/cost cap (ENG-200).

  test('accumulates token usage across turns and returns usageTotals with computed cost', async () => {
    // Turn 1: a tool call (usage present, includes cache tokens)
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
    });
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 1000 }] });
    // Turn 2: report success (usage present)
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Done!', status: 'success' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await runCodingAgent('edit the page', mockContext);

    expect(result.usageTotals).toBeDefined();
    expect(result.usageTotals!.inputTokens).toBe(300);
    expect(result.usageTotals!.outputTokens).toBe(60);
    expect(result.usageTotals!.cacheReadTokens).toBe(5);
    expect(result.usageTotals!.cacheWriteTokens).toBe(3);
    // totalTokens is every token the model processed (input + output + cache).
    expect(result.usageTotals!.totalTokens).toBe(368);
    // Priced via the same source as the shadow meter (Sonnet 4.6 fallback model), in USD.
    // 300*3 + 60*15 + 5*0.3 + 3*3.75 = 1812.75, rounded to integer microUsd (1813) → $0.001813
    expect(result.usageTotals!.costUsd).toBeCloseTo(1813 / 1e6, 9);
  });

  test('omits usageTotals when the run never made a priced LLM call', async () => {
    // Pre-flight list_files fails with 403 before any LLM turn — no usage to report.
    mockedMcpFetch.mockRejectedValueOnce(new Error('API error (403): Not authorized to edit this landing page'));

    const result = await runCodingAgent('Change the heading', mockContext);

    expect(result.success).toBe(false);
    expect(result.usageTotals).toBeUndefined();
  });

  test('max iterations failure includes files edited and preview URL', async () => {
    // Iteration 1: read_file
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'app/page.tsx' } }
      ],
      stop_reason: 'tool_use'
    });
    mockedMcpFetch.mockResolvedValueOnce({ content: '<h1>Old</h1>\n<p>Text</p>' });

    // Iteration 2: edit_file
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'edit_file', input: {
          file_path: 'app/page.tsx',
          edits: [{ search: '<h1>Old</h1>', replace: '<h1>New</h1>' }]
        }}
      ],
      stop_reason: 'tool_use'
    });
    // edit_file reads content, then writes
    mockedMcpFetch
      .mockResolvedValueOnce({ content: '<h1>Old</h1>\n<p>Text</p>' })
      .mockResolvedValueOnce({ success: true, commit_url: 'https://github.com/test/commit/abc' });

    // Iteration 3: check_deployment (last iteration)
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_3', name: 'check_deployment', input: {} }
      ],
      stop_reason: 'tool_use'
    });
    mockedMcpFetch.mockResolvedValueOnce({
      status: 'READY',
      url: 'https://test-abc.vercel.app',
      preview_url: 'https://test-abc.vercel.app'
    });

    const result = await runCodingAgent('change heading', mockContext, 3);

    expect(result.success).toBe(false);
    expect(result.message).toContain('app/page.tsx');
    expect(result.message).toContain('vercel.app');
    expect(result.message).toContain('edit_file');
    expect(result.previewUrl).toContain('vercel.app');
  });

  test('max iterations failure includes last agent reasoning', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'I am trying to fix the CSS import path that is causing the build error.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'app/globals.css' } }
      ],
      stop_reason: 'tool_use'
    });
    mockedMcpFetch.mockResolvedValue({ content: 'body { margin: 0; }' });

    const result = await runCodingAgent('fix css', mockContext, 2);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Last agent note');
    expect(result.message).toContain('CSS import');
  });

  test('handles LLM call errors gracefully', async () => {
    mockCreate.mockRejectedValue(new Error('Bedrock timeout'));

    const result = await runCodingAgent('edit something', mockContext);

    expect(result.success).toBe(false);
    expect(result.message).toContain('error');
  });

  test('edit_file returns error when edits array is empty', async () => {
    // First call: LLM calls edit_file with empty edits
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: { file_path: 'app/page.tsx', edits: [] } }
        ],
        stop_reason: 'tool_use'
      })
      // Second call: LLM gives up and reports
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Edit failed', status: 'error' } }
        ],
        stop_reason: 'tool_use'
      });

    const result = await runCodingAgent('edit page', mockContext);

    // The agent should have received the validation error and reported back
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  // --- SUCCESS CASES ---

  test('returns immediately when LLM calls report_to_user', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'All changes applied successfully!', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('fix the bug', mockContext);

    expect(result.success).toBe(true);
    expect(result.message).toBe('All changes applied successfully!');
    expect(result.iterations).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('runs acceptance checks after a simple landing-page update before returning success', async () => {
    const mockExecuteMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: true });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'report_to_user',
          input: {
            message: 'Updated the hero headline to Launch Faster.',
            status: 'success',
            preview_url: 'https://preview.example',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('Change the hero headline to Launch Faster', {
      ...mockContext,
      executeMcpTool: mockExecuteMcpTool,
      acceptanceChecks: [{
        type: 'text_present',
        label: 'Hero headline changed',
        text: 'Launch Faster',
      }],
    });

    expect(result.success).toBe(true);
    expect(result.acceptanceStatus).toBe('passed');
    expect(result.message).toContain('Acceptance passed');
    expect(mockExecuteMcpTool).toHaveBeenCalledWith('playwright_browser_navigate', { url: 'https://preview.example' });
    expect(mockExecuteMcpTool).toHaveBeenCalledWith('playwright_browser_evaluate', {
      function: expect.stringContaining('Launch Faster'),
    });
  });

  test('refreshes a stale draft preview URL before running acceptance checks', async () => {
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 1000 }] })
      .mockResolvedValueOnce({
        buildStatus: 'success',
        previewUrl: 'https://new-preview.example',
      });
    const mockExecuteMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: true });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'report_to_user',
          input: {
            message: 'Updated the live smoke page.',
            status: 'success',
            preview_url: 'https://old-preview.example',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('Change the smoke page', {
      ...mockContext,
      draftBranch: 'draft/session-789',
      executeMcpTool: mockExecuteMcpTool,
      acceptanceChecks: [{
        type: 'text_present',
        label: 'Smoke phrase visible',
        text: 'Live verifier pass',
      }],
    });

    expect(result.success).toBe(true);
    expect(result.previewUrl).toBe('https://new-preview.example');
    expect(mockedMcpFetch).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'GET',
      path: '/api/landing-pages/v0/generated/test-page-123/preview-url',
      queryParams: { branch: 'draft/session-789' },
      context: { userId: 'user-456' },
    }));
    expect(mockExecuteMcpTool).toHaveBeenCalledWith('playwright_browser_navigate', {
      url: 'https://new-preview.example',
    });
  });

  test('fails the coding agent result when landing-page acceptance checks fail', async () => {
    const mockExecuteMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: false });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'report_to_user',
          input: {
            message: 'Updated the hero headline to Launch Faster.',
            status: 'success',
            preview_url: 'https://preview.example',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('Change the hero headline to Launch Faster', {
      ...mockContext,
      executeMcpTool: mockExecuteMcpTool,
      acceptanceChecks: [{
        type: 'text_present',
        label: 'Hero headline changed',
        text: 'Launch Faster',
      }],
    });

    expect(result.success).toBe(false);
    expect(result.acceptanceStatus).toBe('failed');
    expect(result.acceptance?.checks[0]).toMatchObject({
      label: 'Hero headline changed',
      status: 'failed',
      actual: false,
      expected: true,
    });
    expect(result.message).toContain('Acceptance failed');
  });

  test('treats model-reported partial completion as unsuccessful', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'One item still needs work.', status: 'partial' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('fix multiple issues', mockContext);

    expect(result.success).toBe(false);
    expect(result.message).toBe('One item still needs work.');
  });

  test('multi-iteration: read_file then edit_file then report_to_user', async () => {
    // Iteration 1: LLM calls read_file
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'Let me read the file first.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'app/page.tsx' } }
      ],
      stop_reason: 'tool_use'
    });
    // read_file mcpFetch returns file content
    mockedMcpFetch.mockResolvedValueOnce({
      path: 'app/page.tsx',
      content: '<h1>Old Title</h1>\n<p>Some text</p>',
      sha: 'abc123'
    });

    // Iteration 2: LLM calls edit_file
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'edit_file', input: {
          file_path: 'app/page.tsx',
          edits: [{ search: '<h1>Old Title</h1>', replace: '<h1>New Title</h1>' }],
          commit_message: 'Update heading'
        }}
      ],
      stop_reason: 'tool_use'
    });
    // edit_file: first reads file (mcpFetch GET), then writes (mcpFetch PUT)
    mockedMcpFetch
      .mockResolvedValueOnce({ // GET file content for edit
        path: 'app/page.tsx',
        content: '<h1>Old Title</h1>\n<p>Some text</p>',
        sha: 'abc123'
      })
      .mockResolvedValueOnce({ // PUT github-edit
        success: true,
        commit_url: 'https://github.com/test/repo/commit/def456',
        file_path: 'app/page.tsx',
        deployed_url: 'https://test.vercel.app'
      });

    // Iteration 3: LLM reports success
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_3', name: 'report_to_user', input: { message: 'Updated heading from Old Title to New Title.', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('Change the heading to New Title', mockContext);

    expect(result.success).toBe(true);
    expect(result.message).toContain('New Title');
    expect(result.iterations).toBe(3);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  // --- edit_files (ENG-497): atomic multi-file commit ---

  test('edit_files: commits 2 files (one edited, one deleted) in ONE atomic PUT to update-files', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_files', input: {
          files: [
            { file_path: 'public/book-a-demo.html', edits: [{ search: '<h1>Old</h1>', replace: '<h1>New</h1>' }] },
            { file_path: 'app/api/old-route/route.ts', deleted: true },
          ],
          commit_message: 'Fix email capture + remove stale route',
        }}
      ],
      stop_reason: 'tool_use'
    });
    // edit_files: reads current content only for the non-deleted file, then ONE PUT
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 1000 }] }) // preflight list_files
      .mockResolvedValueOnce({ path: 'public/book-a-demo.html', content: '<h1>Old</h1>' })
      .mockResolvedValueOnce({
        success: true,
        commit_url: 'https://github.com/test/repo/commit/abc123',
        deployed_url: 'https://test.vercel.app',
      });

    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Committed both files.', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('Fix the demo page and remove the old route', mockContext);

    expect(result.success).toBe(true);
    expect(mockedMcpFetch).toHaveBeenCalledTimes(3); // preflight + one read + ONE atomic write, not two writes
    const putCall = mockedMcpFetch.mock.calls[2][0] as any;
    expect(putCall.method).toBe('PUT');
    expect(putCall.path).toBe(`/api/landing-pages/v0/generated/${mockContext.pageId}/update-files`);
    expect(putCall.body.files).toEqual([
      { file_path: 'public/book-a-demo.html', content: '<h1>New</h1>' },
      { file_path: 'app/api/old-route/route.ts', deleted: true },
    ]);
    expect(putCall.body.commit_message).toBe('Fix email capture + remove stale route');
    // Greptile: batch commits must be tracked for rollback the same way edit_file's are.
    expect(result.editedFiles).toEqual(
      expect.arrayContaining(['public/book-a-demo.html', 'app/api/old-route/route.ts'])
    );
  });

  test('edit_files: empty files array is rejected without calling update-files', async () => {
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 1000 }] }); // preflight list_files
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_files', input: { files: [], commit_message: 'msg' } }
      ],
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Could not edit — no files given.', status: 'error' } }
      ],
      stop_reason: 'tool_use'
    });

    await runCodingAgent('do something', mockContext);

    // Only the preflight call — the empty-array guard fires before any read/write.
    expect(mockedMcpFetch).toHaveBeenCalledTimes(1);
  });

  test('edit_files: a path-traversal attempt in ANY one file blocks the whole batch, no update-files call', async () => {
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 1000 }] }); // preflight list_files
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_files', input: {
          files: [
            { file_path: 'app/page.tsx', edits: [{ search: 'a', replace: 'b' }] },
            { file_path: '../../etc/passwd', edits: [{ search: 'a', replace: 'b' }] },
          ],
          commit_message: 'msg',
        }}
      ],
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Rejected unsafe path.', status: 'error' } }
      ],
      stop_reason: 'tool_use'
    });

    await runCodingAgent('do something', mockContext);

    // Only the preflight call — the safety guard fires before any read/write for this tool.
    expect(mockedMcpFetch).toHaveBeenCalledTimes(1);
  });

  test('edit_files: a PARTIAL edit on one file blocks the whole atomic batch — no update-files call, nothing tracked as edited (Greptile)', async () => {
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 1000 }] }) // preflight list_files
      .mockResolvedValueOnce({ path: 'public/book-a-demo.html', content: '<h1>Old</h1>' }); // read for the partial file
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_files', input: {
          files: [
            // Two edits requested for this ONE file; only one search string matches.
            { file_path: 'public/book-a-demo.html', edits: [
              { search: '<h1>Old</h1>', replace: '<h1>New</h1>' },
              { search: 'THIS STRING DOES NOT EXIST', replace: 'irrelevant' },
            ] },
            { file_path: 'app/api/new-route/route.ts', deleted: true },
          ],
          commit_message: 'msg',
        }}
      ],
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Could not complete the batch.', status: 'error' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('do a 2-file fix', mockContext);

    // Read happened, but the atomic write to update-files must NEVER be reached.
    expect(mockedMcpFetch).toHaveBeenCalledTimes(2);
    expect(mockedMcpFetch.mock.calls.every((c: any) => c[0].path !== '/api/landing-pages/v0/generated/test-page-123/update-files')).toBe(true);
    // Nothing was actually committed, so nothing should be tracked as edited for rollback.
    expect(result.editedFiles).toEqual([]);
  });

  test('returns text response when LLM responds without tool calls', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'I cannot make that change because the file does not exist.' }
      ],
      stop_reason: 'end_turn'
    });

    const result = await runCodingAgent('edit nonexistent file', mockContext);

    expect(result.success).toBe(true);
    expect(result.message).toContain('does not exist');
    expect(result.iterations).toBe(1);
  });

  test('browse_page tool calls executeMcpTool for browser navigation and snapshot', async () => {
    const mockExecuteMcpTool = jest.fn()
      .mockResolvedValueOnce({ content: 'Navigated to https://test.vercel.app' }) // navigate
      .mockResolvedValueOnce({ content: '- heading "New Title"\n- paragraph "Some content"' }); // snapshot

    const contextWithBrowser: CodingAgentContext = {
      ...mockContext,
      executeMcpTool: mockExecuteMcpTool,
    };

    // LLM calls browse_page then report_to_user
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'browse_page', input: { url: 'https://test.vercel.app' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Verified: page shows New Title.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    const result = await runCodingAgent('verify the page', contextWithBrowser);

    expect(result.success).toBe(true);
    expect(mockExecuteMcpTool).toHaveBeenCalledWith('playwright_browser_navigate', { url: 'https://test.vercel.app' });
    expect(mockExecuteMcpTool).toHaveBeenCalledWith('playwright_browser_snapshot', {});
  });

  test('browse_page returns error when executeMcpTool is not available', async () => {
    // Context without executeMcpTool
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'browse_page', input: { url: 'https://test.vercel.app' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Browser not available.', status: 'error' } }
        ],
        stop_reason: 'tool_use'
      });

    const result = await runCodingAgent('verify the page', mockContext);

    // Should still complete (agent handles the error message from the tool)
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  test('take_screenshot feeds the captured image back to the model as a vision block', async () => {
    const mockExecuteMcpTool = jest.fn().mockResolvedValueOnce({
      content: 'Screenshot taken',
      raw: { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'BASE64IMAGEDATA' }] }
    });
    const contextWithBrowser: CodingAgentContext = {
      ...mockContext,
      executeMcpTool: mockExecuteMcpTool,
    };

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'take_screenshot', input: { full_page: true } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Looks good.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    const result = await runCodingAgent('screenshot the page', contextWithBrowser);

    expect(result.success).toBe(true);
    expect(mockExecuteMcpTool).toHaveBeenCalledWith('playwright_browser_take_screenshot', { type: 'jpeg', fullPage: true });

    // The second LLM call must receive the screenshot as an image content block,
    // not just the string "Screenshot taken successfully." — otherwise the model is blind.
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
    );
    expect(toolResultMsg).toBeDefined();
    const trBlock = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(Array.isArray(trBlock.content)).toBe(true);
    const imageBlock = trBlock.content.find((b: any) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source).toMatchObject({ type: 'base64', media_type: 'image/jpeg', data: 'BASE64IMAGEDATA' });
  });

  test('take_screenshot returns a text error (no image block) when browser tools are unavailable', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'take_screenshot', input: {} }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Browser not available.', status: 'error' } }
        ],
        stop_reason: 'tool_use'
      });

    // No executeMcpTool on mockContext
    await runCodingAgent('screenshot the page', mockContext);

    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
    );
    const trBlock = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(typeof trBlock.content).toBe('string');
    expect(trBlock.content).toMatch(/not available/i);
  });

  test('take_screenshot falls back to text when MCP returns no image data', async () => {
    const mockExecuteMcpTool = jest.fn().mockResolvedValueOnce({
      content: 'no image here',
      raw: { content: [] }
    });
    const contextWithBrowser: CodingAgentContext = {
      ...mockContext,
      executeMcpTool: mockExecuteMcpTool,
    };

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'take_screenshot', input: {} }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'done', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    const result = await runCodingAgent('screenshot the page', contextWithBrowser);

    expect(result.success).toBe(true);
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
    );
    const trBlock = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(typeof trBlock.content).toBe('string');
  });

  test('list_commits tool returns formatted commit history', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'list_commits', input: { file_path: 'app/page.tsx' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Found commits.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({
      commits: [
        { sha: 'abc1234567890', message: 'Update heading', date: '2026-03-20T10:00:00Z', author: 'Emma' },
        { sha: 'def4567890123', message: 'Initial commit', date: '2026-03-19T10:00:00Z', author: 'v0' }
      ]
    });

    const result = await runCodingAgent('list commits', mockContext);

    expect(result.success).toBe(true);
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/commits'),
      queryParams: { path: 'app/page.tsx' }
    }));
  });

  test('list_commits without file_path passes empty queryParams', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'list_commits', input: {} }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Done.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({ commits: [] });

    const result = await runCodingAgent('list all commits', mockContext);

    expect(result.success).toBe(true);
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/commits'),
      queryParams: {}
    }));
  });

  test('revert_file reads old version and writes it back', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'revert_file', input: {
            file_path: 'app/page.tsx',
            commit_sha: 'abc1234',
            commit_message: 'Revert to pre-edit state'
          }}
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Reverted successfully.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    // Pre-fetch file listing (called before any LLM iteration)
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] });
    // First tool call: GET file-at-commit
    mockedMcpFetch.mockResolvedValueOnce({
      path: 'app/page.tsx',
      content: '<h1>Original Content</h1>',
      sha: 'oldsha',
      commit_ref: 'abc1234'
    });
    // Second tool call: PUT github-edit
    mockedMcpFetch.mockResolvedValueOnce({
      success: true,
      commit_url: 'https://github.com/test/repo/commit/newsha',
      deployed_url: 'https://test.vercel.app'
    });

    const result = await runCodingAgent('revert the file', mockContext);

    expect(result.success).toBe(true);
    // Verify file-at-commit was called
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/file-at-commit'),
      queryParams: { path: 'app/page.tsx', ref: 'abc1234' }
    }));
    // Verify github-edit was called with old content
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'PUT',
      path: expect.stringContaining('/github-edit'),
      body: expect.objectContaining({
        file_path: 'app/page.tsx',
        content: '<h1>Original Content</h1>',
        commit_message: 'Revert to pre-edit state'
      })
    }));
  });

  test('revert_file returns error when file_path or commit_sha is missing', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'revert_file', input: { file_path: 'app/page.tsx' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Missing params.', status: 'error' } }
        ],
        stop_reason: 'tool_use'
      });

    // Pre-fetch file listing (called before any LLM iteration)
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] });

    const result = await runCodingAgent('revert without sha', mockContext);

    // Should have completed (agent handles the error from tool)
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    // Only the pre-fetch should have been called — validation fails before any tool GET/PUT
    expect(mockedMcpFetch).toHaveBeenCalledTimes(1);
  });

  test('revert_file handles file not found at commit', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'revert_file', input: {
            file_path: 'app/missing.tsx',
            commit_sha: 'abc1234'
          }}
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'File not found.', status: 'error' } }
        ],
        stop_reason: 'tool_use'
      });

    // Pre-fetch file listing (called before any LLM iteration)
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] });
    // file-at-commit returns no content
    mockedMcpFetch.mockResolvedValueOnce({ path: 'app/missing.tsx' });

    const result = await runCodingAgent('revert missing file', mockContext);

    expect(result.iterations).toBeGreaterThanOrEqual(1);
    // Should have called pre-fetch + GET (not PUT since content was empty)
    expect(mockedMcpFetch).toHaveBeenCalledTimes(2);
  });

  test('list_files tool returns file listing', async () => {
    // LLM calls list_files then report_to_user
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Found 3 files.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({
      files: [
        { path: 'app/page.tsx', size: 5000 },
        { path: 'app/globals.css', size: 2000 },
        { path: 'package.json', size: 500 }
      ],
      repo: 'org/repo'
    });

    const result = await runCodingAgent('list all files', mockContext);

    expect(result.success).toBe(true);
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/files')
    }));
  });

  // --- search_in_file tool tests ---

  test('search_in_file returns matching lines with line numbers and context', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'search_in_file', input: { file_path: 'app/page.tsx', pattern: 'className' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Found matches.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    // mcpFetch returns file content
    mockedMcpFetch.mockResolvedValueOnce({
      content: 'line1\nline2\nline3 className="hero"\nline4\nline5\nline6 className="footer"\nline7'
    });

    const result = await runCodingAgent('search for className', mockContext);

    expect(result.success).toBe(true);
    // Verify mcpFetch was called with file-content endpoint
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/file-content'),
      queryParams: expect.objectContaining({ path: 'app/page.tsx' })
    }));
  });

  test('search_in_file returns "no matches" when pattern not found', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'search_in_file', input: { file_path: 'app/page.tsx', pattern: 'nonexistent' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'No matches found.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({
      content: 'line1\nline2\nline3'
    });

    const result = await runCodingAgent('search for nonexistent', mockContext);
    expect(result.success).toBe(true);
  });

  // --- read_file with line range tests ---

  test('read_file with start_line and end_line returns only that range with line numbers', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'app/page.tsx', start_line: 2, end_line: 4 } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Read lines 2-4.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({
      content: 'line1\nline2\nline3\nline4\nline5'
    });

    const result = await runCodingAgent('read lines 2-4', mockContext);
    expect(result.success).toBe(true);
  });

  test('read_file without line range returns full content with line numbers', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'app/page.tsx' } }
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Read full file.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({
      content: 'alpha\nbeta\ngamma'
    });

    const result = await runCodingAgent('read the file', mockContext);
    expect(result.success).toBe(true);
  });

  // --- edit_file with line numbers tests ---

  test('edit_file with line_edits uses line-number-based replacement', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
            file_path: 'app/page.tsx',
            line_edits: [{ start_line: 2, end_line: 3, new_content: '  return "universe";\n' }],
            commit_message: 'Update return value'
          }}
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Applied line edit.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    // Pre-fetch file listing (called before any LLM iteration)
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] });
    // GET file content
    mockedMcpFetch.mockResolvedValueOnce({
      content: 'function hello() {\n  return "world";\n}'
    });
    // PUT github-edit
    mockedMcpFetch.mockResolvedValueOnce({
      success: true,
      commit_url: 'https://github.com/test/repo/commit/abc',
    });

    const result = await runCodingAgent('edit with line numbers', mockContext);
    expect(result.success).toBe(true);

    // Verify the PUT was called with the line-edited content
    const putCall = mockedMcpFetch.mock.calls.find(call => call[0]?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect((putCall![0] as any).body.content).toContain('universe');
    expect((putCall![0] as any).body.content).not.toContain('"world"');
  });

  test('edit_file with search/replace still works (backward compat)', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
            file_path: 'app/page.tsx',
            edits: [{ search: '<h1>Old</h1>', replace: '<h1>New</h1>' }],
            commit_message: 'Update heading'
          }}
        ],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Done.', status: 'success' } }
        ],
        stop_reason: 'tool_use'
      });

    mockedMcpFetch.mockResolvedValueOnce({ content: '<h1>Old</h1>\n<p>Text</p>' });
    mockedMcpFetch.mockResolvedValueOnce({ success: true, commit_url: 'https://github.com/test/repo/commit/xyz' });

    const result = await runCodingAgent('edit with search/replace', mockContext);
    expect(result.success).toBe(true);
  });

  // --- check_deployment polling tests ---

  const draftContext: CodingAgentContext = {
    pageId: 'test-page-123',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-sonnet-4-6',
    draftBranch: 'draft/abc12345',
  };

  test('check_deployment polls until build ready and returns preview URL', async () => {
    // LLM: calls check_deployment, then report_to_user with the URL it received
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'check_deployment', input: {} }],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [{
          type: 'tool_use', id: 'tu_2', name: 'report_to_user',
          input: { message: 'Done! Preview at https://test.vercel.app', status: 'success', preview_url: 'https://test.vercel.app' }
        }],
        stop_reason: 'tool_use'
      });

    // Pre-fetch file listing, two check_deployment polls, then final authoritative preview refresh.
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValueOnce({ buildStatus: 'building' })
      .mockResolvedValueOnce({ buildStatus: 'success', previewUrl: 'https://test.vercel.app' })
      .mockResolvedValueOnce({ buildStatus: 'success', previewUrl: 'https://test.vercel.app' });

    await runCodingAgent('update logo', draftContext);

    // Verify polling happened and the final branch preview was refreshed.
    expect(mockedMcpFetch).toHaveBeenCalledTimes(4);
    expect(mockedMcpFetch).toHaveBeenNthCalledWith(3, expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/preview-url'),
    }));
    expect(mockedMcpFetch).toHaveBeenNthCalledWith(4, expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/preview-url'),
    }));
  });

  test('check_deployment stops immediately on success without polling', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'check_deployment', input: {} }],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'report_to_user',
          input: { message: 'Done', status: 'success', preview_url: 'https://test.vercel.app' } }],
        stop_reason: 'tool_use'
      });

    // Pre-fetch, single check_deployment call (success — no retry), final preview refresh.
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValueOnce({ buildStatus: 'success', previewUrl: 'https://test.vercel.app' })
      .mockResolvedValueOnce({ buildStatus: 'success', previewUrl: 'https://test.vercel.app' });

    await runCodingAgent('update logo', draftContext);

    // Success state: no retry, with a final authoritative preview refresh.
    expect(mockedMcpFetch).toHaveBeenCalledTimes(3);
  });

  test('check_deployment stops immediately on error without retrying', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'check_deployment', input: {} }],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'report_to_user',
          input: { message: 'Build failed', status: 'error' } }],
        stop_reason: 'tool_use'
      });

    // Pre-fetch + single check_deployment call (error — no retry)
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValueOnce({ buildStatus: 'error', buildError: 'Module not found' });

    await runCodingAgent('update logo', draftContext);

    // Error state: no retry, mcpFetch called twice (pre-fetch + check_deployment)
    expect(mockedMcpFetch).toHaveBeenCalledTimes(2);
  });

  test('check_deployment stops immediately on not_found without retrying', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'check_deployment', input: {} }],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'report_to_user',
          input: { message: 'No deployment found', status: 'error' } }],
        stop_reason: 'tool_use'
      });

    // Pre-fetch + single check_deployment call (not_found — no retry)
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValueOnce({ buildStatus: 'not_found' });

    await runCodingAgent('update logo', draftContext);

    // not_found state: no retry, mcpFetch called twice (pre-fetch + check_deployment)
    expect(mockedMcpFetch).toHaveBeenCalledTimes(2);
  });

  test('check_deployment times out and returns building status after max retries', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'check_deployment', input: {} }],
        stop_reason: 'tool_use'
      })
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'report_to_user',
          input: { message: 'Build still in progress', status: 'error' } }],
        stop_reason: 'tool_use'
      });

    // Pre-fetch returns file listing; all subsequent calls return building
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValue({ buildStatus: 'building' });

    const result = await runCodingAgent('update logo', draftContext);

    // Should have called: 1 pre-fetch + 8 check_deployment polls = 9 total
    expect(mockedMcpFetch).toHaveBeenCalledTimes(9);
    // LLM should have received a tool result (even if building)
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });
});

// ─── applyLineNumberEdit tests ──────────────────────────────────────────────

describe('applyLineNumberEdit', () => {
  test('replaces a single line range correctly', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = applyLineNumberEdit(content, [
      { start_line: 2, end_line: 3, new_content: 'replaced2\nreplaced3' }
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('line1\nreplaced2\nreplaced3\nline4\nline5');
  });

  test('replaces multiple non-overlapping ranges', () => {
    const content = 'a\nb\nc\nd\ne';
    const result = applyLineNumberEdit(content, [
      { start_line: 1, end_line: 1, new_content: 'A' },
      { start_line: 5, end_line: 5, new_content: 'E' }
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(2);
    expect(result.result).toBe('A\nb\nc\nd\nE');
  });

  test('inserts content (more lines than replaced)', () => {
    const content = 'a\nb\nc';
    const result = applyLineNumberEdit(content, [
      { start_line: 2, end_line: 2, new_content: 'x\ny\nz' }
    ]);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('a\nx\ny\nz\nc');
  });

  test('deletes lines (empty new_content)', () => {
    const content = 'a\nb\nc\nd';
    const result = applyLineNumberEdit(content, [
      { start_line: 2, end_line: 3, new_content: '' }
    ]);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('a\nd');
  });

  test('returns error for out-of-bounds line numbers', () => {
    const content = 'a\nb\nc';
    const result = applyLineNumberEdit(content, [
      { start_line: 0, end_line: 1, new_content: 'x' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('out of range');
    expect(result.appliedCount).toBe(0);
  });

  test('returns error when end_line exceeds file length', () => {
    const content = 'a\nb\nc';
    const result = applyLineNumberEdit(content, [
      { start_line: 2, end_line: 10, new_content: 'x' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('out of range');
  });

  test('returns error when start_line > end_line', () => {
    const content = 'a\nb\nc';
    const result = applyLineNumberEdit(content, [
      { start_line: 3, end_line: 1, new_content: 'x' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.appliedCount).toBe(0);
  });

  test('validates expected_content when provided', () => {
    const content = 'line1\nline2\nline3';
    const result = applyLineNumberEdit(content, [
      { start_line: 2, end_line: 2, new_content: 'replaced', expected_content: 'line2' }
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('line1\nreplaced\nline3');
  });

  test('rejects edit when expected_content does not match', () => {
    const content = 'line1\nline2\nline3';
    const result = applyLineNumberEdit(content, [
      { start_line: 2, end_line: 2, new_content: 'replaced', expected_content: 'wrong content' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('does not match');
    expect(result.appliedCount).toBe(0);
    expect(result.result).toBe(content); // unchanged
  });

  test('creates new file — empty content with line 1-1 edit', () => {
    const result = applyLineNumberEdit('', [
      { start_line: 1, end_line: 1, new_content: 'export default function Page() {\n  return <div>Hello</div>;\n}' }
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('export default function Page() {\n  return <div>Hello</div>;\n}');
  });
});

describe('applySearchReplace — new file creation', () => {
  test('creates new file — empty search on empty content', () => {
    const result = applySearchReplace('', [
      { search: '', replace: 'const x = 1;\nexport default x;' }
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCount).toBe(1);
    expect(result.result).toBe('const x = 1;\nexport default x;');
  });

  test('rejects empty search on non-empty content', () => {
    const result = applySearchReplace('existing content', [
      { search: '', replace: 'new content' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('empty');
    expect(result.appliedCount).toBe(0);
  });
});

// ─── Model → provider routing ─────────────────────────────────────────────────
// Routing must send each model id to the client that can actually serve it:
// - anthropic.claude-opus-4-8 → Bedrock bearer-token client (separate AWS account)
// - other bare claude-* → Vertex
// - anthropic.* → Bedrock (default IAM credentials)
describe('runCodingAgent — model provider routing', () => {
  const mockContext: CodingAgentContext = {
    pageId: 'test-page-123',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-opus-4-8',
  };

  const bedrockCreate = jest.fn();
  const vertexCreate = jest.fn();
  const bearerCreate = jest.fn();
  let modelSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
    bedrockCreate.mockReset();
    vertexCreate.mockReset();
    bearerCreate.mockReset();
    _setBedrockClientForTest({ messages: { create: bedrockCreate } } as any);
    _setVertexClientForTest({ messages: { create: vertexCreate } } as any);
    _setBedrockBearerClientForTest({ messages: { create: bearerCreate } } as any);
    _setSleepFnForTest(async () => {});
    // Pre-flight list_files succeeds so the loop reaches the LLM call.
    mockedMcpFetch.mockResolvedValue({ files: [{ path: 'app/page.tsx', size: 100 }] });
    modelSpy = jest.spyOn(agentModeService, 'getCodingAgentDefaultModel');
  });

  afterEach(() => {
    modelSpy.mockRestore();
  });

  afterAll(() => {
    _setBedrockClientForTest(null);
    _setVertexClientForTest(null);
    _setBedrockBearerClientForTest(null);
  });

  test('routes Opus 4.8 (anthropic.claude-opus-4-8) to the Bedrock bearer client, not Vertex or default Bedrock', async () => {
    modelSpy.mockResolvedValue('anthropic.claude-opus-4-8');
    bearerCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Done.', status: 'success' } }],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('change the heading', mockContext);

    expect(result.success).toBe(true);
    expect(bearerCreate).toHaveBeenCalledTimes(1);
    expect(vertexCreate).not.toHaveBeenCalled();
    expect(bedrockCreate).not.toHaveBeenCalled();
    // The bare model id must be passed through to the bearer client unchanged;
    // the client maps it to the inference profile internally.
    expect(bearerCreate.mock.calls[0][0].model).toBe('anthropic.claude-opus-4-8');
  });

  test('routes a Vertex model (claude-sonnet-*) to the Vertex client, not Bedrock', async () => {
    modelSpy.mockResolvedValue('claude-sonnet-4-6');
    vertexCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Done.', status: 'success' } }],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('change the heading', mockContext);

    expect(result.success).toBe(true);
    expect(vertexCreate).toHaveBeenCalledTimes(1);
    expect(bedrockCreate).not.toHaveBeenCalled();
    expect(bearerCreate).not.toHaveBeenCalled();
    expect(vertexCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
  });

  test('routes a Bedrock model (anthropic.*) to the Bedrock client, not Vertex', async () => {
    modelSpy.mockResolvedValue('anthropic.claude-sonnet-4-6');
    bedrockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Done.', status: 'success' } }],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('change the heading', mockContext);

    expect(result.success).toBe(true);
    expect(bedrockCreate).toHaveBeenCalledTimes(1);
    expect(vertexCreate).not.toHaveBeenCalled();
    expect(bearerCreate).not.toHaveBeenCalled();
  });

  test('retries a transient 5xx from the Opus 4.8 bearer client, then succeeds', async () => {
    modelSpy.mockResolvedValue('anthropic.claude-opus-4-8');
    const transient: any = new Error('Bedrock (Opus 4.8) error 503: overloaded');
    transient.status = 503;
    bearerCreate
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Done.', status: 'success' } }],
        stop_reason: 'tool_use',
      });

    const result = await runCodingAgent('change the heading', mockContext);

    expect(result.success).toBe(true);
    expect(bearerCreate).toHaveBeenCalledTimes(2);
  });
});

// ─── Bedrock streaming: frame parser + accumulator ────────────────────────────
// The bearer-token Opus path streams `application/vnd.amazon.eventstream` frames.
// These tests build real frames (matching AWS framing) and verify we reconstruct
// the exact non-streaming Anthropic.Message shape the agent loop consumes.

/** Encode one eventstream frame. Layout: [totalLen][headersLen][preludeCRC][headers][payload][msgCRC].
 * The parser does not validate CRCs, so we zero them. Headers are string-typed (type 7). */
function encodeFrame(headers: Record<string, string>, payload: Buffer): Buffer {
  const headerParts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const valBuf = Buffer.from(value, 'utf8');
    const h = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
    let o = 0;
    h.writeUInt8(nameBuf.length, o); o += 1;
    nameBuf.copy(h, o); o += nameBuf.length;
    h.writeUInt8(7, o); o += 1; // string type
    h.writeUInt16BE(valBuf.length, o); o += 2;
    valBuf.copy(h, o);
    headerParts.push(h);
  }
  const headerBuf = Buffer.concat(headerParts);
  const totalLen = 4 + 4 + 4 + headerBuf.length + payload.length + 4;
  const frame = Buffer.alloc(totalLen);
  let o = 0;
  frame.writeUInt32BE(totalLen, o); o += 4;
  frame.writeUInt32BE(headerBuf.length, o); o += 4;
  frame.writeUInt32BE(0, o); o += 4; // prelude CRC (unchecked)
  headerBuf.copy(frame, o); o += headerBuf.length;
  payload.copy(frame, o); o += payload.length;
  frame.writeUInt32BE(0, o); // message CRC (unchecked)
  return frame;
}

/** Wrap a native Anthropic streaming event into a Bedrock "event/chunk" frame
 * (payload is JSON with a base64 `bytes` field), exactly as the live endpoint does. */
function chunkFrame(event: any): Buffer {
  const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') }), 'utf8');
  return encodeFrame({ ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' }, payload);
}

function streamFromBuffers(buffers: Buffer[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < buffers.length) controller.enqueue(new Uint8Array(buffers[i++]));
      else controller.close();
    },
  });
}

// A canonical text + tool_use event sequence, mirroring what the probe captured live.
const TEXT_AND_TOOL_EVENTS = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "I'll edit " } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the file.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"app/' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'page.tsx"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 10, outputTokenCount: 42 } },
];

describe('_parseEventStreamFrames', () => {
  test('parses a single complete frame and exposes its headers and payload', () => {
    const payload = Buffer.from('{"hello":"world"}', 'utf8');
    const frame = encodeFrame({ ':message-type': 'event', ':event-type': 'chunk' }, payload);
    const state = { buf: Buffer.alloc(0) };
    const frames = [..._parseEventStreamFrames(state, new Uint8Array(frame))];
    expect(frames).toHaveLength(1);
    expect(frames[0].headers[':message-type']).toBe('event');
    expect(frames[0].headers[':event-type']).toBe('chunk');
    expect(frames[0].payload.toString('utf8')).toBe('{"hello":"world"}');
    expect(state.buf.length).toBe(0);
  });

  test('buffers a partial frame split across chunks until complete', () => {
    const payload = Buffer.from('{"a":1}', 'utf8');
    const frame = encodeFrame({ ':message-type': 'event' }, payload);
    const state = { buf: Buffer.alloc(0) };
    const mid = Math.floor(frame.length / 2);
    // First half yields nothing (incomplete)
    expect([..._parseEventStreamFrames(state, new Uint8Array(frame.subarray(0, mid)))]).toHaveLength(0);
    // Second half completes it
    const frames = [..._parseEventStreamFrames(state, new Uint8Array(frame.subarray(mid)))];
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString('utf8')).toBe('{"a":1}');
  });

  test('parses two frames delivered in one chunk', () => {
    const f1 = encodeFrame({ ':message-type': 'event' }, Buffer.from('first', 'utf8'));
    const f2 = encodeFrame({ ':message-type': 'event' }, Buffer.from('second', 'utf8'));
    const state = { buf: Buffer.alloc(0) };
    const frames = [..._parseEventStreamFrames(state, new Uint8Array(Buffer.concat([f1, f2])))];
    expect(frames.map(f => f.payload.toString('utf8'))).toEqual(['first', 'second']);
  });
});

describe('_accumulateBedrockStream', () => {
  test('reconstructs a text + tool_use message from a streamed event sequence', async () => {
    const frames = TEXT_AND_TOOL_EVENTS.map(chunkFrame);
    const activity = jest.fn();
    const msg = await _accumulateBedrockStream(streamFromBuffers(frames), 'us.anthropic.claude-opus-4-8', activity);

    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: 'text', text: "I'll edit the file." });
    expect(msg.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { file_path: 'app/page.tsx' } });
    // usage from message_start should be merged with message_delta's output_tokens
    expect(msg.usage.output_tokens).toBe(42);
    // onActivity fires at least once per chunk read
    expect(activity).toHaveBeenCalled();
  });

  test('splitting frames mid-stream still reconstructs correctly (chunk boundaries are irrelevant)', async () => {
    const all = Buffer.concat(TEXT_AND_TOOL_EVENTS.map(chunkFrame));
    // Deliver the whole byte stream in 7-byte slices to stress the buffering path.
    const slices: Buffer[] = [];
    for (let i = 0; i < all.length; i += 7) slices.push(all.subarray(i, i + 7));
    const msg = await _accumulateBedrockStream(streamFromBuffers(slices), 'p', () => {});
    expect(msg.content[1]).toMatchObject({ name: 'edit_file', input: { file_path: 'app/page.tsx' } });
  });

  test('throws a retryable (5xx) error when the stream ends without message_start', async () => {
    await expect(
      _accumulateBedrockStream(streamFromBuffers([]), 'p', () => {})
    ).rejects.toMatchObject({ status: 500 });
  });

  test('surfaces a Bedrock throttling exception frame as a retryable 429', async () => {
    const start = chunkFrame(TEXT_AND_TOOL_EVENTS[0]);
    const exceptionFrame = encodeFrame(
      { ':message-type': 'exception', ':exception-type': 'ThrottlingException' },
      Buffer.from('{"message":"Too many requests"}', 'utf8')
    );
    await expect(
      _accumulateBedrockStream(streamFromBuffers([start, exceptionFrame]), 'p', () => {})
    ).rejects.toMatchObject({ status: 429 });
  });
});

// ─── Bearer client: abort surfaces as an honest timeout, not a generic error ──
describe('runCodingAgent — bearer-token request timeout surfacing', () => {
  const mockContext: CodingAgentContext = {
    pageId: 'p', userId: 'u', sessionId: 's', llmModel: 'anthropic.claude-opus-4-8',
  };
  let modelSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
    mockedMcpFetch.mockResolvedValue({ files: [{ path: 'app/page.tsx', size: 100 }] });
    _setSleepFnForTest(async () => {});
    modelSpy = jest.spyOn(agentModeService, 'getCodingAgentDefaultModel').mockResolvedValue('anthropic.claude-opus-4-8');
  });
  afterEach(() => { modelSpy.mockRestore(); _setBedrockBearerClientForTest(null); });

  test('a 408 timeout error from the client is reported (not retried into oblivion)', async () => {
    const timeoutErr: any = new Error('Bedrock (us.anthropic.claude-opus-4-8) request timed out after 120s of inactivity');
    timeoutErr.status = 408;
    timeoutErr.isTimeout = true;
    const bearerCreate = jest.fn().mockRejectedValue(timeoutErr);
    _setBedrockBearerClientForTest({ messages: { create: bearerCreate } } as any);

    const result = await runCodingAgent('edit the page', mockContext);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timed out|inactivity/i);
    // 408 is not in callWithRetry's retry set (only 429/5xx), so exactly one attempt.
    expect(bearerCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Page scope: pure helpers ─────────────────────────────────────────────────
// Many landing pages share ONE repo: a root page owns top-level app/ files and
// each other page is an app/<slug>/ route directory. The coding agent's file API
// is already physically confined to the one repo behind its pageId, so the
// editable boundary is the WHOLE repo (every route dir + shared files) — a run is
// free to edit any sibling route, since they are all one multi-route project.
describe('resolvePageScope', () => {
  const repo = 'https://github.com/acme/lp-every-io';
  const root = { id: 'root-1', isRootPage: true, githubRepoUrl: repo };
  const subA = { id: 'sub-a', slug: 'every-io-day-zero-pre-seed-fou', githubRepoUrl: repo };
  const subB = { id: 'sub-b', slug: 'every-io-seed-stage-founders', githubRepoUrl: repo };
  const otherRepo = { id: 'other-1', slug: 'unrelated', githubRepoUrl: 'https://github.com/acme/lp-other' };

  test('scope carries the page repo and the route slugs that live in it', () => {
    const scope = resolvePageScope(subA, [root, subA, subB]);
    expect(scope.repoUrl).toBe(repo);
    expect(scope.routeSlugs.sort()).toEqual([subA.slug, subB.slug].sort());
  });

  test('only counts pages in the SAME repo as routes (ignores the owner\'s other repos)', () => {
    const scope = resolvePageScope(subA, [root, subA, subB, otherRepo]);
    expect(scope.routeSlugs).not.toContain('unrelated');
    expect(scope.routeSlugs.sort()).toEqual([subA.slug, subB.slug].sort());
  });

  test('deduplicates route slugs and drops blanks', () => {
    const scope = resolvePageScope(subA, [
      subA,
      subB,
      { id: 'sub-c', slug: 'every-io-seed-stage-founders', githubRepoUrl: repo }, // dup slug
      { id: 'sub-d', slug: '', githubRepoUrl: repo }, // blank (root-ish)
    ]);
    expect(scope.routeSlugs.sort()).toEqual([subA.slug, subB.slug].sort());
  });
});

// A repo-wide scope: the agent may edit ANY file in its own repo (all route dirs
// plus shared files). The only paths rejected are unsafe ones that escape the
// repo (absolute paths, parent traversal).
describe('isSafeRepoPath', () => {
  test('allows this page\'s own route directory', () => {
    expect(isSafeRepoPath('app/my-page/page.tsx')).toBe(true);
    expect(isSafeRepoPath('app/my-page/_components/landing/TrustBar.tsx')).toBe(true);
  });

  test('allows OTHER route directories in the same multi-route project', () => {
    // The exact case from the report: editing a sibling route's lead-capture form.
    expect(isSafeRepoPath('app/every-io-series-a-scaling/_components/lead-capture-form.tsx')).toBe(true);
    expect(isSafeRepoPath('app/other-page/page.tsx')).toBe(true);
  });

  test('allows shared components and root-level files', () => {
    expect(isSafeRepoPath('components/landing/trust-bar.tsx')).toBe(true);
    expect(isSafeRepoPath('app/layout.tsx')).toBe(true);
    expect(isSafeRepoPath('app/globals.css')).toBe(true);
    expect(isSafeRepoPath('app/page.tsx')).toBe(true);
  });

  test('normalizes leading ./ and / and backslashes', () => {
    expect(isSafeRepoPath('./app/my-page/page.tsx')).toBe(true);
    expect(isSafeRepoPath('/app/my-page/page.tsx')).toBe(true);
    expect(isSafeRepoPath('app\\my-page\\page.tsx')).toBe(true);
  });

  test('rejects empty paths', () => {
    expect(isSafeRepoPath('')).toBe(false);
    expect(isSafeRepoPath('   ')).toBe(false);
  });

  test('rejects paths that escape the repo via parent traversal', () => {
    expect(isSafeRepoPath('../secrets.txt')).toBe(false);
    expect(isSafeRepoPath('app/../../etc/passwd')).toBe(false);
    expect(isSafeRepoPath('app/my-page/../../../outside.tsx')).toBe(false);
  });
});

describe('buildScopeSystemClause', () => {
  const repo = 'https://github.com/acme/lp-every-io';

  test('lists the project\'s routes and keeps the "only the change asked for" guidance', () => {
    const clause = buildScopeSystemClause({
      repoUrl: repo,
      routeSlugs: ['every-io-day-zero-pre-seed-fou', 'every-io-series-a-scaling'],
    });
    // All routes named so the agent knows it may edit across them.
    expect(clause).toContain('app/every-io-day-zero-pre-seed-fou/');
    expect(clause).toContain('app/every-io-series-a-scaling/');
    // Anti-overreach guidance from PR #1739 is preserved (soft, not a route lockout).
    expect(clause).toMatch(/only the specific change/i);
  });

  test('handles a single-route / no-extra-routes project without crashing', () => {
    const clause = buildScopeSystemClause({ repoUrl: repo, routeSlugs: [] });
    expect(typeof clause).toBe('string');
    expect(clause).toMatch(/only the specific change/i);
  });
});

// ─── Page scope: enforcement in the agent loop ────────────────────────────────
describe('runCodingAgent — scope enforcement', () => {
  const scopedContext: CodingAgentContext = {
    pageId: 'sub-a',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-sonnet-4-6',
    draftBranch: 'draft/abc12345',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
    mockCreate.mockReset();
    mockGetLandingPageById.mockReset();
    mockGetLandingPagesByOwner.mockReset();
    _setBedrockClientForTest(mockClient);
    _setSleepFnForTest(async () => {});
    // The page under edit is one route of a multi-route project; a sibling route
    // shares the SAME repo, so it is in-scope and editable.
    const repo = 'https://github.com/acme/lp-every-io';
    mockGetLandingPageById.mockResolvedValue({ id: 'sub-a', userId: 'user-456', slug: 'my-page', githubRepoUrl: repo });
    mockGetLandingPagesByOwner.mockResolvedValue([
      { id: 'sub-a', userId: 'user-456', slug: 'my-page', githubRepoUrl: repo },
      { id: 'sub-b', userId: 'user-456', slug: 'other-page', githubRepoUrl: repo },
    ]);
  });

  afterAll(() => {
    _setBedrockClientForTest(null);
  });

  test('allows an edit to a SIBLING route in the same multi-route project', async () => {
    // Regression for the report: editing another route's file in the same repo
    // must go through (PR #1739 wrongly blocked this).
    mockedMcpFetch.mockResolvedValueOnce({
      files: [
        { path: 'app/my-page/page.tsx', size: 1000 },
        { path: 'app/other-page/_components/lead-capture-form.tsx', size: 1000 },
      ],
    });

    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
          file_path: 'app/other-page/_components/lead-capture-form.tsx',
          edits: [{ search: '<button>', replace: '<button type="submit">' }],
        }}
      ],
      stop_reason: 'tool_use'
    });
    // edit_file: GET current content, then PUT
    mockedMcpFetch
      .mockResolvedValueOnce({ content: '<button>' })
      .mockResolvedValueOnce({ success: true, is_staging: true, commit_url: 'https://github.com/x/commit/abc' });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Aligned the submit button.', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('align the series A submit button', scopedContext);

    expect(result.success).toBe(true);
    const putCalls = mockedMcpFetch.mock.calls.filter(c => c[0]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    expect((putCalls[0][0] as any).body.file_path).toBe('app/other-page/_components/lead-capture-form.tsx');
  });

  test('allows an edit inside the page\'s own directory', async () => {
    // Pre-fetch list_files
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/my-page/page.tsx', size: 1000 }] });

    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
          file_path: 'app/my-page/_components/landing/TrustBar.tsx',
          edits: [{ search: '<img src="placeholder" />', replace: '<img src="https://logo" />' }],
        }}
      ],
      stop_reason: 'tool_use'
    });
    // edit_file: GET current content, then PUT
    mockedMcpFetch
      .mockResolvedValueOnce({ content: '<img src="placeholder" />' })
      .mockResolvedValueOnce({ success: true, is_staging: true, commit_url: 'https://github.com/x/commit/abc' });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Logo updated.', status: 'success' } }
      ],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('replace the placeholder logo', scopedContext);

    expect(result.success).toBe(true);
    const putCalls = mockedMcpFetch.mock.calls.filter(c => c[0]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    expect((putCalls[0][0] as any).body.file_path).toBe('app/my-page/_components/landing/TrustBar.tsx');
  });

  test('blocks a write that escapes the repo via parent traversal', async () => {
    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/my-page/page.tsx', size: 1000 }] });

    // LLM tries to write outside the repo entirely.
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
          file_path: '../../etc/passwd',
          edits: [{ search: 'a', replace: 'b' }],
        }}
      ],
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'Cannot write there.', status: 'error' } }
      ],
      stop_reason: 'tool_use'
    });

    await runCodingAgent('write outside the repo', scopedContext);

    // No PUT, and the file-content GET never happened either — only the pre-fetch.
    const putCalls = mockedMcpFetch.mock.calls.filter(c => c[0]?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
    expect(mockedMcpFetch).toHaveBeenCalledTimes(1);

    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
    );
    const trBlock = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(trBlock.content).toMatch(/outside the repository|cannot/i);
  });

  test('shows the full repo file listing and injects the scope clause into the system prompt', async () => {
    mockedMcpFetch.mockResolvedValueOnce({
      files: [
        { path: 'app/my-page/page.tsx', size: 1000 },
        { path: 'app/other-page/page.tsx', size: 1000 },
        { path: 'components/landing/trust-bar.tsx', size: 500 },
      ],
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'done', status: 'success' } }],
      stop_reason: 'tool_use'
    });

    await runCodingAgent('do something', scopedContext);

    const firstCall = mockCreate.mock.calls[0][0];
    // System prompt names the project's routes and keeps the anti-overreach guidance.
    expect(firstCall.system).toContain('app/my-page/');
    expect(firstCall.system).toContain('app/other-page/');
    expect(firstCall.system).toMatch(/only the specific change/i);
    // The user message's file listing now shows the WHOLE repo — all routes + shared.
    const userMsg = firstCall.messages.find((m: any) => m.role === 'user');
    const userText = typeof userMsg.content === 'string'
      ? userMsg.content
      : userMsg.content.map((b: any) => b.text || '').join('');
    expect(userText).toContain('app/my-page/page.tsx');
    expect(userText).toContain('app/other-page/page.tsx');
    expect(userText).toContain('components/landing/trust-bar.tsx');
  });

  test('still edits normally when the page record is not found (unrestricted fallback)', async () => {
    // No page record → scope undefined → still unrestricted (safe-path guard only).
    mockGetLandingPageById.mockResolvedValue(null);

    mockedMcpFetch.mockResolvedValueOnce({ files: [{ path: 'app/anything.tsx', size: 100 }] });
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: {
          file_path: 'app/other-page/page.tsx',
          edits: [{ search: 'a', replace: 'b' }],
        }}
      ],
      stop_reason: 'tool_use'
    });
    mockedMcpFetch
      .mockResolvedValueOnce({ content: 'a' })
      .mockResolvedValueOnce({ success: true, is_staging: true });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_2', name: 'report_to_user', input: { message: 'done', status: 'success' } }],
      stop_reason: 'tool_use'
    });

    const result = await runCodingAgent('edit anything', scopedContext);

    expect(result.success).toBe(true);
    const putCalls = mockedMcpFetch.mock.calls.filter(c => c[0]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
  });
});

// ─── GitHub error helpers (ENG-159) ───────────────────────────────────────────

describe('_isMissingGithubRefError', () => {
  test('treats 404 as a missing ref', () => {
    expect(_isMissingGithubRefError(githubAxiosError(404, { message: 'Not Found' }))).toBe(true);
  });

  test('treats 422 "Reference does not exist" as a missing ref (Update-a-reference endpoint)', () => {
    expect(_isMissingGithubRefError(githubAxiosError(422, { message: 'Reference does not exist' }))).toBe(true);
  });

  test('treats 422 with a nested "does not exist" error entry as a missing ref', () => {
    const err = githubAxiosError(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Reference', code: 'custom', message: 'Reference does not exist' }],
    });
    expect(_isMissingGithubRefError(err)).toBe(true);
  });

  test('does NOT treat an unrelated 422 as a missing ref', () => {
    expect(_isMissingGithubRefError(githubAxiosError(422, { message: 'sha is not a commit' }))).toBe(false);
  });

  test('does NOT treat a 500 as a missing ref', () => {
    expect(_isMissingGithubRefError(githubAxiosError(500, { message: 'Server Error' }))).toBe(false);
  });

  test('handles a non-axios error without throwing', () => {
    expect(_isMissingGithubRefError(new Error('boom'))).toBe(false);
  });
});

describe('_describeGithubError', () => {
  test('surfaces the GitHub message and status instead of a bare axios string', () => {
    const detail = _describeGithubError(
      githubAxiosError(422, { message: 'Reference does not exist' }),
      'reset the preview branch',
    );
    expect(detail).toContain('HTTP 422');
    expect(detail).toContain('Reference does not exist');
    expect(detail).not.toBe('Request failed with status code 422');
  });

  test('includes nested validation error messages', () => {
    const detail = _describeGithubError(
      githubAxiosError(422, { message: 'Validation Failed', errors: [{ message: 'sha is not a commit' }] }),
      'reset the preview branch',
    );
    expect(detail).toContain('sha is not a commit');
  });

  test('falls back to the error message when there is no response body', () => {
    expect(_describeGithubError(new Error('network down'), 'read the repo main branch')).toContain('network down');
  });
});

// ─── Preview-branch reset: 422 missing-ref recovery (ENG-159) ─────────────────

describe('runCodingAgent — preview-branch reset resilience', () => {
  const previewContext: CodingAgentContext = {
    pageId: 'test-page-123',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-sonnet-4-6',
    draftBranch: LANDING_PAGE_PREVIEW_BRANCH,
  };

  const editablePage = {
    id: 'test-page-123',
    githubRepoUrl: 'https://github.com/AgentWebPro/lp-free-ai-seo-geo-audit-37343865',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
    mockCreate.mockReset();
    _setBedrockClientForTest(mockClient);
    _setSleepFnForTest(async () => {});
    // Page exists and is editable by the caller so we reach the reset path.
    mockGetLandingPageById.mockResolvedValue(editablePage);
    mockGetLandingPagesByOwner.mockResolvedValue([]);
    mockCanUserEditLandingPage.mockResolvedValue(true);
    mockedAxios.get.mockReset();
    mockedAxios.patch.mockReset();
    mockedAxios.post.mockReset();
  });

  afterAll(() => {
    _setBedrockClientForTest(null);
  });

  test('creates the branch when GitHub returns 422 "Reference does not exist" (was: every edit 422s)', async () => {
    // main ref read OK, PATCH update fails because the draft branch is absent
    // (GitHub reports this as 422, not 404), create succeeds.
    mockedAxios.get.mockResolvedValueOnce({ data: { object: { sha: 'main-sha-abc' } } } as any);
    mockedAxios.patch.mockRejectedValueOnce(githubAxiosError(422, { message: 'Reference does not exist' }));
    mockedAxios.post.mockResolvedValueOnce({ data: {} } as any);

    // After a successful reset the agent proceeds; report success immediately.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Edited the logo.', status: 'success' } }],
      stop_reason: 'tool_use',
    });

    const result = await runCodingAgent('swap the logo image', previewContext);

    // The branch was created (fell through to POST) rather than failing.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/git/refs'),
      expect.objectContaining({ ref: `refs/heads/${LANDING_PAGE_PREVIEW_BRANCH}` }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
    expect(result.message).not.toContain('status code 422');
  });

  test('surfaces the real GitHub 422 detail (not a bare status code) on a genuine rejection', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { object: { sha: 'main-sha-abc' } } } as any);
    mockedAxios.patch.mockRejectedValueOnce(
      githubAxiosError(422, { message: 'Validation Failed', errors: [{ message: 'sha is not a commit' }] }),
    );

    const result = await runCodingAgent('swap the logo image', previewContext);

    // Genuine (non-missing-ref) 422 → run fails but the message carries the
    // actual GitHub detail so the caller can act on it (ENG-159 request a).
    expect(result.success).toBe(false);
    expect(result.message).toContain('sha is not a commit');
    expect(result.message).not.toBe('Request failed with status code 422');
    expect(result.retryable).toBe(true);
    // Did NOT try to create the branch for a non-missing-ref error.
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  test('surfaces the real GitHub detail when reading the main ref fails (GET rejects)', async () => {
    // GET main ref fails outright → the catch must surface the actual GitHub
    // detail, not a bare status code (codingAgentService.ts GET catch).
    mockedAxios.get.mockRejectedValueOnce(githubAxiosError(500, { message: 'Service Unavailable' }));

    const result = await runCodingAgent('swap the logo image', previewContext);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Service Unavailable');
    expect(result.message).not.toBe('Request failed with status code 500');
    // Never got far enough to update or create the branch.
    expect(mockedAxios.patch).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  test('surfaces the real GitHub detail when creating the branch fails (POST rejects after missing-ref fallthrough)', async () => {
    // main ref read OK, PATCH fails with a missing-ref 422 (falls through to
    // create), but the POST create itself fails → surface the POST detail, not
    // a bare status code (codingAgentService.ts POST catch).
    mockedAxios.get.mockResolvedValueOnce({ data: { object: { sha: 'main-sha-abc' } } } as any);
    mockedAxios.patch.mockRejectedValueOnce(githubAxiosError(422, { message: 'Reference does not exist' }));
    mockedAxios.post.mockRejectedValueOnce(
      githubAxiosError(422, { message: 'Validation Failed', errors: [{ message: 'Reference already exists' }] }),
    );

    const result = await runCodingAgent('swap the logo image', previewContext);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Reference already exists');
    expect(result.message).not.toBe('Request failed with status code 422');
  });
});

// ─── Preview-branch reset: preserve unpublished sequential edits (ENG-176) ─────

describe('runCodingAgent — sequential edits do not clobber (ENG-176)', () => {
  const previewContext: CodingAgentContext = {
    pageId: 'test-page-123',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-sonnet-4-6',
    draftBranch: LANDING_PAGE_PREVIEW_BRANCH,
  };

  const editablePage = {
    id: 'test-page-123',
    githubRepoUrl: 'https://github.com/AgentWebPro/lp-free-ai-seo-geo-audit-37343865',
  };

  const reportSuccess = () =>
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'report_to_user', input: { message: 'Added the book card.', status: 'success' } }],
      stop_reason: 'tool_use',
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
    mockCreate.mockReset();
    _setBedrockClientForTest(mockClient);
    _setSleepFnForTest(async () => {});
    mockGetLandingPageById.mockResolvedValue(editablePage);
    mockGetLandingPagesByOwner.mockResolvedValue([]);
    mockCanUserEditLandingPage.mockResolvedValue(true);
    mockedAxios.get.mockReset();
    mockedAxios.patch.mockReset();
    mockedAxios.post.mockReset();
  });

  afterAll(() => {
    _setBedrockClientForTest(null);
  });

  test('does NOT reset the preview branch when it has unpublished commits ahead of main', async () => {
    // A previous coding_agent run already added the first book card to the
    // preview branch (1 unpublished commit ahead of main) and it was never
    // published. The second edit must layer on top — NOT force-reset to main,
    // which would discard the first book. This is the exact ENG-176 clobber.
    mockedAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: 'main-sha-abc' } } } as any) // main ref
      .mockResolvedValueOnce({ data: { status: 'ahead', ahead_by: 1, behind_by: 0 } } as any); // compare main...preview
    reportSuccess();

    const result = await runCodingAgent('append a second book card', previewContext);

    // The reusable branch was preserved: no reset (PATCH) and no re-create (POST).
    expect(mockedAxios.patch).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
    // The ahead-check hit the correct compare endpoint (main...<encoded preview>).
    // If URL construction ever broke, the compare would 404, be read as "0 ahead
    // → reset", and silently reintroduce the clobber — so assert it explicitly.
    expect(mockedAxios.get).toHaveBeenLastCalledWith(
      expect.stringContaining('/compare/main...draft%2Fagentweb-preview'),
      expect.anything(),
    );
    expect(result.success).toBe(true);
  });

  test('resets the preview branch to main when it is not ahead (fully published / identical)', async () => {
    // No unpublished work on the branch → safe to reset to the latest main so
    // the edit starts from the freshest published state (original behavior).
    mockedAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: 'main-sha-abc' } } } as any) // main ref
      .mockResolvedValueOnce({ data: { status: 'identical', ahead_by: 0, behind_by: 0 } } as any); // compare
    mockedAxios.patch.mockResolvedValueOnce({ data: {} } as any);
    reportSuccess();

    const result = await runCodingAgent('edit the hero', previewContext);

    expect(mockedAxios.patch).toHaveBeenCalledTimes(1);
    expect(mockedAxios.patch).toHaveBeenCalledWith(
      expect.stringContaining(`/git/refs/heads/${LANDING_PAGE_PREVIEW_BRANCH}`),
      expect.objectContaining({ sha: 'main-sha-abc', force: true }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
  });
});

describe('_previewBranchCommitsAheadOfMain', () => {
  const repoBase = 'https://api.github.com/repos/AgentWebPro/lp-example';
  const headers = { Authorization: 'Bearer x', Accept: 'application/vnd.github.v3+json' };

  beforeEach(() => {
    mockedAxios.get.mockReset();
  });

  test('returns the ahead count when the branch has unpublished commits', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { status: 'ahead', ahead_by: 2, behind_by: 0 } } as any);
    await expect(_previewBranchCommitsAheadOfMain(repoBase, headers)).resolves.toBe(2);
    // Guard the single safety-critical call: a broken URL (wrong encoding/ref
    // order/path) would 404, be read as "0 ahead → reset", and silently
    // reintroduce the ENG-176 clobber while every other assertion still passed.
    expect(mockedAxios.get).toHaveBeenLastCalledWith(
      expect.stringContaining('/compare/main...draft%2Fagentweb-preview'),
      expect.objectContaining({ headers }),
    );
  });

  test('returns 0 when identical to main', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { status: 'identical', ahead_by: 0, behind_by: 0 } } as any);
    await expect(_previewBranchCommitsAheadOfMain(repoBase, headers)).resolves.toBe(0);
  });

  test('returns 0 when the preview branch does not exist yet (404)', async () => {
    mockedAxios.get.mockRejectedValueOnce(githubAxiosError(404, { message: 'Not Found' }));
    await expect(_previewBranchCommitsAheadOfMain(repoBase, headers)).resolves.toBe(0);
  });

  test('fails CLOSED (treats branch as ahead) on a transient comparison error so unpublished work is never clobbered', async () => {
    // A 5xx/timeout/rate-limit must NOT be read as "0 ahead → safe to reset":
    // that would let a transient GitHub hiccup force-reset the preview branch to
    // main and destroy genuine unpublished edits (the ENG-176 clobber). Fail
    // closed by reporting the branch as ahead so the caller skips the reset.
    mockedAxios.get.mockRejectedValueOnce(githubAxiosError(500, { message: 'Service Unavailable' }));
    await expect(_previewBranchCommitsAheadOfMain(repoBase, headers)).resolves.toBeGreaterThan(0);
  });
});

describe('_rollbackEditedFiles (Greptile: new files must be deleted, not "reverted")', () => {
  const rollbackContext: CodingAgentContext = {
    pageId: 'test-page-123',
    userId: 'user-456',
    sessionId: 'session-789',
    llmModel: 'anthropic.claude-sonnet-4-6',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
  });

  test('succeeds normally when the file existed at the base commit (real content to revert to)', async () => {
    mockedMcpFetch
      .mockResolvedValueOnce({ content: '<h1>Old</h1>' }) // file-at-commit: existed
      .mockResolvedValueOnce({ success: true, commit_url: 'https://github.com/test/repo/commit/abc' }); // github-edit write

    const result = await _rollbackEditedFiles({
      context: rollbackContext,
      baseCommitSha: 'base-sha',
      editedFiles: ['app/page.tsx'],
    });

    expect(result.status).toBe('succeeded');
  });

  test('a brand-new file (nothing at the base commit) is DELETED instead of left committed', async () => {
    mockedMcpFetch
      .mockResolvedValueOnce({ content: undefined }) // file-at-commit: 404-equivalent, nothing there
      .mockResolvedValueOnce({ success: true }); // update-files delete

    const result = await _rollbackEditedFiles({
      context: rollbackContext,
      baseCommitSha: 'base-sha',
      editedFiles: ['app/api/new-route/route.ts'],
    });

    expect(result.status).toBe('succeeded');
    const deleteCall = mockedMcpFetch.mock.calls[1][0] as any;
    expect(deleteCall.method).toBe('PUT');
    expect(deleteCall.path).toBe('/api/landing-pages/v0/generated/test-page-123/update-files');
    expect(deleteCall.body.files).toEqual([{ file_path: 'app/api/new-route/route.ts', deleted: true }]);
  });

  test('reports FAILURE (not a false success) when deleting the new file itself fails', async () => {
    mockedMcpFetch
      .mockResolvedValueOnce({ content: undefined }) // file-at-commit: nothing there
      .mockResolvedValueOnce({ success: false }); // update-files delete failed

    const result = await _rollbackEditedFiles({
      context: rollbackContext,
      baseCommitSha: 'base-sha',
      editedFiles: ['app/api/new-route/route.ts'],
    });

    expect(result.status).toBe('failed');
  });

  test('a genuine transient failure (not "file doesn\'t exist") is reported as failed, NEVER treated as a new file / deleted', async () => {
    mockedMcpFetch.mockRejectedValueOnce(new Error('API error (500): GitHub is down'));

    const result = await _rollbackEditedFiles({
      context: rollbackContext,
      baseCommitSha: 'base-sha',
      editedFiles: ['app/page.tsx'],
    });

    expect(result.status).toBe('failed');
    // Only the one failed file-at-commit call — no delete attempt for a file that
    // might genuinely still exist and need real content restored, not deletion.
    expect(mockedMcpFetch).toHaveBeenCalledTimes(1);
  });
});
