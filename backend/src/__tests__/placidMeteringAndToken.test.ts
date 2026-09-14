/**
 * ENG-698 — Placid: token read from Secrets Manager, and the render metered.
 *
 * Placid was the last unmetered paid vendor. Two separate concerns ship
 * together because they touch the same controller, but they apply to
 * DIFFERENT calls, which is the part most worth pinning down:
 *
 *   getPlacidEditorToken   mints an editor JWT        reads the token, not metered
 *   listPlacidTemplates    catalogue read             reads the token, not metered
 *   render                 URL API image generation   no token, METERED
 *
 * ENG-698's description named the first two as the call sites to meter. They
 * carry no rate — only the render does.
 */

const mockGetSecret = jest.fn();
// One hoisted aws-sdk mock serves both suites. It has to expose S3.putObject:
// a hoisted `jest.mock` wins over a later `jest.doMock`, so a second aws-sdk
// stub further down would be silently ignored and the controller would see an
// S3 client with no methods.
const mockPutObject = jest.fn();
jest.mock('aws-sdk', () => {
  const S3 = jest.fn(() => ({
    putObject: (...a: any[]) => ({ promise: () => mockPutObject(...a) }),
  }));
  const SecretsManager = jest.fn(() => ({
    getSecretValue: (args: { SecretId: string }) => ({ promise: () => mockGetSecret(args.SecretId) }),
  }));
  const DynamoDB = { DocumentClient: jest.fn(() => ({})) };
  return { __esModule: true, default: { S3, SecretsManager, DynamoDB }, S3, SecretsManager, DynamoDB };
});

import { getPlacidPrivateToken, __resetPlacidTokenCache, PLACID_TOKEN_TTL_MS } from '../utils/secretsManager';

describe('getPlacidPrivateToken (ENG-698)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PLACID_PRIVATE_TOKEN;
    // The resolved token is cached at module scope, so without this each test
    // would silently read the previous test's answer.
    __resetPlacidTokenCache();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  // Harsha described the migrated secret as holding "a non-empty
  // PLACID_PRIVATE_TOKEN value" (ENG-1598). That fits both shapes below, and
  // the secret is not readable from here — so both must work, or production
  // breaks on whichever one was not guessed.
  it('reads a JSON secret keyed by PLACID_PRIVATE_TOKEN', async () => {
    mockGetSecret.mockResolvedValue({ SecretString: '{"PLACID_PRIVATE_TOKEN":"tok-json"}' });
    await expect(getPlacidPrivateToken()).resolves.toBe('tok-json');
  });

  it('reads a bare-string secret', async () => {
    mockGetSecret.mockResolvedValue({ SecretString: '  tok-plain  ' });
    await expect(getPlacidPrivateToken()).resolves.toBe('tok-plain');
  });

  it('uses the prod secret name in production and the dev name otherwise', async () => {
    mockGetSecret.mockResolvedValue({ SecretString: 'x' });

    process.env.NODE_ENV = 'production';
    await getPlacidPrivateToken();
    expect(mockGetSecret).toHaveBeenLastCalledWith('prod/AgentWeb/Placid');

    process.env.NODE_ENV = 'development';
    __resetPlacidTokenCache();
    await getPlacidPrivateToken();
    expect(mockGetSecret).toHaveBeenLastCalledWith('dev/AgentWeb/Placid');
  });

  it('prefers the secret over the environment when both exist', async () => {
    // The whole point of the migration: production stops depending on the env var.
    process.env.PLACID_PRIVATE_TOKEN = 'tok-env';
    mockGetSecret.mockResolvedValue({ SecretString: 'tok-secret' });
    await expect(getPlacidPrivateToken()).resolves.toBe('tok-secret');
  });

  it('falls back to the environment when the secret does not exist, and says so', async () => {
    // The normal case in development — no dev/AgentWeb/Placid was created.
    process.env.PLACID_PRIVATE_TOKEN = 'tok-env';
    mockGetSecret.mockRejectedValue(new Error('ResourceNotFoundException'));

    await expect(getPlacidPrivateToken()).resolves.toBe('tok-env');
    // Logged rather than silent, so a production fallback cannot go unnoticed.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to environment'));
  });

  it('falls back when the secret is JSON without a usable token', async () => {
    process.env.PLACID_PRIVATE_TOKEN = 'tok-env';
    mockGetSecret.mockResolvedValue({ SecretString: '{"somethingElse":"nope"}' });
    await expect(getPlacidPrivateToken()).resolves.toBe('tok-env');
  });

  // ── Caching (CodeRabbit, PR #2901) ────────────────────────────────────────
  // This getter sits on interactive request paths. The env read it replaced
  // was free; an uncached Secrets Manager call on each page view is not.

  it('reuses a resolved token instead of calling Secrets Manager on every request', async () => {
    mockGetSecret.mockResolvedValue({ SecretString: 'tok' });

    await getPlacidPrivateToken();
    await getPlacidPrivateToken();
    await getPlacidPrivateToken();

    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });

  it('shares one lookup between concurrent callers on a cold cache', async () => {
    let release!: (v: unknown) => void;
    mockGetSecret.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = Promise.all([getPlacidPrivateToken(), getPlacidPrivateToken(), getPlacidPrivateToken()]);
    release({ SecretString: 'tok' });

    await expect(pending).resolves.toEqual(['tok', 'tok', 'tok']);
    // Without dedup, a cold cache under load fans out into one read per request.
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });

  it('caches a miss too, so development does not retry a missing secret on every request', async () => {
    process.env.PLACID_PRIVATE_TOKEN = 'tok-env';
    mockGetSecret.mockRejectedValue(new Error('ResourceNotFoundException'));

    await getPlacidPrivateToken();
    await getPlacidPrivateToken();

    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });

  it('asks Secrets Manager again once the TTL has passed', async () => {
    jest.useFakeTimers();
    try {
      mockGetSecret.mockResolvedValue({ SecretString: 'tok-1' });
      await expect(getPlacidPrivateToken()).resolves.toBe('tok-1');

      // A rotated secret must eventually be picked up.
      mockGetSecret.mockResolvedValue({ SecretString: 'tok-2' });
      jest.setSystemTime(Date.now() + PLACID_TOKEN_TTL_MS + 1);

      await expect(getPlacidPrivateToken()).resolves.toBe('tok-2');
      expect(mockGetSecret).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not wedge after a lookup fails — the next call can resolve', async () => {
    mockGetSecret.mockRejectedValueOnce(new Error('throttled'));
    await expect(getPlacidPrivateToken()).resolves.toBeNull(); // no env either
    __resetPlacidTokenCache(); // simulate TTL expiry
    mockGetSecret.mockResolvedValue({ SecretString: 'tok' });
    await expect(getPlacidPrivateToken()).resolves.toBe('tok');
  });

  it('returns null when neither source has a token', async () => {
    mockGetSecret.mockRejectedValue(new Error('ResourceNotFoundException'));
    await expect(getPlacidPrivateToken()).resolves.toBeNull();
  });
});

