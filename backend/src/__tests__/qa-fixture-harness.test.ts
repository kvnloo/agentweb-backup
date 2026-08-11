import {
  AdminGrantNotVisibleError,
  AdminGrantToken,
  AdminGrantRequest,
  AuthSession,
  ChildProcessHandle,
  FixtureCredentials,
  QaFixture,
  QaFixturePreflightAdapters,
  QaTerminationSignal,
  QA_TERMINATION_SIGNALS,
  TemporaryAdminAdapters,
  DynamoUpdatePort,
  createDynamoTemporaryAdminAdapters,
  createAxiosHttpPort,
  createEnvCredentialsLoader,
  createProcessChildAdapters,
  preflightFixtures,
  runCli,
  runWithTemporaryAdmin,
} from '../scripts/qa-fixture-harness';
import axios from 'axios';

const fixtures: QaFixture[] = [
  {
    account: 'qa-user',
    secretRef: 'QA_USER',
    expectedLoginStatus: 200,
    expectedAdminStatus: 403,
  },
  {
    account: 'qa-tier',
    secretRef: 'QA_TIER',
    expectedLoginStatus: 200,
    expectedAdminStatus: 403,
  },
];

function preflightAdapters(): jest.Mocked<QaFixturePreflightAdapters> {
  return {
    loadCredentials: jest.fn(async secretRef => ({
      email: `${secretRef}@example.test`,
      password: 'injected-secret',
    })),
    authenticate: jest.fn(async (_baseUrl: string, _credentials: FixtureCredentials): Promise<AuthSession> => (
      { status: 200, userId: 'user-1', token: 'token', roles: ['customer'] }
    )),
    checkAdminAccess: jest.fn(async (_baseUrl: string, _session: AuthSession) => 403),
    emit: jest.fn(),
  };
}

function adminAdapters(exitCode = 0): {
  adapters: jest.Mocked<TemporaryAdminAdapters>;
  grant: AdminGrantToken;
  handlers: Map<QaTerminationSignal, () => Promise<void>>;
  child: jest.Mocked<ChildProcessHandle>;
  /** Ordered adapter call log — proves the child starts only AFTER the grant is visible. */
  calls: string[];
} {
  const handlers = new Map<QaTerminationSignal, () => Promise<void>>();
  const calls: string[] = [];
  const grant: AdminGrantToken = {
    userId: 'user-1',
    previousValue: false,
    expectedGrantedValue: true,
    version: 'grant-v1',
  };
  const child: jest.Mocked<ChildProcessHandle> = {
    wait: jest.fn(async () => exitCode),
    terminate: jest.fn(),
  };
  return {
    grant,
    handlers,
    child,
    calls,
    adapters: {
      grantConditional: jest.fn(async (_request: AdminGrantRequest) => {
        calls.push('grant');
        return grant;
      }),
      // Default: the GSI has already caught up. Tests that exercise the race
      // override this to return stale reads first.
      readGrantVisibility: jest.fn(async (_grant: AdminGrantToken) => {
        calls.push('visibility');
        return true;
      }),
      waitBeforeRetry: jest.fn(async (_attempt: number) => {
        calls.push('wait');
      }),
      revokeIfCurrent: jest.fn(async (_grant: AdminGrantToken) => {
        calls.push('revoke');
        return true;
      }),
      startChild: jest.fn(async (_command: string[]) => {
        calls.push('startChild');
        return child;
      }),
      onSignal: jest.fn((signal, handler) => {
        handlers.set(signal, handler);
        return () => handlers.delete(signal);
      }),
    },
  };
}

/** Drains microtasks until `predicate` holds, so tests never guess tick counts. */
async function flushUntil(predicate: () => boolean, maxTicks = 100): Promise<void> {
  for (let tick = 0; tick < maxTicks && !predicate(); tick += 1) {
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error('flushUntil: condition never became true');
  }
}

