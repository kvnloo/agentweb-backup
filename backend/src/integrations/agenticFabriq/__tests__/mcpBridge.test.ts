/**
 * Protects the vendor's own TRAP #1, verified against their live API: `/mcp`
 * and `/mcp/external` both return 200 for an external-user token, so calling
 * the wrong one fails SILENTLY. This pins that the resolved URL always ends
 * in `/mcp/external` — never the internal `/mcp` route — regardless of
 * whether the token response supplied an mcp_url.
 */
import { resolveMcpExternalUrl, AgenticFabriqMcpBridge } from '../mcpBridge';
import { AgenticFabriqAuthenticationError } from '../errors';

describe('resolveMcpExternalUrl', () => {
  it('uses the token response mcp_url when present and correctly suffixed', () => {
    expect(resolveMcpExternalUrl('https://api.example.com', 'https://mcp.example.com/mcp/external')).toBe(
      'https://mcp.example.com/mcp/external',
    );
  });

  it('falls back to <base>/mcp/external when mcp_url is absent', () => {
    expect(resolveMcpExternalUrl('https://api.example.com', undefined)).toBe('https://api.example.com/mcp/external');
  });

  it('falls back to <base>/mcp/external when mcp_url is null', () => {
    expect(resolveMcpExternalUrl('https://api.example.com', null)).toBe('https://api.example.com/mcp/external');
  });

  it('strips a trailing slash from the base before appending', () => {
    expect(resolveMcpExternalUrl('https://api.example.com/', undefined)).toBe('https://api.example.com/mcp/external');
  });

  it('refuses a token-supplied mcp_url that does NOT end in /mcp/external — never silently uses the internal route', () => {
    expect(() => resolveMcpExternalUrl('https://api.example.com', 'https://mcp.example.com/mcp')).toThrow(
      AgenticFabriqAuthenticationError,
    );
  });
});

describe('AgenticFabriqMcpBridge', () => {
  function fakeFetch(responses: Array<{ status: number; body: unknown }>): any {
    let call = 0;
    return jest.fn(async () => {
      const r = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return {
        ok: r.status < 300,
        status: r.status,
        headers: { get: () => null },
        text: async () => JSON.stringify(r.body),
      };
    });
  }

  it('listTools calls the given URL exactly, never rewriting it', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'google_gmail_search' }] } } }]);
    const bridge = new AgenticFabriqMcpBridge(fetchImpl);
    const tools = await bridge.listTools('https://api.example.com/mcp/external', 'tok');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/mcp/external', expect.any(Object));
    expect(tools).toEqual([{ name: 'google_gmail_search' }]);
  });

  it('throws AgenticFabriqAuthenticationError on 401 — never silently returns empty', async () => {
    const fetchImpl = fakeFetch([{ status: 401, body: {} }]);
    const bridge = new AgenticFabriqMcpBridge(fetchImpl);
    await expect(bridge.listTools('https://api.example.com/mcp/external', 'expired')).rejects.toThrow(
      AgenticFabriqAuthenticationError,
    );
  });

  it('surfaces a JSON-RPC-level error rather than returning undefined', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'boom' } } }]);
    const bridge = new AgenticFabriqMcpBridge(fetchImpl);
    await expect(bridge.callTool('https://api.example.com/mcp/external', 'tok', 'google_gmail_send', {})).rejects.toThrow(/redacted RPC error/);
  });

  it('caps the number of discovered tools', async () => {
    const tools = Array.from({ length: 101 }, (_, i) => ({ name: `gmail_tool_${i}` }));
    const bridge = new AgenticFabriqMcpBridge(fakeFetch([{ status: 200, body: { jsonrpc: '2.0', id: '1', result: { tools } } }]));
    await expect(bridge.listTools('https://api.example.com/mcp/external', 'tok')).rejects.toMatchObject({ name: 'AgenticFabriqResponseTooLargeError' });
  });
});
