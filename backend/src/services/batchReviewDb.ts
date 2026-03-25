import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

const dynamodbConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
};

const dynamodb = new AWS.DynamoDB.DocumentClient(dynamodbConfig);

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const BATCH_REVIEWS_TABLE = `${TABLE_PREFIX}AW-BatchReviews`;

export interface BatchReviewAsset {
  assetUrl: string;
  filename: string;
  assetType: string;
  executionId?: string;
}

export interface BatchReview {
  batchId: string;
  userId: string;
  status: 'pending' | 'partial' | 'completed';
  slackChannel: string;
  slackChannelName: string;
  slackMessageTs: string | null;
  note?: string;
  assets: BatchReviewAsset[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBatchReviewRequest {
  userId: string;
  slackChannel: string;
  slackChannelName: string;
  note?: string;
  assets: BatchReviewAsset[];
}

export class BatchReviewDB {
  async createBatchReview(request: CreateBatchReviewRequest): Promise<BatchReview> {
    const now = new Date().toISOString();
    const batchReview: BatchReview = {
      batchId: uuidv4(),
      userId: request.userId,
      status: 'pending',
      slackChannel: request.slackChannel,
      slackChannelName: request.slackChannelName,
      slackMessageTs: null,
      note: request.note,
      assets: request.assets,
      createdAt: now,
      updatedAt: now,
    };

    await dynamodb.put({
      TableName: BATCH_REVIEWS_TABLE,
      Item: batchReview,
    }).promise();

    console.log(`Created batch review: ${batchReview.batchId} with ${request.assets.length} assets`);
    return batchReview;
  }

  async getBatchReview(batchId: string): Promise<BatchReview | null> {
    const result = await dynamodb.get({
      TableName: BATCH_REVIEWS_TABLE,
      Key: { batchId },
    }).promise();

    return (result.Item as BatchReview) || null;
  }

  async updateSlackMessageTs(batchId: string, slackMessageTs: string): Promise<void> {
    await dynamodb.update({
      TableName: BATCH_REVIEWS_TABLE,
      Key: { batchId },
      UpdateExpression: 'SET slackMessageTs = :ts, updatedAt = :now',
      ExpressionAttributeValues: {
        ':ts': slackMessageTs,
        ':now': new Date().toISOString(),
      },
    }).promise();
  }

  async updateBatchStatus(batchId: string, status: 'pending' | 'partial' | 'completed'): Promise<void> {
    await dynamodb.update({
      TableName: BATCH_REVIEWS_TABLE,
      Key: { batchId },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': new Date().toISOString(),
      },
    }).promise();
  }

  async addAssetToBatch(batchId: string, asset: BatchReviewAsset): Promise<void> {
    await dynamodb.update({
      TableName: BATCH_REVIEWS_TABLE,
      Key: { batchId },
      UpdateExpression: 'SET assets = list_append(assets, :newAsset), #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':newAsset': [asset],
        ':status': 'partial',
        ':now': new Date().toISOString(),
      },
    }).promise();
    console.log(`Added revised asset to batch ${batchId}: ${asset.filename}`);
  }

  async getBatchReviewsByUserId(userId: string, limit?: number): Promise<BatchReview[]> {
    const result = await dynamodb.query({
      TableName: BATCH_REVIEWS_TABLE,
      IndexName: 'UserBatchIndex',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      ScanIndexForward: false,
      ...(limit && { Limit: limit }),
    }).promise();

    return (result.Items as BatchReview[]) || [];
  }
}

export const batchReviewDb = new BatchReviewDB();
