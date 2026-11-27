/**
 * ENG-2333 (ENG-336.1) — golden inventory of the PUBLIC MCP tool surface.
 *
 * Built from what an external client actually receives: the `tools/list`
 * handler of createMcpServer() (listed: true) plus the externally visible
 * catalogue reachable through `emma_search_tools` (listed: false). Each entry
 * records name, description, input schema, side-effect class and gating.
 *
 * Any change to the public surface fails this test until the snapshot is
 * reviewed and regenerated:
 *   UPDATE_MCP_INVENTORY=1 npx jest src/__tests__/mcp.publicToolInventory.test.ts
 * Emma's internal registry (emma/tools.ts) is deliberately not part of this.
 */

// ─── Mocks that must be set up before any imports ──────────────────────────

// Capture request handlers registered on the MCP server
let listToolsHandler: (() => Promise<any>) | null = null;
let callToolHandler: ((request: any) => Promise<any>) | null = null;

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    server: {
      setRequestHandler: jest.fn().mockImplementation((schema: any, handler: any) => {
        if (schema === 'ListToolsRequestSchema') {
          listToolsHandler = handler;
        }
        if (schema === 'CallToolRequestSchema') {
          callToolHandler = handler;
        }
      }),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      onerror: null,
    },
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

// Mock httpClient so apiTools can register without needing a real server
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn().mockResolvedValue({ success: true }),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-jwt'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

// Mock agentApiKeyService for auth tests
const mockValidateKey = jest.fn();
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: {
    validateKey: (...args: any[]) => mockValidateKey(...args),
  },
}));

// Mock mcpOAuthService for auth tests
const mockValidateAccessToken = jest.fn();
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: {
    validateAccessToken: (...args: any[]) => mockValidateAccessToken(...args),
  },
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
    },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
    })),
  },
}));

jest.mock('../services/db', () => ({
  taskDb: {},
  scheduleDb: {},
  userDb: { getUserById: jest.fn() },
}));


// ─── Imports (after all mocks) ─────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import { createMcpServer, mcpToolRegistry } from '../mcp/server/mcpServerCore';
import {
  BANNED_DESCRIPTION_PHRASES,
  BANNED_SCHEMA_FIELD,
  CATCH_ALL_FIELD,
  MCP_TOOL_SIDE_EFFECTS,
  UnclassifiedMcpToolError,
  classifyMcpTool,
} from '../mcp/server/toolAnnotationPolicy';

const SNAPSHOT = path.join(__dirname, '__fixtures__', 'mcp-public-tool-inventory.json');

type InventoryEntry = {
  name: string;
  listed: boolean;
  description: string;
  inputSchema: unknown;
  sideEffect: 'read' | 'write';
  gating: { internalOnly: boolean; requiresUserAccount: boolean };
};

function sideEffectOf(name: string): 'read' | 'write' {
  return mcpToolRegistry.getTool(name)?.readOnly === true ? 'read' : 'write';
}

export async function buildPublicToolInventory(): Promise<InventoryEntry[]> {
  createMcpServer('inventory', { agentUserId: 'inventory-user', isInternal: false });
  if (!listToolsHandler) throw new Error('tools/list handler was not registered');
  const listed: any[] = (await listToolsHandler()).tools;
  const listedNames = new Set(listed.map((d) => d.name));
  // Search-discoverable surface: what emma_search_tools may return — the
  // externally visible definitions that tools/list does not preload.
  const discoverable = mcpToolRegistry
    .getToolDefinitions()
    .filter((d: any) => !listedNames.has(d.name));
  const entry = (d: any, isListed: boolean): InventoryEntry => {
    const h = mcpToolRegistry.getTool(d.name);
    return {
      name: d.name,
      listed: isListed,
      description: String(d.description ?? ''),
      inputSchema: d.inputSchema ?? null,
      sideEffect: sideEffectOf(d.name),
      gating: { internalOnly: h?.internalOnly === true, requiresUserAccount: h?.requiresUserAccount === true },
    };
  };
  return [...listed.map((d) => entry(d, true)), ...discoverable.map((d: any) => entry(d, false))]
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('public MCP tool inventory (ENG-2333)', () => {
  let inventory: InventoryEntry[];
  beforeAll(async () => {
    inventory = await buildPublicToolInventory();
    if (process.env.UPDATE_MCP_INVENTORY === '1') {
      fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(inventory, null, 2) + '\n');
    }
  });

  it('derives the listed set from tools/list output, not registration objects', async () => {
    const listed = (await listToolsHandler!()).tools.map((d: any) => d.name).sort();
    expect(inventory.filter((e) => e.listed).map((e) => e.name).sort()).toEqual(listed);
    expect(listed).toContain('emma_search_tools');
  });

  it('never exposes internal (hidden) tools', () => {
    for (const e of inventory) expect(mcpToolRegistry.getTool(e.name)?.internal).not.toBe(true);
  });

  it('records name, description, schema, side-effect class and gating for every tool', () => {
    expect(inventory.length).toBeGreaterThan(0);
    for (const e of inventory) {
      expect(e.name).toMatch(/^[a-z0-9_]+$/);
      expect(['read', 'write']).toContain(e.sideEffect);
      expect(typeof e.gating.internalOnly).toBe('boolean');
      expect(typeof e.gating.requiresUserAccount).toBe('boolean');
    }
  });

  it('matches the reviewed golden snapshot (regenerate with UPDATE_MCP_INVENTORY=1)', () => {
    expect(fs.existsSync(SNAPSHOT)).toBe(true);
    const golden = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    expect(JSON.parse(JSON.stringify(inventory))).toEqual(golden);
  });
});

