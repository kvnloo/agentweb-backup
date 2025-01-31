import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { DynamoDB } from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

const router = Router();
const dynamodb = new DynamoDB.DocumentClient();

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

// Function to encrypt password
function encryptPassword(password: string, userId: string): string {
  return jwt.sign({ password, userId }, process.env.JWT_SECRET!);
}

// Get user's saved configurations
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const result = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }).promise();

    res.json(result.Items || []);
  } catch (error) {
    console.error('Error fetching configs:', error);
    res.status(500).json({ error: 'Failed to fetch configurations' });
  }
});

// Add a new configuration
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { website, username, password } = req.body;

    if (!website || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const configId = uuidv4();
    const config = {
      configId,
      userId,
      website,
      username,
      password: encryptPassword(password, userId),
      createdAt: new Date().toISOString()
    };

    await dynamodb.put({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      Item: config
    }).promise();

    res.status(201).json({ configId });
  } catch (error) {
    console.error('Error creating config:', error);
    res.status(500).json({ error: 'Failed to create configuration' });
  }
});

// Delete a configuration
router.delete('/:configId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { configId } = req.params;

    await dynamodb.delete({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      Key: {
        userId,
        configId
      }
    }).promise();

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting config:', error);
    res.status(500).json({ error: 'Failed to delete configuration' });
  }
});

export default router; 