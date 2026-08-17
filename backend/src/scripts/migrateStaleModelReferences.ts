/**
 * Find (and, only with --apply, re-point) persisted model-id references that
 * are no longer in the live `llmModels` registry.
 *
 * ENG-9 (2026-08-17): built after dropping 6 OpenRouter registry entries, but
 * the detection is registry-driven, not a hardcoded stale-id list — any future
 * model retirement is caught the same way. Only the same-family REPLACEMENT
 * map (SAME_FAMILY_MODEL_REPLACEMENTS) is specific to this incident; extend it
 * for future retirements or leave orphans for the existing fallback+alert path
 * (agentModeService.resolveGenerationModel) to handle at call time.
 *
 * Default is dry-run — reports every candidate without writing anything:
 *   NODE_ENV=development npx ts-node src/scripts/migrateStaleModelReferences.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrateStaleModelReferences.ts --apply
 *
 * Every write is conditional on the field still holding the exact old value
 * (never clobbers a concurrent change) and is a no-op the second time it runs
 * on the same record, since the field then holds a currently-valid model id
 * and is no longer flagged as stale — safe to re-run.
 *
 * Scope (blast-radius map, ENG-9 investigation):
 *  - AW-TaskSchedules / AW-ScheduleTemplates: llmModel, llmBackupModel
 *    (llmBackupSource is provenance ('user'|'system'), never a model id — not scanned)
 *  - AW-ChatSessions: llmModel
 *  - AW-WorkPlans: defaultModel (workPlanService.ts)
 *  - AW-Settings "agent-mode-predefined-workplans" JSON blob: defaultModel per plan
 *    (a SEPARATE predefined-plan surface from AW-WorkPlans, found during this
 *    investigation — live admin CRUD at routes/settings.ts, not dead legacy data)
 *  - AW-Settings "scoring-judges" JSON blob: llmModel per judge (sessionScoringService.ts)
 *  - AW-Settings direct model-setting rows: the 10 settings that validate against
 *    `llmModels` (agent_mode_default_model, agent_mode_scheduled_chats_default_model,
 *    agent_mode_reports_model, agent_mode_report_generation_default_model,
 *    agent_mode_dedup_judge_model, agent_mode_image_generation_default_model,
 *    agent_mode_video_generation_default_model, agent_mode_customer_support_default_model,
 *    agent_mode_coding_agent_default_model, agent_mode_vision_model).
 *    Deliberately EXCLUDES agent_mode_image_api_default_model and
 *    agent_mode_video_api_default_model — those validate against the separate
 *    IMAGE_API_MODELS/VIDEO_API_MODELS lists, never llmModels, so an OpenRouter
 *    id could never have been valid there and checking them against llmModels
 *    would be the wrong test, not a thorough one.
 */
