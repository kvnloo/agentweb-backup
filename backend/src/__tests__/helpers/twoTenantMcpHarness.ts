/**
 * Two-tenant isolation harness for MCP tools (ENG-2840).
 *
 * What it proves: an MCP caller holding tenant A's identity cannot read, change or learn anything about tenant B's data, through the
 * code path an outside agent actually uses:
 *
 *   MCP client --(in-memory transport)--> real MCP server (createMcpServer: argument stripping, scope context, error envelope, public
 *   response sanitiser) --> real tool in mcpToolRegistry --> mcpFetch (real service JWT) --> the REAL Express app (supertest) --> real
 *   middleware, routes and services/db.ts --> an in-memory DynamoDB (helpers/inMemoryDynamo.ts).
 *
 * Nothing between the client and the table is mocked. The test file only has to (1) replace aws-sdk's DocumentClient with the fake from
 * `makeTwoTenantFake()`, (2) mock the socket.io export and the secrets reader (neither is under test), and (3) call
 * `installSelfCallFetch(app)` so the tool's self-call (a `fetch` to http://localhost:PORT) lands in the app instead of a socket.
 *
 * Limits, stated so nobody reads it as more than it is: the fake database ignores FilterExpression / Limit / ExclusiveStartKey and has no
 * batch operations or S3, so isolation that lives in a database filter cannot be proven here; the caller's identity is the session context
 * the HTTP layer would have built from a valid aw_ key (the key lookup itself is not exercised); and scope checks that live in the HTTP
 * layer (mcpServer.ts) are not exercised.
 */
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryDynamo, type TableKeySchema } from './inMemoryDynamo';

/** Tables the wave-1 tools touch (leads, lead lists, brand and market strategy live on users and orgs). Extend per wave. */
export const TWO_TENANT_TABLES: Record<string, TableKeySchema> = {
  'AW-Users': { hash: 'email', indexes: { UserIdIndex: { hash: 'userId' }, OrgIdIndex: { hash: 'orgId' } } },
  'AW-Organizations': { hash: 'orgId' },
  'AW-LeadLists': { hash: 'listId', indexes: { 'userId-index': { hash: 'userId' } } },
  'AW-Leads': { hash: 'listId', range: 'leadId', indexes: { 'email-index': { hash: 'listId', range: 'email' } } },
};

export function makeTwoTenantFake(): InMemoryDynamo {
  return new InMemoryDynamo(TWO_TENANT_TABLES);
}

/** One tenant: an org with an owner (and optionally a member), one lead list, two leads, a brand and a market strategy. */
export interface Tenant {
  label: 'A' | 'B';
  orgId: string;
  owner: string;
  member?: string;
  listId: string;
  listName: string;
  leads: Array<{ leadId: string; name: string; email: string }>;
  brandName: string;
  overview: string;
  competitor: string;
  icp: string;
}

export const TENANT_A: Tenant = {
  label: 'A',
  orgId: 'org-a',
  owner: 'user-a1',
  member: 'user-a2',
  listId: 'list-a1',
  listName: 'ALPHA prospects',
  leads: [
    { leadId: '001-lead-a1', name: 'Alice Alpha', email: 'alice@alpha-secret.test' },
    { leadId: '002-lead-a2', name: 'Arnold Alpha', email: 'arnold@alpha-secret.test' },
  ],
  brandName: 'ALPHA Corp',
  overview: 'ALPHA sells widgets',
  competitor: 'AlphaRival',
  icp: 'ALPHA ICP',
};

export const TENANT_B: Tenant = {
  label: 'B',
  orgId: 'org-b',
  owner: 'user-b1',
  listId: 'list-b1',
  listName: 'BRAVO prospects',
  leads: [
    { leadId: '001-lead-b1', name: 'Bob Bravo', email: 'bob@bravo-secret.test' },
    { leadId: '002-lead-b2', name: 'Betty Bravo', email: 'betty@bravo-secret.test' },
  ],
  brandName: 'BRAVO Corp',
  overview: 'BRAVO sells gadgets',
  competitor: 'BravoRival',
  icp: 'BRAVO ICP',
};

/** Text that belongs to a tenant's data and must never reach another tenant's caller, in ANY outcome (success or refusal). */
export const contentMarkers = (t: Tenant): string[] => [
  t.listName,
  ...t.leads.flatMap((l) => [l.name, l.email]),
  t.brandName,
  t.overview,
  t.competitor,
  t.icp,
];

/** Identifiers of a tenant. A caller may echo an id it supplied itself, so these are asserted only for READS that never named them. */
export const idMarkers = (t: Tenant): string[] => [t.orgId, t.owner, t.listId, ...t.leads.map((l) => l.leadId), ...(t.member ? [t.member] : [])];

const NOW = '2026-11-18T10:00:00.000Z';

