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
const TABLE_NAME = `${TABLE_PREFIX}AW-TaskSchedules`;

console.log('Repairing TaskSchedules table to remove actualResponse from runResults:', {
  environment: process.env.NODE_ENV || 'production',
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
  tableName: TABLE_NAME
});

/**
 * Remove actualResponse from runResults entries that have a sessionId
 * Keep actualResponse for error cases (no sessionId) since they can't be reconstructed
 */
function cleanRunResults(runResults: any[]): any[] {
  if (!Array.isArray(runResults)) {
    return [];
  }

  return runResults.map((result: any) => {
    // Keep actualResponse for error cases (no sessionId to reconstruct from)
    if (!result.sessionId || result.sessionId.trim().length === 0) {
      return result; // Keep as-is for error cases
    }

    // Remove actualResponse for entries with sessionId (can be reconstructed)
    const cleaned = { ...result };
    delete cleaned.actualResponse;
    return cleaned;
  });
}

/**
 * Repair TaskSchedules table by removing actualResponse from runResults
 */
async function repairScheduledChatRunResults() {
  let lastEvaluatedKey: any = undefined;
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalEntriesCleaned = 0;

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

      console.log(`Processing batch: ${items.length} schedules (Total scanned: ${totalScanned})`);

      // Process items in parallel batches
      const updatePromises = items.map(async (item: any) => {
        // Skip if no runResults
        if (!item.runResults || !Array.isArray(item.runResults) || item.runResults.length === 0) {
          totalSkipped++;
          return;
        }

        // Check if any entry has actualResponse that should be removed
        const hasActualResponseToRemove = item.runResults.some((result: any) => 
          result.sessionId && result.sessionId.trim().length > 0 && result.actualResponse
        );

        if (!hasActualResponseToRemove) {
          totalSkipped++;
          return;
        }

        // Clean the runResults
        const cleanedRunResults = cleanRunResults(item.runResults);
        
        // Count how many entries had actualResponse removed
        const entriesWithActualResponseRemoved = item.runResults.filter((result: any, index: number) => {
          const original = result;
          const cleaned = cleanedRunResults[index];
          return original.sessionId && original.sessionId.trim().length > 0 && 
                 original.actualResponse && !cleaned.actualResponse;
        }).length;

        totalEntriesCleaned += entriesWithActualResponseRemoved;

        // Update the record with cleaned runResults
        try {
          await dynamodb.update({
            TableName: TABLE_NAME,
            Key: {
              scheduleId: item.scheduleId
            },
            UpdateExpression: 'SET runResults = :runResults, updatedAt = :updatedAt',
            ExpressionAttributeValues: {
              ':runResults': cleanedRunResults,
              ':updatedAt': new Date().toISOString()
            }
          }).promise();

          totalUpdated++;
          if (totalUpdated % 10 === 0) {
            console.log(`  ✓ Updated ${totalUpdated} schedules, cleaned ${totalEntriesCleaned} runResults entries so far...`);
          }
        } catch (error: any) {
          console.error(`  ✗ Error updating schedule ${item.scheduleId}:`, error.message);
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
  console.log(`Total schedules scanned: ${totalScanned}`);
  console.log(`Total schedules updated: ${totalUpdated}`);
  console.log(`Total schedules skipped: ${totalSkipped} (no runResults or already cleaned)`);
  console.log(`Total runResults entries cleaned: ${totalEntriesCleaned}`);
  console.log(`Total errors: ${totalErrors}`);
  console.log('='.repeat(50));
}

// Run the repair
const main = async () => {
  try {
    await repairScheduledChatRunResults();
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

export { repairScheduledChatRunResults };