describe('QA fixture preflight', () => {
  const partnerFixtures = fixtures.map(fixture => ({
    ...fixture,
    expectedPortalRole: 'partner',
  })) as QaFixture[];

  it('blocks a healthy login that lacks the portal role required by the QA run', async () => {
    const adapters = preflightAdapters();

    await expect(
      preflightFixtures('https://example.test', partnerFixtures, adapters),
    ).rejects.toMatchObject({
      report: {
        verdict: 'block',
        phase: 'role',
        account: 'qa-user',
        expectedRole: 'partner',
        actualRoles: ['customer'],
      },
    });
    expect(adapters.checkAdminAccess).not.toHaveBeenCalled();
  });

  it('blocks when a required customer role is missing from the login response', async () => {
    const adapters = preflightAdapters();
    adapters.authenticate.mockResolvedValueOnce({ status: 200, userId: 'user-1', token: 'token' });
    const customerFixtures = fixtures.map(fixture => ({
      ...fixture,
      expectedPortalRole: 'customer',
    })) as QaFixture[];

    await expect(
      preflightFixtures('https://example.test', customerFixtures, adapters),
    ).rejects.toMatchObject({
      report: {
        verdict: 'block',
        phase: 'role',
        account: 'qa-user',
        expectedRole: 'customer',
        actualRoles: [],
      },
    });
  });

  it('blocks immediately and names a dead fixture login and status', async () => {
    const adapters = preflightAdapters();
    adapters.authenticate.mockResolvedValueOnce({ status: 403 });

    await expect(preflightFixtures('https://example.test', fixtures, adapters)).rejects.toMatchObject({
      report: {
        verdict: 'block',
        phase: 'login',
        account: 'qa-user',
        status: 403,
        expectedStatus: 200,
      },
    });
    expect(adapters.authenticate).toHaveBeenCalledTimes(1);
    expect(adapters.emit).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'block' }));
  });

  it('blocks when a non-admin fixture unexpectedly has admin access', async () => {
    const adapters = preflightAdapters();
    adapters.checkAdminAccess.mockResolvedValueOnce(200);

    await expect(preflightFixtures('https://example.test', fixtures, adapters)).rejects.toMatchObject({
      report: {
        verdict: 'block',
        phase: 'privilege',
        account: 'qa-user',
        status: 200,
        expectedStatus: 403,
      },
    });
    expect(adapters.authenticate).toHaveBeenCalledTimes(1);
  });

  it('passes a healthy non-admin fixture preflight using injected credentials', async () => {
    const adapters = preflightAdapters();

    await expect(preflightFixtures('https://example.test', fixtures, adapters)).resolves.toEqual({
      verdict: 'pass',
      fixtures: [
        { account: 'qa-user', loginStatus: 200, adminStatus: 403 },
        { account: 'qa-tier', loginStatus: 200, adminStatus: 403 },
      ],
    });
    expect(adapters.loadCredentials).toHaveBeenNthCalledWith(1, 'QA_USER');
    expect(adapters.loadCredentials).toHaveBeenNthCalledWith(2, 'QA_TIER');
  });

  it('blocks with a credentials phase naming the account when secret injection is missing', async () => {
    const adapters = preflightAdapters();
    adapters.loadCredentials.mockRejectedValueOnce(new Error('QA_USER_PASSWORD is not set'));

    await expect(preflightFixtures('https://example.test', fixtures, adapters)).rejects.toMatchObject({
      report: {
        verdict: 'block',
        phase: 'credentials',
        account: 'qa-user',
      },
    });
    expect(adapters.authenticate).not.toHaveBeenCalled();
    expect(adapters.emit).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'block',
      phase: 'credentials',
      account: 'qa-user',
    }));
  });
});