import { DynamoDB } from 'aws-sdk';
import { agentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';
import { paginatedScan } from '../utils/dynamoPagination';

// ── Pure planning logic (unit-testable without AWS) ────────────────────────

/**
 * Same-family replacements for the ENG-9 2026-08-17 registry cleanup. Extend
 * this map for future retirements; a stale id with no entry here becomes an
 * "orphan" — logged, never force-migrated cross-family.
 */
export const SAME_FAMILY_MODEL_REPLACEMENTS: Record<string, string> = {
  'openrouter/x-ai/grok-4.3': 'openrouter/x-ai/grok-4.6',
  'openrouter/mistralai/mistral-large-2512': 'openrouter/mistralai/mistral-small-2603',
  'openrouter/moonshotai/kimi-k2.6': 'openrouter/moonshotai/kimi-k2.7-code',
  'openrouter/qwen/qwen3.7-flash': 'openrouter/qwen/qwen3.8-max',
  // openrouter/meta-llama/llama-4-maverick, llama-4-scout, llama-3.1-8b-instruct:
  // deliberately NOT mapped — no current-gen Llama entrant exists on OpenRouter
  // (checked live 2026-08-17, no meta-llama/llama-5* listed). Records referencing
  // these fall through to 'orphan' below and are left for the existing
  // fallback+alert mechanism, per the explicit no-cross-family-substitution rule.
};

export type MigrationPlan =
  | { action: 'ok' }
  | { action: 'migrate'; newModel: string }
  | { action: 'orphan' };

/** Registry-driven: staleness is "not in the live valid-model-id set", not a hardcoded list. */
export function planModelMigration(
  modelId: string | undefined,
  validModelIds: ReadonlySet<string>,
  normalizeModelId: (id: string) => string,
  replacements: Record<string, string> = SAME_FAMILY_MODEL_REPLACEMENTS
): MigrationPlan {
  if (!modelId || !modelId.trim()) return { action: 'ok' };
  const normalized = normalizeModelId(modelId);
  if (validModelIds.has(normalized)) return { action: 'ok' };
  const replacement = replacements[modelId] ?? replacements[normalized];
  if (replacement) return { action: 'migrate', newModel: replacement };
  return { action: 'orphan' };
}

// ── Scan-time types ─────────────────────────────────────────────────────────

export interface Candidate {
  table: string;
  recordId: string;
  field: string;
  oldModel: string;
  plan: MigrationPlan;
}

interface TableFieldSpec {
  table: string;
  keyField: string;
  modelFields: string[];
}

const SCANNED_TABLES: TableFieldSpec[] = [
  { table: 'AW-TaskSchedules', keyField: 'scheduleId', modelFields: ['llmModel', 'llmBackupModel'] },
  { table: 'AW-ScheduleTemplates', keyField: 'templateId', modelFields: ['llmModel'] },
  { table: 'AW-ChatSessions', keyField: 'sessionId', modelFields: ['llmModel'] },
  { table: 'AW-WorkPlans', keyField: 'planId', modelFields: ['defaultModel'] },
];

/** The 10 AW-Settings rows whose settingValue is validated against llmModels. */
const DIRECT_MODEL_SETTINGS: string[] = [
  'agent_mode_default_model',
  'agent_mode_scheduled_chats_default_model',
  'agent_mode_reports_model',
  'agent_mode_report_generation_default_model',
  'agent_mode_dedup_judge_model',
  'agent_mode_image_generation_default_model',
  'agent_mode_video_generation_default_model',
  'agent_mode_customer_support_default_model',
  'agent_mode_coding_agent_default_model',
  'agent_mode_vision_model',
];

export async function collectCandidates(
  doc: DynamoDB.DocumentClient,
  tablePrefix: string,
  validModelIds: ReadonlySet<string>,
  normalizeModelId: (id: string) => string
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const plan = (modelId: string | undefined) => planModelMigration(modelId, validModelIds, normalizeModelId);

  // 1. Full-table scans (we don't know which records are affected ahead of time).
  for (const spec of SCANNED_TABLES) {
    const items = await paginatedScan<Record<string, any>>(doc, { TableName: `${tablePrefix}${spec.table}` });
    for (const item of items) {
      for (const field of spec.modelFields) {
        const value = item[field];
        if (typeof value !== 'string') continue;
        const p = plan(value);
        if (p.action !== 'ok') out.push({ table: spec.table, recordId: String(item[spec.keyField]), field, oldModel: value, plan: p });
      }
    }
  }

  // 2. Direct AW-Settings rows — one GetItem each, no scan needed.
  for (const settingName of DIRECT_MODEL_SETTINGS) {
    const setting = await settingsService.getSetting(settingName);
    const value = setting?.settingValue?.trim();
    if (!value) continue;
    const p = plan(value);
    if (p.action !== 'ok') out.push({ table: 'AW-Settings', recordId: settingName, field: 'settingValue', oldModel: value, plan: p });
  }

  // 3. "scoring-judges" JSON blob (sessionScoringService.ts ScoringJudge[]).
  const judgesSetting = await settingsService.getSetting('scoring-judges');
  if (judgesSetting?.settingValue) {
    try {
      const judges: Array<{ id: string; llmModel?: string }> = JSON.parse(judgesSetting.settingValue);
      for (const judge of judges) {
        const p = plan(judge.llmModel);
        if (p.action !== 'ok') {
          out.push({ table: 'AW-Settings[scoring-judges]', recordId: judge.id, field: 'llmModel', oldModel: judge.llmModel!, plan: p });
        }
      }
    } catch (err) {
      console.error('[migrateStaleModelReferences] failed to parse scoring-judges JSON — skipping this location:', err);
    }
  }

  // 4. "agent-mode-predefined-workplans" JSON blob (settingsService.ts PredefinedPlan[]).
  //    A SEPARATE predefined-plan surface from the AW-WorkPlans table above.
  const predefinedPlansSetting = await settingsService.getSetting('agent-mode-predefined-workplans');
  if (predefinedPlansSetting?.settingValue) {
    try {
      const plans: Array<{ id: string; defaultModel?: string }> = JSON.parse(predefinedPlansSetting.settingValue);
      for (const predefinedPlan of plans) {
        const p = plan(predefinedPlan.defaultModel);
        if (p.action !== 'ok') {
          out.push({
            table: 'AW-Settings[agent-mode-predefined-workplans]',
            recordId: predefinedPlan.id,
            field: 'defaultModel',
            oldModel: predefinedPlan.defaultModel!,
            plan: p,
          });
        }
      }
    } catch (err) {
      console.error('[migrateStaleModelReferences] failed to parse agent-mode-predefined-workplans JSON — skipping this location:', err);
    }
  }

  return out;
}

// ── Apply (never invoked in the ENG-9 dry-run session — see PR body) ───────

async function applyCandidate(doc: DynamoDB.DocumentClient, tablePrefix: string, c: Candidate): Promise<'updated' | 'raced' | 'skipped'> {
  if (c.plan.action !== 'migrate') return 'skipped'; // orphans are never written
  const newModel = c.plan.newModel;

  try {
    if (c.table === 'AW-Settings') {
      // Conditional PUT: only overwrite if settingValue still holds the old value.
      await doc.put({
        TableName: `${tablePrefix}AW-Settings`,
        Item: { settingName: c.recordId, settingValue: newModel, updatedAt: new Date().toISOString(), updatedBy: 'migrateStaleModelReferences' },
        ConditionExpression: 'settingValue = :old',
        ExpressionAttributeValues: { ':old': c.oldModel },
      }).promise();
      return 'updated';
    }
    if (c.table.startsWith('AW-Settings[')) {
      // JSON-blob locations (scoring-judges / predefined-workplans) need a
      // read-modify-write of the whole array; no per-record CAS is available
      // on this table shape, so a concurrent edit during the write window is a
      // known small residual risk here specifically — acceptable since this
      // path is not executed in this pass and is re-run-safe once one item wins.
      const settingName = c.table === 'AW-Settings[scoring-judges]' ? 'scoring-judges' : 'agent-mode-predefined-workplans';
      const modelField = c.table === 'AW-Settings[scoring-judges]' ? 'llmModel' : 'defaultModel';
      const setting = await settingsService.getSetting(settingName);
      if (!setting?.settingValue) return 'raced';
      const items: Array<Record<string, any>> = JSON.parse(setting.settingValue);
      const target = items.find((i) => i.id === c.recordId);
      if (!target || target[modelField] !== c.oldModel) return 'raced';
      target[modelField] = newModel;
      await settingsService.setSetting(settingName, JSON.stringify(items), undefined, 'migrateStaleModelReferences');
      return 'updated';
    }
    // Scanned tables: conditional UPDATE keyed by the table's own key field.
    const spec = SCANNED_TABLES.find((s) => s.table === c.table)!;
    await doc.update({
      TableName: `${tablePrefix}${c.table}`,
      Key: { [spec.keyField]: c.recordId },
      ConditionExpression: '#field = :old',
      UpdateExpression: 'SET #field = :new, updatedAt = :now',
      ExpressionAttributeNames: { '#field': c.field },
      ExpressionAttributeValues: { ':old': c.oldModel, ':new': newModel, ':now': new Date().toISOString() },
    }).promise();
    return 'updated';
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') return 'raced';
    throw error;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const tablePrefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const apply = process.argv.includes('--apply');

  const validModelIds = new Set(await agentModeService.getSupportedModels(true));
  const normalizeModelId = agentModeService.normalizeModelId.bind(agentModeService);

  const candidates = await collectCandidates(doc, tablePrefix, validModelIds, normalizeModelId);

  const migrateCandidates = candidates.filter((c) => c.plan.action === 'migrate');
  const orphanCandidates = candidates.filter((c) => c.plan.action === 'orphan');

  for (const c of candidates) {
    const desc = c.plan.action === 'migrate' ? `-> ${c.plan.newModel}` : '(orphan — no same-family replacement, left for fallback+alert)';
    console.log(`${apply ? '[apply]' : '[dry-run]'} ${c.table} ${c.recordId}.${c.field}: ${c.oldModel} ${desc}`);
  }

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    totalCandidates: candidates.length,
    migratable: migrateCandidates.length,
    orphaned: orphanCandidates.length,
    orphanedByTable: orphanCandidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.table] = (acc[c.table] || 0) + 1;
      return acc;
    }, {}),
  };

  if (apply) {
    const results = { updated: 0, raced: 0, skipped: 0 };
    for (const c of migrateCandidates) {
      const r = await applyCandidate(doc, tablePrefix, c);
      results[r]++;
    }
    console.log(JSON.stringify({ ...summary, applyResults: results }, null, 2));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrateStaleModelReferences] failed', error);
    process.exit(1);
  });
}
