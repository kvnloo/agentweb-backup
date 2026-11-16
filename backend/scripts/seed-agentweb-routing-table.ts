/**
 * ENG-669 PR-C switch-on: validate an AgentWeb Model routing table and (only with --apply) write it to the AW-Settings
 * row `agentweb_model_routing_table`.
 *
 * Usage (from backend/; NODE_ENV is required: production = AW-Settings, development = Dev-AW-Settings):
 *   NODE_ENV=production npx ts-node scripts/seed-agentweb-routing-table.ts <table.json>            # dry run
 *   NODE_ENV=production npx ts-node scripts/seed-agentweb-routing-table.ts <table.json> --apply    # write it
 *
 * AWS: the settings service's DynamoDB client, i.e. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN) when
 * both are set, else the SDK's default chain (AWS_PROFILE, ~/.aws, instance role); region AWS_REGION, default us-west-2.
 * backend/.env is loaded (it never overrides a variable already set). The target table is printed before anything else.
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
 * The logic is services/agentMode/agentWebRoutingTableSeed.ts (tested); this file only wires it to AWS.
 */
import { readFileSync } from 'fs';
import { settingsService } from '../src/services/settingsService';
import { registryRouterCatalog } from '../src/services/agentMode/agentWebModelRouterInstance';
import { listSubscriptionTiers } from '../src/services/agentMode/modelAccessInstance';
import { resolveLegacyModelAlias } from '../src/services/agentMode/modelAccess';
import { seedRoutingTable } from '../src/services/agentMode/agentWebRoutingTableSeed';

if (require.main === module) {
  seedRoutingTable(process.argv.slice(2), {
    nodeEnv: process.env.NODE_ENV,
    tableName: settingsService.getTableName(),
    region: process.env.AWS_REGION || 'us-west-2',
    readFile: (path) => readFileSync(path, 'utf8'),
    listTiers: listSubscriptionTiers,
    catalog: registryRouterCatalog,
    normalizeModelId: resolveLegacyModelAlias,
    getSetting: (name) => settingsService.getSetting(name),
    setSettingIfAbsent: (name, value, description, updatedBy) => settingsService.setSettingIfAbsent(name, value, description, updatedBy),
    setSettingIfValueMatches: (name, value, expected, description, updatedBy) =>
      settingsService.setSettingIfValueMatches(name, value, expected, description, updatedBy),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`seed-agentweb-routing-table failed: ${error?.message || error}`);
      process.exit(1);
    });
}
