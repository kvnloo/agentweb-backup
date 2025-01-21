import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import '../config/aws';  // Just import for side effects

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const dynamodb = new AWS.DynamoDB();

// Create Users table
const createUsersTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: 'AW-Users',
    AttributeDefinitions: [
      { AttributeName: 'email', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'email', KeyType: 'HASH' }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log('Created Users table:', result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('Users table already exists');
    } else {
      throw error;
    }
  }
};

// Create Tasks table
const createTasksTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
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
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5
        }
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log('Created Tasks table:', result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('Tasks table already exists');
    } else {
      throw error;
    }
  }
};

// Create Task Executions table
const createTaskExecutionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
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
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5
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
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5
        }
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log('Created Task Executions table:', result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('Task Executions table already exists');
    } else {
      throw error;
    }
  }
};

// Create Waitlist table
const createWaitlistTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: 'AW-Waitlist',
    AttributeDefinitions: [
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'joinedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'email', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'JoinedAtIndex',
        KeySchema: [
          { AttributeName: 'joinedAt', KeyType: 'HASH' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5
        }
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log('Created Waitlist table:', result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('Waitlist table already exists');
    } else {
      throw error;
    }
  }
};

const main = async () => {
  try {
    await createUsersTable();
    await createTasksTable();
    await createTaskExecutionsTable();
    await createWaitlistTable();
    console.log('All tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    process.exit(1);
  }
};

main(); 