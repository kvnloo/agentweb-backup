import { DynamoDB } from 'aws-sdk';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

const dynamodb = new DynamoDB.DocumentClient({
  region: 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

const SCHEDULES_TABLE = `${TABLE_PREFIX}AW-TaskSchedules`;

export interface Schedule {
  scheduleId: string;
  taskId: string;
  userId: string;
  frequency: string;
  status: string;
  nextRunTime: string;
  createdAt: string;
  updatedAt: string;
}

export const scheduleDb = {
  async createSchedule(schedule: Schedule): Promise<void> {
    try {
      await dynamodb.put({
        TableName: SCHEDULES_TABLE,
        Item: schedule
      }).promise();
    } catch (error) {
      console.error('Error creating schedule in DynamoDB:', error);
      console.error('Schedule data:', JSON.stringify(schedule, null, 2));
      throw error;
    }
  },

  async getScheduleById(scheduleId: string): Promise<Schedule | null> {
    try {
      const result = await dynamodb.get({
        TableName: SCHEDULES_TABLE,
        Key: { scheduleId }
      }).promise();

      return result.Item as Schedule || null;
    } catch (error) {
      console.error('Error getting schedule by ID from DynamoDB:', error);
      console.error('Schedule ID:', scheduleId);
      throw error;
    }
  },

  async getSchedulesByTaskId(taskId: string): Promise<Schedule[]> {
    try {
      const result = await dynamodb.query({
        TableName: SCHEDULES_TABLE,
        IndexName: 'TaskIdIndex',
        KeyConditionExpression: 'taskId = :taskId',
        ExpressionAttributeValues: {
          ':taskId': taskId
        }
      }).promise();

      return result.Items as Schedule[] || [];
    } catch (error) {
      console.error('Error getting schedules by task ID from DynamoDB:', error);
      console.error('Task ID:', taskId);
      throw error;
    }
  },

  async updateSchedule(scheduleId: string, updates: Partial<Schedule>): Promise<void> {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      await dynamodb.update({
        TableName: SCHEDULES_TABLE,
        Key: { scheduleId },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
      }).promise();
    } catch (error) {
      console.error('Error updating schedule in DynamoDB:', error);
      console.error('Schedule ID:', scheduleId);
      console.error('Updates:', JSON.stringify(updates, null, 2));
      throw error;
    }
  },

  async deleteSchedule(scheduleId: string): Promise<void> {
    try {
      await dynamodb.delete({
        TableName: SCHEDULES_TABLE,
        Key: { scheduleId }
      }).promise();
    } catch (error) {
      console.error('Error deleting schedule from DynamoDB:', error);
      console.error('Schedule ID:', scheduleId);
      throw error;
    }
  },

  async getPendingSchedules(): Promise<Schedule[]> {
    try {
      const now = new Date().toISOString();
      const result = await dynamodb.query({
        TableName: SCHEDULES_TABLE,
        IndexName: 'StatusStartTimeIndex',
        KeyConditionExpression: '#status = :status AND #nextRunTime <= :now',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#nextRunTime': 'nextRunTime'
        },
        ExpressionAttributeValues: {
          ':status': 'active',
          ':now': now
        }
      }).promise();

      return result.Items as Schedule[] || [];
    } catch (error) {
      console.error('Error getting pending schedules from DynamoDB:', error);
      throw error;
    }
  }
}; 