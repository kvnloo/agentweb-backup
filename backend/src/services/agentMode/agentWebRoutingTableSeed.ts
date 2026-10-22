/**
 * ENG-669 PR-C switch-on: the body of backend/scripts/seed-agentweb-routing-table.ts (see its header for usage), with
 * its I/O passed in so every path is testable without AWS.
 *
 *  - Dry run by default: prints what the router would make of the table (agentWebRoutingTableReport) and writes nothing.
 *  - `--apply` writes only a table that is valid for EVERY tier, with a compare-and-set on the value it read (absent:
 *    create-if-absent), so a concurrent edit fails (exit 2) instead of being overwritten.
 *  - It reads `subscription_types` and reads/writes `agentweb_model_routing_table` only: never the router switch.
 *  - The AW-Settings table follows NODE_ENV (settingsService: 'development' = Dev-AW-Settings, anything else = the
 *    PRODUCTION table), so NODE_ENV must be set explicitly to 'production' or 'development' and the target table is
 *    printed first: a forgotten or mistyped NODE_ENV (e.g. 'staging', which also maps to production) is refused.
 *
 * Exit codes: 0 valid (and written, or already held, with --apply), 1 invalid or failed, 2 the row changed while this ran.
 */
import { AGENTWEB_MODEL_ROUTING_TABLE_SETTING, type RouterModelCatalog } from './agentWebModelRouter';
import { describeRoutingTable, formatRoutingTableReport } from './agentWebRoutingTableReport';
import type { TierModelsConfig } from './modelAccess';

export const ROUTING_TABLE_DESCRIPTION = 'AgentWeb Model routing table (ENG-669 PR-C): task type -> model, with per-tier overrides';
const UPDATED_BY = 'seed-agentweb-routing-table';

export interface RoutingTableSeedDeps {
  nodeEnv: string | undefined;
  /** The AW-Settings table the settings service reads and writes, and the AWS region. */
  tableName: string;
  region: string;
  readFile(path: string): string;
  listTiers(): Promise<TierModelsConfig[]>;
  catalog: RouterModelCatalog;
  normalizeModelId(id: string): string;
  getSetting(name: string): Promise<{ settingValue?: unknown; description?: string } | null>;
  setSettingIfAbsent(name: string, value: string, description: string, updatedBy: string): Promise<boolean>;
  /** Throws ConditionalCheckFailedException when the row no longer holds `expected`. */
  setSettingIfValueMatches(name: string, value: string, expected: string, description: string, updatedBy: string): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}

export async function seedRoutingTable(argv: readonly string[], deps: RoutingTableSeedDeps): Promise<0 | 1 | 2> {
  const apply = argv.includes('--apply');
  const files = argv.filter((arg) => !arg.startsWith('--'));
  const unknownFlags = argv.filter((arg) => arg.startsWith('--') && arg !== '--apply');
  if (files.length !== 1 || unknownFlags.length > 0) {
    deps.err('Usage: NODE_ENV=production|development npx ts-node scripts/seed-agentweb-routing-table.ts <table.json> [--apply]');
    return 1;
  }
  if (deps.nodeEnv !== 'production' && deps.nodeEnv !== 'development') {
    deps.err(`NODE_ENV is ${deps.nodeEnv === undefined ? 'not set' : `"${deps.nodeEnv}"`}: set NODE_ENV=production (AW-Settings) or `
      + 'NODE_ENV=development (Dev-AW-Settings) explicitly. Anything else would use the production table.');
    return 1;
  }
  deps.out(`Target: ${deps.tableName} (NODE_ENV=${deps.nodeEnv}, region ${deps.region})${apply ? '' : ', dry run'}\n`);
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFile(files[0]));
  } catch (error) {
    deps.err(`Could not read ${files[0]} as JSON: ${(error as Error).message}`);
    return 1;
  }
  const tiers = await deps.listTiers();
  if (tiers.length === 0) {
    // In every real environment subscription_types lists the tiers; none read means no tier allowlist can be checked
    // (or the wrong table), so nothing is written on that basis.
    deps.err(`No subscription tiers were read from subscription_types in ${deps.tableName}: no tier can be checked`
      + `${apply ? '; refusing --apply.' : '.'}`);
    if (apply) return 1;
  }
  const report = describeRoutingTable(raw, tiers, deps.catalog, deps.normalizeModelId);
  deps.out(formatRoutingTableReport(report));
  if (!report.usable || !report.ok) {
    deps.err(`\nNot written: fix the table${apply ? '' : ' before running with --apply'}.`);
    return 1;
  }
  if (!apply) {
    deps.out(`\nDry run: nothing written. Rerun with --apply to write ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} to ${deps.tableName}.`);
    return 0;
  }
  // Stored as the file's JSON (the router parses and canonicalises it on load), compactly.
  const next = JSON.stringify(raw);
  const current = await deps.getSetting(AGENTWEB_MODEL_ROUTING_TABLE_SETTING);
  const currentValue = current?.settingValue;
  if (currentValue === next) {
    deps.out(`\n${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} already holds this table; no change.`);
    return 0;
  }
  try {
    if (!current) {
      if (!(await deps.setSettingIfAbsent(AGENTWEB_MODEL_ROUTING_TABLE_SETTING, next, ROUTING_TABLE_DESCRIPTION, UPDATED_BY))) {
        deps.err(`\n${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} was created while this ran; rerun.`);
        return 2;
      }
    } else if (typeof currentValue === 'string') {
      await deps.setSettingIfValueMatches(
        AGENTWEB_MODEL_ROUTING_TABLE_SETTING, next, currentValue, current.description ?? ROUTING_TABLE_DESCRIPTION, UPDATED_BY,
      );
    } else {
      // A row with no string value cannot be compared-and-set; never overwrite it blindly.
      deps.err(`\n${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} exists without a string value; fix or delete that row first.`);
      return 1;
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 'ConditionalCheckFailedException') throw error;
    deps.err(`\n${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} changed while this ran; rerun.`);
    return 2;
  }
  deps.out(`\nWrote ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} (version ${report.version}) to ${deps.tableName}. The router reloads it `
    + 'within ~60s; check the logs for "AgentWebModel: routing table loaded" before turning agentweb_model_router_enabled on.');
  return 0;
}
