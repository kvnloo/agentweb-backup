/**
 * Read models over the immutable spend ledger (ENG-1250 §7).
 *
 * §7's requirement is blunt: *"No admin should need direct DynamoDB inspection
 * to explain a pause."* Today they do — nothing outside the ledger modules can
 * read `AW-SpendEvents` at all, so "why is this account paused" is answered by
 * scanning a table by hand.
 *
 * This produces the aggregates §7 lists — daily, provider, feature, acting
 * member, session — plus the in-flight reservations, from the events
 * themselves rather than from a second counter that could disagree with them.
 * Deriving beats storing here for the same reason it did in §3a: an aggregate
 * that can drift from its own source is worse than no aggregate, because it
 * looks authoritative.
 *
 * Pure functions over events the caller fetched. Nothing here reads live data,
 * writes anything, or decides admission — ENG-1250 AC6 keeps enforcement with
 * Harsha, and a read model must never become the thing that pauses an account.
 */
import { SpendEvent } from "./spendEventDb";
import { MonthlyProjection } from "./spendProjection";

export interface SpendSlice {
  key: string;
  settledMicroUsd: number;
  /** In-flight, counted separately: a reservation is not spend. */
  reservedMicroUsd: number;
  eventCount: number;
  /** Share of settled spend, 0–100. Zero when nothing is settled. */
  percentOfSettled: number;
}

export interface DailySpend {
  date: string;
  settledMicroUsd: number;
  reservedMicroUsd: number;
  eventCount: number;
}

export interface InFlightReservation {
  eventId: string;
  occurredAt: string;
  provider: string;
  operation: string;
  costMicroUsd: number;
  actingUserId: string;
}

export interface SpendBreakdown {
  billingUserId: string;
  billingMonth: string;
  /** Oldest first, and only days that actually have events. */
  daily: DailySpend[];
  byProvider: SpendSlice[];
  byFeature: SpendSlice[];
  byMember: SpendSlice[];
  bySession: SpendSlice[];
  /**
   * Reservations still open, newest first. These are the calls a pause has to
   * be explained against as much as settled spend — money committed but not
   * yet resolved.
   */
  inFlight: InFlightReservation[];
  inFlightMicroUsd: number;
  settledMicroUsd: number;
  eventCount: number;
}

const UNATTRIBUTED = "(unattributed)";

function slice(
  events: readonly SpendEvent[],
  keyOf: (e: SpendEvent) => string | undefined,
  settledTotal: number,
): SpendSlice[] {
  const acc = new Map<string, SpendSlice>();

  for (const event of events) {
    // A missing dimension becomes an explicit bucket rather than being dropped.
    // Silently skipping events would make the slices sum to less than the
    // total, and the gap would look like missing spend rather than missing
    // metadata.
    const key = keyOf(event) || UNATTRIBUTED;
    let entry = acc.get(key);
    if (!entry) {
      entry = { key, settledMicroUsd: 0, reservedMicroUsd: 0, eventCount: 0, percentOfSettled: 0 };
      acc.set(key, entry);
    }
    if (event.lifecycle === "settled") entry.settledMicroUsd += event.costMicroUsd;
    if (event.lifecycle === "reserved") entry.reservedMicroUsd += event.costMicroUsd;
    entry.eventCount += 1;
  }

  for (const entry of acc.values()) {
    entry.percentOfSettled = settledTotal === 0 ? 0 : (entry.settledMicroUsd / settledTotal) * 100;
  }

  // Largest settled spend first: an admin explaining a pause wants the thing
  // that caused it at the top, not alphabetical order.
  return [...acc.values()].sort(
    (a, b) => b.settledMicroUsd - a.settledMicroUsd || a.key.localeCompare(b.key),
  );
}

/**
 * Every §7 aggregate for one billing subject and month.
 *
 * Events are filtered to the subject and month rather than trusted — the same
 * defensive scoping as the projection, for the same reason: a caller handing
 * over a neighbouring month's events would otherwise get a plausible-looking
 * breakdown that reconciles against nothing.
 */
