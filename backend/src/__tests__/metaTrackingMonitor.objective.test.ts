/**
 * ENG-926 §F — spend that was never TRYING to convert is not a blackout.
 *
 * The blackout check shipped asking "did this spend produce conversions" without asking
 * "was this spend trying to". Measured on production 2026-08-16, that made two of its three
 * alerts noise:
 *
 *   Every.io      $557.39  OUTCOME_ENGAGEMENT (boosted posts, NO destination URL)  false
 *   Kraftersland  $ 60.59  LINK_CLICKS + OUTCOME_ENGAGEMENT                        false
 *   AgentWeb own  $175.57  OUTCOME_LEADS ("ICP1 PLG – Signup Test")                TRUE
 *
 * A boosted post with no link cannot produce an attributed conversion however perfect the
 * tracking is. Alerting on it teaches people to ignore the channel — the precise outcome
 * §F exists to prevent, arrived at from the opposite direction.
 *
 * This is a FOURTH state alongside the three the detector already distinguishes (`idle`,
 * `unclassifiable`, and null-is-not-zero): spend that is out of scope for the question.
 */

import {
  isConversionOptimisedObjective,
  splitSpendByObjective,
  CONVERSION_OBJECTIVES,
} from '../services/metaTrackingMonitor';

describe('isConversionOptimisedObjective', () => {
  it('accepts the objectives that optimise for a conversion', () => {
    // Meta's outcome-era names plus the legacy ones still present on older campaigns.
    for (const o of ['OUTCOME_LEADS', 'OUTCOME_SALES', 'CONVERSIONS', 'LEAD_GENERATION', 'PRODUCT_CATALOG_SALES']) {
      expect(isConversionOptimisedObjective(o)).toBe(true);
    }
  });

  it('rejects the objectives that never produce attributed conversions', () => {
    // Every one of these was observed on a real account that §F wrongly flagged.
    for (const o of ['OUTCOME_ENGAGEMENT', 'LINK_CLICKS', 'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC',
                     'BRAND_AWARENESS', 'REACH', 'VIDEO_VIEWS', 'POST_ENGAGEMENT', 'PAGE_LIKES']) {
      expect(isConversionOptimisedObjective(o)).toBe(false);
    }
  });

  it('is case and whitespace insensitive', () => {
    expect(isConversionOptimisedObjective('  outcome_leads ')).toBe(true);
  });

  it('treats an UNKNOWN objective as conversion-optimised', () => {
    // Fail toward alerting. A new Meta objective we have not catalogued must not silently
    // suppress a real blackout — the whole failure mode this card exists to end is a
    // tracking problem nobody could see. A false alert is recoverable; silence is not.
    expect(isConversionOptimisedObjective('OUTCOME_SOMETHING_NEW_2027')).toBe(true);
    expect(isConversionOptimisedObjective(undefined)).toBe(true);
    expect(isConversionOptimisedObjective('')).toBe(true);
  });

  it('exposes its catalogue so the alert can name what it excluded', () => {
    expect(CONVERSION_OBJECTIVES.has('OUTCOME_LEADS')).toBe(true);
  });
});

describe('splitSpendByObjective', () => {
  const row = (objective: string, spend: number) => ({ objective, spend: String(spend) });

  it('separates conversion spend from spend that was never trying to convert', () => {
    const split = splitSpendByObjective([
      row('OUTCOME_LEADS', 175.57),
      row('OUTCOME_ENGAGEMENT', 557.39),
      row('LINK_CLICKS', 60.59),
    ]);

    expect(split.conversionSpend).toBeCloseTo(175.57, 2);
    expect(split.nonConversionSpend).toBeCloseTo(617.98, 2);
    expect(split.excludedObjectives.sort()).toEqual(['LINK_CLICKS', 'OUTCOME_ENGAGEMENT']);
  });

  it('reports zero conversion spend for an account running only engagement — the Every.io case', () => {
    const split = splitSpendByObjective([
      row('OUTCOME_ENGAGEMENT', 139.89),
      row('OUTCOME_ENGAGEMENT', 139.69),
      row('OUTCOME_ENGAGEMENT', 128.24),
    ]);

    expect(split.conversionSpend).toBe(0);
    expect(split.nonConversionSpend).toBeCloseTo(407.82, 2);
  });

  it('counts an unknown objective as conversion spend, matching the fail-loud default', () => {
    const split = splitSpendByObjective([row('OUTCOME_MYSTERY', 10)]);
    expect(split.conversionSpend).toBe(10);
    expect(split.unknownObjectives).toEqual(['OUTCOME_MYSTERY']);
  });

  it('survives malformed rows without poisoning the totals', () => {
    const split = splitSpendByObjective([
      { objective: 'OUTCOME_LEADS', spend: 'not-a-number' } as any,
      null as any,
      { spend: '5' } as any,
      row('OUTCOME_LEADS', 20),
    ]);
    expect(split.conversionSpend).toBe(25); // the no-objective row counts as unknown → conversion
  });

  it('handles an empty campaign list', () => {
    const split = splitSpendByObjective([]);
    expect(split).toMatchObject({ conversionSpend: 0, nonConversionSpend: 0 });
  });

  it('de-duplicates the excluded objective names it reports', () => {
    const split = splitSpendByObjective([
      row('OUTCOME_ENGAGEMENT', 1),
      row('OUTCOME_ENGAGEMENT', 2),
    ]);
    expect(split.excludedObjectives).toEqual(['OUTCOME_ENGAGEMENT']);
  });
});
