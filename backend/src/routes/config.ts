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
      FilterExpression: 'attribute_not_exists(sharedBy) OR sharedBy = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }).promise();

    // Process user's own configs and add sharedWith information
    const configs = await Promise.all((result.Items || []).map(async (config) => {
      // Remove password from config object
      const { password, ...configWithoutPassword } = config;

      if (config.sharedConfigIds?.length > 0) {
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
          if (result.Items?.[0]) {
            const { password, ...sharedConfigWithoutPassword } = result.Items[0];
            return sharedConfigWithoutPassword;
          }
          return null;
        });

        const sharedConfigs = (await Promise.all(sharedConfigPromises)).filter(Boolean);

        // Get user emails for shared configs
        const sharedWithUsers = await Promise.all(
          sharedConfigs.map(c => userDb.getUserById(c.userId))
        );

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
    let { website, username, password, isApiConfig, appName, integrationDocLink } = req.body;

    // Check if this is a website config or API config
    if (isApiConfig) {
      // API Configuration validation
      if (!appName || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields for API configuration' });
      }

      const configId = uuidv4();
      const config = {
        configId,
        userId,
        isApiConfig: true,
        appName,
        username,
        password: encryptPassword(password, userId),
        integrationDocLink: integrationDocLink || null,
        createdAt: new Date().toISOString()
      };

      await dynamodb.put({
        TableName: `${TABLE_PREFIX}AW-Configs`,
        Item: config
      }).promise();

      res.status(201).json({ configId });
    } else {
      // Regular website configuration
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
        isApiConfig: false,
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
    }
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
    const { email, shareWithEveryone } = req.body;

    if (!email && !shareWithEveryone) {
      return res.status(400).json({ error: 'Either email or shareWithEveryone must be provided' });
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

    if (shareWithEveryone) {
      // Determine if this is an API configuration
      const isApiConfig = result.Item.isApiConfig === true;
      console.log(`Sharing config with everyone - isApiConfig: ${isApiConfig}`);

      // When sharing with everyone, we just update the existing config
      // No need to modify anything related to API since the original fields are preserved
      await dynamodb.update({
        TableName: `${TABLE_PREFIX}AW-Configs`,
        Key: {
          userId,
          configId
        },
        UpdateExpression: 'SET shareWithEveryone = :shareWithEveryone, sharedBy = :sharedBy',
        ExpressionAttributeValues: {
          ':shareWithEveryone': 1,
          ':sharedBy': userId
        }
      }).promise();

      res.status(201).json({ message: `Configuration shared with everyone successfully (Type: ${isApiConfig ? 'API' : 'Website'})` });
      return;
    }

    // If not sharing with everyone, proceed with sharing with specific user
    // Find target user by email
    const targetUser = await userDb.getUserByEmail(email);
    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    // Create a new config for the target user
    const newConfigId = uuidv4();
    
    // Get the isApiConfig flag from the original configuration
    const isApiConfig = result.Item.isApiConfig === true;
    console.log(`Sharing config directly - isApiConfig: ${isApiConfig}, appName: ${result.Item.appName || 'N/A'}`);
    
    // Prepare the shared config, preserving API-specific fields if present
    const sharedConfig: any = {
      configId: newConfigId,
      userId: targetUser.userId,
      isApiConfig: result.Item.isApiConfig || false,
      username: result.Item.username,
      password: result.Item.password,
      createdAt: new Date().toISOString(),
      sharedBy: userId
    };

    // Add website field for regular website configurations
    if (!result.Item.isApiConfig) {
      sharedConfig.website = result.Item.website;
    } 
    // Add API-specific fields for API configurations
    else {
      sharedConfig.appName = result.Item.appName;
      if (result.Item.integrationDocLink) {
        sharedConfig.integrationDocLink = result.Item.integrationDocLink;
      }
    }

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

// Get configurations shared with me by other users (both direct and public)
router.get('/shared', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    
    // Get configs shared directly with me by other users
    const directlySharedResult = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'attribute_exists(sharedBy) AND sharedBy <> :userId', // Only get configs shared by others
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }).promise();

    // Get configs shared publicly by other users
    const publiclySharedResult = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      IndexName: 'ShareWithEveryoneIndex',
      KeyConditionExpression: 'shareWithEveryone = :shareWithEveryone',
      FilterExpression: 'userId <> :userId AND (attribute_not_exists(sharedBy) OR sharedBy <> :userId)', // Exclude configs shared by me
      ExpressionAttributeValues: {
        ':shareWithEveryone': 1,
        ':userId': userId
      }
    }).promise();

    // Combine and process all configs shared with me by others
    const allSharedConfigs = [...(directlySharedResult.Items || []), ...(publiclySharedResult.Items || [])];
    
    const sharedConfigs = await Promise.all(allSharedConfigs.map(async (config) => {
      const { password, ...configWithoutPassword } = config;
      const sharer = await userDb.getUserById(config.sharedBy || config.userId);
      
      // Determine if this is an API configuration
      const isApiConfig = !!(config.appName && !config.website) || config.isApiConfig === true;
      
      // Ensure API configuration flag is properly set
      if (isApiConfig && configWithoutPassword.isApiConfig !== true) {
        configWithoutPassword.isApiConfig = true;
      }
      
      // Add any missing API fields that might have been lost during sharing
      if (isApiConfig && !configWithoutPassword.appName && config.appName) {
        configWithoutPassword.appName = config.appName;
      }
      
      // Ensure we pass along the API configuration properties
      const result = {
        ...configWithoutPassword,
        sharedBy: sharer ? sharer.email : undefined,
        isPublic: !!config.shareWithEveryone
      };
      
      return result;
    }));

    res.json(sharedConfigs);
  } catch (error) {
    console.error('Error fetching configurations shared with me:', error);
    res.status(500).json({ error: 'Failed to fetch configurations shared with me' });
  }
});

// Get API configurations by app name
router.get('/api/:appName', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { appName } = req.params;
    
    if (!appName) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // First check user's own API configs
    const userConfigs = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'isApiConfig = :isApiConfig AND appName = :appName',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':isApiConfig': true,
        ':appName': appName
      }
    }).promise();

    if (userConfigs.Items && userConfigs.Items.length > 0) {
      // Return user's own config (without password)
      const config = userConfigs.Items[0];
      const { password, ...configWithoutPassword } = config;
      return res.json(configWithoutPassword);
    }

    // If no user configs, check publicly shared API configs
    const publicConfigs = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      IndexName: 'ShareWithEveryoneIndex',
      KeyConditionExpression: 'shareWithEveryone = :shareWithEveryone',
      FilterExpression: 'isApiConfig = :isApiConfig AND appName = :appName AND userId <> :userId',
      ExpressionAttributeValues: {
        ':shareWithEveryone': 1,
        ':isApiConfig': true,
        ':appName': appName,
        ':userId': userId
      }
    }).promise();

    if (publicConfigs.Items && publicConfigs.Items.length > 0) {
      // Return the publicly shared config (without password)
      const config = publicConfigs.Items[0];
      const { password, ...configWithoutPassword } = config;
      return res.json(configWithoutPassword);
    }

    // No configs found for this app name
    return res.status(404).json({ error: `No API configuration found for ${appName}` });
  } catch (error) {
    console.error('Error fetching API config:', error);
    res.status(500).json({ error: 'Failed to fetch API configuration' });
  }
});

export default router; 