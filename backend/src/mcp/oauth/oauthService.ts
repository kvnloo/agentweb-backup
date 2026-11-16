import { activeEvaluationCondition, isTransactionConditionFailure, writeWithEvaluationGuard } from '../../services/evaluationPersistence';
import { isEvaluationUser, requireActiveEvaluation } from '../../services/evaluationPolicy';
/**
 * MCP OAuth 2.1 Service
 *
 * Handles dynamic client registration, authorization codes (with PKCE),
 * and access/refresh token lifecycle.
 *
 * Follows the same patterns as agentApiKeyService.ts:
 * - SHA256 hashing for secrets and tokens
 * - DynamoDB DocumentClient with TABLE_PREFIX
 * - Singleton export
 */

import AWS from "aws-sdk";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { AttributionConfidence, JourneyProduct } from "../../services/journeyAttribution";
import { isJourneyProduct, validateRef } from "../../services/journeyAttribution";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
  clientSecretHash?: string;
  createdAt: string;
}

export interface OAuthAuthorizationCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  used: boolean;
  expiresAt: number; // epoch seconds (DynamoDB TTL)
  createdAt: string;
  /** ENG-2906 attribution only — never consulted for authorization. Absent on legacy codes. */
  product?: JourneyProduct;
  attributionConfidence?: AttributionConfidence;
  ref?: string;
}

/**
 * ENG-2906: what /oauth/authorize learned (RFC 8707 resource, ref) before the portal consent
 * page, which posts back only the standard fields. Keyed by client + PKCE challenge.
 */
export interface PendingAuthorizationAttribution {
  product: JourneyProduct;
  confidence: AttributionConfidence;
  ref?: string;
}

export interface OAuthTokenRecord {
  tokenHash: string;
  refreshTokenHash: string;
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number; // epoch seconds (DynamoDB TTL)
  refreshExpiresAt: number;
  accessExpiresAt?: number; // Legacy records use expiresAt for access expiry.
  familyId?: string; // Root tokenHash; legacy refresh tokens without lineage require login.
  familyRevoked?: boolean; // Only authoritative on the root; retained until family expiry.
  revoked: boolean;
  revokedAtSec?: number; // epoch seconds when this record's refresh was consumed; bounds replay grace.
  createdAt: string;
  /** ENG-2906 attribution only; copied onto every rotated successor. Absent on legacy tokens. */
  product?: JourneyProduct;
}

export interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
}

export interface RegisterClientParams {
  redirectUris: string[];
  clientName: string;
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
  scope?: string;
}

export interface RegisterClientResult {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
}

export interface CreateAuthCodeParams {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  product?: JourneyProduct;
  attributionConfidence?: AttributionConfidence;
  ref?: string;
}

export interface CreateTokenPairParams {
  clientId: string;
  userId: string;
  scope: string;
  product?: JourneyProduct;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SUPPORTED_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'];
const AUTH_CODE_TTL_SEC = 600; // 10 minutes
// A pending attribution row lives as long as a consent page plausibly stays open (sign-up included).
const PENDING_AUTHORIZATION_TTL_SEC = 3600;
const pendingAuthorizationKey = (clientId: string, codeChallenge: string) =>
  `pending#${crypto.createHash('sha256').update(`${clientId}\n${codeChallenge}`).digest('hex')}`;
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days
// Duplicate-delivery grace: a consumed refresh token re-presented within this window
// returns the already-issued successor instead of revoking the family. Covers benign
// races (multi-process clients, retried requests after a lost response) without weakening
// theft detection — a genuinely stolen ancestor replayed after the window still revokes.
const REFRESH_REPLAY_GRACE_SEC = 60;

// ─── Service ─────────────────────────────────────────────────────────────────

export class McpOAuthService {
  private clientsTable: string;
  private codesTable: string;
  private tokensTable: string;

  constructor() {
    this.clientsTable = `${TABLE_PREFIX}AW-MCPOAuthClients`;
    this.codesTable = `${TABLE_PREFIX}AW-MCPOAuthCodes`;
    this.tokensTable = `${TABLE_PREFIX}AW-MCPOAuthTokens`;
  }

  // ─── Client Registration ────────────────────────────────────────────────

