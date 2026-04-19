/**
 * Unit tests for DripCampaignDb (Lifecycle Drip Phase 3).
 *
 * Follows the LeadMagnetConfigDb mock pattern — stub `aws-sdk` at the module
 * level so no network calls happen and assertions focus on validation, merge
 * field parsing, and the optimistic-concurrency update path.
 */
import {
  DripCampaignDb,
  DripCampaign,
  extractMergeFields,
  validateMergeFields,
  renderTemplate,
  ALLOWED_MERGE_FIELDS,
} from '../services/dripCampaignDb';

// ─── aws-sdk mocks ──────────────────────────────────────────────────────────
const mockPut = jest
  .fn()
  .mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockGet = jest.fn();
const mockDelete = jest
  .fn()
  .mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockScan = jest.fn();

jest.mock('aws-sdk', () => {
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockPut,
        get: mockGet,
        delete: mockDelete,
        scan: mockScan,
      })),
    },
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validCampaign: Omit<DripCampaign, 'campaignId' | 'createdAt' | 'updatedAt'> = {
  name: 'Brand step drop-off',
  segmentQuery: { stage: 'brand_skipped' },
  templateHtml:
    '<p>Hey {{firstName}}, Emma is waiting at {{companyName}}.</p>',
  subjectLine: 'Emma is waiting — 2 min setup',
  cadenceUnit: 'days',
  cadenceValue: 7,
  maxSends: 3,
  isActive: true,
  killSwitch: false,
  createdBy: 'admin-123',
};

// ─── Pure-function tests ────────────────────────────────────────────────────
describe('extractMergeFields', () => {
  it('returns empty array when template has no tokens', () => {
    expect(extractMergeFields('<p>hello</p>')).toEqual([]);
  });

  it('extracts unique field names from a template', () => {
    const html =
      '<p>Hi {{firstName}} at {{companyName}}, goal: {{goal}}. {{firstName}} again.</p>';
    expect(extractMergeFields(html).sort()).toEqual(
      ['firstName', 'companyName', 'goal'].sort(),
    );
  });

  it('handles whitespace inside the braces', () => {
    expect(extractMergeFields('{{  firstName  }}')).toEqual(['firstName']);
  });
});

describe('validateMergeFields', () => {
  it('passes when all fields are allowed', () => {
    expect(() =>
      validateMergeFields('Hi {{firstName}} at {{companyName}}'),
    ).not.toThrow();
  });

  it('throws when an unknown field is used', () => {
    expect(() =>
      validateMergeFields('Hi {{mysteryField}} there'),
    ).toThrow(/Invalid merge fields/);
  });

  it('lists every allowed field for a developer to copy', () => {
    try {
      validateMergeFields('{{unknown}}');
      throw new Error('should have thrown');
    } catch (err: any) {
      for (const allowed of ALLOWED_MERGE_FIELDS) {
        expect(err.message).toContain(allowed);
      }
    }
  });
});

describe('renderTemplate', () => {
  it('substitutes known fields and leaves unknown ones as empty strings', () => {
    const rendered = renderTemplate(
      '{{firstName}} at {{companyName}} ({{missing}})',
      { firstName: 'Harsha', companyName: 'AgentWeb' },
    );
    expect(rendered).toBe('Harsha at AgentWeb ()');
  });

  it('returns the original template unchanged if no tokens present', () => {
    expect(renderTemplate('<p>Hello world</p>', {})).toBe('<p>Hello world</p>');
  });
});

