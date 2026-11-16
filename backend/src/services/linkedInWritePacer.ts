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
 *
 * Second gap, same honesty: this paces the AGENT TOOL path only. The CRM route
 * `POST /lists/:listId/leads/:leadId/send-linkedin-invite` calls `sendInvitation`
 * directly, so its writes are invisible to the rolling window here. It is
 * single-lead and user-driven, so it cannot burst — but the hourly ceiling
 * under-counts by however many invites a customer sends by hand during a drain.
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
  // Trim-and-reject before Number(): `Number('')` and `Number('  ')` are both 0,
  // which is finite and >= 0, so an env var set to an empty string would be read as
  // a deliberate 0 and silently switch pacing off entirely.
  const configured = (process.env[name] ?? '').trim();
  if (configured === '') return fallback;
  const raw = Number(configured);
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

/**
 * Rolling per-account ceiling — a backstop against sustained hammering, NOT the
 * primary guard.
 *
 * The evidence indicts BURST, not volume: ~10 writes inside one second killed the
 * session, twice. The minimum gap above is what fixes that, and at 5s the ceiling
 * is already an implicit ~720/hour.
 *
 * Set to 30 originally, which was a mistake: a legitimate stale-invite drain
 * targets 40 withdrawals in a run, and Fangfang's and Hannah's invite schedules are
 * the same shape — so the ceiling would have refused ordinary work that the gap had
 * already made safe, converting a fix into an outage of its own. 120 sits far above
 * realistic per-account use while still catching a runaway loop.
 */
export const maxWritesPerHour = (): number =>
  envInt('LINKEDIN_WRITE_MAX_PER_HOUR', isTestEnv() ? 0 : 120);

/**
 * Longest a call will sit BEHIND OTHER CALLERS before being refused instead.
 *
 * Not a bound on the caller's own spacing gap: a lone caller still waits up to one
 * `minGapMs` after the previous write, which is the mechanism, not a queue.
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

/**
 * Test-only: drop all pacing state so each test starts from a clean slate.
 * Daily-volume state is no longer module-level (it's persisted by the caller
 * and passed into `reserveDailyVolumeSlot` explicitly), so there's nothing of
 * that kind left to reset here.
 */
export function __resetWritePacerForTests(): void {
  chainByAccount.clear();
  recentWritesByAccount.clear();
  queueDepthByAccount.clear();
}

function pruneWindow(accountId: string, now: number): number[] {
  const recent = (recentWritesByAccount.get(accountId) || []).filter((ts) => now - ts < HOUR_MS);
  // Drop the key once its window is empty rather than parking an empty array under
  // it, matching how `chainByAccount`/`queueDepthByAccount` clean up.
  //
  // Stated precisely, because the obvious claim is wrong: this runs only when the
  // account is reserved AGAIN, so a one-off account's entry is exactly the one never
  // removed. What it fixes is the narrower case of an account that returns after its
  // window expired. Growth is bounded by the number of connected Unipile accounts
  // either way — this is hygiene, not a leak fix.
  if (recent.length === 0) {
    recentWritesByAccount.delete(accountId);
  } else {
    recentWritesByAccount.set(accountId, recent);
  }
  return recent;
}

