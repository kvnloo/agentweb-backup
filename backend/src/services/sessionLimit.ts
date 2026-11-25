/**
 * ENG-2812: per-session turn/spend limit, enforced.
 *
 * Every agent-loop LLM call ("turn") is counted on the session's own AW-ChatSessions item with an
 * atomic ADD, so the count survives deploys, restarts and instance switches (the ENG-2953 shadow
 * kept it in process memory). A session works inside a *window*: the tier's turn and dollar caps,
 * measured from where the window opened. When either side is used up the loop stops before its
 * next model call and the session waits. A person in the chat reopens a fresh window by replying
 * "continue"; an unattended scheduled run cannot confirm, so it stays paused until someone does,
 * and neither can a share-link visitor (their text is not the owner's word; ENG-3164).
 * At 75% and 90% of a window the attended chat gets a one-time notice (each claimed with a
 * conditional write, so concurrent turns never show it twice).
 *
 * Caps (owner decision, 2026-11-24): 150 turns / $20 per window at the Starter allowance ($80),
 * scaled up proportionally to a tier's live monthly LLM threshold; never below the baseline.
 * Derived from the existing `subscription_types` policy, so no config row is written.
 *
 * Storage: additive optional numeric attributes on the existing session item (no table, index or
 * backfill). Writes never touch updatedAt, so session lists do not reorder. Every DynamoDB error
 * fails OPEN (the turn proceeds, one log line), the same stance as sessionActiveRunGuard.
 * Kill switch: SESSION_LIMIT_ENFORCE=false (or 0 / off) disables counting and pausing entirely.
 */
import type { SubscriptionType } from './subscriptionService';

export const SESSION_LIMIT_BASELINE = { maxTurns: 150, maxSpendUsd: 20 } as const;
/** The tier allowance the baseline is set for (Starter's monthly LLM threshold). */
export const SESSION_LIMIT_BASELINE_ALLOWANCE_USD = 80;
export const SESSION_LIMIT_WARNING_PERCENTS = [75, 90] as const;
export type SessionLimitWarningPercent = typeof SESSION_LIMIT_WARNING_PERCENTS[number];

export interface SessionLimitCaps {
  maxTurns: number;
  maxSpendUsd: number;
}

/** Persisted counters. Totals only grow; the window start marks where the current window opened. */
export interface SessionLimitState {
  turns: number;
  spendMicroUsd: number;
  windowStartTurns: number;
  windowStartSpendMicroUsd: number;
  /** Window start (in turns) at which each notice was last shown; equal to windowStartTurns = shown this window. */
  warned75?: number;
  warned90?: number;
}

const MICRO = 1_000_000;
const ATTR = {
  turns: 'sessionLimitTurns',
  spend: 'sessionLimitSpendMicroUsd',
  windowTurns: 'sessionLimitWindowStartTurns',
  windowSpend: 'sessionLimitWindowStartSpendMicroUsd',
  warned: (pct: SessionLimitWarningPercent) => `sessionLimitWarned${pct}`,
} as const;

type Env = Record<string, string | undefined>;

export function isSessionLimitEnabled(env: Env = process.env): boolean {
  const flag = (env.SESSION_LIMIT_ENFORCE ?? '').trim().toLowerCase();
  return !(flag === 'false' || flag === '0' || flag === 'off');
}

/** The tier's monthly LLM allowance in USD: the live hard threshold, else the legacy cost allowance. */
function tierAllowanceUsd(tier: SubscriptionType | null | undefined): number | undefined {
  const micro = tier?.llmUsagePolicy?.hardCostThresholdMicroUsd;
  if (typeof micro === 'number' && Number.isFinite(micro) && micro > 0) return micro / MICRO;
  const usd = tier?.monthlyCostAllowance;
  if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) return usd;
  return undefined;
}

/**
 * Caps for a tier: the baseline, multiplied by allowance / $80 when that is above 1. A tier with no
 * allowance (unlimited or unknown) gets the baseline, which is also what any lookup failure gets.
 */
