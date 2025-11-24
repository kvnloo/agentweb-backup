import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Configure AWS SDK
const dynamodb = new AWS.DynamoDB.DocumentClient();

export interface BookContent {
  contentId: string;
  bookId: string;
  userId: string;
  sectionId?: string; // If null, it's a section content; if set, it's a chapter content
  chapterId?: string; // Only set if this is chapter content
  content: string; // Markdown content
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

export const bookContentDb = {
  async createOrUpdateContent(
    bookId: string,
    userId: string,
    contentData: {
      sectionId?: string;
      chapterId?: string;
      content: string;
    }
  ): Promise<BookContent> {
    try {
      // Check if content already exists
      const existing = await this.getContent(bookId, userId, contentData.sectionId, contentData.chapterId);
      
      const now = new Date().toISOString();
      
      if (existing) {
        // Update existing content
        const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
          TableName: `${TABLE_PREFIX}AW-BookContents`,
          Key: {
            contentId: existing.contentId,
            bookId,
          },
          UpdateExpression: "SET #content = :content, #updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#content": "content",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":content": contentData.content,
            ":updatedAt": now,
          },
          ReturnValues: "ALL_NEW",
        };

        const result = await dynamodb.update(params).promise();
        return result.Attributes as BookContent;
      } else {
        // Create new content
        const contentId = uuidv4();
        const newContent: BookContent = {
          contentId,
          bookId,
          userId,
          sectionId: contentData.sectionId,
          chapterId: contentData.chapterId,
          content: contentData.content,
          createdAt: now,
          updatedAt: now,
        };

        const params = {
          TableName: `${TABLE_PREFIX}AW-BookContents`,
          Item: newContent,
        };

        await dynamodb.put(params).promise();
        return newContent;
      }
    } catch (error) {
      handleDynamoDbError(error, "createOrUpdateContent");
      throw error;
    }
  },

  async getContent(
    bookId: string,
    userId: string,
    sectionId?: string,
    chapterId?: string
  ): Promise<BookContent | null> {
    try {
      // Use scan to find content by bookId, userId, sectionId, and chapterId
      const params: AWS.DynamoDB.DocumentClient.ScanInput = {
        TableName: `${TABLE_PREFIX}AW-BookContents`,
        FilterExpression: "bookId = :bookId AND userId = :userId",
        ExpressionAttributeValues: {
          ":bookId": bookId,
          ":userId": userId,
        },
      };

      // Add sectionId filter if provided
      if (sectionId !== undefined) {
        if (chapterId !== undefined) {
          // Looking for chapter content
          params.FilterExpression += " AND sectionId = :sectionId AND chapterId = :chapterId";
          params.ExpressionAttributeValues![":sectionId"] = sectionId;
          params.ExpressionAttributeValues![":chapterId"] = chapterId;
        } else {
          // Looking for section content (chapterId should be null/undefined)
          params.FilterExpression += " AND sectionId = :sectionId AND attribute_not_exists(chapterId)";
          params.ExpressionAttributeValues![":sectionId"] = sectionId;
        }
      } else {
        // Looking for content with no sectionId (shouldn't happen, but handle it)
        params.FilterExpression += " AND attribute_not_exists(sectionId)";
      }

      const result = await dynamodb.scan(params).promise();
      return (result.Items && result.Items.length > 0 ? (result.Items[0] as BookContent) : null);
    } catch (error) {
      handleDynamoDbError(error, "getContent");
      throw error;
    }
  },

  async getAllBookContents(bookId: string, userId: string): Promise<BookContent[]> {
    try {
      const params: AWS.DynamoDB.DocumentClient.ScanInput = {
        TableName: `${TABLE_PREFIX}AW-BookContents`,
        FilterExpression: "bookId = :bookId AND userId = :userId",
        ExpressionAttributeValues: {
          ":bookId": bookId,
          ":userId": userId,
        },
      };

      let allItems: BookContent[] = [];
      let lastEvaluatedKey: any = undefined;

      do {
        const result = await dynamodb
          .scan({
            ...params,
            ExclusiveStartKey: lastEvaluatedKey,
          })
          .promise();

        if (result.Items) {
          allItems = allItems.concat(result.Items as BookContent[]);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return allItems;
    } catch (error) {
      handleDynamoDbError(error, "getAllBookContents");
      throw error;
    }
  },

  async deleteContent(
    bookId: string,
    userId: string,
    sectionId?: string,
    chapterId?: string
  ): Promise<boolean> {
    try {
      const content = await this.getContent(bookId, userId, sectionId, chapterId);
      if (!content) {
        return false;
      }

      const params = {
        TableName: `${TABLE_PREFIX}AW-BookContents`,
        Key: {
          contentId: content.contentId,
          bookId,
        },
      };

      await dynamodb.delete(params).promise();
      return true;
    } catch (error) {
      handleDynamoDbError(error, "deleteContent");
      throw error;
    }
  },

  async deleteAllBookContents(bookId: string, userId: string): Promise<boolean> {
    try {
      const contents = await this.getAllBookContents(bookId, userId);
      
      const deletePromises = contents.map((content) =>
        dynamodb
          .delete({
            TableName: `${TABLE_PREFIX}AW-BookContents`,
            Key: {
              contentId: content.contentId,
              bookId,
            },
          })
          .promise()
      );

      await Promise.all(deletePromises);
      return true;
    } catch (error) {
      handleDynamoDbError(error, "deleteAllBookContents");
      throw error;
    }
  },
};