describe('temporary admin lifecycle', () => {
  it('uses the conditional grant token for compare-and-set cleanup on normal exit', async () => {
    const { adapters, grant } = adminAdapters();

    await expect(runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters)).resolves.toBe(0);

    expect(adapters.grantConditional).toHaveBeenCalledWith({
      userId: 'user-1',
      expectedCurrentValue: false,
      grantedValue: true,
    });
    expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
  });

  it('does not start the child until the grant is visible on the auth read path', async () => {
    const { adapters, calls, child } = adminAdapters();
    // The base-table write succeeded, but UserIdIndex still serves isAdmin=false
    // for the first two reads — exactly the window that 403s the child today.
    adapters.readGrantVisibility
      .mockImplementationOnce(async () => { calls.push('visibility'); return false; })
      .mockImplementationOnce(async () => { calls.push('visibility'); return false; });

    await expect(runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters)).resolves.toBe(0);

    expect(adapters.readGrantVisibility).toHaveBeenCalledTimes(3);
    expect(adapters.startChild).toHaveBeenCalledTimes(1);
    // The child must appear only after a TRUE visibility read, never between stale ones.
    expect(calls.slice(0, calls.indexOf('startChild'))).toEqual([
      'grant',
      'visibility',
      'wait',
      'visibility',
      'wait',
      'visibility',
    ]);
    expect(child.wait).toHaveBeenCalled();
  });

  it('fails closed without starting the child when the grant never becomes visible', async () => {
    const { adapters, grant, calls } = adminAdapters();
    adapters.readGrantVisibility.mockImplementation(async () => {
      calls.push('visibility');
      return false;
    });

    await expect(
      runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters, { visibilityAttempts: 4 }),
    ).rejects.toMatchObject({
      report: {
        verdict: 'block',
        phase: 'grant-visibility',
        userId: 'user-1',
        attempts: 4,
      },
    });

    expect(adapters.startChild).not.toHaveBeenCalled();
    // The grant must still be handed back even though we never used it.
    expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
    expect(adapters.readGrantVisibility).toHaveBeenCalledTimes(4);
  });

  it('bounds the visibility poll by attempts and never waits after the final read', async () => {
    const { adapters, calls } = adminAdapters();
    adapters.readGrantVisibility.mockImplementation(async () => {
      calls.push('visibility');
      return false;
    });

    await expect(
      runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters, { visibilityAttempts: 3 }),
    ).rejects.toBeInstanceOf(AdminGrantNotVisibleError);

    // 3 reads, 2 waits between them — a trailing sleep would burn time for nothing.
    expect(adapters.waitBeforeRetry).toHaveBeenCalledTimes(2);
    expect(calls[calls.length - 1]).toBe('revoke');
  });

  it('never starts the child when a termination signal lands during the visibility wait', async () => {
    const { adapters, handlers, grant, calls } = adminAdapters();
    let signalled = false;
    // Invisible until the signal lands, then visible — so a run that ignores
    // the abort would sail on and spawn the child against a REVOKED grant.
    adapters.readGrantVisibility.mockImplementation(async () => {
      calls.push('visibility');
      return signalled;
    });

    const run = runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters, {
      visibilityAttempts: 50,
    });
    await flushUntil(() => calls.includes('visibility'));

    signalled = true;
    await handlers.get('SIGTERM')!();
    await expect(run).resolves.toBe(1);

    // The signal handler revoked the grant; spawning afterwards would hand the
    // child a grant that no longer exists.
    expect(adapters.startChild).not.toHaveBeenCalled();
    expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
  });

  it.each(QA_TERMINATION_SIGNALS)(
    'terminates the child and compare-and-set cleans the grant on %s',
    async signal => {
      const { adapters, handlers, child, grant, calls } = adminAdapters();
      const run = runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters);
      // Wait for the child to actually be running rather than guessing at a
      // microtask count — the visibility poll changes how many ticks that takes.
      await flushUntil(() => calls.includes('startChild'));

      const handler = handlers.get(signal);
      expect(handler).toBeDefined();
      await handler!();
      await run;

      expect(child.terminate).toHaveBeenCalledWith(signal);
      expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
    },
  );

  /**
   * Baseline for the race below: a signal arriving AFTER the child handle has
   * resolved. The in-flight window must be indistinguishable from this.
   */
  async function signalAfterChildStarted(
    signal: QaTerminationSignal,
    exitCode: number,
  ): Promise<{ code: number; terminateCalls: unknown[][]; revokeCalls: number }> {
    const { adapters, handlers, child, calls } = adminAdapters(exitCode);
    const run = runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters);
    await flushUntil(() => calls.includes('startChild'));
    await handlers.get(signal)!();
    return {
      code: await run,
      terminateCalls: child.terminate.mock.calls,
      revokeCalls: adapters.revokeIfCurrent.mock.calls.length,
    };
  }

  it.each(QA_TERMINATION_SIGNALS)(
    'terminates the child spawned during the %s in-flight window instead of leaving it running',
    async signal => {
      const exitCode = 7;
      const baseline = await signalAfterChildStarted(signal, exitCode);

      const { adapters, handlers, child, grant, calls } = adminAdapters(exitCode);
      // The process is already spawned but the handle has NOT been returned yet —
      // the exact window in which the signal handler sees `child` as undefined.
      let releaseSpawn!: () => void;
      const spawnInFlight = new Promise<void>(resolve => {
        releaseSpawn = resolve;
      });
      adapters.startChild.mockImplementation(async () => {
        calls.push('startChild');
        await spawnInFlight;
        return child;
      });

      const run = runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters);
      await flushUntil(() => calls.includes('startChild'));

      await handlers.get(signal)!();
      // Nothing exists to kill yet: this is the race, not the bug.
      expect(child.terminate).not.toHaveBeenCalled();

      releaseSpawn();

      // The child must not outlive the signal that revoked its grant — it would
      // 403 on every request from here on.
      await expect(run).resolves.toBe(baseline.code);
      expect(child.terminate.mock.calls).toEqual(baseline.terminateCalls);
      expect(child.terminate).toHaveBeenCalledWith(signal);
      // Exactly one completed compare-and-set revoke, same as every other path.
      expect(adapters.revokeIfCurrent).toHaveBeenCalledTimes(baseline.revokeCalls);
      expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
      expect(calls).toContain('revoke');
    },
  );
});

