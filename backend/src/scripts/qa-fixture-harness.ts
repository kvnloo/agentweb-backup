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
 *   preflight:  QA_FIXTURE_BASE_URL, QA_FIXTURE_PORTAL_ROLE,
 *               QA_USER_EMAIL, QA_USER_PASSWORD,
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
  /** Portal this fixture must actually be able to enter for the current QA run. */
  expectedPortalRole?: QaPortalRole;
}

export type QaPortalRole = 'partner' | 'customer' | 'contractor';

export interface FixtureCredentials {
  email: string;
  password: string;
}

export interface AuthSession {
  status: number;
  userId?: string;
  token?: string;
  roles?: string[];
  isAdmin?: boolean;
}

export interface FixturePreflightReport {
  verdict: 'pass' | 'block';
  phase?: 'config' | 'credentials' | 'login' | 'role' | 'privilege';
  account?: string;
  status?: number;
  expectedStatus?: number;
  expectedRole?: QaPortalRole;
  actualRoles?: string[];
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

/** Emitted when a grant never becomes visible on the auth read path. */
export interface GrantVisibilityReport {
  verdict: 'block';
  phase: 'grant-visibility';
  userId: string;
  attempts: number;
  detail: string;
}

export interface TemporaryAdminAdapters {
  grantConditional(request: AdminGrantRequest): Promise<AdminGrantToken>;
  /**
   * Reads `isAdmin` back through the SAME eventually-consistent path the
   * product's auth middleware uses — `getUserById`, i.e. a `UserIdIndex` query
   * — and NOT the base table. A strongly-consistent base-table read would
   * always report the grant we just wrote and prove nothing about what the
   * child's first authenticated request will actually see.
   */
  readGrantVisibility(grant: AdminGrantToken): Promise<boolean>;
  /** Delay between visibility attempts. Injected so tests never sleep for real. */
  waitBeforeRetry(attempt: number): Promise<void>;
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

/**
 * The grant succeeded on the base table but never surfaced on the read path
 * auth uses. Fail closed: the child would 403 on its first protected request.
 */
export class AdminGrantNotVisibleError extends Error {
  constructor(public readonly report: GrantVisibilityReport) {
    super(JSON.stringify(report));
    this.name = 'AdminGrantNotVisibleError';
  }
}

/** Bounded by attempt count, never wall-clock, so the poll is deterministic in tests. */
export const DEFAULT_GRANT_VISIBILITY_ATTEMPTS = 10;

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

