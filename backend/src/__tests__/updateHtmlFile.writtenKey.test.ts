/**
 * update_html_file authorises a key with the storage rule and then writes with the server's credentials. The two must be the SAME key: if
 * the upload ever rewrote the name or directory differently from what was checked, the check would be about a different object than the
 * one written. The other suite (updateHtmlFile.storageAccess.test.ts) mocks the upload; this one runs the REAL upload code
 * (utils/s3Utils.ts uploadFileToS3WithPath, with its real file-name rewriting and directory clean-up) against a fake S3 client and compares
 * the Key S3 actually receives with the key the rule was asked about.
 */
import AWS from 'aws-sdk';
import * as htmlUpdateImpl from '../emma/impl/htmlUpdate';
import { fetchCallerUrlText } from '../utils/callerUrlFetch';
import { decideStorageAccess } from '../services/storageAccessPolicy';

// A fake S3 client that records the upload; the DynamoDB client the policy's module graph builds is inert.
jest.mock('aws-sdk', () => {
  const upload = jest.fn(() => ({ promise: () => Promise.resolve({ Location: 'https://example.invalid/x', Key: 'k' }) }));
  const doc = () => ({
    put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  });
  return {
    DynamoDB: { DocumentClient: jest.fn(doc) },
    S3: Object.assign(jest.fn(() => ({ upload, getObject: jest.fn(), getSignedUrl: jest.fn() })), { upload }),
    SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
    config: { update: jest.fn() },
  };
});
jest.mock('../utils/callerUrlFetch', () => ({
  ...jest.requireActual('../utils/callerUrlFetch'),
  fetchCallerUrlText: jest.fn(),
}));
// The real policy and key rules, with the database reads stubbed; `decideStorageAccess` is wrapped so the keys it is asked about are recorded.
jest.mock('../services/storageAccessPolicy', () => {
  const actual = jest.requireActual('../services/storageAccessPolicy');
  const users: Record<string, any> = { me: { userId: 'me', orgId: 'orgA', orgRole: 'member' } };
  class StubLookups extends actual.StorageAccessLookups {
    user(id: string) { return Promise.resolve(users[id] ?? null); }
    task() { return Promise.resolve(null); }
    execution() { return Promise.resolve(null); }
    org() { return Promise.resolve(null); }
    session() { return Promise.resolve(null); }
  }
  return { ...actual, StorageAccessLookups: StubLookups, decideStorageAccess: jest.fn(actual.decideStorageAccess) };
});

const s3Upload = (AWS.S3 as any).upload as jest.Mock;
const decide = decideStorageAccess as jest.Mock;
const fetchText = fetchCallerUrlText as jest.Mock;

const HOST = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com';
const PART = ['part', [{ old_content: 'Old', new_content: 'New', expected_count: 1 }]] as const;
const CSS = ['css', [{ action: 'replaceInner', selector: 'h1.t', html: 'New' }]] as const;

describe('update_html_file: the key that is authorised is the key S3 receives', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchText.mockResolvedValue('<html><body><h1 class="t">Old</h1></body></html>');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const writeKeysAsked = () => decide.mock.calls.filter((c) => c[2] === 'write').map((c) => c[1] as string);

  describe.each([['part replacement', PART], ['css edit', CSS]] as const)('%s', (_name, mode) => {
    it.each([
      ['a plain name', 'users/me/files/1700/abc/page.html'],
      ['a doubled slash in the folder', 'users//me//files/1700/abc/page.html'],
      ['a name with an encoded space', 'users/me/files/1700/abc/my%20page.html'],
      ['a name with unicode', 'users/me/files/1700/abc/%D1%81%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0.html'],
      ['a name with a control character', 'users/me/files/1700/abc/pa\u0001ge.html'],
      ['a name with characters the upload rewrites', 'users/me/files/1700/abc/we!rd$na(me)&x=y.html'],
      ['a presigned URL with a query string', 'users/me/files/1700/abc/page.html?X-Amz-Signature=abc&X-Amz-Expires=300'],
      ['an upper-case extension', 'users/me/files/1700/abc/PAGE.HTML'],
      ['a name with no extension', 'users/me/files/1700/abc/readme'],
      ['an already versioned name', 'users/me/files/1700/abc/page_v7.html'],
    ])('%s', async (_label, key) => {
      const r = await htmlUpdateImpl.updateHtmlFile(`${HOST}/${key}`, mode[0], mode[1] as any, 'me', 's1');
      expect(r.success).toBe(true);

      const asked = writeKeysAsked();
      expect(asked).toHaveLength(1);
      expect(s3Upload).toHaveBeenCalledTimes(1);
      const written = s3Upload.mock.calls[0][0].Key as string;
      // the whole point: what the rule was asked about is exactly what S3 was told to write
      expect(written).toBe(asked[0]);
      // and it is inside the caller's own folder
      expect(written.startsWith('users/me/files/1700/abc/')).toBe(true);
      expect(written.split('/')).not.toContain('');
    });

    it('a refused file reaches neither the rule\'s success path nor S3', async () => {
      const r = await htmlUpdateImpl.updateHtmlFile(`${HOST}/users/other/files/1700/abc/page.html`, mode[0], mode[1] as any, 'me', 's1');
      expect(r.success).toBe(false);
      expect(s3Upload).not.toHaveBeenCalled();
      expect(fetchText).not.toHaveBeenCalled();
    });
  });
});
