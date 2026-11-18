/**
 * ENG-2162 (same class as ENG-821). Some MCP servers declare tool parameters as `required`
 * that the tool does not actually need. `playwright_browser_network_requests` declares
 * `requestBody` and `requestHeaders` required, but listing a page's network requests needs
 * neither — so the model's natural call is rejected by our gateway's pre-execution schema
 * check (agentToolGatewayService.buildSchemaRetryMessage), wasting turns while it retries with
 * dummy values. Observed twice on 2026-09-25 (sessions 81d208b8-…, e278986c-…).
 *
 * We do not own these external schemas, and there is no per-tool override layer where they are
 * ingested (mcpClientService discovers them via listTools()). This is that layer: at ingest we
 * relax the specific over-strict `required` fields for known tools. Keyed on the ORIGINAL
 * (unprefixed) tool name so it works regardless of a server's toolPrefix.
 *
 * Pure and dependency-free so it is unit-testable without the MCP client. Never mutates the
 * input; returns a shallow-cloned schema when it changes anything.
 */

// original tool name -> parameter names to drop from `required`
const REQUIRED_RELAXATIONS: Record<string, string[]> = {
  playwright_browser_network_requests: ['requestBody', 'requestHeaders'],
  // ENG-2994: `level` has a server-side default ("info"); models omit it and were rejected
  // pre-execution with 'Missing required argument "level"' (4/17 calls in one window).
  playwright_browser_console_messages: ['level'],
  // ENG-2994 follow-up (Opslane run 1999): the Playwright MCP server reports UNPREFIXED names
  // (`browser_console_messages`), so key both forms or the lookup silently misses.
  browser_network_requests: ['requestBody', 'requestHeaders'],
  browser_console_messages: ['level'],
};

/**
 * @param originalToolName the tool's own name as the server reports it (no toolPrefix)
 * @param schema the tool's inputSchema from listTools()
 */
export function sanitizeMcpToolSchema(originalToolName: string, schema: any): any {
  const relax = REQUIRED_RELAXATIONS[originalToolName];
  if (!relax || !schema || typeof schema !== 'object' || !Array.isArray(schema.required)) {
    return schema;
  }
  const relaxSet = new Set(relax);
  const nextRequired = schema.required.filter((name: unknown) => typeof name === 'string' && !relaxSet.has(name));
  if (nextRequired.length === schema.required.length) {
    return schema; // nothing to relax — leave the original untouched
  }
  return { ...schema, required: nextRequired };
}