    if (fixture.expectedPortalRole) {
      const actualRoles = session.roles ?? [];
      // Match the product's legacy-role fallback exactly; admins may enter any portal.
      const effectiveRoles = actualRoles.length > 0 ? actualRoles : ['partner'];
      const hasPortalAccess =
        session.isAdmin === true || effectiveRoles.includes(fixture.expectedPortalRole);
      if (!hasPortalAccess) {
        blockPreflight(adapters, {
          verdict: 'block',
          phase: 'role',
          account: fixture.account,
          expectedRole: fixture.expectedPortalRole,
          actualRoles,
        });
      }
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

export interface TemporaryAdminOptions {
  /** Max visibility reads before failing closed. Defaults to DEFAULT_GRANT_VISIBILITY_ATTEMPTS. */
  visibilityAttempts?: number;
}

/**
 * Blocks until the grant is readable on the auth path, or fails closed.
 *
 * Bounded by attempt count rather than wall-clock so the poll is deterministic
 * under an injected clock. No wait follows the final read — a trailing sleep
 * would delay the block without ever changing its outcome.
 */
async function awaitGrantVisible(
  grant: AdminGrantToken,
  adapters: TemporaryAdminAdapters,
  attempts: number,
  isAborted: () => boolean,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A termination signal during the poll has already revoked the grant.
    // Continuing would hand the child a grant that no longer exists.
    if (isAborted()) {
      return false;
    }
    if (await adapters.readGrantVisibility(grant)) {
      return true;
    }
    if (attempt < attempts) {
      await adapters.waitBeforeRetry(attempt);
    }
  }
  throw new AdminGrantNotVisibleError({
    verdict: 'block',
    phase: 'grant-visibility',
    userId: grant.userId,
    attempts,
    detail:
      `Admin grant for ${grant.userId} was written but never became visible on the ` +
      `UserIdIndex read path after ${attempts} attempts — refusing to start the child, ` +
      'which would 403 on its first protected request.',
  });
}

export async function runWithTemporaryAdmin(
  userId: string,
  command: string[],
  adapters: TemporaryAdminAdapters,
  options: TemporaryAdminOptions = {},
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
  /** Set by the signal handler; doubles as the abort flag and the signal to kill with. */
  let abortedWith: QaTerminationSignal | undefined;
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
        abortedWith = signal;
        // `child` is undefined while startChild is in flight; the post-spawn
        // check below is what covers that window.
        child?.terminate(signal);
        await cleanup();
      }));
    }

    // The base-table write returning success does NOT mean auth can see it:
    // authenticateToken -> getUserById queries the eventually consistent
    // UserIdIndex GSI. Starting the child before that read flips is the race
    // that 403s the run despite a successful grant.
    const visible = await awaitGrantVisible(
      grant,
      adapters,
      options.visibilityAttempts ?? DEFAULT_GRANT_VISIBILITY_ATTEMPTS,
      () => abortedWith !== undefined,
    );
    if (!visible || abortedWith) {
      // Terminated while waiting; the grant is already revoked. Never start the
      // child against a grant that no longer exists.
      return 1;
    }

    child = await adapters.startChild(command);
    if (abortedWith) {
      // The signal landed while the spawn was in flight: the process exists but
      // the handler saw `child` as undefined and could only revoke the grant.
      // Kill it the moment the handle resolves — assignment and this check share
      // a tick, so no signal can slip between them — otherwise the command
      // outlives its own termination signal and 403s on every request after.
      child.terminate(abortedWith);
    }
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
      const body = response.data as {
        token?: string;
        user?: { userId?: string; roles?: string[]; isAdmin?: boolean };
      } | undefined;
      return {
        status: response.status,
        token: body?.token,
        userId: body?.user?.userId,
        roles: body?.user?.roles,
        isAdmin: body?.user?.isAdmin,
      };
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
  query(params: AWS.DynamoDB.DocumentClient.QueryInput): {
    promise(): Promise<{ Items?: Array<Record<string, unknown>> }>;
  };
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
): Pick<TemporaryAdminAdapters, 'grantConditional' | 'revokeIfCurrent' | 'readGrantVisibility'> {
  return {
    /**
     * Mirrors `userDb.getUserById` exactly — same table, same `UserIdIndex`
     * query, no ConsistentRead. Reading the base table instead would always
     * report the grant we just wrote and prove nothing about what the child
     * sees. A missing row means not-yet-visible, never "assume it landed".
     */
    async readGrantVisibility(grant) {
      const result = await docClient
        .query({
          TableName: target.tableName,
          IndexName: 'UserIdIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': grant.userId },
        })
        .promise();
      return result.Items?.[0]?.isAdmin === grant.expectedGrantedValue;
    },
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
export function createProcessChildAdapters(
  baseDelayMs = 250,
): Pick<TemporaryAdminAdapters, 'startChild' | 'onSignal' | 'waitBeforeRetry'> {
  return {
    /** Linear backoff between GSI visibility reads. Only the real CLI ever sleeps. */
    async waitBeforeRetry(attempt) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, baseDelayMs * attempt);
      });
    },
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
  const portalRole = env.QA_FIXTURE_PORTAL_ROLE;
  if (portalRole !== 'partner' && portalRole !== 'customer' && portalRole !== 'contractor') {
    emit({
      verdict: 'block',
      phase: 'config',
      detail: 'QA_FIXTURE_PORTAL_ROLE must be partner, customer, or contractor',
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
    const fixtures = DEFAULT_FIXTURES.map(fixture => ({
      ...fixture,
      expectedPortalRole: portalRole as QaPortalRole,
    }));
    await preflightFixtures(baseUrl, fixtures, adapters);
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
    if (error instanceof AdminGrantNotVisibleError) {
      // Structured verdict on stdout like every other block, so a caller
      // parsing our output sees WHICH step refused to proceed.
      io.stdout(JSON.stringify(error.report));
      io.stderr(error.report.detail);
      return 1;
    }
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
