/**
 * Prompt template store — DynamoDB-backed, admin-editable.
 *
 * Each Brick 5 archetype (A-L) is a single row. Edits from the partner
 * portal overwrite the row and bump `version` so every variant we
 * generate carries the version that produced it (see PromptSignals).
 *
 * The seed values come from `brick5Archetypes.ts` and are written into
 * the table on first read of any missing template (`seedDefaultsIfMissing`).
 * After the first read, edits flow through `saveTemplate`.
 *
 * Read path is cached in-memory for 5 minutes so the prompt builder
 * doesn't hit Dynamo on every variant generation. Writes invalidate the
 * cache.
 *
 * Table: Dev-AW-PromptTemplates (or AW-PromptTemplates in prod).
 *   PK: templateId (e.g. "archetype-A")
 *   No sort key — single row per archetype, edits overwrite.
 */

import AWS from "aws-sdk";
import {
  ARCHETYPES,
  type Archetype,
  type ArchetypeTemplate,
} from "./brick5Archetypes";

const TABLE_PREFIX =
  process.env.NODE_ENV === "development" ? "Dev-" : "";
const TEMPLATES_TABLE = `${TABLE_PREFIX}AW-PromptTemplates`;

const docClient = new AWS.DynamoDB.DocumentClient();

export interface PromptTemplateRow {
  /** "archetype-A" through "archetype-L". */
  templateId: string;
  /** Bumped on every saveTemplate. Used by PromptSignals attribution. */
  version: string;
  name: string;
  feedLayout: string;
  storyLayout: string;
  textBudget: string;
  updatedAt: string;
  /** userId of the admin who last edited (or "system" for seed). */
  updatedBy: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: Map<string, { row: PromptTemplateRow; loadedAt: number }> = new Map();

function nowMs(): number {
  return Date.now();
}

function templateIdFromArchetype(arch: Archetype): string {
  return `archetype-${arch}`;
}

function archetypeFromTemplateId(id: string): Archetype | null {
  const m = /^archetype-([A-L])$/.exec(id);
  return m ? (m[1] as Archetype) : null;
}

/**
 * Bootstrap a template row from the brick5Archetypes constants. Used
 * when a row is missing from the DB on first read.
 */
function seedRowFromConstants(arch: Archetype): PromptTemplateRow {
  const t: ArchetypeTemplate = ARCHETYPES[arch];
  return {
    templateId: templateIdFromArchetype(arch),
    version: "v1-seed",
    name: t.name,
    feedLayout: t.feedLayout,
    storyLayout: t.storyLayout,
    textBudget: t.textBudget,
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
  };
}

/**
 * Read a single template by archetype id. Falls through cache → Dynamo →
 * seed-from-constants. The seed write is best-effort; if it fails the
 * caller still gets a usable row from the constants.
 */
export async function getTemplateForArchetype(
  arch: Archetype,
): Promise<PromptTemplateRow> {
  const id = templateIdFromArchetype(arch);
  const cached = cache.get(id);
  if (cached && nowMs() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.row;
  }
  let row: PromptTemplateRow | null = null;
  try {
    const resp = await docClient
      .get({ TableName: TEMPLATES_TABLE, Key: { templateId: id } })
      .promise();
    if (resp.Item) row = resp.Item as PromptTemplateRow;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[promptTemplatesService] get failed; falling back to seed", {
      templateId: id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  if (!row) {
    // First-read seed.
    row = seedRowFromConstants(arch);
    try {
      await docClient
        .put({
          TableName: TEMPLATES_TABLE,
          Item: row,
          // Don't overwrite if a concurrent request seeded it first.
          ConditionExpression: "attribute_not_exists(templateId)",
        })
        .promise();
    } catch (e: any) {
      if (e?.code !== "ConditionalCheckFailedException") {
        // eslint-disable-next-line no-console
        console.warn("[promptTemplatesService] seed write failed", {
          templateId: id,
          error: e?.message ?? String(e),
        });
      }
      // If we lost the race, re-read so we return the row that won.
      try {
        const reread = await docClient
          .get({ TableName: TEMPLATES_TABLE, Key: { templateId: id } })
          .promise();
        if (reread.Item) row = reread.Item as PromptTemplateRow;
      } catch {
        // best-effort; fall back to seeded row
      }
    }
  }
  cache.set(id, { row, loadedAt: nowMs() });
  return row;
}

/**
 * Read all 12 archetype templates. Used by the partner-portal list view
 * and by the prompt builder when it needs to hydrate every archetype
 * for a generation run. Parallelised.
 */
export async function listAllTemplates(): Promise<PromptTemplateRow[]> {
  const archs = Object.keys(ARCHETYPES) as Archetype[];
  const rows = await Promise.all(archs.map((a) => getTemplateForArchetype(a)));
  return rows;
}

export interface SaveTemplateInput {
  templateId: string;
  name?: string;
  feedLayout?: string;
  storyLayout?: string;
  textBudget?: string;
  /** Admin user id doing the save. Stamped on the row for audit. */
  updatedBy: string;
}

/**
 * Overwrite a template row. Bumps `version` to a fresh
 * `vN-{ISO-date}` string so every variant generated after this edit
 * carries the new version stamp (and the old version's signals stay
 * attributed correctly).
 *
 * Returns the persisted row.
 */
export async function saveTemplate(
  input: SaveTemplateInput,
): Promise<PromptTemplateRow> {
  const arch = archetypeFromTemplateId(input.templateId);
  if (!arch) {
    throw new Error(
      `invalid templateId "${input.templateId}" — must be archetype-A..L`,
    );
  }
  // Read current to get existing fields + last version.
  const existing = await getTemplateForArchetype(arch);
  const next: PromptTemplateRow = {
    templateId: input.templateId,
    name: input.name ?? existing.name,
    feedLayout: input.feedLayout ?? existing.feedLayout,
    storyLayout: input.storyLayout ?? existing.storyLayout,
    textBudget: input.textBudget ?? existing.textBudget,
    version: bumpVersion(existing.version),
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };
  await docClient
    .put({ TableName: TEMPLATES_TABLE, Item: next })
    .promise();
  cache.set(input.templateId, { row: next, loadedAt: nowMs() });
  return next;
}

/**
 * Bump version string. Format: vN-YYYY-MM-DD. Increments N if the date
 * matches today's date, otherwise resets to v1 for today.
 */
function bumpVersion(prev: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const m = /^v(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(prev);
  if (m && m[2] === today) {
    const n = Number(m[1]);
    return `v${n + 1}-${today}`;
  }
  return `v1-${today}`;
}

/** For tests only — drop the in-memory cache. */
export function _clearCacheForTests(): void {
  cache = new Map();
}
