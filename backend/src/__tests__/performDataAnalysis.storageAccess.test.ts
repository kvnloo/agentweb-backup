/**
 * perform_data_analysis reads our file bucket with the SERVER's credentials (the SDK), for three kinds of caller-named reference:
 * an `s3://<bucket>/<key>` URI, a bare `tool-responses/<session>/...` key, and a tool-response key written inside the instruction text.
 * Those credentials can read every bucket in the account, so the tool must apply the ENG-2988 rule (services/storageAccessPolicy.ts)
 * to the caller, and must never read a bucket other than ours on the caller's say-so.
 *
 * The real policy runs here; only its database lookups are stubbed. Everything else is mocked and every fixture is synthetic.
 */
import axios from 'axios';
import { getSecret } from '../utils/secretsManager';
import { getS3ObjectAsString } from '../utils/s3Utils';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: true, url: 'https://example.com/u.png' }),
  getS3ObjectAsString: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));
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

import { performDataAnalysis, __resetDataAnalysisConsistencyCacheForTests } from '../emma/impl/searchResearch';
import { TOOL_FILE_REFUSAL_MESSAGE, TOOL_FILE_UNAVAILABLE_MESSAGE } from '../emma/impl/toolStorageAccess';

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const secret = getSecret as jest.Mock;
const readS3 = getS3ObjectAsString as jest.Mock;

const OUR_BUCKET = 'agentweb-user-files';
const MY_SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_SESSION = '33333333-3333-4333-8333-333333333333';

const geminiOk = () => post.mockResolvedValue({
  data: { candidates: [{ content: { parts: [{ text: 'Analysis complete.' }, { codeExecutionResult: { output: 'ok' } }] } }] },
});

