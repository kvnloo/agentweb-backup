/**
 * update_html_file fetches a URL the caller names, edits it, and writes the edited copy into our file bucket with the SERVER's
 * credentials. The directory of that copy comes from the caller's own URL, so the tool must apply the ENG-2988 write rule
 * (services/storageAccessPolicy.ts) to the exact key it is about to write: only the owner writes, as on /api/files/html.
 * It must decide that BEFORE it fetches anything, and what it authorises must be what it writes.
 *
 * The real policy runs here; only its database lookups are stubbed. The URL fetch and the S3 upload are mocked. Every fixture is synthetic.
 */
import * as htmlUpdateImpl from '../emma/impl/htmlUpdate';
import { fetchCallerUrlText, CALLER_URL_BLOCKED_MESSAGE, CallerUrlBlockedError } from '../utils/callerUrlFetch';
import { uploadFileToS3WithPath } from '../utils/s3Utils';

jest.mock('../utils/callerUrlFetch', () => ({
  ...jest.requireActual('../utils/callerUrlFetch'),
  fetchCallerUrlText: jest.fn(),
}));
// The real file-name rewriting (sanitizeS3Filename); only the upload itself is replaced.
jest.mock('../utils/s3Utils', () => ({
  ...jest.requireActual('../utils/s3Utils'),
  uploadFileToS3WithPath: jest.fn(),
}));
// The real policy and key rules; only the database reads behind it are replaced. (Data lives inside the factory: jest hoists it.)
jest.mock('../services/storageAccessPolicy', () => {
  const actual = jest.requireActual('../services/storageAccessPolicy');
  const users: Record<string, any> = {
    me: { userId: 'me', orgId: 'orgA', orgRole: 'member' },
    mate: { userId: 'mate', orgId: 'orgA', orgRole: 'member' },
    other: { userId: 'other', orgId: 'orgB', orgRole: 'member' },
  };
  const sessions: Record<string, any> = {
    '11111111-1111-4111-8111-111111111111': { userId: 'me' },
    '22222222-2222-4222-8222-222222222222': { userId: 'other' },
  };
  class StubLookups extends actual.StorageAccessLookups {
    user(id: string) { return Promise.resolve(users[id] ?? null); }
    task() { return Promise.resolve(null); }
    execution() { return Promise.resolve(null); }
    org() { return Promise.resolve(null); }
    session(id: string) {
      // '1': what the real class does when a database read fails (records the failure, answers "not found").
      if (process.env.TEST_LOOKUP_FAILS === '1') { (this as any).failed = true; return Promise.resolve(null); }
      // '2': something unexpected escapes the lookup.
      if (process.env.TEST_LOOKUP_FAILS === '2') throw new Error('unexpected');
      return Promise.resolve(sessions[id] ?? null);
    }
  }
  return { ...actual, StorageAccessLookups: StubLookups };
});

import {
  TOOL_FILE_READ_ONLY_MESSAGE,
  TOOL_FILE_REFUSAL_MESSAGE,
  TOOL_FILE_UNAVAILABLE_MESSAGE,
  checkOurBucketPathWrite,
} from '../emma/impl/toolStorageAccess';

const fetchText = fetchCallerUrlText as jest.Mock;
const upload = uploadFileToS3WithPath as jest.Mock;

const BUCKET_HOST = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com';
const OLD = '<html><body><h1 class="t">Old</h1><p>keep</p></body></html>';
const url = (key: string) => `${BUCKET_HOST}/${key}`;

/** The two ways the tool edits: a part/full text replacement and a CSS-selector edit. */
const PART = ['part', [{ old_content: 'Old', new_content: 'New', expected_count: 1 }]] as const;
const CSS = ['css', [{ action: 'replaceInner', selector: 'h1.t', html: 'New' }]] as const;
const MODES: Array<[string, readonly [string, any[]]]> = [['part replacement', PART], ['css edit', CSS]];

