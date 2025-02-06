import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { DynamoDB } from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';

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

    // Process user's own configs and add sharedWith information
    const configs = await Promise.all((result.Items || []).map(async (config) => {
      // Remove password from config object
      const { password, ...configWithoutPassword } = config;

      if (config.sharedBy) {
        // This is a config shared with the user
        const sharer = await userDb.getUserById(config.sharedBy);
        if (sharer) {
          return {
            ...configWithoutPassword,
            sharedBy: sharer.email
          };
        }
      } else if (config.sharedConfigIds?.length > 0) {
        console.log('Found config with sharedConfigIds:', {
          configId: config.configId,
          sharedConfigIds: config.sharedConfigIds
        });

        // Get shared configs using the GSI
        const sharedConfigPromises = config.sharedConfigIds.map(async (sharedId: string) => {
          const result = await dynamodb.query({
            TableName: `${TABLE_PREFIX}AW-Configs`,
            IndexName: 'ConfigIdIndex',
            KeyConditionExpression: 'configId = :configId',
            ExpressionAttributeValues: {
              ':configId': sharedId
            }
          }).promise();
          // Remove password from shared configs as well
          if (result.Items?.[0]) {
            const { password, ...sharedConfigWithoutPassword } = result.Items[0];
            return sharedConfigWithoutPassword;
          }
          return null;
        });

        const sharedConfigs = (await Promise.all(sharedConfigPromises)).filter(Boolean);
        console.log('Shared configs:', sharedConfigs.map(c => ({
          configId: c.configId,
          userId: c.userId
        })));

        // Get user emails for shared configs
        const sharedWithUsers = await Promise.all(
          sharedConfigs.map(c => userDb.getUserById(c.userId))
        );

        console.log('Shared with users:', sharedWithUsers.map(u => u?.email));

        return {
          ...configWithoutPassword,
          sharedWith: sharedWithUsers
            .filter((user): user is NonNullable<typeof user> => user !== null)
            .map(user => user.email)
        };
      }
      return configWithoutPassword;
    }));

    res.json(configs);
  } catch (error) {
    console.error('Error fetching configs:', error);
    res.status(500).json({ error: 'Failed to fetch configurations' });
  }
});

// Add a new configuration
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    let { website, username, password } = req.body;

    if (!website || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Convert website to lowercase
    website = website.toLowerCase();

    // Validate domain name format
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
    if (!domainRegex.test(website)) {
      return res.status(400).json({ 
        error: 'Invalid domain name format. Please enter a valid domain (e.g., example.com, sub.example.com)',
        type: 'INVALID_DOMAIN'
      });
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

// Share a configuration with another user
router.post('/:configId/share', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { configId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Verify the config exists and belongs to the user
    const result = await dynamodb.get({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      Key: {
        userId,
        configId
      }
    }).promise();

    if (!result.Item) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Find target user by email
    const targetUser = await userDb.getUserByEmail(email);
    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    // Create a new config for the target user
    const newConfigId = uuidv4();
    const sharedConfig = {
      configId: newConfigId,
      userId: targetUser.userId,
      website: result.Item.website,
      username: result.Item.username,
      password: result.Item.password,
      createdAt: new Date().toISOString(),
      sharedBy: userId
    };

    // Update original config with the new shared configId
    const sharedConfigIds = result.Item.sharedConfigIds || [];
    await dynamodb.update({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      Key: {
        userId,
        configId
      },
      UpdateExpression: 'SET sharedConfigIds = :sharedConfigIds',
      ExpressionAttributeValues: {
        ':sharedConfigIds': [...sharedConfigIds, newConfigId]
      }
    }).promise();

    // Save the shared config
    await dynamodb.put({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      Item: sharedConfig
    }).promise();

    res.status(201).json({ message: 'Configuration shared successfully' });
  } catch (error) {
    console.error('Error sharing config:', error);
    res.status(500).json({ error: 'Failed to share configuration' });
  }
});

export default router; 