/**
 * ENG-1205 — a correction must survive a reload, not just the live turn.
 *
 * The stamp is read from the session's `llmUsagePolicyDecision`, which is a
 * single slot overwritten every turn. The interesting cases are therefore not
 * the happy path but the ones where that slot does NOT describe this turn.
 */
import { resolveTurnModelCorrection } from '../modelCorrectionStamp';

const CORRECTED = {
  requestedModel: 'anthropic.claude-opus-5',
  effectiveModel: 'gemini-3.1-flash-lite',
  modelSelection: 'corrected',
};

describe('resolveTurnModelCorrection (ENG-1205)', () => {
  it('stamps the pair when the turn ran on the corrected model', () => {
    expect(resolveTurnModelCorrection(CORRECTED, 'gemini-3.1-flash-lite')).toEqual({
      requestedModel: 'anthropic.claude-opus-5',
      effectiveModel: 'gemini-3.1-flash-lite',
    });
  });

  it('refuses a decision that describes a DIFFERENT turn', () => {
    // The session slot is overwritten every turn. A resumed or replayed run that
    // did not write it would otherwise stamp a newer turn's correction onto its
    // own messages and misattribute the model — worse than no stamp.
    expect(resolveTurnModelCorrection(CORRECTED, 'anthropic.claude-opus-5')).toBeNull();
    expect(resolveTurnModelCorrection(CORRECTED, 'gemini-3.5-flash')).toBeNull();
  });

  it.each(['honored', 'defaulted', 'blocked', undefined, null])(
    'stamps nothing for modelSelection %p',
    (modelSelection) => {
      expect(
        resolveTurnModelCorrection({ ...CORRECTED, modelSelection }, 'gemini-3.1-flash-lite'),
      ).toBeNull();
    },
  );

  it('stamps nothing for an equal pair', () => {
    expect(
      resolveTurnModelCorrection(
        { requestedModel: 'gemini-3.1-flash-lite', effectiveModel: 'gemini-3.1-flash-lite', modelSelection: 'corrected' },
        'gemini-3.1-flash-lite',
      ),
    ).toBeNull();
  });

  it.each([
    { modelSelection: 'corrected', effectiveModel: 'gemini-3.1-flash-lite' },
    { modelSelection: 'corrected', requestedModel: 'anthropic.claude-opus-5' },
    {},
  ])('stamps nothing for an incomplete decision %p', (decision) => {
    expect(resolveTurnModelCorrection(decision, 'gemini-3.1-flash-lite')).toBeNull();
  });

  it('stamps nothing when there is no decision or no model', () => {
    expect(resolveTurnModelCorrection(null, 'gemini-3.1-flash-lite')).toBeNull();
    expect(resolveTurnModelCorrection(undefined, 'gemini-3.1-flash-lite')).toBeNull();
    expect(resolveTurnModelCorrection(CORRECTED, null)).toBeNull();
  });
});
