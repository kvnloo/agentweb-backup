import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { S3 } from "aws-sdk";
import { Task } from "../types/task";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// For debugging
console.log("Environment variables loaded:", {
  environment: process.env.NODE_ENV || "production",
  hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
  hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
});

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// Initialize S3 client
const s3 = new S3();

// Helper function to handle DynamoDB errors
const handleDynamoDbError = (error: any, operation: string) => {
  console.error(`DynamoDB ${operation} error:`, error);
  if (error.code === "CredentialsError") {
    throw new Error(
      "AWS credentials are invalid or missing. Please check your .env file"
    );
  }
  throw error;
};

// Ensure the User interface is exported
export interface User {
  userId: string;
  email: string;
  password: string;
  isOAuthUser: boolean;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  roles?: ("partner" | "customer")[];
  stripe_customer_id?: string;
  companyName?: string;
  useCaseCategories?: string[];
  brandGuidelines?: {
    brandData: {
      brandName: string;
      tagline: string;
      primaryColor: string;
      secondaryColor: string;
      fontFamily: string;
      toneOfVoice: string;
      keyMessages: string[];
      brandValues: string[];
      targetAudience: string;
      brandPersonality: string;
    };
    attachments: Array<{
      type: string;
      url: string;
      key: string;
      filename: string;
    }>;
    createdAt: string;
    updatedAt: string;
  };
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: "pending" | "answered";
  timestamp: number;
}

interface TaskAttachment {
  url: string;
  key: string;
  filename: string;
  uploadedAt: string;
}

interface TaskTemplate {
  templateId: string;
  userId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[];
  nameParameter: string | null;
  isInteractive: boolean;
  isDeepResearch: boolean;
  isComplexTask?: boolean;
  extractPageContent?: boolean;
  outputAsJson?: boolean;
  outputAsHtml?: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
  category?: string;
  selectedLLMs?: string[];
  useSharedBrowser?: boolean;
  turnOffHeadless?: boolean;
  useKnowledgeBase?: boolean;
  updateKnowledgeBase?: boolean;
  updateLeadList?: boolean;
}

interface UserWithCounts extends User {
  taskCount: number;
  workflowCount: number;
}

class UserDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName: string;

  constructor() {
    console.log(
      "Initializing DynamoDB with region:",
      process.env.AWS_REGION || "us-west-2"
    );
    this.docClient = dynamodb;
    this.tableName = `${TABLE_PREFIX}AW-Users`;
  }

  private handleError(error: any, operation: string) {
    console.error(`DynamoDB ${operation} error:`, error);
    if (error.code === "ValidationException") {
      throw new Error(`Validation error during ${operation}: ${error.message}`);
    } else if (error.code === "ResourceNotFoundException") {
      throw new Error(`Table not found during ${operation}: ${error.message}`);
    } else if (error.code === "AccessDeniedException") {
      throw new Error(`Access denied during ${operation}: ${error.message}`);
    } else {
      throw new Error(`Error during ${operation}: ${error.message}`);
    }
  }

  async createUser(
    email: string,
    userId: string,
    password: string,
    isOAuthUser: boolean = false,
    isAdmin: boolean = false,
    roles: ("partner" | "customer")[] = ["partner"],
    displayName?: string,
    googleId?: string,
    stripe_customer_id?: string,
    companyName?: string,
    useCaseCategories?: string[]
  ): Promise<User | undefined> {
    const itemToCreate: any = {
      userId,
      email: email.toLowerCase(),
      password,
      isOAuthUser,
      isAdmin,
      isActive: true,
      createdAt: new Date().toISOString(),
      roles,
    };

    if (displayName) {
      itemToCreate.displayName = displayName;
    }
    if (googleId) {
      itemToCreate.googleId = googleId;
    }
    if (stripe_customer_id) {
      itemToCreate.stripe_customer_id = stripe_customer_id;
    }
    if (companyName) {
      itemToCreate.companyName = companyName;
    }
    if (useCaseCategories && useCaseCategories.length > 0) {
      itemToCreate.useCaseCategories = useCaseCategories;
    }

    const params = {
      TableName: this.tableName,
      Item: itemToCreate,
      ConditionExpression: "attribute_not_exists(email)",
    };

    try {
      await this.docClient.put(params).promise();
      return params.Item as User;
    } catch (error) {
      handleDynamoDbError(error, "createUser");
      return undefined;
    }
  }

  async getUserByEmail(email: string) {
    const params = {
      TableName: this.tableName,
      IndexName: "EmailIndex",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": email.toLowerCase(),
      },
    };

    const result = await this.docClient.query(params).promise();
    return result.Items?.[0];
  }

  async getUserById(userId: string) {
    try {
      const params = {
        TableName: this.tableName,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      };

      const result = await this.docClient.query(params).promise();
      return result.Items?.[0];
    } catch (error) {
      console.error("Error in getUserById:", error);
      throw error;
    }
  }

  async getAllUsers(): Promise<UserWithCounts[]> {
    try {
      const params = {
        TableName: this.tableName,
        Limit: 50,
      };

      const result = await this.docClient.scan(params).promise();
      const users = result.Items || [];

      // Get task and workflow counts for each user
      const usersWithCounts = await Promise.all(
        users.map(async (user) => {
          // Get user's tasks
          const tasks = await taskDb.getTasksByUserId(user.userId);

          // Get user's workflow count
          const workflowCount = await workflowDb.getUserWorkflowCount(
            user.userId
          );

          return {
            ...user,
            taskCount: tasks ? tasks.length : 0,
            workflowCount,
          } as UserWithCounts;
        })
      );

      return usersWithCounts;
    } catch (error) {
      console.error("Error in getAllUsers:", error);
      throw error;
    }
  }

  async getUserAnalytics(startDate: string, endDate: string) {
    try {
      const params = {
        TableName: this.tableName,
      };

      const result = await this.docClient.scan(params).promise();
      const users = result.Items || [];

      return {
        totalUsers: users.length,
        newUsers: users.filter(
          (u) => u.createdAt >= startDate && u.createdAt <= endDate
        ).length,
        oauthUsers: users.filter((u) => u.isOAuthUser).length,
        newOauthUsers: users.filter(
          (u) =>
            u.isOAuthUser && u.createdAt >= startDate && u.createdAt <= endDate
        ).length,
        adminUsers: users.filter((u) => u.isAdmin).length,
      };
    } catch (error) {
      console.error("Error in getUserAnalytics:", error);
      throw error;
    }
  }

  async deactivateUser(userId: string) {
    try {
      // First get the user to get the email (primary key)
      const user = await this.getUserById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const params = {
        TableName: this.tableName,
        Key: {
          email: user.email, // Using email as the primary key
        },
        UpdateExpression: "set isActive = :isActive",
        ExpressionAttributeValues: {
          ":isActive": false,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      this.handleError(error, "deactivateUser");
    }
  }

  async updateUser(userId: string, updates: Partial<User>) {
    // First, get the user by userId to ensure they exist and to get their email
    const user = await this.getUserById(userId);
    if (!user || !user.email) {
      // This will be caught by the generic error handler, but good to be explicit
      throw new Error(`User with ID '${userId}' not found or has no email.`);
    }

    // Filter out keys that are part of the key or should not be updated directly
    const {
      userId: _,
      email: __,
      password: ___,
      createdAt: ____,
      ...updatableFields
    } = updates;

    if (Object.keys(updatableFields).length === 0) {
      return user; // Return the fetched user object if no updates are needed
    }

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    Object.entries(updatableFields).forEach(([key, value]) => {
      // Ensure value is not undefined. Allow null to explicitly remove/set a field to null.
      if (value !== undefined) {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    if (updateExpressions.length === 0) {
      return user;
    }

    const params = {
      TableName: this.tableName,
      Key: { email: user.email }, // Use email as the primary key
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes as User;
    } catch (error) {
      handleDynamoDbError(error, "updateUser");
      throw error; // Re-throw after logging
    }
  }

  async deleteUserById(
    userId: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      // First, get the user by userId to retrieve their email (the primary key)
      const user = await this.getUserById(userId);
      if (!user || !user.email) {
        // This case should ideally not happen if userId is valid and user has an email
        return { success: false, message: "User not found or email missing." };
      }

      // Prevent deletion of admin users as a safeguard, mirroring route logic
      if (user.isAdmin) {
        return {
          success: false,
          message: "Admin users cannot be deleted through this method.",
        };
      }

      const params = {
        TableName: this.tableName,
        Key: {
          email: user.email, // Use email as the primary key for deletion
        },
      };

      await this.docClient.delete(params).promise();
      return { success: true };
    } catch (error: any) {
      console.error(`Error deleting user ${userId}:`, error);
      // It might be better to use this.handleError if it's adapted to return or set a structured error
      return {
        success: false,
        message: error.message || `Failed to delete user ${userId}.`,
      };
    }
  }
}

// Initialize and export userDb instance
export const userDb = new UserDB();

export const taskDb = {
  async createTask(task: {
    taskId: string;
    userId: string;
    name: string;
    prompt: string;
    status: string;
    createdAt: string;
    isInteractive?: boolean;
    isDeepResearch?: boolean;
    isComplexTask?: boolean;
    extractPageContent?: boolean;
    validateOutput?: boolean;
    outputAsJson?: boolean;
    outputAsHtml?: boolean;
    isAgenticDevMode?: boolean;
    emailNotification?: boolean;
    attachments?: TaskAttachment[];
    category?: string;
    description?: string;
    llmName?: string | null;
    templateId?: string;
    selectedLLMs?: string[];
    useSharedBrowser?: boolean;
    turnOffHeadless?: boolean;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Item: task,
      };

      await dynamodb.put(params).promise();
      return task;
    } catch (error) {
      handleDynamoDbError(error, "createTask");
    }
  },

  async getAllTasks() {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        ProjectionExpression:
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en, #i, #dr, attachments, #llm, #ct, #epc, #vo, #oaj, #oah, #adm, category, description, templateId, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, knowledgeBase, knowledgeBaseSize, knowledgeBaseType",
        ExpressionAttributeNames: {
          "#n": "name",
          "#s": "status",
          "#e": "error",
          "#sum": "summary",
          "#en": "emailNotification",
          "#i": "isInteractive",
          "#dr": "isDeepResearch",
          "#llm": "llmName",
          "#ct": "isComplexTask",
          "#epc": "extractPageContent",
          "#vo": "validateOutput",
          "#oaj": "outputAsJson",
          "#oah": "outputAsHtml",
          "#adm": "isAgenticDevMode",
        },
      };

      let allItems: any[] = [];
      let lastEvaluatedKey: any = undefined;

      do {
        const result = await dynamodb
          .scan({
            ...params,
            ExclusiveStartKey: lastEvaluatedKey,
          })
          .promise();

        if (result.Items) {
          allItems = allItems.concat(result.Items);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getAllTasks");
    }
  },

  async getTaskSchedules(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getTaskSchedules");
    }
  },

  async getTasksByUserId(userId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        IndexName: "UserTasksIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        ProjectionExpression:
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #epc, #vo, #oaj, #oah, #adm, category, description, templateId, knowledgeBaseSize",
        ExpressionAttributeNames: {
          "#n": "name",
          "#s": "status",
          "#e": "error",
          "#sum": "summary",
          "#epc": "extractPageContent",
          "#vo": "validateOutput",
          "#oaj": "outputAsJson",
          "#oah": "outputAsHtml",
          "#adm": "isAgenticDevMode",
        },
      };

      const result = await dynamodb.query(params).promise();
      const tasks = result.Items || [];

      // Get latest execution, schedules and subscribers for each task
      const tasksWithDetails = await Promise.all(
        tasks.map(async (task) => {
          const [executions, schedules, subscribers] = await Promise.all([
            this.getTaskExecutions(task.taskId),
            this.getTaskSchedules(task.taskId),
            subscriberDb.getTaskSubscribers(task.taskId),
          ]);

          // Filter out archived executions and get the latest one
          const nonArchivedExecutions =
            executions?.filter((exec) => !exec.archived) || [];
          const latestExecution =
            nonArchivedExecutions.length > 0 ? nonArchivedExecutions[0] : null;

          return {
            ...task,
            latestExecution,
            scheduleCount: schedules ? schedules.length : 0,
            subscriberCount: subscribers ? subscribers.length : 0,
          };
        })
      );

      return tasksWithDetails;
    } catch (error) {
      handleDynamoDbError(error, "getTasksByUserId");
    }
  },

  async getTaskById(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Key: {
          taskId,
        },
        ProjectionExpression:
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en, #i, #dr, attachments, #llm, #ct, #epc, #vo, #oaj, #oah, #adm, category, description, templateId, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, updateLeadList, leadListIdentifier, knowledgeBase, knowledgeBaseSize, knowledgeBaseType, knowledgeBaseUpdatedAt",
        ExpressionAttributeNames: {
          "#n": "name",
          "#s": "status",
          "#e": "error",
          "#sum": "summary",
          "#en": "emailNotification",
          "#i": "isInteractive",
          "#dr": "isDeepResearch",
          "#llm": "llmName",
          "#ct": "isComplexTask",
          "#epc": "extractPageContent",
          "#vo": "validateOutput",
          "#oaj": "outputAsJson",
          "#oah": "outputAsHtml",
          "#adm": "isAgenticDevMode",
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getTaskById");
    }
  },

  async updateTask(
    taskId: string,
    updates: Partial<{
      name: string;
      prompt: string;
      status: string;
      error: string;
      summary: string;
      emailNotification: boolean;
      isInteractive: boolean;
      isDeepResearch: boolean;
      isComplexTask: boolean;
      extractPageContent: boolean;
      validateOutput: boolean;
      outputAsJson: boolean;
      outputAsHtml: boolean;
      isAgenticDevMode: boolean;
      llmName: string | null;
      attachments: TaskAttachment[];
      selectedLLMs?: string[];
      useSharedBrowser?: boolean;
      turnOffHeadless?: boolean;
      knowledgeBase?: string;
      knowledgeBaseSize?: number;
      knowledgeBaseType?: "public" | "private";
      useKnowledgeBase?: boolean;
      updateKnowledgeBase?: boolean;
      updateLeadList?: boolean;
      leadListIdentifier?: string | null;
      knowledgeBaseUpdatedAt?: string;
    }>
  ) {
    try {
      const setClauses: string[] = [];
      const removeClauses: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (value === null) {
          // Attribute to be removed
          removeClauses.push(`#${key}`);
          expressionAttributeNames[`#${key}`] = key;
        } else if (value !== undefined) {
          // Attribute to be set/updated
          setClauses.push(`#${key} = :${key}`);
          expressionAttributeNames[`#${key}`] = key;
          expressionAttributeValues[`:${key}`] = value;
        }
      });

      if (setClauses.length === 0 && removeClauses.length === 0) {
        console.warn(
          `[db.ts] updateTask called for taskId ${taskId} with no effective update operations. Returning current task attributes.`
        );
        // Optionally, you might want to fetch and return the current task if no updates are made.
        const currentTaskAttributes = await this.getTaskById(taskId);
        return currentTaskAttributes;
      }

      let updateExpression = "";
      if (setClauses.length > 0) {
        updateExpression += `SET ${setClauses.join(", ")}`;
      }
      if (removeClauses.length > 0) {
        if (updateExpression.length > 0) {
          updateExpression += " "; // Add space if SET clauses exist
        }
        updateExpression += `REMOVE ${removeClauses.join(", ")}`;
      }

      const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Key: { taskId },
        UpdateExpression: updateExpression,
        ReturnValues: "ALL_NEW",
      };

      if (Object.keys(expressionAttributeNames).length > 0) {
        params.ExpressionAttributeNames = expressionAttributeNames;
      }

      // ExpressionAttributeValues should only be added if there are value placeholders (i.e., if setClauses is not empty)
      // This also means expressionAttributeValues will not be empty if setClauses is not empty.
      if (Object.keys(expressionAttributeValues).length > 0) {
        params.ExpressionAttributeValues = expressionAttributeValues;
      }

      console.log(
        `[db.ts] DynamoDB updateTask params for taskId ${taskId}:`,
        JSON.stringify(params, null, 2)
      ); // Added log

      const result = await dynamodb.update(params).promise();
      console.log("[db.ts] DynamoDB updateTask result:", result);
      return result.Attributes;
    } catch (error) {
      console.error(`[db.ts] Error in updateTask for taskId ${taskId}:`, error);
      handleDynamoDbError(error, "updateTask");
    }
  },

  async deleteTask(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
        Key: {
          taskId,
        },
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "deleteTask");
    }
  },

  async createTaskExecution(execution: {
    executionId: string;
    taskId: string;
    userId: string;
    run_user_id?: string;
    status: string;
    startTime: string;
    workflowExecutionId?: string;
    prompt?: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Item: execution,
      };

      await dynamodb.put(params).promise();
      return execution;
    } catch (error) {
      handleDynamoDbError(error, "createTaskExecution");
    }
  },

  async getTaskExecutionById(executionId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: {
          executionId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getTaskExecutionById");
    }
  },

  async updateTaskExecution(
    executionId: string,
    updates: Partial<{
      status: string;
      error: string;
      result: string;
      completedAt: string;
      feedback: "accepted" | "rejected" | null;
      userInteractions: UserInteraction[];
      shareToken: string;
      knowledge_base_updated_at: string;
    }>
  ) {
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
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: {
          executionId,
        },
        UpdateExpression: updateExpressions.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ...(Object.keys(expressionAttributeValues).length > 0 && {
          ExpressionAttributeValues: expressionAttributeValues,
        }),
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateTaskExecution");
    }
  },

  async getPendingTaskExecutions() {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        IndexName: "StatusCreatedAtIndex",
        KeyConditionExpression: "#status = :status",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "pending",
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items;
    } catch (error) {
      handleDynamoDbError(error, "getPendingTaskExecutions");
    }
  },

  async getTaskExecutions(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
        ScanIndexForward: false, // Get latest executions first
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getTaskExecutions");
    }
  },

  async getTaskAnalytics(startDate: string, endDate: string) {
    try {
      // Get all tasks (no date filter)
      const taskParams = {
        TableName: `${TABLE_PREFIX}AW-Tasks`,
      };

      const taskResult = await dynamodb.scan(taskParams).promise();
      const tasks = taskResult.Items || [];

      // Get total count of executions using a separate count operation
      const executionCountParams = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Select: "COUNT",
      };

      const executionCountResult = await dynamodb
        .scan(executionCountParams)
        .promise();
      const totalExecutions = executionCountResult.Count || 0;

      // Get executions for status counts (limited to 1000 for performance)
      const executionParams = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
      };

      const executionResult = await dynamodb.scan(executionParams).promise();
      const executions = executionResult.Items || [];

      // Get all schedules (no date filter)
      const scheduleParams = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
      };

      const scheduleResult = await dynamodb.scan(scheduleParams).promise();
      const schedules = scheduleResult.Items || [];

      // Get all templates (no date filter)
      const templateParams = {
        TableName: `${TABLE_PREFIX}AW-TaskTemplates`,
      };

      const templateResult = await dynamodb.scan(templateParams).promise();
      const templates = templateResult.Items || [];

      // Get all configurations (no date filter)
      const configParams = {
        TableName: `${TABLE_PREFIX}AW-Configs`,
      };

      const configResult = await dynamodb.scan(configParams).promise();
      const configs = configResult.Items || [];

      // Get all workflows (no date filter)
      const workflowParams = {
        TableName: `${TABLE_PREFIX}AW-Workflows`,
      };

      const workflowResult = await dynamodb.scan(workflowParams).promise();
      const workflows = workflowResult.Items || [];

      // Get all workflow executions (no date filter)
      const workflowExecParams = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
      };

      const workflowExecResult = await dynamodb
        .scan(workflowExecParams)
        .promise();
      const workflowExecutions = workflowExecResult.Items || [];

      return {
        totalTasks: tasks.length,
        newTasks: tasks.filter(
          (t) => t.createdAt >= startDate && t.createdAt <= endDate
        ).length,
        totalExecutions: executions.length,
        successfulExecutions: executions.filter((e) => e.status === "completed")
          .length,
        failedExecutions: executions.filter((e) => e.status === "failed")
          .length,
        newExecutions: executions.filter(
          (e) => e.startTime >= startDate && e.startTime <= endDate
        ).length,
        scheduledTasks: schedules.length,
        newScheduledTasks: schedules.filter(
          (s) => s.createdAt >= startDate && s.createdAt <= endDate
        ).length,
        templates: templates.length,
        newTemplates: templates.filter(
          (t) => t.createdAt >= startDate && t.createdAt <= endDate
        ).length,
        websiteConfigs: configs.filter((c) => !c.isApiConfig).length,
        newWebsiteConfigs: configs.filter(
          (c) =>
            !c.isApiConfig && c.createdAt >= startDate && c.createdAt <= endDate
        ).length,
        apiConfigs: configs.filter((c) => c.isApiConfig === true).length,
        newApiConfigs: configs.filter(
          (c) =>
            c.isApiConfig === true &&
            c.createdAt >= startDate &&
            c.createdAt <= endDate
        ).length,
        sharedConfigs: configs.filter((c) => c.sharedBy || c.sharedConfigIds)
          .length,
        totalWorkflows: workflows.length,
        newWorkflows: workflows.filter(
          (w) => w.createdAt >= startDate && w.createdAt <= endDate
        ).length,
        workflowExecutions: workflowExecutions.length,
        newWorkflowExecutions: workflowExecutions.filter(
          (e) => e.startTime >= startDate && e.startTime <= endDate
        ).length,
        successfulWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "success" || e.status === "completed"
        ).length,
        failedWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "failed"
        ).length,
        pendingWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "pending" || e.status === "running"
        ).length,
        workflowExecutionStatusBreakdown: Object.entries(
          workflowExecutions.reduce<Record<string, number>>((acc, exec) => {
            acc[exec.status || "unknown"] =
              (acc[exec.status || "unknown"] || 0) + 1;
            return acc;
          }, {})
        ),
        averageExecutionTime:
          executions
            .filter((e) => e.status === "completed" && e.completedAt)
            .reduce((acc, e) => {
              return (
                acc +
                (new Date(e.completedAt!).getTime() -
                  new Date(e.startTime).getTime())
              );
            }, 0) /
          (executions.filter((e) => e.status === "completed" && e.completedAt)
            .length || 1),
      };
    } catch (error) {
      console.error("Error in getTaskAnalytics:", error);
      throw error;
    }
  },

  async addAttachment(
    taskId: string,
    file: {
      originalname: string;
      buffer: Buffer;
      mimetype: string;
    }
  ) {
    try {
      // Get current task to check attachment count
      const task = await this.getTaskById(taskId);
      if (!task) throw new Error("Task not found");

      // Check attachment limit
      const currentAttachments = task.attachments || [];
      if (currentAttachments.length >= 5) {
        throw new Error("Maximum number of attachments (5) reached");
      }

      // Generate a random token (32 characters)
      const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const key = `tasks/${taskId}/attachments/${Date.now()}-${randomToken}-${
        file.originalname
      }`;

      // Upload to S3 without ACL setting
      await s3
        .putObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
        .promise();

      // Generate regular S3 URL
      const url = `https://${
        process.env.AWS_S3_BUCKET || "agentweb-user-files"
      }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

      // Update task with attachment URL
      const attachments = [
        ...currentAttachments,
        {
          url,
          key,
          filename: file.originalname,
          uploadedAt: new Date().toISOString(),
        },
      ];

      await this.updateTask(taskId, { attachments });

      return { url, key, filename: file.originalname };
    } catch (error) {
      if (error instanceof Error) {
        throw error; // Re-throw the attachment limit error
      }
      handleDynamoDbError(error, "addAttachment");
    }
  },

  async deleteAttachment(taskId: string, key: string) {
    try {
      // Delete from S3
      await s3
        .deleteObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: key,
        })
        .promise();

      // Update task to remove attachment
      const task = await this.getTaskById(taskId);
      if (!task) throw new Error("Task not found");

      const attachments = (task.attachments || []).filter(
        (a: TaskAttachment) => a.key !== key
      );
      await this.updateTask(taskId, { attachments });
    } catch (error) {
      handleDynamoDbError(error, "deleteAttachment");
    }
  },

  async updateTaskOwner(taskId: string, newOwnerId: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Tasks`,
      Key: {
        taskId,
      },
      UpdateExpression: "set userId = :userId",
      ExpressionAttributeValues: {
        ":userId": newOwnerId,
      },
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes;
  },

  async archiveExecution(taskId: string, executionId: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
      Key: {
        executionId,
      },
      UpdateExpression: "SET archived = :archived, archivedAt = :archivedAt",
      ExpressionAttributeValues: {
        ":archived": true,
        ":archivedAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes;
  },

  async unarchiveExecution(taskId: string, executionId: string) {
    const params = {
      TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
      Key: {
        executionId,
      },
      UpdateExpression: "REMOVE archived, archivedAt",
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(params).promise();
    return result.Attributes;
  },

  async killTaskExecution(executionId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: {
          executionId,
        },
        UpdateExpression: "SET killRequested = :killRequested",
        ExpressionAttributeValues: {
          ":killRequested": new Date().toISOString(),
        },
        ReturnValues: "UPDATED_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "killTaskExecution");
    }
  },

  async getAvailableTasks(userId: string) {
    try {
      const tasks = await this.getTasksByUserId(userId);
      if (!tasks) return [];
      return tasks.filter((task: any) => task.status === "active");
    } catch (error) {
      handleDynamoDbError(error, "getAvailableTasks");
      return [];
    }
  },
};

export const waitlistDb = {
  async add(entry: { email: string; joinedAt: string }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Item: entry,
      };

      await dynamodb.put(params).promise();
      return entry;
    } catch (error) {
      handleDynamoDbError(error, "addToWaitlist");
    }
  },

  async getByEmail(email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Key: {
          email,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getWaitlistByEmail");
    }
  },

  async list(lastEvaluatedKey?: any) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Waitlist`,
        Limit: 50,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      };

      const result = await dynamodb.scan(params).promise();
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey,
      };
    } catch (error) {
      console.error("Error listing waitlist:", error);
      throw error;
    }
  },
};

export const scheduleDb = {
  async createSchedule(schedule: {
    scheduleId: string;
    taskId: string;
    userId: string;
    frequency: string; // 'daily', 'weekly', 'monthly', or cron expression
    nextRunTime: string;
    status: string; // 'active' or 'inactive'
    createdAt: string;
    lastRunTime?: string;
    timezone?: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Item: schedule,
      };

      await dynamodb.put(params).promise();
      return schedule;
    } catch (error) {
      handleDynamoDbError(error, "createSchedule");
    }
  },

  async getSchedulesByTaskId(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getSchedulesByTaskId");
    }
  },

  async getScheduleById(scheduleId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getScheduleById");
    }
  },

  async updateSchedule(
    scheduleId: string,
    updates: Partial<{
      frequency: string;
      nextRunTime: string;
      status: string;
      lastRunTime: string;
      timezone: string;
    }>
  ) {
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
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSchedule");
    }
  },

  async deleteSchedule(scheduleId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        Key: {
          scheduleId,
        },
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "deleteSchedule");
    }
  },

  async getPendingSchedules() {
    try {
      const now = new Date().toISOString();
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskSchedules`,
        IndexName: "StatusNextRunTimeIndex",
        KeyConditionExpression: "#status = :status AND #nextRunTime <= :now",
        ExpressionAttributeNames: {
          "#status": "status",
          "#nextRunTime": "nextRunTime",
        },
        ExpressionAttributeValues: {
          ":status": "active",
          ":now": now,
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getPendingSchedules");
    }
  },
};

