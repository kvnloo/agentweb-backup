import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-ImageReports`;

export interface ImageReportImage {
  url: string;
  filename: string;
  executionId: string;
  taskId?: string;
  source?: 'task' | 'agent-mode';
  sessionId?: string;
}

export interface ImageReport {
  reportId: string;
  userId: string;
  title: string;
  reportType: 'ad-copy' | 'social-media-captions' | 'brand-consistency' | 'custom';
  customInstruction?: string;
  images: ImageReportImage[];
  htmlUrl: string;
  status: 'generating' | 'ready' | 'error';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImageReportInput {
  userId: string;
  title: string;
  reportType: ImageReport['reportType'];
  customInstruction?: string;
  images: ImageReportImage[];
  htmlUrl: string;
}

class ImageReportDB {
  async createReport(input: CreateImageReportInput): Promise<ImageReport> {
    const now = new Date().toISOString();
    const report: ImageReport = {
      reportId: uuidv4(),
      userId: input.userId,
      title: input.title,
      reportType: input.reportType,
      customInstruction: input.customInstruction,
      images: input.images,
      htmlUrl: input.htmlUrl,
      status: 'generating',
      createdAt: now,
      updatedAt: now,
    };

    await dynamodb.put({ TableName: TABLE, Item: report }).promise();
    return report;
  }

  async updateReport(
    reportId: string,
    updates: Partial<Pick<ImageReport, 'htmlUrl' | 'status' | 'errorMessage'>>
  ): Promise<void> {
    const setClauses: string[] = ['updatedAt = :now'];
    const values: Record<string, any> = { ':now': new Date().toISOString() };

    if (updates.htmlUrl !== undefined) {
      setClauses.push('htmlUrl = :htmlUrl');
      values[':htmlUrl'] = updates.htmlUrl;
    }
    if (updates.status !== undefined) {
      setClauses.push('#status = :status');
      values[':status'] = updates.status;
    }
    if (updates.errorMessage !== undefined) {
      setClauses.push('errorMessage = :errorMessage');
      values[':errorMessage'] = updates.errorMessage;
    }

    await dynamodb
      .update({
        TableName: TABLE,
        Key: { reportId },
        UpdateExpression: `SET ${setClauses.join(', ')}`,
        ExpressionAttributeNames: updates.status !== undefined ? { '#status': 'status' } : undefined,
        ExpressionAttributeValues: values,
      })
      .promise();
  }

  async getReport(reportId: string): Promise<ImageReport | null> {
    const result = await dynamodb
      .get({ TableName: TABLE, Key: { reportId } })
      .promise();
    return (result.Item as ImageReport) || null;
  }

  async getReportsByUser(userId: string, limit = 50): Promise<ImageReport[]> {
    const result = await dynamodb
      .query({
        TableName: TABLE,
        IndexName: 'UserIdCreatedAtIndex',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false,
        Limit: limit,
      })
      .promise();
    return (result.Items as ImageReport[]) || [];
  }

  async deleteReport(reportId: string): Promise<void> {
    await dynamodb.delete({ TableName: TABLE, Key: { reportId } }).promise();
  }
}

export const imageReportDb = new ImageReportDB();
