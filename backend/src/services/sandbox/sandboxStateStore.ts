import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import { EvaluationDenied } from '../evaluationPolicy';
import { EMPTY_OVERLAY, type SandboxOverlay, type SimRequest, type SimResponse } from './types';

type Db = Pick<AWS.DynamoDB.DocumentClient, 'get' | 'put'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Reject malformed persisted objects before either simulator reads or reviewer diffs use them. */
export function validateOverlay(value: unknown): asserts value is SandboxOverlay {
  if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Number.isSafeInteger(value.nextId) || Number(value.nextId) < 1) throw new EvaluationDenied();
  for (const kind of ['campaigns', 'adsets', 'ads', 'adcreatives', 'adimages']) {
    const rows = value[kind];
    if (!object(rows)) throw new EvaluationDenied();
    for (const [key, row] of Object.entries(rows)) {
      if (!object(row) || (kind === 'adimages' ? row.hash : row.id) !== key || !key || (kind !== 'adimages' && !/^\d+$/.test(key))) throw new EvaluationDenied();
      if (typeof row.name !== 'string' || typeof row.status !== 'string') throw new EvaluationDenied();
      if (kind !== 'adimages' && (typeof row.account_id !== 'string' || !/^\d+$/.test(row.account_id))) throw new EvaluationDenied();
      if (kind === 'campaigns' && (typeof row.objective !== 'string' || !Array.isArray(row.special_ad_categories) || row.special_ad_categories.some(value => typeof value !== 'string'))) throw new EvaluationDenied();
      if (kind === 'adsets' && (typeof row.campaign_id !== 'string' || !object(row.targeting) || typeof row.optimization_goal !== 'string' || typeof row.billing_event !== 'string')) throw new EvaluationDenied();
      if (kind === 'ads' && (typeof row.campaign_id !== 'string' || typeof row.adset_id !== 'string' || !object(row.creative) || typeof row.creative.id !== 'string')) throw new EvaluationDenied();
      if (kind === 'adimages' && (typeof row.url !== 'string' || typeof row.width !== 'number' || typeof row.height !== 'number')) throw new EvaluationDenied();
    }
  }
  if (!Array.isArray(value.deletedIds) || value.deletedIds.some(id => typeof id !== 'string' || !id) || !object(value.reviewUntil) || Object.values(value.reviewUntil).some(at => typeof at !== 'string' || !Number.isFinite(Date.parse(at))) || !Array.isArray(value.capiEvents) || value.capiEvents.some(event => !object(event) || typeof event.pixelId !== 'string' || typeof event.receivedAt !== 'string' || !Number.isFinite(Date.parse(event.receivedAt)) || !Number.isSafeInteger(event.count) || Number(event.count) < 0)) throw new EvaluationDenied();
}
function redact(value: unknown, token: string, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'object' && parsed !== null) return redact(parsed, token, depth + 1); } catch { /* Plain text. */ }
    return (token ? value.split(token).join('[redacted]') : value).replace(/([?&](?:access_token|fb_exchange_token|client_secret|appsecret_proof)=)[^&\s]+/gi, '$1[redacted]').replace(/sbx\.[A-Za-z0-9_.-]+/g, '[redacted]').slice(0, 8192);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, token, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => /token|secret|authorization|password|appsecret_proof/i.test(key) ? ['[credential]', '[redacted]'] : [key, redact(item, token, depth + 1)]));
  return value ?? null;
}
export class SandboxStateStore {
  private table = `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-Evaluations`;
  constructor(private db: Db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' })) {}
  private prefix(userId: string) {
    if (!/^eval_[a-zA-Z0-9-]+$/.test(userId)) throw new EvaluationDenied();
    return `evaluation/${userId}`;
  }
  async loadOverlay(userId: string): Promise<SandboxOverlay> {
    const result = await this.db.get({ TableName: this.table, Key: { evaluationKey: `${this.prefix(userId)}/sim` }, ConsistentRead: true }).promise();
    if (!result.Item) return JSON.parse(JSON.stringify(EMPTY_OVERLAY));
    if (result.Item.userId !== userId) throw new EvaluationDenied();
    validateOverlay(result.Item.overlay);
    return result.Item.overlay;
  }
  async recordAction(req: SimRequest, response: SimResponse, at: Date): Promise<void> {
    const args = { ...req.query, ...(object(req.json) ? req.json : {}), ...req.form, ...req.multipart?.fields };
    let result: unknown;
    try { result = JSON.parse(response.body); } catch { result = response.body; }
    const details = redact({ args, result }, req.token) as Record<string, unknown>;
    // Bound the DynamoDB item even for large insight pages; the complete result stays with the caller.
    if (Buffer.byteLength(JSON.stringify(details.result)) > 100000) details.result = { omitted: 'response exceeds audit limit', bytes: Buffer.byteLength(response.body) };
    if (Buffer.byteLength(JSON.stringify(details.args)) > 100000) details.args = { omitted: 'arguments exceed audit limit' };
    await this.db.put({ TableName: this.table, Item: { evaluationKey: `${this.prefix(req.userId)}/audit/${at.toISOString()}/${randomUUID()}`, userId: req.userId, actor: req.userId, action: 'meta', at: at.toISOString(), method: req.method, path: redact(req.path, req.token), status: response.status, ...details }, ConditionExpression: 'attribute_not_exists(evaluationKey)' }).promise();
  }
}
export const sandboxStateStore = new SandboxStateStore();
