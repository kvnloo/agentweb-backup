/**
 * Migration script: Move predefined work plans from AW-Settings JSON blob to AW-WorkPlans table.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-workplans.ts
 *   NODE_ENV=production npx ts-node src/scripts/migrate-workplans.ts
 */
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

async function migrate() {
  const settingsTable = `${TABLE_PREFIX}AW-Settings`;
  const workPlansTable = `${TABLE_PREFIX}AW-WorkPlans`;

  console.log(`Migrating work plans from ${settingsTable} to ${workPlansTable}...`);

  // Read existing predefined plans from settings
  const result = await dynamodb.get({
    TableName: settingsTable,
    Key: { settingName: 'agent-mode-predefined-workplans' },
  }).promise();

  if (!result.Item || !result.Item.settingValue) {
    console.log('No predefined work plans found in settings. Nothing to migrate.');
    return;
  }

  let plans: any[];
  try {
    plans = JSON.parse(result.Item.settingValue);
  } catch (err) {
    console.error('Failed to parse work plans JSON:', err);
    return;
  }

  console.log(`Found ${plans.length} plans to migrate.`);

  const timestamp = new Date().toISOString();
  let migrated = 0;
  let skipped = 0;

  for (const plan of plans) {
    const planId = plan.id || `plan_${uuidv4()}`;

    // Check if already migrated
    const existing = await dynamodb.get({
      TableName: workPlansTable,
      Key: { planId },
    }).promise();

    if (existing.Item) {
      console.log(`  Skipping "${plan.title}" (${planId}) — already exists in target table`);
      skipped++;
      continue;
    }

    const workPlan = {
      planId,
      title: plan.title,
      description: plan.description || undefined,
      welcomeMessage: plan.welcomeMessage || undefined,
      autocomplete: plan.autocomplete || false,
      requireLogin: plan.requireLogin || false,
      showLoginSignup: plan.showLoginSignup || 'after_plan_completed',
      showInAgentMode: plan.showInAgentMode !== false,
      defaultModel: plan.defaultModel || undefined,
      steps: (plan.steps || []).map((s: any, i: number) => ({
        stepCount: s.stepCount || i + 1,
        title: s.title,
        description: s.description,
        requiredFunctionCalls: s.requiredFunctionCalls || [],
        skillIds: s.skillIds || [],
      })),
      visibility: 'system',
      isBuiltIn: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Remove undefined values to avoid DynamoDB errors
    const cleanPlan = JSON.parse(JSON.stringify(workPlan));

    await dynamodb.put({
      TableName: workPlansTable,
      Item: cleanPlan,
    }).promise();

    console.log(`  Migrated "${plan.title}" (${planId})`);
    migrated++;
  }

  console.log(`\nMigration complete: ${migrated} migrated, ${skipped} skipped.`);
  console.log('NOTE: The AW-Settings entry has been preserved as backup.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
