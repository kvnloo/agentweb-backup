import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import '../config/aws';  // Just import for side effects

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const dynamodb = new AWS.DynamoDB();

console.log('Creating tables with configuration:', {
  environment: process.env.NODE_ENV || 'production',
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX
});

// Create Users table
const createUsersTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Users`,
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Tasks table
const createTasksTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Tasks`,
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
      },
      {
        IndexName: 'UserTasksIndex',
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

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Task Executions table
const createTaskExecutionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
    AttributeDefinitions: [
      { AttributeName: 'executionId', AttributeType: 'S' },
      { AttributeName: 'taskId', AttributeType: 'S' },
      { AttributeName: 'startTime', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'feedback', AttributeType: 'S' }
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
      },
      {
        IndexName: 'TaskFeedbackIndex',
        KeySchema: [
          { AttributeName: 'taskId', KeyType: 'HASH' },
          { AttributeName: 'feedback', KeyType: 'RANGE' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Waitlist table
const createWaitlistTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Waitlist`,
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Subscribers table
const createSubscribersTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Subscribers`,
    KeySchema: [
      { AttributeName: 'taskId', KeyType: 'HASH' },
      { AttributeName: 'email', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'taskId', AttributeType: 'S' },
      { AttributeName: 'email', AttributeType: 'S' }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Task Schedules table
const createTaskSchedulesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
    AttributeDefinitions: [
      { AttributeName: 'scheduleId', AttributeType: 'S' },
      { AttributeName: 'taskId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'nextRunTime', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'scheduleId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'TaskIdIndex',
        KeySchema: [
          { AttributeName: 'taskId', KeyType: 'HASH' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      },
      {
        IndexName: 'StatusStartTimeIndex',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'nextRunTime', KeyType: 'RANGE' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  };

  try {
    const result = await dynamodb.createTable(params).promise();
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Configs table
const createConfigsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Configs`,
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'configId', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'configId', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'ConfigIdIndex',
        KeySchema: [
          { AttributeName: 'configId', KeyType: 'HASH' }
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Workflows table
const createWorkflowsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Workflows`,
    AttributeDefinitions: [
      { AttributeName: 'workflowId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'workflowId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserWorkflowsIndex',
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
      },
      {
        IndexName: 'StatusUpdatedIndex',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create WorkflowExecutions table
const createWorkflowExecutionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
    AttributeDefinitions: [
      { AttributeName: 'executionId', AttributeType: 'S' },
      { AttributeName: 'workflowId', AttributeType: 'S' },
      { AttributeName: 'startTime', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'executionId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'WorkflowExecutionsIndex',
        KeySchema: [
          { AttributeName: 'workflowId', KeyType: 'HASH' },
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

const main = async () => {
  try {
    console.log(`Creating tables for environment: ${process.env.NODE_ENV || 'production'}`);
    await createUsersTable();
    await createTasksTable();
    await createTaskExecutionsTable();
    await createWaitlistTable();
    await createSubscribersTable();
    await createTaskSchedulesTable();
    await createConfigsTable();
    await createWorkflowsTable();
    await createWorkflowExecutionsTable();
    console.log('All tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    process.exit(1);
  }
};

// Run if this script is called directly
if (require.main === module) {
  main();
} 