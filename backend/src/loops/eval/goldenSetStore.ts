/**
 * Golden-set store adapter (ENG-2135, decision D2).
 *
 * Case ids + binary labels live in a private DynamoDB table; transcript/creative/account content
 * is never stored here and is fetched from its source at view or run time.
 *
 * The table is created by OPS-2 (ENG-2147), not by this code. Its name comes from
 * EVAL_GOLDEN_CASES_TABLE; while that is unset the store reports "not provisioned" and every
 * read and write throws GoldenSetStoreNotProvisionedError instead of touching DynamoDB. Dev
 * points the variable at a `Dev-` table.
 *
 * Shape (see createEvalGoldenCasesTable in scripts/create-tables.ts):
 *   HASH caseId                              "<surface>#<sourceKind>#<sourceId>"
 *   GSI  SurfaceIndex  HASH surface, RANGE caseId   — list one surface without a scan
 */

import AWS from 'aws-sdk';
import {
  parseGoldenCase,
  type GoldenCase,
  type GoldenSplit,
  type LabelUpdate,
} from './goldenSet';
import type { EvalSurface } from './evalRegistry';

export const GOLDEN_CASES_TABLE_ENV = 'EVAL_GOLDEN_CASES_TABLE';
export const SURFACE_INDEX = 'SurfaceIndex';

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

export class GoldenSetStoreNotProvisionedError extends Error {
  readonly code = 'golden_set_store_not_provisioned';
  constructor() {
    super(`Golden-set store not provisioned: ${GOLDEN_CASES_TABLE_ENV} is not set (the table is created by OPS-2, ENG-2147)`);
    this.name = 'GoldenSetStoreNotProvisionedError';
  }
}

export class GoldenCaseNotFoundError extends Error {
  constructor(caseId: string) {
    super(`Golden case not found: ${caseId}`);
    this.name = 'GoldenCaseNotFoundError';
  }
}

/** The case changed (or was removed) after the labeller loaded it. */
export class GoldenCaseVersionConflictError extends Error {
  constructor(caseId: string, expectedVersion: number) {
    super(`Golden case ${caseId} is no longer at version ${expectedVersion}; reload and label again`);
    this.name = 'GoldenCaseVersionConflictError';
  }
}

type DocClient = AWS.DynamoDB.DocumentClient;

/** The DynamoDB calls the store makes, as promises (so tests can pass a plain fake). */
export interface GoldenSetDb {
  get(params: AWS.DynamoDB.DocumentClient.GetItemInput): Promise<AWS.DynamoDB.DocumentClient.GetItemOutput>;
  put(params: AWS.DynamoDB.DocumentClient.PutItemInput): Promise<AWS.DynamoDB.DocumentClient.PutItemOutput>;
  update(params: AWS.DynamoDB.DocumentClient.UpdateItemInput): Promise<AWS.DynamoDB.DocumentClient.UpdateItemOutput>;
  query(params: AWS.DynamoDB.DocumentClient.QueryInput): Promise<AWS.DynamoDB.DocumentClient.QueryOutput>;
}

export function documentClientDb(client: DocClient): GoldenSetDb {
  return {
    get: (params) => client.get(params).promise(),
    put: (params) => client.put(params).promise(),
    update: (params) => client.update(params).promise(),
    query: (params) => client.query(params).promise(),
  };
}

export interface ListCasesOptions {
  split?: GoldenSplit;
}

