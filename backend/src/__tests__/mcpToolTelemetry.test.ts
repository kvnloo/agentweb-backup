/**
 * Unit tests for the pure MCP tool telemetry helper (ENG-107).
 *
 * Imports ONLY the pure helper — no McpClientService boot, no MCP SDK, no
 * agentModeService — so it runs fast and isolates the normalized telemetry shape.
 */

import {
  buildMcpToolTelemetry,
  redactSensitive,
  McpToolTelemetryPayload,
} from '../mcp/client/mcpToolTelemetry';

describe('buildMcpToolTelemetry', () => {
  it('success/call payload includes server, transport, truncated session ids, retryCount=0, phase=call', () => {
    const payload = buildMcpToolTelemetry({
      serverName: 'playwright-server',
      toolName: 'browser_navigate',
      transport: 'sse',
      chatSessionId: 'sess-1234567890abcdef',
      mcpSessionId: 'mcp-abcdef0123456789',
      attempt: 1,
      maxAttempts: 3,
      phase: 'call',
    });

    expect(payload.event).toBe('mcp_tool_call');
    expect(payload.serverName).toBe('playwright-server');
    expect(payload.toolName).toBe('browser_navigate');
    expect(payload.transport).toBe('sse');
    // truncated to first 8 chars — full ids never leak into telemetry
    expect(payload.chatSessionId).toBe('sess-123');
    expect(payload.mcpSessionId).toBe('mcp-abcd');
    expect(payload.retryCount).toBe(0);
    expect(payload.maxAttempts).toBe(3);
    expect(payload.phase).toBe('call');
    // no error fields on a successful call
    expect(payload.errorClass).toBeUndefined();
    expect(payload.errorMessage).toBeUndefined();
  });

  it("absent mcp session id falls back to 'NO_SESSION_ID'", () => {
    const payload = buildMcpToolTelemetry({
      serverName: 'srv',
      toolName: 'do_thing',
      transport: 'stdio',
      chatSessionId: undefined,
      mcpSessionId: 'NO_SESSION_ID',
      attempt: 1,
      maxAttempts: 1,
      phase: 'call',
    });
    expect(payload.chatSessionId).toBe('NO_SESSION_ID');
    expect(payload.mcpSessionId).toBe('NO_SESSION_ID');
  });

  it('timeout error → errorClass=timeout, phase=retry when attempt < maxAttempts', () => {
    const payload = buildMcpToolTelemetry({
      serverName: 'playwright-server',
      toolName: 'browser_navigate',
      transport: 'sse',
      chatSessionId: 'sess1',
      attempt: 1,
      maxAttempts: 3,
      phase: 'retry',
      error: new Error('Operation timed out after 3600000ms'),
    });
    expect(payload.errorClass).toBe('timeout');
    expect(payload.phase).toBe('retry');
    expect(payload.retryCount).toBe(0);
  });

  it('auth error (401/unauthorized) → errorClass=auth, phase=final_failure on last attempt', () => {
    const payload = buildMcpToolTelemetry({
      serverName: 'srv',
      toolName: 'browser_click',
      transport: 'streamable-http',
      chatSessionId: 'sess1',
      attempt: 3,
      maxAttempts: 3,
      phase: 'final_failure',
      error: new Error('Request failed: unauthorized'),
    });
    expect(payload.errorClass).toBe('auth');
    expect(payload.phase).toBe('final_failure');
    expect(payload.retryCount).toBe(2);
  });

  it('representative MCP failure modes map to the correct normalized error class', () => {
    const rate = buildMcpToolTelemetry({
      serverName: 's', toolName: 't', transport: 'sse', chatSessionId: 'x',
      attempt: 1, maxAttempts: 3, phase: 'retry',
      error: new Error('429 Too Many Requests'),
    });
    expect(rate.errorClass).toBe('rate_limit');

    const network = buildMcpToolTelemetry({
      serverName: 's', toolName: 't', transport: 'sse', chatSessionId: 'x',
      attempt: 1, maxAttempts: 3, phase: 'retry',
      error: new Error('socket hang up: ECONNRESET'),
    });
    expect(network.errorClass).toBe('network');
  });

  it('retryCount increments across attempts and final_failure is distinguishable from retry', () => {
    const mk = (attempt: number, phase: 'retry' | 'final_failure') =>
      buildMcpToolTelemetry({
        serverName: 's', toolName: 'browser_navigate', transport: 'sse',
        chatSessionId: 'x', attempt, maxAttempts: 3, phase,
        error: new Error('econnreset'),
      });

    const a1 = mk(1, 'retry');
    const a2 = mk(2, 'retry');
    const a3 = mk(3, 'final_failure');

    expect(a1.retryCount).toBe(0);
    expect(a1.phase).toBe('retry');
    expect(a2.retryCount).toBe(1);
    expect(a2.phase).toBe('retry');
    expect(a3.retryCount).toBe(2);
    expect(a3.phase).toBe('final_failure');
    // structured discriminator, not log-prefix text
    expect(a3.phase).not.toBe(a2.phase);
  });

  it('redacts secrets in the emitted error message', () => {
    const payload = buildMcpToolTelemetry({
      serverName: 's', toolName: 't', transport: 'sse', chatSessionId: 'x',
      attempt: 3, maxAttempts: 3, phase: 'final_failure',
      error: new Error('unauthorized: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.sigpart and access_token=sk_live_0123456789abcdefghij failed; api_key=AKIA0123456789ABCDEF rejected'),
    });
    const msg = payload.errorMessage ?? '';
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(msg).not.toContain('sk_live_0123456789abcdefghij');
    expect(msg).not.toContain('AKIA0123456789ABCDEF');
    expect(msg).toContain('[REDACTED]');
    // errorClass still derives from the raw error (auth), not the redacted text
    expect(payload.errorClass).toBe('auth');
  });

  it('payload is JSON-serializable and round-trips', () => {
    const payload = buildMcpToolTelemetry({
      serverName: 'playwright-server', toolName: 'browser_navigate', transport: 'sse',
      chatSessionId: 'sess1', mcpSessionId: 'mcp1', attempt: 2, maxAttempts: 3,
      phase: 'retry', error: new Error('etimedout'),
    });
    const roundTripped = JSON.parse(JSON.stringify(payload)) as McpToolTelemetryPayload;
    expect(roundTripped).toEqual(payload);
  });
});

describe('redactSensitive', () => {
  it('masks bearer tokens', () => {
    const out = redactSensitive('called with Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.abc.def now');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9');
  });

  it('masks access_token / refresh_token / api_key / password values', () => {
    const out = redactSensitive('access_token=abc123secrettoken99 refresh_token: rt_secretvalue123456 api_key=apikeysecret0001 password=hunter2supersecret');
    expect(out).not.toContain('abc123secrettoken99');
    expect(out).not.toContain('rt_secretvalue123456');
    expect(out).not.toContain('apikeysecret0001');
    expect(out).not.toContain('hunter2supersecret');
    expect((out.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('handles non-string / non-error inputs without throwing', () => {
    expect(redactSensitive(undefined)).toBe('');
    expect(redactSensitive(null)).toBe('');
    expect(redactSensitive(42)).toBe('42');
  });

  it('leaves ordinary error text intact', () => {
    const out = redactSensitive(new Error('Tool browser_navigate failed: page crashed'));
    expect(out).toBe('Tool browser_navigate failed: page crashed');
  });
});
