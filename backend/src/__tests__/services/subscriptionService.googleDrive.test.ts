/**
 * Tests for getAllAvailableConnectedAccounts() in subscriptionService.ts.
 *
 * This test suite specifically covers the google_drive entry that was added
 * to the list of available connected account platforms.
 */

// ---------------------------------------------------------------------------
// Mock heavy dependencies before any module imports so that the service's
// top-level imports resolve to lightweight stubs and don't blow up on missing
// AWS / DB configuration.
// ---------------------------------------------------------------------------

const mockDynamo = () => ({
  put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
});

const mockS3 = () => ({
  upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  putObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
  headObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  listObjectsV2: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Contents: [] }) }),
});

const awsMock = {
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(mockDynamo) },
  S3: jest.fn(mockS3),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
};

jest.mock('aws-sdk', () => ({ __esModule: true, default: awsMock, ...awsMock }));

// Stub the DB service and secretsManager so the service module can be loaded
// without a real DynamoDB or Secrets Manager connection.
jest.mock('../../services/db', () => ({}));
jest.mock('../../utils/secretsManager', () => ({}));

// ---------------------------------------------------------------------------
// Actual imports — must come after all jest.mock() calls.
// ---------------------------------------------------------------------------
import { getAllAvailableConnectedAccounts } from '../../services/subscriptionService';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getAllAvailableConnectedAccounts', () => {
  it('returns an array', () => {
    const result = getAllAvailableConnectedAccounts();
    expect(Array.isArray(result)).toBe(true);
  });

  it('includes google_drive', () => {
    const result = getAllAvailableConnectedAccounts();
    expect(result).toContain('google_drive');
  });

  it('includes all other expected platforms', () => {
    const result = getAllAvailableConnectedAccounts();
    const expectedPlatforms = [
      'linkedin',
      'unipile',
      'meta',
      'gmail',
      'youtube',
      'fathom',
      'instagram',
      'twitter',
      'hubspot',
      'attio',
      'google_ads',
    ];
    for (const platform of expectedPlatforms) {
      expect(result).toContain(platform);
    }
  });

  it('returns exactly 12 items', () => {
    const result = getAllAvailableConnectedAccounts();
    expect(result).toHaveLength(12);
  });

  it('does not include unexpected platforms', () => {
    const result = getAllAvailableConnectedAccounts();
    const knownPlatforms = new Set([
      'linkedin',
      'unipile',
      'meta',
      'gmail',
      'youtube',
      'fathom',
      'instagram',
      'twitter',
      'hubspot',
      'attio',
      'google_ads',
      'google_drive',
    ]);
    for (const platform of result) {
      expect(knownPlatforms.has(platform)).toBe(true);
    }
  });
});
