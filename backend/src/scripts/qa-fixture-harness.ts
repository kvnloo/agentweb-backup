export const QA_TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export type QaTerminationSignal = (typeof QA_TERMINATION_SIGNALS)[number];

export interface QaFixture {
  account: string;
  secretRef: string;
  expectedLoginStatus: number;
  expectedAdminStatus: number;
}

export interface FixtureCredentials {
  email: string;
  password: string;
}

export interface AuthSession {
  status: number;
  userId?: string;
  token?: string;
}

export interface FixturePreflightReport {
  verdict: 'pass' | 'block';
  phase?: 'login' | 'privilege';
  account?: string;
  status?: number;
  expectedStatus?: number;
  fixtures?: Array<{ account: string; loginStatus: number; adminStatus: number }>;
}

export interface QaFixturePreflightAdapters {
  loadCredentials(secretRef: string): Promise<FixtureCredentials>;
  authenticate(baseUrl: string, credentials: FixtureCredentials): Promise<AuthSession>;
  checkAdminAccess(baseUrl: string, session: AuthSession): Promise<number>;
  emit(report: FixturePreflightReport): void;
}

export interface AdminGrantToken {
  userId: string;
  expectedGrantedValue: boolean;
  previousValue: boolean;
  version: string;
}

export interface AdminGrantRequest {
  userId: string;
  expectedCurrentValue: false;
  grantedValue: true;
}

export interface ChildProcessHandle {
  wait(): Promise<number>;
  terminate(signal: QaTerminationSignal): void;
}

export interface TemporaryAdminAdapters {
  grantConditional(request: AdminGrantRequest): Promise<AdminGrantToken>;
  revokeIfCurrent(grant: AdminGrantToken): Promise<boolean>;
  startChild(command: string[]): Promise<ChildProcessHandle>;
  onSignal(
    signal: QaTerminationSignal,
    handler: () => Promise<void>,
  ): () => void;
}

export class QaFixturePreflightError extends Error {
  constructor(public readonly report: FixturePreflightReport) {
    super(JSON.stringify(report));
    this.name = 'QaFixturePreflightError';
  }
}

export class TemporaryAdminCleanupError extends Error {
  constructor(userId: string) {
    super(`Temporary admin compare-and-set cleanup failed for user ${userId}`);
    this.name = 'TemporaryAdminCleanupError';
  }
}

function blockPreflight(
  adapters: QaFixturePreflightAdapters,
  report: FixturePreflightReport,
): never {
  adapters.emit(report);
  throw new QaFixturePreflightError(report);
}

export async function preflightFixtures(
  baseUrl: string,
  fixtures: QaFixture[],
  adapters: QaFixturePreflightAdapters,
): Promise<FixturePreflightReport> {
  const results: NonNullable<FixturePreflightReport['fixtures']> = [];
  for (const fixture of fixtures) {
    const credentials = await adapters.loadCredentials(fixture.secretRef);
    const session = await adapters.authenticate(baseUrl, credentials);
    if (session.status !== fixture.expectedLoginStatus) {
      blockPreflight(adapters, {
        verdict: 'block',
        phase: 'login',
        account: fixture.account,
        status: session.status,
        expectedStatus: fixture.expectedLoginStatus,
      });
    }

    const adminStatus = await adapters.checkAdminAccess(baseUrl, session);
    if (adminStatus !== fixture.expectedAdminStatus) {
      blockPreflight(adapters, {
        verdict: 'block',
        phase: 'privilege',
        account: fixture.account,
        status: adminStatus,
        expectedStatus: fixture.expectedAdminStatus,
      });
    }

    results.push({
      account: fixture.account,
      loginStatus: session.status,
      adminStatus,
    });
  }
  const report: FixturePreflightReport = { verdict: 'pass', fixtures: results };
  adapters.emit(report);
  return report;
}

export async function runWithTemporaryAdmin(
  userId: string,
  command: string[],
  adapters: TemporaryAdminAdapters,
): Promise<number> {
  if (command.length === 0) {
    throw new Error('with-admin requires a command after --');
  }

  const grant = await adapters.grantConditional({
    userId,
    expectedCurrentValue: false,
    grantedValue: true,
  });
  let child: ChildProcessHandle | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const unsubscribe: Array<() => void> = [];
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= adapters.revokeIfCurrent(grant).then(revoked => {
      if (!revoked) {
        throw new TemporaryAdminCleanupError(grant.userId);
      }
    });
    return cleanupPromise;
  };

  try {
    for (const signal of QA_TERMINATION_SIGNALS) {
      unsubscribe.push(adapters.onSignal(signal, async () => {
        child?.terminate(signal);
        await cleanup();
      }));
    }

    child = await adapters.startChild(command);
    return await child.wait();
  } finally {
    for (const removeListener of unsubscribe) {
      removeListener();
    }
    await cleanup();
  }
}
