import { DynamoDB } from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import AWS from 'aws-sdk';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';

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

class UserDB {
  private docClient: DocumentClient;
  private tableName = 'AW-Users';

  constructor() {
    this.docClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      }
    });
  }

  async createUser(email: string, userId: string, password: string, isOAuthUser: boolean = false) {
    const params = {
      TableName: this.tableName,
      Item: {
        userId,
        email,
        password,
        isOAuthUser,
        createdAt: new Date().toISOString()
      }
    };

    await this.docClient.put(params).promise();
  }

  async getUserByEmail(email: string) {
    const params = {
      TableName: this.tableName,
      IndexName: 'EmailIndex',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: {
        ':email': email
      }
    };

    const result = await this.docClient.query(params).promise();
    return result.Items?.[0];
  }
}

export const userDb = new UserDB();

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
        },
        ProjectionExpression: 'taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum',
        ExpressionAttributeNames: {
          '#n': 'name',
          '#s': 'status',
          '#e': 'error',
          '#sum': 'summary'
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
        },
        ProjectionExpression: 'taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en',
        ExpressionAttributeNames: {
          '#n': 'name',
          '#s': 'status',
          '#e': 'error',
          '#sum': 'summary',
          '#en': 'emailNotification'
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
    error: string;
    summary: string;
    emailNotification: boolean;
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
  },

  async createTaskExecution(execution: {
    executionId: string;
    taskId: string;
    userId: string;
    status: string;
    startTime: string;
  }) {
    try {
      const params = {
        TableName: 'AW-TaskExecutions',
        Item: execution
      };

      await dynamodb.put(params).promise();
      return execution;
    } catch (error) {
      handleDynamoDbError(error, 'createTaskExecution');
    }
  },

  async getTaskExecutionById(executionId: string) {
    try {
      const params = {
        TableName: 'AW-TaskExecutions',
        Key: {
          executionId
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, 'getTaskExecutionById');
    }
  },

  async updateTaskExecution(executionId: string, updates: Partial<{
    status: string;
    error: string;
    result: string;
    completedAt: string;
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
        TableName: 'AW-TaskExecutions',
        Key: {
          executionId
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, 'updateTaskExecution');
    }
  },

  async getPendingTaskExecutions() {
    try {
      const params = {
        TableName: 'AW-TaskExecutions',
        IndexName: 'StatusCreatedAtIndex',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': 'pending'
        }
      };

      const result = await dynamodb.query(params).promise();
      return result.Items;
    } catch (error) {
      handleDynamoDbError(error, 'getPendingTaskExecutions');
    }
  },

  async getTaskExecutions(taskId: string) {
    try {
      const params = {
        TableName: 'AW-TaskExecutions',
        IndexName: 'TaskIdIndex',
        KeyConditionExpression: 'taskId = :taskId',
        ExpressionAttributeValues: {
          ':taskId': taskId
        },
        ScanIndexForward: false  // Get latest executions first
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getTaskExecutions');
    }
  }
};

export const waitlistDb = {
  async add(entry: { email: string; joinedAt: string }) {
    try {
      const params = {
        TableName: 'AW-Waitlist',
        Item: entry
      };

      await dynamodb.put(params).promise();
      return entry;
    } catch (error) {
      handleDynamoDbError(error, 'addToWaitlist');
    }
  },

  async getByEmail(email: string) {
    try {
      const params = {
        TableName: 'AW-Waitlist',
        Key: {
          email
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, 'getWaitlistByEmail');
    }
  }
};

export const scheduleDb = {
  async createSchedule(schedule: {
    scheduleId: string;
    taskId: string;
    userId: string;
    frequency: string;  // 'daily', 'weekly', 'monthly', or cron expression
    nextRunTime: string;
    status: string;  // 'active' or 'inactive'
    createdAt: string;
    lastRunTime?: string;
    timezone?: string;
  }) {
    try {
      const params = {
        TableName: 'AW-TaskSchedules',
        Item: schedule
      };

      await dynamodb.put(params).promise();
      return schedule;
    } catch (error) {
      handleDynamoDbError(error, 'createSchedule');
    }
  },

  async getSchedulesByTaskId(taskId: string) {
    try {
      const params = {
        TableName: 'AW-TaskSchedules',
        IndexName: 'TaskIdIndex',
        KeyConditionExpression: 'taskId = :taskId',
        ExpressionAttributeValues: {
          ':taskId': taskId
        }
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getSchedulesByTaskId');
    }
  },

  async getScheduleById(scheduleId: string) {
    try {
      const params = {
        TableName: 'AW-TaskSchedules',
        Key: {
          scheduleId
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, 'getScheduleById');
    }
  },

  async updateSchedule(scheduleId: string, updates: Partial<{
    frequency: string;
    nextRunTime: string;
    status: string;
    lastRunTime: string;
    timezone: string;
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
        TableName: 'AW-TaskSchedules',
        Key: {
          scheduleId
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, 'updateSchedule');
    }
  },

  async deleteSchedule(scheduleId: string) {
    try {
      const params = {
        TableName: 'AW-TaskSchedules',
        Key: {
          scheduleId
        }
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, 'deleteSchedule');
    }
  },

  async getPendingSchedules() {
    try {
      const now = new Date().toISOString();
      const params = {
        TableName: 'AW-TaskSchedules',
        IndexName: 'StatusNextRunTimeIndex',
        KeyConditionExpression: '#status = :status AND #nextRunTime <= :now',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#nextRunTime': 'nextRunTime'
        },
        ExpressionAttributeValues: {
          ':status': 'active',
          ':now': now
        }
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getPendingSchedules');
    }
  }
}; 