export function buildSpendBreakdown(
  billingUserId: string,
  billingMonth: string,
  events: readonly SpendEvent[],
): SpendBreakdown {
  const mine = events.filter((e) => e.billingUserId === billingUserId && e.billingMonth === billingMonth);

  const settledMicroUsd = mine.reduce(
    (total, e) => (e.lifecycle === "settled" ? total + e.costMicroUsd : total),
    0,
  );

  const dailyAcc = new Map<string, DailySpend>();
  for (const event of mine) {
    const date = event.occurredAt.slice(0, 10);
    let day = dailyAcc.get(date);
    if (!day) {
      day = { date, settledMicroUsd: 0, reservedMicroUsd: 0, eventCount: 0 };
      dailyAcc.set(date, day);
    }
    if (event.lifecycle === "settled") day.settledMicroUsd += event.costMicroUsd;
    if (event.lifecycle === "reserved") day.reservedMicroUsd += event.costMicroUsd;
    day.eventCount += 1;
  }

  const inFlight: InFlightReservation[] = mine
    .filter((e) => e.lifecycle === "reserved")
    .map((e) => ({
      eventId: e.eventId,
      occurredAt: e.occurredAt,
      provider: e.provider,
      operation: e.operation,
      costMicroUsd: e.costMicroUsd,
      actingUserId: e.actingUserId,
    }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    billingUserId,
    billingMonth,
    daily: [...dailyAcc.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byProvider: slice(mine, (e) => e.provider, settledMicroUsd),
    byFeature: slice(mine, (e) => e.feature, settledMicroUsd),
    // The ACTING member, not the payer: every event here shares one payer, so
    // slicing by that would produce a single bucket. "Who spent this" is the
    // question §7 asks.
    byMember: slice(mine, (e) => e.actingUserId, settledMicroUsd),
    bySession: slice(mine, (e) => e.references?.sessionId, settledMicroUsd),
    inFlight,
    inFlightMicroUsd: inFlight.reduce((total, r) => total + r.costMicroUsd, 0),
    settledMicroUsd,
    eventCount: mine.length,
  };
}

export interface PauseExplanation {
  paused: boolean;
  /** Plain-language reason, or null when the account is not paused. */
  reason: string | null;
  settledMicroUsd: number;
  reservedMicroUsd: number;
  usableAllowanceMicroUsd: number;
  overspentMicroUsd: number;
  /** What pushed it over, largest first. Empty when not paused. */
  topProviders: SpendSlice[];
}

/**
 * "Why is this account paused", answered from the ledger (§7).
 *
 * Reads the projection's mode rather than recomputing it, so this explanation
 * can never disagree with the thing it is explaining — an explanation that
 * contradicts the decision is worse than none.
 *
 * Explains only. It cannot pause, unpause, or change a balance; the projection
 * it reads is itself a shadow computation while AC6 stands.
 */
export function explainPause(
  projection: MonthlyProjection,
  breakdown: SpendBreakdown,
): PauseExplanation {
  const paused = projection.policyMode === "paused";
  const topProviders = paused ? breakdown.byProvider.slice(0, 3) : [];

  const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;

  let reason: string | null = null;
  if (paused) {
    const drivers = topProviders.length
      ? ` Largest contributors: ${topProviders.map((p) => `${p.key} ${usd(p.settledMicroUsd)}`).join(", ")}.`
      : "";
    const inFlightNote = projection.reservedMicroUsd
      ? ` ${usd(projection.reservedMicroUsd)} of that is in-flight and not yet settled.`
      : "";
    reason =
      `Committed spend ${usd(projection.settledMicroUsd + projection.reservedMicroUsd)} reached the cap ` +
      `against a usable allowance of ${usd(projection.usableAllowanceMicroUsd)}.${inFlightNote}${drivers}`;
  }

  return {
    paused,
    reason,
    settledMicroUsd: projection.settledMicroUsd,
    reservedMicroUsd: projection.reservedMicroUsd,
    usableAllowanceMicroUsd: projection.usableAllowanceMicroUsd,
    overspentMicroUsd: projection.overspentMicroUsd,
    topProviders,
  };
}

/**
 * Resolve the allowance side of the projection for one billing subject and
 * month (ENG-1250 §3), so `explainPause` has something to explain against.
 *
 * Every input is read from the SAME places the live gate reads them —
 * `getSubscriptionTypeConfig` for the tier's policy and
 * `getLlmUsageCreditAdjustment` for credits, grants and the migration offset.
 * Resolving them independently would create a second definition of "what this
 * account is allowed to spend", and the two would drift silently: the pause
 * explanation would then contradict the pause.
 *
 * One sign convention needs care. The unit-economics report applies the
 * migration offset by REDUCING spend (`llmCost - migrationOffset`), while the
 * projection applies it by RAISING the allowance. Those are the same
 * adjustment on opposite sides of the same inequality, so the offset is added
 * here rather than subtracted — flipping it would silently double the error.
 */
export async function resolveAllowanceInputs(
  billingUserId: string,
  month: string,
  deps: {
    getUser: (id: string) => Promise<{ subscriptionType?: string; llmUsageCredits?: unknown } | null | undefined>;
    getTierConfig: (tier: string) => Promise<{ llmUsagePolicy?: { hardCostThresholdMicroUsd: number } | null } | null | undefined>;
    getCreditAdjustment: (
      ledger: unknown,
      month: string,
    ) => { purchasedMicroUsd: number; adminGrantedMicroUsd: number; migrationOffsetMicroUsd: number };
  },
): Promise<{
  includedAllowanceMicroUsd: number;
  purchasedCreditsMicroUsd: number;
  adminAdjustmentMicroUsd: number;
  migrationAdjustmentMicroUsd: number;
  /** True when the tier has no configured cap — an unlimited account cannot be paused by spend. */
  unlimited: boolean;
}> {
  const user = await deps.getUser(billingUserId);
  const config = user?.subscriptionType ? await deps.getTierConfig(user.subscriptionType) : null;
  const policy = config?.llmUsagePolicy ?? null;
  const adjustment = deps.getCreditAdjustment(user?.llmUsageCredits, month);

  return {
    // A tier with no policy is uncapped, not zero-allowance. Defaulting to 0
    // would report every such account as massively overspent and paused, which
    // is the opposite of the truth.
    includedAllowanceMicroUsd: policy?.hardCostThresholdMicroUsd ?? 0,
    purchasedCreditsMicroUsd: adjustment.purchasedMicroUsd,
    adminAdjustmentMicroUsd: adjustment.adminGrantedMicroUsd,
    migrationAdjustmentMicroUsd: adjustment.migrationOffsetMicroUsd,
    unlimited: policy == null,
  };
}
