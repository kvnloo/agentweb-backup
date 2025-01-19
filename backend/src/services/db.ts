import { DynamoDB } from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Validate AWS credentials
const validateAwsCredentials = () => {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = process.env;
  
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials are missing. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your .env file');
  }

  if (!AWS_REGION) {
    throw new Error('AWS region is missing. Please set AWS_REGION in your .env file');
  }
};

// For debugging
console.log('Environment variables loaded:', {
  hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
  hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Validate credentials before creating DynamoDB client
validateAwsCredentials();

const dynamodb = new DynamoDB.DocumentClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  }
});

// Helper function to handle DynamoDB errors
const handleDynamoDbError = (error: any, operation: string) => {
  console.error(`DynamoDB ${operation} error:`, error);
  if (error.code === 'CredentialsError') {
    throw new Error('AWS credentials are invalid or missing. Please check your .env file');
  }
  throw error;
};

export const userDb = {
  async createUser(email: string, userId: string, hashedPassword: string) {
    try {
      const params = {
        TableName: 'AW-Users',
        Item: {
          email,
          userId,
          password: hashedPassword,
          createdAt: new Date().toISOString()
        }
      };

      await dynamodb.put(params).promise();
    } catch (error) {
      handleDynamoDbError(error, 'createUser');
    }
  },

  async getUserByEmail(email: string) {
    try {
      const params = {
        TableName: 'AW-Users',
        Key: {
          email
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, 'getUserByEmail');
    }
  }
};

export const taskDb = {
  async createTask(task: {
    taskId: string;
    userId: string;
    name: string;
    prompt: string;
    status: string;
    createdAt: string;
  }) {
    try {
      const params = {
        TableName: 'AW-Tasks',
        Item: task
      };

      await dynamodb.put(params).promise();
      return task;
    } catch (error) {
      handleDynamoDbError(error, 'createTask');
    }
  },

  async getTasksByUserId(userId: string) {
    try {
      const params = {
        TableName: 'AW-Tasks',
        IndexName: 'UserTasksIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId
        }
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getTasksByUserId');
    }
  },

  async getTaskById(taskId: string) {
    try {
      const params = {
        TableName: 'AW-Tasks',
        Key: {
          taskId
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, 'getTaskById');
    }
  },

  async updateTask(taskId: string, updates: Partial<{
    name: string;
    prompt: string;
    status: string;
  }>) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      const params = {
        TableName: 'AW-Tasks',
        Key: {
          taskId
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, 'updateTask');
    }
  },

  async deleteTask(taskId: string) {
    try {
      const params = {
        TableName: 'AW-Tasks',
        Key: {
          taskId
        }
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, 'deleteTask');
    }
  }
}; 