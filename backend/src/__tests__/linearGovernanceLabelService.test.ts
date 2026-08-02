import { manageLinearGovernanceLabel } from '../services/linearGovernanceLabelService';

const routeEmma = {
  id: 'label-emma',
  name: 'Route: Emma',
  description: 'Old description',
  color: '#123456',
};
const catalog = (labels = [routeEmma]) => ({
  teams: { nodes: [{ labels: { nodes: labels, pageInfo: { hasNextPage: false } } }] },
});

describe('manageLinearGovernanceLabel', () => {
  const base = {
    labelName: 'Route: Emma',
    reason: 'Keep autonomous intake definitions accurate',
    actor: 'harsha@agentweb.pro',
  };

  it('rejects labels outside the governance allowlist before calling Linear', async () => {
    const graphql = jest.fn();
    await expect(manageLinearGovernanceLabel(
      { ...base, labelName: 'Customer Reported' },
      { graphql },
    )).rejects.toThrow('not an allowlisted governance label');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('rejects overlong descriptions before calling Linear', async () => {
    const graphql = jest.fn();
    await expect(manageLinearGovernanceLabel(
      { ...base, description: 'x'.repeat(1_001) },
      { graphql },
    )).rejects.toThrow('exceeds 1000');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('fails loudly when the allowlisted label is missing', async () => {
    await expect(manageLinearGovernanceLabel(base, {
      graphql: jest.fn().mockResolvedValue(catalog([])),
    })).rejects.toThrow('was not found');
  });

  it('does not mutate when the planned audit record cannot be written', async () => {
    const graphql = jest.fn().mockResolvedValue(catalog());
    await expect(manageLinearGovernanceLabel(
      { ...base, description: 'New description' },
      {
        graphql,
        audit: jest.fn().mockRejectedValue(new Error('audit unavailable')),
      },
    )).rejects.toThrow('audit unavailable');
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('returns verified proposed values in dry-run mode without mutating', async () => {
    const graphql = jest.fn().mockResolvedValue(catalog());
    const audit = jest.fn().mockResolvedValue(undefined);
    const result = await manageLinearGovernanceLabel(
      { ...base, description: 'New description', dryRun: true },
      { graphql, audit, now: () => '2026-07-27T00:00:00.000Z' },
    );
    expect(result).toMatchObject({
      dryRun: true,
      changed: true,
      verified: true,
      after: { description: 'New description' },
    });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'verified',
      actor: 'harsha@agentweb.pro',
      verified: true,
    }));
  });

  it('updates once, verifies readback, and is idempotent when values already match', async () => {
    const desired = { ...routeEmma, description: 'Autonomous Emma queue' };
    const graphql = jest.fn()
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce({ issueLabelUpdate: { success: true } })
      .mockResolvedValueOnce({ issueLabel: desired });
    const audit = jest.fn().mockResolvedValue(undefined);
    const updated = await manageLinearGovernanceLabel(
      { ...base, description: desired.description },
      { graphql, audit },
    );
    expect(updated).toMatchObject({ changed: true, verified: true, after: desired });
    expect(graphql.mock.calls[1][1]).toEqual({
      id: routeEmma.id,
      input: { description: desired.description },
    });

    graphql.mockReset().mockResolvedValue(catalog([desired]));
    const unchanged = await manageLinearGovernanceLabel(
      { ...base, description: desired.description },
      { graphql, audit },
    );
    expect(unchanged).toMatchObject({ changed: false, verified: true });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('surfaces Linear update failures and never claims readback success', async () => {
    const graphql = jest.fn()
      .mockResolvedValueOnce(catalog())
      .mockRejectedValueOnce(new Error('Linear unavailable'));
    await expect(manageLinearGovernanceLabel(
      { ...base, color: '#abcdef' },
      { graphql, audit: jest.fn().mockResolvedValue(undefined) },
    )).rejects.toThrow('Linear unavailable');
    expect(graphql).toHaveBeenCalledTimes(2);
  });
});
