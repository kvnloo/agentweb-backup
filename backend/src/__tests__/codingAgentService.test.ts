import { applySearchReplace, applyLineNumberEdit, runCodingAgent, CodingAgentContext, _setBedrockClientForTest, _setVertexClientForTest, _setBedrockBearerClientForTest, _setSleepFnForTest } from '../services/codingAgentService';
import { agentModeService } from '../services/agentModeService';

// Mock mcpFetch
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn()
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

    // Pre-fetch file listing, then two check_deployment polls
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValueOnce({ buildStatus: 'building' })
      .mockResolvedValueOnce({ buildStatus: 'success', previewUrl: 'https://test.vercel.app' });

    await runCodingAgent('update logo', draftContext);

    // Verify polling happened: mcpFetch called 3 times (pre-fetch + 2 check_deployment polls)
    expect(mockedMcpFetch).toHaveBeenCalledTimes(3);
    expect(mockedMcpFetch).toHaveBeenNthCalledWith(3, expect.objectContaining({
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

    // Pre-fetch + single check_deployment call (success — no retry)
    mockedMcpFetch
      .mockResolvedValueOnce({ files: [{ path: 'app/page.tsx', size: 2000 }] })
      .mockResolvedValueOnce({ buildStatus: 'success', previewUrl: 'https://test.vercel.app' });

    await runCodingAgent('update logo', draftContext);

    // Success state: no retry, mcpFetch called twice (pre-fetch + check_deployment)
    expect(mockedMcpFetch).toHaveBeenCalledTimes(2);
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
