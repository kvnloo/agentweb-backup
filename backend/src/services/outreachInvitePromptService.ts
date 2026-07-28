/**
 * Onboarding outreach invite prompt store — DynamoDB-backed, admin-editable.
 *
 * A single row in the same AW-PromptTemplates table used by the ad-image
 * archetypes, keyed `onboarding-outreach-invite`. It holds the variant
 * pool + system prompt the onboarding "review your drafts" step uses to
 * pre-fill LinkedIn invites (AC #1/#3). Admins edit it from the
 * partner-portal "Prompt Templates" tab; the customer app fetches it via
 * `GET /api/onboarding/outreach/invite-template` and interpolates the
 * variants client-side.
 *
 * Mirrors the global-image-directives idiom in promptTemplatesService:
 *   cache → Dynamo → seed-from-constants (best-effort seed write), never
 *   throws on read, save bumps `version` and invalidates the cache.
 *
 * Table: Dev-AW-PromptTemplates (or AW-PromptTemplates in prod).
 *   PK: templateId = "onboarding-outreach-invite"
 */

import AWS from "aws-sdk";
import {
  DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT,
  DEFAULT_OUTREACH_INVITE_WITH_COMPANY,
  DEFAULT_OUTREACH_INVITE_WITHOUT_COMPANY,
} from "./outreachInvitePromptDefaults";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TEMPLATES_TABLE = `${TABLE_PREFIX}AW-PromptTemplates`;

const docClient = new AWS.DynamoDB.DocumentClient();

export const OUTREACH_INVITE_TEMPLATE_ID = "onboarding-outreach-invite";

export interface OutreachInvitePromptRow {
  templateId: string;
  /** Bumped on every save. */
  version: string;
  /** Guidance / future-LLM system prompt. Not interpolated today. */
  systemPrompt: string;
  /** Variant templates used when the prospect has a company. */
  withCompanyVariants: string[];
  /** Variant templates used when the prospect has no company. */
  withoutCompanyVariants: string[];
  updatedAt: string;
  /** userId/email of the admin who last edited (or "system" for seed). */
  updatedBy: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { row: OutreachInvitePromptRow; loadedAt: number } | null = null;

function nowMs(): number {
  return Date.now();
}

function seedRow(): OutreachInvitePromptRow {
  return {
    templateId: OUTREACH_INVITE_TEMPLATE_ID,
    version: "v1-seed",
    systemPrompt: DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT,
    withCompanyVariants: [...DEFAULT_OUTREACH_INVITE_WITH_COMPANY],
    withoutCompanyVariants: [...DEFAULT_OUTREACH_INVITE_WITHOUT_COMPANY],
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
  };
}

/**
 * Normalise a persisted row: a hand-edited DynamoDB row could be missing a
 * field or have a non-array variant list. Fall back to the seed value for
 * anything malformed so the caller always gets a usable, non-empty pool.
 */
function normaliseRow(raw: any): OutreachInvitePromptRow {
  const seed = seedRow();
  const cleanList = (v: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(v)) return fallback;
    const list = v
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return list.length > 0 ? list : fallback;
  };
  return {
    templateId: OUTREACH_INVITE_TEMPLATE_ID,
    version:
      typeof raw?.version === "string" && raw.version.length > 0
        ? raw.version
        : seed.version,
    systemPrompt:
      typeof raw?.systemPrompt === "string" && raw.systemPrompt.trim().length > 0
        ? raw.systemPrompt
        : seed.systemPrompt,
    withCompanyVariants: cleanList(
      raw?.withCompanyVariants,
      seed.withCompanyVariants,
    ),
    withoutCompanyVariants: cleanList(
      raw?.withoutCompanyVariants,
      seed.withoutCompanyVariants,
    ),
    updatedAt:
      typeof raw?.updatedAt === "string" ? raw.updatedAt : seed.updatedAt,
    updatedBy:
      typeof raw?.updatedBy === "string" ? raw.updatedBy : seed.updatedBy,
  };
}

/**
 * Read the outreach invite prompt row. cache → Dynamo → seed-from-constants
 * (best-effort seed write). Never throws — the onboarding flow must degrade
 * to the constants if Dynamo is unreachable.
 */
export async function getOutreachInvitePrompt(): Promise<OutreachInvitePromptRow> {
  if (cache && nowMs() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.row;
  }
  let row: OutreachInvitePromptRow | null = null;
  try {
    const resp = await docClient
      .get({
        TableName: TEMPLATES_TABLE,
        Key: { templateId: OUTREACH_INVITE_TEMPLATE_ID },
      })
      .promise();
    if (resp.Item) row = normaliseRow(resp.Item);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[outreachInvitePromptService] get failed; using seed",
      { error: e instanceof Error ? e.message : String(e) },
    );
  }
  if (!row) {
    row = seedRow();
    try {
      await docClient
        .put({
          TableName: TEMPLATES_TABLE,
          Item: row,
          ConditionExpression: "attribute_not_exists(templateId)",
        })
        .promise();
    } catch (e: any) {
      if (e?.code !== "ConditionalCheckFailedException") {
        // eslint-disable-next-line no-console
        console.warn("[outreachInvitePromptService] seed write failed", {
          error: e?.message ?? String(e),
        });
      }
      // If we lost the race, re-read so we return the row that won.
      try {
        const reread = await docClient
          .get({
            TableName: TEMPLATES_TABLE,
            Key: { templateId: OUTREACH_INVITE_TEMPLATE_ID },
          })
          .promise();
        if (reread.Item) row = normaliseRow(reread.Item);
      } catch {
        // best-effort; fall back to seeded row
      }
    }
  }
  cache = { row, loadedAt: nowMs() };
  return row;
}

