// Unit tests for MCP-wrapped tool result content extraction.
//
// Root cause context: tools registered via mcpToolRegistry use jsonResult() which wraps
// data in { content: [{ type: 'text', text: '...' }] }. Previously, agentModeService
// stored this in S3 via JSON.stringify(result), causing double-escaping: field names
// like "sessionId" became \"sessionId\" in the S3 file, making search_tool_response
// return 0 matches for those fields.
//
// The fix extracts result.content[0].text directly (the inner text) when available,
// avoiding the double-escaping.

import { extractToolContent } from '../services/agentModeService';

describe('extractToolContent', () => {
  // ── FAIL tests (invalid / edge / error paths) ────────────────────────────

  it('should return the string as-is when result is already a string', () => {
    const result = '{"sessions":[{"sessionId":"abc"}]}';
    expect(extractToolContent(result)).toBe(result);
  });

  it('should JSON.stringify plain objects that have no formattedContent or content[0].text', () => {
    const result = { success: true, message: 'done' };
    expect(extractToolContent(result)).toBe(JSON.stringify(result));
  });

  it('should fall through to JSON.stringify when content is a string (legacy format)', () => {
    const result = { content: 'some string content' };
    expect(extractToolContent(result)).toBe(JSON.stringify(result));
  });

  it('should fall through to JSON.stringify when content array is empty', () => {
    const result = { content: [] };
    expect(extractToolContent(result)).toBe(JSON.stringify(result));
  });

  it('should fall through to JSON.stringify when content[0].text is empty string', () => {
    const result = { content: [{ type: 'text', text: '' }] };
    // empty string is falsy — falls through
    expect(extractToolContent(result)).toBe(JSON.stringify(result));
  });

  it('should fall through to JSON.stringify when content[0] has no text field', () => {
    const result = { content: [{ type: 'image', data: 'base64data' }] };
    expect(extractToolContent(result)).toBe(JSON.stringify(result));
  });

  // ── SUCCESS test (happy path) ────────────────────────────────────────────

  it('should return content[0].text directly for MCP-wrapped results (avoids double-escaping)', () => {
    const innerJson = JSON.stringify({ sessions: [{ sessionId: 'abc-123', score: 3 }] });
    const mcpResult = { content: [{ type: 'text', text: innerJson }] };

    const output = extractToolContent(mcpResult);

    // Must be the raw inner text, NOT JSON.stringify of the whole wrapper
    expect(output).toBe(innerJson);
    // The output must NOT contain double-escaped quotes like \"sessionId\"
    expect(output).not.toContain('\\"sessionId\\"');
    // The output must contain the plain field names
    expect(output).toContain('"sessionId"');
    expect(output).toContain('"score"');
  });

  it('should prefer formattedContent over content[0].text when both are present', () => {
    const formatted = 'Human readable sessions summary';
    const innerJson = JSON.stringify({ sessions: [{ sessionId: 'abc' }] });
    const result = {
      formattedContent: formatted,
      content: [{ type: 'text', text: innerJson }],
    };

    expect(extractToolContent(result)).toBe(formatted);
  });

  it('should use formattedContent over JSON.stringify for tools that provide it', () => {
    const result = { formattedContent: 'GTM Plan: ...\nPhases: ...' };
    expect(extractToolContent(result)).toBe('GTM Plan: ...\nPhases: ...');
  });

  it('should handle multi-item content arrays by using the first text item', () => {
    const innerJson = '{"count":5}';
    const result = {
      content: [
        { type: 'text', text: innerJson },
        { type: 'text', text: 'second item' },
      ],
    };
    expect(extractToolContent(result)).toBe(innerJson);
  });
});
