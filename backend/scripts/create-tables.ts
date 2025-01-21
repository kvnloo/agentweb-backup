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

// Function to enable streams on existing table
async function enableStreamsOnTasksTable() {
  try {
    console.log('Enabling streams on AW-Tasks table...');
    await dynamodb.updateTable({
      TableName: 'AW-Tasks',
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES'
      }
    }).promise();
    console.log('Successfully enabled streams on AW-Tasks table');
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error enabling streams:', error.message);
    } else {
      console.error('Unknown error occurred:', error);
    }
    process.exit(1);
  }
}

// Function to update existing table
async function updateTasksTable() {
  try {
    console.log('Updating AW-Tasks table with StatusCreatedAtIndex...');
    await dynamodb.updateTable({
      TableName: 'AW-Tasks',
      AttributeDefinitions: [
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' }
      ],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: 'StatusCreatedAtIndex',
            KeySchema: [
              { AttributeName: 'status', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' }
            ],
            Projection: {
              ProjectionType: 'ALL'
            }
          }
        }
      ]
    }).promise();
    console.log('Successfully added StatusCreatedAtIndex to AW-Tasks table');
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error updating table:', error.message);
    } else {
      console.error('Unknown error occurred:', error);
    }
    process.exit(1);
  }
}

// Create Waitlist table
const createWaitlistTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: 'AW-Waitlist',
    AttributeDefinitions: [
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'joinedAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'email', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'JoinedAtIndex',
        KeySchema: [
          { AttributeName: 'joinedAt', KeyType: 'HASH' },
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
  } catch (error) {
    if (error.code === 'ResourceInUseException') {
      console.log('Waitlist table already exists');
    } else {
      throw error;
    }
  }
};

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
    BillingMode: 'PAY_PER_REQUEST',
    StreamSpecification: {
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES'
    }
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

    // Create Waitlist table
    await createWaitlistTable();
    console.log('Waitlist table created successfully');

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error creating tables:', error.message);
    } else {
      console.error('Unknown error occurred:', error);
    }
    process.exit(1);
  }
}

// Main function to handle script execution
async function main() {
  // Check if this script was run with --update-index flag
  if (process.argv.includes('--update-index')) {
    await updateTasksTable();
    return;
  }

  // Check if this script was run with --enable-streams flag
  if (process.argv.includes('--enable-streams')) {
    await enableStreamsOnTasksTable();
    return;
  }

  // Otherwise, create tables
  await createTables();
}

// Run the main function
main()
  .then(() => {
    console.log('Operation completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Operation failed:', error);
    process.exit(1);
  }); 