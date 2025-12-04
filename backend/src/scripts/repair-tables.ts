import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
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
const TABLE_NAME = `${TABLE_PREFIX}AW-EmailEvents`;

console.log('Repairing EmailEvents table with configuration:', {
  environment: process.env.NODE_ENV || 'production',
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
  tableName: TABLE_NAME
});

/**
 * Extract email domain from email string
 * Handles formats like "Name <email@domain.com>" or "email@domain.com"
 */
function extractEmailDomain(email: string): string {
  // Extract domain from "Name <email@domain.com>" format
  const match = email.match(/<([^>]+)>/);
  if (match) {
    const emailAddr = match[1];
    const domain = emailAddr.split('@')[1];
    return domain || 'unknown';
  }
  
  // If no angle brackets, assume the whole string is an email
  const emailAddr = email.split(' ').pop() || email;
  const domain = emailAddr.split('@')[1];
  return domain || 'unknown';
}

/**
 * Extract email address from email string
 * Handles formats like "Name <email@domain.com>" or "email@domain.com"
 */
function extractEmailAddress(email: string): string {
  // Extract email from "Name <email@domain.com>" format
  const match = email.match(/<([^>]+)>/);
  if (match) {
    return match[1].toLowerCase().trim();
  }
  
  // If no angle brackets, assume the whole string is an email
  return email.split(' ').pop()?.toLowerCase().trim() || email.toLowerCase().trim();
}

/**
 * Extract leadEmail from event data based on event type
 */
function extractLeadEmail(event: any): string | null {
  if (!event.data) {
    return null;
  }

  // For email.received events, leadEmail is the sender (from field)
  if (event.eventType === 'email.received') {
    const from = event.data.from;
    if (!from) {
      return null;
    }
    return extractEmailAddress(from);
  } else {
    // For all other events (delivered, opened, clicked, etc.), leadEmail is the recipient (to field)
    const to = event.data.to;
    if (!to) {
      return null;
    }
    
    // Handle both array and string formats
    const recipient = Array.isArray(to) ? to[0] : to;
    if (!recipient) {
      return null;
    }
    
    return extractEmailAddress(recipient);
  }
}

/**
 * Repair EmailEvents table by adding leadEmail to records that don't have it
 */
async function repairEmailEvents() {
  let lastEvaluatedKey: any = undefined;
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  console.log('Starting repair process...\n');

  do {
    const scanParams: any = {
      TableName: TABLE_NAME,
      Limit: 100, // Process in batches of 100
    };

    if (lastEvaluatedKey) {
      scanParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    try {
      const result = await dynamodb.scan(scanParams).promise();
      const items = result.Items || [];
      totalScanned += items.length;

      console.log(`Processing batch: ${items.length} items (Total scanned: ${totalScanned})`);

      // Process items in parallel batches
      const updatePromises = items.map(async (item: any) => {
        // Skip if leadEmail already exists
        if (item.leadEmail) {
          totalSkipped++;
          return;
        }

        // Extract leadEmail based on event type
        const leadEmail = extractLeadEmail(item);
        
        if (!leadEmail) {
          console.warn(`  ⚠️  Skipping event ${item.eventId}: Could not extract leadEmail`);
          totalSkipped++;
          return;
        }

        // Update the record with leadEmail
        try {
          await dynamodb.update({
            TableName: TABLE_NAME,
            Key: {
              eventId: item.eventId
            },
            UpdateExpression: 'SET leadEmail = :leadEmail',
            ExpressionAttributeValues: {
              ':leadEmail': leadEmail
            }
          }).promise();

          totalUpdated++;
          if (totalUpdated % 10 === 0) {
            console.log(`  ✓ Updated ${totalUpdated} records so far...`);
          }
        } catch (error: any) {
          console.error(`  ✗ Error updating event ${item.eventId}:`, error.message);
          totalErrors++;
        }
      });

      await Promise.all(updatePromises);
      lastEvaluatedKey = result.LastEvaluatedKey;

      // Small delay to avoid throttling
      if (lastEvaluatedKey) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error: any) {
      console.error('Error scanning table:', error);
      throw error;
    }
  } while (lastEvaluatedKey);

  console.log('\n' + '='.repeat(50));
  console.log('Repair process completed!');
  console.log('='.repeat(50));
  console.log(`Total records scanned: ${totalScanned}`);
  console.log(`Total records updated: ${totalUpdated}`);
  console.log(`Total records skipped: ${totalSkipped} (already had leadEmail)`);
  console.log(`Total errors: ${totalErrors}`);
  console.log('='.repeat(50));
}

// Run the repair
const main = async () => {
  try {
    await repairEmailEvents();
    console.log('\n✅ Repair completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Repair failed:', error);
    process.exit(1);
  }
};

// Run if this script is called directly
if (require.main === module) {
  main();
}

export { repairEmailEvents };

