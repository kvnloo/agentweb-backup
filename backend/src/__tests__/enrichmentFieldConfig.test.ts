import {
  ALL_ENRICHMENT_FIELDS,
  EXTENDED_FIELDS,
  STANDARD_FIELDS,
  getDefaultEnrichmentFieldConfig,
  normalizeEnrichmentFieldConfig,
  unionEnrichmentFieldConfigs,
} from '../services/enrichmentFieldConfig';

describe('enrichmentFieldConfig', () => {
  describe('getDefaultEnrichmentFieldConfig', () => {
    it('enables all 5 standard fields', () => {
      const cfg = getDefaultEnrichmentFieldConfig();
      for (const f of STANDARD_FIELDS) expect(cfg[f]).toBe(true);
    });
    it('disables all 7 extended fields', () => {
      const cfg = getDefaultEnrichmentFieldConfig();
      for (const f of EXTENDED_FIELDS) expect(cfg[f]).toBe(false);
    });
    it('covers exactly the 12 known fields', () => {
      expect(ALL_ENRICHMENT_FIELDS.length).toBe(12);
      const cfg = getDefaultEnrichmentFieldConfig();
      expect(Object.keys(cfg).sort()).toEqual([...ALL_ENRICHMENT_FIELDS].sort());
    });
  });

  describe('normalizeEnrichmentFieldConfig', () => {
    it('returns defaults when input is null/undefined/non-object', () => {
      const def = getDefaultEnrichmentFieldConfig();
      expect(normalizeEnrichmentFieldConfig(null)).toEqual(def);
      expect(normalizeEnrichmentFieldConfig(undefined)).toEqual(def);
    });
    it('overrides only fields explicitly set to a boolean — leaves the rest at default', () => {
      const cfg = normalizeEnrichmentFieldConfig({ skills: true, summary: true });
      expect(cfg.skills).toBe(true);
      expect(cfg.summary).toBe(true);
      // standards untouched
      expect(cfg.firstName).toBe(true);
      // other extended still off
      expect(cfg.connectionCount).toBe(false);
    });
    it('drops unknown keys silently — does not pollute the config', () => {
      const cfg = normalizeEnrichmentFieldConfig({ banana: true, firstName: false } as any);
      expect((cfg as any).banana).toBeUndefined();
      expect(cfg.firstName).toBe(false);
    });
    it('ignores non-boolean values for known fields (keeps default)', () => {
      const cfg = normalizeEnrichmentFieldConfig({ skills: 'yes' as any, firstName: 1 as any });
      expect(cfg.skills).toBe(false);   // default extended
      expect(cfg.firstName).toBe(true); // default standard
    });
  });

  describe('unionEnrichmentFieldConfigs', () => {
    it('returns all-false when input is empty', () => {
      const u = unionEnrichmentFieldConfigs([]);
      for (const f of ALL_ENRICHMENT_FIELDS) expect(u[f]).toBe(false);
    });
    it('enables a field if any input enables it', () => {
      const a = normalizeEnrichmentFieldConfig({ skills: true });
      const b = normalizeEnrichmentFieldConfig({ summary: true });
      const u = unionEnrichmentFieldConfigs([a, b]);
      expect(u.skills).toBe(true);
      expect(u.summary).toBe(true);
      expect(u.firstName).toBe(true);  // both have default standards on
    });
    it('a field disabled in every input stays disabled in the union', () => {
      const a = normalizeEnrichmentFieldConfig({ firstName: false });
      const b = normalizeEnrichmentFieldConfig({ firstName: false });
      const u = unionEnrichmentFieldConfigs([a, b]);
      expect(u.firstName).toBe(false);
    });
  });
});
