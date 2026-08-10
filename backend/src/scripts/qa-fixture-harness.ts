/**
 * QA fixture harness (ENG-739) — fail-closed fixture preflight + temporary admin grant.
 *
 * Why this exists: on 2026-07-29 every documented QA fixture account was dead
 * (401 / 403-deactivated / 404) and QA runs still reported passes. This harness
 * makes fixture health a BLOCKING precondition and removes the need for a
 * standing prod admin account.
 *
 * Pure core (preflightFixtures / runWithTemporaryAdmin and their types) salvaged
 * from closed PR #2239; that PR was closed because the core was unreachable —
 * interface-only adapters, no CLI. This file adds the invokable layer:
 *
 *   npx ts-node src/scripts/qa-fixture-harness.ts preflight
 *   npx ts-node src/scripts/qa-fixture-harness.ts with-admin -- <command...>
 *
 * Configuration is environment/secret injection ONLY (no hardcoded secrets):
 *   preflight:  QA_FIXTURE_BASE_URL, QA_USER_EMAIL, QA_USER_PASSWORD,
 *               QA_TIER_EMAIL, QA_TIER_PASSWORD
 *   with-admin: QA_USERS_TABLE, QA_ADMIN_FIXTURE_EMAIL, QA_ADMIN_FIXTURE_USER_ID
 *               (+ standard AWS credential/region chain)
 *
 * Exit codes: 0 pass · 1 blocking verdict or runtime failure (fail closed) ·
 * 2 usage/config error. Structured JSON verdicts go to stdout.
 *
 * Deliberately standalone: no product-runtime imports (AC4 — QA-harness scope only).
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import AWS from 'aws-sdk';
import axios from 'axios';

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
  phase?: 'config' | 'credentials' | 'login' | 'privilege';
  account?: string;
  status?: number;
  expectedStatus?: number;
  detail?: string;
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
    let credentials: FixtureCredentials;
    try {
      credentials = await adapters.loadCredentials(fixture.secretRef);
    } catch (error) {
      blockPreflight(adapters, {
        verdict: 'block',
        phase: 'credentials',
        account: fixture.account,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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

// ---------------------------------------------------------------------------
// Invokable layer — the gap that closed PR #2239 (correct core, no way to run it)
// ---------------------------------------------------------------------------

/**
 * The canonical fixture matrix (rules/loop-back-testing.md, re-provisioned
 * 2026-07-29). `secretRef` is the env-var prefix the credentials are injected
 * under: QA_USER_EMAIL / QA_USER_PASSWORD, QA_TIER_EMAIL / QA_TIER_PASSWORD.
 * Both are non-admin: login must be 200 and an admin route must return 403.
 */
export const DEFAULT_FIXTURES: QaFixture[] = [
  { account: 'qa-user', secretRef: 'QA_USER', expectedLoginStatus: 200, expectedAdminStatus: 403 },
  { account: 'qa-tier', secretRef: 'QA_TIER', expectedLoginStatus: 200, expectedAdminStatus: 403 },
];

/** Loads fixture credentials from `<secretRef>_EMAIL` / `<secretRef>_PASSWORD`, failing closed. */
export function createEnvCredentialsLoader(
  env: NodeJS.ProcessEnv,
): (secretRef: string) => Promise<FixtureCredentials> {
  return async secretRef => {
    const emailVar = `${secretRef}_EMAIL`;
    const passwordVar = `${secretRef}_PASSWORD`;
    const email = env[emailVar];
    const password = env[passwordVar];
    if (!email) {
      throw new Error(`${emailVar} is not set — refusing to run with partial fixture credentials`);
    }
    if (!password) {
      throw new Error(`${passwordVar} is not set — refusing to run with partial fixture credentials`);
    }
    return { email, password };
  };
}

/** The two HTTP probes preflight needs; injectable so tests never touch the network. */
export interface HttpAuthPort {
  authenticate(baseUrl: string, credentials: FixtureCredentials): Promise<AuthSession>;
  checkAdminAccess(baseUrl: string, session: AuthSession): Promise<number>;
}

