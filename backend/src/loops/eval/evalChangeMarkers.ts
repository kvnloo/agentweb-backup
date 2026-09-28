/**
 * "Needs eval" markers for prompt / model / skill changes made in the database (ENG-2145, D4).
 *
 * Many prompt and model changes never touch git: an admin edits an AW-Settings row (the agent
 * system prompt, a default model, a scoring judge) or an AW-Skills skill, and the change is live.
 * A PR-only eval gate cannot see those. Every such write records one `eval_needed` row in
 * Dev-AW-LoopEvents (loopId `eval-gate`), so the offline suite (offlineSuite.ts) can list the
 * changes made since its last run and nothing is invisible.
 *
 * Report-only: the marker never blocks or delays the write that caused it, and writing it is
 * best-effort (errors are logged, never thrown). It carries the setting name or skill id, what
 * kind of change it was and a short hash of the new value — never the prompt text itself.
 *
 * On by default; EVAL_CHANGE_MARKERS_ENABLED=false turns it off.
 */

import AWS from 'aws-sdk';
import { createHash, randomUUID } from 'crypto';
import { LOOP_EVENTS_TABLE, eventToItem } from '../core/sensors/eventTableEventSource';
import { asLoopId, asSubjectId, type LoopId } from '../core/types';
import type { DynamoAttributeMap } from '../core/ports';

export const EVAL_GATE_LOOP_ID: LoopId = asLoopId('eval-gate');
export const EVT_EVAL_NEEDED = 'eval_needed';
export const EVAL_CHANGE_MARKERS_FLAG = 'EVAL_CHANGE_MARKERS_ENABLED';

export type EvalChangeCategory = 'prompt' | 'model' | 'judge' | 'workplan' | 'skill' | 'tools';

/** AW-Settings rows whose value is a prompt, a model choice, a judge or a skill/tool allow-list.
 * Verified against the production setting names (read-only listing, 2026-09-26). */
const SETTING_CATEGORIES: Readonly<Record<string, EvalChangeCategory>> = {
  'agent_mode_system_prompt': 'prompt',
  'agent_mode_conversation_starters': 'prompt',
  'report_revision_system_instruction': 'prompt',
  'default-scoring-prompt': 'judge',
  'default-scoring-model': 'judge',
  'scoring-judges': 'judge',
  'agent-mode-predefined-workplans': 'workplan',
  'default_image_model': 'model',
  'supported_image_models': 'model',
  'public_allowed_skills': 'skill',
  'foundation_tools': 'tools',
};

/** `agent_mode_default_model`, `agent_mode_vision_model`, `agent_mode_reports_model`, ... */
const AGENT_MODE_MODEL_SETTING = /^agent_mode_[a-z0-9_]*model$/;

/** The eval category of an AW-Settings row, or null when a change to it cannot move agent quality. */
export function classifySettingChange(settingName: string): EvalChangeCategory | null {
  if (Object.prototype.hasOwnProperty.call(SETTING_CATEGORIES, settingName)) return SETTING_CATEGORIES[settingName];
  if (AGENT_MODE_MODEL_SETTING.test(settingName)) return 'model';
  return null;
}

export type EvalChangeAction = 'set' | 'delete' | 'create' | 'update' | 'approve' | 'sync';

export interface EvalChangeMarker {
  changeKind: 'setting' | 'skill';
  /** AW-Settings settingName or AW-Skills skillId. */
  target: string;
  category: EvalChangeCategory;
  action: EvalChangeAction;
  /** Which code path wrote it, e.g. `settingsService`, `admin skill route`. */
  via: string;
  /** Skill fields the write touched (skills only). */
  fields?: string[];
  /** The new value, hashed (first 12 hex chars of sha256); omitted for deletes. */
  value?: string;
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * One row per change. The sort key keeps eventToItem's `<ts>#<subject>#<eventType>` prefix (so
 * range reads by time still work) plus a random suffix: two writes to the same target in the same
 * millisecond must not overwrite each other.
 */
