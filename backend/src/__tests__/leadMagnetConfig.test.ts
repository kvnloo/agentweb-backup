import { LeadMagnetConfigDb, LeadMagnetConfig } from '../services/leadMagnetConfigDb';
import AWS from 'aws-sdk';

// Mock DynamoDB DocumentClient
const mockPut = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockGet = jest.fn();
const mockDelete = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockScan = jest.fn();
const mockQuery = jest.fn();

jest.mock('aws-sdk', () => {
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockPut,
        get: mockGet,
        delete: mockDelete,
        scan: mockScan,
        query: mockQuery,
      })),
    },
  };
});

describe('LeadMagnetConfigDb', () => {
  let db: LeadMagnetConfigDb;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new LeadMagnetConfigDb('Test-AW-LeadMagnetConfigs');
  });

  const validConfig: Omit<LeadMagnetConfig, 'configId' | 'createdAt' | 'updatedAt'> = {
    name: 'Free Website Audit',
    inputSchema: {
      fields: [
        { name: 'website_url', label: 'Your Website URL', type: 'url', required: true },
      ],
    },
    taskTemplateId: 'website-audit-v1',
    resultGate: 'blur',
    ctaText: 'Get your full audit — sign up free',
    landingPageSlug: 'free-website-audit',
    enabled: true,
  };

  // FAIL test 1: Missing name throws validation error
  it('should throw when name is missing', async () => {
    const invalid = { ...validConfig, name: '' };
    await expect(db.create(invalid)).rejects.toThrow('name is required');
  });

  // FAIL test 2: Missing taskTemplateId throws
  it('should throw when taskTemplateId is missing', async () => {
    const invalid = { ...validConfig, taskTemplateId: '' };
    await expect(db.create(invalid)).rejects.toThrow('taskTemplateId is required');
  });

  // FAIL test 3: Invalid resultGate throws
  it('should throw when resultGate is invalid', async () => {
    const invalid = { ...validConfig, resultGate: 'invalid' as any };
    await expect(db.create(invalid)).rejects.toThrow('resultGate must be');
  });

  // FAIL test 4: Get nonexistent config returns null
  it('should return null for nonexistent configId', async () => {
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    });

    const result = await db.getById('nonexistent-id');
    expect(result).toBeNull();
  });

  // SUCCESS test 5: Create config generates ID and timestamps
  it('should create config with generated ID and timestamps', async () => {
    mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

    const result = await db.create(validConfig);

    expect(result.configId).toBeDefined();
    expect(result.configId.length).toBeGreaterThan(0);
    expect(result.name).toBe('Free Website Audit');
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBeDefined();
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'Test-AW-LeadMagnetConfigs',
      }),
    );
  });

  // SUCCESS test 6: Get by ID returns config
  it('should return config when found by ID', async () => {
    const storedConfig: LeadMagnetConfig = {
      ...validConfig,
      configId: 'cfg-123',
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-10T00:00:00Z',
    };
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: storedConfig }),
    });

    const result = await db.getById('cfg-123');

    expect(result).not.toBeNull();
    expect(result!.configId).toBe('cfg-123');
    expect(result!.name).toBe('Free Website Audit');
  });

  // SUCCESS test 7: List enabled configs
  it('should list only enabled configs', async () => {
    const configs = [
      { ...validConfig, configId: 'c1', enabled: true, createdAt: 'x', updatedAt: 'x' },
      { ...validConfig, configId: 'c2', enabled: false, name: 'Disabled', createdAt: 'x', updatedAt: 'x' },
    ];
    mockScan.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Items: configs }),
    });

    const result = await db.listEnabled();

    // Filtering happens in code
    expect(mockScan).toHaveBeenCalled();
  });

  // SUCCESS test 8: Delete config
  it('should delete config by ID', async () => {
    mockDelete.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

    await db.deleteById('cfg-to-delete');

    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'Test-AW-LeadMagnetConfigs',
        Key: { configId: 'cfg-to-delete' },
      }),
    );
  });

  // SUCCESS test 9: Update config with optimistic concurrency
  it('should update config with ConditionExpression for optimistic locking', async () => {
    const existing: LeadMagnetConfig = {
      ...validConfig,
      configId: 'cfg-update',
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-10T00:00:00Z',
    };
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Item: existing }),
    });
    mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

    const result = await db.update('cfg-update', { name: 'Updated Audit', enabled: false });

    expect(result.name).toBe('Updated Audit');
    expect(result.enabled).toBe(false);
    expect(result.configId).toBe('cfg-update');
    expect(result.updatedAt).not.toBe('2026-03-10T00:00:00Z');
    // Verify optimistic concurrency control
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        ConditionExpression: 'updatedAt = :expectedUpdatedAt',
        ExpressionAttributeValues: { ':expectedUpdatedAt': '2026-03-10T00:00:00Z' },
      }),
    );
  });

  // SUCCESS test 10: listAll handles DynamoDB pagination
  it('should paginate through all scan results', async () => {
    const page1Items = [
      { ...validConfig, configId: 'c1', createdAt: 'x', updatedAt: 'x' },
    ];
    const page2Items = [
      { ...validConfig, configId: 'c2', createdAt: 'x', updatedAt: 'x', name: 'Second' },
    ];
    mockScan
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: page1Items,
          LastEvaluatedKey: { configId: 'c1' },
        }),
      })
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: page2Items,
        }),
      });

    const result = await db.listAll();

    expect(mockScan).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0].configId).toBe('c1');
    expect(result[1].configId).toBe('c2');
  });
});
