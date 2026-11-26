/**
 * The shared-service-account fallback of `readGoogleFileById` writes an audit line (log only) and changes nothing it returns.
 */
const mockOAuth = jest.fn();
const mockServiceAccount = jest.fn();
jest.mock('../emma/impl/shared/googleDriveAccess', () => ({
  getGoogleDriveOAuthClient: (...a: any[]) => mockOAuth(...a),
  getGoogleDriveClient: (...a: any[]) => mockServiceAccount(...a),
  readGoogleDriveFileContent: jest.fn(async () => 'file content'),
  fetchDriveFileComments: jest.fn(async () => ''),
}));
jest.mock('googleapis', () => ({ google: { drive: jest.fn((opts: any) => opts.auth.__drive) } }));

import { readGoogleFileById } from '../emma/impl/googleDrive';
import { hashShared } from '../services/sharedGoogleAudit';

const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const driveReturning = (outcome: 'ok' | 'denied' | 'notfound') => ({
  files: {
    get: jest.fn(async () => {
      if (outcome === 'denied') throw Object.assign(new Error('forbidden'), { code: 403 });
      if (outcome === 'notfound') throw Object.assign(new Error('not found'), { code: 404 });
      return { data: { id: FILE, name: 'Plan', mimeType: 'text/plain', modifiedTime: '2026-11-01T00:00:00Z' } };
    }),
  },
});

let info: jest.SpyInstance;
beforeEach(() => {
  mockOAuth.mockReset();
  mockServiceAccount.mockReset();
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
const audits = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('shared_google_read')).map((l) => JSON.parse(l));

describe('readGoogleFileById: the shared service account is audited', () => {
  it('a read with the caller\'s own Google login writes no audit line', async () => {
    mockOAuth.mockResolvedValue({ __drive: driveReturning('ok') });
    const result = await readGoogleFileById(FILE, 'user-1');
    expect(result.success).toBe(true);
    expect(audits()).toEqual([]);
    expect(mockServiceAccount).not.toHaveBeenCalled();
  });

  it('no Google login: the shared account reads the file, and the line says who, why, and only the hash of the id', async () => {
    mockOAuth.mockRejectedValue(new Error('Google Drive is not connected'));
    mockServiceAccount.mockResolvedValue(driveReturning('ok'));
    const result = await readGoogleFileById(FILE, 'user-1');
    expect(result).toMatchObject({ success: true, file_id: FILE, file_name: 'Plan', content: 'file content' });
    expect(audits()).toEqual([expect.objectContaining({ kind: 'drive-file', userId: 'user-1', idHash: hashShared(FILE), source: 'readGoogleFileById', reason: 'no_oauth', outcome: 'ok' })]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(FILE);
  });

  it('no Google login and the shared account cannot open it either: the failure is audited and the answer is the same as before', async () => {
    mockOAuth.mockRejectedValue(new Error('not connected'));
    mockServiceAccount.mockResolvedValue(driveReturning('notfound'));
    const result = await readGoogleFileById(FILE, 'user-1');
    expect(result.success).toBe(false);
    expect(result.code).toBe(404);
    expect(audits()).toEqual([expect.objectContaining({ reason: 'no_oauth', outcome: 'failed' })]);
  });

  it('the caller\'s own login is refused (403) and the shared account is used instead: audited as oauth_denied', async () => {
    mockOAuth.mockResolvedValue({ __drive: driveReturning('denied') });
    mockServiceAccount.mockResolvedValue(driveReturning('ok'));
    const result = await readGoogleFileById(FILE, 'user-2');
    expect(result.success).toBe(true);
    expect(audits()).toEqual([expect.objectContaining({ userId: 'user-2', reason: 'oauth_denied', outcome: 'ok' })]);
  });

  it('refused by the caller\'s login and by the shared account: audited as failed, answer unchanged', async () => {
    mockOAuth.mockResolvedValue({ __drive: driveReturning('denied') });
    mockServiceAccount.mockResolvedValue(driveReturning('notfound'));
    const result = await readGoogleFileById(FILE, 'user-2');
    expect(result).toMatchObject({ success: false, code: 404 });
    expect(audits()).toEqual([expect.objectContaining({ reason: 'oauth_denied', outcome: 'failed' })]);
  });

  it('an audit that cannot be written never changes the read', async () => {
    mockOAuth.mockRejectedValue(new Error('not connected'));
    mockServiceAccount.mockResolvedValue(driveReturning('ok'));
    info.mockImplementation(() => { throw new Error('log sink down'); });
    await expect(readGoogleFileById(FILE, 'user-1')).resolves.toMatchObject({ success: true });
  });
});