export function sessionLimitCapsForTier(tier: SubscriptionType | null | undefined): SessionLimitCaps {
  const allowance = tierAllowanceUsd(tier);
  const scale = allowance === undefined ? 1 : Math.max(1, allowance / SESSION_LIMIT_BASELINE_ALLOWANCE_USD);
  return {
    maxTurns: Math.round(SESSION_LIMIT_BASELINE.maxTurns * scale),
    maxSpendUsd: Math.round(SESSION_LIMIT_BASELINE.maxSpendUsd * scale * 100) / 100,
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function readSessionLimitState(item: Record<string, unknown> | null | undefined): SessionLimitState {
  const i = item ?? {};
  return {
    turns: num(i[ATTR.turns]),
    spendMicroUsd: num(i[ATTR.spend]),
    windowStartTurns: num(i[ATTR.windowTurns]),
    windowStartSpendMicroUsd: num(i[ATTR.windowSpend]),
    warned75: optNum(i[ATTR.warned(75)]),
    warned90: optNum(i[ATTR.warned(90)]),
  };
}

export interface SessionLimitUsage {
  turns: number;
  spendUsd: number;
  /** Largest of the two used fractions of the window. */
  fraction: number;
}

export function sessionLimitUsage(state: SessionLimitState, caps: SessionLimitCaps): SessionLimitUsage {
  const turns = Math.max(0, state.turns - state.windowStartTurns);
  const spendUsd = Math.max(0, state.spendMicroUsd - state.windowStartSpendMicroUsd) / MICRO;
  const fraction = Math.max(turns / caps.maxTurns, spendUsd / caps.maxSpendUsd);
  return { turns, spendUsd, fraction };
}

export function isSessionLimitReached(state: SessionLimitState, caps: SessionLimitCaps): boolean {
  return sessionLimitUsage(state, caps).fraction >= 1;
}

/**
 * Notice thresholds this window has crossed but not yet shown, below the cap (at the cap the pause
 * notice says it all). Highest first: when one turn jumps past both, only the 90% notice is shown,
 * but both are claimed so the 75% one does not appear afterwards.
 */
export function sessionLimitThresholdsDue(state: SessionLimitState, caps: SessionLimitCaps): SessionLimitWarningPercent[] {
  const { fraction } = sessionLimitUsage(state, caps);
  if (fraction >= 1) return [];
  return SESSION_LIMIT_WARNING_PERCENTS
    .filter((pct) => fraction >= pct / 100 && state[`warned${pct}` as 'warned75' | 'warned90'] !== state.windowStartTurns)
    .sort((a, b) => b - a);
}

const CONFIRMATIONS = new Set([
  'continue', 'continue please', 'please continue', 'keep going', 'go on', 'carry on', 'proceed',
  'yes', 'yes continue', 'yes please', 'confirm', 'ok continue', 'okay continue',
]);

/** Whether a typed reply explicitly asks to keep going. Anything else leaves the session paused. */
export function isSessionLimitConfirmation(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const normalized = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return CONFIRMATIONS.has(normalized);
}

export function sessionLimitWarningMessage(pct: SessionLimitWarningPercent): string {
  return `You have used ${pct}% of this session’s limit. Start a new session to keep going without interruption.`;
}

/**
 * The pause text. No numbers on purpose (owner, 2026-11-25): customers should not see steps or our model cost; the exact usage is
 * logged and stored on the message (`sessionLimitPaused`). A share-link visitor cannot continue the owner's session, so they are
 * told to ask the person who shared it.
 */
export function sessionLimitPauseMessage(unattended: boolean, shareVisitor = false): string {
  if (shareVisitor) return 'This shared chat has reached its usage limit. Ask the person who shared it to continue it.';
  return unattended
    ? 'This scheduled run paused because the session reached its usage limit. Open this session and reply "continue" to keep going, or start a new session.'
    : 'This session has reached its usage limit. Reply "continue" to keep going in this session, or start a new session.';
}

export interface SessionLimitDeps {
  /** DocumentClient.get(params).promise() */
  get(params: Record<string, unknown>): Promise<{ Item?: Record<string, unknown> }>;
  /** DocumentClient.update(params).promise() */
  update(params: Record<string, unknown>): Promise<{ Attributes?: Record<string, unknown> }>;
  tableName: string;
  resolveCaps(userId: string): Promise<SessionLimitCaps>;
  log(line: string): void;
  env?: Env;
}

const isConditionFailed = (error: unknown): boolean =>
  (error as any)?.code === 'ConditionalCheckFailedException' || (error as any)?.name === 'ConditionalCheckFailedException';

export interface SessionLimitTracker {
  readonly caps: SessionLimitCaps;
  /** True once the current window is used up: the loop must not make another model call. */
  reached(): boolean;
  usage(): SessionLimitUsage;
  /** Count one model call. Never throws. */
  recordTurn(costUsd: number): Promise<void>;
  /** Highest notice newly claimed during this run (shown once, at the end of the reply), if any. */
  dueWarning(): SessionLimitWarningPercent | undefined;
  pauseMessage(unattended: boolean): string;
}

export interface StartSessionLimitInput {
  sessionId: string;
  userId: string;
  messageContent: string;
  /** True only for an unattended scheduled/test run: nobody can confirm, and no notices are shown. */
  isUnattendedRun?: boolean;
  /** Whether 75%/90% notices may be shown on this run (in-app chat only). */
  warningsAllowed: boolean;
  /**
   * True when this turn is typed by a share-link visitor (the turn's `isInteractiveShare`: false for the owner on their own link).
   * A visitor's "continue" is not the owner's word, so it never reopens the owner's window, and a visitor sees no 75%/90% notices.
   */
  isShareVisitor?: boolean;
}

/**
 * Load the session's counters at the start of a run. When the window is already used up and this
 * run's message is an explicit confirmation from a person, open a fresh window (conditional on the
 * window not having moved, so two confirmations open one window). Returns null when disabled or the
 * state cannot be read (fail open).
 */
export async function startSessionLimit(input: StartSessionLimitInput, deps: SessionLimitDeps): Promise<SessionLimitTracker | null> {
  if (!isSessionLimitEnabled(deps.env ?? process.env) || !input.sessionId) return null;
  const { sessionId } = input;
  let caps: SessionLimitCaps;
  let state: SessionLimitState;
  try {
    caps = await deps.resolveCaps(input.userId).catch(() => sessionLimitCapsForTier(null));
    const got = await deps.get({
      TableName: deps.tableName,
      Key: { sessionId },
      ConsistentRead: true,
      ProjectionExpression: 'sessionId, #t, #s, #wt, #ws, #w75, #w90',
      ExpressionAttributeNames: {
        '#t': ATTR.turns, '#s': ATTR.spend, '#wt': ATTR.windowTurns, '#ws': ATTR.windowSpend,
        '#w75': ATTR.warned(75), '#w90': ATTR.warned(90),
      },
    });
    if (!got.Item) return null; // no persisted session (mock / not yet created): nothing to count against
    state = readSessionLimitState(got.Item);
  } catch (error) {
    deps.log(JSON.stringify({ event: 'session_limit_read_failed', sessionId, error: (error as Error)?.name ?? 'Error' }));
    return null;
  }

  if (isSessionLimitReached(state, caps) && input.isUnattendedRun !== true && input.isShareVisitor !== true && isSessionLimitConfirmation(input.messageContent)) {
    try {
      await deps.update({
        TableName: deps.tableName,
        Key: { sessionId },
        UpdateExpression: 'SET #wt = :t, #ws = :s',
        ConditionExpression: 'attribute_exists(sessionId) AND (attribute_not_exists(#wt) OR #wt = :old)',
        ExpressionAttributeNames: { '#wt': ATTR.windowTurns, '#ws': ATTR.windowSpend },
        ExpressionAttributeValues: { ':t': state.turns, ':s': state.spendMicroUsd, ':old': state.windowStartTurns },
      });
      deps.log(JSON.stringify({ event: 'session_limit_confirmed', sessionId, userId: input.userId, turns: state.turns, spendUsd: state.spendMicroUsd / MICRO }));
    } catch (error) {
      if (!isConditionFailed(error)) {
        deps.log(JSON.stringify({ event: 'session_limit_confirm_failed', sessionId, error: (error as Error)?.name ?? 'Error' }));
      }
      // Lost the race: another confirmation already opened the window. Either way it is open now.
    }
    state = { ...state, windowStartTurns: state.turns, windowStartSpendMicroUsd: state.spendMicroUsd };
  }

  let warning: SessionLimitWarningPercent | undefined;
  let loggedPause = false;

  const claimWarnings = async () => {
    for (const pct of sessionLimitThresholdsDue(state, caps)) {
      try {
        await deps.update({
          TableName: deps.tableName,
          Key: { sessionId },
          UpdateExpression: 'SET #w = :win',
          ConditionExpression: 'attribute_exists(sessionId) AND (attribute_not_exists(#w) OR #w <> :win)',
          ExpressionAttributeNames: { '#w': ATTR.warned(pct) },
          ExpressionAttributeValues: { ':win': state.windowStartTurns },
        });
        if (warning === undefined || pct > warning) warning = pct;
      } catch (error) {
        if (!isConditionFailed(error)) {
          deps.log(JSON.stringify({ event: 'session_limit_warning_claim_failed', sessionId, pct, error: (error as Error)?.name ?? 'Error' }));
        }
      }
      if (pct === 75) state = { ...state, warned75: state.windowStartTurns };
      else state = { ...state, warned90: state.windowStartTurns };
    }
  };

  return {
    caps,
    reached: () => isSessionLimitReached(state, caps),
    usage: () => sessionLimitUsage(state, caps),
    dueWarning: () => warning,
    pauseMessage: (unattended: boolean) => {
      if (!loggedPause) {
        loggedPause = true;
        const u = sessionLimitUsage(state, caps);
        deps.log(JSON.stringify({
          event: 'session_limit_paused', sessionId, userId: input.userId, unattended, shareVisitor: input.isShareVisitor === true,
          windowTurns: u.turns, windowSpendUsd: Number(u.spendUsd.toFixed(4)), totalTurns: state.turns, ...caps,
        }));
      }
      return sessionLimitPauseMessage(unattended, input.isShareVisitor === true);
    },
    recordTurn: async (costUsd: number) => {
      const micro = Number.isFinite(costUsd) && costUsd > 0 ? Math.round(costUsd * MICRO) : 0;
      try {
        const res = await deps.update({
          TableName: deps.tableName,
          Key: { sessionId },
          UpdateExpression: 'ADD #t :one, #s :micro',
          ConditionExpression: 'attribute_exists(sessionId)',
          ExpressionAttributeNames: { '#t': ATTR.turns, '#s': ATTR.spend },
          ExpressionAttributeValues: { ':one': 1, ':micro': micro },
          ReturnValues: 'UPDATED_NEW',
        });
        const a = res.Attributes ?? {};
        state = {
          ...state,
          turns: typeof a[ATTR.turns] === 'number' ? (a[ATTR.turns] as number) : state.turns + 1,
          spendMicroUsd: typeof a[ATTR.spend] === 'number' ? (a[ATTR.spend] as number) : state.spendMicroUsd + micro,
        };
      } catch (error) {
        // Count locally so this run still stops at its cap even if the write failed.
        state = { ...state, turns: state.turns + 1, spendMicroUsd: state.spendMicroUsd + micro };
        deps.log(JSON.stringify({ event: 'session_limit_record_failed', sessionId, error: (error as Error)?.name ?? 'Error' }));
      }
      if (input.warningsAllowed && input.isUnattendedRun !== true && input.isShareVisitor !== true) await claimWarnings();
    },
  };
}

/** Production wiring: the chat-sessions table and the user's effective (org-aware) tier. */
export async function startSessionLimitForRun(input: StartSessionLimitInput): Promise<SessionLimitTracker | null> {
  if (!isSessionLimitEnabled()) return null;
  try {
    const { dynamodb } = await import('./chatbotService');
    const { getUserSubscriptionType, getTierConfig } = await import('./subscriptionService');
    const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    return await startSessionLimit(input, {
      get: (p) => dynamodb.get(p as any).promise() as any,
      update: (p) => dynamodb.update(p as any).promise() as any,
      tableName: `${prefix}AW-ChatSessions`,
      resolveCaps: async (userId) => sessionLimitCapsForTier(await getTierConfig(await getUserSubscriptionType(userId))),
      log: (line) => console.log(line),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'session_limit_start_failed', sessionId: input.sessionId, error: (error as Error)?.name ?? 'Error' }));
    return null;
  }
}
