/**
 * Append-only evidence for a charge applied to the monthly LLM counter.
 * This is deliberately LLM-only: it is not the future cross-vendor wallet.
 */
import AWS from "aws-sdk";

export const LLM_CHARGE_EVENTS_TABLE = `${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-LlmChargeEvents`;
let client: AWS.DynamoDB.DocumentClient | null = null;
const db = () => (client ||= new AWS.DynamoDB.DocumentClient());

export type LlmChargeAuditEvent = {
  billingUserId: string; eventId: string; occurredAt: string; actingUserId: string;
  tokens: number; costMicroUsd: number; model?: string; provider?: string; feature?: string;
  sessionId?: string;
  counterAppliedAt?: string;
};

export async function recordLlmChargeEvent(event: LlmChargeAuditEvent): Promise<boolean> {
  try {
    await db().put({
      TableName: LLM_CHARGE_EVENTS_TABLE,
      Item: { ...event, ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 },
      // Retries are harmless: the counter caller must not apply a second charge.
      ConditionExpression: "attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)",
    }).promise();
    return true;
  } catch (error: any) {
    if (error?.code === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function listLlmChargeEvents(billingUserId: string, start: string, end: string): Promise<LlmChargeAuditEvent[]> {
  const items: LlmChargeAuditEvent[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await db().query({
      TableName: LLM_CHARGE_EVENTS_TABLE,
      KeyConditionExpression: "billingUserId = :user AND eventId BETWEEN :start AND :end",
      ExpressionAttributeValues: { ":user": billingUserId, ":start": start, ":end": `${end}~` },
      ScanIndexForward: false,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }).promise();
    items.push(...((result.Items || []) as LlmChargeAuditEvent[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items.filter((event) => !!event.counterAppliedAt);
}

export async function markLlmChargeApplied(billingUserId: string, eventId: string): Promise<void> {
  await db().update({
    TableName: LLM_CHARGE_EVENTS_TABLE,
    Key: { billingUserId, eventId },
    UpdateExpression: 'SET counterAppliedAt = :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
  }).promise();
}
