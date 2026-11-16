/**
 * ENG-2950 acceptance contract:
 *  1. Every covered row maps to a tool advertised by the Zoma manifests on main
 *     (Meta toolkit manifest incl. Zoma tools, Google toolkit names), and to an
 *     advertised action / entity_type where the tool is multiplexed.
 *  2. No Meta tool name appears twice.
 *  3. Gap rows name an owning ENG issue; n/a rows give a reason.
 *  4. Per-category covered / gap / n/a counts are printed.
 */
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import officialInventory from './__fixtures__/officialMetaAdsMcpTools.json';

import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { GOOGLE_TOOLKIT_TOOL_NAMES } from '../mcp/googleToolkitManifest';
import { ZOMA_META_PARITY_MATRIX, formatParitySummary } from '../mcp/zomaMetaParityMatrix';

describe('ENG-2950 Zoma ↔ Meta Ads MCP parity matrix', () => {
  const manifest = getMetaToolkitManifest();
  const byName = new Map<string, any>(manifest.map((d: any) => [d.name, d]));
  const googleNames = new Set<string>(GOOGLE_TOOLKIT_TOOL_NAMES as readonly string[]);

  it('every covered row points at an advertised Zoma tool, action and entity_type', () => {
    const problems: string[] = [];
    for (const row of ZOMA_META_PARITY_MATRIX) {
      if (row.status !== 'covered') continue;
      const op = row.zoma;
      if (!op) { problems.push(`${row.metaTool}: covered without a zoma mapping`); continue; }
      const def = byName.get(op.tool);
      if (!def && !googleNames.has(op.tool)) { problems.push(`${row.metaTool}: ${op.tool} is not advertised`); continue; }
      const props = def?.inputSchema?.properties ?? {};
      if (op.action !== undefined && !(props.action?.enum ?? []).includes(op.action)) {
        problems.push(`${row.metaTool}: ${op.tool} does not advertise action ${op.action}`);
      }
      if (op.entityType !== undefined && !(props.entity_type?.enum ?? []).includes(op.entityType)) {
        problems.push(`${row.metaTool}: ${op.tool} does not advertise entity_type ${op.entityType}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('covers exactly the 88 tool names published across the seven official categories', () => {
    const official = officialInventory.categories.flatMap((category) => category.tools);
    expect(officialInventory.categories).toHaveLength(7);
    expect(new Set(official).size).toBe(88);
    expect([...new Set(ZOMA_META_PARITY_MATRIX.map((row) => row.metaTool))].sort())
      .toEqual([...new Set(official)].sort());
  });

  it('no Meta tool name appears twice', () => {
    const seen = new Set<string>();
    const dupes = ZOMA_META_PARITY_MATRIX.map((r) => r.metaTool).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes).toEqual([]);
  });

  it('gap rows name an owning ENG issue and n/a rows give a reason', () => {
    for (const row of ZOMA_META_PARITY_MATRIX) {
      if (row.status === 'gap') expect(row.owner).toMatch(/^ENG-\d+$/);
      if (row.status === 'not_applicable') expect((row.reason ?? '').trim()).not.toBe('');
      if (row.status !== 'covered') expect(row.zoma).toBeUndefined();
    }
  });

  it('prints per-category coverage counts', () => {
    const summary = formatParitySummary();
    // eslint-disable-next-line no-console
    console.log(`Zoma Meta parity\n${summary}`);
    expect(summary).toMatch(/^TOTAL: covered \d+ \/ gap \d+ \/ n\/a \d+ \(of \d+\)$/m);
  });
});
