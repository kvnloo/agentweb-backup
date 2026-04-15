// @ts-nocheck
/**
 * Tests for dealDb (A2 — CRM Unification v1).
 *
 * Focus: CRUD paths, GSI queries, primary rotation (including Lead.isPrimary
 * mirroring), auth gating, and stage-driven side effects (closedDate).
 */

jest.mock('aws-sdk', () => {
  const mockDocClient = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    scan: jest.fn(),
    delete: jest.fn(),
    batchWrite: jest.fn(),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    config: { update: jest.fn() },
  };
});

// crmDb is used by updateLeadDealMembership — stub it.
jest.mock('../db', () => ({
  crmDb: {
    getLeadById: jest.fn(),
  },
}));

import AWS from 'aws-sdk';
import {
  dealDb,
  DealAuthError,
  DealNotFoundError,
  DEAL_STAGES,
  canWrite,
  generateDealId,
  updateLeadDealMembership,
  Deal,
} from '../dealDb';
import { crmDb } from '../db';

const mockClient: any = new (AWS as any).DynamoDB.DocumentClient();
const ok = (data: unknown) => ({ promise: () => Promise.resolve(data) });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('generateDealId', () => {
  it('produces the expected prefix shape', () => {
    expect(generateDealId()).toMatch(/^deal_\d+_[a-z0-9]+$/);
  });
});

describe('canWrite', () => {
  const base: Deal = {
    dealId: 'd1',
    ownerUserId: 'user-A',
    primaryContactId: 'c1',
    contactIds: ['c1'],
    stage: 'Lead',
    createdAt: 't',
    updatedAt: 't',
  };
  it('allows the owner', () => {
    expect(canWrite(base, 'user-A')).toBe(true);
  });
  it('allows the account owner', () => {
    expect(canWrite({ ...base, accountOwnerUserId: 'user-B' }, 'user-B')).toBe(true);
  });
  it('rejects strangers', () => {
    expect(canWrite(base, 'user-Z')).toBe(false);
  });
});

describe('dealDb.createDeal', () => {
  it('creates a Lead-stage deal with primary auto-added to contactIds', async () => {
    mockClient.put.mockReturnValueOnce(ok({}));
    const deal = await dealDb.createDeal({
      ownerUserId: 'u1',
      primaryContactId: 'c1',
    });
    expect(deal.stage).toBe('Lead');
    expect(deal.contactIds).toEqual(['c1']);
    expect(deal.ownerUserId).toBe('u1');
    expect(deal.dealId).toMatch(/^deal_/);
    const putCall = mockClient.put.mock.calls[0][0];
    expect(putCall.TableName).toMatch(/AW-Deals$/);
    expect(putCall.ConditionExpression).toContain('attribute_not_exists');
  });

  it('auto-sets closedDate when stage=Won at creation', async () => {
    mockClient.put.mockReturnValueOnce(ok({}));
    const deal = await dealDb.createDeal({
      ownerUserId: 'u1',
      primaryContactId: 'c1',
      stage: 'Won',
    });
    expect(deal.closedDate).toBeDefined();
  });

  it('normalises companyDomain to lowercase', async () => {
    mockClient.put.mockReturnValueOnce(ok({}));
    const deal = await dealDb.createDeal({
      ownerUserId: 'u1',
      primaryContactId: 'c1',
      companyDomain: 'ACME.COM',
    });
    expect(deal.companyDomain).toBe('acme.com');
  });

  it('ensures primaryContactId is always in contactIds', async () => {
    mockClient.put.mockReturnValueOnce(ok({}));
    const deal = await dealDb.createDeal({
      ownerUserId: 'u1',
      primaryContactId: 'c-primary',
      contactIds: ['c-other-1', 'c-other-2'],
    });
    expect(deal.contactIds).toContain('c-primary');
  });

  it('rejects invalid stages', async () => {
    await expect(
      dealDb.createDeal({ ownerUserId: 'u1', primaryContactId: 'c1', stage: 'Nope' as any })
    ).rejects.toThrow('Invalid deal stage');
  });

  it('rejects out-of-range heatScore', async () => {
    await expect(
      dealDb.createDeal({ ownerUserId: 'u1', primaryContactId: 'c1', heatScore: 150 })
    ).rejects.toThrow('heatScore');
  });
});

