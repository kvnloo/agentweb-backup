/**
 * Seed a throwaway test environment for the LinkedIn-Ads work-plan image-resume fix.
 *
 * Creates (idempotently):
 *   1. A throwaway customer user  (email/password printed at the end)
 *   2. An agent-mode "predefined-work-plan" session that reproduces the EXACT prod
 *      failure state for session 7c8ff5b2-... :
 *        - 4-step LinkedIn Ads work plan
 *        - Steps 1 & 2 completed
 *        - Step 3 ("Generate 3 Images Per Hook") PENDING, requiredFunctionCalls=[generate_image]
 *        - Step 4 PENDING
 *        - 6 images ALREADY generated (hooks 1 & 2 × 3 styles) recorded as
 *          "Image generated: <file>" system messages — the same trail generateImage leaves
 *        - calledFunctions.generate_image = 6 so the step-completion gate is satisfiable
 *
 * The scenario is scoped to hooks 1 & 2 (6 images) instead of the full 18 so a single
 * agent run finishes inside the 10-minute timeout — this lets a human verify the FIX
 * deterministically: the agent must NOT regenerate the 6 existing images and MUST
 * advance the plan. (The original 18-image bug is the same code path; 6 is the
 * timeout-safe, reproducible slice.)
 *
 * Usage:   cd backend && NODE_ENV=development npx ts-node src/scripts/seed-imageresume-testenv.ts
 * Cleanup: cd backend && NODE_ENV=development npx ts-node src/scripts/seed-imageresume-testenv.ts --cleanup
 */
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { userDb } from '../services/db';
import { chatbotDb, dynamodb } from '../services/chatbotService';

dotenv.config();

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const CHAT_SESSIONS_TABLE = `${TABLE_PREFIX}AW-ChatSessions`;
const CHAT_MESSAGES_TABLE = `${TABLE_PREFIX}AW-ChatMessages`;

// Stable, recognizable identifiers so re-runs and cleanup are deterministic.
const TEST_EMAIL = 'imgresume-tester@example.com';
const TEST_PASSWORD = 'Test123!';
const TEST_USER_ID = 'imgresume-tester-0001';
const FIXED_SESSION_ID = 'imgresume-e2e-session-0001';

// The 6 images already produced before the (simulated) timeout — hooks 1 & 2.
const ALREADY_GENERATED = [
  'xcures_h1_typographic.png',
  'xcures_h1_dataclarity.png',
  'xcures_h1_growth.png',
  'xcures_h2_typographic.png',
  'xcures_h2_dataclarity.png',
  'xcures_h2_growth.png',
];

