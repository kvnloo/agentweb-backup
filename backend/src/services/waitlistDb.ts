import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { handleDynamoError } from '../utils/errorHandler';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

interface WaitlistEntry {
  email: string;
  joinedAt: string;
  status?: string;
  invitedAt?: string;
}

// Helper function to handle DynamoDB errors
const handleDynamoDbError = (error: any, operation: string) => {
  console.error(`DynamoDB ${operation} error:`, error);
  if (error.code === 'CredentialsError') {
    throw new Error('AWS credentials are invalid or missing. Please check your .env file');
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
        status: entry.status || 'pending',
        invitedAt: entry.invitedAt
      },
      ConditionExpression: 'attribute_not_exists(email)'
    };

    try {
      await dynamodb.put(params).promise();
      return params.Item;
    } catch (error) {
      handleDynamoDbError(error, 'addToWaitlist');
    }
  },

  async getByEmail(email: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: {
        email: email.toLowerCase()
      }
    };

    try {
      const result = await dynamodb.get(params).promise();
      return result.Item as WaitlistEntry | undefined;
    } catch (error) {
      handleDynamoDbError(error, 'getWaitlistByEmail');
    }
  },

  async list(lastEvaluatedKey?: any) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Limit: 50,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey })
      };

      const result = await dynamodb.scan(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey
      };
    } catch (error) {
      console.error('Error listing waitlist:', error);
      throw error;
    }
  },

  async updateStatus(email: string, status: string, invitedAt?: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Waitlist`,
      Key: {
        email: email.toLowerCase()
      },
      UpdateExpression: 'SET #status = :status, invitedAt = :invitedAt',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':invitedAt': invitedAt || null
      },
      ReturnValues: 'ALL_NEW'
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as WaitlistEntry;
    } catch (error) {
      return handleDynamoError(error);
    }
  }
}; 