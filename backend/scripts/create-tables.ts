import { DynamoDB } from 'aws-sdk';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configure AWS
const dynamodb = new DynamoDB({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

async function createTables() {
  // Users table
  const userTableParams: DynamoDB.CreateTableInput = {
    TableName: 'AW-Users',
    AttributeDefinitions: [
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'email', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  };

  // Tasks table
  const taskTableParams: DynamoDB.CreateTableInput = {
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
        IndexName: 'UserTasksIndex',
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

  try {
    // Validate AWS credentials
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS credentials are not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env file');
    }

    // Create Users table
    console.log('Creating AW-Users table...');
    await dynamodb.createTable(userTableParams).promise();
    console.log('AW-Users table created successfully');

    // Create Tasks table
    console.log('Creating AW-Tasks table...');
    await dynamodb.createTable(taskTableParams).promise();
    console.log('AW-Tasks table created successfully');

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error creating tables:', error.message);
    } else {
      console.error('Unknown error occurred:', error);
    }
    process.exit(1);
  }
}

// Run the table creation
createTables()
  .then(() => {
    console.log('All tables created successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Failed to create tables:', error);
    process.exit(1);
  }); 