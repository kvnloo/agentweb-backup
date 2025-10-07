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
  lastLoginTime?: string;
  supportNote?: string;
  roles?: ("partner" | "customer" | "free")[];
  displayName?: string;
  stripe_customer_id?: string;
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
  companyName?: string;
  useCaseCategories?: string[];
  brandGuidelines?: {
    brandData: {
      brandName: string;
      tagline: string;
      primaryColor: string;
      primaryColorEnd: string;
      secondaryColor: string;
      fontFamily: string;
      toneOfVoice: string;
      keyMessages: string[];
      brandValues: string[];
      targetAudience: string;
      brandPersonality: string;
      isGradient: boolean;
      founders: Array<{
        name: string;
        jobTitle: string;
        styleTone: string;
        signaturePosts: string;
      }>;
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
  marketStrategy?: {
    businessOverview: string;
    competitors: Array<{
      name: string;
      description: string;
    }>;
    icp: Array<{
      title: string;
      description: string;
      valueProposition: string;
    }>;
    createdAt: string;
    updatedAt: string;
  };
  startupProfiles?: Array<{
    id: string;
    companyName: string;
    industry: string;
    companySize: string;
    targetMarket: string;
    currentChallenges: string;
    goals: string;
    createdAt: string;
    updatedAt: string;
  }>;
  resetPasswordToken?: string;
  resetPasswordExpires?: string;
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
  emailFriendlyHtml?: boolean;
  repairImageEmbedding?: boolean;
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
  createVideo?: boolean;
  requireApproval?: boolean;
  slackChannel?: string;
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
    roles: ("partner" | "customer" | "free")[] = ["partner"],
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
        Limit: 5000,
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

      // Convert dates to ISO strings for proper comparison
      const startDateISO = new Date(startDate).toISOString();
      const endDateISO = new Date(endDate).toISOString();

      const newUsers = users.filter((u) => {
        if (!u.createdAt) return false;
        const userCreatedAt = new Date(u.createdAt).toISOString();
        return userCreatedAt >= startDateISO && userCreatedAt <= endDateISO;
      });

      const oauthUsers = users.filter((u) => u.isOAuthUser === true);
      const newOauthUsers = oauthUsers.filter((u) => {
        if (!u.createdAt) return false;
        const userCreatedAt = new Date(u.createdAt).toISOString();
        return userCreatedAt >= startDateISO && userCreatedAt <= endDateISO;
      });

      const adminUsers = users.filter((u) => u.isAdmin === true);

      const analytics = {
        totalUsers: users.length,
        newUsers: newUsers.length,
        oauthUsers: oauthUsers.length,
        newOauthUsers: newOauthUsers.length,
        adminUsers: adminUsers.length,
      };

      return analytics;
    } catch (error) {
      console.error("Error in getUserAnalytics:", error);
      throw error;
    }
  }

  // Helper function to scan all items with pagination
  async scanAllItems(tableName: string) {
    const items: any[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const params: any = {
        TableName: tableName,
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await this.docClient.scan(params).promise();
      items.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return items;
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

  async getUserByResetToken(resetToken: string): Promise<User | null> {
    try {
      const params = {
        TableName: this.tableName,
        FilterExpression: "resetPasswordToken = :token",
        ExpressionAttributeValues: {
          ":token": resetToken,
        },
      };

      const result = await this.docClient.scan(params).promise();
      return result.Items && result.Items.length > 0 ? (result.Items[0] as User) : null;
    } catch (error) {
      this.handleError(error, "getUserByResetToken");
      return null;
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
    createVideo?: boolean;
    videoModel?: string;
    imageModel?: string;
    requireApproval?: boolean;
    slackChannel?: string;
    emailSender?: string;
    fromName?: string;
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
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en, #i, #dr, attachments, #llm, #ct, #epc, #vo, #oaj, #oah, #adm, category, description, templateId, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, knowledgeBase, knowledgeBaseSize, knowledgeBaseType, knowledgeBaseUpdatedAt, createVideo, videoModel, imageModel, requireApproval, slackChannel, emailSender, fromName",
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
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #epc, #vo, #oaj, #oah, emailFriendlyHtml, repairImageEmbedding, #adm, category, description, templateId, knowledgeBaseSize, createVideo, videoModel, imageModel, requireApproval, slackChannel, sendHtmlReportOnly",
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
          "taskId, userId, #n, prompt, #s, createdAt, updatedAt, #e, #sum, #en, #i, #dr, attachments, #llm, #ct, #epc, #vo, #oaj, #oah, emailFriendlyHtml, repairImageEmbedding, htmlFormatInstructions, #adm, category, description, templateId, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, updateLeadList, createVideo, videoModel, imageModel, leadListIdentifier, knowledgeBase, knowledgeBaseSize, knowledgeBaseType, knowledgeBaseUpdatedAt, requireApproval, slackChannel, sendHtmlReportOnly, emailSender, fromName",
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
      createVideo?: boolean;
      videoModel?: string;
      imageModel?: string;
      leadListIdentifier?: string | null;
      knowledgeBaseUpdatedAt?: string;
      requireApproval?: boolean;
      slackChannel?: string;
      sendHtmlReportOnly?: boolean;
      emailSender?: string;
      fromName?: string;
      htmlTemplateFilename?: string | null;
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

      const result = await dynamodb.update(params).promise();
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
    feedback?: string;
    revision_prompt?: string;
    original_image_url?: string;
    original_execution_id?: string;
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
      result_files: Array<{
        url: string;
        filename: string;
        token: string;
        is_html?: boolean;
        is_favorited?: boolean;
      }>;
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

  async getAllTaskExecutionsByUserId(userId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        ScanIndexForward: false, // Get latest executions first
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getAllTaskExecutionsByUserId");
    }
  },

  async getTaskAnalytics(startDate: string, endDate: string) {
    try {
      // Convert dates to ISO strings for proper comparison
      const startDateISO = new Date(startDate).toISOString();
      const endDateISO = new Date(endDate).toISOString();

      // Get all tasks with pagination
      const tasks = await this.scanAllItems(`${TABLE_PREFIX}AW-Tasks`);

      // Get all executions with pagination
      const executions = await this.scanAllItems(`${TABLE_PREFIX}AW-TaskExecutions`);

      // Get all other data with pagination
      const schedules = await this.scanAllItems(`${TABLE_PREFIX}AW-TaskSchedules`);
      const templates = await this.scanAllItems(`${TABLE_PREFIX}AW-TaskTemplates`);
      const configs = await this.scanAllItems(`${TABLE_PREFIX}AW-Configs`);
      const workflows = await this.scanAllItems(`${TABLE_PREFIX}AW-Workflows`);
      const workflowExecutions = await this.scanAllItems(`${TABLE_PREFIX}AW-WorkflowExecutions`);

      // Helper function to check if date is within range
      const isDateInRange = (dateStr: string) => {
        if (!dateStr) return false;
        const date = new Date(dateStr).toISOString();
        return date >= startDateISO && date <= endDateISO;
      };

      const newTasks = tasks.filter((t) => isDateInRange(t.createdAt));
      const newExecutions = executions.filter((e) => isDateInRange(e.startTime));
      const newScheduledTasks = schedules.filter((s) => isDateInRange(s.createdAt));
      const newTemplates = templates.filter((t) => isDateInRange(t.createdAt));
      const newWebsiteConfigs = configs.filter(
        (c) => !c.isApiConfig && isDateInRange(c.createdAt)
      );
      const newApiConfigs = configs.filter(
        (c) => c.isApiConfig === true && isDateInRange(c.createdAt)
      );
      const newWorkflows = workflows.filter((w) => isDateInRange(w.createdAt));
      const newWorkflowExecutions = workflowExecutions.filter((e) => isDateInRange(e.startTime));

      const analytics = {
        totalTasks: tasks.length,
        newTasks: newTasks.length,
        totalExecutions: executions.length,
        successfulExecutions: executions.filter((e) => e.status === "completed").length,
        failedExecutions: executions.filter((e) => e.status === "failed").length,
        newExecutions: newExecutions.length,
        scheduledTasks: schedules.length,
        newScheduledTasks: newScheduledTasks.length,
        templates: templates.length,
        newTemplates: newTemplates.length,
        websiteConfigs: configs.filter((c) => !c.isApiConfig).length,
        newWebsiteConfigs: newWebsiteConfigs.length,
        apiConfigs: configs.filter((c) => c.isApiConfig === true).length,
        newApiConfigs: newApiConfigs.length,
        sharedConfigs: configs.filter((c) => c.sharedBy || c.sharedConfigIds).length,
        totalWorkflows: workflows.length,
        newWorkflows: newWorkflows.length,
        workflowExecutions: workflowExecutions.length,
        newWorkflowExecutions: newWorkflowExecutions.length,
        successfulWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "success" || e.status === "completed"
        ).length,
        failedWorkflowExecutions: workflowExecutions.filter((e) => e.status === "failed").length,
        pendingWorkflowExecutions: workflowExecutions.filter(
          (e) => e.status === "pending" || e.status === "running"
        ).length,
        workflowExecutionStatusBreakdown: Object.entries(
          workflowExecutions.reduce<Record<string, number>>((acc, exec) => {
            acc[exec.status || "unknown"] = (acc[exec.status || "unknown"] || 0) + 1;
            return acc;
          }, {})
        ),
        averageExecutionTime: (() => {
          const completedExecutions = executions.filter((e) => e.status === "completed" && e.completedAt);
          if (completedExecutions.length === 0) return null;
          
          const totalTime = completedExecutions.reduce((acc, e) => {
            return acc + (new Date(e.completedAt!).getTime() - new Date(e.startTime).getTime());
          }, 0);
          
          return totalTime / completedExecutions.length;
        })(),
      };

      return analytics;
    } catch (error) {
      console.error("Error in getTaskAnalytics:", error);
      throw error;
    }
  },

  // Helper function to scan all items with pagination
  async scanAllItems(tableName: string) {
    const items: any[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const params: any = {
        TableName: tableName,
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.scan(params).promise();
      items.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return items;
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

  async updateTaskExecutionOwnership(taskId: string, newOwnerId: string) {
    try {
      // Get all executions for this task
      const executions = await this.getTaskExecutions(taskId);
      
      if (!executions || executions.length === 0) {
        console.log(`No executions found for task ${taskId}`);
        return;
      }
      
      // Update each execution's userId
      const updatePromises = executions.map(async (execution) => {
        const params = {
          TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
          Key: {
            executionId: execution.executionId,
          },
          UpdateExpression: "set userId = :userId",
          ExpressionAttributeValues: {
            ":userId": newOwnerId,
          },
        };

        return dynamodb.update(params).promise();
      });

      await Promise.all(updatePromises);
      console.log(`Updated ownership for ${executions.length} executions of task ${taskId}`);
    } catch (error) {
      console.error('Error updating task execution ownership:', error);
      throw error;
    }
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
      // Check if subscriber already exists
      const existingSubscriber = await this.getTaskSubscriberByEmail(taskId, email);
      
      if (existingSubscriber) {
        // Email already exists - throw error regardless of subscription status
        throw new Error(`Email ${email} is already in the subscriber list for this task`);
      }
      
      // Add new subscriber only if they don't exist at all
      const subscribedAt = new Date().toISOString();
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Item: {
          taskId,
          email,
          subscribedAt,
          unsubscribed: false,
        },
      };

      await dynamodb.put(params).promise();
      return { taskId, email, subscribedAt, unsubscribed: false };
    } catch (error: any) {
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

  async softUnsubscribe(taskId: string, email: string, feedback?: string) {
    try {
      const updateExpression = feedback 
        ? "SET unsubscribed = :unsubscribed, unsubscribedAt = :unsubscribedAt, feedback = :feedback"
        : "SET unsubscribed = :unsubscribed, unsubscribedAt = :unsubscribedAt";
      
      const expressionAttributeValues: any = {
        ":unsubscribed": true,
        ":unsubscribedAt": new Date().toISOString(),
      };
      
      if (feedback) {
        expressionAttributeValues[":feedback"] = feedback;
      }

      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId,
          email,
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "softUnsubscribe");
    }
  },

  async resubscribe(taskId: string, email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId,
          email,
        },
        UpdateExpression: "SET unsubscribed = :unsubscribed, resubscribedAt = :resubscribedAt, feedback = :feedback",
        ExpressionAttributeValues: {
          ":unsubscribed": false,
          ":resubscribedAt": new Date().toISOString(),
          ":feedback": null,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "resubscribe");
    }
  },

  async getTaskSubscribers(taskId: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        KeyConditionExpression: "taskId = :taskId",
        FilterExpression: "attribute_not_exists(unsubscribed) OR unsubscribed = :unsubscribed",
        ExpressionAttributeValues: {
          ":taskId": taskId,
          ":unsubscribed": false,
        },
      };

      const result = await dynamodb.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getTaskSubscribers");
    }
  },

  async getAllTaskSubscribers(taskId: string) {
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
      handleDynamoDbError(error, "getAllTaskSubscribers");
    }
  },

  async getTaskSubscriberByEmail(taskId: string, email: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
      };

      const result = await dynamodb.get(params).promise();
      return result.Item || null;
    } catch (error) {
      handleDynamoDbError(error, "getTaskSubscriberByEmail");
    }
  },

  async updateSubscriberDetails(taskId: string, email: string, feedback: string, customFields: { [key: string]: string }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET feedback = :feedback, customFields = :customFields",
        ExpressionAttributeValues: {
          ":feedback": feedback,
          ":customFields": customFields,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSubscriberDetails");
    }
  },

  async updateSubscriberCustomFields(taskId: string, email: string, customFields: { [key: string]: string }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET customFields = :customFields",
        ExpressionAttributeValues: {
          ":customFields": customFields,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateSubscriberCustomFields");
    }
  },

  async addEmailHistory(taskId: string, email: string, emailHistory: {
    sentAt: string;
    subject: string;
    status: 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed';
    taskExecutionId?: string;
    htmlContentUrl?: string;
    senderType: 'SMTP' | 'resend';
    emailId?: string;
  }) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET emailHistory = list_append(if_not_exists(emailHistory, :empty_list), :newEmail)",
        ExpressionAttributeValues: {
          ":empty_list": [],
          ":newEmail": [emailHistory],
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "addEmailHistory");
    }
  },

  async updateEmailStatus(taskId: string, email: string, emailId: string, status: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed') {
    try {
      // First get the current subscriber record
      const subscribers = await this.getTaskSubscribers(taskId);
      const subscriber = subscribers?.find(sub => sub.email === email);
      if (!subscriber || !subscriber.emailHistory) {
        return null;
      }

      // Update the specific email history entry
      const updatedHistory = subscriber.emailHistory.map((emailHistory: any) => 
        emailHistory.id === emailId ? { ...emailHistory, status } : emailHistory
      );

      const params = {
        TableName: `${TABLE_PREFIX}AW-Subscribers`,
        Key: {
          taskId: taskId,
          email: email,
        },
        UpdateExpression: "SET emailHistory = :updatedHistory",
        ExpressionAttributeValues: {
          ":updatedHistory": updatedHistory,
        },
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateEmailStatus");
    }
  },

  async batchAddSubscribers(taskId: string, subscribers: Array<{ email: string; customFields: { [key: string]: string } }>) {
    try {
      const results = {
        successCount: 0,
        errorCount: 0,
        errors: [] as string[]
      };

      // Deduplicate subscribers by email (case-insensitive)
      const uniqueSubscribers = new Map<string, { email: string; customFields: { [key: string]: string } }>();
      subscribers.forEach((subscriber, index) => {
        const emailLower = subscriber.email.toLowerCase();
        if (uniqueSubscribers.has(emailLower)) {
          results.errorCount++;
          results.errors.push(`Row ${index + 1}: Duplicate email "${subscriber.email}" found in upload data`);
        } else {
          uniqueSubscribers.set(emailLower, subscriber);
        }
      });

      // Get existing subscribers to check for duplicates
      const existingSubscribers = await this.getAllTaskSubscribers(taskId);
      const existingEmails = new Set((existingSubscribers || []).map(sub => sub.email.toLowerCase()));

      // Filter out existing subscribers
      const newSubscribers: Array<{ email: string; customFields: { [key: string]: string } }> = [];
      uniqueSubscribers.forEach((subscriber, emailLower) => {
        if (existingEmails.has(emailLower)) {
          results.errorCount++;
          results.errors.push(`Email "${subscriber.email}" already exists in subscriber list`);
        } else {
          newSubscribers.push(subscriber);
        }
      });

      // Process new subscribers in batches of 25 (DynamoDB batch write limit)
      const batchSize = 25;
      for (let i = 0; i < newSubscribers.length; i += batchSize) {
        const batch = newSubscribers.slice(i, i + batchSize);
        
        const writeRequests = batch.map(subscriber => ({
          PutRequest: {
            Item: {
              taskId: taskId,
              email: subscriber.email,
              subscribedAt: new Date().toISOString(),
              customFields: subscriber.customFields || {}
            }
          }
        }));

        try {
          const params = {
            RequestItems: {
              [`${TABLE_PREFIX}AW-Subscribers`]: writeRequests
            }
          };

          await dynamodb.batchWrite(params).promise();
          results.successCount += batch.length;
        } catch (batchError: any) {
          // Handle individual item errors
          if (batchError.code === 'ValidationException' || batchError.code === 'ConditionalCheckFailedException') {
            batch.forEach((subscriber, index) => {
              results.errorCount++;
              results.errors.push(`Row ${i + index + 1}: ${subscriber.email} - ${batchError.message}`);
            });
          } else {
            // If it's a different error, mark all items in this batch as failed
            batch.forEach((subscriber, index) => {
              results.errorCount++;
              results.errors.push(`Row ${i + index + 1}: ${subscriber.email} - Batch write failed`);
            });
          }
        }
      }

      return results;
    } catch (error: any) {
      handleDynamoDbError(error, "batchAddSubscribers");
      return {
        successCount: 0,
        errorCount: subscribers.length,
        errors: [`Batch upload failed: ${error.message}`]
      };
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

// Benchmark Tests Database
class BenchmarkTestDB {
  private docClient: AWS.DynamoDB.DocumentClient;
  private tableName: string;

  constructor() {
    this.docClient = new AWS.DynamoDB.DocumentClient();
    this.tableName = `${TABLE_PREFIX}AW-BenchmarkTests`;
  }

  async createBenchmarkTest(benchmarkTest: any) {
    const params = {
      TableName: this.tableName,
      Item: {
        ...benchmarkTest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };

    try {
      await this.docClient.put(params).promise();
      return benchmarkTest;
    } catch (error) {
      handleDynamoDbError(error, "createBenchmarkTest");
      throw error;
    }
  }

  async getBenchmarkTest(testId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
    };

    try {
      const result = await this.docClient.get(params).promise();
      return result.Item;
    } catch (error) {
      handleDynamoDbError(error, "getBenchmarkTest");
      throw error;
    }
  }

  async getBenchmarkTestsByCreator(createdBy: string, limit: number = 50) {
    const params = {
      TableName: this.tableName,
      IndexName: "CreatedByIndex",
      KeyConditionExpression: "createdBy = :createdBy",
      ExpressionAttributeValues: {
        ":createdBy": createdBy,
      },
      ScanIndexForward: false, // Sort by createdAt descending
      Limit: limit,
    };

    try {
      const result = await this.docClient.query(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getBenchmarkTestsByCreator");
      throw error;
    }
  }

  async getAllBenchmarkTests(limit: number = 100) {
    const params = {
      TableName: this.tableName,
      Limit: limit,
    };

    try {
      const result = await this.docClient.scan(params).promise();
      return result.Items || [];
    } catch (error) {
      handleDynamoDbError(error, "getAllBenchmarkTests");
      throw error;
    }
  }

  async updateBenchmarkTest(testId: string, updates: any) {
    const updateExpression = [];
    const expressionAttributeNames: any = {};
    const expressionAttributeValues: any = {};

    // Build dynamic update expression
    Object.keys(updates).forEach((key, index) => {
      if (key !== 'testId') { // Don't update the key
        updateExpression.push(`#${key} = :val${index}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:val${index}`] = updates[key];
      }
    });

    updateExpression.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "updateBenchmarkTest");
      throw error;
    }
  }

  async deleteBenchmarkTest(testId: string) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
    };

    try {
      await this.docClient.delete(params).promise();
      return { success: true };
    } catch (error) {
      handleDynamoDbError(error, "deleteBenchmarkTest");
      throw error;
    }
  }

  async incrementRunCount(testId: string, success: boolean) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
      UpdateExpression: 'ADD runCount :inc, #successCount :successInc, #failureCount :failureInc SET #lastRunAt = :lastRunAt, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#successCount': 'successCount',
        '#failureCount': 'failureCount',
        '#lastRunAt': 'lastRunAt',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':inc': 1,
        ':successInc': success ? 1 : 0,
        ':failureInc': success ? 0 : 1,
        ':lastRunAt': new Date().toISOString(),
        ':updatedAt': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "incrementRunCount");
      throw error;
    }
  }

  async addTestResult(testId: string, testResult: any) {
    const params = {
      TableName: this.tableName,
      Key: {
        testId,
      },
      UpdateExpression: 'SET #testHistory = list_append(if_not_exists(#testHistory, :emptyList), :testResult), #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#testHistory': 'testHistory',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':testResult': [testResult],
        ':emptyList': [],
        ':updatedAt': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.update(params).promise();
      return result.Attributes;
    } catch (error) {
      handleDynamoDbError(error, "addTestResult");
      throw error;
    }
  }
}

export const benchmarkTestDb = new BenchmarkTestDB();

