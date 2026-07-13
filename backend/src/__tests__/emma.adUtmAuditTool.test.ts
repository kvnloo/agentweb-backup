/**
 * ENG-239 AC3 — the `audit_ad_utm_coverage` Emma tool.
 *
 * The AC: "Existing campaigns are not silently modified; a report/tool lists
 * campaigns lacking UTMs so the team can opt in per client."
 *
 * The audit service and its platform adapters exist and are tested; this tool is
 * what makes them REACHABLE — without it the AC's deliverable is unusable.
 *
 * Two properties matter and are pinned here:
 *  1. It is strictly READ-ONLY. Emma must not be able to modify a campaign through
 *     it. (The AdReadPort has no write method, so this is structural — but the tool
 *     must not smuggle one in.)
 *  2. It surfaces `unreadable` ads separately from `untagged` ones. Acting on a
 *     false "untagged" means swapping a live Meta creative, which resets the ad's
 *     learning phase and hurts a paying client — so the two must never be conflated
 *     in what the team sees.
 */

jest.mock('../services/adUtmAuditService', () => ({
  auditCampaigns: jest.fn(),
}));

jest.mock('../services/adUtmAuditAdapters', () => ({
  metaAdReadPort: { __port: 'meta' },
  googleAdReadPort: { __port: 'google' },
  linkedInAdReadPort: { __port: 'linkedin' },
}));

import { emmaToolRegistry } from '../emma/registry';
import { auditCampaigns } from '../services/adUtmAuditService';
import '../emma/tools';

const mockAudit = auditCampaigns as jest.Mock;
const TOOL = 'audit_ad_utm_coverage';

const report = (over: Partial<any> = {}) => ({
  campaignId: 'c1',
  name: 'Spring Sale',
  tagged: false,
  missingKeys: ['utm_source', 'utm_medium', 'utm_campaign'],
  untaggedAdIds: ['ad_1'],
  unreadableAdIds: [],
  ...over,
});

describe('ENG-239 AC3 — audit_ad_utm_coverage tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is registered in the Emma tool registry', () => {
    expect(emmaToolRegistry.getTool(TOOL)).toBeDefined();
  });

  it('requires a platform and an account_id', () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;
    const schema: any = tool.definition.inputSchema;
    expect(schema.required).toEqual(expect.arrayContaining(['platform', 'account_id']));
    expect(schema.properties.platform.enum).toEqual(['meta', 'google', 'linkedin']);
  });

  it('audits the requested platform with that platform port and the caller userId', async () => {
    mockAudit.mockResolvedValueOnce([report({ tagged: true, missingKeys: [], untaggedAdIds: [] })]);
    const tool = emmaToolRegistry.getTool(TOOL)!;

    await tool.execute({ platform: 'google', account_id: 'acct-9' }, { userId: 'u1' });

    expect(mockAudit).toHaveBeenCalledWith('google', 'u1', 'acct-9', { __port: 'google' });
  });

  it('summarises which campaigns need action and which are clean', async () => {
    mockAudit.mockResolvedValueOnce([
      report({ campaignId: 'c1', name: 'Untagged', tagged: false }),
      report({ campaignId: 'c2', name: 'Clean', tagged: true, missingKeys: [], untaggedAdIds: [] }),
    ]);
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const res: any = await tool.execute({ platform: 'meta', account_id: 'a1' }, { userId: 'u1' });

    expect(res.success).toBe(true);
    expect(res.totalCampaigns).toBe(2);
    expect(res.campaignsNeedingAction).toBe(1);
    expect(res.campaigns).toHaveLength(2);
  });

  it('surfaces unreadable ads SEPARATELY from untagged ones, never merging the two', async () => {
    // Conflating them would send the team to "fix" an ad we simply could not read —
    // and on Meta that means a creative swap, which resets the ad's learning phase.
    mockAudit.mockResolvedValueOnce([
      report({ tagged: false, missingKeys: [], untaggedAdIds: [], unreadableAdIds: ['ad_x'] }),
    ]);
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const res: any = await tool.execute({ platform: 'meta', account_id: 'a1' }, { userId: 'u1' });

    expect(res.campaigns[0].untaggedAdIds).toEqual([]);
    expect(res.campaigns[0].unreadableAdIds).toEqual(['ad_x']);
    // and the tool must say out loud that these need a human, not an auto-fix
    expect(String(res.message)).toMatch(/unreadable|could not be read|needs review/i);
  });

  it('rejects a missing user context rather than auditing someone else', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;
    await expect(
      tool.execute({ platform: 'meta', account_id: 'a1' }, {}),
    ).rejects.toThrow(/user context/i);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('rejects an unsupported platform without calling the audit', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;
    await expect(
      tool.execute({ platform: 'tiktok', account_id: 'a1' }, { userId: 'u1' }),
    ).rejects.toThrow(/platform/i);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('rejects a missing account_id without calling the audit', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;
    await expect(
      tool.execute({ platform: 'meta' }, { userId: 'u1' }),
    ).rejects.toThrow(/account_id/i);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reports a clean account plainly when every campaign is tagged', async () => {
    mockAudit.mockResolvedValueOnce([
      report({ tagged: true, missingKeys: [], untaggedAdIds: [] }),
    ]);
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const res: any = await tool.execute({ platform: 'linkedin', account_id: 'a1' }, { userId: 'u1' });

    expect(res.campaignsNeedingAction).toBe(0);
    expect(String(res.message)).toMatch(/all|every|no campaigns/i);
  });

  it('is read-only: its description tells Emma it never modifies a campaign', () => {
    // AC3's first clause. The tool must not read as something that can mutate ads.
    const tool = emmaToolRegistry.getTool(TOOL)!;
    expect(tool.definition.description).toMatch(/read-only|never modifies|does not modify/i);
  });
});