describe('update_html_file: who may write the edited copy', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TEST_LOOKUP_FAILS;
    fetchText.mockResolvedValue(OLD);
    upload.mockResolvedValue({ success: true, url: 'https://example.invalid/new.html', key: 'new.html' });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // `rest` so that an explicit `undefined` caller stays undefined (a default parameter would turn it into 'me').
  const edit = (mode: readonly [string, any[]], fileUrl: unknown, ...rest: any[]) =>
    htmlUpdateImpl.updateHtmlFile(fileUrl as string, mode[0], mode[1], rest.length ? rest[0] : 'me', 'session-1');

  const refused = (r: any) => {
    expect(r.success).toBe(false);
    expect(r.message).toBe(TOOL_FILE_REFUSAL_MESSAGE);
    expect(r.errorClass).toBe('invalid_args'); // a bad argument, not a config/account fault (ENG-2993)
    expect(JSON.stringify(r)).not.toMatch(/users\/|bucket|\.html/i); // nothing about the target comes back
  };
  const nothingTouched = () => {
    expect(fetchText).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  };

  describe.each(MODES)('%s', (_name, mode) => {
    describe('what keeps working', () => {
      it('edits a file in the caller\'s own folder, and writes the next version beside it', async () => {
        const r = await edit(mode, url('users/me/files/1700/abc/page.html'));
        expect(r.success).toBe(true);
        expect(fetchText).toHaveBeenCalledTimes(1);
        expect(upload).toHaveBeenCalledTimes(1);
        // exactly where the original lives, under the next version's name
        expect(upload).toHaveBeenCalledWith(expect.any(String), 'page_v2.html', 'text/html', 'users/me/files/1700/abc');
        expect(warn).not.toHaveBeenCalled();
      });

      it('the next version of a versioned file goes to the next number', async () => {
        await edit(mode, url('users/me/files/1700/abc/page_v2.html'));
        expect(upload).toHaveBeenCalledWith(expect.any(String), 'page_v3.html', 'text/html', 'users/me/files/1700/abc');
      });

      it('fetches the URL through the guarded fetch, naming the tool and the caller', async () => {
        await edit(mode, url('users/me/files/1700/abc/page.html'));
        expect(fetchText).toHaveBeenCalledWith(
          url('users/me/files/1700/abc/page.html'),
          expect.objectContaining({ tool: 'update_html_file', userId: 'me' }),
        );
      });

      it('a file name with characters the upload rewrites is authorised as the name it will actually have', async () => {
        await edit(mode, url('users/me/files/1700/abc/my%20page.html'));
        expect(upload).toHaveBeenCalledTimes(1);
        const [, name, , dir] = upload.mock.calls[0];
        expect(dir).toBe('users/me/files/1700/abc');
        expect(name).toMatch(/^my.*_v2\.html$/);
      });
    });

    describe('the key that is checked is the key that is written', () => {
      // The upload rewrites unsafe characters in the file name (a control character becomes `_`). The raw name would not even pass the rule's
      // key checks, the rewritten one does, so this only passes if the check is asked about the name the upload will actually write.
      it('a file name with a control character is authorised as the name the upload will write, not as the raw name', async () => {
        const r = await edit(mode, `${BUCKET_HOST}/users/me/files/1700/abc/pa\u0001ge.html`);
        expect(r.success).toBe(true);
        expect(upload).toHaveBeenCalledTimes(1);
        const [, name, , dir] = upload.mock.calls[0];
        expect(dir).toBe('users/me/files/1700/abc');
        expect(name).toBe('pa\u0001ge_v2.html');
      });
    });

    describe('what is refused (nothing is fetched, nothing is written)', () => {
      it.each([
        ['another user\'s file', url('users/other/files/1700/abc/page.html')],
        ['a user that does not exist at all', url('users/9999999999999/files/1700/abc/page.html')],
        ['another organisation\'s brand folder', url('users/other/brand/page.html')],
        ['a task folder it cannot place for the caller', url('tasks/t-unknown/attachments/page.html')],
        ['a tool-response folder of a session that is not the caller\'s', url('tool-responses/22222222-2222-4222-8222-222222222222/page.html')],
        ['a key of a shape the rule does not know', url('backups/page.html')],
        ['a bare top-level name', url('page.html')],
        ['a URL on another host whose path is not the caller\'s', 'https://example.com/some/dir/page.html'],
        ['a URL with no path at all', 'https://example.com'],
      ])('%s', async (_label, fileUrl) => {
        refused(await edit(mode, fileUrl));
        nothingTouched();
      });

      it('a teammate\'s file: told it is read-only (only the owner writes), not "not found"', async () => {
        const r = await edit(mode, url('users/mate/files/1700/abc/page.html'));
        expect(r.success).toBe(false);
        expect(r.message).toBe(TOOL_FILE_READ_ONLY_MESSAGE);
        expect(r.errorClass).toBe('invalid_args');
        nothingTouched();
      });

      it.each([
        ['a `..` that climbs into another user\'s folder (the URL parser resolves it)', 'https://x.example/users/me/files/../../other/files/1700/abc/page.html'],
        ['a `..` written with percent-encoding', 'https://x.example/users/me/files/%2e%2e/%2e%2e/other/files/1700/abc/page.html'],
        ['the owner\'s name written with percent-encoding (a different key from the one the rule would place)', url('users/%6de/files/1700/abc/page.html')],
        ['a doubled slash in the folder', url('users/me//files/1700/abc/page.html')],
      ])('%s', async (_label, fileUrl) => {
        const r = await edit(mode, fileUrl);
        // Either refused outright, or (the URL parser having resolved it to the caller's own folder) written exactly there: never elsewhere.
        if (r.success) {
          for (const [, , , dir] of upload.mock.calls) expect(String(dir)).toMatch(/^users\/me\//);
        } else {
          expect([TOOL_FILE_REFUSAL_MESSAGE, TOOL_FILE_READ_ONLY_MESSAGE]).toContain(r.message);
        }
        for (const [, , , dir] of upload.mock.calls) expect(String(dir)).not.toMatch(/other/);
      });

      it.each([
        ['missing from the call', undefined],
        ['null', null],
        ['an empty string', ''],
        ['blank', '   '],
        ['not a string', 42],
      ])('refuses when the caller is %s, even for a file that would be the caller\'s own', async (_label, userId) => {
        refused(await edit(mode, url('users/me/files/1700/abc/page.html'), userId));
        nothingTouched();
      });

      it('refuses a file URL that is not a string', async () => {
        const r = await edit(mode, undefined);
        expect(r.success).toBe(false);
        nothingTouched();
      });

      it('gives the SAME refusal whether the file exists or not (no way to probe for files)', async () => {
        const a = await edit(mode, url('users/other/files/1700/abc/real.html'));
        const b = await edit(mode, url('users/other/files/1700/abc/nope.html'));
        expect(a).toEqual(b);
        refused(a);
      });

      it('a refusal is logged with the tool, the kind of key and the reason, never the key or the file name', async () => {
        await edit(mode, url('users/other/files/1700/abc/secret-plan.html'));
        expect(warn).toHaveBeenCalledTimes(1);
        const line = JSON.parse(warn.mock.calls[0][0]);
        expect(line).toMatchObject({ event: 'storage_access_denied', route: 'tool:update_html_file', access: 'write', userId: 'me' });
        expect(typeof line.shape).toBe('string');
        expect(warn.mock.calls[0][0]).not.toMatch(/secret-plan|abc/);
      });
    });

    describe('when the check cannot run', () => {
      it('does nothing and says "try again" when a lookup fails', async () => {
        process.env.TEST_LOOKUP_FAILS = '1';
        const r = await edit(mode, url('tool-responses/11111111-1111-4111-8111-111111111111/page.html'));
        expect(r.success).toBe(false);
        expect(r.message).toBe(TOOL_FILE_UNAVAILABLE_MESSAGE);
        expect(r.errorClass).toBe('upstream_5xx');
        nothingTouched();
      });

      it('does nothing when something unexpected escapes the check', async () => {
        process.env.TEST_LOOKUP_FAILS = '2';
        const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const r = await edit(mode, url('tool-responses/11111111-1111-4111-8111-111111111111/page.html'));
        expect(r.success).toBe(false);
        expect(r.message).toBe(TOOL_FILE_UNAVAILABLE_MESSAGE);
        nothingTouched();
        err.mockRestore();
      });
    });

    describe('the fetch, once the write is allowed', () => {
      it('a URL the guard refuses gives one generic answer with no address, and nothing is written', async () => {
        fetchText.mockRejectedValue(new CallerUrlBlockedError());
        const r = await edit(mode, 'https://x.example/users/me/files/1700/abc/page.html');
        expect(r.success).toBe(false);
        expect(String(r.error)).toContain(CALLER_URL_BLOCKED_MESSAGE);
        expect(JSON.stringify(r)).not.toMatch(/169\.254|127\.0\.0\.1|private|internal|resolve|DNS/i);
        expect(upload).not.toHaveBeenCalled();
      });

      it('a dead link is still reported as a failed fetch, and nothing is written', async () => {
        fetchText.mockRejectedValue(new Error('Request failed with status code 404'));
        const r = await edit(mode, url('users/me/files/1700/abc/page.html'));
        expect(r.success).toBe(false);
        expect(String(r.error)).toContain('404');
        expect(upload).not.toHaveBeenCalled();
      });
    });
  });

  it('still validates its own arguments first (a bad update_type is reported as that, not as a refusal)', async () => {
    const r = await htmlUpdateImpl.updateHtmlFile(url('users/other/files/1700/abc/page.html'), 'bogus', [{}], 'me', 's');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/update_type/);
    expect(r.message).not.toBe(TOOL_FILE_REFUSAL_MESSAGE);
  });
});

