import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { EvaluationDenied, isEvaluationUser } from './evaluationPolicy';

export interface EvaluationMaterial { title: string; text: string; approved: true }
export interface EvaluationRecord {
  userId: string;
  email: string;
  status: 'active' | 'revoked';
  expiresAt: number;
  remaining: number;
  materials: EvaluationMaterial[];
}
export interface ProvisionEvaluation {
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
    return (result.Item as EvaluationRecord) || null;
  }

  private audit(userId: string, actor: string, action: string) {
    return { Put: { TableName: this.table, Item: {
      evaluationKey: `evaluation/${userId}/audit/${randomUUID()}`, userId, actor, action, at: new Date().toISOString(),
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
    const userId = `eval_${randomUUID()}`;
    const email = input.email.toLowerCase();
    const record: EvaluationRecord = {
      userId, email, status: 'active', expiresAt: input.expiresAt, remaining: input.generationBudget,
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

  async reserve(userId: string) {
    await this.db.transactWrite({ TransactItems: [{ Update: {
      TableName: this.table, Key: this.key(userId),
      UpdateExpression: 'SET remaining = remaining - :one',
      ConditionExpression: '#status = :active AND expiresAt > :now AND remaining > :zero',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':now': Date.now(), ':zero': 0, ':one': 1 },
    } }, this.audit(userId, userId, 'generation-reserved')] }).promise();
  }

  async saveArtifact(userId: string, content: Buffer, mime: 'text/plain' | 'image/jpeg' | 'application/octet-stream') {
    if (!Buffer.isBuffer(content) || content.length === 0 || content.length > 240000 || !['text/plain', 'image/jpeg', 'application/octet-stream'].includes(mime)) throw new EvaluationDenied();
    const artifactId = randomUUID();
    await this.db.transactWrite({ TransactItems: [
      { Update: { TableName: this.table, Key: this.key(userId),
        UpdateExpression: 'SET artifacts = list_append(if_not_exists(artifacts, :empty), :artifact)',
        ConditionExpression: '#status = :active AND expiresAt > :now AND (attribute_not_exists(artifacts) OR size(artifacts) < :limit)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':empty': [], ':artifact': [{ artifactId, mime }], ':active': 'active', ':now': Date.now(), ':limit': 100 },
      } },
      { Put: { TableName: this.table, Item: { evaluationKey: `evaluation/${userId}/artifact/${artifactId}`, userId, content, mime }, ConditionExpression: 'attribute_not_exists(evaluationKey)' } },
    ] }).promise();
    return { artifactId, mime };
  }

  async getArtifact(userId: string, artifactId: string) {
    this.key(userId);
    if (!/^[a-zA-Z0-9-]+$/.test(artifactId)) throw new EvaluationDenied();
    const result = await this.db.get({ TableName: this.table, Key: { evaluationKey: `evaluation/${userId}/artifact/${artifactId}` }, ConsistentRead: true }).promise();
    if (!result.Item || result.Item.userId !== userId || !Buffer.isBuffer(result.Item.content) || !['text/plain', 'image/jpeg', 'application/octet-stream'].includes(result.Item.mime)) throw new EvaluationDenied();
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
    const audit = this.audit(userId, actor, 'revoke');
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
    const cleanup = await this.cleanupCredentials(userId);
    const cleanupAudit = this.audit(userId, actor, 'revocation-cleanup');
    await this.db.transactWrite({ TransactItems: [{ Put: { ...cleanupAudit.Put, Item: { ...cleanupAudit.Put.Item, cleanup } } }] }).promise();
    return { userId, status: 'revoked', audit: audit.Put.Item, cleanup, cleanupAudit: cleanupAudit.Put.Item };
  }

  private async cleanupCredentials(userId: string) {
    const counts: Record<string, number> = {};
    // Primary-table scans avoid stale identity indexes during revocation. Only key + owner
    // are read; credential material never enters this process or its audit evidence.
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
          page = await this.db.scan({ TableName: `${this.prefix}${table}`, ConsistentRead: true,
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
          } catch (error: any) { if (error?.code !== 'ConditionalCheckFailedException') throw error; }
          counts[table]++;
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
    }
    return counts;
  }
}

export const evaluationStore = new EvaluationStore();
