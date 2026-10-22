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
  subjectLabel: 'Test Account · Meta Ad Set acc-1',
  businessImpact: 'Pauses an underperforming ad set.',
  evidencePacket: { chatUrl: 'https://example.com/chat/1' },
  metaWriteManifestDigest: 'digest-abc-123',
  metaWriteDispatch: {
    entity_type: 'AD_SET', action: 'UPDATE', account_id: 'acc-1', resolvedAccountId: 'acc-1', params: { status: 'PAUSED' },
  },
  manifestId: 'manifest-test-1',
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

  it('rejects a decision with no subjectLabel — regardless of audience or gateType (ENG-2159)', async () => {
    const missing = { gateType: 'plan_choice' as const, approver: 'fangfang' as const, businessImpact: 'x', evidencePacket: {}, options: [
      { id: 'a', label: 'A', consequence: 'x', recommended: true },
      { id: 'b', label: 'B', consequence: 'x' },
    ], expiresAt: FUTURE };
    await expect(service.createDecision(missing as any)).rejects.toThrow(/subjectLabel/);

    const blank = { ...missing, subjectLabel: '   ' };
    await expect(service.createDecision(blank as any)).rejects.toThrow(/subjectLabel/);
  });

  it('persists subjectLabel onto the created record', async () => {
    mockDynamoDB.put.mockReturnValue(ok());
    const decision = await service.createDecision(metaWriteRequest({ subjectLabel: 'Vincent Hu · TriCityAI 2041725529929988' }));
    expect(decision.subjectLabel).toBe('Vincent Hu · TriCityAI 2041725529929988');
  });

  it('persists subjectContactEmail when provided, and leaves it undefined when omitted (optional, unlike subjectLabel)', async () => {
    mockDynamoDB.put.mockReturnValue(ok());
    const withEmail = await service.createDecision(metaWriteRequest({ subjectContactEmail: 'vincent@thinkingai.com' }));
    expect(withEmail.subjectContactEmail).toBe('vincent@thinkingai.com');

    const withoutEmail = await service.createDecision(metaWriteRequest({ metaWriteManifestDigest: 'digest-no-email' }));
    expect(withoutEmail.subjectContactEmail).toBeUndefined();
  });

  it('rejects a plan_choice decision with fewer than 2 or more than 4 options', async () => {
    const tooFew = { gateType: 'plan_choice' as const, approver: 'fangfang' as const, subjectLabel: 'Test Account', businessImpact: 'x', evidencePacket: {}, options: [{ id: 'a', label: 'A', consequence: 'x', recommended: true }], expiresAt: FUTURE };
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
      gateType: 'customer_credential', customerId: 'cust-1', subjectLabel: 'Test Customer · Meta Ad Account act_123', businessImpact: 'Needs a fresh OAuth token.',
      evidencePacket: {}, customerActionUrl: 'https://app.agentweb.pro/settings?tab=connected-accounts',
      credentialPlatform: 'meta', credentialAccountId: 'act_123', manifestId: 'manifest-test-2', expiresAt: FUTURE,
    } as any);
    expect(decision.audience).toBe('customer');
    expect(decision.status).toBe('pending_customer_response');
    expect(decision.customerActionUrl).toBe('https://app.agentweb.pro/settings?tab=connected-accounts');
    expect(decision.credentialPlatform).toBe('meta');
    expect(decision.credentialAccountId).toBe('act_123');
  });

  it('a customer_credential decision without customerActionUrl is rejected', async () => {
    await expect(service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', businessImpact: 'x', evidencePacket: {},
      credentialPlatform: 'meta', credentialAccountId: 'act_123', expiresAt: FUTURE,
    } as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('a customer_credential decision without credentialPlatform is rejected', async () => {
    await expect(service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', businessImpact: 'x', evidencePacket: {},
      customerActionUrl: 'https://x', credentialAccountId: 'act_123', expiresAt: FUTURE,
    } as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('a customer_credential decision without credentialAccountId is rejected', async () => {
    await expect(service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', businessImpact: 'x', evidencePacket: {},
      customerActionUrl: 'https://x', credentialPlatform: 'meta', expiresAt: FUTURE,
    } as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('review fix: a credentialPlatform outside meta/instagram/linkedin/linkedin_ads is rejected — no route could ever auto-resolve it', async () => {
    await expect(service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', businessImpact: 'x', evidencePacket: {},
      customerActionUrl: 'https://x', credentialPlatform: 'Facebook Ads', credentialAccountId: 'act_123', expiresAt: FUTURE,
    } as any)).rejects.toThrow(ApprovalInboxError);
  });

  it('review fix: linkedin_ads is accepted — a distinct platform from linkedin, now wired to its own reconnect route', async () => {
    mockDynamoDB.put.mockReturnValue(ok());
    const decision = await service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', subjectLabel: 'Test Customer · LinkedIn Ads urn:li:sponsoredAccount:111', businessImpact: 'x', evidencePacket: {},
      customerActionUrl: 'https://x', credentialPlatform: 'linkedin_ads', credentialAccountId: 'urn:li:sponsoredAccount:111', manifestId: 'manifest-test-3', expiresAt: FUTURE,
    } as any);
    expect(decision.credentialPlatform).toBe('linkedin_ads');
  });

  it('review fix: a credentialAccountId that normalizes to empty (e.g. literally "act_") is rejected', async () => {
    await expect(service.createDecision({
      gateType: 'customer_credential', customerId: 'cust-1', businessImpact: 'x', evidencePacket: {},
      customerActionUrl: 'https://x', credentialPlatform: 'meta', credentialAccountId: 'act_', expiresAt: FUTURE,
    } as any)).rejects.toThrow(ApprovalInboxError);
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

  describe('skipExpiryCheck (review fix — real reconnects are ground truth, not a stale UI click)', () => {
    it('claims successfully even past expiresAt when skipExpiryCheck is set, and drops the expiresAt clause from the condition', async () => {
      mockDynamoDB.update.mockReturnValue(ok({ Attributes: { decisionId: 'd1', status: 'approved' } }));

      const result = await service.claimDecision('d1', 'approve', 'system:auto-reconnect', undefined, { skipExpiryCheck: true });

      expect(result.claimed).toBe(true);
      const params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.ConditionExpression).toContain('#status = :pendingTeam');
      expect(params.ConditionExpression).not.toContain('expiresAt');
    });

    it('still refuses an already-resolved decision even with skipExpiryCheck — status is still checked', async () => {
      mockDynamoDB.update.mockReturnValue(conditionalFail());
      mockDynamoDB.get.mockReturnValue(ok({ Item: { decisionId: 'd1', status: 'approved', expiresAt: PAST } }));

      const result = await service.claimDecision('d1', 'approve', 'system:auto-reconnect', undefined, { skipExpiryCheck: true });

      expect(result.claimed).toBe(false);
      if (result.claimed) throw new Error('unreachable');
      // Never 'expired' when skipExpiryCheck is set — expiry is not what
      // failed this claim, the status condition is.
      expect(result.reason).toBe('already_resolved');
    });

    it('without skipExpiryCheck, the default (Slack human-click) path is completely unchanged — still rejects a real expiry', async () => {
      mockDynamoDB.update.mockReturnValue(conditionalFail());
      mockDynamoDB.get.mockReturnValue(ok({ Item: { decisionId: 'd1', status: 'pending_team_review', expiresAt: PAST } }));

      const result = await service.claimDecision('d1', 'approve', 'slack:U123');

      expect(result.claimed).toBe(false);
      if (result.claimed) throw new Error('unreachable');
      expect(result.reason).toBe('expired');
    });
  });
});

describe('approvalInboxService.expireDecision', () => {
  it('atomically flips a genuinely-due pending decision to expired — no pre-read, one conditional update', async () => {
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: { decisionId: 'd1', status: 'expired' } }));

    const result = await service.expireDecision('d1');
    expect(result.expired).toBe(true);
    expect(mockDynamoDB.get).not.toHaveBeenCalled();
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toContain('#status = :pendingTeam');
    expect(params.ConditionExpression).toContain('expiresAt <= :now');
    expect(params.ExpressionAttributeValues[':expired']).toBe('expired');
  });

  it('loses cleanly (expired:false, no throw) to a claim that landed first — the real race this exists to handle', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());

    const result = await service.expireDecision('d1');
    expect(result.expired).toBe(false);
    // Unlike claimDecision, there's no follow-up read here — a lost race just
    // means "nothing to do," no specific reason needs reporting to a caller.
    expect(mockDynamoDB.get).not.toHaveBeenCalled();
  });

  it('loses cleanly to a previous sweep tick that already expired the same decision', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    const result = await service.expireDecision('already-expired-d1');
    expect(result.expired).toBe(false);
  });
});

