import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

export interface HtmlTemplate {
  templateId: string;
  userId: string;
  type: ("email" | "landing_page")[];
  name: string;
  subject?: string;
  html: string;
  isPublic?: "true";
  createdAt: string;
  updatedAt: string;
}

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE = `${TABLE_PREFIX}AW-HtmlTemplates`;
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

export const htmlTemplateService = {
  async createTemplate(input: Omit<HtmlTemplate, "templateId" | "createdAt" | "updatedAt">): Promise<HtmlTemplate> {
    const now = new Date().toISOString();
    const tpl: HtmlTemplate = { ...input, templateId: uuidv4(), createdAt: now, updatedAt: now };
    await dynamodb.put({ TableName: TABLE, Item: tpl }).promise();
    return tpl;
  },

  async getTemplate(templateId: string): Promise<HtmlTemplate | null> {
    const r = await dynamodb.get({ TableName: TABLE, Key: { templateId } }).promise();
    return (r.Item as HtmlTemplate) || null;
  },

  async getTemplatesByOwner(userId: string): Promise<HtmlTemplate[]> {
    const r = await dynamodb.query({
      TableName: TABLE,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
    }).promise();
    return (r.Items as HtmlTemplate[]) || [];
  },

  async getPublicTemplates(): Promise<HtmlTemplate[]> {
    const r = await dynamodb.query({
      TableName: TABLE,
      IndexName: "IsPublicIndex",
      KeyConditionExpression: "isPublic = :v",
      ExpressionAttributeValues: { ":v": "true" },
    }).promise();
    return (r.Items as HtmlTemplate[]) || [];
  },

  async updateTemplate(
    templateId: string,
    fields: Partial<Omit<HtmlTemplate, "templateId" | "userId" | "createdAt">>,
  ): Promise<HtmlTemplate | null> {
    const existing = await this.getTemplate(templateId);
    if (!existing) return null;
    const next: HtmlTemplate = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    await dynamodb.put({ TableName: TABLE, Item: next }).promise();
    return next;
  },

  async deleteTemplate(templateId: string): Promise<void> {
    await dynamodb.delete({ TableName: TABLE, Key: { templateId } }).promise();
  },

  /**
   * Transfer ownership of an HTML template to a new user (used when removing a member from an org).
   */
  async transferOwner(templateId: string, newOwnerId: string): Promise<void> {
    await dynamodb.update({
      TableName: TABLE,
      Key: { templateId },
      UpdateExpression: "SET userId = :newOwner, updatedAt = :now",
      ExpressionAttributeValues: {
        ":newOwner": newOwnerId,
        ":now": new Date().toISOString(),
      },
    }).promise();
  },
};
