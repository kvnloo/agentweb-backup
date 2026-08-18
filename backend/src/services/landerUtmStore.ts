/**
 * landerUtmStore — storage accessors for the two configured UTM layers the
 * ENG-538 contract defines (ENG-724, slice B):
 *
 *   - the customer-level default, on the existing AW-Users record
 *     (`landerUtmDefault`), and
 *   - the per-lander override, on the existing AW-LandingPages record
 *     (`utmOverride`).
 *
 * No new table or registry. This module is accessors only — no consumers here;
 * lander decoration (slice D) and Meta `url_tags` (slice C) read these layers
 * through the slice-A resolver.
 *
 * Contract properties enforced structurally:
 *   - A default write goes only to the user record and a single field, so it can
 *     never clobber a per-lander override — the override lives in another table.
 *   - Absent is absent: a layer that was never configured reads back as `null`,
 *     never as `{}` or empty strings. Clearing is explicit (`null`), not an
 *     empty-object write.
 *   - Writes validate through the same `validateUtmConfig` rules the resolver
 *     applies at read time (reserved keys, unknown keys, blank values throw).
 *   - Records written before these fields existed read back `null` with no
 *     backfill.
 */
import AWS from "aws-sdk";
import { userDb } from "./db";
import { validateUtmConfig, type UtmConfig } from "../utils/landerUtm";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: { timeout: 30_000, connectTimeout: 5_000 },
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const LANDERS_TABLE = `${TABLE_PREFIX}AW-LandingPages`;

/**
 * A stored layer is only emitted when it is a plain, non-empty object; anything
 * else (missing field, `{}`, a corrupt non-object write) normalizes to `null`
 * so downstream code has exactly one "not configured" shape to handle.
 */
function normalizeStored(value: unknown): UtmConfig | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    return null;
  }
  return value as UtmConfig;
}

/** Shared write-side validation: `null` clears; `{}` is rejected as ambiguous. */
function validateForWrite(config: UtmConfig, label: string): UtmConfig {
  const validated = validateUtmConfig(config, label);
  if (Object.keys(validated).length === 0) {
    throw new Error(
      `landerUtmStore: ${label} is empty — pass null to clear the ${label} instead of writing an empty object`,
    );
  }
  return validated;
}

/** The customer-level default, or `null` when the customer has none. */
export async function getCustomerUtmDefault(userId: string): Promise<UtmConfig | null> {
  const user = await userDb.getUserById(userId);
  return normalizeStored(user?.landerUtmDefault);
}

/**
 * Set (or, with `null`, clear) the customer-level default. Touches only the
 * `landerUtmDefault` field on the user record — never any lander record.
 * Returns the validated (trimmed) config as stored.
 */
export async function setCustomerUtmDefault(
  userId: string,
  config: UtmConfig | null,
): Promise<UtmConfig | null> {
  if (config === null) {
    // userDb.updateUser REMOVEs a field when its value is null.
    await userDb.updateUser(userId, { landerUtmDefault: null as any });
    return null;
  }
  const validated = validateForWrite(config, "customer default");
  await userDb.updateUser(userId, { landerUtmDefault: validated });
  return validated;
}

/** The per-lander override, or `null` when this lander has none. */
export async function getLanderUtmOverride(pageId: string): Promise<UtmConfig | null> {
  const result = await dynamodb
    .get({
      TableName: LANDERS_TABLE,
      Key: { id: pageId },
      ProjectionExpression: "utmOverride",
    })
    .promise();
  return normalizeStored(result.Item?.utmOverride);
}

/**
 * Set (or, with `null`, clear) one lander's override. Conditional on the record
 * existing so a typo'd id fails loudly instead of materializing a phantom
 * lander record.
 */
export async function setLanderUtmOverride(
  pageId: string,
  config: UtmConfig | null,
): Promise<UtmConfig | null> {
  const validated = config === null ? null : validateForWrite(config, "per-lander override");
  try {
    await dynamodb
      .update({
        TableName: LANDERS_TABLE,
        Key: { id: pageId },
        ConditionExpression: "attribute_exists(id)",
        ...(validated === null
          ? { UpdateExpression: "REMOVE utmOverride" }
          : {
              UpdateExpression: "SET utmOverride = :utmOverride",
              ExpressionAttributeValues: { ":utmOverride": validated },
            }),
      })
      .promise();
  } catch (err: any) {
    if (err?.code === "ConditionalCheckFailedException") {
      throw new Error(`landerUtmStore: no landing page record with id "${pageId}"`);
    }
    throw err;
  }
  return validated;
}
