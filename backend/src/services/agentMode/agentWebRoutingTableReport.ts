/**
 * ENG-669 PR-C switch-on: a dry-run report of an AgentWeb Model routing table (AW-Settings
 * `agentweb_model_routing_table`) BEFORE it is written, judged by the router's own rules (parseRoutingTable, checkTiers,
 * routeFor), so an operator sees exactly what the router would make of it: whether the table is usable at all, and for
 * each subscription tier (and for an owner with no tier override) the model and rule of every task type, with every
 * route or tier the router would refuse and why. Used by backend/scripts/seed-agentweb-routing-table.ts.
 *
 * Pure (no service graph): the tiers and the model catalog are passed in.
 */
import {
  AGENTWEB_TASK_TYPES,
  checkTiers,
  parseRoutingTable,
  routeFor,
  type AgentWebTaskType,
  type RouterModelCatalog,
} from './agentWebModelRouter';
import type { TierModelsConfig } from './modelAccess';

export interface RouteReport {
  taskType: AgentWebTaskType;
  model: string;
  /** Which rule chose the model (routeFor's reason). */
  rule: string;
  /** Why the router refuses this route (an unusable target), else undefined. */
  refused?: string;
}

export interface TierReport {
  /** null = an owner whose tier has no override (or no tier): the table's own routes. */
  tier: string | null;
  /** False when the router is unavailable for this whole tier (`why`), or any of its routes is refused. */
  ok: boolean;
  /** Why the router is unavailable for the whole tier (a malformed override, or routes outside its allowlist). */
  why?: string;
  routes: RouteReport[];
}

export type RoutingTableReport =
  | { usable: false; errors: string[] }
  | {
      usable: true;
      version: string;
      /** True when every tier and every route is servable. */
      ok: boolean;
      tiers: TierReport[];
      /** Problems that take nothing down (an override naming no configured tier). */
      issues: string[];
    };

/**
 * What the router would make of `raw` (the parsed JSON) against these subscription tiers, judged as if the tier model
 * allowlist were on (the switch-on state: a tier listing `agentweb-model` must allow every model its routes use).
 */
export function describeRoutingTable(
  raw: unknown,
  tiers: readonly TierModelsConfig[],
  catalog: RouterModelCatalog,
  normalizeModelId: (id: string) => string,
): RoutingTableReport {
  const parsed = parseRoutingTable(raw, catalog);
  if (!parsed.ok) return { usable: false, errors: parsed.errors };
  const { table, invalidTargets, malformedTiers } = parsed;
  const checked = checkTiers(table, tiers, normalizeModelId, invalidTargets);
  const unavailable: Record<string, string> = { ...checked.unavailableTiers };
  for (const [tier, errors] of Object.entries(malformedTiers)) {
    unavailable[tier] = `has a malformed override in the routing table: ${errors.join('; ')}`;
  }
  const report = (tier: string | null): TierReport => {
    const why = tier ? unavailable[tier] : undefined;
    const routes = AGENTWEB_TASK_TYPES.map((taskType): RouteReport => {
      const { model, reason } = routeFor(table, tier, taskType);
      return { taskType, model, rule: reason, ...(invalidTargets[model] && { refused: invalidTargets[model] }) };
    });
    return { tier, ok: !why && routes.every((route) => !route.refused), ...(why && { why }), routes };
  };
  const tierNames = tiers.map((t) => t?.name).filter((name): name is string => typeof name === 'string');
  // A malformed override for a name no tier has still says something is wrong in the table: report it too.
  for (const name of Object.keys(malformedTiers)) if (!tierNames.includes(name)) tierNames.push(name);
  const reports = [report(null), ...tierNames.map(report)];
  return { usable: true, version: table.version, ok: reports.every((r) => r.ok), tiers: reports, issues: checked.issues };
}

/** The report as plain text, one tier per block, for the ops script's output. */
export function formatRoutingTableReport(report: RoutingTableReport): string {
  if (!report.usable) {
    return ['Routing table: UNUSABLE (the router would be unavailable for EVERY tier):', ...report.errors.map((e) => `  - ${e}`)].join('\n');
  }
  const lines = [`Routing table version ${report.version}: ${report.ok ? 'VALID for every tier' : 'NOT valid for every tier (see below)'}`];
  for (const tier of report.tiers) {
    lines.push('', `${tier.tier === null ? '(no tier override)' : `Tier "${tier.tier}"`}: ${tier.ok ? 'OK' : 'UNAVAILABLE'}`);
    if (tier.why) lines.push(`  ! ${tier.why}`);
    for (const route of tier.routes) {
      lines.push(`  ${route.taskType.padEnd(9)} -> ${route.model} (${route.rule})${route.refused ? `  REFUSED: ${route.refused}` : ''}`);
    }
  }
  if (report.issues.length > 0) lines.push('', 'Issues (nothing unavailable):', ...report.issues.map((i) => `  - ${i}`));
  return lines.join('\n');
}