describe('perform_data_analysis: what the server may read for the caller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TEST_LOOKUP_FAILS;
    delete process.env.AWS_S3_BUCKET;
    secret.mockResolvedValue('test-key');
    readS3.mockResolvedValue('a,b\n1,2');
    geminiOk();
    __resetDataAnalysisConsistencyCacheForTests();
  });

  const refused = (r: any) => {
    expect(r.success).toBe(false);
    expect(r.message).toBe(TOOL_FILE_REFUSAL_MESSAGE);
    expect(r.errorClass).toBe('invalid_args'); // a bad argument, not a config/account fault (ENG-2993)
    expect(JSON.stringify(r)).not.toMatch(/users\/|bucket|tool-responses/i); // nothing about the target comes back
  };

  describe('s3:// URIs', () => {
    it('refuses a bucket other than ours and reads nothing', async () => {
      const r = await performDataAnalysis(['s3://some-other-private-bucket/backups/db.sql'], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses another bucket even when the key would be allowed in ours (the bucket check stands on its own)', async () => {
      const r = await performDataAnalysis(['s3://some-other-private-bucket/users/me/files/1/abc/data.csv'], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it.each([[`${OUR_BUCKET}-backup`], [`${OUR_BUCKET}.s3.amazonaws.com`], [OUR_BUCKET.toUpperCase()], [`prefix-${OUR_BUCKET}`]])(
      'refuses a bucket whose name only resembles ours (%s), even with a key that would be allowed',
      async (bucket) => {
        const r = await performDataAnalysis([`s3://${bucket}/users/me/files/1/abc/data.csv`], 'summarise', 'me');
        refused(r);
        expect(readS3).not.toHaveBeenCalled();
      },
    );

    it('does not read, and says "try again", when the lookup fails on an s3:// file', async () => {
      process.env.TEST_LOOKUP_FAILS = '1';
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/tool-responses/${MY_SESSION}/call1.txt`], 'summarise', 'me');
      expect(r.success).toBe(false);
      expect(r.message).toBe(TOOL_FILE_UNAVAILABLE_MESSAGE);
      expect(r.errorClass).toBe('upstream_5xx');
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a task file key it cannot place for the caller', async () => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/tasks/t-unknown/attachments/data.csv`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('follows the policy for files of anonymous plan visitors (readable by any signed-in user, as on the REST routes)', async () => {
      const key = 'users/anon_abc123/files/1/abc/plan.csv';
      await performDataAnalysis([`s3://${OUR_BUCKET}/${key}`], 'summarise', 'me');
      expect(readS3).toHaveBeenCalledWith(key, OUR_BUCKET);
    });

    it('refuses the whole call when one file in the list is not the caller\'s, and sends nothing to the model', async () => {
      const r = await performDataAnalysis(
        [`s3://${OUR_BUCKET}/users/me/files/1/abc/mine.csv`, `s3://${OUR_BUCKET}/users/other/files/1/abc/theirs.csv`],
        'summarise',
        'me',
      );
      refused(r);
      expect(post).not.toHaveBeenCalled();
    });

    it('refuses another organisation\'s file in our bucket', async () => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/users/other/files/1/abc/secret.csv`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a kind that is the owner\'s alone, even for a teammate', async () => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/users/mate/books/1/abc/draft.csv`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a key shape the policy cannot place', async () => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/builds/backend-20260101-pr1.zip`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a key that tries to climb out of its folder', async () => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/users/me/files/../../other/files/1/abc/secret.csv`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a key the policy would rewrite, so the checked key is the key that would be read', async () => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/s3:users/me/files/1/abc/data.csv`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('reads the caller\'s own file', async () => {
      const key = 'users/me/files/1234/abc/data.csv';
      await performDataAnalysis([`s3://${OUR_BUCKET}/${key}`], 'summarise', 'me');
      expect(readS3).toHaveBeenCalledWith(key, OUR_BUCKET);
    });

    it('reads a teammate\'s file of a kind shared inside the organisation (same rule as the REST routes)', async () => {
      const key = 'users/mate/files/1234/abc/data.csv';
      await performDataAnalysis([`s3://${OUR_BUCKET}/${key}`], 'summarise', 'me');
      expect(readS3).toHaveBeenCalledWith(key, OUR_BUCKET);
    });

    it('follows AWS_S3_BUCKET when the deployment names another bucket as ours', async () => {
      process.env.AWS_S3_BUCKET = 'custom-user-files';
      const key = 'users/me/files/1/abc/data.csv';
      await performDataAnalysis([`s3://custom-user-files/${key}`], 'summarise', 'me');
      expect(readS3).toHaveBeenCalledWith(key, 'custom-user-files');
      readS3.mockClear();
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/${key}`], 'summarise again', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it.each([[undefined], [''], ['   ']])('fails closed with no usable caller (%j)', async (caller) => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/users/me/files/1/abc/data.csv`], 'summarise', caller as any);
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    // The policy lets ANY signed-in user read anonymous-visitor files, so this is the case where only the "no usable caller" guard
    // stands between a caller-less run and a read (an ordinary key is refused by the policy anyway and would not prove the guard).
    it.each([[undefined], [''], ['   ']])('does not let a caller-less run read a file the policy opens to any signed-in user (%j)', async (caller) => {
      const r = await performDataAnalysis([`s3://${OUR_BUCKET}/users/anon_abc123/files/1/abc/plan.csv`], 'summarise', caller as any);
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });
  });

  describe('bare tool-response keys', () => {
    it('reads a tool response of the caller\'s own session', async () => {
      const key = `tool-responses/${MY_SESSION}/call1.txt`;
      await performDataAnalysis([key], 'summarise', 'me');
      expect(readS3).toHaveBeenCalledWith(key);
    });

    it('refuses a tool response of another user\'s session', async () => {
      const r = await performDataAnalysis([`tool-responses/${OTHER_SESSION}/call1.txt`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a tool response of a session that does not exist', async () => {
      const r = await performDataAnalysis([`tool-responses/${UNKNOWN_SESSION}/call1.txt`], 'summarise', 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('does not read, and says "try again" (not "not found"), when the lookup behind the decision fails', async () => {
      process.env.TEST_LOOKUP_FAILS = '1';
      const r = await performDataAnalysis([`tool-responses/${MY_SESSION}/call1.txt`], 'summarise', 'me');
      expect(r.success).toBe(false);
      expect(r.message).toBe(TOOL_FILE_UNAVAILABLE_MESSAGE);
      expect(r.errorClass).toBe('upstream_5xx');
      expect(readS3).not.toHaveBeenCalled();
    });

    it('does not read, and says "try again", when something unexpected escapes the check', async () => {
      process.env.TEST_LOOKUP_FAILS = '2';
      const r = await performDataAnalysis([`tool-responses/${MY_SESSION}/call1.txt`], 'summarise', 'me');
      expect(r.message).toBe(TOOL_FILE_UNAVAILABLE_MESSAGE);
      expect(readS3).not.toHaveBeenCalled();
    });
  });

  describe('tool-response keys written inside the instruction text', () => {
    it('inlines the caller\'s own tool response', async () => {
      const key = `tool-responses/${MY_SESSION}/call1.txt`;
      await performDataAnalysis([], `Use ${key} and total the clicks.`, 'me');
      expect(readS3).toHaveBeenCalledWith(key);
      const sent = post.mock.calls[0][1].contents[0].parts.at(-1).text as string;
      expect(sent).toContain('a,b\n1,2');
    });

    it('refuses another user\'s tool response named in the text, with the same answer as the other read sites', async () => {
      const r = await performDataAnalysis([], `Use tool-responses/${OTHER_SESSION}/call1.txt and total the clicks.`, 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('says "try again", and reads nothing, when the lookup fails for a key named in the text', async () => {
      process.env.TEST_LOOKUP_FAILS = '1';
      const r = await performDataAnalysis([], `Use tool-responses/${MY_SESSION}/call1.txt and total the clicks.`, 'me');
      expect(r.success).toBe(false);
      expect(r.message).toBe(TOOL_FILE_UNAVAILABLE_MESSAGE);
      expect(r.errorClass).toBe('upstream_5xx');
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses a key that climbs out of the caller\'s own tool-response folder', async () => {
      const r = await performDataAnalysis([], `Use tool-responses/${MY_SESSION}/../../users/other/files/1/abc/secret.csv now.`, 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses the WHOLE call, and reads nothing, when the text names one key the caller owns and one it does not', async () => {
      const mine = `tool-responses/${MY_SESSION}/a.txt`;
      const theirs = `tool-responses/${OTHER_SESSION}/b.txt`;
      const r = await performDataAnalysis([], `Compare ${mine} with ${theirs}.`, 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });

    it('refuses the whole call when the refused key comes FIRST and an owned key second (every position is checked)', async () => {
      const theirs = `tool-responses/${OTHER_SESSION}/b.txt`;
      const mine = `tool-responses/${MY_SESSION}/a.txt`;
      const r = await performDataAnalysis([], `Compare ${theirs} with ${mine}.`, 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('refuses the whole call when the refused key is in the MIDDLE of three', async () => {
      const a = `tool-responses/${MY_SESSION}/a.txt`;
      const theirs = `tool-responses/${OTHER_SESSION}/b.txt`;
      const c = `tool-responses/${MY_SESSION}/c.txt`;
      const r = await performDataAnalysis([], `Compare ${a}, ${theirs} and ${c}.`, 'me');
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('answers "refused", not "try again", when one key is refused outright and another check could not run', async () => {
      process.env.TEST_LOOKUP_FAILS = '1';
      // The climbing key is refused without any lookup; the own-session key needs a lookup, which fails here.
      const r = await performDataAnalysis(
        [],
        `Use tool-responses/${MY_SESSION}/../../users/other/files/1/abc/secret.csv and tool-responses/${MY_SESSION}/ok.txt.`,
        'me',
      );
      refused(r);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('still inlines several keys when the caller owns them all', async () => {
      const a = `tool-responses/${MY_SESSION}/a.txt`;
      const b = `tool-responses/${MY_SESSION}/b.txt`;
      await performDataAnalysis([], `Compare ${a} with ${b}.`, 'me');
      expect(readS3).toHaveBeenCalledTimes(2);
    });
  });

  describe('plain HTTP(S) URLs are a separate matter', () => {
    // A plain GET of a public URL uses no server privilege, so this change does not gate it (the outbound-fetch hardening is its own work).
    it('still fetches an https URL, own bucket or not', async () => {
      get.mockResolvedValue({ data: new ArrayBuffer(8) });
      await performDataAnalysis([`https://${OUR_BUCKET}.s3.us-west-2.amazonaws.com/users/other/files/1/abc/public.csv`], 'summarise', 'me');
      expect(get).toHaveBeenCalledTimes(1);
      expect(readS3).not.toHaveBeenCalled();
    });
  });
});
