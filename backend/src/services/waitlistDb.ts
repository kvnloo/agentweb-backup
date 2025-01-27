import { dynamodb } from '../config/aws';
import { handleDynamoError } from '../utils/errorHandler';

interface WaitlistEntry {
  email: string;
  joinedAt: string;
  status?: string;
  invitedAt?: string;
}

export const waitlistDb = {
  async add(entry: WaitlistEntry) {
    const params = {
      TableName: 'AW-Waitlist',
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
      return handleDynamoError(error);
    }
  },

  async getByEmail(email: string) {
    const params = {
      TableName: 'AW-Waitlist',
      Key: {
        email: email.toLowerCase()
      }
    };

    try {
      const result = await dynamodb.get(params).promise();
      return result.Item as WaitlistEntry | undefined;
    } catch (error) {
      return handleDynamoError(error);
    }
  },

  async list(lastEvaluatedKey?: any) {
    try {
      const params = {
        TableName: 'AW-Waitlist',
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
      TableName: 'AW-Waitlist',
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