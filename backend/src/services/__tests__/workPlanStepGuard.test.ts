/**
 * ENG-1221 — the destructive-update guard must live where the write happens.
 *
 * `manage_predefined_work_plan` promises two protections: `steps_mode: "merge"`
 * amends named steps without touching the others, and `confirm_step_removal`
 * gates any update that would drop steps or blank fields on the steps it keeps.
 *
 * Both were implemented inside the MCP tool. `PUT /api/admin/work-plans/:planId`
 * — the endpoint that actually writes — knew about neither. So a caller that
 * reached the endpoint directly got `steps_mode` silently ignored, a partial
 * array treated as a full replace, every omitted field erased, and HTTP 200
 * with `stepsChange: null` in response.
 *
 * That is not hypothetical. It destroyed all ten step descriptions on the
 * Google Pre-Launch Gate plan (~20.3k chars) on 2026-08-14, recovered only
 * because a snapshot happened to exist. The guard being one layer above the
 * damage is the whole defect.
 */

import {
  findStepContentLoss,
  summarizeStepChange,
  mergeWorkPlanSteps,
} from '../workPlanSteps';

const step = (n: number, over: Record<string, any> = {}) => ({
  stepCount: n,
  title: `Step ${n}: real title`,
  description: `A description for step ${n} that took someone a long time to write.`,
  requiredFunctionCalls: ['list_connected_accounts'],
  skillIds: ['skill-a'],
  ...over,
});

const TEN = Array.from({ length: 10 }, (_, i) => step(i + 1));

describe('findStepContentLoss (ENG-1221)', () => {
  it('flags the exact payload that destroyed the Pre-Launch Gate plan', () => {
    // stepCount + skillIds only, intending to "just change the skill".
    const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
    const loss = findStepContentLoss(TEN, partial);
    expect(loss).toHaveLength(10);
  });

  it('names which fields would be blanked, not merely that something would be', () => {
    const partial = [{ stepCount: 1, skillIds: ['skill-b'] }];
    const loss = findStepContentLoss([TEN[0]], partial);
    const fields = JSON.stringify(loss);
    expect(fields).toContain('description');
    expect(fields).toContain('title');
  });

  it('reports no loss when every step is re-sent whole', () => {
    expect(findStepContentLoss(TEN, TEN)).toHaveLength(0);
  });

  it('reports no loss when a field changes value rather than disappearing', () => {
    const edited = TEN.map((s) => ({ ...s, description: 'a different but present description' }));
    expect(findStepContentLoss(TEN, edited)).toHaveLength(0);
  });

  it('treats an empty string as blanking, not as a value', () => {
    // The failure mode is content vanishing. '' is how it vanishes in practice.
    const blanked = [{ ...TEN[0], description: '' }];
    expect(findStepContentLoss([TEN[0]], blanked).length).toBeGreaterThan(0);
  });
});