export const subscriberDb = {
  async addSubscriber(taskId: string, email: string) {
    try {
      const subscribedAt = new Date().toISOString();
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Item: {
          taskId,
          email,
          subscribedAt,
        },
        ConditionExpression:
          "attribute_not_exists(taskId) AND attribute_not_exists(email)",
      };

      await dynamodb.put(params).promise();
      return { taskId, email, subscribedAt };
    } catch (error: any) {
      if (error.code === "ConditionalCheckFailedException") {
        throw new Error(`Email ${email} is already subscribed to this task`);
      }
      handleDynamoDbError(error, "addSubscriber");
    }
  },

  async removeSubscriber(taskId: string, email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId,
          email,
        },
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      handleDynamoDbError(error, "removeSubscriber");
    }
  },

  async getTaskSubscribers(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        KeyConditionExpression: "taskId = :taskId",
        ExpressionAttributeValues: {
          ":taskId": taskId,
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getTaskSubscribers");
    }
  },
};

// Add minimal workflow methods for counting
export const workflowDb = {
  async getUserWorkflowCount(userId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Workflows`,
        IndexName: "UserWorkflowsIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        Select: "COUNT",
      };

      const result = await dynamodb.query(params).promise();
      return result.Count || 0;
    } catch (error) {
      console.error("Error getting workflow count:", error);
      return 0;
    }
  },
};

class TaskTemplateDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName: string;

  constructor() {
    this.docClient = dynamodb;
    this.tableName = `${TABLE_PREFIX}AW-TaskTemplates`;
  }

  async createTemplate(template: TaskTemplate) {
    const params = {
      TableName: this.tableName,
      Item: template,
    };

    try {
      await this.docClient.put(params).promise();
      return template;
    } catch (error) {
      handleDynamoDbError(error, "createTemplate");
      throw error;
    }
  }

  async getTemplatesByUserId(userId: string) {
    const params = {
      TableName: this.tableName,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };

    try {
      const result = await this.docClient.query(params).promise();
      return result.Items as TaskTemplate[];
    } catch (error) {
      handleDynamoDbError(error, "getTemplatesByUserId");
      throw error;
    }
  }

  async getAllTemplates() {
    const params = {
      TableName: this.tableName,
    };

    try {
      const result = await this.docClient.scan(params).promise();
      return result.Items as TaskTemplate[];
    } catch (error) {
      handleDynamoDbError(error, "getAllTemplates");
      throw error;
    }
  }

  async getPublishedTemplates() {
    const params = {
      TableName: this.tableName,
      FilterExpression: "published = :published",
      ExpressionAttributeValues: {
        ":published": true,
      },
    };

    try {
      const result = await this.docClient.scan(params).promise();
      return result.Items as TaskTemplate[];
    } catch (error) {
      handleDynamoDbError(error, "getPublishedTemplates");
      throw error;
    }
  }

  async getTemplateById(templateId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        templateId,
      },
    };

    try {
      const result = await this.docClient.get(params).promise();
      return result.Item as TaskTemplate;
    } catch (error) {
      handleDynamoDbError(error, "getTemplateById");
      throw error;
    }
  }

  async updateTemplate(
    templateId: string,
    updates: Partial<Omit<TaskTemplate, "templateId" | "userId" | "createdAt">>
  ) {
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        updateExpressions.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    // Always update the updatedAt timestamp
    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        templateId,
      },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes as TaskTemplate;
    } catch (error) {
      handleDynamoDbError(error, "updateTemplate");
      throw error;
    }
  }

  async deleteTemplate(templateId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        templateId,
      },
    };

    try {
      await this.docClient.delete(params).promise();
      return { success: true };
    } catch (error) {
      handleDynamoDbError(error, "deleteTemplate");
      throw error;
    }
  }
}

export const taskTemplateDb = new TaskTemplateDB();
