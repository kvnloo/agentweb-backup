/**
 * ENG-1603. workPlanService.ts and config/aws.ts each built AWS config with an
 * explicit credentials object that fell back to empty strings/undefined when
 * AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY weren't set — which short-circuits
 * the SDK's default credential-provider chain and masks valid shared-profile
 * or instance-role credentials (the exact failure mode db.ts already guards
 * against, per its own comment). These pin the fix: credentials are omitted
 * entirely when the env vars are absent, and passed through unchanged when
 * both are set (no behavior change for the deployed path, which sets them).
 */

describe('AWS credentials guard (ENG-1603)', () => {
  const ORIGINAL_ENV = { ...process.env };

  const setEnv = (accessKeyId?: string, secretAccessKey?: string, sessionToken?: string) => {
    if (accessKeyId === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = accessKeyId;
    if (secretAccessKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
    if (sessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
    else process.env.AWS_SESSION_TOKEN = sessionToken;
  };

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('workPlanService.ts', () => {
    let DocumentClientMock: jest.Mock;

    beforeEach(() => {
      jest.resetModules();
      DocumentClientMock = jest.fn();
      jest.doMock('aws-sdk', () => ({
        DynamoDB: { DocumentClient: DocumentClientMock },
        config: { update: jest.fn() },
      }));
      // Otherwise workPlanService.ts's own dotenv.config() call reloads the
      // real .env file's AWS keys into process.env right as the module loads,
      // silently undoing setEnv(undefined, undefined) above it.
      jest.doMock('dotenv', () => ({ config: jest.fn() }));
    });

    it('omits credentials when env vars are unset — falls through to the default provider chain', () => {
      setEnv(undefined, undefined);
      require('../services/workPlanService');
      const args = DocumentClientMock.mock.calls[0][0];
      expect(args.credentials).toBeUndefined();
    });

    it('passes explicit credentials when both env vars are set — no behavior change for the deployed path', () => {
      setEnv('AKIA_TEST', 'secret_test');
      require('../services/workPlanService');
      const args = DocumentClientMock.mock.calls[0][0];
      expect(args.credentials).toEqual({ accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret_test' });
    });

    it('includes sessionToken when set alongside both keys', () => {
      setEnv('AKIA_TEST', 'secret_test', 'session_tok');
      require('../services/workPlanService');
      const args = DocumentClientMock.mock.calls[0][0];
      expect(args.credentials).toEqual({
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret_test',
        sessionToken: 'session_tok',
      });
    });
  });

  describe('config/aws.ts', () => {
    let updateMock: jest.Mock;

    beforeEach(() => {
      jest.resetModules();
      updateMock = jest.fn();
      jest.doMock('aws-sdk', () => ({
        DynamoDB: { DocumentClient: jest.fn() },
        config: { update: updateMock },
      }));
    });

    it('omits accessKeyId/secretAccessKey entirely when env vars are unset', () => {
      setEnv(undefined, undefined);
      require('../config/aws');
      const args = updateMock.mock.calls[0][0];
      expect(args).not.toHaveProperty('accessKeyId');
      expect(args).not.toHaveProperty('secretAccessKey');
    });

    it('passes explicit credentials when both env vars are set', () => {
      setEnv('AKIA_TEST', 'secret_test');
      require('../config/aws');
      const args = updateMock.mock.calls[0][0];
      expect(args.accessKeyId).toBe('AKIA_TEST');
      expect(args.secretAccessKey).toBe('secret_test');
    });
  });
});