/**
 * Real HTTP port against the backend's public surface: POST /api/auth/login
 * (returns `{ token, user }`) and GET /api/admin/users as the privilege probe
 * (non-admin must get 403). Raw statuses are returned, never thrown.
 */
export function createAxiosHttpPort(timeoutMs = 15_000): HttpAuthPort {
  return {
    async authenticate(baseUrl, credentials) {
      const response = await axios.post(
        `${baseUrl}/api/auth/login`,
        { email: credentials.email, password: credentials.password },
        { timeout: timeoutMs, validateStatus: () => true },
      );
      const body = response.data as { token?: string; user?: { userId?: string } } | undefined;
      return { status: response.status, token: body?.token, userId: body?.user?.userId };
    },
    async checkAdminAccess(baseUrl, session) {
      const response = await axios.get(`${baseUrl}/api/admin/users`, {
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: session.token ? { Authorization: `Bearer ${session.token}` } : {},
      });
      return response.status;
    },
  };
}

/** Identifies the exact row a temporary admin grant may touch. */
export interface TemporaryAdminTarget {
  tableName: string;
  /** AW-Users HASH key. */
  email: string;
  /** Pinned in every ConditionExpression so an email reassignment can never flip the wrong row. */
  userId: string;
  /** Unique per run; revoke only removes what THIS run granted. */
  runId: string;
}

/** Structural slice of DocumentClient so tests can inject a fake without aws-sdk machinery. */
export interface DynamoUpdatePort {
  update(params: AWS.DynamoDB.DocumentClient.UpdateItemInput): { promise(): Promise<unknown> };
}

/**
 * Compare-and-set grant/revoke on the users table. Grant requires the row to be
 * non-admin and stamps this run's id; revoke restores ONLY the exact value this
 * run granted (isAdmin true + matching run id) and reports `false` — never a
 * silent success — when the row changed under it.
 */
export function createDynamoTemporaryAdminAdapters(
  target: TemporaryAdminTarget,
  docClient: DynamoUpdatePort = new AWS.DynamoDB.DocumentClient(),
): Pick<TemporaryAdminAdapters, 'grantConditional' | 'revokeIfCurrent'> {
  return {
    async grantConditional(request) {
      await docClient
        .update({
          TableName: target.tableName,
          Key: { email: target.email },
          UpdateExpression: 'SET isAdmin = :granted, qaAdminGrantRunId = :runId',
          ConditionExpression:
            'userId = :uid AND (attribute_not_exists(isAdmin) OR isAdmin = :previous)',
          ExpressionAttributeValues: {
            ':granted': request.grantedValue,
            ':previous': request.expectedCurrentValue,
            ':uid': target.userId,
            ':runId': target.runId,
          },
        })
        .promise();
      return {
        userId: request.userId,
        previousValue: request.expectedCurrentValue,
        expectedGrantedValue: request.grantedValue,
        version: target.runId,
      };
    },
    async revokeIfCurrent(grant) {
      try {
        await docClient
          .update({
            TableName: target.tableName,
            Key: { email: target.email },
            UpdateExpression: 'SET isAdmin = :previous REMOVE qaAdminGrantRunId',
            ConditionExpression:
              'userId = :uid AND isAdmin = :granted AND qaAdminGrantRunId = :runId',
            ExpressionAttributeValues: {
              ':previous': grant.previousValue,
              ':granted': grant.expectedGrantedValue,
              ':uid': grant.userId,
              ':runId': grant.version,
            },
          })
          .promise();
        return true;
      } catch (error) {
        if ((error as { code?: string })?.code === 'ConditionalCheckFailedException') {
          return false;
        }
        throw error;
      }
    },
  };
}