export function buildEvalNeededItem(marker: EvalChangeMarker, at: Date, unique: () => string = () => randomUUID().slice(0, 8)): DynamoAttributeMap {
  const item = eventToItem(EVAL_GATE_LOOP_ID, {
    subjectId: asSubjectId(`${marker.changeKind}:${marker.target}`),
    eventType: EVT_EVAL_NEEDED,
    ts: at,
    dimensions: {
      changeKind: marker.changeKind,
      target: marker.target,
      category: marker.category,
      action: marker.action,
      via: marker.via,
      ...(marker.fields ? { fields: marker.fields.join(',') } : {}),
      ...(marker.value !== undefined ? { valueSha: shortHash(marker.value) } : {}),
      gateMode: 'report_only',
    },
  });
  return { ...item, tsSession: `${String(item.tsSession)}#${unique()}` };
}

export type MarkerWriter = (item: DynamoAttributeMap) => Promise<void>;

let defaultWriter: MarkerWriter | undefined;
function loopEventsWriter(): MarkerWriter {
  if (!defaultWriter) {
    const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
    defaultWriter = async (item) => {
      await doc.put({ TableName: LOOP_EVENTS_TABLE, Item: item }).promise();
    };
  }
  return defaultWriter;
}

export function markersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVAL_CHANGE_MARKERS_FLAG] !== 'false';
}

/** Records one marker. Never throws; resolves true when a row was written. */
export async function recordEvalChange(
  marker: EvalChangeMarker,
  deps: { write?: MarkerWriter; now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  if (!markersEnabled(deps.env)) return false;
  try {
    await (deps.write ?? loopEventsWriter())(buildEvalNeededItem(marker, (deps.now ?? (() => new Date()))()));
    return true;
  } catch (error) {
    console.error('[evalChangeMarkers] failed to record eval_needed marker:', {
      target: `${marker.changeKind}:${marker.target}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** For AW-Settings writes: records a marker when the setting is eval-relevant, else does nothing. */
export async function recordSettingChange(
  settingName: string,
  action: 'set' | 'delete',
  value: string | undefined,
  deps: { write?: MarkerWriter; now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const category = classifySettingChange(settingName);
  if (!category) return false;
  return recordEvalChange({ changeKind: 'setting', target: settingName, category, action, via: 'settingsService', ...(value !== undefined ? { value } : {}) }, deps);
}

/** Skill fields whose change can move agent behaviour. */
export const EVAL_RELEVANT_SKILL_FIELDS = ['systemPrompt', 'toolNames', 'llmModel', 'isPublished', 'maxIterations'] as const;

/** The eval-relevant fields present in a skill write body. */
export function evalRelevantSkillFields(body: Readonly<Record<string, unknown>>): string[] {
  return EVAL_RELEVANT_SKILL_FIELDS.filter((f) => body[f] !== undefined);
}

/**
 * For admin skill writes. A create or update records a marker only when it touches an
 * eval-relevant field; delete, approve (a skill goes public) and sync always do.
 */
export async function recordSkillChange(
  skillId: string,
  action: Extract<EvalChangeAction, 'create' | 'update' | 'delete' | 'approve' | 'sync'>,
  body: Readonly<Record<string, unknown>>,
  deps: { write?: MarkerWriter; now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const fields = evalRelevantSkillFields(body);
  if ((action === 'create' || action === 'update') && fields.length === 0) return false;
  const prompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined;
  return recordEvalChange(
    { changeKind: 'skill', target: skillId, category: 'skill', action, via: 'admin skill route', ...(fields.length ? { fields } : {}), ...(prompt !== undefined ? { value: prompt } : {}) },
    deps,
  );
}

export interface EvalChangeMarkerRow {
  ts: string;
  subjectId: string;
  dimensions: Record<string, unknown>;
}

/** Read-only: `eval_needed` markers recorded since `sinceIso` (oldest first). */
export async function listEvalChangeMarkers(
  query: (params: AWS.DynamoDB.DocumentClient.QueryInput) => Promise<AWS.DynamoDB.DocumentClient.QueryOutput>,
  sinceIso: string,
): Promise<EvalChangeMarkerRow[]> {
  const rows: EvalChangeMarkerRow[] = [];
  let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await query({
      TableName: LOOP_EVENTS_TABLE,
      KeyConditionExpression: 'loopId = :l AND tsSession >= :since',
      ExpressionAttributeValues: { ':l': EVAL_GATE_LOOP_ID, ':since': sinceIso },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    });
    for (const item of page.Items ?? []) {
      if (item.eventType !== EVT_EVAL_NEEDED) continue;
      rows.push({ ts: String(item.ts), subjectId: String(item.subjectId), dimensions: (item.dimensions ?? {}) as Record<string, unknown> });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return rows;
}
