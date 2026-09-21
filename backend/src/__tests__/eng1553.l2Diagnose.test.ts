import { diagnose, CAUSES_BY_SYMPTOM, type CauseEvaluation } from '../services/l2Diagnose';

function evalAll(symptom: keyof typeof CAUSES_BY_SYMPTOM, overrides: Record<string, CauseEvaluation['verdict']>): CauseEvaluation[] {
  return CAUSES_BY_SYMPTOM[symptom].map(cause => ({
    cause,
    verdict: overrides[cause] ?? 'unchecked',
    evidence: `test evidence for ${cause}`,
  }));
}

describe('diagnose — the guard against a silently-missing cause', () => {
  it('throws if a cause the symptom lists was never evaluated', () => {
    const causes = evalAll('leads_at_zero', {}).filter(c => c.cause !== 'budget_exhausted');
    expect(() => diagnose('leads_at_zero', causes)).toThrow(/missing: budget_exhausted/);
  });
});

describe('diagnose — the real case that broke the first (2-state) design', () => {
  it('reaches determined when one cause is supported, even though an unrelated cause (budget_exhausted) has zero evidence source and stays unchecked', () => {
    // Mirrors the real live-tested case: pixel/CAPI confirmed broken via
    // check_account_tracking_health, budget_exhausted has no evidence source anywhere in this
    // codebase (verified directly), landing page / demand-drop / normal-variance ruled out.
    const causes = evalAll('leads_at_zero', {
      pixel_capi_broken: 'supported',
      landing_page_unreachable: 'ruled_out',
      genuine_demand_drop: 'ruled_out',
      normal_variance: 'ruled_out',
      // budget_exhausted: left as 'unchecked' (no override) — the whole point of this test
    });
    const result = diagnose('leads_at_zero', causes);
    expect(result.outcome).toBe('determined');
    expect(result.concludedCause).toBe('pixel_capi_broken');
    expect(result.reason).toBeNull();
  });
});

describe('diagnose — could_not_determine paths', () => {
  it('is could_not_determine when every cause is unchecked (no evidence source exists at all)', () => {
    const causes = evalAll('ctr_falling', {});
    const result = diagnose('ctr_falling', causes);
    expect(result.outcome).toBe('could_not_determine');
    expect(result.concludedCause).toBeNull();
    expect(result.reason).toMatch(/no evidence source exists for any/);
  });

  it('is could_not_determine when some causes are ruled out but none is supported', () => {
    const causes = evalAll('leads_at_zero', {
      landing_page_unreachable: 'ruled_out',
      genuine_demand_drop: 'ruled_out',
      // pixel_capi_broken, budget_exhausted, normal_variance stay unchecked
    });
    const result = diagnose('leads_at_zero', causes);
    expect(result.outcome).toBe('could_not_determine');
    expect(result.reason).toMatch(/no cause has supporting evidence/);
  });

  it('is could_not_determine when two causes are both supported — never picks one', () => {
    const causes = evalAll('leads_at_zero', {
      pixel_capi_broken: 'supported',
      genuine_demand_drop: 'supported',
      landing_page_unreachable: 'ruled_out',
      normal_variance: 'ruled_out',
    });
    const result = diagnose('leads_at_zero', causes);
    expect(result.outcome).toBe('could_not_determine');
    expect(result.concludedCause).toBeNull();
    expect(result.reason).toMatch(/more than one cause has supporting evidence/);
    expect(result.reason).toMatch(/pixel_capi_broken/);
    expect(result.reason).toMatch(/genuine_demand_drop/);
  });

  it('recommendation-gating: a caller must never emit an action when concludedCause is null', () => {
    // This is the mechanical enforcement the card's AC #3 requires ("a recommendation is only
    // emitted once a cause is established") — asserted here as a property of the return shape
    // itself: concludedCause is null on every could_not_determine result, full stop.
    const causes = evalAll('cpm_rising', {});
    const result = diagnose('cpm_rising', causes);
    expect(result.outcome).toBe('could_not_determine');
    expect(result.concludedCause).toBeNull();
  });
});

describe('diagnose — every symptom is representable, not just leads_at_zero', () => {
  it.each(Object.keys(CAUSES_BY_SYMPTOM) as (keyof typeof CAUSES_BY_SYMPTOM)[])(
    'can reach determined for %s given full evidence',
    symptom => {
      const causeNames = CAUSES_BY_SYMPTOM[symptom];
      const overrides: Record<string, CauseEvaluation['verdict']> = {};
      causeNames.forEach((c, i) => { overrides[c] = i === 0 ? 'supported' : 'ruled_out'; });
      const result = diagnose(symptom, evalAll(symptom, overrides));
      expect(result.outcome).toBe('determined');
      expect(result.concludedCause).toBe(causeNames[0]);
    },
  );
});

describe('diagnose — CAUSES_BY_SYMPTOM matches the card verbatim', () => {
  it('leads_at_zero has exactly the 5 look-alikes the card names', () => {
    expect([...CAUSES_BY_SYMPTOM.leads_at_zero].sort()).toEqual(
      ['budget_exhausted', 'genuine_demand_drop', 'landing_page_unreachable', 'normal_variance', 'pixel_capi_broken'].sort(),
    );
  });

  it('ctr_falling has exactly the 4 look-alikes the card names', () => {
    expect([...CAUSES_BY_SYMPTOM.ctr_falling].sort()).toEqual(
      ['audience_saturation', 'auction_competition', 'creative_fatigue', 'seasonality'].sort(),
    );
  });

  it('cpm_rising has exactly the 4 look-alikes the card names', () => {
    expect([...CAUSES_BY_SYMPTOM.cpm_rising].sort()).toEqual(
      ['audience_shrink', 'competitor_entry', 'creative_fatigue', 'delivery_optimisation_shift'].sort(),
    );
  });
});