// ---------------------------------------------------------------------------
// Invokable layer (the gap that closed PR #2239: correct core, no way to run it)
// ---------------------------------------------------------------------------

interface CliHarness {
  stdout: string[];
  stderr: string[];
  io: { stdout(line: string): void; stderr(line: string): void };
}

function cliIo(): CliHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    },
  };
}

function healthyEnv(): NodeJS.ProcessEnv {
  return {
    QA_FIXTURE_BASE_URL: 'https://qa.example.test',
    QA_FIXTURE_PORTAL_ROLE: 'customer',
    QA_USER_EMAIL: 'qa-user@agentweb.pro',
    QA_USER_PASSWORD: 'user-secret-from-env',
    QA_TIER_EMAIL: 'qa-tier@agentweb.pro',
    QA_TIER_PASSWORD: 'tier-secret-from-env',
  };
}

function httpPort(overrides: Partial<{ loginStatus: number; adminStatus: number; roles: string[] }> = {}) {
  return {
    authenticate: jest.fn(async (_baseUrl: string, _credentials: FixtureCredentials): Promise<AuthSession> => (
      {
        status: overrides.loginStatus ?? 200,
        userId: 'user-1',
        token: 'token',
        roles: overrides.roles ?? ['customer'],
      }
    )),
    checkAdminAccess: jest.fn(async (_baseUrl: string, _session: AuthSession) => overrides.adminStatus ?? 403),
  };
}

