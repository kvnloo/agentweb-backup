import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// For debugging
console.log('Environment variables loaded:', {
  hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
  hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// Helper function to handle DynamoDB errors
const handleDynamoDbError = (error: any, operation: string) => {
  console.error(`DynamoDB ${operation} error:`, error);
  if (error.code === 'CredentialsError') {
    throw new Error('AWS credentials are invalid or missing. Please check your .env file');
  }
  throw error;
};

interface User {
  userId: string;
  email: string;
  password: string;
  isOAuthUser: boolean;
  isAdmin: boolean;
  createdAt: string;
}

class UserDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName = 'AW-Users';

  constructor() {
    console.log('Initializing DynamoDB with region:', process.env.AWS_REGION || 'us-west-2');
    this.docClient = dynamodb;
  }

  private handleError(error: any, operation: string) {
    console.error(`DynamoDB ${operation} error:`, error);
    if (error.code === 'ValidationException') {
      throw new Error(`Validation error during ${operation}: ${error.message}`);
    } else if (error.code === 'ResourceNotFoundException') {
      throw new Error(`Table not found during ${operation}: ${error.message}`);
    } else if (error.code === 'AccessDeniedException') {
      throw new Error(`Access denied during ${operation}: ${error.message}`);
    } else {
      throw new Error(`Error during ${operation}: ${error.message}`);
    }
  }

  async createUser(email: string, userId: string, password: string, isOAuthUser: boolean = false, isAdmin: boolean = false) {
    const params = {
      TableName: this.tableName,
      Item: {
        userId,
        email,
        password,
        isOAuthUser,
        isAdmin,
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

  async getUserById(userId: string) {
    try {
      console.log('Getting user by ID:', userId);
      const params = {
        TableName: this.tableName,
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId
        }
      };

      const result = await this.docClient.query(params).promise();
      console.log('User lookup result:', result);
      return result.Items?.[0];
    } catch (error) {
      console.error('Error in getUserById:', error);
      throw error;
    }
  }

  async getAllUsers() {
    try {
      const params = {
        TableName: this.tableName,
        Limit: 50
      };

      const result = await this.docClient.scan(params).promise();
      return result.Items || [];
    } catch (error) {
      console.error('Error in getAllUsers:', error);
      throw error;
    }
  }

  async getUserAnalytics(startDate: string, endDate: string) {
    try {
      const params = {
        TableName: this.tableName,
        FilterExpression: 'createdAt BETWEEN :startDate AND :endDate',
        ExpressionAttributeValues: {
          ':startDate': startDate,
          ':endDate': endDate
        }
      };

      const result = await this.docClient.scan(params).promise();
      const users = result.Items || [];

      return {
        totalUsers: users.length,
        newUsers: users.filter(u => u.createdAt >= startDate && u.createdAt <= endDate).length,
        oauthUsers: users.filter(u => u.isOAuthUser).length,
        adminUsers: users.filter(u => u.isAdmin).length
      };
    } catch (error) {
      console.error('Error in getUserAnalytics:', error);
      throw error;
    }
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

  async getAllTasks() {
    try {
      const params = {
        TableName: 'AW-Tasks',
        ProjectionExpression: 'taskId, userId, #n, prompt, #s, createdAt',
        ExpressionAttributeNames: {
          '#n': 'name',
          '#s': 'status'
        }
      };

      const result = await dynamodb.scan(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getAllTasks');
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
    feedback: 'accepted' | 'rejected' | null;
  }>) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (value === null) {
          updateExpressions.push(`REMOVE #${key}`);
          expressionAttributeNames[`#${key}`] = key;
        } else {
          updateExpressions.push(`SET #${key} = :${key}`);
          expressionAttributeNames[`#${key}`] = key;
          expressionAttributeValues[`:${key}`] = value;
        }
      });

      const params = {
        TableName: 'AW-TaskExecutions',
        Key: {
          executionId
        },
        UpdateExpression: updateExpressions.join(', '),
        ExpressionAttributeNames: expressionAttributeNames,
        ...(Object.keys(expressionAttributeValues).length > 0 && {
          ExpressionAttributeValues: expressionAttributeValues
        }),
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
  },

  async getTaskAnalytics(startDate: string, endDate: string) {
    try {
      // Get tasks for the period
      const taskParams = {
        TableName: 'AW-Tasks',
        FilterExpression: 'createdAt BETWEEN :startDate AND :endDate',
        ExpressionAttributeValues: {
          ':startDate': startDate,
          ':endDate': endDate
        }
      };

      const taskResult = await dynamodb.scan(taskParams).promise();
      const tasks = taskResult.Items || [];

      // Get executions for the period
      const executionParams = {
        TableName: 'AW-TaskExecutions',
        FilterExpression: 'startTime BETWEEN :startDate AND :endDate',
        ExpressionAttributeValues: {
          ':startDate': startDate,
          ':endDate': endDate
        }
      };

      const executionResult = await dynamodb.scan(executionParams).promise();
      const executions = executionResult.Items || [];

      return {
        totalTasks: tasks.length,
        newTasks: tasks.filter(t => t.createdAt >= startDate && t.createdAt <= endDate).length,
        totalExecutions: executions.length,
        successfulExecutions: executions.filter(e => e.status === 'completed').length,
        failedExecutions: executions.filter(e => e.status === 'failed').length,
        averageExecutionTime: executions.reduce((acc, e) => {
          if (e.endTime && e.startTime) {
            return acc + (new Date(e.endTime).getTime() - new Date(e.startTime).getTime());
          }
          return acc;
        }, 0) / (executions.length || 1)  // Avoid division by zero
      };
    } catch (error) {
      console.error('Error in getTaskAnalytics:', error);
      throw error;
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

export const subscriberDb = {
  async addSubscriber(taskId: string, email: string) {
    try {
      const subscribedAt = new Date().toISOString();
      const params = {
        TableName: 'AW-Subscribers',
        Item: {
          taskId,
          email,
          subscribedAt
        },
        ConditionExpression: 'attribute_not_exists(taskId) AND attribute_not_exists(email)'
      };

      await dynamodb.put(params).promise();
      return { taskId, email, subscribedAt };
    } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') {
        throw new Error(`Email ${email} is already subscribed to this task`);
      }
      handleDynamoDbError(error, 'addSubscriber');
    }
  },

  async removeSubscriber(taskId: string, email: string) {
    try {
      const params = {
        TableName: 'AW-Subscribers',
        Key: {
          taskId,
          email
        }
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, 'removeSubscriber');
    }
  },

  async getTaskSubscribers(taskId: string) {
    try {
      const params = {
        TableName: 'AW-Subscribers',
        KeyConditionExpression: 'taskId = :taskId',
        ExpressionAttributeValues: {
          ':taskId': taskId
        }
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, 'getTaskSubscribers');
    }
  }
}; 