function seedTenant(fake: InMemoryDynamo, t: Tenant): void {
  const user = (userId: string, orgRole: 'owner' | 'member') =>
    fake.seed('AW-Users', {
      email: `${userId}@${t.orgId}.test`,
      userId,
      orgId: t.orgId,
      orgRole,
      isActive: true,
      isAdmin: false,
      roles: ['customer'],
    });
  user(t.owner, 'owner');
  if (t.member) user(t.member, 'member');
  fake.seed('AW-Organizations', {
    orgId: t.orgId,
    name: `${t.label} Org`,
    ownerUserId: t.owner,
    brandGuidelines: { brandData: { brandName: t.brandName, valueProposition: t.overview }, attachments: [], createdAt: NOW, updatedAt: NOW },
    marketStrategy: { businessOverview: t.overview, competitors: [{ name: t.competitor }], icp: [{ name: t.icp }] },
  });
  fake.seed('AW-LeadLists', { listId: t.listId, userId: t.owner, name: t.listName, listType: 'sales', createdAt: NOW, leadCount: t.leads.length });
  for (const lead of t.leads) {
    fake.seed('AW-Leads', { listId: t.listId, leadId: lead.leadId, userId: t.owner, name: lead.name, email: lead.email, status: 'new', createdAt: NOW });
  }
}

/** Empty every table, then seed both tenants. Call from beforeEach so each test starts from the same world. */
export function seedTwoTenantWorld(fake: InMemoryDynamo): void {
  for (const table of Object.keys(TWO_TENANT_TABLES)) fake.tables.get(table)?.clear();
  seedTenant(fake, TENANT_A);
  seedTenant(fake, TENANT_B);
}

/** A tenant's rows, as JSON, to compare before and after an attempt on it. */
export function snapshotTenant(fake: InMemoryDynamo, t: Tenant): string {
  const people = [t.owner, ...(t.member ? [t.member] : [])];
  // Every clause names a defined value: a tenant without a member must not match the rows that simply have no userId.
  const mine = (row: Record<string, any>) => row.orgId === t.orgId || people.includes(row.userId) || row.listId === t.listId;
  const rows = Object.keys(TWO_TENANT_TABLES).flatMap((table) =>
    fake.items(table).filter(mine).map((row) => ({ table, row })),
  );
  rows.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  return JSON.stringify(rows);
}

/**
 * Route the tools' self-call (a global `fetch` to http://localhost:PORT with the service JWT) into the real Express app, so the real
 * routes and middleware run. Returns the function that puts the original fetch back.
 */
export function installSelfCallFetch(app: any): () => void {
  const realFetch = global.fetch;
  global.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    let req = (request(app) as any)[String(init.method || 'GET').toLowerCase()](u.pathname + u.search);
    for (const [k, v] of Object.entries(init.headers || {})) req = req.set(k, v as string);
    if (init.body) req = req.send(init.body);
    const res = await req;
    // The answer is a plain object, not a `Response`: `Response.json()` builds its objects in the OUTER Node realm, whose Object.prototype is not
    // the one jest's sandbox sees, so a value read from it fails `Object.getPrototypeOf(v) === Object.prototype` (customFieldsGuard) and is
    // coerced to {}. In production fetch and the code share one realm; this keeps that true here. It also sidesteps the Response constructor
    // refusing a body on 204 / 205 / 304.
    const text: string = [204, 205, 304].includes(res.status) ? '' : res.text;
    const contentType: string = res.headers['content-type'] || 'text/plain';
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }) as any;
  return () => {
    global.fetch = realFetch;
  };
}

export interface Outcome {
  /** True when the MCP server answered with isError (a refusal or a thrown tool error). */
  isError: boolean;
  /** Every text block of the reply, joined. */
  text: string;
  /** The reply parsed as JSON (null when it is not JSON, e.g. an error string). */
  json: any;
}

export interface McpCaller {
  userId: string;
  call(name: string, args: Record<string, unknown>): Promise<Outcome>;
  close(): Promise<void>;
}

/**
 * An MCP client connected to a real MCP server whose session is that of an external aw_ key owned by `userId` (default scopes
 * tools:read + tools:execute, like every key created without extra scopes). `createMcpServer` and the tool modules are imported here, not at
 * the top of the file, so the test file's jest.mock calls are in place first.
 */
export async function connectCaller(userId: string, opts: { scopes?: string[] } = {}): Promise<McpCaller> {
  const { createMcpServer } = await import('../../mcp/server/mcpServerCore');
  await import('../../mcp/server/apiTools');
  const server = createMcpServer('two-tenant-harness', {
    agentUserId: userId,
    sessionId: `harness-${userId}`,
    isInternal: false,
    authMethod: 'api_key',
    apiKeyId: `key-${userId}`,
    apiKeyScopes: opts.scopes ?? ['tools:read', 'tools:execute'],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'two-tenant-harness', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    userId,
    async call(name, args) {
      const res: any = await client.callTool({ name, arguments: args });
      const text = (res.content ?? []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { isError: !!res.isError, text, json };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
