import AWS from 'aws-sdk';

interface CleanupDependencies {
  db?: AWS.DynamoDB.DocumentClient;
  s3?: AWS.S3;
  tablePrefix?: string;
  bucket?: string;
  deleteGcsPrefix?: (prefix: string) => Promise<void>;
}

const TABLES = [
  ['AW-AgentRuns', 'pk'], ['AW-ChatSessions', 'sessionId'],
  ['AW-TaskExecutions', 'executionId'], ['AW-WorkflowExecutions', 'executionId'],
  ['AW-Tasks', 'taskId'], ['AW-Workflows', 'workflowId'],
  ['AW-LandingPages', 'id'], ['AW-WorkPlans', 'planId'],
  ['AW-LeadLists', 'listId'],
  ['AW-Characters', 'characterId'], ['AW-Books', 'bookId'],
] as const;
const ownerField = (table: string) => table === 'AW-WorkPlans' ? 'ownerId' : 'userId';
const ACTIVE = new Set(['pending', 'queued', 'running', 'processing', 'generating', 'deploying', 'in_progress', 'in-progress']);
type Row = Record<string, any>;

function assertSandbox(userId: string) {
  if (!/^eval_[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Sandbox cleanup requires an evaluation account');
}
function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_#:-]+$/.test(value)) throw new Error('Invalid sandbox artifact identity');
}

/** Called only after the lifecycle policy has blocked new candidate writes. Never touches
 * policy/audit or shared dataset rows. Ownership records survive failed file cleanup for retry. */
export class SandboxArtifactCleanup {
  private db: AWS.DynamoDB.DocumentClient;
  private s3: AWS.S3;
  private tablePrefix: string;
  private bucket: string;
  private deleteGcsPrefix: (prefix: string) => Promise<void>;
  constructor(deps: CleanupDependencies = {}) {
    this.db = deps.db ?? new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.s3 = deps.s3 ?? new AWS.S3();
    this.tablePrefix = deps.tablePrefix ?? (process.env.NODE_ENV === 'development' ? 'Dev-' : '');
    this.bucket = deps.bucket ?? process.env.AWS_S3_BUCKET ?? 'agentweb-user-files';
    this.deleteGcsPrefix = deps.deleteGcsPrefix ?? (async (prefix) => {
      const { Storage } = await import('@google-cloud/storage');
      const { getGCSPPrivateKey } = await import('../../utils/secretsManager');
      const storage = new Storage({ projectId: process.env.GCS_PROJECT_ID, credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL, private_key: await getGCSPPrivateKey(),
      } });
      for (const name of new Set([process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev',
        process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev'])) {
        // SDK auto-pagination; force is deliberately absent so partial deletion rejects.
        await storage.bucket(name).deleteFiles({ prefix });
      }
    });
  }

  private async ownedRows(table: string, owner: string, value: string, keys: readonly string[]): Promise<Row[]> {
    // Owner GSIs can omit newly written rows. Query only primary owner keys;
    // otherwise exhaust a strongly consistent, owner-filtered base-table scan.
    const primary = ['AW-Characters', 'AW-AccountMemory', 'AW-Leads', 'AW-ChatMessages'].includes(table);
    const optionalTable = ['AW-AgentRuns', 'AW-WorkflowExecutions', 'AW-Characters', 'AW-AccountMemory', 'AW-Leads', 'AW-ChatMessages', 'AW-Settings'].includes(table);
    const rows: Row[] = [];
    let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
    const seen = new Set<string>();
    do {
      let items: Row[];
      try {
        if (table === 'AW-Settings') {
          const result = await this.db.get({ TableName: this.tablePrefix + table, Key: { settingName: value }, ConsistentRead: true }).promise();
          items = result.Item === undefined ? [] : [result.Item];
        } else {
          const params = { TableName: this.tablePrefix + table,
            ExpressionAttributeNames: { '#owner': owner }, ExpressionAttributeValues: { ':owner': value },
            ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          };
          const page = primary
            ? await this.db.query({ ...params, KeyConditionExpression: '#owner = :owner' }).promise()
            : await this.db.scan({ ...params, FilterExpression: '#owner = :owner' }).promise();
          items = page.Items as Row[];
          cursor = page.LastEvaluatedKey;
        }
      } catch (error: any) {
        // Optional tables may be absent, but never accept a partial inventory.
        if (optionalTable && cursor === undefined && error?.code === 'ResourceNotFoundException') break;
        throw error;
      }
      if (!Array.isArray(items)) throw new Error('Invalid sandbox artifact listing');
      for (const row of items) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || row[owner] !== value) throw new Error('Sandbox artifact ownership mismatch');
        for (const key of keys) {
          if (key === 'messageIndex') {
            if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('Invalid message index');
          } else assertId(row[key]);
        }
        rows.push(row);
      }
      if (cursor !== undefined) {
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.keys(cursor).length) throw new Error('Invalid sandbox artifact pagination');
        const token = JSON.stringify(Object.entries(cursor).sort(([a], [b]) => a.localeCompare(b)));
        if (seen.has(token)) throw new Error('Invalid sandbox artifact pagination');
        seen.add(token);
      }
    } while (cursor);
    return rows;
  }

  private async inventory(userId: string) {
    assertSandbox(userId);
    const inventory = new Map<string, Row[]>();
    for (const [table, key] of TABLES) inventory.set(table, await this.ownedRows(table, ownerField(table), userId, [key]));
    for (const table of ['AW-AgentRuns', 'AW-ChatSessions', 'AW-TaskExecutions', 'AW-WorkflowExecutions', 'AW-LandingPages']) {
      const rows = inventory.get(table)!;
      if (rows.some(row => ACTIVE.has(typeof row.status === 'string' ? row.status.toLowerCase() : '') || row.isProcessing === true)) {
        throw new Error('Sandbox has active work; wait for executions to finish before lifecycle cleanup');
      }
    }
    return inventory;
  }

  async assertQuiescent(userId: string): Promise<void> { await this.inventory(userId); }

  private async inventoryS3Prefix(prefix: string): Promise<AWS.S3.ObjectIdentifier[]> {
    let token: string | undefined;
    const seen = new Set<string>();
    const objects: AWS.S3.ObjectIdentifier[] = [];
    do {
      const page = await this.s3.listObjectsV2({ Bucket: this.bucket, Prefix: prefix,
        ...(token ? { ContinuationToken: token } : {}),
      }).promise();
      if (page.Contents !== undefined && !Array.isArray(page.Contents)) throw new Error('Invalid S3 listing');
      objects.push(...(page.Contents ?? []).map(object => {
        if (!object || typeof object.Key !== 'string' || !object.Key.startsWith(prefix)) throw new Error('S3 cleanup prefix mismatch');
        return { Key: object.Key };
      }));
      if (page.IsTruncated && (typeof page.NextContinuationToken !== 'string' || !page.NextContinuationToken || seen.has(page.NextContinuationToken))) {
        throw new Error('Invalid S3 pagination');
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (token) seen.add(token);
    } while (token);
    return objects;
  }

  private async deleteS3Objects(objects: AWS.S3.ObjectIdentifier[]): Promise<number> {
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const result = await this.s3.deleteObjects({ Bucket: this.bucket, Delete: { Objects: objects.slice(offset, offset + 1000) } }).promise();
      if (result.Errors !== undefined && (!Array.isArray(result.Errors) || result.Errors.length)) throw new Error('Sandbox S3 deletion incomplete');
    }
    return objects.length;
  }

  async deleteSandboxPrefix(userId: string): Promise<number> {
    assertSandbox(userId);
    return this.deleteS3Objects(await this.inventoryS3Prefix(`sandbox/${userId}/`));
  }

  async preparePurge(userId: string): Promise<() => Promise<Record<string, number>>> {
    const inventory = await this.inventory(userId);
    // Sandbox publishing is prohibited. A live deployment is unexpected and cannot be
    // silently orphaned or deleted through a shared project without explicit remediation.
    if (inventory.get('AW-LandingPages')!.some(row => row.githubRepoUrl || row.vercelProjectId || row.deploymentId || row.customDomain)) {
      throw new Error('Sandbox lander has external deployment artifacts; remove and verify deployment before purge');
    }
    const children: Array<{ table: string; owner: string; value: string; keys: string[]; rows: Row[] }> = [];
    const collect = async (table: string, owner: string, value: string, keys: string[]) => {
      children.push({ table, owner, value, keys, rows: await this.ownedRows(table, owner, value, keys) });
    };
    await collect('AW-AccountMemory', 'userId', userId, ['userId', 'memoryId']);
    await collect('AW-Skills', 'ownerId', userId, ['skillId']);
    await collect('AW-Deals', 'ownerUserId', userId, ['dealId']);
    await collect('AW-Settings', 'settingName', `templates_${userId}`, ['settingName']);
    for (const list of inventory.get('AW-LeadLists')!) await collect('AW-Leads', 'listId', list.listId, ['listId', 'leadId']);
    for (const book of inventory.get('AW-Books')!) await collect('AW-BookContents', 'bookId', book.bookId, ['bookId', 'contentId']);
    for (const run of inventory.get('AW-AgentRuns')!) {
      if (typeof run.runId === 'string') await collect('AW-AgentRuns', 'runId', run.runId, ['pk']);
    }
    const messages: Row[] = [];
    for (const session of inventory.get('AW-ChatSessions')!) {
      for (const message of await this.ownedRows('AW-ChatMessages', 'sessionId', session.sessionId, ['sessionId', 'messageIndex'])) messages.push(message);
    }
    // Executions outlive deleted task definitions. Their files remain scoped to the
    // execution owner, so clean that narrow prefix even without a task parent.
    const orphanExecutions = inventory.get('AW-TaskExecutions')!.filter(execution =>
      execution.taskId !== undefined && !inventory.get('AW-Tasks')!.some(task => task.taskId === execution.taskId));
    for (const execution of orphanExecutions) assertId(execution.taskId);
    const prefixes = [
      `sandbox/${userId}/`, `users/${userId}/`,
      ...inventory.get('AW-ChatSessions')!.map(session => `tool-responses/${session.sessionId}/`),
      ...orphanExecutions.map(execution => `tasks/${execution.taskId}/executions/${execution.executionId}/`),
      ...inventory.get('AW-Tasks')!.map(task => `tasks/${task.taskId}/`),
      ...inventory.get('AW-WorkPlans')!.map(plan => `workplans/${plan.planId}/`),
    ];
    const objects: AWS.S3.ObjectIdentifier[] = [];
    for (const prefix of new Set(prefixes)) {
      for (const object of await this.inventoryS3Prefix(prefix)) objects.push(object);
    }
    // Preparation must finish across every owner and prefix before any deletion.
    return async () => {
      const counts: Record<string, number> = { s3: await this.deleteS3Objects(objects) };
      for (const task of inventory.get('AW-Tasks')!) await this.deleteGcsPrefix(`tasks/${task.taskId}/`);
      for (const message of messages) {
        await this.db.delete({ TableName: this.tablePrefix + 'AW-ChatMessages',
          Key: { sessionId: message.sessionId, messageIndex: message.messageIndex },
          ConditionExpression: 'sessionId = :session', ExpressionAttributeValues: { ':session': message.sessionId },
        }).promise();
      }
      counts['AW-ChatMessages'] = messages.length;
      for (const child of children) {
        let deleted = 0;
        for (const row of child.rows) {
          if (child.table === 'AW-AgentRuns' && row.userId === userId) continue;
          await this.db.delete({ TableName: this.tablePrefix + child.table,
            Key: Object.fromEntries(child.keys.map(key => [key, row[key]])),
            ConditionExpression: '#owner = :owner', ExpressionAttributeNames: { '#owner': child.owner },
            ExpressionAttributeValues: { ':owner': child.value },
          }).promise();
          deleted++;
        }
        counts[child.table] = (counts[child.table] ?? 0) + deleted;
      }
      // Shares are fields on AW-ChatSessions; deleting the session invalidates every share.
      for (const [table, key] of TABLES) {
        counts[table] = counts[table] ?? 0;
        for (const row of inventory.get(table)!) {
          await this.db.delete({ TableName: this.tablePrefix + table, Key: { [key]: row[key], ...(['AW-Characters', 'AW-Books'].includes(table) ? { userId } : {}) },
            ConditionExpression: '#owner = :user', ExpressionAttributeNames: { '#owner': ownerField(table) },
            ExpressionAttributeValues: { ':user': userId },
          }).promise();
          counts[table]++;
        }
      }
      return counts;
    };
  }

  async purge(userId: string): Promise<Record<string, number>> {
    return (await this.preparePurge(userId))();
  }
}

export const sandboxArtifactCleanup = new SandboxArtifactCleanup();
export const cleanupSandboxArtifacts = (userId: string) => sandboxArtifactCleanup.purge(userId);
export const deleteSandboxPrefix = (userId: string) => sandboxArtifactCleanup.deleteSandboxPrefix(userId);
