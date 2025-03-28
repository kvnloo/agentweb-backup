import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import '../config/aws';  // Just import for side effects

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// Function to derive a 32-byte key from JWT_SECRET
function deriveKey(secret: string): Buffer {
  // Convert JWT_SECRET to Buffer if it's not already
  const secretBuffer = Buffer.from(secret, 'utf8');
  return crypto.pbkdf2Sync(secretBuffer, 'salt', 100000, 32, 'sha256');
}

// Function to encrypt password
function encryptPassword(signedPassword: string): string {
  // Generate a random IV
  const iv = crypto.randomBytes(16);
  
  // Derive a 32-byte key from JWT_SECRET
  const key = deriveKey(process.env.JWT_SECRET!);
  
  // Create cipher using derived key
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt the signed password
  let encrypted = cipher.update(signedPassword, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Get the auth tag
  const authTag = cipher.getAuthTag();
  
  // Combine IV, encrypted data, and auth tag
  const combined = Buffer.concat([iv, Buffer.from(encrypted, 'hex'), authTag]);
  
  // Return as base64 string
  return combined.toString('base64');
}

async function migratePasswords(limit: number = 1) {
  try {
    console.log(`Starting password migration for environment: ${process.env.NODE_ENV || 'production'}`);
    console.log(`Processing up to ${limit} records`);
    
    // Scan the AW-Configs table
    const result = await dynamodb.scan({
      TableName: `${TABLE_PREFIX}AW-Configs`
    }).promise();
    
    const items = result.Items || [];
    console.log(`Found ${items.length} configurations to process`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // Process each item up to the limit
    for (const item of items) {
      // Stop if we've reached the limit
      if (migratedCount >= limit) {
        console.log(`Reached limit of ${limit} records`);
        break;
      }
      
      try {
        // Skip if already has encryptedPassword
        if (item.encryptedPassword) {
          skippedCount++;
          continue;
        }
        
        // Skip if no password field
        if (!item.password) {
          skippedCount++;
          continue;
        }
        
        // Encrypt the already signed password
        const encryptedPassword = encryptPassword(item.password);
        
        // Update the item with encryptedPassword
        await dynamodb.update({
          TableName: `${TABLE_PREFIX}AW-Configs`,
          Key: {
            userId: item.userId,
            configId: item.configId
          },
          UpdateExpression: 'SET encryptedPassword = :encryptedPassword',
          ExpressionAttributeValues: {
            ':encryptedPassword': encryptedPassword
          }
        }).promise();
        
        migratedCount++;
        console.log(`Migrated password for config ${item.configId}`);
        
      } catch (error) {
        console.error(`Error processing config ${item.configId}:`, error);
        errorCount++;
      }
    }
    
    console.log('\nMigration Summary:');
    console.log(`Total configurations processed: ${items.length}`);
    console.log(`Successfully migrated: ${migratedCount}`);
    console.log(`Skipped (already migrated or no password): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
}

// Run if this script is called directly
if (require.main === module) {
  // Get limit from command line argument or use default of 1
  const limit = parseInt(process.argv[2]) || 1;
  migratePasswords(limit);
} 