/** Delete every AW-ChatMessages row for a session (the message rows key off sessionId+messageIndex). */
async function deleteAllSessionMessages(sessionId: string): Promise<number> {
  let deleted = 0;
  let lastKey: any = undefined;
  do {
    const q: any = await dynamodb
      .query({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: 'sessionId = :s',
        ExpressionAttributeValues: { ':s': sessionId },
        ProjectionExpression: 'sessionId, messageIndex',
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
      .promise();
    for (const it of q.Items || []) {
      await dynamodb
        .delete({ TableName: CHAT_MESSAGES_TABLE, Key: { sessionId: it.sessionId, messageIndex: it.messageIndex } })
        .promise();
      deleted++;
    }
    lastKey = q.LastEvaluatedKey;
  } while (lastKey);
  return deleted;
}

async function cleanup() {
  // Delete the seeded session, its message rows, and the throwaway user.
  try {
    const n = await deleteAllSessionMessages(FIXED_SESSION_ID);
    await chatbotDb.deleteSession(FIXED_SESSION_ID);
    console.log(`✓ Deleted session ${FIXED_SESSION_ID} and ${n} message rows`);
  } catch (e: any) {
    console.log(`(session delete) ${e?.message || e}`);
  }
  try {
    const u = await userDb.getUserByEmail(TEST_EMAIL);
    if (u?.userId) {
      const r = await userDb.deleteUserById(u.userId);
      console.log(`✓ Deleted user ${TEST_EMAIL}: ${r.success ? 'ok' : r.message}`);
    } else {
      console.log(`(user delete) ${TEST_EMAIL} not found`);
    }
  } catch (e: any) {
    console.log(`(user delete) ${e?.message || e}`);
  }
  console.log('Cleanup done.');
}

async function seed() {
  const now = new Date().toISOString();

  // 1) Throwaway user (idempotent).
  const existing = await userDb.getUserByEmail(TEST_EMAIL);
  if (existing) {
    console.log(`User ${TEST_EMAIL} already exists (userId=${existing.userId}). Reusing.`);
  } else {
    const hashed = await bcrypt.hash(TEST_PASSWORD, 10);
    await userDb.createUser(TEST_EMAIL, TEST_USER_ID, hashed, false, false, ['customer']);
    console.log(`✓ Created throwaway user ${TEST_EMAIL} (userId=${TEST_USER_ID})`);
  }
  const userId = existing?.userId || TEST_USER_ID;

  // 2) Fresh session every run — delete the prior one (and its message rows) so
  //    message indices start clean.
  try {
    await deleteAllSessionMessages(FIXED_SESSION_ID);
    await chatbotDb.deleteSession(FIXED_SESSION_ID);
  } catch { /* not present yet */ }

  // Persist the base session record with our fixed sessionId. createChatSession would
  // mint its own uuid, so we write the record directly via the shared DocumentClient.
  // Field shape mirrors createChatSession + an agent predefined-work-plan session.
  const baseSession: any = {
    sessionId: FIXED_SESSION_ID,
    userId,
    title: 'PR Launch LinkedIn Ad Campaign (image-resume test)',
    messages: [],
    createdAt: now,
    updatedAt: now,
    adminListPartition: 'all',
    portalType: 'agent',
    pageIdentifier: 'plan-Lilly - LinkedIn Ads Campaign generator',
    sessionType: 'predefined-work-plan',
    associatedSkills: [],
    llmModel: 'anthropic.claude-opus-4-8',
    messageCount: 0,
  };
  await dynamodb.put({ TableName: CHAT_SESSIONS_TABLE, Item: baseSession }).promise();
  console.log(`✓ Created session ${FIXED_SESSION_ID}`);

  // 3) Work plan: steps 1&2 done, step 3 pending (needs generate_image), step 4 pending.
  await chatbotDb.updateSessionWorkPlan(FIXED_SESSION_ID, {
    title: 'Lilly - LinkedIn Ads Campaign generator',
    createdAt: now,
    updatedAt: now,
    autocomplete: false,
    welcomeMessage: 'Welcome to the LinkedIn Ads Campaign work plan!',
    steps: [
      {
        stepCount: 1,
        title: 'Collect Campaign Inputs',
        description: 'Collect ICP, objective, ad format, offer, constraints. Confirm with user.',
        status: 'completed',
        completedAt: now,
        notes: 'Broad ICP, single image, awareness, destination xcures.com.',
        requiredFunctionCalls: [],
        skillIds: [],
      },
      {
        stepCount: 2,
        title: 'Write 6 Hooks & Ad Copy',
        description: 'Create 6 hooks with full ad copy in xCures brand voice. Present for approval.',
        status: 'completed',
        completedAt: now,
        notes: 'All 6 hooks approved by user.',
        requiredFunctionCalls: [],
        skillIds: [],
      },
      {
        stepCount: 3,
        title: 'Generate 3 Images Per Hook',
        description:
          'Generate 3 images per hook using brand colors (#0154BE / #29ADE3) and logo. ' +
          'For THIS test only hooks 1 and 2 are in scope (6 images total). Hooks 1 and 2 are ' +
          'already done — generate only what is still missing, then advance.',
        status: 'pending',
        requiredFunctionCalls: ['generate_image'],
        skillIds: [],
      },
      {
        stepCount: 4,
        title: 'Generate Creative Hub Report',
        description:
          'Compile brief, hooks, ad copy, and selected images into a polished HTML report. ' +
          'Ask whether to revise, save as GTM Plan, or save to Knowledge Base.',
        status: 'pending',
        requiredFunctionCalls: [],
        skillIds: [],
      },
    ],
  });
  console.log('✓ Work plan attached (step 3 pending, needs generate_image)');

  // 4) Conversation history + the 6 "Image generated:" system trails.
  const msg = (role: string, content: string) => ({ role: role as any, content, timestamp: now });
  const history = [
    msg('system', 'You are EMMA, the AI marketing assistant. Drive the work plan to completion.'),
    msg('user', 'Run the LinkedIn Ads Campaign generator. ICP: oncology researchers. Awareness. Single image. Promote the xCures platform. No investor mention.'),
    msg('assistant', 'Inputs collected and confirmed. Step 1 complete.'),
    msg('user', 'Approved — write the 6 hooks and ad copy.'),
    msg('assistant',
      'Here are 6 hooks with full ad copy (approved). Step 2 complete. Starting Step 3 — I generated ' +
      '3 sample images for Hook 1 and 3 for Hook 2 so you can confirm the style direction.'),
    ...ALREADY_GENERATED.map((f) => msg('system', `Image generated: ${f}`)),
  ];
  await chatbotDb.addMessagesToSession(FIXED_SESSION_ID, history as any);
  console.log(`✓ Seeded ${history.length} messages (incl. ${ALREADY_GENERATED.length} "Image generated:" trails)`);

  // 5) calledFunctions.generate_image = 6 so the step-completion gate is satisfiable.
  await chatbotDb.incrementCalledFunctions(FIXED_SESSION_ID, { generate_image: ALREADY_GENERATED.length });
  console.log(`✓ calledFunctions.generate_image = ${ALREADY_GENERATED.length}`);

  console.log('\n================ TEST ENVIRONMENT READY ================');
  console.log(`Customer Portal : http://16.146.78.118:5174`);
  console.log(`Login email     : ${TEST_EMAIL}`);
  console.log(`Login password  : ${TEST_PASSWORD}`);
  console.log(`Session ID      : ${FIXED_SESSION_ID}`);
  console.log(`Direct URL      : http://16.146.78.118:5174/agent-mode/${FIXED_SESSION_ID}`);
  console.log(`Already-generated images (must NOT be regenerated):`);
  ALREADY_GENERATED.forEach((f) => console.log(`   - ${f}`));
  console.log('========================================================\n');
}

(async () => {
  try {
    if (process.argv.includes('--cleanup')) {
      await cleanup();
    } else {
      await seed();
    }
    process.exit(0);
  } catch (err) {
    console.error('seed-imageresume-testenv failed:', err);
    process.exit(1);
  }
})();
