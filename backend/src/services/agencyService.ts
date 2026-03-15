import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

/**
 * Represents a link between an agency team and a client team.
 * Stored in AW-AgencyClients DynamoDB table.
 * PK: agencyTeamId, SK: clientTeamId
 * GSI: clientTeamId-index (for reverse lookup)
 */
export interface AgencyClient {
  agencyTeamId: string;
  clientTeamId: string;
  status: "active" | "revoked";
  linkedAt: string;
  linkedBy: string;
  revokedAt?: string;
}

export class AgencyService {
  private tableName: string;
  private gsiName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-AgencyClients`;
    this.gsiName = "clientTeamId-index";
  }

  /**
   * Link a client team to an agency team.
   * Uses a condition expression to prevent duplicate active links.
   */
  async linkClient(
    agencyTeamId: string,
    clientTeamId: string,
    linkedBy: string
  ): Promise<AgencyClient> {
    if (!agencyTeamId) {
      throw new Error("agencyTeamId is required");
    }
    if (!clientTeamId) {
      throw new Error("clientTeamId is required");
    }
    if (agencyTeamId === clientTeamId) {
      throw new Error("Cannot link a team to itself");
    }

    const now = new Date().toISOString();
    const item: AgencyClient = {
      agencyTeamId,
      clientTeamId,
      status: "active",
      linkedAt: now,
      linkedBy,
    };

    const params: AWS.DynamoDB.DocumentClient.PutItemInput = {
      TableName: this.tableName,
      Item: item,
      ConditionExpression:
        "attribute_not_exists(agencyTeamId) OR #status <> :active",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":active": "active",
      },
    };

    try {
      await dynamodb.put(params).promise();
      return item;
    } catch (error: any) {
      if (error.code === "ConditionalCheckFailedException") {
        throw new Error(
          `Agency ${agencyTeamId} is already linked to client ${clientTeamId}`
        );
      }
      console.error("Error linking client:", error);
      throw error;
    }
  }

  /**
   * Unlink (delete) an agency-client relationship.
   * Throws if the link does not exist.
   */
  async unlinkClient(
    agencyTeamId: string,
    clientTeamId: string
  ): Promise<void> {
    if (!agencyTeamId) {
      throw new Error("agencyTeamId is required");
    }
    if (!clientTeamId) {
      throw new Error("clientTeamId is required");
    }

    // Verify link exists
    const existing = await this.getLink(agencyTeamId, clientTeamId);
    if (!existing) {
      throw new Error(
        `Link not found between agency ${agencyTeamId} and client ${clientTeamId}`
      );
    }

    const params: AWS.DynamoDB.DocumentClient.DeleteItemInput = {
      TableName: this.tableName,
      Key: {
        agencyTeamId,
        clientTeamId,
      },
    };

    await dynamodb.delete(params).promise();
  }

  /**
   * Get all clients linked to an agency team.
   * Queries the table by agencyTeamId (partition key).
   */
  async getAgencyClients(agencyTeamId: string): Promise<AgencyClient[]> {
    if (!agencyTeamId) {
      throw new Error("agencyTeamId is required");
    }

    const params: AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: this.tableName,
      KeyConditionExpression: "agencyTeamId = :agencyTeamId",
      ExpressionAttributeValues: {
        ":agencyTeamId": agencyTeamId,
      },
    };

    const result = await dynamodb.query(params).promise();
    return (result.Items as AgencyClient[]) || [];
  }

  /**
   * Get all agencies that manage a given client team.
   * Uses the GSI (clientTeamId-index) for reverse lookup.
   */
  async getClientAgencies(clientTeamId: string): Promise<AgencyClient[]> {
    if (!clientTeamId) {
      throw new Error("clientTeamId is required");
    }

    const params: AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: this.tableName,
      IndexName: this.gsiName,
      KeyConditionExpression: "clientTeamId = :clientTeamId",
      ExpressionAttributeValues: {
        ":clientTeamId": clientTeamId,
      },
    };

    const result = await dynamodb.query(params).promise();
    return (result.Items as AgencyClient[]) || [];
  }

  /**
   * Check if an agency has an active link to a specific client.
   */
  async isAgencyForClient(
    agencyTeamId: string,
    clientTeamId: string
  ): Promise<boolean> {
    const link = await this.getLink(agencyTeamId, clientTeamId);
    return link?.status === "active";
  }

  /**
   * Revoke agency access from the client side.
   * Sets the link status to 'revoked' rather than deleting.
   */
  async revokeAgencyAccess(
    agencyTeamId: string,
    clientTeamId: string
  ): Promise<AgencyClient> {
    // Verify link exists
    const existing = await this.getLink(agencyTeamId, clientTeamId);
    if (!existing) {
      throw new Error(
        `Link not found between agency ${agencyTeamId} and client ${clientTeamId}`
      );
    }

    const now = new Date().toISOString();

    const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
      TableName: this.tableName,
      Key: {
        agencyTeamId,
        clientTeamId,
      },
      UpdateExpression: "SET #status = :revoked, revokedAt = :revokedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":revokedAt": now,
      },
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes as AgencyClient;
  }

  /**
   * Internal: get a single agency-client link by composite key.
   */
  private async getLink(
    agencyTeamId: string,
    clientTeamId: string
  ): Promise<AgencyClient | null> {
    const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
      TableName: this.tableName,
      Key: {
        agencyTeamId,
        clientTeamId,
      },
    };

    const result = await dynamodb.get(params).promise();
    return (result.Item as AgencyClient) || null;
  }
}

// Singleton export
export const agencyService = new AgencyService();
