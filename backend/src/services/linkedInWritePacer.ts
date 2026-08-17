/**
 * Pace LinkedIn write actions per account (ENG-1197).
 *
 * Why this exists, from the evidence rather than from principle:
 *
 *   2026-07-12  17:00:50Z  10x cancel-invitation, one parallel tool-call batch
 *               17:00:59Z  4 more
 *               17:01:07Z  "The LinkedIn account is disconnected from Unipile"
 *   2026-07-18  17:00:55Z  10x cancel-invitation, one parallel tool-call batch
 *               17:01:08Z  1 more
 *               17:01:15Z  "The LinkedIn account is disconnected from Unipile"
 *
 * Both times the same schedule, draining its stale-invite backlog. Both times
 * roughly a dozen writes inside twenty seconds, then a revoked session — an outage
 * that then blocked the customer for days, because only they can re-authenticate.
 * The account had no rate problem; we were the rate problem.
 *
 * There is already a cooldown breaker for send-invite (ENG-126), but it arms only
 * after LinkedIn rejects a send, and cancel-invitation had nothing at all. So the
 * withdraw path — the one the drain hammers — was completely unpaced.
 *
 * This cannot live in the prompt. The model emits ten parallel tool calls because
 * that is the efficient shape of the work, and an unattended scheduled run has no
 * one to notice it ignoring an instruction not to. It has to be structural.
 *
 * Scope, stated honestly: the gate is per-process. Two instances pace independently,
 * so a user driving writes through both simultaneously could still double the rate.
 * That is not the observed failure — a single agent session runs on one instance,
 * and the bursts come from one session's parallel tool calls — so a distributed
 * lease would be cost without a matching risk. Revisit if writes ever fan out
 * across instances.
 */

const TAG = '[linkedInWritePacer]';

/** LinkedIn actions that mutate state on the platform and therefore need pacing. */
export const PACED_WRITE_ACTIONS = new Set([
  'send-invite',
  'send-message',
  'send-inmail',
  'cancel-invitation',
  'accept-invitation',
]);

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Pacing is off by default under Jest.
 *
 * These are real wall-clock delays, so leaving them on would make every existing
 * suite that exercises a write action sleep five seconds per call and blow the
 * default 5s test timeout — turning a safety feature into ~40 unrelated red tests.
 * Bumping those timeouts instead would trade minutes of CI for nothing: they are
 * asserting the outreach behaviour, not the spacing.
 *
 * The pacer's own suite sets both env vars explicitly, so the mechanism is still
 * fully covered; what's disabled here is only the ambient delay. Mirrors
 * `shouldBootstrapBackgroundJobs`, which suppresses background work under Jest for
 * the same class of reason.
 */
const isTestEnv = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

/**
 * Minimum spacing between two write actions on one account.
 *
 * The lethal observed rate was ~0.8 writes/second sustained. This is an order of
 * magnitude below that, which is roughly the pace of a person doing the same work by
 * hand. It is a hypothesis, not a known constant — LinkedIn publishes no limit — so
 * it is env-tunable and starts conservative.
 */
export const minGapMs = (): number =>
  envInt('LINKEDIN_WRITE_MIN_GAP_MS', isTestEnv() ? 0 : 5_000);

/** Rolling per-account ceiling, so a long run cannot creep up on the limit. */
export const maxWritesPerHour = (): number =>
  envInt('LINKEDIN_WRITE_MAX_PER_HOUR', isTestEnv() ? 0 : 30);

/**
 * Longest a single call will sit in the queue before being refused instead.
 *
 * Sleeping without a bound would let a 40-invite drain hold a request open for
 * minutes and blow the run's own timeouts. Past this, the honest answer to the agent
 * is "not now" — the remaining work is still there on the next run.
 */
export const maxQueueWaitMs = (): number => envInt('LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS', 60_000);

const HOUR_MS = 60 * 60 * 1000;

/** Serialization chain per account — the tail every new request awaits. */
const chainByAccount = new Map<string, Promise<void>>();
/** Timestamps of recent writes per account, pruned to the rolling window. */
const recentWritesByAccount = new Map<string, number[]>();
/**
 * How many calls are queued (waiting or running) per account. Needed because the
 * chain alone cannot say how DEEP it is, and the projected wait for the caller at
 * the back of a twenty-deep queue is twenty gaps, not one.
 */
const queueDepthByAccount = new Map<string, number>();

export interface PacerDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Jitter factor in [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

const defaultDeps: PacerDeps = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Never let a pacing delay hold the process open during shutdown.
      if (typeof timer.unref === 'function') timer.unref();
    }),
  random: Math.random,
};

export type WriteSlot =
  | { allowed: true; waitedMs: number }
  | { allowed: false; reason: string; retryAfterMs: number };

/** Test-only: drop all pacing state so each test starts from a clean slate. */
export function __resetWritePacerForTests(): void {
  chainByAccount.clear();
  recentWritesByAccount.clear();
  queueDepthByAccount.clear();
}

