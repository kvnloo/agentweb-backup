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

  it('says nothing when the gate was cleared by a successful install, even if the tool never ran', () => {
    /*
     * THE common healthy path, and the one this guard must not fire on: the gate error names
     * install_skills as the remedy, so "tool gated -> skill installed -> model moved on without
     * re-running that exact tool" is routine. Warning there would put a scary banner on ordinary
     * turns, and a warning that appears when nothing is wrong is one people learn to skip —
     * exactly when it finally matters.
     */
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', result: { success: true } },
      { name: 'call_meta_marketing_api', result: { success: true } },
    ] as any);

    expect(notice).toBeNull();
  });

  it('is silent when the model never tried to obtain the capability', () => {
    /*
     * Narrowed after review: the gate refuses ANY name not in the session's allowed set,
     * including one the model tried speculatively and then simply did without. Warning there
     * puts a banner above a correct answer. Attempting an install is the model's own signal
     * that it needed the capability; an install of some OTHER skill beforehand is not that
     * signal, so this stays silent.
     */
    const notice = buildUnavailableCapabilityNotice([
      { name: 'install_skills', result: { success: true } },
      { name: 'search_web', error: gateError('search_web') },
    ] as any);

    expect(notice).toBeNull();
  });

  it('is silent for a purely speculative gated call with no install attempt at all', () => {
    const notice = buildUnavailableCapabilityNotice([
      { name: 'search_web', error: gateError('search_web') },
      { name: 'read_brand_guidelines', result: { ok: true } },
    ] as any);

    expect(notice).toBeNull();
  });

  it('fires on the real trace: gate refusal followed by a FAILED install', () => {
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', error: 'The requested skills are not available with your current subscription.' },
      { name: 'call_meta_marketing_api', result: { success: true } },
    ] as any);

    expect(notice).toContain('audit_ad_utm_coverage');
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
      { name: 'install_skills', result: { success: false, message: 'not available' } },
    ] as any);

    expect(notice).toContain('a_tool');
    expect(notice).toContain('b_tool');
    // Ordered, so the same turn does not produce a different string run to run.
    expect(notice!.indexOf('a_tool')).toBeLessThan(notice!.indexOf('b_tool'));
    expect(notice!.match(/b_tool/g)).toHaveLength(1);
  });

  it('fires when the failed install returned { success: false } instead of throwing', () => {
    /*
     * Several installSkills paths report failure as a RESULT, not a throw. Keying "the install
     * worked" off a missing `error` read those as successes and disarmed this notice on exactly
     * the live incident it exists for — the fixture below is the shape that hole hid behind.
     */
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', result: { success: false, message: 'not available with your current subscription' } },
    ] as any);

    expect(notice).toContain('audit_ad_utm_coverage');
  });

  it('fires when the failed install landed BEFORE the refusal in the same assistant message', () => {
    /*
     * Parallel tool calls in one assistant message land in the ledger in whatever order the
     * model emitted them. The old predicate required the install to come strictly AFTER the
     * refusal, so this identical turn armed or disarmed the notice purely on that ordering —
     * a model that asks for the skill first and then tries the tool (the more sensible order)
     * silently got no notice at all.
     */
    const notice = buildUnavailableCapabilityNotice([
      { name: 'install_skills', result: { success: false, message: 'not available with your current subscription' } },
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
    ] as any);

    expect(notice).toContain('audit_ad_utm_coverage');
  });

  it('fires when the install was PARTIAL — success:true with some skills refused', () => {
    /*
     * A partial install reports `success: true` because something installed, while the ONE
     * skill the gated tool needed may be exactly the one that was refused. Reading that as a
     * clean install disarmed the notice on the shape it is most likely to be needed for.
     */
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      {
        name: 'install_skills',
        result: {
          success: true,
          message: 'Successfully installed 1 skill(s). 1 skill(s) were not available with your subscription.',
          installedSkills: ['Some Other Skill'],
          rejectedSkillIds: ['utm-audit'],
        },
      },
    ] as any);

    expect(notice).toContain('audit_ad_utm_coverage');
  });

  it('warns that content below it did not come from the missing tool', () => {
    // The whole point: the reader must not take what follows as that tool's output.
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', error: 'The requested skills are not available with your current subscription.' },
    ] as any);

    expect(notice).toMatch(/was not produced by that tool/i);
  });

  it('still fires when the failed install is followed by an unrelated LATER successful one', () => {
    /*
     * Pins the ledger-index bug: `executePreparedTools` always appends Phase 1 preflight
     * failures (a skill-gate refusal is one) before any Phase 3 executed result, including every
     * `install_skills` outcome — so a later, unrelated install succeeding can never mean the
     * refused tool's own skill arrived. The old code kept an index comparison
     * (`installSucceededAfter > i`) that read this shape as "obtained afterward" and wrongly
     * stayed silent. `audit_ad_utm_coverage`'s own skill was never installed; a second,
     * different install_skills call succeeding later must not silence the notice.
     */
    const notice = buildUnavailableCapabilityNotice([
      { name: 'audit_ad_utm_coverage', error: gateError('audit_ad_utm_coverage') },
      { name: 'install_skills', error: 'The requested skills are not available with your current subscription.' },
      { name: 'install_skills', result: { success: true, installedSkills: ['Unrelated Skill'] } },
      { name: 'call_meta_marketing_api', result: { success: true } },
    ] as any);

    expect(notice).toContain('audit_ad_utm_coverage');
  });
});
