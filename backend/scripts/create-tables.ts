import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Initialize DynamoDB client
const dynamodb = new AWS.DynamoDB({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

async function createUsersTable() {
  try {
    const params = {
      TableName: 'AW-Users',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'email', AttributeType: 'S' }
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'EmailIndex',
          KeySchema: [
            { AttributeName: 'email', KeyType: 'HASH' }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    };

    await dynamodb.createTable(params).promise();
    console.log('Created AW-Users table');
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('AW-Users table already exists');
      
      // Add EmailIndex if it doesn't exist
      try {
        await dynamodb.updateTable({
          TableName: 'AW-Users',
          AttributeDefinitions: [
            { AttributeName: 'email', AttributeType: 'S' }
          ],
          GlobalSecondaryIndexUpdates: [
            {
              Create: {
                IndexName: 'EmailIndex',
                KeySchema: [
                  { AttributeName: 'email', KeyType: 'HASH' }
                ],
                Projection: {
                  ProjectionType: 'ALL'
                }
              }
            }
          ]
        }).promise();
        console.log('Added EmailIndex to AW-Users table');
      } catch (indexError: any) {
        if (indexError.code === 'ResourceInUseException') {
          console.log('EmailIndex already exists');
        } else {
          throw indexError;
        }
      }
    } else {
      throw error;
    }
  }
}

async function createTasksTable() {
  try {
    const params = {
      TableName: 'AW-Tasks',
      AttributeDefinitions: [
        { AttributeName: 'taskId', AttributeType: 'S' },
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' }
      ],
      KeySchema: [
        { AttributeName: 'taskId', KeyType: 'HASH' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'UserIdIndex',
          KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    };

    await dynamodb.createTable(params).promise();
    console.log('Created AW-Tasks table');
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('AW-Tasks table already exists');
    } else {
      throw error;
    }
  }
}

async function createTaskExecutionsTable() {
  try {
    const params = {
      TableName: 'AW-TaskExecutions',
      AttributeDefinitions: [
        { AttributeName: 'executionId', AttributeType: 'S' },
        { AttributeName: 'taskId', AttributeType: 'S' },
        { AttributeName: 'startTime', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' }
      ],
      KeySchema: [
        { AttributeName: 'executionId', KeyType: 'HASH' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'TaskIdIndex',
          KeySchema: [
            { AttributeName: 'taskId', KeyType: 'HASH' },
            { AttributeName: 'startTime', KeyType: 'RANGE' }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        },
        {
          IndexName: 'StatusStartTimeIndex',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'startTime', KeyType: 'RANGE' }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    };

    await dynamodb.createTable(params).promise();
    console.log('Created AW-TaskExecutions table');
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('AW-TaskExecutions table already exists');
    } else {
      throw error;
    }
  }
}

async function main() {
  try {
    await createUsersTable();
    await createTasksTable();
    await createTaskExecutionsTable();
    console.log('All tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    process.exit(1);
  }
}

main(); 