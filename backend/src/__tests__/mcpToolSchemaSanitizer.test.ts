import { sanitizeMcpToolSchema } from '../utils/mcpToolSchemaSanitizer';

describe('sanitizeMcpToolSchema — ENG-2162', () => {
  it('drops requestBody/requestHeaders from required for playwright_browser_network_requests', () => {
    const schema = { type: 'object', required: ['requestBody', 'requestHeaders'], properties: { requestBody: {}, requestHeaders: {} } };
    const out = sanitizeMcpToolSchema('playwright_browser_network_requests', schema);
    expect(out.required).toEqual([]);
    expect(schema.required).toEqual(['requestBody', 'requestHeaders']); // input not mutated
  });

  it('keeps genuinely-required fields for that tool', () => {
    const schema = { type: 'object', required: ['url', 'requestBody'] };
    const out = sanitizeMcpToolSchema('playwright_browser_network_requests', schema);
    expect(out.required).toEqual(['url']);
  });

  it('leaves other tools untouched (same object returned)', () => {
    const schema = { type: 'object', required: ['requestBody'] };
    const out = sanitizeMcpToolSchema('send_email_from_sender', schema);
    expect(out).toBe(schema);
  });

  it('no-ops when nothing to relax (same object returned)', () => {
    const schema = { type: 'object', required: ['url'] };
    expect(sanitizeMcpToolSchema('playwright_browser_network_requests', schema)).toBe(schema);
  });

  it('handles missing/!array required safely', () => {
    expect(sanitizeMcpToolSchema('playwright_browser_network_requests', { type: 'object' })).toEqual({ type: 'object' });
    expect(sanitizeMcpToolSchema('playwright_browser_network_requests', undefined)).toBeUndefined();
  });
});

describe('sanitizeMcpToolSchema — ENG-2994', () => {
  it('drops level from required for playwright_browser_console_messages, keeping the property', () => {
    const schema = {
      type: 'object',
      required: ['level'],
      properties: { level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'] } },
    };
    const out = sanitizeMcpToolSchema('playwright_browser_console_messages', schema);
    expect(out.required).toEqual([]);
    expect(out.properties.level.enum).toContain('error');
    expect(schema.required).toEqual(['level']);
  });
});
