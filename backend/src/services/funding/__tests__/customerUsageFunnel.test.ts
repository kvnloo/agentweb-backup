/**
 * ENG-2106 (A3): through the REAL metering funnel (nothing in it mocked but the AWS
 * SDK), a customer-funded call writes to AW-AttemptUsage and to no other table, and an
 * AgentWeb-funded call still writes to the usage tables and never to the journal. This is
 * the "sum of AgentWeb-paid attempts equals the ledger" guard: if a customer-funded call
 * ever reached a rail, AW-SpendProjection would fold it into the customer's own cap.
 */
const calls: Array<{ op: string; table: string }> = [];
const record = (op: string) => (params: any) => {
  const table = params?.TableName ?? params?.TransactItems?.[0]?.Put?.TableName ?? params?.TransactItems?.[0]?.Update?.TableName ?? '(none)';
  calls.push({ op, table });
  return { promise: async () => ({ Item: undefined, Items: [], Attributes: {} }) };
};
jest.mock('aws-sdk', () => {
  class DocumentClient {
    put = record('put');
    get = record('get');
    update = record('update');
    query = record('query');
    delete = record('delete');
    batchWrite = record('batchWrite');
    transactWrite = record('transactWrite');
    scan = record('scan');
  }
  class DynamoDB {
    static DocumentClient = DocumentClient;
  }
  const mod = { DynamoDB, S3: class {}, config: { update: jest.fn() }, SecretsManager: class {}, KMS: class {} };
  return { __esModule: true, default: mod, ...mod };
});
import { __resetAttemptUsageJournalForTests } from '../attemptUsageJournal';
import type { RunFunding } from '../runFunding';

const customer: RunFunding = {
  route: 'api_key',
  connectionId: 'conn-1',
  fallback: 'stop',
  ownerUserId: 'user-1',
  billingUserId: 'user-1',
  fundingPrincipalId: 'user-1',
  resolvedAt: new Date().toISOString(),
};
const ctx = {
  userId: 'user-1',
  billingUserId: 'user-1',
  sessionId: 'session-1',
  model: 'gpt-4.1',
  provider: 'openai',
  feature: 'agent_task',
  inputTokens: 100,
  outputTokens: 50,
  eventId: 'gen-funnel-1',
};

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

describe('customer-funded usage vs the metering rails', () => {
  beforeEach(() => {
    calls.length = 0;
    __resetAttemptUsageJournalForTests();
  });

  it('the production default journal is the DynamoDB one, built without any startup binding', () => {
    // Chat runs in a forked worker where server.ts never ran: nothing may need to bind it.
    // (__reset binds a no-op for other tests; clear that to see the real default.)
    jest.isolateModules(() => {
      const { getAttemptUsageJournal: fresh } = require('../attemptUsageJournal');
      const { DynamoAttemptUsageJournal } = require('../dynamoAttemptUsageJournal');
      expect(fresh()).toBeInstanceOf(DynamoAttemptUsageJournal);
    });
  });

  it('a customer-funded call writes only to AW-AttemptUsage', async () => {
    // Use the real journal, over the recording SDK.
    jest.isolateModules(() => {
      const { recordLlmUsage: rec } = require('../recordLlmUsage');
      rec(customer, ctx, 'funnel-test');
    });
    await settle();
    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls.map((c) => c.table))]).toEqual(['AW-AttemptUsage']);
    expect(calls.map((c) => c.op)).toEqual(['put']);
  });

  it('an AgentWeb-funded call never writes to the journal', async () => {
    jest.isolateModules(() => {
      const { recordLlmUsage: rec } = require('../recordLlmUsage');
      rec({ ...customer, route: 'agentweb', connectionId: undefined, fallback: 'agentweb' }, ctx, 'funnel-test');
    });
    await settle();
    // Not vacuous: the AgentWeb rails really did write somewhere.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => c.table)).not.toContain('AW-AttemptUsage');
  });
});
