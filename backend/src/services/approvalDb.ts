import AWS from 'aws-sdk';

// Import the configuration from db.ts
const dynamodbConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
};

const dynamodb = new AWS.DynamoDB.DocumentClient(dynamodbConfig);

// Determine environment prefix for table names
import { TABLE_PREFIX } from '../config/constants';
const ASSET_APPROVALS_TABLE = `${TABLE_PREFIX}AW-AssetApprovals`;

export type AssetType = 'image' | 'video' | 'html' | 'text' | 'pdf' | 'other';

/**
 * Determine asset type from filename based on extension
 */
export function getAssetTypeFromFilename(filename: string): AssetType {
  const extension = filename.toLowerCase().split('.').pop() || '';
  
  // Image formats
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(extension)) {
    return 'image';
  }
  
  // Video formats
  if (['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpg', 'mpeg', 'ogv'].includes(extension)) {
    return 'video';
  }
  
  // HTML formats
  if (['html', 'htm'].includes(extension)) {
    return 'html';
  }
  
  // Text formats
  if (['txt', 'json', 'csv', 'xml', 'md', 'js', 'css', 'log', 'yml', 'yaml'].includes(extension)) {
    return 'text';
  }
  
  // PDF format
  if (extension === 'pdf') {
    return 'pdf';
  }
  
  // Default to other
  return 'other';
}

export interface AssetApproval {
  assetUrl: string; // Primary key - the URL of the asset
  filename: string;
  assetType: AssetType;
  executionId?: string; // Optional reference to execution
  userId: string;
  status: 'pending' | 'approved' | 'needs_changes' | 'revision_submitted' | 'rejected';
  slackChannel: string; // Channel ID
  slackChannelName: string; // Channel name (e.g., "approvals")
  slackMessageTs: string | null;
  reviewedBy?: string;
  feedback?: string;
  note?: string; // User-provided note for context
  batchId?: string; // Optional reference to a batch review
  createdAt: string;
  updatedAt: string;
}

export interface CreateApprovalRequest {
  assetUrl: string;
  filename: string;
  assetType: AssetType;
  executionId?: string;
  userId: string;
  slackChannel: string; // Channel ID
  slackChannelName: string; // Channel name
  slackMessageTs: string | null;
  note?: string; // User-provided note for context
  batchId?: string; // Optional reference to a batch review
}

export class ApprovalDB {
  /**
   * Create a new approval request
   */
  async createApproval(request: CreateApprovalRequest): Promise<AssetApproval> {
    const now = new Date().toISOString();

    const approval: AssetApproval = {
      assetUrl: request.assetUrl,
      filename: request.filename,
      assetType: request.assetType,
      executionId: request.executionId,
      userId: request.userId,
      status: 'pending',
      slackChannel: request.slackChannel,
      slackChannelName: request.slackChannelName,
      slackMessageTs: request.slackMessageTs,
      note: request.note,
      ...(request.batchId && { batchId: request.batchId }),
      createdAt: now,
      updatedAt: now,
    };

    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      Item: approval,
    };