describe('qa-fixture-harness CLI: preflight', () => {
  it('exits 1 before the admin probe when login succeeds without the requested portal role', async () => {
    const { io, stdout } = cliIo();
    const env = healthyEnv();
    env.QA_FIXTURE_PORTAL_ROLE = 'partner';
    const http = httpPort({ roles: ['customer'] });

    await expect(runCli(['preflight'], env, { http, io })).resolves.toBe(1);

    expect(JSON.parse(stdout[stdout.length - 1])).toMatchObject({
      verdict: 'block',
      phase: 'role',
      account: 'qa-user',
      expectedRole: 'partner',
      actualRoles: ['customer'],
    });
    expect(http.checkAdminAccess).not.toHaveBeenCalled();
  });

  it('exits 1 and emits a blocking JSON report naming the dead account and status, never reaching later fixtures', async () => {
    const { io, stdout } = cliIo();
    const http = httpPort({ loginStatus: 401 });

    await expect(runCli(['preflight'], healthyEnv(), { http, io })).resolves.toBe(1);

    const report = JSON.parse(stdout[stdout.length - 1]);
    expect(report).toMatchObject({
      verdict: 'block',
      phase: 'login',
      account: 'qa-user',
      status: 401,
      expectedStatus: 200,
    });
    expect(http.authenticate).toHaveBeenCalledTimes(1);
    expect(http.checkAdminAccess).not.toHaveBeenCalled();
  });

  it('fails closed on missing credential env vars, naming the account, before any login for that fixture', async () => {
    const { io, stdout } = cliIo();
    const http = httpPort();
    const env = healthyEnv();
    delete env.QA_TIER_PASSWORD;

    await expect(runCli(['preflight'], env, { http, io })).resolves.toBe(1);

    const report = JSON.parse(stdout[stdout.length - 1]);
    expect(report).toMatchObject({
      verdict: 'block',
      phase: 'credentials',
      account: 'qa-tier',
    });
    expect(String(report.detail)).toContain('QA_TIER_PASSWORD');
    expect(http.authenticate).toHaveBeenCalledTimes(1);
  });

  it('exits 0 with a structured pass report when every fixture authenticates at its expected privilege', async () => {
    const { io, stdout } = cliIo();
    const http = httpPort();

    await expect(runCli(['preflight'], healthyEnv(), { http, io })).resolves.toBe(0);

    const report = JSON.parse(stdout[stdout.length - 1]);
    expect(report).toEqual({
      verdict: 'pass',
      fixtures: [
        { account: 'qa-user', loginStatus: 200, adminStatus: 403 },
        { account: 'qa-tier', loginStatus: 200, adminStatus: 403 },
      ],
    });
    expect(http.authenticate).toHaveBeenCalledWith('https://qa.example.test', {
      email: 'qa-user@agentweb.pro',
      password: 'user-secret-from-env',
    });
  });

  it('fails closed with a config block when QA_FIXTURE_BASE_URL is not set', async () => {
    const { io, stdout } = cliIo();
    const env = healthyEnv();
    delete env.QA_FIXTURE_BASE_URL;

    await expect(runCli(['preflight'], env, { http: httpPort(), io })).resolves.toBe(1);

    const report = JSON.parse(stdout[stdout.length - 1]);
    expect(report).toMatchObject({ verdict: 'block', phase: 'config' });
    expect(String(report.detail)).toContain('QA_FIXTURE_BASE_URL');
  });
});