function pruneWindow(accountId: string, now: number): number[] {
  const recent = (recentWritesByAccount.get(accountId) || []).filter((ts) => now - ts < HOUR_MS);
  recentWritesByAccount.set(accountId, recent);
  return recent;
}

/** The refusal returned when an account is at its rolling hourly ceiling. */
function overHourlyCeiling(recent: number[], at: number): WriteSlot {
  return {
    allowed: false,
    reason:
      `This LinkedIn account has already performed ${recent.length} write actions in the last hour, ` +
      `which is the safety ceiling that keeps LinkedIn from revoking the account's session. ` +
      `Remaining actions should be left for a later run.`,
    retryAfterMs: Math.max(0, (recent[0] ?? at) + HOUR_MS - at),
  };
}

/**
 * Wait for this account's turn to perform a write action.
 *
 * Calls queue in arrival order per account: ten parallel tool calls become ten
 * spaced writes rather than ten simultaneous ones. Different accounts never block
 * each other.
 *
 * Returns `{ allowed: false }` — without sleeping — when the account is over its
 * hourly ceiling or the queue is already longer than the wait cap. The caller is
 * expected to surface that to the agent rather than retry.
 */
export async function reserveWriteSlot(
  accountId: string,
  deps: Partial<PacerDeps> = {},
): Promise<WriteSlot> {
  const { now, sleep, random } = { ...defaultDeps, ...deps };
  const gap = minGapMs();
  if (gap === 0 && maxWritesPerHour() === 0) {
    // Both limits explicitly disabled — an escape hatch for incident response.
    return { allowed: true, waitedMs: 0 };
  }

  const startedAt = now();

  // Refuse early on the hourly ceiling, before joining the queue: a call that will
  // be refused anyway should not first make every queued call behind it wait.
  const recentAtEntry = pruneWindow(accountId, startedAt);
  const hourlyCap = maxWritesPerHour();
  if (hourlyCap > 0 && recentAtEntry.length >= hourlyCap) {
    return overHourlyCeiling(recentAtEntry, startedAt);
  }

  // Estimate the queue wait before committing, so an over-long queue refuses rather
  // than parking the caller for minutes. Each call ahead of us costs one gap.
  const queuedAhead = queueDepthByAccount.get(accountId) ?? 0;
  const projectedWait = queuedAhead * gap;
  if (queuedAhead > 0 && projectedWait > maxQueueWaitMs()) {
    return {
      allowed: false,
      reason:
        `${queuedAhead} LinkedIn write actions are already queued for this account, which is more ` +
        `than can be paced safely in one run. Remaining actions should be left for a later run.`,
      retryAfterMs: projectedWait,
    };
  }

  const previous = chainByAccount.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const thisTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The chain tail is this call's turn, so the next arrival waits for us. Errors are
  // swallowed onto the chain: one failed write must not wedge the account forever.
  const myTail = previous.then(() => thisTurn).catch(() => undefined);
  chainByAccount.set(accountId, myTail);
  queueDepthByAccount.set(accountId, queuedAhead + 1);

  try {
    await previous;

    const arrivedAt = now();
    const recent = pruneWindow(accountId, arrivedAt);

    // Re-check the ceiling now that we hold the account's turn.
    //
    // The entry-time check above runs BEFORE queueing, so with the cap one write
    // away, ten concurrent callers all read the same under-cap history and all pass
    // it — then each records a write on its way through, overshooting by nine. Only
    // a check taken while holding the turn can see what the callers ahead actually
    // recorded. Deliberately before the sleep: a call that is going to be refused
    // should not first spend the gap waiting.
    if (hourlyCap > 0 && recent.length >= hourlyCap) {
      return overHourlyCeiling(recent, arrivedAt);
    }

    const lastWrite = recent.length > 0 ? recent[recent.length - 1] : 0;
    // Jitter so the spacing is not metronomic — perfectly regular timing is itself
    // an automation signal.
    const jittered = gap + Math.floor(gap * 0.2 * (random() - 0.5) * 2);
    const waitMs = Math.max(0, lastWrite + jittered - arrivedAt);
    if (waitMs > 0) await sleep(waitMs);

    const grantedAt = now();
    recent.push(grantedAt);
    recentWritesByAccount.set(accountId, recent);
    const waitedMs = grantedAt - startedAt;
    if (waitedMs > 0) {
      console.log(`${TAG} account=${accountId} write paced by ${waitedMs}ms`);
    }
    return { allowed: true, waitedMs };
  } finally {
    // Hand the account to whoever queued behind us, whatever happened here.
    release();
    const depth = (queueDepthByAccount.get(accountId) ?? 1) - 1;
    if (depth <= 0) {
      queueDepthByAccount.delete(accountId);
      // Nobody queued behind us, so drop the chain entry rather than retaining a
      // settled promise per account forever.
      if (chainByAccount.get(accountId) === myTail) chainByAccount.delete(accountId);
    } else {
      queueDepthByAccount.set(accountId, depth);
    }
  }
}
