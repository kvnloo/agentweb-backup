/**
 * GTM Plan Service
 *
 * Provides helpers for programmatically managing GTM plans.
 * Currently used by the Slack integration to auto-track Agent Mode sessions
 * as work items in the GTM Tracker, organized by week.
 */

import { DynamoDB } from "aws-sdk";

const dynamodb = new DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  }),
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

const SLACK_SESSION_PLAN_TITLE = "Slack Agent Sessions";

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Returns the Monday of the current week (Monday-Sunday).
 */
function getCurrentWeekMonday(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // If Sunday, go back 6 days; else go back to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * Formats a date as "Week of Mar 24, 2026".
 */
function formatWeekPhaseTitle(monday: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `Week of ${months[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
}

/**
 * Finds the user's "Slack Agent Sessions" plan, or creates one if it doesn't exist.
 */
async function findOrCreateSlackSessionPlan(userId: string): Promise<any> {
  // Query all plans for this user
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
      ScanIndexForward: false,
    })
    .promise();

  const plans = result.Items || [];
  const existing = plans.find((p: any) => p.title === SLACK_SESSION_PLAN_TITLE);
  if (existing) {
    return existing;
  }

  // Create a new plan
  const now = new Date().toISOString();
  const newPlan = {
    planId: generateId("plan"),
    userId,
    title: SLACK_SESSION_PLAN_TITLE,
    description: "Auto-created plan to track Agent Mode sessions started from Slack.",
    status: "in_progress",
    phases: [],
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: newPlan }).promise();
  console.log(`📋 Created GTM plan "${SLACK_SESSION_PLAN_TITLE}" for user ${userId}: ${newPlan.planId}`);
  return newPlan;
}

/**
 * Finds the phase for the current week, or creates one if it doesn't exist.
 * Returns the updated plan and the phase.
 */
async function findOrCreateWeeklyPhase(plan: any): Promise<{ plan: any; phase: any }> {
  const monday = getCurrentWeekMonday();
  const phaseTitle = formatWeekPhaseTitle(monday);
  const phases = plan.phases || [];

  const existing = phases.find((p: any) => p.title === phaseTitle);
  if (existing) {
    return { plan, phase: existing };
  }

  // Create a new phase for this week
  const newPhase = {
    id: generateId("phase"),
    title: phaseTitle,
    description: null,
    dri: null,
    status: "in_progress",
    workItems: [],
  };

  phases.push(newPhase);
  const now = new Date().toISOString();

  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { planId: plan.planId },
      UpdateExpression: "SET phases = :phases, updatedAt = :now",
      ExpressionAttributeValues: {
        ":phases": phases,
        ":now": now,
      },
    })
    .promise();

  plan.phases = phases;
  plan.updatedAt = now;
  console.log(`📅 Created weekly phase "${phaseTitle}" in plan ${plan.planId}`);
  return { plan, phase: newPhase };
}

/**
 * Creates a work item for a Slack-started Agent Mode session.
 * Returns the IDs needed to link the session back to the work item.
 */
async function createSlackSessionWorkItem(params: {
  plan: any;
  phase: any;
  sessionId: string;
  title: string;
  adminEmail?: string;
}): Promise<{ planId: string; phaseId: string; workItemId: string }> {
  const { plan, phase, sessionId, title, adminEmail } = params;

  const workItemId = generateId("item");
  const newWorkItem = {
    id: workItemId,
    title,
    description: null,
    status: "agent_in_progress",
    agentSessionId: sessionId,
    dri: adminEmail || null,
    notes: null,
    dueDate: null,
  };

  // Find the phase in the plan and add the work item
  const phases = plan.phases || [];
  const phaseIndex = phases.findIndex((p: any) => p.id === phase.id);
  if (phaseIndex === -1) {
    throw new Error(`Phase ${phase.id} not found in plan ${plan.planId}`);
  }

  const workItems = phases[phaseIndex].workItems || [];
  workItems.push(newWorkItem);
  phases[phaseIndex].workItems = workItems;

  const now = new Date().toISOString();

  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { planId: plan.planId },
      UpdateExpression: "SET phases = :phases, updatedAt = :now",
      ExpressionAttributeValues: {
        ":phases": phases,
        ":now": now,
      },
    })
    .promise();

  console.log(`📝 Created work item "${title}" (${workItemId}) in phase "${phase.title}" for session ${sessionId}`);
  return { planId: plan.planId, phaseId: phase.id, workItemId };
}

/**
 * Orchestrates creating a GTM work item for a Slack-started Agent Mode session.
 * Non-blocking: returns null on any failure so session creation is not disrupted.
 */
export async function ensureGtmWorkItemForSlackSession(params: {
  userId: string;
  sessionId: string;
  rawMessage: string;
  adminEmail?: string;
}): Promise<{ planId: string; phaseId: string; workItemId: string } | null> {
  const { userId, sessionId, rawMessage, adminEmail } = params;

  try {
    const plan = await findOrCreateSlackSessionPlan(userId);
    const { plan: updatedPlan, phase } = await findOrCreateWeeklyPhase(plan);

    // Truncate title to match session title logic
    const title = rawMessage.length > 50
      ? rawMessage.substring(0, 47) + "..."
      : rawMessage;

    const result = await createSlackSessionWorkItem({
      plan: updatedPlan,
      phase,
      sessionId,
      title,
      adminEmail,
    });

    return result;
  } catch (error) {
    console.error("❌ Error creating GTM work item for Slack session:", error);
    return null;
  }
}

/**
 * Adds a ✅ reaction to the original Slack message when a work item is marked completed.
 * Non-blocking: logs errors but never throws.
 */
export async function notifySlackWorkItemCompleted(workItem: {
  agentSessionId?: string;
  title?: string;
}): Promise<void> {
  try {
    if (!workItem.agentSessionId) return;

    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) return;

    // Dynamic import to avoid pulling in chatbotService (and its transitive deps) at module load time
    const { chatbotDb } = await import("./chatbotService");
    const session = await chatbotDb.getChatSession(workItem.agentSessionId);
    if (!session?.slackThread) return;

    const { channel, threadTs } = session.slackThread as { channel: string; threadTs: string };
    if (!channel || !threadTs) return;

    const { WebClient } = await import("@slack/web-api");
    const slackClient = new WebClient(slackToken);

    await slackClient.reactions.add({
      channel,
      timestamp: threadTs,
      name: "white_check_mark",
    });

    console.log(`✅ Added completion reaction for session ${workItem.agentSessionId}`);
  } catch (error) {
    console.error("⚠️ Non-blocking: Failed to add Slack completion reaction:", error);
  }
}
