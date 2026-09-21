/**
 * ENG-821 — the three shapes the model sends campaign ids in must mean the same
 * thing. This is the contract `get_meta_ads_metrics` declares.
 *
 * Tested here, against the pure module, rather than only through the tool: the
 * tool path runs under a `jest.mock` of agentModeService in 140 test files, and
 * a helper reachable only through that module is a helper those tests cannot
 * exercise (and, before this extraction, one they actively broke on).
 */

import { normalizeMetaCampaignIds } from '../metaCampaignIds';

describe('normalizeMetaCampaignIds', () => {
  it('passes a real array through, trimmed', () => {
    expect(normalizeMetaCampaignIds([' 123 ', '456'])).toEqual(['123', '456']);
  });

  it('parses a JSON-encoded array — the shape the model actually emitted', () => {
    expect(normalizeMetaCampaignIds('["123","456"]')).toEqual(['123', '456']);
  });

  it('treats a bare id string as a single id', () => {
    expect(normalizeMetaCampaignIds('123')).toEqual(['123']);
  });

  it('produces identical output for all three shapes', () => {
    // This is the acceptance criterion itself: same meaning, same result.
    const fromArray = normalizeMetaCampaignIds(['123', '456']);
    const fromJson = normalizeMetaCampaignIds('["123","456"]');
    expect(fromJson).toEqual(fromArray);
  });

  it('falls back to the legacy singular campaign_id', () => {
    expect(normalizeMetaCampaignIds(undefined, '789')).toEqual(['789']);
  });

  it('prefers campaign_ids over the legacy argument when both are present', () => {
    expect(normalizeMetaCampaignIds(['123'], '789')).toEqual(['123']);
  });

  it('de-duplicates repeated ids', () => {
    expect(normalizeMetaCampaignIds(['123', '123', '456'])).toEqual(['123', '456']);
    expect(normalizeMetaCampaignIds('["123","123"]')).toEqual(['123']);
  });

  it('drops empty and whitespace-only entries rather than querying for ""', () => {
    expect(normalizeMetaCampaignIds(['123', '', '   '])).toEqual(['123']);
  });

  it('returns an empty list when nothing usable is supplied', () => {
    expect(normalizeMetaCampaignIds(undefined)).toEqual([]);
    expect(normalizeMetaCampaignIds('')).toEqual([]);
    expect(normalizeMetaCampaignIds('   ')).toEqual([]);
    expect(normalizeMetaCampaignIds(null, null)).toEqual([]);
  });

  it('treats malformed JSON as a bare id instead of throwing', () => {
    // Failing loudly here would turn a recoverable arg into a dead tool call.
    expect(normalizeMetaCampaignIds('[123')).toEqual(['[123']);
  });

  it('treats a JSON scalar as a bare id, not a parsed value', () => {
    expect(normalizeMetaCampaignIds('123456789')).toEqual(['123456789']);
  });

  it('coerces numeric ids to strings so callers get one type', () => {
    expect(normalizeMetaCampaignIds([123, 456] as unknown)).toEqual(['123', '456']);
  });
});
