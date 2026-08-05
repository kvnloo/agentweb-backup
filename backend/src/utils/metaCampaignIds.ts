/**
 * Meta campaign-ID normalization (ENG-821).
 *
 * Pure — no imports, no I/O. It lives here rather than in agentModeService for
 * a concrete reason: `emma/tools.ts` needs it at tool-dispatch time, and **140
 * test files `jest.mock` agentModeService**. Importing a helper from that
 * module means every one of those mocks must also stub the helper, or dispatch
 * dies with `normalizeMetaCampaignIds is not a function` — which is exactly how
 * `emma.metaAdsCampaignTools.test.ts` broke when this logic first landed there.
 *
 * A pure module is not mocked away, so the tool keeps working under any mock of
 * the monolith.
 *
 * The model may send campaign ids three ways, all of which must mean the same
 * thing (the mismatch this issue exists to fix):
 *   - a real array:            ["123", "456"]
 *   - a JSON-encoded array:    '["123","456"]'
 *   - a bare id string:        "123"
 *   - or the legacy singular `campaign_id` argument.
 */

export function normalizeMetaCampaignIds(
  campaignIds: unknown,
  legacyCampaignId?: unknown,
): string[] {
  if (Array.isArray(campaignIds)) {
    return [...new Set(campaignIds.map(id => String(id).trim()).filter(Boolean))];
  }

  if (typeof campaignIds === 'string' && campaignIds.trim()) {
    const trimmed = campaignIds.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(id => String(id).trim()).filter(Boolean))];
      }
    } catch {
      // A bare campaign ID is the supported legacy string shape.
    }
    return [trimmed];
  }

  return typeof legacyCampaignId === 'string' && legacyCampaignId.trim()
    ? [legacyCampaignId.trim()]
    : [];
}
