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
}

export interface OAuthTokenRecord {
  tokenHash: string;
  refreshTokenHash: string;
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number; // epoch seconds (DynamoDB TTL)
  refreshExpiresAt: number;
  revoked: boolean;
  createdAt: string;
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
}

export interface CreateTokenPairParams {
  clientId: string;
  userId: string;
  scope: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AUTH_CODE_TTL_SEC = 600; // 10 minutes
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days

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
    if (!params.clientName || params.clientName.trim() === '') {
      throw new Error('Client name is required');
    }
    if (!params.redirectUris || params.redirectUris.length === 0) {
      throw new Error('At least one redirect URI is required');
    }

    // Validate redirect URIs
    for (const uri of params.redirectUris) {
      const parsed = new URL(uri);
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
    const authMethod = params.tokenEndpointAuthMethod || 'none';
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

    return (result.Item as OAuthClient) || null;
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
    };

    await dynamodb.put({
      TableName: this.codesTable,
      Item: record,
    }).promise();

    return { code };
  }

  async consumeAuthorizationCode(code: string): Promise<OAuthAuthorizationCode | null> {
    const result = await dynamodb.get({
      TableName: this.codesTable,
      Key: { code },
    }).promise();

    const record = result.Item as OAuthAuthorizationCode | undefined;
    if (!record) return null;
    if (record.used) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (record.expiresAt <= nowSec) return null;

    // Mark as used (single-use)
    await dynamodb.update({
      TableName: this.codesTable,
      Key: { code },
      UpdateExpression: 'SET used = :used',
      ExpressionAttributeValues: { ':used': true },
    }).promise();

    return record;
  }

  // ─── Token Pair ────────────────────────────────────────────────────────

  async createTokenPair(params: CreateTokenPairParams): Promise<TokenPairResponse> {
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
      expiresAt: nowSec + ACCESS_TOKEN_TTL_SEC,
      refreshExpiresAt: nowSec + REFRESH_TOKEN_TTL_SEC,
      revoked: false,
      createdAt: new Date().toISOString(),
    };

    await dynamodb.put({
      TableName: this.tokensTable,
      Item: record,
    }).promise();

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      scope: params.scope,
    };
  }

  // ─── Token Validation ─────────────────────────────────────────────────

  async validateAccessToken(rawToken: string): Promise<OAuthTokenRecord | null> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const result = await dynamodb.get({
      TableName: this.tokensTable,
      Key: { tokenHash },
    }).promise();

    const record = result.Item as OAuthTokenRecord | undefined;
    if (!record) return null;
    if (record.revoked) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (record.expiresAt <= nowSec) return null;

    return record;
  }

  // ─── Refresh Flow ─────────────────────────────────────────────────────

  async refreshTokens(rawRefreshToken: string): Promise<TokenPairResponse | null> {
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    // Look up by refresh token hash
    const result = await dynamodb.query({
      TableName: this.tokensTable,
      IndexName: 'RefreshTokenHashIndex',
      KeyConditionExpression: 'refreshTokenHash = :hash',
      ExpressionAttributeValues: { ':hash': refreshTokenHash },
    }).promise();

    if (!result.Items || result.Items.length === 0) return null;

    const record = result.Items[0] as OAuthTokenRecord;
    if (record.revoked) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (record.refreshExpiresAt <= nowSec) return null;

    // Revoke the old token pair
    await dynamodb.update({
      TableName: this.tokensTable,
      Key: { tokenHash: record.tokenHash },
      UpdateExpression: 'SET revoked = :revoked',
      ExpressionAttributeValues: { ':revoked': true },
    }).promise();

    // Issue new pair
    return this.createTokenPair({
      clientId: record.clientId,
      userId: record.userId,
      scope: record.scope,
    });
  }

  // ─── Client Secret Validation ─────────────────────────────────────────

  validateClientSecret(rawSecret: string, storedHash: string): boolean {
    const computed = crypto.createHash('sha256').update(rawSecret).digest('hex');
    return computed === storedHash;
  }
}

export const mcpOAuthService = new McpOAuthService();
