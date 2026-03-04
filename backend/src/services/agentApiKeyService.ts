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

export interface AgentApiKey {
  keyId: string;
  keyHash: string;
  maskedKey: string;
  userId: string;
  keyName: string;
  scopes: string[];
  rateLimitPerMin: number;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  status: "active" | "revoked";
}

export class AgentApiKeyService {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-AgentApiKeys`;
  }

  async generateKey(
    userId: string,
    keyName: string,
    scopes: string[] = ["tools:read", "tools:execute"],
    rateLimitPerMin: number = 60,
    expiresAt?: string
  ): Promise<{ rawKey: string; keyRecord: AgentApiKey }> {
    const keyId = uuidv4();
    const rawKey = `aw_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const maskedKey = `aw_...${rawKey.slice(-6)}`;

    const keyRecord: AgentApiKey = {
      keyId,
      keyHash,
      maskedKey,
      userId,
      keyName,
      scopes,
      rateLimitPerMin,
      createdAt: new Date().toISOString(),
      status: "active",
      ...(expiresAt && { expiresAt }),
    };

    await dynamodb
      .put({
        TableName: this.tableName,
        Item: keyRecord,
      })
      .promise();

    return { rawKey, keyRecord };
  }

  async validateKey(rawKey: string): Promise<AgentApiKey | null> {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    try {
      const result = await dynamodb
        .query({
          TableName: this.tableName,
          IndexName: "KeyHashIndex",
          KeyConditionExpression: "keyHash = :keyHash",
          ExpressionAttributeValues: { ":keyHash": keyHash },
        })
        .promise();

      if (!result.Items || result.Items.length === 0) {
        return null;
      }

      const key = result.Items[0] as AgentApiKey;

      if (key.status !== "active") {
        return null;
      }

      if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
        return null;
      }

      // Fire-and-forget lastUsedAt update
      this.updateLastUsed(key.keyId);

      return key;
    } catch (error) {
      console.error("Error validating API key:", error);
      throw error;
    }
  }

  async getKeysByUserId(userId: string): Promise<AgentApiKey[]> {
    try {
      const result = await dynamodb
        .query({
          TableName: this.tableName,
          IndexName: "UserIdIndex",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": userId },
        })
        .promise();

      return (result.Items as AgentApiKey[]) || [];
    } catch (error) {
      console.error("Error getting keys by userId:", error);
      throw error;
    }
  }

  async revokeKey(keyId: string, userId: string): Promise<void> {
    const result = await dynamodb
      .get({
        TableName: this.tableName,
        Key: { keyId },
      })
      .promise();

    if (!result.Item) {
      throw new Error("API key not found");
    }

    if (result.Item.userId !== userId) {
      throw new Error("Unauthorized");
    }

    await dynamodb
      .update({
        TableName: this.tableName,
        Key: { keyId },
        UpdateExpression: "SET #status = :status, revokedAt = :revokedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "revoked",
          ":revokedAt": new Date().toISOString(),
        },
      })
      .promise();
  }

  async updateLastUsed(keyId: string): Promise<void> {
    try {
      await dynamodb
        .update({
          TableName: this.tableName,
          Key: { keyId },
          UpdateExpression: "SET lastUsedAt = :lastUsedAt",
          ExpressionAttributeValues: {
            ":lastUsedAt": new Date().toISOString(),
          },
        })
        .promise();
    } catch (error) {
      // Fire-and-forget: log but don't throw
      console.error("Error updating lastUsedAt:", error);
    }
  }
}

export const agentApiKeyService = new AgentApiKeyService();
