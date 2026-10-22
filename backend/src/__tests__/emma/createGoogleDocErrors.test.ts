/**
 * ENG-1539: create_google_doc runtime error cluster — non-live fixture (mocked googleapis + OAuth).
 */
const mockFilesCreate = jest.fn();
const mockPermsCreate = jest.fn();
const mockGetClient = jest.fn();

jest.mock('googleapis', () => ({
  google: { drive: () => ({ files: { create: mockFilesCreate }, permissions: { create: mockPermsCreate } }) },
}));
jest.mock('../../emma/impl/shared/googleDriveAccess', () => ({
  getGoogleDriveOAuthClient: (...a: any[]) => mockGetClient(...a),
}));

import { createGoogleDoc } from '../../emma/impl/googleDocsSheets';

function gaxios(code: any, extra: any = {}) {
  return Object.assign(new Error(extra.message || `status ${code}`), { code, ...extra });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetClient.mockResolvedValue({});
});

describe('createGoogleDoc error classification', () => {
  it('success path returns doc id and url', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'd1', webViewLink: 'https://x/d1' } });
    const r = await createGoogleDoc('T', '# hi', 'u1');
    expect(r).toMatchObject({ success: true, doc_id: 'd1', url: 'https://x/d1' });
  });

  it('401 without folder maps to auth_expired with reconnect hint, not folder advice', async () => {
    mockFilesCreate.mockRejectedValue(gaxios('401'));
    const r = await createGoogleDoc('T', 'b', 'u1');
    expect(r.error_type).toBe('auth_expired');
    expect(r.message).toMatch(/Reconnect Google Drive/);
    expect(r.message).not.toMatch(/folder_id/);
  });

  it('invalid_grant token refresh failure maps to auth_expired', async () => {
    mockFilesCreate.mockRejectedValue(gaxios(400, { message: 'invalid_grant', response: { data: { error: 'invalid_grant' } } }));
    const r = await createGoogleDoc('T', 'b', 'u1');
    expect(r.error_type).toBe('auth_expired');
  });

  it('missing connection maps to auth_expired', async () => {
    mockGetClient.mockRejectedValue(new Error('Google Drive not connected. Connect Google Drive in Settings → Connected Accounts.'));
    const r = await createGoogleDoc('T', 'b', 'u1');
    expect(r.error_type).toBe('auth_expired');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it('403 with folder keeps folder-access advice; without folder does not', async () => {
    mockFilesCreate.mockRejectedValue(gaxios(403));
    expect((await createGoogleDoc('T', 'b', 'u1', 'f1')).message).toMatch(/folder_id/);
    const r = await createGoogleDoc('T', 'b', 'u1');
    expect(r.error_type).toBe('permission');
    expect(r.message).not.toMatch(/folder_id/);
  });

  it('other 4xx is validation; non-HTTP error is internal', async () => {
    mockFilesCreate.mockRejectedValue(gaxios(400, { message: 'Bad media' }));
    expect((await createGoogleDoc('T', 'b', 'u1')).error_type).toBe('validation');
    mockFilesCreate.mockRejectedValue(new TypeError('boom'));
    expect((await createGoogleDoc('T', 'b', 'u1')).error_type).toBe('internal');
  });
});
