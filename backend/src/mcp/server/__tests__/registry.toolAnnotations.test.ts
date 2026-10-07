/**
 * ENG-336 slice 1 — every externally listed MCP tool carries the three MCP
 * tool annotations ChatGPT app publication requires: readOnlyHint,
 * destructiveHint, openWorldHint. Undeclared tools are labelled conservatively
 * (write + destructive); explicit per-tool annotations are never overwritten.
 */
import { McpToolRegistry } from '../registry';

describe('ENG-336 — MCP tool annotations on tools/list', () => {
  let registry: McpToolRegistry;

  beforeEach(() => {
    registry = new McpToolRegistry();
    registry.register({
      name: 'read_brand_guidelines',
      definition: { name: 'read_brand_guidelines', description: 'r', inputSchema: { type: 'object' } },
      readOnly: true,
      execute: jest.fn(),
    });
    registry.register({
      name: 'send_email',
      definition: { name: 'send_email', description: 'w', inputSchema: { type: 'object' } },
      execute: jest.fn(),
    });
    registry.register({
      name: 'custom_annotated',
      definition: {
        name: 'custom_annotated',
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      execute: jest.fn(),
    });
    registry.register({
      name: 'hidden_tool',
      definition: { name: 'hidden_tool' },
      internal: true,
      execute: jest.fn(),
    });
  });

  const byName = (n: string) => registry.getToolDefinitions().find((d: any) => d.name === n);

  it('labels a declared read-only tool readOnlyHint=true, non-destructive', () => {
    expect(byName('read_brand_guidelines').annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('labels an undeclared tool conservatively as a destructive write', () => {
    expect(byName('send_email').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('preserves explicit per-tool annotations', () => {
    expect(byName('custom_annotated').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('does not mutate the registered definition object', () => {
    registry.getToolDefinitions();
    expect((registry as any).tools.get('send_email').definition.annotations).toBeUndefined();
  });

  it('gate: every listed tool has all three hints as booleans', () => {
    const defs = registry.getToolDefinitions();
    expect(defs.find((d: any) => d.name === 'hidden_tool')).toBeUndefined();
    for (const d of defs) {
      for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof d.annotations?.[k]).toBe('boolean');
      }
    }
  });
});