describe('dealDb.updateDeal', () => {
  const existing: Deal = {
    dealId: 'd1',
    ownerUserId: 'u1',
    primaryContactId: 'c1',
    contactIds: ['c1', 'c2'],
    stage: 'Lead',
    createdAt: 't',
    updatedAt: 't',
  };

  it('rejects writes from non-owners', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    await expect(dealDb.updateDeal('d1', 'stranger', { stage: 'Qualified' })).rejects.toBeInstanceOf(
      DealAuthError
    );
  });

  it('404s when the deal is missing', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: null }));
    await expect(dealDb.updateDeal('d1', 'u1', { stage: 'Qualified' })).rejects.toBeInstanceOf(
      DealNotFoundError
    );
  });

  it('auto-sets closedDate when stage transitions to Won', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    mockClient.update.mockReturnValueOnce(ok({ Attributes: { ...existing, stage: 'Won' } }));
    await dealDb.updateDeal('d1', 'u1', { stage: 'Won' });
    const updateCall = mockClient.update.mock.calls[0][0];
    expect(updateCall.UpdateExpression).toContain('closedDate = :closedDate');
  });

  it('rejects promoting a primary not present in contactIds', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    await expect(
      dealDb.updateDeal('d1', 'u1', { primaryContactId: 'c-unknown' })
    ).rejects.toThrow('primaryContactId must be a member');
  });

  it('rejects empty contactIds', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    await expect(dealDb.updateDeal('d1', 'u1', { contactIds: [] })).rejects.toThrow(
      'contactIds cannot be empty'
    );
  });
});

describe('dealDb.deleteDeal', () => {
  const existing: Deal = {
    dealId: 'd1',
    ownerUserId: 'u1',
    primaryContactId: 'c1',
    contactIds: ['c1'],
    stage: 'Lead',
    createdAt: 't',
    updatedAt: 't',
  };

  it('deletes when owner matches', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    mockClient.delete.mockReturnValueOnce(ok({}));
    await dealDb.deleteDeal('d1', 'u1');
    expect(mockClient.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects strangers', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    await expect(dealDb.deleteDeal('d1', 'stranger')).rejects.toBeInstanceOf(DealAuthError);
    expect(mockClient.delete).not.toHaveBeenCalled();
  });
});

describe('dealDb.getDealsByOwner', () => {
  it('queries the owner-heatScore GSI', async () => {
    mockClient.query.mockReturnValueOnce(ok({ Items: [] }));
    await dealDb.getDealsByOwner('u1');
    const q = mockClient.query.mock.calls[0][0];
    expect(q.IndexName).toBe('ownerUserId-heatScore-index');
    expect(q.KeyConditionExpression).toContain('ownerUserId = :uid');
    expect(q.ScanIndexForward).toBe(false);
  });
});

describe('dealDb.getDealsByDomain', () => {
  it('queries the companyDomain-stage GSI and lowercases domain', async () => {
    mockClient.query.mockReturnValueOnce(ok({ Items: [] }));
    await dealDb.getDealsByDomain('ACME.com', { stage: 'Qualified' });
    const q = mockClient.query.mock.calls[0][0];
    expect(q.IndexName).toBe('companyDomain-stage-index');
    expect(q.ExpressionAttributeValues[':domain']).toBe('acme.com');
    expect(q.ExpressionAttributeValues[':stage']).toBe('Qualified');
    expect(q.ExpressionAttributeNames['#s']).toBe('stage');
  });
});