  async registerClient(params: RegisterClientParams): Promise<RegisterClientResult> {
    if (typeof params.clientName !== 'string' || params.clientName.trim() === '') {
      throw new Error('Client name is required');
    }
    if (!Array.isArray(params.redirectUris) || params.redirectUris.length === 0) {
      throw new Error('At least one redirect URI is required');
    }

    // Validate redirect URIs
    for (const uri of params.redirectUris) {
      if (typeof uri !== 'string') throw new Error('Redirect URIs must be strings');
      const parsed = new URL(uri);
      if (uri.includes('#') || parsed.username || parsed.password) {
        throw new Error('Redirect URIs must not contain fragments or credentials');
      }
      const isLoopback =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1' ||
        parsed.hostname === '[::1]';

      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new Error('Redirect URIs must use HTTPS (HTTP only allowed for loopback redirect URIs)');
      }
    }

    const clientId = uuidv4();
    const authMethod = params.tokenEndpointAuthMethod === undefined ? 'none' : params.tokenEndpointAuthMethod;
    if (!SUPPORTED_AUTH_METHODS.includes(authMethod)) throw new Error('invalid_client_metadata');
    const isConfidential = authMethod !== 'none';

    let clientSecret: string | undefined;
    let clientSecretHash: string | undefined;

    if (isConfidential) {
      clientSecret = crypto.randomBytes(32).toString('hex');
      clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');
    }

    const record: OAuthClient = {
      clientId,
      clientName: params.clientName.trim(),
      redirectUris: params.redirectUris,
      grantTypes: params.grantTypes || ['authorization_code', 'refresh_token'],
      responseTypes: params.responseTypes || ['code'],
      tokenEndpointAuthMethod: authMethod,
      scope: params.scope || 'mcp:tools',
      ...(clientSecretHash && { clientSecretHash }),
      createdAt: new Date().toISOString(),
    };

    await dynamodb.put({
      TableName: this.clientsTable,
      Item: record,
    }).promise();

    return {
      clientId,
      ...(clientSecret && { clientSecret }),
      clientName: record.clientName,
      redirectUris: record.redirectUris,
      grantTypes: record.grantTypes,
      responseTypes: record.responseTypes,
      tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
      scope: record.scope,
    };
  }

  // ─── Client Lookup ──────────────────────────────────────────────────────

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await dynamodb.get({
      TableName: this.clientsTable,
      Key: { clientId },
    }).promise();

