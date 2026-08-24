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

import * as fs from 'fs';
import * as path from 'path';

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
// Reads partner-portal's actual AVAILABLE_CONNECTED_ACCOUNTS ids straight out
// of its source file — not a hand-copied literal — so the parity test below
// validates against the real, current frontend list on every run instead of
// a second hardcoded copy that could itself silently drift (Greptile finding
// on this PR: the original version of this test compared against a manually
// duplicated array, which defeats the point of a drift-detection test).
// ---------------------------------------------------------------------------
function readFrontendAvailableConnectedAccountIds(): string[] {
  const frontendPath = path.join(
    __dirname,
    '../../../../partner-portal/src/components/admin/SubscriptionTypesTab.tsx',
  );
  const source = fs.readFileSync(frontendPath, 'utf8');
  const blockMatch = source.match(/const AVAILABLE_CONNECTED_ACCOUNTS = \[([\s\S]*?)\n\];/);
  if (!blockMatch) {
    throw new Error(
      `Could not locate the AVAILABLE_CONNECTED_ACCOUNTS array in ${frontendPath} — its declaration shape ` +
      `changed and this test needs updating alongside it, rather than silently comparing against nothing.`,
    );
  }
  const ids = [...blockMatch[1].matchAll(/id:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  if (ids.length === 0) {
    throw new Error(`Matched the AVAILABLE_CONNECTED_ACCOUNTS block but extracted zero ids from ${frontendPath}.`);
  }
  return ids;
}

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

  it('matches partner-portal\'s actual AVAILABLE_CONNECTED_ACCOUNTS ids, read live from its source file, so the "select all -> save" path can never silently drop a platform again', () => {
    // The frontend collapses a full selection to '*' before saving
    // (SubscriptionTypesTab.tsx's handleSave), and the backend expands '*'
    // via getAllAvailableConnectedAccounts() — so this comparison has to be
    // against the REAL frontend list, not a copy of it, or a future drift
    // between the two would go undetected by this exact test again.
    const frontendIds = readFrontendAvailableConnectedAccountIds();
    const result = getAllAvailableConnectedAccounts();
    expect(new Set(result)).toEqual(new Set(frontendIds));
  });

  // ── Boundary / invalid-data-shape coverage ──────────────────────────────
  // getAllAvailableConnectedAccounts() takes no arguments and has no I/O, so
  // there's no "invalid input" or "error path" in the usual sense — but the
  // shape of what it returns still has real invariants worth locking down,
  // since this exact list is round-tripped through '*' expansion on every
  // subscription-type save and silently determines what a customer can see.

  it('contains no duplicate platform ids', () => {
    const result = getAllAvailableConnectedAccounts();
    expect(new Set(result).size).toBe(result.length);
  });

  it('contains no empty, whitespace-only, or non-string entries', () => {
    const result = getAllAvailableConnectedAccounts();
    for (const platform of result) {
      expect(typeof platform).toBe('string');
      expect(platform.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns a fresh array on every call, not a shared mutable reference', () => {
    // If this were ever refactored to `return SOME_CONST_ARRAY` instead of a
    // fresh literal, a caller mutating its result (e.g. `.push()`) would
    // corrupt every subsequent call's return value — a real bug class for a
    // list this many call sites treat as read-only.
    const first = getAllAvailableConnectedAccounts();
    first.push('mutated-should-not-leak');
    const second = getAllAvailableConnectedAccounts();
    expect(second).not.toContain('mutated-should-not-leak');
    expect(second).toHaveLength(14);
  });
});
