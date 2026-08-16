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
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' }
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
      },
      {
        IndexName: 'OrgIdIndex',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' }
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
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'knowledgeBaseType', AttributeType: 'S' },
      { AttributeName: 'knowledgeBaseUpdatedAt', AttributeType: 'S' }
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
      },
      {
        IndexName: 'KnowledgeBaseTypeIndex',
        KeySchema: [
          { AttributeName: 'knowledgeBaseType', KeyType: 'HASH' },
          { AttributeName: 'knowledgeBaseUpdatedAt', KeyType: 'RANGE' }
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

// Create Async Job Queue table — generic crash-safety net for any webhook receiver's
// fire-and-forget processing (ENG-524). One table for every integration, discriminated
// by `source`, rather than a table per integration: a new source just registers a
// processor function, no schema change. See backend/src/services/asyncJobQueue.ts.
const createAsyncJobQueueTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-AsyncJobQueue`,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'id', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'StatusCreatedAtIndex',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
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

// Create Calendly Orphaned Webhooks table — last-resort durable record of a
// Calendly webhook_id that couldn't be either deleted remotely OR durably
// enqueued for cleanup retry (both AW-AsyncJobQueue writes exhausted). Greptile
// P1 on #2291 (round 15/16): the async job queue is itself the thing failing to
// accept writes in exactly this scenario, so a fallback that ALSO writes to that
// same table has no value — this is a genuinely separate table so the fallback
// actually has a chance of succeeding when the queue table specifically (not
// DynamoDB broadly) is the problem. Keyed by `<userId>_<calendlyUserUri>` so a
// later /connect for that exact identity can look itself up directly (no listing,
// preserving the same tenant-safety guarantee as the local-account-record check —
// see calendlyAuth.ts's provisionCalendlyWebhook). See
// services/calendlyWebhookCleanupQueue.ts.
const createCalendlyOrphanedWebhooksTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-CalendlyOrphanedWebhooks`,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'id', KeyType: 'HASH' }
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
      { AttributeName: 'updatedAt', AttributeType: 'S' },
      { AttributeName: 'adminListPartition', AttributeType: 'S' }
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
      },
      {
        IndexName: 'AdminUpdatedAtIndex',
        KeySchema: [
          { AttributeName: 'adminListPartition', KeyType: 'HASH' },
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

// Create Chat Messages table
const createChatMessagesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-ChatMessages`,
    AttributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'messageIndex', AttributeType: 'N' }
    ],
    KeySchema: [
      { AttributeName: 'sessionId', KeyType: 'HASH' },
      { AttributeName: 'messageIndex', KeyType: 'RANGE' }
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

// Create BatchReviews table
const createBatchReviewsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-BatchReviews`,
    AttributeDefinitions: [
      { AttributeName: 'batchId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'batchId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserBatchIndex',
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

// Create Prompt Templates table
// Single-key config table (PK: templateId). Holds admin-editable prompt
// templates: the ad-image archetypes / global image directives
// (promptTemplatesService) and the onboarding outreach-invite prompt
// (outreachInvitePromptService). Both services only ever get/put by
// templateId, so no GSIs are needed. This table was introduced by ENG-242 but
// never added to provisioning, so it was missing in production — reads there
// silently fell back to seed defaults while saves returned HTTP 500
// (ResourceNotFoundException). See ENG-603.
const createPromptTemplatesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-PromptTemplates`,
    KeySchema: [
      { AttributeName: 'templateId', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'templateId', AttributeType: 'S' }
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
      { AttributeName: 'emailDomain', AttributeType: 'S' },
      { AttributeName: 'leadEmail', AttributeType: 'S' }
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
      },
      {
        IndexName: 'EmailDomainLeadEmailIndex',
        KeySchema: [
          { AttributeName: 'emailDomain', KeyType: 'HASH' },
          { AttributeName: 'leadEmail', KeyType: 'RANGE' }
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

// Create Books table
const createBooksTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Books`,
    AttributeDefinitions: [
      { AttributeName: 'bookId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'bookId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' }
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
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'isICP', AttributeType: 'N' },
      { AttributeName: 'isEngaged', AttributeType: 'N' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'linkedin', AttributeType: 'S' },
      { AttributeName: 'nameCompanyKey', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' },
      { AttributeName: 'companyId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'listId', KeyType: 'HASH' },
      { AttributeName: 'leadId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'email-index',
        KeySchema: [
          { AttributeName: 'listId', KeyType: 'HASH' },
          { AttributeName: 'email', KeyType: 'RANGE' }
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
        IndexName: 'listId-isICP-index',
        KeySchema: [
          { AttributeName: 'listId', KeyType: 'HASH' },
          { AttributeName: 'isICP', KeyType: 'RANGE' }
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
        IndexName: 'listId-isEngaged-index',
        KeySchema: [
          { AttributeName: 'listId', KeyType: 'HASH' },
          { AttributeName: 'isEngaged', KeyType: 'RANGE' }
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
        IndexName: 'listId-status-index',
        KeySchema: [
          { AttributeName: 'listId', KeyType: 'HASH' },
          { AttributeName: 'status', KeyType: 'RANGE' }
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
        IndexName: 'EmailLookupIndex',
        KeySchema: [
          { AttributeName: 'email', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
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
        IndexName: 'LinkedinLookupIndex',
        KeySchema: [
          { AttributeName: 'linkedin', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
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
        IndexName: 'NameCompanyLookupIndex',
        KeySchema: [
          { AttributeName: 'nameCompanyKey', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
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
        IndexName: 'companyId-index',
        KeySchema: [
          { AttributeName: 'companyId', KeyType: 'HASH' },
          { AttributeName: 'leadId', KeyType: 'RANGE' }
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

// Create Book Contents table
const createBookContentsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-BookContents`,
    AttributeDefinitions: [
      { AttributeName: 'contentId', AttributeType: 'S' },
      { AttributeName: 'bookId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'contentId', KeyType: 'HASH' },
      { AttributeName: 'bookId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'BookIdIndex',
        KeySchema: [
          { AttributeName: 'bookId', KeyType: 'HASH' }
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

// Create Connected Account Posts table
const createConnectedAccountPostsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-ConnectedAccountPosts`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'postId', AttributeType: 'S' },
      { AttributeName: 'accountId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'postId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'AccountPostsIndex',
        KeySchema: [
          { AttributeName: 'accountId', KeyType: 'HASH' },
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

// Create Skills table
const createSkillsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Skills`,
    AttributeDefinitions: [
      { AttributeName: 'skillId', AttributeType: 'S' },
      { AttributeName: 'ownerId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'visibility', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'skillId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'OwnerIndex',
        KeySchema: [
          { AttributeName: 'ownerId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'VisibilityIndex',
        KeySchema: [
          { AttributeName: 'visibility', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
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

// Create Skill Assignments table
const createSkillAssignmentsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-SkillAssignments`,
    AttributeDefinitions: [
      { AttributeName: 'assignmentId', AttributeType: 'S' },
      { AttributeName: 'skillId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'nextRunTime', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'assignmentId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'SkillIndex',
        KeySchema: [
          { AttributeName: 'skillId', KeyType: 'HASH' },
          { AttributeName: 'status', KeyType: 'RANGE' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      },
      {
        IndexName: 'UserIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'status', KeyType: 'RANGE' }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      },
      {
        IndexName: 'RunnerIndex',
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

// Create Work Plans table
const createWorkPlansTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-WorkPlans`,
    AttributeDefinitions: [
      { AttributeName: 'planId', AttributeType: 'S' },
      { AttributeName: 'ownerId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'visibility', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'planId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'OwnerIndex',
        KeySchema: [
          { AttributeName: 'ownerId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'VisibilityIndex',
        KeySchema: [
          { AttributeName: 'visibility', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
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

// Create Agent API Keys table
const createAgentApiKeysTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-AgentApiKeys`,
    AttributeDefinitions: [
      { AttributeName: 'keyId', AttributeType: 'S' },
      { AttributeName: 'keyHash', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'keyId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'KeyHashIndex',
        KeySchema: [
          { AttributeName: 'keyHash', KeyType: 'HASH' }
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

// Create MCP OAuth Clients table (dynamic client registration)
const createMcpOAuthClientsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-MCPOAuthClients`,
    AttributeDefinitions: [
      { AttributeName: 'clientId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'clientId', KeyType: 'HASH' }
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

// Create MCP OAuth Authorization Codes table (10-min TTL via DynamoDB TTL on expiresAt)
const createMcpOAuthCodesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-MCPOAuthCodes`,
    AttributeDefinitions: [
      { AttributeName: 'code', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'code', KeyType: 'HASH' }
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

// Create MCP OAuth Tokens table (access + refresh tokens, TTL on expiresAt)
const createMcpOAuthTokensTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-MCPOAuthTokens`,
    AttributeDefinitions: [
      { AttributeName: 'tokenHash', AttributeType: 'S' },
      { AttributeName: 'refreshTokenHash', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'tokenHash', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'RefreshTokenHashIndex',
        KeySchema: [
          { AttributeName: 'refreshTokenHash', KeyType: 'HASH' }
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

// Create MCP Streamable-HTTP session store (ENG-114). Shared session metadata so
// a session initialized on one backend instance can be rehydrated on another,
// eliminating the cross-instance reinitialize churn. Only the minimal context
// (sessionId, agentUserId, isInternal) is stored — never the live transport.
// TTL: rows carry a `ttl` attribute (epoch seconds). Enable DynamoDB native TTL
// on the `ttl` attribute manually — same manual TTL-enable step as the MCP OAuth
// tables — so stale rows self-prune; the app also treats ttl-passed rows as gone
// on read for consistent cross-instance eviction.
const createMcpSessionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-MCPSessions`,
    AttributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'sessionId', KeyType: 'HASH' }
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

// Create Usage Records table (shadow LLM usage metering — one row per
// userId, day, model, feature; see services/usageRecordDb.ts).
// TTL: enable DynamoDB TTL on the `ttl` attribute (epoch seconds, 180d) so
// rows self-prune — same manual TTL-enable step as the MCP OAuth tables.
const createUsageRecordsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-UsageRecords`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' } // "{YYYY-MM-DD}#{model}#{feature}"
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' }
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

// Append-only, per-charge LLM audit evidence. eventId is the uniqueness/dedup
// key (caller-controlled, not reliably date-prefixed); the GSI below on
// occurredAt is what makes a billing subject's charges queryable by month.
const createLlmChargeEventsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-LlmChargeEvents`,
    AttributeDefinitions: [
      { AttributeName: 'billingUserId', AttributeType: 'S' },
      { AttributeName: 'eventId', AttributeType: 'S' },
      { AttributeName: 'occurredAt', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'billingUserId', KeyType: 'HASH' }, { AttributeName: 'eventId', KeyType: 'RANGE' }],
    // eventId is caller-controlled and not reliably date-prefixed (provider
    // response IDs, engine task-derived keys) -- monthly queries go through
    // occurredAt, which is always a real timestamp. See llmChargeAuditDb.ts.
    GlobalSecondaryIndexes: [
      {
        IndexName: 'BillingUserOccurredAtIndex',
        KeySchema: [
          { AttributeName: 'billingUserId', KeyType: 'HASH' },
          { AttributeName: 'occurredAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  };
  try { await dynamodb.createTable(params).promise(); console.log(`Created ${params.TableName} table`); }
  catch (error: any) { if (error.code !== 'ResourceInUseException') throw error; }
};

// Create Agent Runs table (run-survival core — durable run records +
// idempotency submit-locks; see services/agentMode/runStore.ts). Single pk
// hash key with two item kinds: run#<runId>, idem#<key>.
// TTL: rows carry a `ttl` attr (epoch seconds — 30d runs / 10m-24h idem).
// Enable DynamoDB native TTL on the `ttl` attribute manually — same manual
// TTL-enable step as the UsageRecords/LoopEvents tables. Note: TTL reaping is
// eventual; the store's conditional puts treat expired items as absent, so
// correctness never depends on the reaper having run.
const createAgentRunsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-AgentRuns`,
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' }
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

const createAccountMemoryTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-AccountMemory`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'memoryId', AttributeType: 'S' },
      { AttributeName: 'category', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'memoryId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdCategoryIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'category', KeyType: 'RANGE' }
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

// Create Org Memory table
const createOrgMemoryTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-OrgMemory`,
    AttributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'memoryId', AttributeType: 'S' },
      { AttributeName: 'category', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'memoryId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'OrgIdCategoryIndex',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'category', KeyType: 'RANGE' }
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

// Create Social Engagement Tracking table
const createSocialEngagementTrackingTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-SocialEngagementTracking`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'postId_engagingAccountId', AttributeType: 'S' },
      { AttributeName: 'engagingAccountId', AttributeType: 'S' },
      { AttributeName: 'postId', AttributeType: 'S' },
      { AttributeName: 'executedAt', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'postId_engagingAccountId', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'EngagingAccountIndex',
        KeySchema: [
          { AttributeName: 'engagingAccountId', KeyType: 'HASH' },
          { AttributeName: 'executedAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'PostEngagementIndex',
        KeySchema: [
          { AttributeName: 'postId', KeyType: 'HASH' },
          { AttributeName: 'executedAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
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

const createBrowserCookiesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-BrowserCookies`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'domain', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'domain', KeyType: 'RANGE' }
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

// Create Payment History table (audit trail for Stripe payment events)
const createPaymentHistoryTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-PaymentHistory`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'timestamp', AttributeType: 'S' },
      { AttributeName: 'stripeInvoiceId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'timestamp', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'StripeInvoiceIndex',
        KeySchema: [
          { AttributeName: 'stripeInvoiceId', KeyType: 'HASH' },
        ],
        Projection: {
          ProjectionType: 'ALL',
        },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createTempEmailsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-TempEmails`,
    AttributeDefinitions: [
      { AttributeName: 'emailId', AttributeType: 'S' },
      { AttributeName: 'toAddress', AttributeType: 'S' },
      { AttributeName: 'receivedAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'emailId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'ToAddressIndex',
        KeySchema: [
          { AttributeName: 'toAddress', KeyType: 'HASH' },
          { AttributeName: 'receivedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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


const createEnrichmentHistoryTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-EnrichmentHistory`,
    AttributeDefinitions: [
      { AttributeName: 'jobId', AttributeType: 'S' },
      { AttributeName: 'leadId', AttributeType: 'S' },
      { AttributeName: 'listId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'jobType', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'jobId', KeyType: 'HASH' },
      { AttributeName: 'leadId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'listId-createdAt-index',
        KeySchema: [
          { AttributeName: 'listId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'userId-createdAt-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'jobType-createdAt-index',
        KeySchema: [
          { AttributeName: 'jobType', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createEnrichmentRawCacheTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-EnrichmentRawCache`,
    AttributeDefinitions: [
      { AttributeName: 'canonicalId', AttributeType: 'S' },
      { AttributeName: 'fieldGroup',  AttributeType: 'S' },
      { AttributeName: 'entityKey',   AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'canonicalId', KeyType: 'HASH' },
      { AttributeName: 'fieldGroup',  KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'entityKey-fieldGroup-index',
        KeySchema: [
          { AttributeName: 'entityKey',  KeyType: 'HASH' },
          { AttributeName: 'fieldGroup', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

// Shared event sink for every closed-loop instance (funnel loops + agent-mode).
// PK loopId, SK tsSession (`<ts ISO>#<subjectId>#<eventType>`); see
// loops/core/sensors/eventTableEventSource.ts for the row shape.
const createOnboardingMetricsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-OnboardingMetrics`,
    AttributeDefinitions: [
      { AttributeName: 'metricId', AttributeType: 'S' },
      { AttributeName: 'step', AttributeType: 'S' },
      { AttributeName: 'startedAt', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'metricId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'StepStartedAtIndex',
        KeySchema: [
          { AttributeName: 'step', KeyType: 'HASH' },
          { AttributeName: 'startedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createLoopEventsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: 'Dev-AW-LoopEvents',
    AttributeDefinitions: [
      { AttributeName: 'loopId', AttributeType: 'S' },
      { AttributeName: 'tsSession', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'loopId', KeyType: 'HASH' },
      { AttributeName: 'tsSession', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createLoopLearningTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: 'Dev-AW-LoopLearning',
    AttributeDefinitions: [
      { AttributeName: 'loopId', AttributeType: 'S' },
      { AttributeName: 'sortKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'loopId', KeyType: 'HASH' },
      { AttributeName: 'sortKey', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

// Loop Dispatches table — idempotency record for the Slack ✅→cloud-dev dispatch
// path (services/loopDispatchTracker.ts). PK is the Slack DM `messageTs`; the
// dedupe set lives here so it survives backend redeploys (the in-memory v1 Map
// reset on every restart, allowing a re-✅ to re-launch an EC2).
// TTL: rows carry a `ttl` attr (epoch seconds, now+7d). Enable DynamoDB native
// TTL on the `ttl` attribute manually — same manual TTL-enable step as the
// LoopEvents/LoopLearning + MCP OAuth tables. Reads also filter on `ttl` so a
// not-yet-swept-but-expired item still reads as not dispatched.
const createLoopDispatchesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: 'Dev-AW-LoopDispatches',
    AttributeDefinitions: [
      { AttributeName: 'messageTs', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'messageTs', KeyType: 'HASH' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createHumanEvalQueueTable = async () => {
  const params = {
    TableName: `${TABLE_PREFIX}AW-HumanEvalQueue`,
    KeySchema: [
      { AttributeName: 'candidateId', KeyType: 'HASH' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'candidateId', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  };
  try {
    const result = await dynamodb.createTable(params).promise();
    console.log('Human eval queue table created:', result);
  } catch (error: any) {
    if (error.code === 'ResourceInUseException') {
      console.log('Human eval queue table already exists');
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
    await createAsyncJobQueueTable();
    await createCalendlyOrphanedWebhooksTable();
    await createWaitlistTable();
    await createSubscribersTable();
    await createTaskSchedulesTable();
    await createConfigsTable();
    await createWorkflowsTable();
    await createWorkflowExecutionsTable();
    await createTaskTemplatesTable();
    await createChatSessionsTable();
    await createChatMessagesTable();
    await createTaskLeadListTable();
    await createAssetApprovalsTable();
    await createBatchReviewsTable();
    await createSettingsTable();
    await createPromptTemplatesTable();
    await createEmailEventsTable();
    await createBenchmarkTestsTable();
    await createGTMPlansTable();
    await createLeadListsTable();
    await createLeadsTable();
    await createBooksTable();
    await createBookContentsTable();
    await createConnectedAccountPostsTable();
    await createSkillsTable();
    await createSkillAssignmentsTable();
    await createWorkPlansTable();
    await createAgentApiKeysTable();
    await createMcpOAuthClientsTable();
    await createMcpOAuthCodesTable();
    await createMcpOAuthTokensTable();
    await createMcpSessionsTable();
    await createUsageRecordsTable();
    await createLlmChargeEventsTable();
    await createLandingPagesTable();
    await createAccountMemoryTable();
    await createOrgMemoryTable();
    await createSocialEngagementTrackingTable();
    await createBrowserCookiesTable();
    await createOrganizationsTable();
    await createScheduleTemplatesTable();
    await createPaymentHistoryTable();
    await createTempEmailsTable();
    await createTestAccountsTable();
    await createDealsTable();
    await createOAuthSessionsTable();
    await createDripSequencesTable();
    await createSequenceEnrollmentsTable();
    await createUnipileConnectionsTable();
    await createUnipileSentInvitationsTable();
    await createDripCampaignsTable();
    await createDripSendsTable();
    await createEnrichmentHistoryTable();
    await createEnrichmentRawCacheTable();
    await createOnboardingMetricsTable();
    await createLoopEventsTable();
    await createLoopLearningTable();
    await createLoopDispatchesTable();
    await createHumanEvalQueueTable();
    await createCharactersTable();
    await createCRMCompaniesTable();
    await createCodingAgentRunsTable();
    await createV0UsageTable();
    await createAgentRunsTable();
    console.log('All tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    process.exit(1);
  }
};

// Create Landing Pages table (for v0-generated landing pages)
const createLandingPagesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-LandingPages`,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'id', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    },
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

// Create Organizations table (for org profile sharing)
const createOrganizationsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Organizations`,
    AttributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'ownerUserId', AttributeType: 'S' },
      { AttributeName: 'autoJoinDomain', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'OwnerUserIdIndex',
        KeySchema: [
          { AttributeName: 'ownerUserId', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      },
      {
        IndexName: 'AutoJoinDomainIndex',
        KeySchema: [
          { AttributeName: 'autoJoinDomain', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    },
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

// Create Schedule Templates table (shared scheduled chat blueprints)
const createScheduleTemplatesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-ScheduleTemplates`,
    AttributeDefinitions: [
      { AttributeName: 'templateId', AttributeType: 'S' },
      { AttributeName: 'createdBy', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'visibility', AttributeType: 'S' },
      { AttributeName: 'category', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'templateId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'CreatedByIndex',
        KeySchema: [
          { AttributeName: 'createdBy', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'VisibilityCategoryIndex',
        KeySchema: [
          { AttributeName: 'visibility', KeyType: 'HASH' },
          { AttributeName: 'category', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

// Create Test Accounts table (per-user saved credentials for testing client websites)
const createTestAccountsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-TestAccounts`,
    AttributeDefinitions: [
      { AttributeName: 'accountId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'domain', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'accountId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        // Look up all accounts for a user, sorted by creation time
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        // Look up accounts for a user by domain (for get-or-create flow)
        IndexName: 'UserIdDomainIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'domain', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

// Create Deals table (CRM Unification v1 — A2)
const createDealsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Deals`,
    AttributeDefinitions: [
      { AttributeName: 'dealId', AttributeType: 'S' },
      { AttributeName: 'ownerUserId', AttributeType: 'S' },
      { AttributeName: 'heatScore', AttributeType: 'N' },
      { AttributeName: 'companyDomain', AttributeType: 'S' },
      { AttributeName: 'stage', AttributeType: 'S' },
      { AttributeName: 'primaryContactId', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'dealId', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'ownerUserId-heatScore-index',
        KeySchema: [
          { AttributeName: 'ownerUserId', KeyType: 'HASH' },
          { AttributeName: 'heatScore', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'companyDomain-stage-index',
        KeySchema: [
          { AttributeName: 'companyDomain', KeyType: 'HASH' },
          { AttributeName: 'stage', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'primaryContactId-index',
        KeySchema: [
          { AttributeName: 'primaryContactId', KeyType: 'HASH' }
        ],
        Projection: { ProjectionType: 'ALL' }
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

const createOAuthSessionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-OAuthSessions`,
    AttributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'sessionId', KeyType: 'HASH' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createDripSequencesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-DripSequences`,
    AttributeDefinitions: [
      { AttributeName: 'sequenceId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'sequenceId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-createdAt-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createSequenceEnrollmentsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-SequenceEnrollments`,
    AttributeDefinitions: [
      { AttributeName: 'enrollmentId', AttributeType: 'S' },
      { AttributeName: 'sequenceId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'nextSendAt', AttributeType: 'S' },
      { AttributeName: 'leadEmail', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'enrollmentId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'sequenceId-status-index',
        KeySchema: [
          { AttributeName: 'sequenceId', KeyType: 'HASH' },
          { AttributeName: 'status', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'userId-nextSendAt-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'nextSendAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'leadEmail-index',
        KeySchema: [
          { AttributeName: 'leadEmail', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createDripCampaignsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-DripCampaigns`,
    AttributeDefinitions: [
      { AttributeName: 'campaignId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'campaignId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createDripSendsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-DripSends`,
    AttributeDefinitions: [
      { AttributeName: 'sendId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'sendId', KeyType: 'HASH' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createCharactersTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-Characters`,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'characterId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'characterId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'CharacterIdIndex',
        KeySchema: [
          { AttributeName: 'characterId', KeyType: 'HASH' },
        ],
        Projection: {
          ProjectionType: 'ALL',
        },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createUnipileConnectionsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-UnipileConnections`,
    AttributeDefinitions: [
      { AttributeName: 'accountId', AttributeType: 'S' },
      { AttributeName: 'memberId', AttributeType: 'S' },
      { AttributeName: 'publicProfileUrl', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'accountId', KeyType: 'HASH' },
      { AttributeName: 'memberId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'publicProfileUrl-index',
        KeySchema: [
          { AttributeName: 'publicProfileUrl', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createUnipileSentInvitationsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-UnipileSentInvitations`,
    AttributeDefinitions: [
      { AttributeName: 'accountId', AttributeType: 'S' },
      { AttributeName: 'invitedUserPublicId', AttributeType: 'S' },
      { AttributeName: 'publicProfileUrl', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'accountId', KeyType: 'HASH' },
      { AttributeName: 'invitedUserPublicId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'publicProfileUrl-index',
        KeySchema: [
          { AttributeName: 'publicProfileUrl', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createCRMCompaniesTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-CRMCompanies`,
    AttributeDefinitions: [
      { AttributeName: 'companyId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'domain', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'companyId', KeyType: 'HASH' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-createdAt-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
      {
        IndexName: 'domain-index',
        KeySchema: [
          { AttributeName: 'domain', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
    ],
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
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

const createCodingAgentRunsTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-CodingAgentRuns`,
    AttributeDefinitions: [
      { AttributeName: 'runId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'runId', KeyType: 'HASH' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

const createV0UsageTable = async () => {
  const params: AWS.DynamoDB.CreateTableInput = {
    TableName: `${TABLE_PREFIX}AW-V0Usage`,
    AttributeDefinitions: [
      { AttributeName: 'idempotencyKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'idempotencyKey', KeyType: 'HASH' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
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

// Run if this script is called directly
if (require.main === module) {
  main();
}
