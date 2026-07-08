/**
 * extractToolContent — normalize a tool result into the string stored on the
 * tool-role message / S3 ledger for LLM consumption.
 *
 * Tools registered via mcpToolRegistry use jsonResult() which wraps their output in the MCP
 * format: { content: [{ type: 'text', text: '<actual JSON>' }] }. If we store the entire
 * wrapper via JSON.stringify(), the inner JSON becomes double-escaped in S3: field names like
 * "sessionId" are stored as \"sessionId\", causing search_tool_response to return 0 matches.
 *
 * Priority: formattedContent > content[0].text (MCP inner text) > JSON.stringify fallback.
 *
 * Extracted out of the agentModeService monolith (ENG-105 follow-up) so the pure
 * extractor can be imported + wired directly (e.g. into the tool-output contract
 * validator and the toolDispatch unit suite) without loading the 24k-line service.
 * agentModeService re-exports it, so existing `from '../services/agentModeService'`
 * importers are unaffected.
 */
export function extractToolContent(result: any): string {
  if (typeof result === 'string') return result;
  if (result?.formattedContent) return result.formattedContent;
  if (result?.content?.[0]?.text) return result.content[0].text;
  return JSON.stringify(result);
}
