import { describe, it, expect } from '@jest/globals';
import {
  buildBuiltInPresets,
  validateCreateInput,
  generateViewId,
  isPresetViewId,
  VALID_SCOPES,
} from '../savedViews';

describe('savedViews utils — presets', () => {
  it('returns exactly 5 built-in presets with preset: prefixed ids', () => {
    const presets = buildBuiltInPresets('user-123');
    expect(presets).toHaveLength(5);
    for (const p of presets) {
      expect(p.viewId.startsWith('preset:')).toBe(true);
      expect(p.isPreset).toBe(true);
    }
  });

  it('injects the current userId into My Deals filter', () => {
    const presets = buildBuiltInPresets('user-abc');
    const myDeals = presets.find((p) => p.viewId === 'preset:my-deals');
    expect(myDeals).toBeDefined();
    expect(myDeals!.filters).toEqual({ accountOwnerUserId: 'user-abc' });
    expect(myDeals!.scope).toBe('working');
  });

  it('provides Hot in Inbox with heat threshold and inbox scope', () => {
    const hot = buildBuiltInPresets('u').find((p) => p.viewId === 'preset:hot-in-inbox');
    expect(hot?.scope).toBe('inbox');
    expect(hot?.filters).toEqual({ minHeatScore: 50 });
    expect(hot?.sort).toBe('heatScore:desc');
  });

  it('provides At-risk Customers scoped to paying with healthScore:asc', () => {
    const atRisk = buildBuiltInPresets('u').find(
      (p) => p.viewId === 'preset:at-risk-customers'
    );
    expect(atRisk?.scope).toBe('paying');
    expect(atRisk?.sort).toBe('healthScore:asc');
    expect(atRisk?.filters?.lifecycle).toBe('at_risk');
  });
});

describe('savedViews utils — isPresetViewId', () => {
  it('detects preset ids', () => {
    expect(isPresetViewId('preset:hot-in-inbox')).toBe(true);
    expect(isPresetViewId('preset:anything')).toBe(true);
  });
  it('returns false for user view ids', () => {
    expect(isPresetViewId('view_12345_abc')).toBe(false);
    expect(isPresetViewId('')).toBe(false);
    // @ts-expect-error intentional wrong type
    expect(isPresetViewId(null)).toBe(false);
  });
});

describe('savedViews utils — validateCreateInput', () => {
  it('accepts a valid input', () => {
    const r = validateCreateInput({
      name: '  My view  ',
      scope: 'inbox',
      filters: { minHeatScore: 20 },
      sort: 'heatScore:desc',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('My view');
      expect(r.value.scope).toBe('inbox');
      expect(r.value.filters).toEqual({ minHeatScore: 20 });
      expect(r.value.sort).toBe('heatScore:desc');
    }
  });

  it('defaults filters to {} when omitted', () => {
    const r = validateCreateInput({ name: 'x', scope: 'all' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.filters).toEqual({});
  });

  it('rejects missing name', () => {
    const r = validateCreateInput({ scope: 'inbox' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/i);
  });

  it('rejects whitespace-only name', () => {
    const r = validateCreateInput({ name: '   ', scope: 'inbox' });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid scope', () => {
    const r = validateCreateInput({ name: 'x', scope: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/scope/);
  });

  it('accepts every valid scope', () => {
    for (const s of VALID_SCOPES) {
      const r = validateCreateInput({ name: 'x', scope: s });
      expect(r.ok).toBe(true);
    }
  });

  it('rejects array filters', () => {
    const r = validateCreateInput({ name: 'x', scope: 'inbox', filters: ['a'] });
    expect(r.ok).toBe(false);
  });

  it('rejects null filters', () => {
    const r = validateCreateInput({ name: 'x', scope: 'inbox', filters: null });
    expect(r.ok).toBe(false);
  });

  it('rejects non-string sort', () => {
    const r = validateCreateInput({ name: 'x', scope: 'inbox', sort: 123 });
    expect(r.ok).toBe(false);
  });
});

describe('savedViews utils — generateViewId', () => {
  it('produces unique view_ prefixed ids', () => {
    const a = generateViewId();
    const b = generateViewId();
    expect(a.startsWith('view_')).toBe(true);
    expect(b.startsWith('view_')).toBe(true);
    expect(a).not.toBe(b);
  });
});
