/*
 * The live case: a delegated session on a real customer account where the skill gate refused
 * `audit_ad_utm_coverage`, `install_skills` was refused by subscription, and the model then ran
 * an unrelated `call_meta_marketing_api` AD LIST and presented a confident
 * "UTM Tagging Audit Summary — PASS, 6/6 ads tagged (100%)" table built from it.
 *
 * `buildFalseClaimCorrectionFooter` did fire — but only because that claim carried a checkable
 * number, and it appended the correction BELOW the fabricated table. This notice exists because
 * both of those are the wrong shape for a fabricated certification: it is unconditional (a claim
 * phrased in a way no detector anticipates is exactly what a conditional guard misses) and it is
 * prepended by the caller.
 */
import { buildUnavailableCapabilityNotice } from '../synthesisResidue';

const gateError = (tool: string) =>
  `Tool "${tool}" is not available. You must install the required skill first using install_skills.`;

describe('buildUnavailableCapabilityNotice', () => {
  it('names a tool the gate refused that never afterwards succeeded', () => {
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', error: 'The requested skills are not available with your current subscription.' },
      { name: 'call_meta_marketing_api', result: { success: true } },
    ] as any);

    expect(notice).toContain('audit_ad_utm_coverage');
    expect(notice).toMatch(/did not run/i);
  });

  it('says nothing when the refused tool was installed and then ran', () => {
    // A tool refused once and then successfully run is not an unavailable capability, and
    // warning about it would train readers to ignore the notice.
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', result: { success: true } },
      { name: 'audit_ad_utm_coverage', result: { success: true } },
    ] as any);

    expect(notice).toBeNull();
  });

  it('says nothing on an ordinary turn', () => {
    expect(
      buildUnavailableCapabilityNotice([{ name: 'call_meta_marketing_api', result: { ok: true } }] as any),
    ).toBeNull();
    expect(buildUnavailableCapabilityNotice([] as any)).toBeNull();
  });

  it('ignores failures that are not availability failures', () => {
    // A tool that ran and errored is a different situation; the model can describe it.
    const notice = buildUnavailableCapabilityNotice([
      { name: 'call_meta_marketing_api', error: 'Meta API Error: Invalid parameter' },
    ] as any);

    expect(notice).toBeNull();
  });

  it('lists every unavailable capability once, deterministically', () => {
    const notice = buildUnavailableCapabilityNotice([
      { name: 'b_tool', error: gateError('b_tool') },
      { name: 'a_tool', error: gateError('a_tool') },
      { name: 'b_tool', error: gateError('b_tool') },
    ] as any);

    expect(notice).toContain('a_tool');
    expect(notice).toContain('b_tool');
    // Ordered, so the same turn does not produce a different string run to run.
    expect(notice!.indexOf('a_tool')).toBeLessThan(notice!.indexOf('b_tool'));
    expect(notice!.match(/b_tool/g)).toHaveLength(1);
  });

  it('warns that content below it did not come from the missing tool', () => {
    // The whole point: the reader must not take what follows as that tool's output.
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
    ] as any);

    expect(notice).toMatch(/was not produced by that tool/i);
  });
});