export interface SaveOutreachInvitePromptInput {
  systemPrompt?: string;
  withCompanyVariants?: string[];
  withoutCompanyVariants?: string[];
  updatedBy: string;
}

/** Bump version string. Format: vN-YYYY-MM-DD. */
function bumpVersion(prev: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const m = /^v(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(prev);
  if (m && m[2] === today) {
    return `v${Number(m[1]) + 1}-${today}`;
  }
  return `v1-${today}`;
}

/**
 * Read the current row straight from DynamoDB, bypassing the cache, along with
 * the raw stored `version` string used as the optimistic-concurrency token.
 * `raw` is null when no row exists yet (so the caller conditions on
 * attribute_not_exists). Never throws — degrades to the seed row.
 */
async function fetchRowForSave(): Promise<{
  raw: any | null;
  row: OutreachInvitePromptRow;
}> {
  try {
    const resp = await docClient
      .get({
        TableName: TEMPLATES_TABLE,
        Key: { templateId: OUTREACH_INVITE_TEMPLATE_ID },
      })
      .promise();
    if (resp.Item) return { raw: resp.Item, row: normaliseRow(resp.Item) };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[outreachInvitePromptService] save read failed; using seed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { raw: null, row: seedRow() };
}

/**
 * Overwrite the row, merging only the provided fields, bumping `version`.
 * Empty/whitespace-only variant lists are rejected upstream by the route;
 * here we defensively fall back to existing values for anything absent.
 *
 * Concurrency-safe: reads the CURRENT row fresh (not the 5-minute cache) and
 * writes it back under a version-guarded `ConditionExpression`, so a save that
 * merged onto a stale row can never clobber a concurrent admin edit — it loses
 * the conditional write, re-reads the winner, and retries once, merging its own
 * change on top. Without this, two admins (or two instances) saving within the
 * cache window would silently revert one another.
 */
export async function saveOutreachInvitePrompt(
  input: SaveOutreachInvitePromptInput,
): Promise<OutreachInvitePromptRow> {
  const cleanList = (v: string[] | undefined): string[] | undefined => {
    if (v === undefined) return undefined;
    const list = v
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return list.length > 0 ? list : undefined;
  };

  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { raw, row: existing } = await fetchRowForSave();
    const next: OutreachInvitePromptRow = {
      templateId: OUTREACH_INVITE_TEMPLATE_ID,
      systemPrompt:
        typeof input.systemPrompt === "string" &&
        input.systemPrompt.trim().length > 0
          ? input.systemPrompt
          : existing.systemPrompt,
      withCompanyVariants:
        cleanList(input.withCompanyVariants) ?? existing.withCompanyVariants,
      withoutCompanyVariants:
        cleanList(input.withoutCompanyVariants) ??
        existing.withoutCompanyVariants,
      version: bumpVersion(existing.version),
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy,
    };

    // Guard the write so we only overwrite the exact row we merged onto. The
    // stored `version` is the concurrency token; our own writes always set it,
    // so a row without one is either brand-new or corrupt. In that case we
    // guard on the version staying ABSENT (`attribute_not_exists(version)`) —
    // the first writer stamps a version and any concurrent versionless save
    // then fails the condition, retries, and re-reads the real token. Guarding
    // on mere `attribute_exists(templateId)` would give the versionless case no
    // protection at all, letting concurrent saves silently clobber each other.
    const hasVersionToken =
      raw && raw.version !== undefined && raw.version !== null;
    const guard = !raw
      ? { ConditionExpression: "attribute_not_exists(templateId)" }
      : hasVersionToken
        ? {
            ConditionExpression: "version = :expected",
            ExpressionAttributeValues: { ":expected": raw.version },
          }
        : { ConditionExpression: "attribute_not_exists(version)" };

    try {
      await docClient
        .put({ TableName: TEMPLATES_TABLE, Item: next, ...guard })
        .promise();
      cache = { row: next, loadedAt: nowMs() };
      return next;
    } catch (e: any) {
      // Lost the race: another writer changed the row. Re-read and retry once.
      if (
        e?.code === "ConditionalCheckFailedException" &&
        attempt < MAX_ATTEMPTS - 1
      ) {
        continue;
      }
      throw e;
    }
  }
  /* istanbul ignore next — unreachable: the loop always returns or throws. */
  throw new Error("saveOutreachInvitePrompt: exhausted retries");
}

/** For tests only — drop the in-memory cache. */
export function _clearCacheForTests(): void {
  cache = null;
}
