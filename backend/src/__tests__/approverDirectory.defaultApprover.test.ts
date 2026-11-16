import { getDefaultApproverForGate } from '../services/approverDirectory';

describe('getDefaultApproverForGate', () => {
  it('routes Meta write review to Matt, matching the eval queue (never Harsha by default)', () => {
    expect(getDefaultApproverForGate('meta_write')).toBe('matt');
  });

  it('returns a named approver for any gate type so a staged decision is never unassigned', () => {
    expect(['matt', 'harsha', 'fangfang']).toContain(getDefaultApproverForGate('plan_choice'));
    expect(['matt', 'harsha', 'fangfang']).toContain(getDefaultApproverForGate('some_future_gate'));
  });
});
