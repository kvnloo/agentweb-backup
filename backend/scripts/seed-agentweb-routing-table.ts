/**
 * ENG-669 PR-C switch-on: validate an AgentWeb Model routing table and (only with --apply) write it to the AW-Settings
 * row `agentweb_model_routing_table`.
 *
 * Usage (from backend/):
 *   NODE_ENV=production npx ts-node scripts/seed-agentweb-routing-table.ts <table.json>            # dry run
 *   NODE_ENV=production npx ts-node scripts/seed-agentweb-routing-table.ts <table.json> --apply    # write it
 *
 * The dry run reads the `subscription_types` setting and prints what the router would make of the table, using the
 * router's own validator (agentWebModelRouter.parseRoutingTable / checkTiers / routeFor): whether the table is usable at
 * all, and for every tier (and for an owner with no tier override) the model and rule of each task type, with every
 * route or tier the router would refuse and why. Tiers are judged as if `model_tier_allowlist_enabled` were on.
 *
 * --apply writes only a table that is valid for EVERY tier, and only with a compare-and-set on the value it read, so a
 * concurrent edit makes the run fail (exit 2) instead of being overwritten: rerun to retry. It never touches the
 * router switch (`agentweb_model_router_enabled`): write the table first, check the logs for
 * "AgentWebModel: routing table loaded", then turn the switch on.
 *
 * Exit codes: 0 valid (and written with --apply), 1 invalid or failed, 2 the row changed while this ran.
 */
import { readFileSync } from 'fs';
import { settingsService } from '../src/services/settingsService';
import { AGENTWEB_MODEL_ROUTING_TABLE_SETTING } from '../src/services/agentMode/agentWebModelRouter';
import { registryRouterCatalog } from '../src/services/agentMode/agentWebModelRouterInstance';
import { listSubscriptionTiers } from '../src/services/agentMode/modelAccessInstance';
import { resolveLegacyModelAlias } from '../src/services/agentMode/modelAccess';
import { describeRoutingTable, formatRoutingTableReport } from '../src/services/agentMode/agentWebRoutingTableReport';

const DESCRIPTION = 'AgentWeb Model routing table (ENG-669 PR-C): task type -> model, with per-tier overrides';

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const files = argv.filter((arg) => !arg.startsWith('--'));
  if (files.length !== 1) {
    console.error('Usage: npx ts-node scripts/seed-agentweb-routing-table.ts <table.json> [--apply]');
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(files[0], 'utf8'));
  } catch (error) {
    console.error(`Could not read ${files[0]} as JSON: ${(error as Error).message}`);
    return 1;
  }
  const tiers = await listSubscriptionTiers();
  const report = describeRoutingTable(raw, tiers, registryRouterCatalog, resolveLegacyModelAlias);
  console.log(formatRoutingTableReport(report));
  if (!report.usable || !report.ok) {
    console.error(`\nNot written: fix the table${apply ? '' : ' before running with --apply'}.`);
    return 1;
  }
  if (!apply) {
    console.log(`\nDry run: nothing written. Rerun with --apply to write ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING}.`);
    return 0;
  }
  // Stored as the file's JSON (the router parses and canonicalises it on load), compactly.
  const next = JSON.stringify(raw);
  const current = await settingsService.getSetting(AGENTWEB_MODEL_ROUTING_TABLE_SETTING);
  const currentValue = current?.settingValue;
  if (currentValue === next) {
    console.log(`\n${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} already holds this table; no change.`);
    return 0;
  }
  if (typeof currentValue !== 'string') {
    const created = await settingsService.setSettingIfAbsent(AGENTWEB_MODEL_ROUTING_TABLE_SETTING, next, DESCRIPTION, 'seed-agentweb-routing-table');
    if (!created) {
      console.error(`\n${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} was created while this ran; rerun.`);
      return 2;
    }
  } else {
    await settingsService.setSettingIfValueMatches(
      AGENTWEB_MODEL_ROUTING_TABLE_SETTING, next, currentValue, current?.description ?? DESCRIPTION, 'seed-agentweb-routing-table',
    );
  }
  console.log(`\nWrote ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} (version ${report.version}). The router reloads it within ~60s; `
    + 'check the logs for "AgentWebModel: routing table loaded" before turning agentweb_model_router_enabled on.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const raced = error?.code === 'ConditionalCheckFailedException';
      console.error(raced
        ? `${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} changed while this ran; rerun.`
        : `seed-agentweb-routing-table failed: ${error?.message || error}`);
      process.exit(raced ? 2 : 1);
    });
}
