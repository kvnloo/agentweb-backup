/**
 * Tests for getAllAvailableConnectedAccounts() in subscriptionService.ts.
 *
 * This test suite covers the calendly entry, which was missing from this list
 * despite being present in partner-portal's AVAILABLE_CONNECTED_ACCOUNTS
 * (SubscriptionTypesTab.tsx). That drift is a real production bug: when an
 * admin selects every connected-account checkbox in the Subscription Types
 * editor (a natural "select all" action, or simply checking the last box),
 * the frontend compresses the full selection down to the wildcard '*' before
 * saving (see SubscriptionTypesTab.tsx's handleSave). The backend's POST
 * /subscription-types handler then expands '*' back out using THIS list —
 * so any platform missing here is silently dropped from what's persisted,
 * even though the admin explicitly selected it. calendly checked, saved,
 * and reverted to unchecked on refresh in production is exactly this bug.
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
  it('includes calendly', () => {
    const result = getAllAvailableConnectedAccounts();
    expect(result).toContain('calendly');
  });

  it('includes all other expected platforms alongside calendly', () => {
    const result = getAllAvailableConnectedAccounts();
    const expectedPlatforms = [
      'linkedin',
      'unipile',
      'meta',
      'gmail',
      'outlook',
      'calendly',
      'youtube',
      'fathom',
      'instagram',
      'twitter',
      'hubspot',
      'attio',
      'google_ads',
      'google_drive',
    ];
    for (const platform of expectedPlatforms) {
      expect(result).toContain(platform);
    }
  });

  it('returns exactly 14 items now that calendly is included', () => {
    const result = getAllAvailableConnectedAccounts();
    expect(result).toHaveLength(14);
  });

  it('matches partner-portal\'s AVAILABLE_CONNECTED_ACCOUNTS ids exactly, so the "select all -> save" path never silently drops a platform', () => {
    // Mirrors SubscriptionTypesTab.tsx's AVAILABLE_CONNECTED_ACCOUNTS ids. If either
    // list changes, keep them in sync — the frontend collapses a full selection to
    // '*' before saving, and the backend expands '*' via THIS list, so any drift
    // here silently strips whatever platform is missing on save.
    const frontendIds = [
      'linkedin',
      'unipile',
      'meta',
      'instagram',
      'twitter',
      'gmail',
      'outlook',
      'calendly',
      'youtube',
      'fathom',
      'hubspot',
      'attio',
      'google_ads',
      'google_drive',
    ];
    const result = getAllAvailableConnectedAccounts();
    expect(new Set(result)).toEqual(new Set(frontendIds));
  });
});