describe('checkOurBucketPathWrite: the key that is authorised is the key that is written', () => {
  beforeEach(() => {
    delete process.env.TEST_LOOKUP_FAILS;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('allows the owner, with the same clean-up of the directory the upload applies', async () => {
    expect(await checkOurBucketPathWrite('t', 'me', 'users/me/files/1/abc', 'a.html')).toBe('allow');
    expect(await checkOurBucketPathWrite('t', 'me', '/users/me/files/1/abc/', 'a.html')).toBe('allow');
    expect(await checkOurBucketPathWrite('t', 'me', 'users//me///files/1/abc', 'a.html')).toBe('allow');
  });

  it('refuses another user\'s folder however the directory is spelled', async () => {
    expect(await checkOurBucketPathWrite('t', 'me', 'users/other/files/1/abc', 'a.html')).toBe('refuse');
    expect(await checkOurBucketPathWrite('t', 'me', '/users/other/files/1/abc/', 'a.html')).toBe('refuse');
    expect(await checkOurBucketPathWrite('t', 'me', 'users//other//files/1/abc', 'a.html')).toBe('refuse');
  });

  it('a teammate may read but not write', async () => {
    expect(await checkOurBucketPathWrite('t', 'me', 'users/mate/files/1/abc', 'a.html')).toBe('read_only');
  });

  it.each([
    ['a file name that is a dot segment', 'users/me/files/1/abc', '..'],
    ['a file name that is a single dot', 'users/me/files/1/abc', '.'],
    ['an empty file name', 'users/me/files/1/abc', ''],
    ['a file name with a slash (it would add a segment the rule never saw)', 'users/me/files/1/abc', 'x/../../../other/y.html'],
    ['a `..` in the directory', 'users/me/files/../../other/files/1', 'a.html'],
    ['a control character in the name', 'users/me/files/1/abc', 'a\u0000.html'],
    ['no directory and a bare name', '', 'a.html'],
  ])('refuses %s', async (_label, dir, filename) => {
    expect(await checkOurBucketPathWrite('t', 'me', dir, filename)).toBe('refuse');
  });

  it.each([[undefined], [null], [''], ['  ']])('refuses a blank caller (%p)', async (userId) => {
    expect(await checkOurBucketPathWrite('t', userId as any, 'users/me/files/1/abc', 'a.html')).toBe('refuse');
  });

  it('answers "try again" for a failed lookup, and never allows on an error', async () => {
    process.env.TEST_LOOKUP_FAILS = '1';
    expect(await checkOurBucketPathWrite('t', 'me', 'tool-responses/11111111-1111-4111-8111-111111111111', 'a.html')).toBe('unavailable');
    process.env.TEST_LOOKUP_FAILS = '2';
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await checkOurBucketPathWrite('t', 'me', 'tool-responses/11111111-1111-4111-8111-111111111111', 'a.html')).toBe('unavailable');
    err.mockRestore();
  });

  it('a tool never carries admin power', async () => {
    // 'other' is not an admin here; the rule is asked with isRealAdmin false, so another user's folder stays refused.
    expect(await checkOurBucketPathWrite('t', 'other', 'users/me/files/1/abc', 'a.html')).toBe('refuse');
  });
});