    const client = result.Item as OAuthClient | undefined;
    if (!client || client.clientId !== clientId || typeof client.clientName !== 'string' ||
        !Array.isArray(client.redirectUris) || !client.redirectUris.every(uri => typeof uri === 'string') ||
        !SUPPORTED_AUTH_METHODS.includes(client.tokenEndpointAuthMethod) ||
        (client.tokenEndpointAuthMethod !== 'none' && typeof client.clientSecretHash !== 'string')) return null;
    return client;
  }

  /**
   * ENG-2496 — idempotently ensure a first-party public client (fixed id) exists and lists
   * `redirectUri`, so a backend flow can reuse the portal sign-in + consent page. Writes a
   * row of the existing client shape only; no schema change.
   */
  async ensureFirstPartyClient(clientId: string, clientName: string, redirectUri: string): Promise<void> {
    const existing = await this.getClient(clientId);
    if (existing?.redirectUris.includes(redirectUri)) return;
    try {
      if (!existing) {
        const record: OAuthClient = {
          clientId,
          clientName,
          redirectUris: [redirectUri],
          grantTypes: ['authorization_code'],
          responseTypes: ['code'],
          tokenEndpointAuthMethod: 'none',
          scope: 'mcp:tools',
          createdAt: new Date().toISOString(),
        };
        await dynamodb.put({ TableName: this.clientsTable, Item: record, ConditionExpression: 'attribute_not_exists(clientId)' }).promise();
      } else {
        await dynamodb.update({
          TableName: this.clientsTable,
          Key: { clientId },
          UpdateExpression: 'SET redirectUris = list_append(redirectUris, :uris)',
          ConditionExpression: 'NOT contains(redirectUris, :uri)',
          ExpressionAttributeValues: { ':uris': [redirectUri], ':uri': redirectUri },
        }).promise();
      }
    } catch (error) {
      // A concurrent caller won the write; the client now exists either way.
      if ((error as { code?: string }).code !== 'ConditionalCheckFailedException') throw error;
    }
  }

  // ─── PKCE Validation ───────────────────────────────────────────────────

  validatePkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
    if (method !== 'S256') {
      throw new Error('Only S256 code challenge method is supported');
    }
    const computed = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return computed === codeChallenge;
  }

  // ─── Authorization Code ────────────────────────────────────────────────

  async createAuthorizationCode(params: CreateAuthCodeParams): Promise<{ code: string }> {
    const code = crypto.randomBytes(48).toString('hex');
    const nowSec = Math.floor(Date.now() / 1000);

    const record: OAuthAuthorizationCode = {
      code,
      clientId: params.clientId,
      userId: params.userId,
      redirectUri: params.redirectUri,
      scope: params.scope,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      used: false,
      expiresAt: nowSec + AUTH_CODE_TTL_SEC,
      createdAt: new Date().toISOString(),
      ...(isJourneyProduct(params.product) && { product: params.product }),
      ...(params.attributionConfidence && { attributionConfidence: params.attributionConfidence }),
      ...(validateRef(params.ref) ? { ref: params.ref } : {}),
    };

    await writeWithEvaluationGuard(dynamodb, params.userId, TABLE_PREFIX, { Put: {
      TableName: this.codesTable,
      Item: record,
    } });

    return { code };
  }

  // ─── Pending authorization attribution (ENG-2906) ──────────────────────
  // Stored in the codes table under a `pending#<sha256>` key. It has no `used` attribute, so
  // consumeAuthorizationCode (which requires used === false) can never redeem it, and the key
  // can never collide with a real 96-hex-char code. Best-effort: callers swallow failures.

  async savePendingAuthorization(clientId: string, codeChallenge: string, attribution: PendingAuthorizationAttribution): Promise<void> {
    const ref = validateRef(attribution.ref);
    await dynamodb.put({
      TableName: this.codesTable,
      Item: {
        code: pendingAuthorizationKey(clientId, codeChallenge),
        kind: 'pending_authorization',
        product: attribution.product,
        attributionConfidence: attribution.confidence,
        ...(ref ? { ref } : {}),
        expiresAt: Math.floor(Date.now() / 1000) + PENDING_AUTHORIZATION_TTL_SEC,
        createdAt: new Date().toISOString(),
      },
    }).promise();
  }

  async takePendingAuthorization(clientId: string, codeChallenge: string, preserveForRetry = false): Promise<PendingAuthorizationAttribution | null> {
    const code = pendingAuthorizationKey(clientId, codeChallenge);
    const result = await dynamodb.get({ TableName: this.codesTable, Key: { code } }).promise();
    const item = result.Item;
    if (!item || item.kind !== 'pending_authorization' || !isJourneyProduct(item.product) ||
        !Number.isFinite(item.expiresAt) || item.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    // Admission can refuse consent. Keep the product hint for an identical retry;
    // it expires via the existing DynamoDB TTL and cannot be redeemed as a code.
    if (!preserveForRetry) await dynamodb.delete({ TableName: this.codesTable, Key: { code } }).promise().catch(() => undefined);
    const confidence: AttributionConfidence =
      item.attributionConfidence === 'explicit' || item.attributionConfidence === 'inferred' ? item.attributionConfidence : 'unknown';
    const ref = validateRef(item.ref);
    return { product: item.product, confidence, ...(ref ? { ref } : {}) };
  }

  async consumeAuthorizationCode(code: string, clientId?: string, redirectUri?: string, codeVerifier?: string): Promise<OAuthAuthorizationCode | null> {
    const result = await dynamodb.get({
      TableName: this.codesTable,
      Key: { code },
    }).promise();

    const record = result.Item as OAuthAuthorizationCode | undefined;
    if (!record || record.used !== false || record.code !== code ||
        typeof record.clientId !== 'string' || (typeof record.userId !== 'string' || !record.userId) ||
        typeof record.scope !== 'string' || typeof record.redirectUri !== 'string' ||
        !Number.isFinite(record.expiresAt)) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (record.expiresAt <= nowSec) return null;
    if (clientId !== undefined && record.clientId !== clientId) return null;
    if (redirectUri !== undefined && record.redirectUri !== redirectUri) return null;

    if (!codeVerifier || typeof record.codeChallenge !== 'string' || record.codeChallengeMethod !== 'S256' ||
        !this.validatePkce(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) return null;

    const conditions = ['used = :unused', 'expiresAt > :now',
      'codeChallenge = :challenge', 'codeChallengeMethod = :method'];
    const values: Record<string, string | number | boolean> = {
      ':used': true, ':unused': false, ':now': Math.floor(Date.now() / 1000),
      ':challenge': record.codeChallenge, ':method': 'S256',
    };
    if (clientId !== undefined) {
      conditions.push('clientId = :clientId');
      values[':clientId'] = clientId;
    }
    if (redirectUri !== undefined) {
      conditions.push('redirectUri = :redirectUri');
      values[':redirectUri'] = redirectUri;
    }

    // The read alone cannot enforce single use: callback paste and the listener
    // can race. DynamoDB must elect one redeemer, including at the TTL boundary.
    try {
      await writeWithEvaluationGuard(dynamodb, record.userId, TABLE_PREFIX, { Update: {
        TableName: this.codesTable,
        Key: { code },
        UpdateExpression: 'SET used = :used',
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeValues: values,
      } });
    } catch (error) {
      if ((error as { code?: string }).code === 'ConditionalCheckFailedException' || isTransactionConditionFailure(error)) return null;
      throw error;
    }

    return record;
  }

  // ─── Token Pair ────────────────────────────────────────────────────────

  async createTokenPair(params: CreateTokenPairParams): Promise<TokenPairResponse> {
    if (isEvaluationUser(params.userId)) await requireActiveEvaluation(params.userId);
    const { record, response } = this.newTokenPair(params);
    await writeWithEvaluationGuard(dynamodb, params.userId, TABLE_PREFIX, { Put: { TableName: this.tokensTable, Item: record } });
    if (isEvaluationUser(params.userId)) await requireActiveEvaluation(params.userId);
    return response;
  }

  private newTokenPair(params: CreateTokenPairParams, familyId?: string, familyExpiresAt?: number):
    { record: OAuthTokenRecord; response: TokenPairResponse } {
    const accessToken = crypto.randomBytes(48).toString('hex');
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const nowSec = Math.floor(Date.now() / 1000);

    const record: OAuthTokenRecord = {
      tokenHash,
      refreshTokenHash,
      userId: params.userId,
      clientId: params.clientId,
      scope: params.scope,
      // TTL must retain ancestors for replay detection, not just access validity.
      expiresAt: familyExpiresAt ?? nowSec + REFRESH_TOKEN_TTL_SEC,
      accessExpiresAt: Math.min(nowSec + ACCESS_TOKEN_TTL_SEC, familyExpiresAt ?? Infinity),
      refreshExpiresAt: familyExpiresAt ?? nowSec + REFRESH_TOKEN_TTL_SEC,
      familyId: familyId ?? tokenHash,
      ...(!familyId && { familyRevoked: false }),
      revoked: false,
      createdAt: new Date().toISOString(),
      // Refresh passes the predecessor record as params, so product rides every rotation.
      ...(isJourneyProduct(params.product) && { product: params.product }),
    };

    return { record, response: {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: record.accessExpiresAt! - nowSec,
      scope: params.scope,
    } };
  }

  // ─── Token Validation ─────────────────────────────────────────────────

  async validateAccessToken(rawToken: string): Promise<OAuthTokenRecord | null> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const result = await dynamodb.get({
      TableName: this.tokensTable,
      Key: { tokenHash },
      ConsistentRead: true,
    }).promise();

    const record = result.Item as OAuthTokenRecord | undefined;
    if (!record || record.revoked !== false || record.tokenHash !== tokenHash ||
        typeof record.clientId !== 'string' || (typeof record.userId !== 'string' || !record.userId) || typeof record.scope !== 'string') return null;

    if (isEvaluationUser(record.userId)) {
      try { await requireActiveEvaluation(record.userId); } catch { return null; }
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const accessExpiry = record.familyId === undefined ? record.expiresAt : record.accessExpiresAt;
    if (typeof accessExpiry !== 'number' || !Number.isFinite(accessExpiry) || accessExpiry <= nowSec) return null;
    if (record.familyId !== undefined && !await this.activeFamily(record)) return null;

    return record;
  }

  // ─── Refresh Flow ─────────────────────────────────────────────────────

  private async tokenRecord(tokenHash: string): Promise<OAuthTokenRecord | null> {
    const result = await dynamodb.get({
      TableName: this.tokensTable, Key: { tokenHash }, ConsistentRead: true,
    }).promise();
    return result.Item as OAuthTokenRecord || null;
  }

  private async activeFamily(record: OAuthTokenRecord): Promise<boolean> {
    if (typeof record.familyId !== 'string' || !record.familyId) return false;
    const root = await this.tokenRecord(record.familyId);
    return !!root && root.familyId === record.familyId && root.familyRevoked === false &&
      root.clientId === record.clientId && root.userId === record.userId &&
      Number.isFinite(root.refreshExpiresAt) && root.refreshExpiresAt > Math.floor(Date.now() / 1000);
  }

  private async retryTransactionConflict<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); } catch (error) {
        const failure = error as { code?: string; CancellationReasons?: { Code?: string }[] };
        const reasons = failure.CancellationReasons;
        const conflict = failure.code === 'TransactionConflictException' ||
          (failure.code === 'TransactionCanceledException' && Array.isArray(reasons) &&
            reasons.some(reason => reason?.Code === 'TransactionConflict') &&
            reasons.every(reason => reason?.Code === 'None' || reason?.Code === 'TransactionConflict'));
        if (!conflict || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }

  private async replayGraceSuccessor(record: OAuthTokenRecord, now: number): Promise<TokenPairResponse | null> {
    // Benign duplicate delivery (multi-process refresh race, retried request after a
    // lost response): the consumed token re-presented within REFRESH_REPLAY_GRACE_SEC
    // of its consumption mints a fresh pair in the same family instead of revoking it.
    // Only hashes are stored, so the already-issued successor's raw tokens are
    // unrecoverable — a fresh sibling pair keeps the client working without weakening
    // theft detection. Outside the window, null: the caller revokes (unchanged).
    if (typeof record.familyId !== 'string' || !record.familyId ||
        !Number.isFinite(record.revokedAtSec) || now - record.revokedAtSec! > REFRESH_REPLAY_GRACE_SEC) return null;
    if (!await this.activeFamily(record)) return null;
    const familyId = record.familyId!;
    const { record: sibling, response } = this.newTokenPair(record, familyId, record.refreshExpiresAt);
    try {
      await dynamodb.put({
        TableName: this.tokensTable,
        Item: sibling,
        ConditionExpression: 'attribute_not_exists(tokenHash)',
      }).promise();
    } catch {
      return null;
    }
    return response;
  }

  private async revokeFamily(record: OAuthTokenRecord): Promise<void> {
    if (!record.familyId) return; // Legacy consumed records have no recoverable lineage.
    try {
      await this.retryTransactionConflict(() => writeWithEvaluationGuard(dynamodb, record.userId, TABLE_PREFIX, { Update: {
        TableName: this.tokensTable, Key: { tokenHash: record.familyId! },
        UpdateExpression: 'SET familyRevoked = :revoked',
        ConditionExpression: 'familyId = :familyId AND clientId = :clientId',
        ExpressionAttributeValues: { ':revoked': true, ':familyId': record.familyId, ':clientId': record.clientId },
      } }));
    } catch (error) {
      // Missing root already disables every descendant; never recreate a TTL-deleted root.
      if ((error as { code?: string }).code !== 'ConditionalCheckFailedException' && !isTransactionConditionFailure(error)) throw error;
    }
  }

  async refreshTokens(rawRefreshToken: string, clientId?: string): Promise<TokenPairResponse | null> {
    if (!clientId) return null;
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const result = await dynamodb.query({
      TableName: this.tokensTable,
      IndexName: 'RefreshTokenHashIndex',
      KeyConditionExpression: 'refreshTokenHash = :hash',
      ExpressionAttributeValues: { ':hash': refreshTokenHash },
    }).promise();
    // The GSI is only a locator: never trust its eventually consistent revoked state.
    if (!Array.isArray(result.Items) || result.Items.length !== 1 ||
        typeof result.Items[0]?.tokenHash !== 'string') return null;
    const record = await this.tokenRecord(result.Items[0].tokenHash);
    const now = Math.floor(Date.now() / 1000);
    if (!record || record.refreshTokenHash !== refreshTokenHash || record.clientId !== clientId ||
        (typeof record.userId !== 'string' || !record.userId) || typeof record.scope !== 'string' ||
        typeof record.revoked !== 'boolean' || !Number.isFinite(record.refreshExpiresAt) ||
        record.refreshExpiresAt <= now) return null;
    if (isEvaluationUser(record.userId)) {
      try { await requireActiveEvaluation(record.userId); } catch { return null; }
    }
    if (record.revoked) {
      const graced = await this.replayGraceSuccessor(record, now);
      if (graced) return graced;
      await this.revokeFamily(record);
      return null;
    }
    // Legacy rows cannot prove their ancestry. Keep existing access validity, but
    // require fresh authorization rather than accepting an untraceable refresh chain.
    if (!await this.activeFamily(record)) return null;
    const familyId = record.familyId!;
    const { record: successor, response } = this.newTokenPair(record, familyId, record.refreshExpiresAt);
    const conditions = ['revoked = :unused', 'refreshExpiresAt > :now',
      'refreshTokenHash = :hash', 'clientId = :clientId'];
    const values: AWS.DynamoDB.DocumentClient.ExpressionAttributeValueMap = {
      ':unused': false, ':used': true, ':now': now, ':hash': refreshTokenHash, ':clientId': clientId,
    };
    if (familyId === record.tokenHash) conditions.push('familyRevoked = :unused');
    const TransactItems: AWS.DynamoDB.DocumentClient.TransactWriteItemList = [
      { Update: { TableName: this.tokensTable, Key: { tokenHash: record.tokenHash },
        UpdateExpression: 'SET revoked = :used, revokedAtSec = :now', ConditionExpression: conditions.join(' AND '), ExpressionAttributeValues: values } },
      { Put: { TableName: this.tokensTable, Item: successor, ConditionExpression: 'attribute_not_exists(tokenHash)' } },
    ];
    if (familyId !== record.tokenHash) {
      TransactItems.push({ ConditionCheck: {
        TableName: this.tokensTable, Key: { tokenHash: familyId },
        ConditionExpression: 'familyRevoked = :unused AND refreshExpiresAt > :now',
        ExpressionAttributeValues: { ':unused': false, ':now': now },
      } });
    }
    if (isEvaluationUser(record.userId)) TransactItems.push(activeEvaluationCondition(record.userId, TABLE_PREFIX));
    try {
      const transaction = { TransactItems, ClientRequestToken: uuidv4() };
      await this.retryTransactionConflict(() => dynamodb.transactWrite(transaction).promise());
    } catch (error) {
      if ((error as { code?: string }).code !== 'TransactionCanceledException') throw error;
      const current = await this.tokenRecord(record.tokenHash);
      // Only authenticated, correctly bound replay revokes. Storage errors must not
      // masquerade as replay or silently revoke an otherwise usable grant.
      if (current?.revoked && current.clientId === clientId && current.refreshTokenHash === refreshTokenHash) {
        const graced = await this.replayGraceSuccessor(current, now);
        if (graced) return graced;
        await this.revokeFamily(current);
        return null;
      }
      if (current?.familyId && !await this.activeFamily(current)) return null;
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
      if (Array.isArray(reasons) && reasons.some(reason => reason?.Code === 'ConditionalCheckFailed')) return null;
      throw error;
    }
    if (isEvaluationUser(record.userId)) {
      try { await requireActiveEvaluation(record.userId); } catch { return null; }
    }
    return response;
  }

  // ─── Client Secret Validation ─────────────────────────────────────────

  validateClientSecret(rawSecret: string, storedHash: string): boolean {
    const computed = crypto.createHash('sha256').update(rawSecret).digest('hex');
    return computed === storedHash;
  }
}

export const mcpOAuthService = new McpOAuthService();