// ─── Db class tests ─────────────────────────────────────────────────────────
describe('DripCampaignDb', () => {
  let db: DripCampaignDb;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new DripCampaignDb('Test-AW-DripCampaigns');
  });

  // ── Validation (FAIL cases) ────────────────────────────────────────────────
  it('throws when name is empty', async () => {
    await expect(db.create({ ...validCampaign, name: '' })).rejects.toThrow(
      'name is required',
    );
  });

  it('throws when templateHtml is missing', async () => {
    await expect(
      db.create({ ...validCampaign, templateHtml: '' }),
    ).rejects.toThrow('templateHtml is required');
  });

  it('throws when cadenceUnit is invalid', async () => {
    await expect(
      db.create({ ...validCampaign, cadenceUnit: 'decades' as any }),
    ).rejects.toThrow(/cadenceUnit must be one of/);
  });

  it('throws when cadenceValue is not a positive integer', async () => {
    await expect(
      db.create({ ...validCampaign, cadenceValue: 0 }),
    ).rejects.toThrow('cadenceValue must be a positive integer');
    await expect(
      db.create({ ...validCampaign, cadenceValue: 1.5 }),
    ).rejects.toThrow('cadenceValue must be a positive integer');
  });

  it('throws when maxSends is out of range', async () => {
    await expect(
      db.create({ ...validCampaign, maxSends: 0 }),
    ).rejects.toThrow('maxSends must be a positive integer');
    await expect(
      db.create({ ...validCampaign, maxSends: 500 }),
    ).rejects.toThrow('maxSends must be 100 or fewer');
  });

  it('throws when templateHtml uses an unknown merge field', async () => {
    await expect(
      db.create({
        ...validCampaign,
        templateHtml: '<p>Hi {{wrongField}}</p>',
      }),
    ).rejects.toThrow(/Invalid merge fields/);
  });

  it('throws when subjectLine is empty', async () => {
    await expect(
      db.create({ ...validCampaign, subjectLine: '' }),
    ).rejects.toThrow('subjectLine is required');
  });

  // ── CRUD happy paths ───────────────────────────────────────────────────────
  it('creates a campaign with generated ID and timestamps', async () => {
    mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

    const result = await db.create(validCampaign);

    expect(result.campaignId).toBeDefined();
    expect(result.campaignId.length).toBeGreaterThan(0);
    expect(result.name).toBe('Brand step drop-off');
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBeDefined();
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'Test-AW-DripCampaigns',
        Item: expect.objectContaining({ name: 'Brand step drop-off' }),
      }),
    );
  });

  it('returns null when getById finds nothing', async () => {
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    });
    const result = await db.getById('nope');
    expect(result).toBeNull();
  });

  it('returns the item when getById finds it', async () => {
    const stored: DripCampaign = {
      ...validCampaign,
      campaignId: 'cmp-1',
      createdAt: '2026-04-19T00:00:00Z',
      updatedAt: '2026-04-19T00:00:00Z',
    };
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: stored }),
    });
    const result = await db.getById('cmp-1');
    expect(result).toEqual(stored);
  });

  it('listAll aggregates across paginated scans', async () => {
    const pageA = [{ ...validCampaign, campaignId: 'a', createdAt: 'x', updatedAt: 'x' }];
    const pageB = [{ ...validCampaign, campaignId: 'b', createdAt: 'x', updatedAt: 'x' }];
    mockScan
      .mockReturnValueOnce({
        promise: jest
          .fn()
          .mockResolvedValue({ Items: pageA, LastEvaluatedKey: { campaignId: 'a' } }),
      })
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: pageB }),
      });

    const all = await db.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.campaignId)).toEqual(['a', 'b']);
  });

  it('listActive filters by isActive=true AND killSwitch=false', async () => {
    mockScan.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });
    await db.listActive();
    expect(mockScan).toHaveBeenCalledWith(
      expect.objectContaining({
        FilterExpression: 'isActive = :active AND killSwitch = :off',
        ExpressionAttributeValues: { ':active': true, ':off': false },
      }),
    );
  });

  it('update merges fields, preserves createdBy / createdAt, and bumps updatedAt', async () => {
    const existing: DripCampaign = {
      ...validCampaign,
      campaignId: 'cmp-42',
      createdAt: '2026-04-10T00:00:00Z',
      updatedAt: '2026-04-10T00:00:00Z',
    };
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: existing }),
    });
    mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

    const updated = await db.update('cmp-42', {
      cadenceValue: 14,
      killSwitch: true,
      // Attempt to tamper with createdBy should be ignored by the type but
      // we cast the whole object to any to prove the runtime override still wins.
      // Per-field `as any` does not suppress TS2353 (excess-property check runs
      // before value-type resolution); whole-object cast does.
      createdBy: 'hijacker',
    } as any);

    expect(updated.cadenceValue).toBe(14);
    expect(updated.killSwitch).toBe(true);
    expect(updated.createdBy).toBe('admin-123');
    expect(updated.createdAt).toBe('2026-04-10T00:00:00Z');
    expect(updated.updatedAt).not.toBe('2026-04-10T00:00:00Z');
    // Optimistic concurrency guard must be present
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        ConditionExpression: 'updatedAt = :expectedUpdatedAt',
      }),
    );
  });

  it('update throws when the campaign does not exist', async () => {
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    });
    await expect(db.update('missing', { maxSends: 5 })).rejects.toThrow(
      'Campaign not found: missing',
    );
  });

  it('deleteById calls DynamoDB delete with the right key', async () => {
    await db.deleteById('cmp-99');
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'Test-AW-DripCampaigns',
        Key: { campaignId: 'cmp-99' },
      }),
    );
  });
});
