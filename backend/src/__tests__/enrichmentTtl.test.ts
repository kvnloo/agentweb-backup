// Tests for enrichmentTtl — stateless TTL freshness + field-to-group lookup
// helpers used by the v3.1 CRM enrichment waterfall (Tier 1 / CRM check).
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.2 step 1, §7.2.
// TTL is derived at read time from existing `enrichedAt + FIELD_GROUPS[group].ttlDays`
// — no schema migration, no stored expiresAt.

import { isFresh, groupOf } from '../services/enrichmentTtl';
import { FIELD_GROUPS } from '../services/enrichmentGroups';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';

const DAY_MS = 24 * 60 * 60 * 1000;
const FROZEN_NOW = new Date('2026-05-11T12:00:00.000Z').getTime();

function metaAt(daysAgo: number): EnrichedFieldMeta {
  return {
    source: 'web_search',
    enrichedAt: new Date(FROZEN_NOW - daysAgo * DAY_MS).toISOString(),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── groupOf ──────────────────────────────────────────────────────────────────

describe('groupOf', () => {
  it("returns 'ungrouped' for unknown field names", () => {
    expect(groupOf('not_a_real_field')).toBe('ungrouped');
  });

  it("returns 'ungrouped' for empty string", () => {
    expect(groupOf('')).toBe('ungrouped');
  });

  it("returns 'ungrouped' for whitespace-only input", () => {
    expect(groupOf('   ')).toBe('ungrouped');
  });

  it('maps tech_stack → company_technographic', () => {
    expect(groupOf('tech_stack')).toBe('company_technographic');
  });

  it('maps company_name → company_firmographic', () => {
    expect(groupOf('company_name')).toBe('company_firmographic');
  });

  it('maps first_name → person_identity', () => {
    expect(groupOf('first_name')).toBe('person_identity');
  });

  it('maps recent_news → intent_signals', () => {
    expect(groupOf('recent_news')).toBe('intent_signals');
  });

  // Parametrized: every field declared in FIELD_GROUPS resolves to its group.
  // Catches the case where someone adds a field to a group but forgets to
  // wire it through any lookup table groupOf depends on.
  it('resolves every field declared in FIELD_GROUPS to its group', () => {
    for (const [groupName, config] of Object.entries(FIELD_GROUPS)) {
      for (const field of config.fields) {
        expect(groupOf(field)).toBe(groupName);
      }
    }
  });
});

// ─── isFresh ──────────────────────────────────────────────────────────────────

describe('isFresh', () => {
  // Failure / edge cases first (TDD: minimum 3 fail paths per CLAUDE.md Rule 2)

  it('returns false when meta is undefined', () => {
    expect(isFresh(undefined, 'tech_stack')).toBe(false);
  });

  it('returns false when meta is null', () => {
    expect(isFresh(null as any, 'tech_stack')).toBe(false);
  });

  it('returns false when enrichedAt is missing from meta', () => {
    const meta = { source: 'web_search' } as any;
    expect(isFresh(meta, 'tech_stack')).toBe(false);
  });

  it('returns false when enrichedAt is not a parseable date string', () => {
    const meta = { source: 'web_search', enrichedAt: 'not-a-date' } as any;
    expect(isFresh(meta, 'tech_stack')).toBe(false);
  });

  it("returns false for fields with no known group (no ttlDays to compare)", () => {
    // Defensive: an unknown field has no group → no TTL → cannot prove freshness
    // → safer to treat as stale so the waterfall falls through to next tier.
    const meta = metaAt(0);
    expect(isFresh(meta, 'some_custom_field_not_in_any_group')).toBe(false);
  });

  it('returns false when value is older than the group TTL', () => {
    // intent_signals ttlDays = 30; meta is 45 days old → stale
    expect(FIELD_GROUPS.intent_signals.ttlDays).toBe(30); // sanity check
    expect(isFresh(metaAt(45), 'recent_news')).toBe(false);
  });

  it('returns false exactly at the TTL boundary (strict <, not <=)', () => {
    // company_firmographic ttlDays = 180. enrichedAt = exactly 180 days ago
    // → not fresh anymore (boundary is exclusive).
    expect(FIELD_GROUPS.company_firmographic.ttlDays).toBe(180);
    expect(isFresh(metaAt(180), 'company_name')).toBe(false);
  });

  // Success cases

  it('returns true for fresh value just written (0 days old)', () => {
    expect(isFresh(metaAt(0), 'company_name')).toBe(true);
  });

  it('returns true for value within the group TTL', () => {
    // company_technographic ttlDays = 180. 100 days old → still fresh.
    expect(isFresh(metaAt(100), 'tech_stack')).toBe(true);
  });

  it('respects per-group TTL — intent_signals (30d) goes stale before firmographic (180d)', () => {
    const fortyFiveDaysOld = metaAt(45);
    expect(isFresh(fortyFiveDaysOld, 'recent_news')).toBe(false); // intent_signals: 30d → stale
    expect(isFresh(fortyFiveDaysOld, 'company_name')).toBe(true); // firmographic: 180d → fresh
  });

  it('respects person_career TTL (90d) — 80 days old is fresh, 100 days old is stale', () => {
    expect(FIELD_GROUPS.person_career.ttlDays).toBe(90);
    expect(isFresh(metaAt(80), 'tenure_at_company')).toBe(true);
    expect(isFresh(metaAt(100), 'tenure_at_company')).toBe(false);
  });

  it('is stable across all groups — fresh-at-0d, stale-at-(ttl+1)', () => {
    for (const [groupName, config] of Object.entries(FIELD_GROUPS)) {
      const sampleField = config.fields[0];
      expect(isFresh(metaAt(0), sampleField)).toBe(true);
      expect(isFresh(metaAt(config.ttlDays + 1), sampleField)).toBe(false);
    }
  });
});
