import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { handleDynamoError } from "../utils/errorHandler";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// Ensure the WaitlistEntry interface is exported
export interface WaitlistEntry {
  email: string;
  joinedAt: string;
  status?: string;
  invitedAt?: string;
  fullName?: string;
  phoneNumber?: string;
  companyName?: string;
  requestReport?: boolean;
  useCaseCategories?: string[];
  useCaseDescription?: string;
  supportNote?: string;
  stripe_customer_id?: string;
  productUsagePlan?: string;
}

// Helper function to handle DynamoDB errors
const handleDynamoDbError = (error: any, operation: string) => {
  console.error(`DynamoDB ${operation} error:`, error);
  if (error.code === "CredentialsError") {
    throw new Error(
      "AWS credentials are invalid or missing. Please check your .env file"
    );
  }
  throw error;
};

export const waitlistDb = {
  async add(entry: WaitlistEntry) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Item: {
        email: entry.email.toLowerCase(),
        joinedAt: entry.joinedAt,
        status: entry.status || "pending",
        invitedAt: entry.invitedAt,
        fullName: entry.fullName,
        phoneNumber: entry.phoneNumber,
        companyName: entry.companyName,
        requestReport: entry.requestReport || false,
        useCaseCategories: entry.useCaseCategories || [],
        useCaseDescription: entry.useCaseDescription || "",
        supportNote: entry.supportNote || "",
        stripe_customer_id: entry.stripe_customer_id,
        productUsagePlan: entry.productUsagePlan,
      },
      ConditionExpression: "attribute_not_exists(email)",
    };

    try {
      await dynamodb.put(params).promise();
      return params.Item;
    } catch (error) {
      handleDynamoDbError(error, "addToWaitlist");
    }
  },

  async getByEmail(email: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: {
        email: email.toLowerCase(),
      },
    };

    try {
      const result = await dynamodb.get(params).promise();
      return result.Item as WaitlistEntry | undefined;
    } catch (error) {
      handleDynamoDbError(error, "getWaitlistByEmail");
    }
  },

  async list(lastEvaluatedKey?: any) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Limit: 1000,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      };

      const result = await dynamodb.scan(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey,
      };
    } catch (error) {
      console.error("Error listing waitlist:", error);
      throw error;
    }
  },

  async updateStatus(email: string, status: string, invitedAt?: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: {
        email: email.toLowerCase(),
      },
      UpdateExpression:
        "SET #status = :status" + (invitedAt ? ", invitedAt = :invitedAt" : ""),
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": status,
        ...(invitedAt && { ":invitedAt": invitedAt }),
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as WaitlistEntry;
    } catch (error) {
      return handleDynamoError(error);
    }
  },

  async updateSupportNote(email: string, supportNote: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: {
        email: email.toLowerCase(),
      },
      UpdateExpression: "SET supportNote = :supportNote",
      ExpressionAttributeValues: {
        ":supportNote": supportNote,
      },
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as WaitlistEntry;
    } catch (error) {
      return handleDynamoError(error);
    }
  },

  async updateDetails(email: string, details: Partial<WaitlistEntry>) {
    const { email: _email, joinedAt: _joinedAt, ...writableDetails } = details;

    if (Object.keys(writableDetails).length === 0) {
      return this.getByEmail(email.toLowerCase());
    }

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    Object.entries(writableDetails).forEach(([key, value]) => {
      if (value !== undefined) {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      } else {
        // If you want to explicitly remove fields by passing undefined/null
        // updateExpressions.push(`REMOVE #${key}`);
        // expressionAttributeNames[`#${key}`] = key;
      }
    });

    if (updateExpressions.length === 0) {
      return this.getByEmail(email.toLowerCase());
    }

    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: { email: email.toLowerCase() },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as WaitlistEntry;
    } catch (error) {
      // Check if the error is because the item doesn't exist, then maybe create it?
      // For now, let it throw if update is called on non-existent item, or rely on prior getByEmail check.
      handleDynamoDbError(error, "updateWaitlistDetails");
      throw error;
    }
  },

  async deleteByEmail(
    email: string
  ): Promise<{ success: boolean; message?: string }> {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: {
        email: email.toLowerCase(),
      },
    };

    try {
      await dynamodb.delete(params).promise();
      return { success: true };
    } catch (error) {
      // It's useful to log the error and return a more specific message if needed
      console.error(`Error deleting waitlist entry for ${email}:`, error);
      // Using handleDynamoError or a similar centralized error handler is good practice
      // For now, let's return a generic error message, assuming handleDynamoError might throw or not be suited for delete operations directly
      return {
        success: false,
        message: `Failed to delete waitlist entry for ${email}.`,
      };
      // Depending on handleDynamoError's signature and behavior, you might use it like:
      // const dynamoError = handleDynamoError(error, 'deleteWaitlistEntry');
      // return { success: false, message: dynamoError.message || 'Failed to delete.' };
    }
  },
};