describe('approvalInboxService.listDuePending', () => {
  it('queries StatusExpiryIndex for the given status with expiresAt <= now', async () => {
    mockDynamoDB.query.mockReturnValue(ok({ Items: [{ decisionId: 'd1', status: 'pending_team_review' }] }));

    const result = await service.listDuePending('pending_team_review');
    expect(result).toHaveLength(1);
    const params = mockDynamoDB.query.mock.calls[0][0];
    expect(params.IndexName).toBe('StatusExpiryIndex');
    expect(params.ExpressionAttributeValues[':status']).toBe('pending_team_review');
    expect(params.KeyConditionExpression).toContain('expiresAt <= :now');
  });

  it('returns an empty array when nothing is due, not undefined/throw', async () => {
    mockDynamoDB.query.mockReturnValue(ok({}));
    const result = await service.listDuePending('pending_customer_response');
    expect(result).toEqual([]);
  });
});

describe('approvalInboxService.listPendingForApprover / listPendingForCustomer (review fix: Limit-before-filter pagination)', () => {
  it('listPendingForApprover finds a real pending match that sorts past the first page of (mostly non-pending) history', async () => {
    // Page 1: DynamoDB scanned a full page of this approver's history, none
    // of which matched the status FilterExpression (real DynamoDB applies
    // FilterExpression server-side — Items here already reflects that, empty
    // — while Limit only bounded how many were SCANNED, hence LastEvaluatedKey
    // still pointing past them). Before the fix, a single query with a plain
    // Limit would have silently returned nothing.
    mockDynamoDB.query
      .mockReturnValueOnce(ok({
        Items: [],
        LastEvaluatedKey: { decisionId: 'old-2' },
      }))
      .mockReturnValueOnce(ok({
        Items: [{ decisionId: 'new-1', status: 'pending_team_review' }],
      }));

    const result = await service.listPendingForApprover('matt');
    expect(result).toHaveLength(1);
    expect(result[0].decisionId).toBe('new-1');
    expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
    // Second call resumes from the first page's LastEvaluatedKey.
    expect(mockDynamoDB.query.mock.calls[1][0].ExclusiveStartKey).toEqual({ decisionId: 'old-2' });
  });

  it('listAwaitingDispatchForApprover filters gate type and verdict server-side, so other approved rows cannot fill the page', async () => {
    mockDynamoDB.query.mockReturnValueOnce(ok({
      Items: [{ decisionId: 'a', gateType: 'meta_write', verdict: 'approve', status: 'dispatching' }],
    }));
    const result = await service.listAwaitingDispatchForApprover('matt');
    expect(result.map((d: any) => d.decisionId)).toEqual(['a']);
    const params = mockDynamoDB.query.mock.calls[0][0];
    expect(params.FilterExpression).toBe('#status IN (:s0, :s1) AND #gateType = :metaWrite AND #verdict = :approve');
    expect(params.ExpressionAttributeValues).toMatchObject({ ':keyValue': 'matt', ':s0': 'approved', ':s1': 'dispatching', ':metaWrite': 'meta_write', ':approve': 'approve' });
    expect(params.ExpressionAttributeNames).toMatchObject({ '#status': 'status', '#gateType': 'gateType', '#verdict': 'verdict' });
  });

  it('listAwaitingDispatchForApprover keeps paging past pages whose rows the server-side filter removed', async () => {
    mockDynamoDB.query
      .mockReturnValueOnce(ok({ Items: [], LastEvaluatedKey: { decisionId: 'old-1' } }))
      .mockReturnValueOnce(ok({ Items: [{ decisionId: 'new-1', gateType: 'meta_write', verdict: 'approve', status: 'dispatching' }] }));
    const result = await service.listAwaitingDispatchForApprover('matt');
    expect(result.map((d: any) => d.decisionId)).toEqual(['new-1']);
    expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
  });

  it('listPendingForCustomer finds a real pending match that sorts past the first page of history', async () => {
    mockDynamoDB.query
      .mockReturnValueOnce(ok({
        Items: [],
        LastEvaluatedKey: { decisionId: 'old-1' },
      }))
      .mockReturnValueOnce(ok({
        Items: [{ decisionId: 'new-1', status: 'pending_customer_response' }],
      }));

    const result = await service.listPendingForCustomer('cust-1');
    expect(result).toHaveLength(1);
    expect(result[0].decisionId).toBe('new-1');
  });

  it('stops paging once it has accumulated `limit` real matches, without over-fetching', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [{ decisionId: 'm1', status: 'pending_team_review' }, { decisionId: 'm2', status: 'pending_team_review' }],
      LastEvaluatedKey: { decisionId: 'm2' },
    }));

    const result = await service.listPendingForApprover('matt', 2);
    expect(result).toHaveLength(2);
    expect(mockDynamoDB.query).toHaveBeenCalledTimes(1);
  });

  it('is capped at a bounded number of pages when nothing ever matches, instead of paging forever', async () => {
    // Every page scans history but the status filter matches nothing —
    // Items reflects that (empty), LastEvaluatedKey keeps pointing further.
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [],
      LastEvaluatedKey: { decisionId: 'old' },
    }));

    const result = await service.listPendingForApprover('matt');
    expect(result).toEqual([]);
    // Bounded, not unbounded — proves the safety cap actually stops the loop.
    expect(mockDynamoDB.query.mock.calls.length).toBeLessThan(1000);
    expect(mockDynamoDB.query.mock.calls.length).toBeGreaterThan(1);
  });

  it('review fix: each page still carries a real Limit — pagination fixed the correctness bug without leaving every round trip unbounded', async () => {
    mockDynamoDB.query.mockReturnValue(ok({ Items: [{ decisionId: 'm1', status: 'pending_team_review' }] }));

    await service.listPendingForApprover('matt', 25);

    const params = mockDynamoDB.query.mock.calls[0][0];
    expect(params.Limit).toBe(25);
  });
});

