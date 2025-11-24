import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Configure AWS SDK
const dynamodb = new AWS.DynamoDB.DocumentClient();

export interface BookAttachment {
  url: string;
  key: string;
  filename: string;
  type: string;
  uploadedAt: string;
}

export interface Chapter {
  chapterId: string;
  title: string;
  description?: string;
  order: number;
  content?: string; // Optional: populated from AW-BookContents table when fetching
}

export interface Section {
  sectionId: string;
  title: string;
  description?: string;
  order: number;
  content?: string; // Optional: populated from AW-BookContents table when fetching
  chapters: Chapter[];
}

export interface Book {
  bookId: string;
  userId: string;
  title: string;
  description: string;
  content: string; // Keep for backward compatibility
  type: "book" | "whitepaper";
  author: string;
  coverImageUrl?: string;
  attachments?: BookAttachment[];
  tags?: string[];
  sections?: Section[]; // New hierarchical structure
  status: "draft" | "published" | "archived";
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

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

export const bookDb = {
  async createBook(book: Omit<Book, "bookId" | "createdAt" | "updatedAt">): Promise<Book> {
    try {
      const bookId = uuidv4();
      const now = new Date().toISOString();
      
      const newBook: Book = {
        ...book,
        bookId,
        createdAt: now,
        updatedAt: now,
      };

      const params = {
        TableName: `${TABLE_PREFIX}AW-Books`,
        Item: newBook,
      };

      await dynamodb.put(params).promise();
      return newBook;
    } catch (error) {
      handleDynamoDbError(error, "createBook");
      throw error;
    }
  },

  async getBookById(bookId: string, userId: string): Promise<Book | null> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Books`,
        Key: {
          bookId,
          userId,
        },
      };

      const result = await dynamodb.get(params).promise();
      return (result.Item as Book) || null;
    } catch (error) {
      handleDynamoDbError(error, "getBookById");
      throw error;
    }
  },

  async getBooksByUser(
    userId: string,
    filters?: {
      type?: "book" | "whitepaper";
      status?: "draft" | "published" | "archived";
    }
  ): Promise<Book[]> {
    try {
      // Use scan with filter since userId is not the partition key
      const params: AWS.DynamoDB.DocumentClient.ScanInput = {
        TableName: `${TABLE_PREFIX}AW-Books`,
        FilterExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      };

      // Add additional filters if provided
      if (filters?.type || filters?.status) {
        const filterExpressions: string[] = ["userId = :userId"];
        const expressionAttributeNames: { [key: string]: string } = {};

        if (filters.type) {
          filterExpressions.push("#type = :type");
          expressionAttributeNames["#type"] = "type";
          params.ExpressionAttributeValues![":type"] = filters.type;
        }

        if (filters.status) {
          filterExpressions.push("#status = :status");
          expressionAttributeNames["#status"] = "status";
          params.ExpressionAttributeValues![":status"] = filters.status;
        }

        params.FilterExpression = filterExpressions.join(" AND ");
        params.ExpressionAttributeNames = expressionAttributeNames;
      }

      let allItems: Book[] = [];
      let lastEvaluatedKey: any = undefined;

      do {
        const result = await dynamodb
          .scan({
            ...params,
            ExclusiveStartKey: lastEvaluatedKey,
          })
          .promise();

        if (result.Items) {
          allItems = allItems.concat(result.Items as Book[]);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getBooksByUser");
      throw error;
    }
  },

  async updateBook(
    bookId: string,
    userId: string,
    updates: Partial<Omit<Book, "bookId" | "userId" | "createdAt">>
  ): Promise<Book | null> {
    try {
      // First check if book exists and belongs to user
      const existingBook = await this.getBookById(bookId, userId);
      if (!existingBook) {
        return null;
      }

      // Build update expression
      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      Object.keys(updates).forEach((key) => {
        if (key !== "bookId" && key !== "userId" && key !== "createdAt") {
          const attributeName = `#${key}`;
          const attributeValue = `:${key}`;
          updateExpressions.push(`${attributeName} = ${attributeValue}`);
          expressionAttributeNames[attributeName] = key;
          expressionAttributeValues[attributeValue] = updates[key as keyof typeof updates];
        }
      });

      // Always update updatedAt
      updateExpressions.push("#updatedAt = :updatedAt");
      expressionAttributeNames["#updatedAt"] = "updatedAt";
      expressionAttributeValues[":updatedAt"] = new Date().toISOString();

      const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: `${TABLE_PREFIX}AW-Books`,
        Key: {
          bookId,
          userId,
        },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      };

      const result = await dynamodb.update(params).promise();
      return (result.Attributes as Book) || null;
    } catch (error) {
      handleDynamoDbError(error, "updateBook");
      throw error;
    }
  },

  async deleteBook(bookId: string, userId: string): Promise<boolean> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Books`,
        Key: {
          bookId,
          userId,
        },
      };

      await dynamodb.delete(params).promise();
      return true;
    } catch (error) {
      handleDynamoDbError(error, "deleteBook");
      throw error;
    }
  },

  async publishBook(bookId: string, userId: string, publish: boolean): Promise<Book | null> {
    try {
      const updates: Partial<Book> = {
        status: publish ? "published" : "draft",
      };

      if (publish) {
        updates.publishedAt = new Date().toISOString();
      }

      return await this.updateBook(bookId, userId, updates);
    } catch (error) {
      handleDynamoDbError(error, "publishBook");
      throw error;
    }
  },
};