// ─── ENG-2334 (ENG-336.2): annotation policy + publication CI gate ─────────

function* schemaProps(schema: any): Generator<[string, any]> {
  if (!schema || typeof schema !== 'object') return;
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
    yield [k, v];
    yield* schemaProps(v);
  }
  if (schema.items && typeof schema.items === 'object') yield* schemaProps(schema.items);
}

describe('MCP tool annotation policy gate (ENG-2334)', () => {
  let inventory: InventoryEntry[];
  let annotated: Map<string, any>;
  beforeAll(async () => {
    inventory = await buildPublicToolInventory();
    annotated = new Map(mcpToolRegistry.getToolDefinitions().map((d: any) => [d.name, d]));
  });

  it('every public tool is explicitly classified (unclassified fails closed)', () => {
    const missing = inventory.map((e) => e.name).filter((n) => !(n in MCP_TOOL_SIDE_EFFECTS));
    expect(missing).toEqual([]);
  });

  it('classifyMcpTool throws for an unclassified tool instead of defaulting', () => {
    expect(() => classifyMcpTool('definitely_not_a_tool')).toThrow(UnclassifiedMcpToolError);
    expect(() => classifyMcpTool('toString')).toThrow(UnclassifiedMcpToolError);
    expect(classifyMcpTool('emma_search_tools')).toBe('read');
  });

  it('every public tool emits all three annotation hints matching its policy class', () => {
    for (const e of inventory) {
      const a = annotated.get(e.name)?.annotations;
      expect({ name: e.name, a: a && typeof a.readOnlyHint }).toEqual({ name: e.name, a: 'boolean' });
      expect(typeof a.destructiveHint).toBe('boolean');
      expect(typeof a.openWorldHint).toBe('boolean');
      const isRead = classifyMcpTool(e.name) === 'read';
      expect({ name: e.name, readOnlyHint: a.readOnlyHint }).toEqual({ name: e.name, readOnlyHint: isRead });
    }
  });

  it('get_chat_history is not read-only (sync=true persists satisfaction scores)', () => {
    expect(classifyMcpTool('get_chat_history')).toBe('write');
    expect(annotated.get('get_chat_history')?.annotations?.readOnlyHint).toBe(false);
  });

  it('mutating tools are never read-only', () => {
    const mutating = /(^|_)(post|publish|send|email|create|update|delete|manage|deploy|duplicate|edit|freeze|enable|configure|set|share|revert|launch|execute|submit|schedule|generate|iterate|file|answer)(_|$)/;
    // Name-heuristic exceptions, each proven read-only elsewhere: read_email's
    // schema has no send/reply fields, its action enum is search|list|get, and
    // the handler refuses anything else before any request
    // (mcp/server/__tests__/readEmailTool.test.ts).
    // read_file_content ("file" in the name) reads one file of the caller's own storage and writes nothing: the route is always called
    // with own_storage_only and max_bytes (mcp/server/__tests__/fileReadTool.test.ts; readFileContent refuses any other URL before a fetch).
    const readOnlyByContract = new Set(['read_email', 'read_file_content']);
    const bad = inventory.filter((e) => mutating.test(e.name) && !readOnlyByContract.has(e.name) && classifyMcpTool(e.name) === 'read');
    expect(bad.map((e) => e.name)).toEqual([]);
  });

  it('no public schema carries banned fields (transcripts, raw location, catch-all context objects)', () => {
    const hits: string[] = [];
    for (const e of inventory) {
      for (const [k, v] of schemaProps(e.inputSchema)) {
        if (BANNED_SCHEMA_FIELD.test(k)) hits.push(`${e.name}.${k}`);
        if (
          CATCH_ALL_FIELD.test(k) &&
          v?.type === 'object' &&
          !v.properties &&
          v.additionalProperties !== false
        ) {
          hits.push(`${e.name}.${k} (catch-all)`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('the banned-field gate actually catches a planted violation', () => {
    const planted = { properties: { opts: { type: 'object', properties: { full_transcript: { type: 'string' } } } } };
    expect([...schemaProps(planted)].some(([k]) => BANNED_SCHEMA_FIELD.test(k))).toBe(true);
    expect(CATCH_ALL_FIELD.test('context')).toBe(true);
  });

  it('no public description contains a banned phrase', () => {
    const hits: string[] = [];
    for (const e of inventory) {
      const d = e.description.toLowerCase();
      for (const ph of BANNED_DESCRIPTION_PHRASES) if (d.includes(ph)) hits.push(`${e.name}: ${ph}`);
    }
    expect(hits).toEqual([]);
  });
});