/** Real child-process + process-signal adapters for `with-admin`. */
export function createProcessChildAdapters(): Pick<TemporaryAdminAdapters, 'startChild' | 'onSignal'> {
  return {
    async startChild(command) {
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
      const exit = new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      return {
        wait: () => exit,
        terminate: signal => {
          child.kill(signal);
        },
      };
    },
    onSignal(signal, handler) {
      const wrapped = (): void => {
        void handler().catch(error => {
          process.stderr.write(`${signal} cleanup failed: ${String(error)}\n`);
          process.exitCode = 1;
        });
      };
      process.on(signal, wrapped);
      return () => {
        process.removeListener(signal, wrapped);
      };
    },
  };
}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliOverrides {
  http?: HttpAuthPort;
  adminAdapters?: TemporaryAdminAdapters;
  io?: CliIo;
}

const USAGE =
  'usage: qa-fixture-harness <preflight | with-admin -- <command...>>\n' +
  '  preflight   verify every QA fixture logs in at its expected privilege (blocking)\n' +
  '  with-admin  run a command under a temporary compare-and-set admin grant';

function requireEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  io: CliIo,
): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (!value) {
      io.stderr(`${name} is not set — refusing to run (credentials/config come from env injection only)`);
      return undefined;
    }
    values[name] = value;
  }
  return values;
}

async function runPreflightCommand(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  overrides: CliOverrides,
): Promise<number> {
  const emit = (report: FixturePreflightReport): void => io.stdout(JSON.stringify(report));
  const baseUrl = env.QA_FIXTURE_BASE_URL;
  if (!baseUrl) {
    emit({
      verdict: 'block',
      phase: 'config',
      detail: 'QA_FIXTURE_BASE_URL is not set — preflight has no target domain',
    });
    return 1;
  }
  const http = overrides.http ?? createAxiosHttpPort();
  const adapters: QaFixturePreflightAdapters = {
    loadCredentials: createEnvCredentialsLoader(env),
    authenticate: (url, credentials) => http.authenticate(url, credentials),
    checkAdminAccess: (url, session) => http.checkAdminAccess(url, session),
    emit,
  };
  try {
    await preflightFixtures(baseUrl, DEFAULT_FIXTURES, adapters);
    return 0;
  } catch (error) {
    if (!(error instanceof QaFixturePreflightError)) {
      // Fail closed: an unexpected failure (network down, DNS, bug) is a block,
      // never a silent skip.
      emit({
        verdict: 'block',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return 1;
  }
}

async function runWithAdminCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  overrides: CliOverrides,
): Promise<number> {
  const separator = argv.indexOf('--');
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  if (command.length === 0) {
    io.stderr('with-admin requires a command after --');
    io.stderr(USAGE);
    return 2;
  }
  const required = requireEnv(
    env,
    ['QA_USERS_TABLE', 'QA_ADMIN_FIXTURE_EMAIL', 'QA_ADMIN_FIXTURE_USER_ID'],
    io,
  );
  if (!required) {
    return 2;
  }
  const adapters: TemporaryAdminAdapters =
    overrides.adminAdapters ??
    {
      ...createDynamoTemporaryAdminAdapters({
        tableName: required.QA_USERS_TABLE,
        email: required.QA_ADMIN_FIXTURE_EMAIL,
        userId: required.QA_ADMIN_FIXTURE_USER_ID,
        runId: randomUUID(),
      }),
      ...createProcessChildAdapters(),
    };
  try {
    return await runWithTemporaryAdmin(required.QA_ADMIN_FIXTURE_USER_ID, command, adapters);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** CLI entrypoint. Exit codes: 0 pass · 1 blocking/runtime failure · 2 usage/config error. */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  overrides: CliOverrides = {},
): Promise<number> {
  const io: CliIo = overrides.io ?? {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  };
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case 'preflight':
      return runPreflightCommand(env, io, overrides);
    case 'with-admin':
      return runWithAdminCommand(rest, env, io, overrides);
    default:
      io.stderr(USAGE);
      return 2;
  }
}

/* istanbul ignore next -- process entrypoint; all branches exercised through runCli tests */
if (require.main === module) {
  runCli(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