describe('findStepContentLoss — pairing must survive a reorder (Greptile, ENG-1221)', () => {
  const before = [
    { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
    { stepCount: 2, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
  ];

  it('flags erasure on a step that was renamed and moved in the same replace', () => {
    // Beta moves to position 1. Alpha is renamed, so it matches no title, and
    // the old positional fallback then paired it with Beta's entry — which is
    // fully populated, so the erasure of Alpha's description read as no loss.
    const after = [
      { stepCount: 1, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
      { stepCount: 2, title: 'Alpha v2', description: '', skillIds: ['a'], requiredFunctionCalls: ['f'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss).toHaveLength(1);
    expect(loss[0].title).toBe('Alpha');
    expect(loss[0].fields).toContain('description');
  });

  it('never pairs one incoming step against two existing ones', () => {
    // Only Beta is re-sent. Alpha has no counterpart at all, so its content is
    // gone — reporting nothing here is how a rewrite erases a step silently.
    const after = [{ stepCount: 1, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] }];
    const loss = findStepContentLoss(before, after);
    expect(loss.map((l: any) => l.title)).toEqual(['Alpha']);
  });

  it('flags a step destroyed under a duplicated title, where positional fallback cross-pairs', () => {
    // Alpha is erased and replaced by a second copy of Beta. Two entries now
    // share Beta's title, so title matching is ambiguous and both fall through
    // to the positional pass — which pairs Alpha against a Beta that is fully
    // populated. Every field looks "changed, not blanked", so the destruction
    // of Alpha reads as no loss at all.
    const after = [
      { stepCount: 1, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
      { stepCount: 2, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss.map((l: any) => l.title)).toEqual(['Alpha']);
  });

  it('flags a step replaced in place by a different, fully populated step', () => {
    // Alpha is kept; Beta is deleted and a brand-new step takes its stepCount.
    // Positional fallback pairs Beta with the newcomer, whose fields are all
    // populated, so nothing reads as "blanked" — and the count is unchanged, so
    // the removal guard never fires either. Beta's content is simply gone.
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Gamma', description: 'GAMMA', skillIds: ['c'], requiredFunctionCalls: ['h'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss.map((l: any) => l.title)).toEqual(['Beta']);
  });

  it('flags erasure when every step is renamed and reordered at once', () => {
    // Rename and move BOTH steps, blanking Beta's content on the way. Nothing
    // pairs, so "nothing was kept" looks true and the wholesale-rewrite
    // carve-out would swallow the erasure — a same-length write, so the count
    // guard never fires either. A real rewrite brings its own content; a hollow
    // step in the replacement is erasure wearing a rewrite's clothes.
    const after = [
      { stepCount: 1, title: 'Gamma', description: '', skillIds: [], requiredFunctionCalls: [] },
      { stepCount: 2, title: 'Delta', description: 'DELTA', skillIds: ['d'], requiredFunctionCalls: ['i'] },
    ];
    expect(findStepContentLoss(before, after).length).toBeGreaterThan(0);
  });

  it('stays silent on a wholesale rewrite where nothing was kept', () => {
    // The carve-out that makes "replace this plan" possible at all: no step was
    // recognised, so none was plainly meant to survive, and droppedStepTitles
    // already reports what went. Only an unpaired step ALONGSIDE a recognised
    // one is content the caller did not mean to drop.
    const after = [
      { title: 'Brand new A', description: 'a' },
      { title: 'Brand new B', description: 'b' },
    ];
    expect(findStepContentLoss(before, after)).toHaveLength(0);
  });

  it('still reports no loss for a plain reorder that keeps every field', () => {
    const after = [
      { stepCount: 1, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
      { stepCount: 2, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
    ];
    expect(findStepContentLoss(before, after)).toHaveLength(0);
  });

  it('still reports no loss for a rename in place that keeps every field', () => {
    // The common, harmless case: same order, same content, new wording. The
    // stepCount fallback must still find it, or every rename trips the guard.
    const after = [
      { stepCount: 1, title: 'Alpha v2', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    expect(findStepContentLoss(before, after)).toHaveLength(0);
  });
});

describe('findStepContentLoss — a refusal must say which KIND of loss it saw (Greptile round 2)', () => {
  // Greptile flagged the rename-with-edits case: keep step 1, rename step 2 and
  // change one of its populated fields, and the endpoint refuses with 400.
  //
  // The refusal is correct and must stay. At equal length the shrink guard never
  // fires (it tests `after.length < before.length`), so this function is the ONLY
  // thing between a caller and a step being destroyed in place. And "renamed with
  // an edit" is byte-for-byte indistinguishable from "deleted, replaced by a new
  // step at the same number" — same stepCount, a title belonging to no other
  // step, different content. No rule over this data can separate them, so the
  // safe default is the right one: a false refusal costs one retry, a false pass
  // destroyed 20.3k characters of someone's work.
  //
  // What was genuinely wrong is the REPORT. Both cases came back as "fields that
  // are currently set would be blanked", which is false here — nothing is being
  // blanked, the slot is being handed different content. Naming the two kinds
  // apart is what lets the endpoint explain itself honestly.
  const before = [
    { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
    { stepCount: 2, title: 'Beta', description: 'BETA', skillIds: ['b'], requiredFunctionCalls: ['g'] },
  ];

  it('marks a rename-with-edits as unpaired, not as blanking', () => {
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Beta v2', description: 'BETA REWORDED', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss).toHaveLength(1);
    expect(loss[0].title).toBe('Beta');
    expect(loss[0].kind).toBe('unpaired');
  });

  it('still marks a genuinely emptied field as blanked', () => {
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Beta', description: '', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss).toHaveLength(1);
    expect(loss[0].kind).toBe('blanked');
    expect(loss[0].fields).toEqual(['description']);
  });

  it('keeps refusing the rename-with-edits — the safe default is the point', () => {
    // Pinning the behaviour Greptile asked to remove, so a future edit cannot
    // quietly turn a same-length step replacement back into a silent 200.
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Beta v2', description: 'BETA REWORDED', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    expect(findStepContentLoss(before, after).length).toBeGreaterThan(0);
  });

  it('reports the replaced-by-a-different-step case as unpaired too', () => {
    // The indistinguishable twin of the case above. Same verdict, same kind —
    // if these two ever reported differently, the function would be claiming a
    // distinction the data cannot support.
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Gamma', description: 'GAMMA', skillIds: ['c'], requiredFunctionCalls: ['h'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss.map((l: any) => [l.title, l.kind])).toEqual([['Beta', 'unpaired']]);
  });

  it('merge mode performs the rename-and-edit without touching anything else', () => {
    // The remedy the endpoint already recommends first. Worth pinning: if merge
    // ever stopped handling rename+edit cleanly, the refusal above would become
    // a dead end instead of a signpost. (The route runs the loss check only on
    // the replace path, so merge output is never gated by it — what matters here
    // is that the merge itself preserves the untouched fields.)
    const merged = mergeWorkPlanSteps(before, [
      { stepCount: 2, title: 'Beta v2', description: 'BETA REWORDED' },
    ]);
    const second = merged.find((s: any) => s.stepCount === 2);
    expect(second.title).toBe('Beta v2');
    expect(second.description).toBe('BETA REWORDED');
    expect(second.skillIds).toEqual(['b']);
    expect(second.requiredFunctionCalls).toEqual(['g']);
    expect(merged.find((s: any) => s.stepCount === 1)).toEqual(before[0]);
  });

  it('does not list fields as lost when the replacement carries them unchanged', () => {
    // The reporting bug underneath Greptile's complaint. An unpaired step used to
    // have EVERY populated field listed as lost, so a rename that edited only the
    // description accused the payload of dropping skillIds and
    // requiredFunctionCalls that are sitting right there, identical, in the step
    // occupying that stepCount. The refusal stands; the accusation must be true.
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Beta v2', description: 'BETA REWORDED', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss).toHaveLength(1);
    expect(loss[0].fields).not.toContain('skillIds');
    expect(loss[0].fields).not.toContain('requiredFunctionCalls');
  });

  it('still lists a field the replacement genuinely drops on an unpaired step', () => {
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'Beta v2', description: 'BETA REWORDED', skillIds: [], requiredFunctionCalls: ['g'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss[0].kind).toBe('unpaired');
    expect(loss[0].fields).toContain('skillIds');
  });

  it('lists everything when the step simply did not come back at all', () => {
    // No candidate at that stepCount, so there is nothing carrying its content
    // and the full populated set is the honest answer.
    const after = [
      { stepCount: 1, title: 'Alpha', description: 'ALPHA', skillIds: ['a'], requiredFunctionCalls: ['f'] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss).toHaveLength(1);
    expect(loss[0].title).toBe('Beta');
    expect(loss[0].fields).toEqual(
      expect.arrayContaining(['description', 'skillIds', 'requiredFunctionCalls']),
    );
  });
});

describe('findStepContentLoss — the rewrite carve-out must not swallow an amendment (Greptile round 3)', () => {
  // `replacementCarriesContent` asked only whether each incoming step had SOME
  // content. A payload that renamed and renumbered every step — so nothing
  // paired — while keeping the descriptions and dropping the skillIds therefore
  // read as a deliberate wholesale rewrite, and every loss was suppressed. The
  // endpoint persisted the blanked field with HTTP 200 and no stepContentLoss.
  //
  // What separates the two is whether the incoming plan REUSES the prose of the
  // one it replaces. Nobody writes a genuinely new plan whose step description
  // is byte-identical to the old one's; that is an amendment that lost its
  // footing. Only prose counts — skillIds and requiredFunctionCalls repeat
  // across unrelated plans all the time, so treating those as evidence of
  // amendment would refuse ordinary rewrites.
  const before = [
    { stepCount: 1, title: 'Alpha', description: 'SHARED-A', skillIds: ['a'], requiredFunctionCalls: ['f'] },
    { stepCount: 2, title: 'Beta', description: 'SHARED-B', skillIds: ['b'], requiredFunctionCalls: ['g'] },
  ];

  it('flags a renumbered rewrite that keeps the prose but drops the skillIds', () => {
    const after = [
      { stepCount: 3, title: 'Gamma', description: 'SHARED-A', skillIds: [], requiredFunctionCalls: [] },
      { stepCount: 4, title: 'Delta', description: 'SHARED-B', skillIds: [], requiredFunctionCalls: [] },
    ];
    const loss = findStepContentLoss(before, after);
    expect(loss.length).toBeGreaterThan(0);
    expect(JSON.stringify(loss)).toContain('skillIds');
  });

  it('still stays silent on a genuinely new plan that supplies no skillIds', () => {
    // The capability the carve-out exists for. A fresh plan whose steps carry
    // only descriptions must not be refused, or replacing a plan becomes
    // impossible without confirm_step_removal.
    const after = [
      { stepCount: 1, title: 'New One', description: 'brand new text 1', skillIds: [], requiredFunctionCalls: [] },
      { stepCount: 2, title: 'New Two', description: 'brand new text 2', skillIds: [], requiredFunctionCalls: [] },
    ];
    expect(findStepContentLoss(before, after)).toHaveLength(0);
  });

  it('does not treat a reused skillId as evidence of an amendment', () => {
    // A new plan may legitimately drive the same skill. If low-cardinality
    // fields counted, this ordinary rewrite would be refused.
    const after = [
      { stepCount: 1, title: 'New One', description: 'brand new text 1', skillIds: ['a'], requiredFunctionCalls: ['f'] },
      { stepCount: 2, title: 'New Two', description: 'brand new text 2', skillIds: ['b'], requiredFunctionCalls: ['g'] },
    ];
    expect(findStepContentLoss(before, after)).toHaveLength(0);
  });

  it('flags reuse of userInstructions just as it flags a reused description', () => {
    const withInstructions = [
      { stepCount: 1, title: 'Alpha', userInstructions: 'DO THE THING', skillIds: ['a'] },
      { stepCount: 2, title: 'Beta', userInstructions: 'DO THE OTHER', skillIds: ['b'] },
    ];
    const after = [
      { stepCount: 3, title: 'Gamma', userInstructions: 'DO THE THING', skillIds: [] },
      { stepCount: 4, title: 'Delta', userInstructions: 'DO THE OTHER', skillIds: [] },
    ];
    expect(findStepContentLoss(withInstructions, after).length).toBeGreaterThan(0);
  });
});

describe('summarizeStepChange (ENG-1221 AC3)', () => {
  it('reports a diff when steps actually changed', () => {
    const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
    const s = summarizeStepChange(TEN, partial, 'replace');
    expect(s).toBeTruthy();
    expect(s.stepsBefore).toBe(10);
  });

  it('counts removed steps so a shrink is visible in the response', () => {
    const s = summarizeStepChange(TEN, TEN.slice(0, 4), 'replace');
    expect(s.stepsBefore).toBe(10);
    expect(s.stepsAfter).toBe(4);
    expect(s.stepsRemoved).toBe(6);
  });

  it('names the dropped steps rather than only counting them', () => {
    const s = summarizeStepChange(TEN, TEN.slice(0, 9), 'replace');
    expect(JSON.stringify(s.droppedStepTitles)).toContain('Step 10');
  });
});

describe('mergeWorkPlanSteps — what the endpoint must do for steps_mode=merge', () => {
  it('changes only the named field and preserves everything else', () => {
    const merged = mergeWorkPlanSteps(TEN, [{ stepCount: 3, skillIds: ['skill-b'] }]);
    expect(merged).toHaveLength(10);
    const third = merged.find((s: any) => s.stepCount === 3);
    expect(third.skillIds).toEqual(['skill-b']);
    expect(third.description).toBe(TEN[2].description);
    expect(third.title).toBe(TEN[2].title);
  });

  it('leaves every untouched step byte-identical', () => {
    const merged = mergeWorkPlanSteps(TEN, [{ stepCount: 3, skillIds: ['skill-b'] }]);
    for (const n of [1, 2, 4, 5, 6, 7, 8, 9, 10]) {
      expect(merged.find((s: any) => s.stepCount === n)).toEqual(TEN[n - 1]);
    }
  });

  it('a merge of the real-world payload loses nothing', () => {
    // The same input that was destructive as a replace must be safe as a merge.
    const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
    const merged = mergeWorkPlanSteps(TEN, partial);
    expect(findStepContentLoss(TEN, merged)).toHaveLength(0);
    expect(merged.every((s: any) => s.description)).toBe(true);
  });
});
