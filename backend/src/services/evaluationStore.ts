import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { applySimulation, createSimulation, validateSimulation, SimulationCommand, SimulationPacket, SimulationState } from './evaluationSimulation';
import { EvaluationDenied, isEvaluationUser } from './evaluationPolicy';

export interface EvaluationMaterial { title: string; text: string; approved: true }
export interface EvaluationRecord {
  userId: string;
  email: string;
  status: 'active' | 'revoked';
  expiresAt: number;
  remaining: number;
  materials: EvaluationMaterial[];
  simulation?: SimulationState;
  simulationRevision?: number;
  artifactEpoch?: number;
  resetArtifacts?: string[];
  artifacts?: { artifactId: string; mime: string }[];
  provisionedBy?: string;
  reviewerUserIds?: string[];
}
export interface ProvisionEvaluation {
  simulationPacket?: SimulationPacket;
  reviewerUserIds?: string[];
  email: string;
  displayName: string;
  password: string;
  generationBudget: number;
  expiresAt: number;
  materials: EvaluationMaterial[];
}

/** Evaluation data never enters customer asset tables, shared S3, or connector storage. */
export class EvaluationStore {
  private prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  private table = `${this.prefix}AW-Evaluations`;
  private users = `${this.prefix}AW-Users`;
  constructor(private db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' })) {}

  private key(userId: string) {
    if (!isEvaluationUser(userId) || !/^eval_[a-zA-Z0-9-]+$/.test(userId)) throw new EvaluationDenied();
    return { evaluationKey: `evaluation/${userId}` };
  }

  async get(userId: string): Promise<EvaluationRecord | null> {
    const result = await this.db.get({ TableName: this.table, Key: this.key(userId), ConsistentRead: true }).promise();
    if (!result.Item) return null;
    const record = result.Item as EvaluationRecord;
    if (record.userId !== userId) throw new EvaluationDenied();
    if (record.simulation !== undefined) validateSimulation(userId, record.simulation);
    for (const count of [record.simulationRevision, record.artifactEpoch]) if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new EvaluationDenied();
    if (record.artifacts !== undefined && (!Array.isArray(record.artifacts) || record.artifacts.length > 100 ||
      record.artifacts.some(a => !a || typeof a.artifactId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(a.artifactId) || !['text/plain', 'image/jpeg', 'application/octet-stream'].includes(a.mime)))) throw new EvaluationDenied();
    if (record.resetArtifacts !== undefined && (!Array.isArray(record.resetArtifacts) || record.resetArtifacts.length > 100 ||
      record.resetArtifacts.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)))) throw new EvaluationDenied();
    return record;
  }

  private audit(userId: string, actor: string, action: string, details: Record<string, unknown> = {}) {
    return { Put: { TableName: this.table, Item: {
      evaluationKey: `evaluation/${userId}/audit/${randomUUID()}`, userId, actor, action, at: new Date().toISOString(), ...details,
    }, ConditionExpression: 'attribute_not_exists(evaluationKey)' } };
  }

  async provision(actor: string, input: ProvisionEvaluation) {
    if (!input || typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254 ||
        typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 100 ||
        typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 72 ||
        !Number.isSafeInteger(input.generationBudget) || input.generationBudget < 1 || input.generationBudget > 100 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 30 * 86400000 ||
        !Array.isArray(input.materials) || input.materials.length > 10 ||
        input.materials.some(m => !m || typeof m !== 'object' || m.approved !== true || typeof m.title !== 'string' || !m.title || m.title.length > 100 || typeof m.text !== 'string' || m.text.length > 10000) ||
        JSON.stringify(input.materials).length > 30000) throw new EvaluationDenied();
    if (input.reviewerUserIds !== undefined && (!Array.isArray(input.reviewerUserIds) || input.reviewerUserIds.length > 5 ||
      input.reviewerUserIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)))) throw new EvaluationDenied();
    const userId = `eval_${randomUUID()}`;
    const simulation = createSimulation(userId, input.simulationPacket);
    const email = input.email.toLowerCase();
    const record: EvaluationRecord = {
      userId, email, status: 'active', provisionedBy: actor, reviewerUserIds: input.reviewerUserIds || [], simulation, simulationRevision: 0, artifactEpoch: 0, expiresAt: input.expiresAt, remaining: input.generationBudget,
      materials: input.materials.map(({ title, text }) => ({ title, text, approved: true })),
    };
    const audit = this.audit(userId, actor, 'provision');
    await this.db.transactWrite({ TransactItems: [
      { Put: { TableName: this.users, Item: {
        email, userId, displayName: input.displayName, password: await bcrypt.hash(input.password, 12),
        isOAuthUser: false, isAdmin: false, isActive: true, roles: ['customer'],
        subscriptionType: 'Pro', subscription_status: 'active', sessionVersion: 0,
        signupSource: 'evaluation', createdAt: new Date().toISOString(),
        memoryEnabled: false, emailNotificationsEnabled: false, emmaTipsEnabled: false,
      }, ConditionExpression: 'attribute_not_exists(email)' } },
      { Put: { TableName: this.table, Item: { ...this.key(userId), ...record }, ConditionExpression: 'attribute_not_exists(evaluationKey)' } },
      audit,
    ] }).promise();
    return { userId, expiresAt: record.expiresAt, remaining: record.remaining, audit: audit.Put.Item };
  }

  async simulate(userId: string, input: SimulationCommand) {
    const record = await this.get(userId);
    this.active(record, userId);
    const { state, result } = applySimulation(userId, record.simulation || createSimulation(userId), input, (record.artifacts || []).map(a => a.artifactId));
    if (['query', 'inspect'].includes(input.operation)) {
      this.active(await this.get(userId), userId);
      return result;
    }
    const revision = record.simulationRevision || 0;
    const reset = input.operation === 'reset';
    const artifacts = record.artifacts || [];
    const pending = [...new Set([...(record.resetArtifacts || []), ...artifacts.map(a => a.artifactId)])];
    if (pending.length > 100 || pending.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id))) throw new EvaluationDenied();
    const epoch = (record.artifactEpoch || 0) + 1;
    const audit = this.audit(userId, userId, `simulation:${input.operation}`, {
      ok: result.ok, errors: result.errors, warnings: result.warnings, objectId: result.object?.id || null,
      object: result.object ? { ...result.object, ...(result.object.upload ? { upload: { mime: result.object.upload.mime, bytes: Buffer.from(result.object.upload.base64, 'base64').length } } : {}) } : null, revision: revision + 1,
    });
    await this.db.transactWrite({ TransactItems: [{ Update: {
      TableName: this.table, Key: this.key(userId),
      UpdateExpression: 'SET simulation = :simulation, simulationRevision = :next' + (reset ? ', artifacts = :empty, artifactEpoch = :epoch, resetArtifacts = :pending' : ''),
      ConditionExpression: '#status = :active AND expiresAt > :now AND (simulationRevision = :revision OR (attribute_not_exists(simulationRevision) AND :revision = :zero))',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':now': Date.now(), ':revision': revision, ':zero': 0, ':next': revision + 1,
        ':simulation': state, ...(reset ? { ':empty': [], ':epoch': epoch, ':pending': pending } : {}) },
    } }, audit] }).promise();
    if (reset) {
      // Access is already invalidated atomically. Keep cleanup intent durable for retries.
      // Each batch also checks live policy/epoch, so revoke or another reset stops stale cleanup.
      const guard = {
        TableName: this.table, Key: this.key(userId),
        ConditionExpression: '#status = :active AND expiresAt > :now AND artifactEpoch = :epoch',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':now': Date.now(), ':epoch': epoch },
      };
      for (let i = 0; i < pending.length; i += 99) {
        await this.db.transactWrite({ TransactItems: [{ ConditionCheck: guard }, ...pending.slice(i, i + 99).map(id => ({
          Delete: { TableName: this.table, Key: { evaluationKey: `evaluation/${userId}/artifact/${id}` } },
        }))] }).promise();
      }
      await this.db.transactWrite({ TransactItems: [{ Update: { ...guard, UpdateExpression: 'REMOVE resetArtifacts' } }] }).promise();
    }
    this.active(await this.get(userId), userId);
    return result;
  }

  private active(record: EvaluationRecord | null, userId: string): asserts record is EvaluationRecord {
    if (!record || record.userId !== userId || record.status !== 'active' || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) throw new EvaluationDenied();
  }

  /** Explicit assignment, never organization membership, authorizes reviewer access. */
  async requireReview(actor: string, userId: string) {
    const record = await this.get(userId);
    if (!record || record.userId !== userId || (record.provisionedBy !== actor &&
      (!Array.isArray(record.reviewerUserIds) || !record.reviewerUserIds.includes(actor)))) throw new EvaluationDenied();
    return record;
  }

  async review(actor: string, userId: string) {
    const record = await this.requireReview(actor, userId);
    const audit: Record<string, unknown>[] = [];
    let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
    let pages = 0;
    do {
      const page = await this.db.scan({ TableName: this.table, ConsistentRead: true, Limit: 100,
        FilterExpression: 'userId = :user AND begins_with(evaluationKey, :prefix)',
        ExpressionAttributeValues: { ':user': userId, ':prefix': `evaluation/${userId}/audit/` },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }).promise();
      if (!Array.isArray(page.Items)) throw new EvaluationDenied();
      for (const item of page.Items) {
        if (!item || item.userId !== userId || typeof item.evaluationKey !== 'string' || !item.evaluationKey.startsWith(`evaluation/${userId}/audit/`)) throw new EvaluationDenied();
        audit.push(item);
      }
      cursor = page.LastEvaluatedKey; pages++;
    } while (cursor && audit.length < 1000 && pages < 100);
    return { userId, status: record.status, simulation: record.simulation || createSimulation(userId), materials: record.materials,
      artifacts: record.artifacts || [], audit, truncated: !!cursor };
  }

  async reserve(userId: string) {
    await this.db.transactWrite({ TransactItems: [{ Update: {
      TableName: this.table, Key: this.key(userId),
      UpdateExpression: 'SET remaining = remaining - :one',
      ConditionExpression: '#status = :active AND expiresAt > :now AND remaining > :zero',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':now': Date.now(), ':zero': 0, ':one': 1 },
    } }, this.audit(userId, userId, 'generation-reserved')] }).promise();
  }

  async saveArtifact(userId: string, content: Buffer, mime: 'text/plain' | 'image/jpeg' | 'application/octet-stream', expectedEpoch?: number) {
    if (!Buffer.isBuffer(content) || content.length === 0 || content.length > 240000 || !['text/plain', 'image/jpeg', 'application/octet-stream'].includes(mime)) throw new EvaluationDenied();
    const record = await this.get(userId);
    this.active(record, userId);
    const epoch = expectedEpoch ?? record.artifactEpoch ?? 0;
    if (epoch !== (record.artifactEpoch || 0) || record.resetArtifacts !== undefined) throw new EvaluationDenied();
    const artifactId = randomUUID();
    await this.db.transactWrite({ TransactItems: [
      { Update: { TableName: this.table, Key: this.key(userId),
        UpdateExpression: 'SET artifacts = list_append(if_not_exists(artifacts, :empty), :artifact) ADD simulationRevision :one',
        ConditionExpression: '#status = :active AND expiresAt > :now AND (attribute_not_exists(artifacts) OR size(artifacts) < :limit) AND attribute_not_exists(resetArtifacts) AND (artifactEpoch = :epoch OR (attribute_not_exists(artifactEpoch) AND :epoch = :zero))',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':empty': [], ':artifact': [{ artifactId, mime }], ':active': 'active', ':now': Date.now(), ':limit': 100, ':epoch': epoch, ':zero': 0, ':one': 1 },
      } },
      { Put: { TableName: this.table, Item: { evaluationKey: `evaluation/${userId}/artifact/${artifactId}`, userId, content, mime }, ConditionExpression: 'attribute_not_exists(evaluationKey)' } },
    ] }).promise();
    return { artifactId, mime };
  }

  async getArtifact(userId: string, artifactId: string) {
    this.key(userId);
    if (!/^[a-zA-Z0-9-]+$/.test(artifactId)) throw new EvaluationDenied();
    const record = await this.get(userId);
    if (!record || record.userId !== userId || !Array.isArray(record.artifacts) || !record.artifacts.some(a => a?.artifactId === artifactId)) throw new EvaluationDenied();
    const result = await this.db.get({ TableName: this.table, Key: { evaluationKey: `evaluation/${userId}/artifact/${artifactId}` }, ConsistentRead: true }).promise();
    if (!result.Item || result.Item.userId !== userId || !Buffer.isBuffer(result.Item.content) || !['text/plain', 'image/jpeg', 'application/octet-stream'].includes(result.Item.mime)) throw new EvaluationDenied();
    const latest = await this.get(userId);
    if (!latest || (latest.artifactEpoch || 0) !== (record.artifactEpoch || 0) || !latest.artifacts?.some(a => a.artifactId === artifactId)) throw new EvaluationDenied();
    return { content: result.Item.content as Buffer, mime: result.Item.mime as string };
  }

  async discardJob(userId: string, scheduleId: string) {
    this.key(userId);
    if (typeof scheduleId !== 'string' || !scheduleId) throw new EvaluationDenied();
    try {
      await this.db.delete({ TableName: `${this.prefix}AW-TaskSchedules`, Key: { scheduleId },
        ConditionExpression: 'userId = :user', ExpressionAttributeValues: { ':user': userId },
      }).promise();
    } catch (error: any) { if (error?.code !== 'ConditionalCheckFailedException') throw error; }
  }

  async revoke(actor: string, userId: string) {
    const record = await this.get(userId);
    if (!record || record.userId !== userId || typeof record.email !== 'string') throw new EvaluationDenied();
    const audit = this.audit(userId, actor, 'revoke', { cleanupStatus: 'pending' });
    // This marker is committed with the deny state, so incomplete cleanup remains
    // durable even when both cleanup and the best-effort failure audit write fail.
    const writes: AWS.DynamoDB.DocumentClient.TransactWriteItemList = [
      { Update: { TableName: this.table, Key: this.key(userId),
        UpdateExpression: 'SET #status = :revoked', ConditionExpression: 'userId = :user',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':user': userId },
      } },
      { Update: { TableName: this.users, Key: { email: record.email },
        UpdateExpression: 'SET isActive = :inactive ADD sessionVersion :one, delegateTokenEpoch :one',
        ConditionExpression: 'userId = :user', ExpressionAttributeValues: { ':inactive': false, ':one': 1, ':user': userId },
      } }, audit,
    ];
    try {
      await this.db.transactWrite({ TransactItems: writes }).promise();
    } catch (error: any) {
      // A separately deleted/replaced account must not keep its policy or MCP grants alive.
      const reasons = error?.CancellationReasons;
      if (!Array.isArray(reasons) || reasons.length !== 3 || reasons[1]?.Code !== 'ConditionalCheckFailed' ||
          reasons.some((r, i) => i !== 1 && r?.Code !== 'None')) throw error;
      await this.db.transactWrite({ TransactItems: [writes[0], writes[2]] }).promise();
    }
    let cleanup: Record<string, number>;
    try { cleanup = await this.cleanupCredentials(userId); } catch (error) {
      try { await this.db.transactWrite({ TransactItems: [this.audit(userId, actor, 'revocation-cleanup-failed')] }).promise(); } catch {
        // The original revoke audit is already committed. Keep the cleanup failure.
      }
      throw error;
    }
    const cleanupAudit = this.audit(userId, actor, 'revocation-cleanup');
    await this.db.transactWrite({ TransactItems: [{ Put: { ...cleanupAudit.Put, Item: { ...cleanupAudit.Put.Item, cleanup } } }] }).promise();
    return { userId, status: 'revoked', audit: audit.Put.Item, cleanup, cleanupAudit: cleanupAudit.Put.Item };
  }

  private async cleanupCredentials(userId: string) {
    const counts: Record<string, number> = {};
    // Primary-table scans avoid stale identity indexes during revocation. Only key + owner
    // are read for conditional deletion; row keys and credential values are never logged.
    for (const [table, key, owner] of [
      ['AW-AgentApiKeys', 'keyId', 'userId'], ['AW-MCPOAuthTokens', 'tokenHash', 'userId'],
      ['AW-MCPOAuthCodes', 'code', 'userId'], ['AW-MCPSessions', 'sessionId', 'agentUserId'],
      ['AW-TaskSchedules', 'scheduleId', 'userId'],
    ]) {
      counts[table] = 0;
      let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        let page: AWS.DynamoDB.DocumentClient.ScanOutput;
        try {
          page = await this.db.scan({ TableName: `${this.prefix}${table}`, ConsistentRead: true, Limit: 100,
            FilterExpression: '#owner = :user', ProjectionExpression: '#key, #owner',
            ExpressionAttributeNames: { '#key': key, '#owner': owner }, ExpressionAttributeValues: { ':user': userId },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }).promise();
        } catch (error: any) {
          // Some environments use only the in-memory MCP store; absent tables hold no grants.
          if (error?.code === 'ResourceNotFoundException') break;
          throw error;
        }
        if (!Array.isArray(page.Items)) throw new EvaluationDenied();
        for (const item of page.Items) {
          if (!item || item[owner] !== userId || typeof item[key] !== 'string') throw new EvaluationDenied();
          try {
            await this.db.delete({ TableName: `${this.prefix}${table}`, Key: { [key]: item[key] },
              ConditionExpression: '#owner = :user', ExpressionAttributeNames: { '#owner': owner }, ExpressionAttributeValues: { ':user': userId },
            }).promise();
            counts[table]++;
          } catch (error: any) { if (error?.code !== 'ConditionalCheckFailedException') throw error; }
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
    }
    return counts;
  }
}

export const evaluationStore = new EvaluationStore();