describe('qa-fixture-harness CLI: with-admin', () => {
  function adminEnv(): NodeJS.ProcessEnv {
    return {
      QA_USERS_TABLE: 'Dev-AW-Users',
      QA_ADMIN_FIXTURE_EMAIL: 'eng658-realdomain-check@agentweb.pro',
      QA_ADMIN_FIXTURE_USER_ID: 'user-1',
    };
  }

  it('exits 2 and never attempts a grant when no command follows --', async () => {
    const { io, stderr } = cliIo();
    const { adapters } = adminAdapters();

    await expect(runCli(['with-admin'], adminEnv(), { adminAdapters: adapters, io })).resolves.toBe(2);

    expect(adapters.grantConditional).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('--');
  });

  it('exits 2 and never attempts a grant when required env injection is missing', async () => {
    const { io, stderr } = cliIo();
    const { adapters } = adminAdapters();
    const env = adminEnv();
    delete env.QA_ADMIN_FIXTURE_USER_ID;

    await expect(
      runCli(['with-admin', '--', 'node', 'qa.js'], env, { adminAdapters: adapters, io }),
    ).resolves.toBe(2);

    expect(adapters.grantConditional).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('QA_ADMIN_FIXTURE_USER_ID');
  });

  it('propagates the child exit code and compare-and-set revokes the grant', async () => {
    const { io } = cliIo();
    const { adapters, grant } = adminAdapters(7);

    await expect(
      runCli(['with-admin', '--', 'node', 'qa.js'], adminEnv(), { adminAdapters: adapters, io }),
    ).resolves.toBe(7);

    expect(adapters.grantConditional).toHaveBeenCalledWith({
      userId: 'user-1',
      expectedCurrentValue: false,
      grantedValue: true,
    });
    expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
    expect(adapters.startChild).toHaveBeenCalledWith(['node', 'qa.js']);
  });

  it('exits nonzero when compare-and-set cleanup cannot restore the exact granted value', async () => {
    const { io, stderr } = cliIo();
    const { adapters } = adminAdapters();
    adapters.revokeIfCurrent.mockResolvedValue(false);

    await expect(
      runCli(['with-admin', '--', 'node', 'qa.js'], adminEnv(), { adminAdapters: adapters, io }),
    ).resolves.toBe(1);

    expect(stderr.join('\n')).toContain('user-1');
  });

  it('exits 1 with a structured grant-visibility block, no child, and a completed revoke', async () => {
    const { io, stdout } = cliIo();
    const { adapters, grant } = adminAdapters();
    adapters.readGrantVisibility.mockResolvedValue(false);

    await expect(
      runCli(['with-admin', '--', 'node', 'qa.js'], adminEnv(), { adminAdapters: adapters, io }),
    ).resolves.toBe(1);

    expect(JSON.parse(stdout[stdout.length - 1])).toMatchObject({
      verdict: 'block',
      phase: 'grant-visibility',
      userId: 'user-1',
    });
    expect(adapters.startChild).not.toHaveBeenCalled();
    expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
  });

  it('exits 2 with usage on an unknown subcommand', async () => {
    const { io, stderr } = cliIo();

    await expect(runCli(['frobnicate'], {}, { io })).resolves.toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

describe('env credentials loader', () => {
  it('loads email and password from the secretRef-prefixed env vars', async () => {
    const load = createEnvCredentialsLoader(healthyEnv());

    await expect(load('QA_TIER')).resolves.toEqual({
      email: 'qa-tier@agentweb.pro',
      password: 'tier-secret-from-env',
    });
  });

  it('throws naming the exact missing env var instead of returning partial credentials', async () => {
    const env = healthyEnv();
    delete env.QA_USER_EMAIL;
    const load = createEnvCredentialsLoader(env);

    await expect(load('QA_USER')).rejects.toThrow('QA_USER_EMAIL');
  });
});

describe('HTTP fixture adapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves portal roles and admin state from the login response', async () => {
    jest.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        token: 'token',
        user: {
          userId: 'user-1',
          roles: ['customer'],
          isAdmin: false,
        },
      },
    } as never);
    const http = createAxiosHttpPort();

    await expect(http.authenticate('https://qa.example.test', {
      email: 'qa-user@agentweb.pro',
      password: 'injected-secret',
    })).resolves.toEqual({
      status: 200,
      token: 'token',
      userId: 'user-1',
      roles: ['customer'],
      isAdmin: false,
    });
  });
});

