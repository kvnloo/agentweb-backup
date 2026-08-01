import {
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
  preflightFixtures,
  runWithTemporaryAdmin,
} from '../scripts/qa-fixture-harness';

const fixtures: QaFixture[] = [
  {
    account: 'qa-user',
    secretRef: 'qa/user',
    expectedLoginStatus: 200,
    expectedAdminStatus: 403,
  },
  {
    account: 'qa-tier',
    secretRef: 'qa/tier',
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
      { status: 200, userId: 'user-1', token: 'token' }
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
} {
  const handlers = new Map<QaTerminationSignal, () => Promise<void>>();
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
    adapters: {
      grantConditional: jest.fn(async (_request: AdminGrantRequest) => grant),
      revokeIfCurrent: jest.fn(async (_grant: AdminGrantToken) => true),
      startChild: jest.fn(async (_command: string[]) => child),
      onSignal: jest.fn((signal, handler) => {
        handlers.set(signal, handler);
        return () => handlers.delete(signal);
      }),
    },
  };
}

describe('QA fixture preflight', () => {
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
    expect(adapters.loadCredentials).toHaveBeenNthCalledWith(1, 'qa/user');
    expect(adapters.loadCredentials).toHaveBeenNthCalledWith(2, 'qa/tier');
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

  it.each(QA_TERMINATION_SIGNALS)(
    'terminates the child and compare-and-set cleans the grant on %s',
    async signal => {
      const { adapters, handlers, child, grant } = adminAdapters();
      const run = runWithTemporaryAdmin('user-1', ['node', 'qa.js'], adapters);
      await Promise.resolve();
      await Promise.resolve();

      const handler = handlers.get(signal);
      expect(handler).toBeDefined();
      await handler!();
      await run;

      expect(child.terminate).toHaveBeenCalledWith(signal);
      expect(adapters.revokeIfCurrent).toHaveBeenCalledWith(grant);
    },
  );
});
