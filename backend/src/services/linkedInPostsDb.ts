import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const LINKEDIN_POSTS_TABLE = `${TABLE_PREFIX}AW-ConnectedAccountPosts`;

const dynamodb = new AWS.DynamoDB.DocumentClient();

/**
 * LinkedIn Post stored in database
 */
export interface PostMetricsCache {
    impressionCount: number;
    likeCount: number;
    commentCount: number;
    shareCount: number;
    clickCount: number;
    engagement: number;
}

export interface LinkedInPost {
    userId: string;           // Partition key
    postId: string;          // Sort key (e.g., "urn:li:share:123")
    accountId: string;        // Account URN (e.g., "urn:li:person:456")
    content: string;          // Post text content
    mediaUrls?: string[];     // Optional image URLs
    createdAt: string;        // ISO timestamp
    metrics?: PostMetricsCache;
    metricsFetchedAt?: string; // ISO timestamp of last metrics fetch
}

/**
 * Helper function to handle DynamoDB errors
 */
function handleDbError(operation: string, error: any): void {
    console.error(`[LinkedInPostsDb] ${operation} error:`, error);
    throw error;
}

/**
 * Store a LinkedIn post in the database (personal accounts only)
 */
export async function createPost(
    userId: string,
    accountId: string,
    postId: string,
    content: string,
    mediaUrls?: string[]
): Promise<LinkedInPost> {
    try {
        const now = new Date().toISOString();

        const post: LinkedInPost = {
            userId,
            postId,
            accountId,
            content,
            mediaUrls,
            createdAt: now,
        };

        await dynamodb.put({
            TableName: LINKEDIN_POSTS_TABLE,
            Item: post,
        }).promise();

        return post;
    } catch (error) {
        handleDbError('createPost', error);
        throw error;
    }
}

/**
 * Get posts for a specific LinkedIn account, sorted by timestamp (newest first)
 * Uses the AccountPostsIndex GSI for efficient querying.
 */
export async function getPostsByAccount(
    accountId: string,
    limit: number = 10
): Promise<LinkedInPost[]> {
    try {
        const params: AWS.DynamoDB.DocumentClient.QueryInput = {
            TableName: LINKEDIN_POSTS_TABLE,
            IndexName: 'AccountPostsIndex',
            KeyConditionExpression: 'accountId = :accountId',
            ExpressionAttributeValues: {
                ':accountId': accountId,
            },
            ScanIndexForward: false, // Sort by createdAt descending (newest first)
            Limit: limit,
        };

        const result = await dynamodb.query(params).promise();
        return (result.Items || []) as LinkedInPost[];
    } catch (error) {
        handleDbError('getPostsByAccount', error);
        return [];
    }
}

/**
 * Get a single post by primary key (userId + postId). O(1) lookup.
 */
export async function getPostById(userId: string, postId: string): Promise<LinkedInPost | null> {
    try {
        const result = await dynamodb.get({
            TableName: LINKEDIN_POSTS_TABLE,
            Key: { userId, postId },
        }).promise();
        return (result.Item as LinkedInPost) || null;
    } catch (error) {
        handleDbError('getPostById', error);
        return null;
    }
}

/**
 * Get posts for a specific user, sorted by timestamp (newest first)
 * Uses the primary key (userId) for efficient querying.
 */
export async function getPostsByUserId(
    userId: string,
    limit: number = 100
): Promise<LinkedInPost[]> {
    try {
        const params: AWS.DynamoDB.DocumentClient.QueryInput = {
            TableName: LINKEDIN_POSTS_TABLE,
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: {
                ':userId': userId,
            },
            ScanIndexForward: false,
            Limit: limit,
        };

        const result = await dynamodb.query(params).promise();
        return (result.Items || []) as LinkedInPost[];
    } catch (error) {
        handleDbError('getPostsByUserId', error);
        return [];
    }
}

/**
 * Update cached metrics for a stored post.
 * Called by the LinkedIn adapter after fetching fresh metrics from the API.
 */
export async function updatePostMetrics(
    userId: string,
    postId: string,
    metrics: PostMetricsCache
): Promise<void> {
    try {
        await dynamodb.update({
            TableName: LINKEDIN_POSTS_TABLE,
            Key: { userId, postId },
            UpdateExpression: 'SET #metrics = :m, metricsFetchedAt = :ts',
            ExpressionAttributeNames: {
                '#metrics': 'metrics',
            },
            ExpressionAttributeValues: {
                ':m': metrics,
                ':ts': new Date().toISOString(),
            },
        }).promise();
    } catch (error) {
        handleDbError('updatePostMetrics', error);
    }
}

/**
 * Get a specific post by ID
 */
export async function getPostByUrn(
    userId: string,
    postId: string
): Promise<LinkedInPost | null> {
    try {
        const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
            TableName: LINKEDIN_POSTS_TABLE,
            Key: {
                userId,
                postId,
            },
        };

        const result = await dynamodb.get(params).promise();
        return (result.Item as LinkedInPost) || null;
    } catch (error) {
        handleDbError('getPostByUrn', error);
        return null;
    }
}