describe('DynamoDB compare-and-set adapters', () => {
  const target = {
    tableName: 'Dev-AW-Users',
    email: 'eng658-realdomain-check@agentweb.pro',
    userId: 'user-1',
    runId: 'run-abc',
  };

  type UpdateParams = Parameters<DynamoUpdatePort['update']>[0];
  type QueryParams = Parameters<DynamoUpdatePort['query']>[0];

  function fakeDocClient(
    impl: (params: UpdateParams) => Promise<unknown>,
    queryImpl: (params: QueryParams) => Promise<{ Items?: Array<Record<string, unknown>> }> =
      async () => ({ Items: [] }),
  ) {
    const update = jest.fn((params: UpdateParams) => ({ promise: () => impl(params) }));
    const query = jest.fn((params: QueryParams) => ({ promise: () => queryImpl(params) }));
    return { update, query };
  }

  it('grants with a userId-pinned conditional update keyed on the fixture email', async () => {
    const docClient = fakeDocClient(async () => ({}));
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    const grant = await adapters.grantConditional({
      userId: 'user-1',
      expectedCurrentValue: false,
      grantedValue: true,
    });

    expect(grant).toMatchObject({ userId: 'user-1', previousValue: false, version: 'run-abc' });
    const params = docClient.update.mock.calls[0][0];
    expect(params.TableName).toBe('Dev-AW-Users');
    expect(params.Key).toEqual({ email: 'eng658-realdomain-check@agentweb.pro' });
    expect(String(params.ConditionExpression)).toContain('userId');
  });

  it('revokeIfCurrent returns false when the conditional check fails (row changed by someone else)', async () => {
    const conditionalError = Object.assign(new Error('conditional failed'), {
      code: 'ConditionalCheckFailedException',
    });
    const docClient = fakeDocClient(async () => { throw conditionalError; });
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    await expect(
      adapters.revokeIfCurrent({
        userId: 'user-1',
        previousValue: false,
        expectedGrantedValue: true,
        version: 'run-abc',
      }),
    ).resolves.toBe(false);
  });

  it('revokeIfCurrent rethrows non-conditional errors loudly', async () => {
    const docClient = fakeDocClient(async () => {
      throw Object.assign(new Error('throughput exceeded'), { code: 'ProvisionedThroughputExceededException' });
    });
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    await expect(
      adapters.revokeIfCurrent({
        userId: 'user-1',
        previousValue: false,
        expectedGrantedValue: true,
        version: 'run-abc',
      }),
    ).rejects.toThrow('throughput exceeded');
  });

  it('reads visibility through UserIdIndex, mirroring the auth path getUserById uses', async () => {
    const queried: QueryParams[] = [];
    const docClient = fakeDocClient(async () => ({}), async params => {
      queried.push(params);
      return { Items: [{ userId: 'user-1', isAdmin: true }] };
    });
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    await expect(
      adapters.readGrantVisibility({
        userId: 'user-1',
        previousValue: false,
        expectedGrantedValue: true,
        version: 'run-abc',
      }),
    ).resolves.toBe(true);

    expect(queried[0].TableName).toBe('Dev-AW-Users');
    expect(queried[0].IndexName).toBe('UserIdIndex');
    expect(String(queried[0].KeyConditionExpression)).toContain('userId');
    expect(queried[0].ExpressionAttributeValues).toMatchObject({ ':userId': 'user-1' });
  });

  it('reports the grant as not yet visible when the index still serves the old isAdmin', async () => {
    const docClient = fakeDocClient(
      async () => ({}),
      async () => ({ Items: [{ userId: 'user-1', isAdmin: false }] }),
    );
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    await expect(
      adapters.readGrantVisibility({
        userId: 'user-1',
        previousValue: false,
        expectedGrantedValue: true,
        version: 'run-abc',
      }),
    ).resolves.toBe(false);
  });

  it('treats a missing row on the index as not visible rather than assuming the grant landed', async () => {
    const docClient = fakeDocClient(async () => ({}), async () => ({ Items: [] }));
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    await expect(
      adapters.readGrantVisibility({
        userId: 'user-1',
        previousValue: false,
        expectedGrantedValue: true,
        version: 'run-abc',
      }),
    ).resolves.toBe(false);
  });

  it('revoke pins the exact row and run: email key, userId + granted value + run id condition', async () => {
    const docClient = fakeDocClient(async () => ({}));
    const adapters = createDynamoTemporaryAdminAdapters(target, docClient);

    await expect(
      adapters.revokeIfCurrent({
        userId: 'user-1',
        previousValue: false,
        expectedGrantedValue: true,
        version: 'run-abc',
      }),
    ).resolves.toBe(true);

    const params = docClient.update.mock.calls[0][0];
    expect(params.Key).toEqual({ email: 'eng658-realdomain-check@agentweb.pro' });
    expect(String(params.ConditionExpression)).toContain('qaAdminGrantRunId');
    expect(params.ExpressionAttributeValues).toMatchObject({
      ':uid': 'user-1',
      ':runId': 'run-abc',
      ':previous': false,
    });
  });
});

describe('process child adapters', () => {
  it('startChild reports the real child exit code', async () => {
    const { startChild } = createProcessChildAdapters();

    const child = await startChild([process.execPath, '-e', 'process.exit(7)']);

    await expect(child.wait()).resolves.toBe(7);
  });

  it('terminate kills a long-running child and wait still resolves', async () => {
    const { startChild } = createProcessChildAdapters();

    const child = await startChild([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
    child.terminate('SIGTERM');

    await expect(child.wait()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('onSignal registers a process listener and the disposer removes it', () => {
    const { onSignal } = createProcessChildAdapters();
    const before = process.listenerCount('SIGHUP');

    const dispose = onSignal('SIGHUP', async () => undefined);
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);

    dispose();
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});