describe('approvalInboxService.findPendingCredentialDecisions', () => {
  it('finds the matching pending customer_credential decision by platform + accountId', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [
        { decisionId: 'd1', gateType: 'customer_credential', credentialPlatform: 'linkedin', credentialAccountId: 'urn:li:person:other' },
        { decisionId: 'd2', gateType: 'customer_credential', credentialPlatform: 'meta', credentialAccountId: 'act_123' },
      ],
    }));

    const result = await service.findPendingCredentialDecisions('cust-1', 'meta', 'act_123');
    expect(result).toHaveLength(1);
    expect(result[0].decisionId).toBe('d2');
  });

  // ENG-1644 follow-up: real bug found live on prod — .find() only ever
  // returned the oldest match, so a reconnect left every OTHER pending
  // duplicate stuck until it silently expired.
  it('returns EVERY matching pending decision, not just the first, when duplicates exist for the same account (real bug found live on prod)', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [
        { decisionId: 'older', gateType: 'customer_credential', credentialPlatform: 'meta', credentialAccountId: 'act_123', createdAt: '2026-09-25T13:29:00.000Z' },
        { decisionId: 'newer', gateType: 'customer_credential', credentialPlatform: 'meta', credentialAccountId: 'act_123', createdAt: '2026-09-25T17:55:00.000Z' },
        { decisionId: 'unrelated', gateType: 'customer_credential', credentialPlatform: 'meta', credentialAccountId: 'act_999' },
      ],
    }));

    const result = await service.findPendingCredentialDecisions('cust-1', 'meta', 'act_123');
    expect(result.map((d) => d.decisionId).sort()).toEqual(['newer', 'older']);
  });

  it('matches regardless of a leading "act_" prefix on either side (review fix — Meta surfaces the id both ways)', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [{ decisionId: 'd1', gateType: 'customer_credential', credentialPlatform: 'meta', credentialAccountId: 'act_555' }],
    }));

    // Decision was stored WITH the prefix; a real reconnect passes the bare id.
    const result = await service.findPendingCredentialDecisions('cust-1', 'meta', '555');
    expect(result).toHaveLength(1);
    expect(result[0].decisionId).toBe('d1');
  });

  it('returns an empty array when no pending decision matches the platform+accountId', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [{ decisionId: 'd1', gateType: 'customer_credential', credentialPlatform: 'meta', credentialAccountId: 'act_999' }],
    }));

    const result = await service.findPendingCredentialDecisions('cust-1', 'meta', 'act_123');
    expect(result).toEqual([]);
  });

  it('never matches a non-customer_credential decision even with the same platform/accountId fields', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [{ decisionId: 'd1', gateType: 'plan_choice', credentialPlatform: 'meta', credentialAccountId: 'act_123' }],
    }));

    const result = await service.findPendingCredentialDecisions('cust-1', 'meta', 'act_123');
    expect(result).toEqual([]);
  });

  it('returns an empty array when the customer has no pending decisions at all', async () => {
    mockDynamoDB.query.mockReturnValue(ok({}));
    const result = await service.findPendingCredentialDecisions('cust-1', 'meta', 'act_123');
    expect(result).toEqual([]);
  });

  it('matches case-insensitively and ignores stray whitespace on both sides (review fix)', async () => {
    mockDynamoDB.query.mockReturnValue(ok({
      Items: [{ decisionId: 'd1', gateType: 'customer_credential', credentialPlatform: 'Meta', credentialAccountId: ' act_123 ' }],
    }));

    const result = await service.findPendingCredentialDecisions('cust-1', ' meta ', 'ACT_123');
    expect(result).toHaveLength(1);
    expect(result[0].decisionId).toBe('d1');
  });
});
