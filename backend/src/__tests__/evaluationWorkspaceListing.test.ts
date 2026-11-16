// ENG-1948: evaluation_workspace is only listed for principals that can pass the execute-time gate.
import { shouldOfferEvaluationWorkspace, requireEvaluationAdmin, EvaluationDenied } from '../services/evaluationPolicy';

describe('shouldOfferEvaluationWorkspace (ENG-1948)', () => {
  const admin = { userId: 'u_admin', isAdmin: true };
  it('offers to a direct, attended admin', () => {
    expect(shouldOfferEvaluationWorkspace(admin)).toBe(true);
    expect(shouldOfferEvaluationWorkspace({ ...admin, isUnattendedRun: false })).toBe(true);
  });
  it.each([
    ['non-admin', { ...admin, isAdmin: false }],
    ['delegated access', { ...admin, isDelegatedAccess: true }],
    ['interactive share', { ...admin, isInteractiveShare: true }],
    ['unattended/scheduled run', { ...admin, isUnattendedRun: true }],
    ['sandbox principal', { ...admin, userId: 'eval_abc' }],
  ])('hides from %s', (_label, input) => {
    expect(shouldOfferEvaluationWorkspace(input)).toBe(false);
  });
  it('execute-time gate still denies internal/delegated contexts (unchanged)', async () => {
    await expect(requireEvaluationAdmin('u_admin', { isInternal: true })).rejects.toBeInstanceOf(EvaluationDenied);
    await expect(requireEvaluationAdmin('u_admin', { delegateInfo: {} })).rejects.toBeInstanceOf(EvaluationDenied);
    await expect(requireEvaluationAdmin('eval_abc', {})).rejects.toBeInstanceOf(EvaluationDenied);
  });
});

describe('applyEvaluationWorkspaceListing (ENG-1948)', () => {
  const { applyEvaluationWorkspaceListing } = require('../services/agentMode/evaluationWorkspaceListing');
  const tools = [{ function: { name: 'evaluation_workspace' } }, { function: { name: 'web_search' } }];
  it('removes the tool from both the list and the dispatch allow-list when not offered', () => {
    const allowed = new Set(['evaluation_workspace', 'web_search']);
    const out = applyEvaluationWorkspaceListing(tools, allowed, false);
    expect(out.map((t: any) => t.function.name)).toEqual(['web_search']);
    expect(allowed.has('evaluation_workspace')).toBe(false);
  });
  it('leaves both untouched when offered', () => {
    const allowed = new Set(['evaluation_workspace']);
    expect(applyEvaluationWorkspaceListing(tools, allowed, true)).toBe(tools);
    expect(allowed.has('evaluation_workspace')).toBe(true);
  });
});