describe('dealDb.rotatePrimary', () => {
  const existing: Deal = {
    dealId: 'd1',
    ownerUserId: 'u1',
    primaryContactId: 'c1',
    contactIds: ['c1', 'c2'],
    stage: 'Lead',
    createdAt: 't',
    updatedAt: 't',
  };

  it('is a no-op when the new primary is already primary', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    const result = await dealDb.rotatePrimary('d1', 'u1', 'c1');
    expect(result).toBe(existing);
    expect(mockClient.update).not.toHaveBeenCalled();
  });

  it('auth-gates to owner only', async () => {
    mockClient.get.mockReturnValueOnce(ok({ Item: existing }));
    await expect(dealDb.rotatePrimary('d1', 'stranger', 'c2')).rejects.toBeInstanceOf(
      DealAuthError
    );
  });

  it('promotes a member contact to primary without duplicating contactIds', async () => {
    mockClient.get
      .mockReturnValueOnce(ok({ Item: existing })) // outer
      .mockReturnValueOnce(ok({ Item: existing })); // updateDeal re-fetch
    mockClient.update.mockReturnValueOnce(
      ok({ Attributes: { ...existing, primaryContactId: 'c2' } })
    );

    const result = await dealDb.rotatePrimary('d1', 'u1', 'c2');
    expect(result.primaryContactId).toBe('c2');
    const updateCall = mockClient.update.mock.calls[0][0];
    expect(updateCall.ExpressionAttributeValues[':contactIds']).toEqual(['c1', 'c2']);
  });

  it('flips Lead.isPrimary on both sides when contact refs are provided', async () => {
    mockClient.get
      .mockReturnValueOnce(ok({ Item: existing }))
      .mockReturnValueOnce(ok({ Item: existing }));
    mockClient.update
      .mockReturnValueOnce(ok({ Attributes: { ...existing, primaryContactId: 'c2' } })) // deal update
      .mockReturnValueOnce(ok({})) // old primary lead
      .mockReturnValueOnce(ok({})); // new primary lead

    (crmDb.getLeadById as jest.Mock)
      .mockResolvedValueOnce({ listId: 'L1', leadId: 'c1', dealIds: ['d1'], isPrimary: true })
      .mockResolvedValueOnce({ listId: 'L1', leadId: 'c2', dealIds: [] });

    await dealDb.rotatePrimary('d1', 'u1', 'c2', {
      oldPrimary: { listId: 'L1', leadId: 'c1' },
      newPrimary: { listId: 'L1', leadId: 'c2' },
    });

    // 1 deal update + 2 lead updates = 3
    expect(mockClient.update).toHaveBeenCalledTimes(3);
  });
});

describe('dealDb.promoteContactsToDeal', () => {
  it('creates the deal and mirrors dealId onto each lead', async () => {
    mockClient.put.mockReturnValueOnce(ok({})); // createDeal
    mockClient.update.mockReturnValue(ok({})); // lead mirrors (both)
    (crmDb.getLeadById as jest.Mock)
      .mockResolvedValueOnce({ listId: 'L1', leadId: 'c1', dealIds: [] })
      .mockResolvedValueOnce({ listId: 'L1', leadId: 'c2', dealIds: [] });

    const deal = await dealDb.promoteContactsToDeal(
      [
        { listId: 'L1', leadId: 'c1' },
        { listId: 'L1', leadId: 'c2' },
      ],
      { ownerUserId: 'u1' }
    );

    expect(deal.primaryContactId).toBe('c1');
    expect(deal.contactIds).toEqual(['c1', 'c2']);
    // 2 lead mirrors
    expect(mockClient.update).toHaveBeenCalledTimes(2);
  });

  it('rejects empty contact refs', async () => {
    await expect(
      dealDb.promoteContactsToDeal([], { ownerUserId: 'u1' })
    ).rejects.toThrow('contactRefs required');
  });

  it('tolerates per-lead mirror failures (best-effort)', async () => {
    mockClient.put.mockReturnValueOnce(ok({}));
    (crmDb.getLeadById as jest.Mock).mockRejectedValue(new Error('transient DynamoDB error'));

    const deal = await dealDb.promoteContactsToDeal(
      [{ listId: 'L1', leadId: 'c1' }],
      { ownerUserId: 'u1' }
    );
    expect(deal).toBeDefined();
    expect(deal.dealId).toMatch(/^deal_/);
  });
});

describe('updateLeadDealMembership', () => {
  it('appends a dealId without duplicating', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValueOnce({
      listId: 'L1',
      leadId: 'c1',
      dealIds: ['d1'],
    });
    mockClient.update.mockReturnValueOnce(ok({}));

    await updateLeadDealMembership({ listId: 'L1', leadId: 'c1' }, { addDealId: 'd2' });
    const call = mockClient.update.mock.calls[0][0];
    expect(call.ExpressionAttributeValues[':crmDealIds']).toEqual(['d1', 'd2']);
  });

  it('is a no-op when the dealId already exists and isPrimary not set', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValueOnce({
      listId: 'L1',
      leadId: 'c1',
      dealIds: ['d1'],
    });

    await updateLeadDealMembership({ listId: 'L1', leadId: 'c1' }, { addDealId: 'd1' });
    expect(mockClient.update).not.toHaveBeenCalled();
  });

  it('throws when the lead is missing', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValueOnce(null);
    await expect(
      updateLeadDealMembership({ listId: 'L1', leadId: 'missing' }, { addDealId: 'd1' })
    ).rejects.toThrow('Lead not found');
  });
});

describe('DEAL_STAGES', () => {
  it('is the exact set from the A2 spec', () => {
    expect(DEAL_STAGES).toEqual([
      'Lead',
      'Qualified',
      'Demo',
      'Proposal',
      'Negotiation',
      'Won',
      'Lost',
    ]);
  });
});