/** The refusal returned when an account is at its rolling hourly ceiling. */
function overHourlyCeiling(recent: number[], at: number): WriteSlot {
  return {
    allowed: false,
    reason:
      `This LinkedIn Outreach account has already performed ${recent.length} write actions in the last hour, ` +
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
  // than parking the caller for minutes.
  //
  // The estimate has to be an UPPER bound or the cap does not hold: `maxQueueWaitMs`
  // is a promise that an admitted caller will not sit longer than that. Each call
  // ahead of us costs up to one gap, and so does our own turn after the last of them
  // — hence `queuedAhead + 1`, not `queuedAhead`. The jitter below is ±20% of the
  // gap (`0.2 * (random() - 0.5) * 2`), so the worst case per slot is 1.2 gaps.
  // Under-estimating both terms let a caller be admitted and then wait past the cap.
  const queuedAhead = queueDepthByAccount.get(accountId) ?? 0;
  const worstCaseSlotMs = Math.ceil(gap * 1.2);
  const projectedWait = (queuedAhead + 1) * worstCaseSlotMs;
  // The `queuedAhead > 0` term is deliberate. This cap bounds time spent QUEUED
  // BEHIND other callers; a lone caller is not queued behind anyone, and the single
  // gap it may still wait is `minGapMs` — a separate, deliberately-configured cost,
  // not a queue. Dropping the term would also make `LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS=0`
  // refuse every write rather than meaning "never queue", which is a much larger
  // behaviour change than the wording it would fix.
  if (queuedAhead > 0 && projectedWait > maxQueueWaitMs()) {
    return {
      allowed: false,
      reason:
        `${queuedAhead} LinkedIn Outreach write actions are already queued for this account, which is more ` +
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
    // Jitter so the spacing is not metronomic — perfectly regular timing is itself an
    // automation signal. UPWARD only: symmetric jitter put the real floor at 0.8x the
    // configured gap, which made `minGapMs` — documented as a minimum, and the number
    // the whole safety argument rests on — untrue by 20%. Widening is always safe;
    // narrowing is the thing being defended against.
    const jittered = gap + Math.floor(gap * 0.2 * random());
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

/**
 * Read-only peek at whether an account is currently inside the hourly/burst pacer's
 * cooldown (`reserveWriteSlot`'s minGap/hourly-ceiling state), and when it clears.
 *
 * Deliberately non-mutating: unlike `reserveWriteSlot`/`pruneWindow`, this never
 * writes back to `recentWritesByAccount` or reserves a slot. It exists so a status
 * endpoint (e.g. daily-quota) can answer "cooling down until 14:32" without the
 * side effects of an actual reservation attempt.
 */
export function peekWriteCooldown(
  accountId: string,
  now: number = Date.now(),
): { active: boolean; expiresAt: string | null } {
  const gap = minGapMs();
  const hourlyCap = maxWritesPerHour();
  if (gap === 0 && hourlyCap === 0) return { active: false, expiresAt: null };

  const recent = (recentWritesByAccount.get(accountId) || []).filter((ts) => now - ts < HOUR_MS);
  if (hourlyCap > 0 && recent.length >= hourlyCap) {
    const expiresAt = (recent[0] ?? now) + HOUR_MS;
    return { active: true, expiresAt: new Date(expiresAt).toISOString() };
  }

  const lastWrite = recent.length > 0 ? recent[recent.length - 1] : 0;
  if (recent.length > 0) {
    const nextAvailable = lastWrite + gap;
    if (nextAvailable > now) {
      return { active: true, expiresAt: new Date(nextAvailable).toISOString() };
    }
  }
  return { active: false, expiresAt: null };
}

/**
 * DAILY send-volume ceiling (distinct from the hourly/burst pacer above).
 *
 * Before this, "5 invites / 10 messages per run" existed only as prose in the
 * skill system prompts — advisory to the model, not enforced. The only
 * code-enforced limit was the hourly ceiling above, a flat number shared
 * across every write action type with no invite/message split at all.
 *
 * DELIBERATELY NOT auto-detected. LinkedIn's own developer API doesn't expose
 * Premium status to us at all, and the only real signal Unipile offers
 * (InMail credit balance) is an extra external call whose failure mode would
 * be a silent, unverifiable guess about someone's real account — exactly the
 * "hidden fallback" this design avoids. Instead: the account's own configured
 * cap (`daily_invite_cap`, self-reported — set directly by the user in
 * Settings, or by Emma asking "are you on LinkedIn Premium?" in a live turn
 * and calling `linkedin_outreach` action `set-daily-invite-cap`) IS the
 * number. Nothing here infers or guesses it.
 *
 * The system still enforces an ABSOLUTE ceiling (`dailyInviteAbsoluteMax`)
 * regardless of what's configured — a safety backstop against a bad/malicious
 * value, not a detection mechanism. Unset defaults to the conservative
 * free-tier number (10) rather than the risky max, so an account nobody has
 * asked yet never silently gets treated as Premium.
 */

/** Which of the two daily-volume classes a write action belongs to. */
export type DailyVolumeClass = 'invite' | 'message';

/**
 * cancel-invitation and accept-invitation are account maintenance, not outbound
 * send volume, so this rule doesn't apply to them — they stay governed by the
 * hourly/burst pacer above only.
 */
export function dailyVolumeClassFor(action: string): DailyVolumeClass | null {
  if (action === 'send-invite') return 'invite';
  if (action === 'send-message' || action === 'send-inmail') return 'message';
  return null;
}

/** Conservative default when nobody has ever configured a cap for this account. */
export const DEFAULT_DAILY_INVITE_CAP = 10;

/**
 * Hard system-wide ceiling on the daily invite cap — never exceeded no matter
 * what a user/Emma configures. This IS Harsha's Premium number (30): the
 * highest volume he's observed a real account safely sustain, so it doubles
 * as both "what Premium gets" and "the absolute backstop everyone is clamped
 * to." Off (0) under Jest so other suites calling send-invite repeatedly don't
 * break; env-tunable for the same incident-response reason as `maxWritesPerHour`
 * — 0 there is the operator escape hatch, NOT a valid self-reported cap (a user
 * setting their own cap to 0 should mean "send nothing", handled separately
 * below, not "unlimited").
 */
export const dailyInviteAbsoluteMax = (): number =>
  envInt('LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX', isTestEnv() ? 0 : 30);

/**
 * Resolve the invite cap actually enforced for this account: the self-reported
 * `configuredCap` if it's a non-negative number, else the conservative default
 * — either way clamped to the absolute ceiling.
 *
 * Returns `Infinity` when the OPERATOR has disabled the whole mechanism
 * (`dailyInviteAbsoluteMax() <= 0`, the incident-response escape hatch) — a
 * distinct value from a USER explicitly configuring 0, which means "send
 * nothing" and must stay a real, enforced zero, not get read as "unlimited."
 * Collapsing those two into the same number was the bug in the first draft of
 * this cap: a user setting their own cap to 0 would have been silently
 * treated as no cap at all.
 */
export function resolveDailyInviteCap(configuredCap: number | null | undefined): number {
  const absoluteMax = dailyInviteAbsoluteMax();
  if (absoluteMax <= 0) return Infinity; // operator escape hatch: disabled entirely
  if (typeof configuredCap === 'number' && Number.isFinite(configuredCap) && configuredCap >= 0) {
    return Math.min(configuredCap, absoluteMax);
  }
  return Math.min(DEFAULT_DAILY_INVITE_CAP, absoluteMax);
}

/**
 * ENG-1721 / ENG-1609 AC #6 — the warm-up ramp.
 *
 * WHY A FLAT CAP IS NOT ENOUGH. Harsha queried Unipile directly for the
 * iTrials account after its ENG-1132 block: `premiumId: null`, no premium
 * features — a FREE LinkedIn account — and `created_at` ~24 hours before the
 * block. It was refused at a target well under the 30/day ceiling. LinkedIn
 * throttles a freshly-connected third-party integration materially harder for
 * roughly its first one to two weeks, independent of our own cap, and his
 * conclusion was that this "is very likely the DEFAULT new-customer failure
 * mode, not an edge case."
 *
 * AGE IS THE ONLY INPUT, DELIBERATELY. Not `is_premium`, not
 * `daily_invite_cap`: both are self-reported and provably wrong in the field —
 * the very account above carries `is_premium: true` and `daily_invite_cap: 30`
 * while being a free account. `created_at` is verified faithful (it matched
 * Unipile's own record to the minute) and survives re-OAuth
 * (`connectedAccountsDb.createAccount` keeps `existingAccount?.created_at`), so
 * an established account that reconnects does not restart its ramp.
 *
 * IN CODE, NOT IN A PROMPT. ENG-1631 had to run a production migration over
 * `AW-Skills` because a cap written as prose went stale and `appendBlocks()`
 * never rewrites an existing block; ENG-1634 is the same stale prose still
 * living in scheduled-chat prompts. Prose caps drift. This one cannot.
 *
 * Shape mirrors `senderUsageTracker.ts`'s `WARMUP_RAMP` / `effectiveDailyLimit`
 * (ENG-265, the CRM email-sender ramp) with LinkedIn numbers: ~5/day through
 * the first week, one intermediate step through day 14, then the account's own
 * configured cap with no ramp at all.
 */
export const LINKEDIN_WARMUP_RAMP: Array<{ throughDay: number; limit: number }> = [
  { throughDay: 7, limit: 5 },
  { throughDay: 14, limit: 15 },
];

/** Length of the ramp — the last day on which any step still applies. */
export const LINKEDIN_WARMUP_THROUGH_DAY =
  LINKEDIN_WARMUP_RAMP[LINKEDIN_WARMUP_RAMP.length - 1].throughDay;

/**
 * The warm-up ceiling for a connection of this age, or `null` when the ramp does
 * not apply — past the window, or no usable `created_at`.
 *
 * A missing or unparseable timestamp returns `null` rather than the most
 * conservative step: this function never INVENTS a restriction from absent data.
 * Every one of the 16 unipile accounts in production carries a `created_at`, so
 * the null case is a defensive path, not a routine one — and if it ever became
 * routine, silently throttling every account to 5/day would be a far worse
 * failure than leaving the configured cap in place.
 *
 * Day numbering matches `effectiveDailyLimit`: the connection day itself is day
 * 1. A future-dated timestamp (clock skew) floors to day 1, the most
 * conservative step, rather than escaping the ramp.
 */
export function warmupInviteCap(
  connectedAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof connectedAt !== 'string' || connectedAt.trim().length === 0) return null;
  const start = Date.parse(connectedAt);
  if (Number.isNaN(start)) return null;
  const dayNumber = Math.max(1, Math.floor((now - start) / DAY_MS) + 1);
  const step = LINKEDIN_WARMUP_RAMP.find((s) => dayNumber <= s.throughDay);
  return step ? step.limit : null;
}

/**
 * The invite cap actually enforced for this account today: the configured cap
 * (already clamped to the absolute ceiling by `resolveDailyInviteCap`), further
 * lowered by the warm-up ramp while the connection is new.
 *
 * `Math.min`, never `Math.max` — the ramp only ever LOWERS. A configured cap
 * below the ramp still wins, exactly as `effectiveDailyLimit` treats a
 * configured `dailyLimit`, and a user's explicit `0` ("send nothing") stays a
 * real zero.
 *
 * The operator escape hatch is preserved before the ramp is consulted at all:
 * when `resolveDailyInviteCap` returns `Infinity` the whole mechanism has been
 * switched off (`LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX <= 0`, which is also Jest's
 * default), and layering a ramp on top would REINTRODUCE a cap precisely where
 * an operator — or the test environment — had disabled it.
 */
export function resolveEffectiveDailyInviteCap(
  configuredCap: number | null | undefined,
  connectedAt?: string | null,
  now: number = Date.now(),
): number {
  const resolved = resolveDailyInviteCap(configuredCap);
  if (!Number.isFinite(resolved)) return resolved;
  const warmup = warmupInviteCap(connectedAt, now);
  return warmup === null ? resolved : Math.min(warmup, resolved);
}

/**
 * Is today's cap the RAMP's doing rather than the account's own configuration?
 * Only used to phrase the refusal: telling a warm-up account to "raise it in
 * Settings" is advice that cannot work, and acting on it (self-reporting
 * Premium to lift a cap) is the exact move that gets a new account throttled
 * harder.
 */
export function isWarmupLimitedInviteCap(
  configuredCap: number | null | undefined,
  connectedAt?: string | null,
  now: number = Date.now(),
): boolean {
  const resolved = resolveDailyInviteCap(configuredCap);
  if (!Number.isFinite(resolved)) return false;
  const warmup = warmupInviteCap(connectedAt, now);
  return warmup !== null && warmup < resolved;
}

/**
 * Daily message ceiling — flat, not self-reported or Premium-dependent.
 * send-message and send-inmail share one budget; InMail separately requires
 * Premium + available credits to be attempted at all, enforced upstream in
 * linkedInOutreachService, so this cap is not where Premium-gating for InMail
 * belongs.
 *
 * Off by default under Jest — same reasoning as the caps above.
 */
export const dailyMessageCap = (): number =>
  envInt('LINKEDIN_DAILY_MESSAGE_CAP', isTestEnv() ? 0 : 20);

const DAY_MS = 24 * HOUR_MS;

/**
 * One class's daily-window counter. A FIXED window that renews from the first
 * send after it expires, not a true sliding window — deliberately, so the
 * persisted shape is two numbers instead of an array of up to 30 timestamps
 * living forever in the account's config. Equivalent enough for a safety
 * ceiling: it still guarantees no more than `cap` sends in any 24h window
 * anchored at the first send of that window.
 */
export interface DailyVolumeWindowState {
  count: number;
  windowStartedAt: number; // epoch ms
}

/**
 * Per-account daily-volume state, PERSISTED (CodeRabbit finding, 2026-08-25):
 * this used to live in a module-level Map, which a backend process
 * restart — which happens on every merge to `main`, i.e. routinely, multiple
 * times a day — silently reset to empty, letting an account exceed its daily
 * cap simply because a deploy landed mid-day. There is nothing per-account to
 * key an in-memory store by that survives that; the account's own config
 * (`LinkedInOutreachConfig.daily_volume`) is the durable store instead. This
 * module stays pure — it takes the last-persisted state in and returns the
 * next state out; the caller (`agentModeService.ts`) does the actual read
 * before and write after, using `updateAccountConfig`'s compare-and-swap.
 */
export interface DailyVolumeState {
  invite?: DailyVolumeWindowState;
  message?: DailyVolumeWindowState;
}

export type DailyVolumeSlot =
  | { allowed: true; nextState: DailyVolumeState }
  | { allowed: false; reason: string; retryAfterMs: number };

/**
 * Read the current daily window for one class WITHOUT reserving anything.
 *
 * Extracted (ENG-1717) so the reservation path and the pre-send capacity gate can
 * never disagree about what "used today" means. A fixed window renews from the
 * first send after it expires, so an expired window reads as a fresh zero — that
 * detail is exactly what a second, hand-written implementation would get wrong.
 */
function readDailyWindow(
  state: DailyVolumeState,
  cls: DailyVolumeClass,
  now: number,
): { currentCount: number; windowStartedAt: number } {
  const existingWindow = state[cls];
  const windowExpired = !existingWindow || now - existingWindow.windowStartedAt >= DAY_MS;
  return {
    currentCount: windowExpired ? 0 : existingWindow!.count,
    windowStartedAt: windowExpired ? now : existingWindow!.windowStartedAt,
  };
}

/** How much of an account's daily invite budget is left, and when it renews. */
export interface DailyInviteHeadroom {
  /** Sends still permitted in the current window. `Infinity` when the cap mechanism is disabled. */
  remaining: number;
  /** The cap in force. `Infinity` when the operator escape hatch is on. */
  cap: number;
  /** Invites already sent inside the current window. */
  used: number;
  /** Ms until the current window renews. `0` when nothing is used or the cap is disabled. */
  resetsInMs: number;
}

/**
 * Answer "can this account send an invite right now?" WITHOUT consuming a slot.
 *
 * `reserveDailyVolumeSlot` already refuses an over-cap send, but only once a send
 * is attempted — which is per-recipient, after a run has done all of its sourcing
 * work. This is the same arithmetic, exposed as a read, so a caller can decide
 * before spending the run (ENG-1717 / ENG-1132's "pre-send capacity check").
 *
 * Deliberately pure and I/O-free, exactly like `reserveDailyVolumeSlot`, and
 * sharing `readDailyWindow` with it so the two can never drift. A `remaining` of 0
 * is therefore not a heuristic: it is a proof that the next `send-invite` on this
 * account will be refused, for as long as `resetsInMs` says.
 */
export function remainingDailyInvites(
  configuredInviteCap: number | null | undefined,
  persistedState: DailyVolumeState | null | undefined,
  deps: DailyVolumeOptions = {},
): DailyInviteHeadroom {
  const now = (deps.now ?? defaultDeps.now)();
  // ENG-1721: the SAME effective cap the reservation enforces, ramp included —
  // a pre-send capacity gate that reported headroom against the unramped cap
  // would wave through a run whose very first send the pacer then refuses.
  const cap = resolveEffectiveDailyInviteCap(configuredInviteCap, deps.connectedAt, now);
  // Operator escape hatch (`dailyInviteAbsoluteMax() <= 0`) surfaces as Infinity —
  // unlimited, no window to report. A USER-configured 0 is finite and stays a real
  // block, the same distinction resolveDailyInviteCap draws.
  if (!Number.isFinite(cap)) {
    return { remaining: Infinity, cap: Infinity, used: 0, resetsInMs: 0 };
  }
  const { currentCount, windowStartedAt } = readDailyWindow(persistedState || {}, 'invite', now);
  return {
    remaining: Math.max(0, cap - currentCount),
    cap,
    used: currentCount,
    resetsInMs: currentCount > 0 ? Math.max(0, windowStartedAt + DAY_MS - now) : 0,
  };
}

/**
 * Check this account's daily invite/message budget against its persisted
 * state, and — if allowed — return the incremented state for the caller to
 * persist.
 *
 * Deliberately separate from `reserveWriteSlot`: that call paces BURSTS and a
 * generic hourly ceiling shared across every write type; this one enforces the
 * DAILY volume ceiling. A caller must pass BOTH checks — this one does not
 * replace the hourly/burst pacer, it adds to it.
 *
 * `configuredInviteCap` is the account's own self-reported setting (set by the
 * user directly, or by Emma after asking about Premium status) — see the
 * module doc comment above for why this is self-reported rather than detected.
 *
 * Pure and synchronous, unlike `reserveWriteSlot` — no queueing (a daily cap is
 * a hard stop for the rest of the day, not worth making a caller wait out) and
 * no I/O (the caller owns persistence, so this stays trivially unit-testable).
 */
/**
 * The optional 4th argument shared by `reserveDailyVolumeSlot` and
 * `remainingDailyInvites`: the injected clock, plus the connection age the
 * warm-up ramp reads. Kept as one options object so a caller cannot pass the
 * age to one and forget it on the other — the reservation and the headroom
 * query must always agree about today's cap.
 */
export interface DailyVolumeOptions extends Partial<Pick<PacerDeps, 'now'>> {
  /** ISO `created_at` of the connected account (ENG-1721). Omitted = no ramp. */
  connectedAt?: string | null;
}

export function reserveDailyVolumeSlot(
  action: string,
  configuredInviteCap: number | null | undefined,
  persistedState: DailyVolumeState | null | undefined,
  deps: DailyVolumeOptions = {},
): DailyVolumeSlot {
  const cls = dailyVolumeClassFor(action);
  const carriedState = persistedState || {};
  if (cls === null) return { allowed: true, nextState: carriedState };

  const now = (deps.now ?? defaultDeps.now)();
  const cap = cls === 'invite'
    ? resolveEffectiveDailyInviteCap(configuredInviteCap, deps.connectedAt, now)
    : dailyMessageCap();
  // The two classes disable differently, on purpose. Messages are never
  // self-reported — `cap <= 0` can only be the operator env-var escape hatch
  // (including Jest's suppressed-by-default 0), so it means "unlimited" here,
  // same convention as the hourly ceiling above. Invites ARE self-reported, so
  // `resolveDailyInviteCap` already turned "operator disabled" into `Infinity`
  // — a literal 0 reaching this point for an invite can only be a user's own
  // "send nothing," which must stay a real block, not get read as unlimited.
  if (cls === 'message' ? cap <= 0 : !Number.isFinite(cap)) {
    return { allowed: true, nextState: carriedState };
  }

  const { currentCount, windowStartedAt } = readDailyWindow(carriedState, cls, now);

  if (currentCount >= cap) {
    const label = cls === 'invite' ? 'LinkedIn connection request' : 'LinkedIn message';
    // ENG-1721: a warm-up cap must NOT be described as a configurable one.
    // "Raise it in Settings" is advice that cannot work here, and acting on it —
    // self-reporting Premium to lift the number — is precisely what gets a
    // newly-connected account throttled harder by LinkedIn.
    const warmupLimited = cls === 'invite'
      && isWarmupLimitedInviteCap(configuredInviteCap, deps.connectedAt, now);
    const tierNote =
      cls !== 'invite'
        ? ''
        : warmupLimited
          ? ` (a new LinkedIn connection is ramped up gradually over its first ${LINKEDIN_WARMUP_THROUGH_DAY} days`
            + ' — this is not a configurable cap, and raising it in Settings will not lift it)'
          : cap >= dailyInviteAbsoluteMax()
            ? ' (the system-wide maximum)'
            : ' (this account\'s configured daily cap — raise it in Settings or ask Emma to update it if you have LinkedIn Premium)';
    return {
      allowed: false,
      reason:
        `This LinkedIn account has already sent ${currentCount} ${label}${currentCount === 1 ? '' : 's'} ` +
        `in the last 24 hours, which is today's safety ceiling of ${cap}${tierNote}. ` +
        `Remaining actions should be left for a later run.`,
      retryAfterMs: Math.max(0, windowStartedAt + DAY_MS - now),
    };
  }

  return {
    allowed: true,
    nextState: { ...carriedState, [cls]: { count: currentCount + 1, windowStartedAt } },
  };
}