    try {
      await dynamodb.put(params).promise();
      console.log(`✅ Created approval request for asset: ${request.assetUrl}`);
      return approval;
    } catch (error) {
      console.error('❌ Error creating approval request:', error);
      throw new Error('Failed to create approval request');
    }
  }

  /**
   * Update approval status (approved/needs_changes/rejected)
   */
  async updateApprovalStatus(
    assetUrl: string,
    status: 'approved' | 'needs_changes' | 'revision_submitted' | 'rejected',
    reviewedBy: string,
    feedback?: string
  ): Promise<AssetApproval | null> {
    const now = new Date().toISOString();

    let updateExpression = 'SET #status = :status, reviewedBy = :reviewedBy, updatedAt = :updatedAt';
    const expressionAttributeNames: any = { '#status': 'status' };
    const expressionAttributeValues: any = {
      ':status': status,
      ':reviewedBy': reviewedBy,
      ':updatedAt': now,
    };

    if (feedback) {
      updateExpression += ', feedback = :feedback';
      expressionAttributeValues[':feedback'] = feedback;
    }

    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      Key: { assetUrl },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW' as const,
    };

    try {
      const result = await dynamodb.update(params).promise();
      console.log(`✅ Updated approval status: ${assetUrl} -> ${status}`);
      return result.Attributes as AssetApproval;
    } catch (error) {
      console.error('❌ Error updating approval status:', error);
      throw new Error('Failed to update approval status');
    }
  }

  /**
   * Get approval by asset URL
   */
  /**
   * Record a verdict only if the approval is still open, atomically (ENG-273).
   *
   * `updateApprovalStatus` is an unconditional SET: it will overwrite any status, and it
   * upserts — a row that does not exist is created as a stub holding only the verdict.
   * That is tolerable behind Slack, where answering strips the buttons so nothing is left
   * to click. WhatsApp cannot remove buttons: every tap, however late, arrives as a fresh
   * message, and the customer may also have answered on another surface. So the check and
   * the write have to be one operation, or two taps (or a tap and a portal click) can
   * each pass a separate check and both write.
   *
   * "Open" is pending or needs_changes — Slack deliberately keeps its buttons live after
   * "Request changes" so a reviewer can still approve later, and that transition is
   * legitimate. Anything else (approved, rejected, revision_submitted) is final here.
   *
   * Never creates a row: a verdict for an approval that does not exist is refused.
   */
  async answerIfOpen(
    assetUrl: string,
    status: 'approved' | 'rejected',
    reviewedBy: string,
    /** When given, the record must belong to this user (a stale button must not answer
     * someone else's approval for the same asset URL). */
    ownerUserId?: string,
  ): Promise<
    | { answered: true; approval: AssetApproval }
    | { answered: false; current: AssetApproval['status'] | null | 'unknown' }
  > {
    try {
      const result = await dynamodb
        .update({
          TableName: ASSET_APPROVALS_TABLE,
          Key: { assetUrl },
          UpdateExpression: 'SET #status = :status, reviewedBy = :reviewedBy, updatedAt = :updatedAt',
          ConditionExpression:
            'attribute_exists(assetUrl) AND (#status = :pending OR #status = :needsChanges)' +
            (ownerUserId ? ' AND userId = :owner' : ''),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ':reviewedBy': reviewedBy,
            ':updatedAt': new Date().toISOString(),
            ':pending': 'pending',
            ':needsChanges': 'needs_changes',
            ...(ownerUserId ? { ':owner': ownerUserId } : {}),
          },
          ReturnValues: 'ALL_NEW',
        })
        .promise();
      return { answered: true, approval: result.Attributes as AssetApproval };
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') {
        // Report what stands, so the caller can say it rather than guess. A failed read is
        // 'unknown', NOT null: null means the approval does not exist, and telling someone
        // their request is gone because a read blipped would be wrong.
        try {
          const existing = await this.getApproval(assetUrl);
          return { answered: false, current: existing?.status ?? null };
        } catch {
          return { answered: false, current: 'unknown' };
        }
      }
      console.error('❌ Error answering approval:', error);
      throw new Error('Failed to answer approval');
    }
  }

  async getApproval(assetUrl: string): Promise<AssetApproval | null> {
    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      Key: { assetUrl },
    };

    try {
      const result = await dynamodb.get(params).promise();
      return (result.Item as AssetApproval) || null;
    } catch (error) {
      console.error('❌ Error getting approval:', error);
      throw new Error('Failed to get approval');
    }
  }

  /**
   * Get multiple approvals by asset URLs
   */
  async getApprovalsByAssetUrls(assetUrls: string[]): Promise<AssetApproval[]> {
    if (assetUrls.length === 0) return [];

    // DynamoDB batchGet has a limit of 100 items per request, but let's use 25 to be safe
    const BATCH_SIZE = 25;
    const results: AssetApproval[] = [];

    for (let i = 0; i < assetUrls.length; i += BATCH_SIZE) {
      const batch = assetUrls.slice(i, i + BATCH_SIZE);
      
      const params = {
        RequestItems: {
          [ASSET_APPROVALS_TABLE]: {
            Keys: batch.map(assetUrl => ({ assetUrl }))
          }
        }
      };

      try {
        const result = await dynamodb.batchGet(params).promise();
        const batchResults = (result.Responses?.[ASSET_APPROVALS_TABLE] as AssetApproval[]) || [];
        results.push(...batchResults);
      } catch (error) {
        console.error('❌ Error getting approvals by asset URLs:', {
          error: (error as any).message,
          code: (error as any).code,
          statusCode: (error as any).statusCode,
          tableName: ASSET_APPROVALS_TABLE,
          region: process.env.AWS_REGION
        });
        throw new Error(`Failed to get approvals by asset URLs: ${(error as any).message}`);
      }
    }

    return results;
  }

  /**
   * Get approvals by user ID
   */
  async getApprovalsByUserId(userId: string, limit?: number): Promise<AssetApproval[]> {
    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      IndexName: 'UserApprovalsIndex',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ScanIndexForward: false, // Sort by createdAt in descending order (newest first)
      ...(limit && { Limit: limit }),
    };

    const items: AssetApproval[] = [];
    let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    try {
      do {
        const result = await dynamodb.query({
          ...params,
          ...(limit && { Limit: limit - items.length }),
          ...(startKey && { ExclusiveStartKey: startKey }),
        }).promise();
        items.push(...((result.Items as AssetApproval[]) || []));
        startKey = result.LastEvaluatedKey;
      } while (startKey && (!limit || items.length < limit));
      return limit ? items.slice(0, limit) : items;
    } catch (error) {
      console.error('❌ Error getting approvals by user ID:', error);
      throw new Error('Failed to get approvals by user ID');
    }
  }

  /**
   * Every PENDING approval of a user, following the index to the end. Filter in
   * DynamoDB rather than loading approvals of every status into memory.
   */
  async getPendingApprovalsByUserId(userId: string): Promise<AssetApproval[]> {
    const items: AssetApproval[] = [];
    let startKey: Record<string, any> | undefined;
    try {
      do {
        const result = await dynamodb
          .query({
            TableName: ASSET_APPROVALS_TABLE,
            IndexName: 'UserApprovalsIndex',
            KeyConditionExpression: 'userId = :userId',
            FilterExpression: '#status = :pending',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':userId': userId, ':pending': 'pending' },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          })
          .promise();
        items.push(...((result.Items as AssetApproval[]) || []));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    } catch (error) {
      console.error('❌ Error getting pending approvals by user ID:', error);
      throw new Error('Failed to get pending approvals by user ID');
    }
  }

  /**
   * Get approvals by status
   */
  async getApprovalsByStatus(status: 'pending' | 'approved' | 'needs_changes', limit?: number): Promise<AssetApproval[]> {
    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': status,
      },
      ScanIndexForward: false, // Sort by createdAt in descending order (newest first)
      ...(limit && { Limit: limit }),
    };

    try {
      const result = await dynamodb.query(params).promise();
      return (result.Items as AssetApproval[]) || [];
    } catch (error) {
      console.error('❌ Error getting approvals by status:', error);
      throw new Error('Failed to get approvals by status');
    }
  }

  /**
   * Get approvals by asset type
   */
  async getApprovalsByAssetType(assetType: AssetType, limit?: number): Promise<AssetApproval[]> {
    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      IndexName: 'AssetTypeIndex',
      KeyConditionExpression: 'assetType = :assetType',
      ExpressionAttributeValues: {
        ':assetType': assetType,
      },
      ScanIndexForward: false, // Sort by createdAt in descending order (newest first)
      ...(limit && { Limit: limit }),
    };

    try {
      const result = await dynamodb.query(params).promise();
      return (result.Items as AssetApproval[]) || [];
    } catch (error) {
      console.error('❌ Error getting approvals by asset type:', error);
      throw new Error('Failed to get approvals by asset type');
    }
  }

  /**
   * Put a previously read approval back exactly as it was. Used when a re-request replaced a
   * record and then reached nobody: the earlier verdict must survive, not be deleted.
   */
  async restoreApproval(approval: AssetApproval, replacingCreatedAt: string): Promise<void> {
    try {
      // Only over the record WE wrote, and only while it is still unanswered: a newer
      // concurrent re-request, or a customer's tap on our buttons, must not be reverted by
      // a failed older request.
      await dynamodb
        .put({
          TableName: ASSET_APPROVALS_TABLE,
          Item: approval,
          ConditionExpression:
            'attribute_not_exists(assetUrl) OR (createdAt = :ours AND #status = :pending)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':ours': replacingCreatedAt, ':pending': 'pending' },
        })
        .promise();
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return;
      console.error('❌ Error restoring approval:', error);
      throw new Error('Failed to restore approval');
    }
  }

  /**
   * Delete a record only if it is still the one this request wrote and is unanswered.
   * Used to undo an unsent approval without deleting a concurrent request's record.
   */
  async deleteApprovalIfUnanswered(assetUrl: string, createdAt: string): Promise<void> {
    try {
      await dynamodb
        .delete({
          TableName: ASSET_APPROVALS_TABLE,
          Key: { assetUrl },
          ConditionExpression: 'createdAt = :ours AND #status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':ours': createdAt, ':pending': 'pending' },
        })
        .promise();
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return;
      console.error('❌ Error deleting unsent approval:', error);
      throw new Error('Failed to delete approval');
    }
  }

  /**
   * Delete approval request
   */
  async deleteApproval(assetUrl: string): Promise<boolean> {
    const params = {
      TableName: ASSET_APPROVALS_TABLE,
      Key: { assetUrl },
    };

    try {
      await dynamodb.delete(params).promise();
      console.log(`✅ Deleted approval: ${assetUrl}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting approval:', error);
      throw new Error('Failed to delete approval');
    }
  }
}

// Export a singleton instance
export const approvalDb = new ApprovalDB();