export interface GoldenSetStore {
  /** The configured table, or null when not provisioned. */
  readonly tableName: string | null;
  isProvisioned(): boolean;
  getCase(caseId: string): Promise<GoldenCase | null>;
  /** Every valid case of a surface (rows failing validation are skipped and logged by id). */
  listCases(surface: EvalSurface, opts?: ListCasesOptions): Promise<GoldenCase[]>;
  /** Idempotent seed write: never overwrites an existing case or its labels. */
  createCase(goldenCase: GoldenCase): Promise<'created' | 'exists'>;
  /** Replace the case's labels/notes if it is still at `update.expectedVersion`. */
  saveLabels(caseId: string, update: LabelUpdate, labeller: string, now?: Date): Promise<GoldenCase>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The configured table name, or null when unset/blank. Throws on a malformed name. */
export function resolveGoldenCasesTable(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[GOLDEN_CASES_TABLE_ENV]?.trim();
  if (!raw) return null;
  if (!TABLE_NAME_PATTERN.test(raw)) throw new Error(`${GOLDEN_CASES_TABLE_ENV} is not a valid DynamoDB table name`);
  return raw;
}

export function createGoldenSetStore(opts: { tableName: string | null; db?: GoldenSetDb }): GoldenSetStore {
  const { tableName } = opts;
  let db = opts.db;
  const requireTable = (): { table: string; client: GoldenSetDb } => {
    if (!tableName) throw new GoldenSetStoreNotProvisionedError();
    db ??= documentClientDb(new AWS.DynamoDB.DocumentClient());
    return { table: tableName, client: db };
  };

  const parseOrSkip = (item: unknown): GoldenCase | null => {
    try {
      return parseGoldenCase(item);
    } catch (error) {
      const id = typeof item === 'object' && item !== null && 'caseId' in item ? String((item as { caseId: unknown }).caseId) : '?';
      console.warn(`[goldenSetStore] skipping invalid case ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  return {
    tableName,
    isProvisioned: () => tableName !== null,

    async getCase(caseId) {
      const { table, client } = requireTable();
      const out = await client.get({ TableName: table, Key: { caseId } });
      return out.Item ? parseGoldenCase(out.Item) : null;
    },

    async listCases(surface, listOpts = {}) {
      const { table, client } = requireTable();
      const cases: GoldenCase[] = [];
      let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        const out = await client.query({
          TableName: table,
          IndexName: SURFACE_INDEX,
          KeyConditionExpression: '#surface = :surface',
          ExpressionAttributeNames: { '#surface': 'surface' },
          ExpressionAttributeValues: { ':surface': surface },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        });
        for (const item of out.Items ?? []) {
          const parsed = parseOrSkip(item);
          if (parsed && (!listOpts.split || parsed.split === listOpts.split)) cases.push(parsed);
        }
        startKey = out.LastEvaluatedKey;
      } while (startKey);
      return cases;
    },

    async createCase(goldenCase) {
      const { table, client } = requireTable();
      const valid = parseGoldenCase(goldenCase);
      try {
        await client.put({ TableName: table, Item: valid, ConditionExpression: 'attribute_not_exists(caseId)' });
        return 'created';
      } catch (error) {
        if (errorCode(error) === 'ConditionalCheckFailedException') return 'exists';
        throw error;
      }
    },

    async saveLabels(caseId, update, labeller, now = new Date()) {
      const { table, client } = requireTable();
      const names: Record<string, string> = {
        '#labels': 'labels',
        '#labeller': 'labeller',
        '#labelledAt': 'labelledAt',
        '#version': 'version',
        '#notes': 'notes',
      };
      const values: Record<string, unknown> = {
        ':labels': update.labels,
        ':labeller': labeller,
        ':labelledAt': now.toISOString(),
        ':expected': update.expectedVersion,
        ':next': update.expectedVersion + 1,
      };
      const note = update.notes?.trim();
      if (note) values[':notes'] = note;
      const updateExpression =
        'SET #labels = :labels, #labeller = :labeller, #labelledAt = :labelledAt, #version = :next' +
        (note ? ', #notes = :notes' : ' REMOVE #notes');
      try {
        const out = await client.update({
          TableName: table,
          Key: { caseId },
          UpdateExpression: updateExpression,
          ConditionExpression: 'attribute_exists(caseId) AND #version = :expected',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        });
        return parseGoldenCase(out.Attributes);
      } catch (error) {
        if (errorCode(error) === 'ConditionalCheckFailedException') {
          throw new GoldenCaseVersionConflictError(caseId, update.expectedVersion);
        }
        throw error;
      }
    },
  };
}

/** The store for this process's environment (inert until EVAL_GOLDEN_CASES_TABLE is set). */
export function goldenSetStoreFromEnv(env: NodeJS.ProcessEnv = process.env): GoldenSetStore {
  return createGoldenSetStore({ tableName: resolveGoldenCasesTable(env) });
}
