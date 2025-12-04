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
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'email', KeyType: 'HASH' } // Use email as primary key
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' }
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
      { AttributeName: 'userId', AttributeType: 'S' },
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
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
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

  // Note: userInteractions will be a List attribute that doesn't need to be defined in AttributeDefinitions
  // It will have the following structure:
  // userInteractions: [
  //   {
  //     id: string,
  //     question: string,
  //     response?: string,
  //     status: 'pending' | 'answered',
  //     timestamp: number
  //   }
  // ]

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
      { AttributeName: 'userId', AttributeType: 'S' },
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
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' }
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
      { AttributeName: 'configId', AttributeType: 'S' },
      { AttributeName: 'shareWithEveryone', AttributeType: 'N' },
      { AttributeName: 'appName', AttributeType: 'S' }
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
      },
      {
        IndexName: 'ShareWithEveryoneIndex',
        KeySchema: [
          { AttributeName: 'shareWithEveryone', KeyType: 'HASH' }
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
        IndexName: 'AppNameIndex',
        KeySchema: [
          { AttributeName: 'appName', KeyType: 'HASH' }
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
      { AttributeName: 'status', AttributeType: 'S' },
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Task Templates table
const createTaskTemplatesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-TaskTemplates`,
    AttributeDefinitions: [
      { AttributeName: 'templateId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'templateId', KeyType: 'HASH' }
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Chat Sessions table
const createChatSessionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-ChatSessions`,
    AttributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'sessionId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
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

// Create Task Lead List table
const createTaskLeadListTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-TaskLeadList`,
    AttributeDefinitions: [
      { AttributeName: 'taskId', AttributeType: 'S' },     // Partition key
      { AttributeName: 'identifier', AttributeType: 'S' }   // Sort key
    ],
    KeySchema: [
      { AttributeName: 'taskId', KeyType: 'HASH' },        // Partition key
      { AttributeName: 'identifier', KeyType: 'RANGE' }     // Sort key
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

// Create Asset Approvals table
const createAssetApprovalsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-AssetApprovals`,
    AttributeDefinitions: [
      { AttributeName: 'assetUrl', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'assetType', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'assetUrl', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserApprovalsIndex',
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
        IndexName: 'StatusIndex',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
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
        IndexName: 'AssetTypeIndex',
        KeySchema: [
          { AttributeName: 'assetType', KeyType: 'HASH' },
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create Settings table
const createSettingsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Settings`,
    KeySchema: [
      { AttributeName: 'settingName', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'settingName', AttributeType: 'S' }
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

// Create Email Events table
const createEmailEventsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-EmailEvents`,
    KeySchema: [
      { AttributeName: 'eventId', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'eventId', AttributeType: 'S' },
      { AttributeName: 'emailId', AttributeType: 'S' },
      { AttributeName: 'emailDomain', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'EmailIdIndex',
        KeySchema: [
          { AttributeName: 'emailId', KeyType: 'HASH' }
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
        IndexName: 'EmailDomainIndex',
        KeySchema: [
          { AttributeName: 'emailDomain', KeyType: 'HASH' }
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

// Create Benchmark Tests table
const createBenchmarkTestsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-BenchmarkTests`,
    AttributeDefinitions: [
      { AttributeName: 'testId', AttributeType: 'S' },
      { AttributeName: 'createdBy', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'testId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'CreatedByIndex',
        KeySchema: [
          { AttributeName: 'createdBy', KeyType: 'HASH' },
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
        IndexName: 'StatusIndex',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
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
    console.log(`Created ${params.TableName} table:`, result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log(`${params.TableName} table already exists`);
    } else {
      throw error;
    }
  }
};

// Create GTM Plans table
const createGTMPlansTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-GTMPlan`,
    AttributeDefinitions: [
      { AttributeName: 'planId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'planId', KeyType: 'HASH' }
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

// Create Lead Lists table
const createLeadListsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-LeadLists`,
    AttributeDefinitions: [
      { AttributeName: 'listId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'listId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' }
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

// Create Leads table
const createLeadsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Leads`,
    AttributeDefinitions: [
      { AttributeName: 'listId', AttributeType: 'S' },
      { AttributeName: 'leadId', AttributeType: 'S' },
      { AttributeName: 'uniqueIdentifier', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'listId', KeyType: 'HASH' },
      { AttributeName: 'leadId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'uniqueIdentifier-index',
        KeySchema: [
          { AttributeName: 'listId', KeyType: 'HASH' },
          { AttributeName: 'uniqueIdentifier', KeyType: 'RANGE' }
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
    await createTaskTemplatesTable();
    await createChatSessionsTable();
    await createTaskLeadListTable();
    await createAssetApprovalsTable();
    await createSettingsTable();
    await createEmailEventsTable();
    await createBenchmarkTestsTable();
    await createGTMPlansTable();
    await createLeadListsTable();
    await createLeadsTable();
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