// ── The render: the one billable Placid call ────────────────────────────────
// Exercised through the real controller so the test proves metering sits in
// the render path, not merely somewhere in the file (which is all the coverage
// guard can establish).

describe('Placid render metering (ENG-698)', () => {
  // Isolated module graph: the controller pulls in a large dependency tree, so
  // every boundary is stubbed and nothing here touches AWS or the network.
  let generateFromTemplateToExecution: any;
  let getPlacidEditorToken: any;
  let listPlacidTemplates: any;
  const mockRecordVendorUsage = jest.fn();
  const mockAxiosGet = jest.fn();
  const mockAxiosPost = jest.fn();
  const mockGetTask = jest.fn();
  const mockGetExecution = jest.fn();
  const mockUpdateExecution = jest.fn();
  const mockGetUser = jest.fn();
  const mockGetToken = jest.fn();

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('../services/usageRecorderService', () => ({
        recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
      }));
      jest.doMock('../utils/secretsManager', () => ({
        getPlacidPrivateToken: (...a: any[]) => mockGetToken(...a),
      }));
      jest.doMock('axios', () => ({
        __esModule: true,
        default: { get: (...a: any[]) => mockAxiosGet(...a), post: (...a: any[]) => mockAxiosPost(...a) },
      }));
      jest.doMock('../services/db', () => ({
        taskDb: {
          getTaskById: (...a: any[]) => mockGetTask(...a),
          getTaskExecutionById: (...a: any[]) => mockGetExecution(...a),
          updateTaskExecution: (...a: any[]) => mockUpdateExecution(...a),
        },
        userDb: { getUserById: (...a: any[]) => mockGetUser(...a) },
        orgDb: {}, scheduleDb: {}, taskTemplateDb: {},
      }));
      jest.doMock('../services/chatbotService', () => ({ chatbotDb: {} }));
      jest.doMock('../services/approvalDb', () => ({ getAssetTypeFromFilename: jest.fn() }));
      jest.doMock('../services/orgShareService', () => ({ canViewItem: jest.fn(), canEditItem: jest.fn() }));
      const ctrl = require('../controllers/tasks');
      generateFromTemplateToExecution = ctrl.generateFromTemplateToExecution;
      getPlacidEditorToken = ctrl.getPlacidEditorToken;
      listPlacidTemplates = ctrl.listPlacidTemplates;
    });
  });

  const res = () => {
    const r: any = {};
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    return r;
  };
  const renderReq = (userId = 'user-3') =>
    ({
      user: { userId },
      params: { id: 'task-1', executionId: 'exec-1' },
      body: { template_uuid: 'tpl-abcdef12', layers: {} },
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetTask.mockResolvedValue({ taskId: 'task-1', userId: 'user-3' });
    mockGetUser.mockResolvedValue({ userId: 'user-3', isAdmin: false });
    mockGetExecution.mockResolvedValue({ taskId: 'task-1', result_files: [] });
    mockUpdateExecution.mockResolvedValue(undefined);
    mockPutObject.mockResolvedValue({});
    mockAxiosGet.mockResolvedValue({ data: new ArrayBuffer(8), headers: { 'content-type': 'image/png' } });
  });

  it('records a render against the requesting user, priced as allocated (AC3, AC7)', async () => {
    const r = res();
    await generateFromTemplateToExecution(renderReq('user-3'), r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-3',
        billingUserId: 'user-3',
        provider: 'placid',
        operation: 'image_render',
        unit: 'render',
        quantity: 1,
        costSource: 'allocated',
      }),
    );
    // $0.095 per image render, from the ENG-703 card.
    expect(mockRecordVendorUsage.mock.calls[0][0].costUsd).toBeCloseTo(0.095, 6);
  });

  // CodeRabbit, PR #2901. The access check lets an admin render a task that a
  // customer owns. Billing the requester would charge the ADMIN's own account
  // for the customer's render.
  it('bills the task owner, not the admin who rendered it on their behalf', async () => {
    mockGetTask.mockResolvedValue({ taskId: 'task-1', userId: 'customer-1' });
    mockGetUser.mockResolvedValue({ userId: 'admin-1', isAdmin: true });
    const r = res();
    await generateFromTemplateToExecution(renderReq('admin-1'), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.billingUserId).toBe('customer-1');
    // The admin is still recorded as who did it — both are kept (ENG-666 #2).
    expect(ctx.userId).toBe('admin-1');
    // onBehalfOf holds the ACTING user, matching every existing writer:
    // spendChargingService sets it to actingUserId, and v0Service to the actor.
    // (An earlier revision of this PR set it to the owner, which contradicted
    // that convention; #2900's implementation had it right.)
    expect(ctx.onBehalfOf).toBe('admin-1');
  });

  it('sets no onBehalfOf when the owner renders their own task', async () => {
    const r = res();
    await generateFromTemplateToExecution(renderReq('user-3'), r);
    expect(mockRecordVendorUsage.mock.calls[0][0].onBehalfOf).toBeUndefined();
  });

  it('does not record when Placid returned no image', async () => {
    mockAxiosGet.mockRejectedValue(new Error('404 template'));
    const r = res();
    await generateFromTemplateToExecution(renderReq(), r);

    expect(r.status).toHaveBeenCalledWith(500);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('records before storage, so an S3 failure cannot lose a billed render', async () => {
    mockPutObject.mockRejectedValue(new Error('bucket gone'));
    const r = res();
    await generateFromTemplateToExecution(renderReq(), r);

    // Placid was paid regardless of what happened to the bytes afterwards.
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('still serves the image when metering throws (AC6)', async () => {
    mockRecordVendorUsage.mockImplementation(() => {
      throw new Error('ledger down');
    });
    const r = res();
    await generateFromTemplateToExecution(renderReq(), r);

    expect(r.status).toHaveBeenCalledWith(200);
  });

  // The two calls ENG-698's description named are NOT billable. Metering them
  // would book spend Placid never charged.
  it('does not meter minting an editor token', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAxiosPost.mockResolvedValue({ data: { token: 'jwt' } });
    const r = res();
    await getPlacidEditorToken({ user: { userId: 'user-3' }, query: { template_uuid: 'tpl' }, body: {} } as any, r);

    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('does not meter listing templates', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAxiosGet.mockResolvedValue({ data: { data: [] } });
    const r = res();
    await listPlacidTemplates({ user: { userId: 'user-3' }, query: {} } as any, r);

    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('reads the token from the secret getter, not the environment', async () => {
    process.env.PLACID_PRIVATE_TOKEN = 'env-should-not-be-used-directly';
    mockGetToken.mockResolvedValue('tok-from-secret');
    mockAxiosGet.mockResolvedValue({ data: { data: [] } });
    const r = res();
    await listPlacidTemplates({ user: { userId: 'user-3' }, query: {} } as any, r);

    expect(mockGetToken).toHaveBeenCalled();
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('api.placid.app/api/rest/templates'),
      expect.objectContaining({ headers: { Authorization: 'Bearer tok-from-secret' } }),
    );
    delete process.env.PLACID_PRIVATE_TOKEN;
  });

  it('returns a clear 500 when no token is configured anywhere', async () => {
    mockGetToken.mockResolvedValue(null);
    const r = res();
    await listPlacidTemplates({ user: { userId: 'user-3' }, query: {} } as any, r);

    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ message: 'Placid private token is not configured' });
  });
});
