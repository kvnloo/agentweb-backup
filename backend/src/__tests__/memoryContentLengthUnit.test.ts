/**
 * ENG-821 — the memory length guard must count the same unit the tool schema
 * declares, and it must keep doing so.
 *
 * `save_memory` advertises `maxLength: 2000`. In JSON Schema that is 2,000
 * Unicode characters. The persistence guard used to count UTF-16 code units, so
 * 1,001 emoji — 1,001 characters — passed the advertised contract and then threw
 * at execution. This drives the REAL guard, not a restatement of it, so the two
 * sides cannot drift apart again silently.
 */

const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Attributes: {} }) });
const mockGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Item: undefined }) });
const mockQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

jest.mock('aws-sdk', () => {
  const DocumentClient = jest.fn().mockImplementation(() => ({
    put: (...a: unknown[]) => (global as any).__put(...a),
    update: (...a: unknown[]) => (global as any).__update(...a),
    get: (...a: unknown[]) => (global as any).__get(...a),
    query: (...a: unknown[]) => (global as any).__query(...a),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  }));
  const SecretsManager = jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ SecretString: '{"apiKey":"test"}' }),
    }),
  }));
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient }, SecretsManager, S3: jest.fn(), config: { update: jest.fn() } },
    DynamoDB: { DocumentClient },
    SecretsManager,
    S3: jest.fn(),
    config: { update: jest.fn() },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).__put = mockPut;
  (global as any).__update = mockUpdate;
  (global as any).__get = mockGet;
  (global as any).__query = mockQuery;
});

const LENGTH_ERROR = /2000 characters or less/;

describe('ENG-821 — memory content length is measured in the declared unit', () => {
  it('accepts 1,001 astral characters — inside the declared 2,000-character limit', async () => {
    const { accountMemoryDb } = require('../services/db');
    const content = '😀'.repeat(1001); // 1,001 chars, 2,002 UTF-16 code units

    // Must not be rejected for length. Any other failure would be a different
    // bug, so the assertion is specifically about the length error.
    await expect(
      accountMemoryDb.addMemory('user-1', 'insight', content, 'session-1'),
    ).resolves.not.toThrow?.();
    expect(mockPut).toHaveBeenCalled();
  });

  it('still rejects 2,001 characters', async () => {
    const { accountMemoryDb } = require('../services/db');
    await expect(
      accountMemoryDb.addMemory('user-1', 'insight', 'a'.repeat(2001), 'session-1'),
    ).rejects.toThrow(LENGTH_ERROR);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects 2,001 astral characters too — the limit is characters, not bytes', async () => {
    const { accountMemoryDb } = require('../services/db');
    await expect(
      accountMemoryDb.addMemory('user-1', 'insight', '😀'.repeat(2001), 'session-1'),
    ).rejects.toThrow(LENGTH_ERROR);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('applies the same unit on the org memory path', async () => {
    // Same declared contract, same wording in the error — it would be its own
    // small lie if one path counted differently.
    const { orgMemoryDb } = require('../services/db');
    await expect(
      orgMemoryDb.addMemory('org-1', 'insight', '😀'.repeat(1001), 'user-1'),
    ).resolves.not.toThrow?.();
    expect(mockPut).toHaveBeenCalled();
  });

  it('applies the same unit on the update path', async () => {
    const { accountMemoryDb } = require('../services/db');
    await expect(
      accountMemoryDb.updateMemory('user-1', 'mem-1', { content: '😀'.repeat(2001) }),
    ).rejects.toThrow(LENGTH_ERROR);
  });
});
