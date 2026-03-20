import { applySearchReplace, runCodingAgent, CodingAgentContext } from '../services/codingAgentService';

// Mock mcpFetch
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn()
}));

import { mcpFetch } from '../mcp/server/httpClient';
const mockedMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

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

  // Mock callLLM function
  const mockCallLLM = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockedMcpFetch.mockReset();
  });

  // --- FAIL CASES ---

  test('returns partial result when max iterations reached', async () => {
    // LLM always returns a tool call, never terminates
    mockCallLLM.mockResolvedValue({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc_1',
            type: 'function',
            function: { name: 'list_files', arguments: '{}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    });
    mockedMcpFetch.mockResolvedValue({ files: [{ path: 'app/page.tsx', size: 1000 }] });

    const result = await runCodingAgent('edit the page', mockContext, mockCallLLM, 3); // max 3 iterations

    expect(result.success).toBe(false);
    expect(result.message).toContain('maximum');
    expect(result.iterations).toBe(3);
  });

  test('handles LLM call errors gracefully', async () => {
    mockCallLLM.mockRejectedValue(new Error('Bedrock timeout'));

    const result = await runCodingAgent('edit something', mockContext, mockCallLLM);

    expect(result.success).toBe(false);
    expect(result.message).toContain('error');
  });

  test('edit_file returns error when edits array is empty', async () => {
    // First call: LLM calls edit_file with empty edits
    mockCallLLM
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({ file_path: 'app/page.tsx', edits: [] })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      })
      // Second call: LLM gives up and reports
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_2',
              type: 'function',
              function: {
                name: 'report_to_user',
                arguments: JSON.stringify({ message: 'Edit failed', status: 'error' })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });

    const result = await runCodingAgent('edit page', mockContext, mockCallLLM);

    // The agent should have received the validation error and reported back
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  // --- SUCCESS CASES ---

  test('returns immediately when LLM calls report_to_user', async () => {
    mockCallLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc_1',
            type: 'function',
            function: {
              name: 'report_to_user',
              arguments: JSON.stringify({ message: 'All changes applied successfully!', status: 'success' })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    });

    const result = await runCodingAgent('fix the bug', mockContext, mockCallLLM);

    expect(result.success).toBe(true);
    expect(result.message).toBe('All changes applied successfully!');
    expect(result.iterations).toBe(1);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  test('multi-iteration: read_file then edit_file then report_to_user', async () => {
    // Iteration 1: LLM calls read_file
    mockCallLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: 'Let me read the file first.',
          tool_calls: [{
            id: 'tc_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ file_path: 'app/page.tsx' })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    });
    // read_file mcpFetch returns file content
    mockedMcpFetch.mockResolvedValueOnce({
      path: 'app/page.tsx',
      content: '<h1>Old Title</h1>\n<p>Some text</p>',
      sha: 'abc123'
    });

    // Iteration 2: LLM calls edit_file
    mockCallLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc_2',
            type: 'function',
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({
                file_path: 'app/page.tsx',
                edits: [{ search: '<h1>Old Title</h1>', replace: '<h1>New Title</h1>' }],
                commit_message: 'Update heading'
              })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
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
    mockCallLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc_3',
            type: 'function',
            function: {
              name: 'report_to_user',
              arguments: JSON.stringify({ message: 'Updated heading from Old Title to New Title.', status: 'success' })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    });

    const result = await runCodingAgent('Change the heading to New Title', mockContext, mockCallLLM);

    expect(result.success).toBe(true);
    expect(result.message).toContain('New Title');
    expect(result.iterations).toBe(3);
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
  });

  test('returns text response when LLM responds without tool calls', async () => {
    mockCallLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: 'I cannot make that change because the file does not exist.',
          tool_calls: undefined
        },
        finish_reason: 'stop'
      }]
    });

    const result = await runCodingAgent('edit nonexistent file', mockContext, mockCallLLM);

    expect(result.success).toBe(true);
    expect(result.message).toContain('does not exist');
    expect(result.iterations).toBe(1);
  });

  test('list_files tool returns file listing', async () => {
    // LLM calls list_files then report_to_user
    mockCallLLM
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_1',
              type: 'function',
              function: { name: 'list_files', arguments: '{}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_2',
              type: 'function',
              function: {
                name: 'report_to_user',
                arguments: JSON.stringify({ message: 'Found 3 files.', status: 'success' })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });

    mockedMcpFetch.mockResolvedValueOnce({
      files: [
        { path: 'app/page.tsx', size: 5000 },
        { path: 'app/globals.css', size: 2000 },
        { path: 'package.json', size: 500 }
      ],
      repo: 'org/repo'
    });

    const result = await runCodingAgent('list all files', mockContext, mockCallLLM);

    expect(result.success).toBe(true);
    expect(mockedMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: expect.stringContaining('/files')
    }));
  });
});
