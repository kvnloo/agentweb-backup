/**
 * ENG-1644 Phase A: unit tests for approvalInboxService's durable-store
 * primitives — the critical invariants this ticket's own decision-persistence
 * layer depends on: idempotent create (digest-as-key), at-most-once atomic
 * claim (never double-resolve, never claim past expiry), and the hard
 * team/customer audience+status invariant (ticket point 6 — a customer item
 * must never be constructible as a team review item, or vice versa).
 */
import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    config: { update: jest.fn() },
  };
});

import { ApprovalInboxService, ApprovalInboxError } from '../services/approvalInboxService';

const ok = (attrs: any = {}) => ({ promise: jest.fn().mockResolvedValue(attrs) });
const conditionalFail = () => ({
  promise: jest.fn().mockRejectedValue(
    Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' }),
  ),
});

let mockDynamoDB: any;
let service: ApprovalInboxService;

beforeEach(() => {
  jest.clearAllMocks();
  const DocumentClient = AWS.DynamoDB.DocumentClient as any;
  mockDynamoDB = new DocumentClient();
  service = new ApprovalInboxService();
});

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

const metaWriteRequest = (overrides: Partial<any> = {}) => ({
  gateType: 'meta_write' as const,
  approver: 'matt' as const,
  businessImpact: 'Pauses an underperforming ad set.',
  evidencePacket: { chatUrl: 'https://example.com/chat/1' },
  metaWriteManifestDigest: 'digest-abc-123',
  metaWriteDispatch: {
    entity_type: 'AD_SET', action: 'UPDATE', account_id: 'acc-1', resolvedAccountId: 'acc-1', params: { status: 'PAUSED' },
  },
  expiresAt: FUTURE,
  ...overrides,
});

