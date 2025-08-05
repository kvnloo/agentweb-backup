import AWS from 'aws-sdk';

// Import the configuration from db.ts
const dynamodbConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
};

const dynamodb = new AWS.DynamoDB.DocumentClient(dynamodbConfig);

// Determine environment prefix for table names
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
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
  status: 'pending' | 'approved' | 'needs_changes' | 'revision_submitted';
  slackChannel: string; // Channel ID
  slackChannelName: string; // Channel name (e.g., "approvals")
  slackMessageTs: string | null;
  reviewedBy?: string;
  feedback?: string;
  note?: string; // User-provided note for context
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
   * Update approval status (approved/needs_changes)
   */
  async updateApprovalStatus(
    assetUrl: string,
    status: 'approved' | 'needs_changes' | 'revision_submitted',
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

    const params = {
      RequestItems: {
        [ASSET_APPROVALS_TABLE]: {
          Keys: assetUrls.map(assetUrl => ({ assetUrl }))
        }
      }
    };

    try {
      const result = await dynamodb.batchGet(params).promise();
      return (result.Responses?.[ASSET_APPROVALS_TABLE] as AssetApproval[]) || [];
    } catch (error) {
      console.error('❌ Error getting approvals by asset URLs:', error);
      throw new Error('Failed to get approvals by asset URLs');
    }
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

    try {
      const result = await dynamodb.query(params).promise();
      return (result.Items as AssetApproval[]) || [];
    } catch (error) {
      console.error('❌ Error getting approvals by user ID:', error);
      throw new Error('Failed to get approvals by user ID');
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