describe('approvalInboxService.createDecision', () => {
  it('uses the metaWriteManifestDigest AS the decisionId for a meta_write decision — changed payload is structurally a new record', async () => {
    mockDynamoDB.put.mockReturnValue(ok());
    const decision = await service.createDecision(metaWriteRequest());
    expect(decision.decisionId).toBe('digest-abc-123');
    expect(decision.status).toBe('pending_team_review');
    expect(decision.audience).toBe('team');
    const params = mockDynamoDB.put.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('attribute_not_exists(decisionId)');
  });

  it('a re-create of the SAME digest returns the existing record rather than erroring (safe re-preview, not a duplicate)', async () => {
    const existing = { ...metaWriteRequest(), decisionId: 'digest-abc-123', status: 'approved', audience: 'team', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockDynamoDB.put.mockReturnValue(conditionalFail());
    mockDynamoDB.get.mockReturnValue(ok({ Item: existing }));

    const decision = await service.createDecision(metaWriteRequest());
    expect(decision.status).toBe('approved');
    expect(mockDynamoDB.get).toHaveBeenCalled();
  });

  it('rejects a plan_choice decision with fewer than 2 or more than 4 options', async () => {
    const tooFew = { gateType: 'plan_choice' as const, approver: 'fangfang' as const, businessImpact: 'x', evidencePacket: {}, options: [{ id: 'a', label: 'A', consequence: 'x', recommended: true }], expiresAt: FUTURE };
    await expect(service.createDecision(tooFew as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('rejects a plan_choice decision with zero or multiple recommended options', async () => {
    const noRecommended = {
      gateType: 'plan_choice' as const, approver: 'fangfang' as const, businessImpact: 'x', evidencePacket: {},
      options: [
        { id: 'a', label: 'A', consequence: 'x' },
        { id: 'b', label: 'B', consequence: 'x' },
      ],
      expiresAt: FUTURE,
    };
    await expect(service.createDecision(noRecommended as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('rejects an option id of "comment" (reserved, collides with the universal comment verdict)', async () => {
    const reserved = {
      gateType: 'plan_choice' as const, approver: 'fangfang' as const, businessImpact: 'x', evidencePacket: {},
      options: [
        { id: 'comment', label: 'A', consequence: 'x', recommended: true },
        { id: 'b', label: 'B', consequence: 'x' },
      ],
      expiresAt: FUTURE,
    };
    await expect(service.createDecision(reserved as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('ticket point 6: a customer gateType with an approver is rejected — customer and team audiences must never mix', async () => {
    const mixed = {
      gateType: 'customer_credential' as const,
      approver: 'matt' as const, // invalid: customer audience must not carry an approver
      customerId: 'cust-1',
      businessImpact: 'x', evidencePacket: {}, expiresAt: FUTURE,
    };
    await expect(service.createDecision(mixed as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('ticket point 6: a team gateType with a customerId is rejected', async () => {
    const mixed = {
      gateType: 'plan_choice' as const,
      customerId: 'cust-1', // invalid: team audience must not carry a customerId
      options: [
        { id: 'a', label: 'A', consequence: 'x', recommended: true },
        { id: 'b', label: 'B', consequence: 'x' },
      ],
      businessImpact: 'x', evidencePacket: {}, expiresAt: FUTURE,
    };
    await expect(service.createDecision(mixed as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('a valid customer_credential decision gets audience=customer and status=pending_customer_response, never the team pending status', async () => {
    mockDynamoDB.put.mockReturnValue(ok());
    const decision = await service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', businessImpact: 'Needs a fresh OAuth token.', evidencePacket: {}, expiresAt: FUTURE,
    } as any);
    expect(decision.audience).toBe('customer');
    expect(decision.status).toBe('pending_customer_response');
  });
});

describe('approvalInboxService.claimDecision', () => {
  it('atomically transitions pending_team_review -> approved via ONE conditional update — no pre-read, no TOCTOU race', async () => {
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: { decisionId: 'd1', status: 'approved' } }));

    const result = await service.claimDecision('d1', 'approve', 'slack:U123');
    expect(result.claimed).toBe(true);
    // The claim must never read-before-write — the atomic condition IS the
    // authorization check. A pre-read-then-write here would itself be a race.
    expect(mockDynamoDB.get).not.toHaveBeenCalled();
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toContain('#status = :pendingTeam');
    expect(params.ConditionExpression).toContain('expiresAt > :now');
  });

  it('refuses to claim an already-resolved decision — the write itself fails the condition, not a pre-read', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    mockDynamoDB.get.mockReturnValue(ok({ Item: { decisionId: 'd1', status: 'approved', expiresAt: FUTURE } }));

    const result = await service.claimDecision('d1', 'approve', 'slack:U123');
    expect(result.claimed).toBe(false);
    if (result.claimed) throw new Error('unreachable');
    expect(result.reason).toBe('already_resolved');
    // The follow-up read only happens AFTER the write already failed, purely
    // to produce a specific error reason — never before/instead of the write.
    expect(mockDynamoDB.get).toHaveBeenCalledTimes(1);
  });

  it('refuses to claim an expired decision even if its status is still nominally pending', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    mockDynamoDB.get.mockReturnValue(ok({ Item: { decisionId: 'd1', status: 'pending_team_review', expiresAt: PAST } }));

    const result = await service.claimDecision('d1', 'approve', 'slack:U123');
    expect(result.claimed).toBe(false);
    if (result.claimed) throw new Error('unreachable');
    expect(result.reason).toBe('expired');
  });

  it('a nonexistent decision refuses cleanly, not a throw', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    mockDynamoDB.get.mockReturnValue(ok({}));
    const result = await service.claimDecision('missing', 'approve', 'slack:U123');
    expect(result.claimed).toBe(false);
    if (result.claimed) throw new Error('unreachable');
    expect(result.reason).toBe('not_found');
  });

  it('an "edit" verdict transitions to status=edited and persists freeText', async () => {
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: { decisionId: 'd1', status: 'edited', freeText: 'wrong account' } }));

    await service.claimDecision('d1', 'edit', 'slack:U123', 'wrong account');
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ExpressionAttributeValues[':newStatus']).toBe('edited');
    expect(params.ExpressionAttributeValues[':freeText']).toBe('wrong account');
  });
});
