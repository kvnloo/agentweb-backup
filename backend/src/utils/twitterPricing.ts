/**
 * twitterPricing — X (Twitter) API pay-per-use rate card (ENG-664).
 *
 * X exposes NO per-call price at runtime (the rate-limit headers twitter-api-v2
 * returns carry quota, not dollars), so every figure here is ALLOCATED: we apply
 * X's published pay-per-use rate to a call / resource count. It is never a
 * vendor-measured cost — hence callers record it with costSource "allocated".
 *
 * Rates: docs.x.com/x-api/getting-started/pricing (pay-per-use, effective Apr 2026):
 *   - Post created ............ $0.015 / request   ($0.200 if it contains a link)
 *   - Post read ............... $0.005 / resource
 *   - User read ............... $0.010 / resource
 *   - Owned read (own posts, bookmarks, followers, lists) ... $0.001 / resource
 *   - DM event read ........... $0.010 / resource
 *   - DM create ............... $0.015 / request
 *   - Interaction writes (like/follow/retweet/block/mute/delete): X publishes no
 *     per-call price → recorded at $0 so the call is still attributed, never dropped.
 *
 * Caveat (acceptance criterion 2): X charges a repeat read of the SAME resource
 * within a UTC day only once. We do not track resource ids, so a computed total
 * is an allocated UPPER BOUND — it reconciles as ">=" the X console's billed
 * usage, not to the cent. Exact reconciliation would need per-resource-id dedup.
 */

export const TWITTER_PROVIDER = "twitter" as const;

/** Every metered X action. One entry per public twitterService method. */
export type TwitterOperation =
  // ── Post writes (post-create rate; link bumps the rate) ──
  | "post"
  | "reply"
  | "quote"
  // ── DM writes / reads ──
  | "send_dm"
  | "list_dms"
  | "get_dm_conversation"
  // ── Post reads ──
  | "search_tweets"
  | "list_replies"
  | "get_quote_tweets"
  | "get_tweet_metrics"
  | "get_list_tweets"
  | "get_user_tweets"
  // ── User reads ──
  | "get_profile"
  | "get_retweeters"
  | "get_liking_users"
  | "get_list_members"
  | "list_followers"
  | "list_following"
  // ── Owned reads ──
  | "get_bookmarks"
  | "get_owned_lists"
  // ── Interaction writes X does not price per call ($0, still recorded) ──
  | "delete_tweet"
  | "follow"
  | "unfollow"
  | "like"
  | "unlike"
  | "retweet"
  | "unretweet"
  | "bookmark"
  | "block"
  | "unblock"
  | "mute"
  | "unmute";

/** How a single billable unit of an operation is priced. */
interface RateCard {
  /** Human unit label stored on the ledger row ("post", "user", "resource", "dm", "request"). */
  unit: string;
  /** USD per unit. For post-create this is the no-link rate; see linkUsd. */
  usdPerUnit: number;
  /** USD per unit when a created post contains a link (post-create only). */
  linkUsd?: number;
}

const POST_READ: RateCard = { unit: "post", usdPerUnit: 0.005 };
const USER_READ: RateCard = { unit: "user", usdPerUnit: 0.01 };
const OWNED_READ: RateCard = { unit: "resource", usdPerUnit: 0.001 };
const DM_READ: RateCard = { unit: "dm", usdPerUnit: 0.01 };
const POST_WRITE: RateCard = { unit: "post", usdPerUnit: 0.015, linkUsd: 0.2 };
const DM_WRITE: RateCard = { unit: "request", usdPerUnit: 0.015 };
/** X publishes no per-call price for these — recorded at $0, never dropped. */
const UNPRICED_WRITE: RateCard = { unit: "request", usdPerUnit: 0 };

const RATE_CARD: Record<TwitterOperation, RateCard> = {
  // Post writes
  post: POST_WRITE,
  reply: POST_WRITE,
  quote: POST_WRITE,
  // DM write / reads
  send_dm: DM_WRITE,
  list_dms: DM_READ,
  get_dm_conversation: DM_READ,
  // Post reads
  search_tweets: POST_READ,
  list_replies: POST_READ,
  get_quote_tweets: POST_READ,
  get_tweet_metrics: POST_READ,
  get_list_tweets: POST_READ,
  get_user_tweets: POST_READ,
  // User reads
  get_profile: USER_READ,
  get_retweeters: USER_READ,
  get_liking_users: USER_READ,
  get_list_members: USER_READ,
  list_followers: USER_READ,
  list_following: USER_READ,
  // Owned reads
  get_bookmarks: OWNED_READ,
  get_owned_lists: OWNED_READ,
  // Unpriced interaction writes
  delete_tweet: UNPRICED_WRITE,
  follow: UNPRICED_WRITE,
  unfollow: UNPRICED_WRITE,
  like: UNPRICED_WRITE,
  unlike: UNPRICED_WRITE,
  retweet: UNPRICED_WRITE,
  unretweet: UNPRICED_WRITE,
  bookmark: UNPRICED_WRITE,
  block: UNPRICED_WRITE,
  unblock: UNPRICED_WRITE,
  mute: UNPRICED_WRITE,
  unmute: UNPRICED_WRITE,
};

/** Type guard used by the metering chokepoint to reject an unknown op loudly. */
export function isTwitterOperation(op: string): op is TwitterOperation {
  return Object.prototype.hasOwnProperty.call(RATE_CARD, op);
}

/**
 * True when an operation is a POST READ (priced $0.005/resource). These are the
 * only calls X counts in `project_usage` on GET /2/usage/tweets, so
 * reconciliation compares the sum of these operations' quantities against X's
 * measured number. Derived from the rate card so it can never drift from pricing.
 */
export function isPostReadOperation(op: string): boolean {
  return isTwitterOperation(op) && RATE_CARD[op] === POST_READ;
}

export interface TwitterCost {
  /** Ledger unit label. */
  unit: string;
  /** Whole billable units (resources read, or 1 for a single write). */
  quantity: number;
  /** Allocated USD for this call. */
  costUsd: number;
}

/**
 * Allocated USD cost of one X API call.
 *
 * @param operation  which metered action was made
 * @param units      billable resources: resource count for reads, post count for
 *                   writes. Coerced to a non-negative whole number (a garbage or
 *                   negative count becomes 0 — never a negative or NaN charge).
 * @param opts.hasLink  post-create only: charge the link rate ($0.200) not $0.015.
 * @throws if `operation` is not a known X operation — an uninstrumented / mistyped
 *         call must fail loudly rather than record spend under a $0 unknown row.
 */
export function computeTwitterCost(
  operation: TwitterOperation,
  units: number,
  opts?: { hasLink?: boolean }
): TwitterCost {
  const rate = RATE_CARD[operation];
  if (!rate) {
    throw new Error(`Unknown X operation "${operation}" — no rate card entry`);
  }

  const quantity =
    Number.isFinite(units) && units > 0 ? Math.floor(units) : 0;

  const perUnit =
    opts?.hasLink && rate.linkUsd != null ? rate.linkUsd : rate.usdPerUnit;

  return {
    unit: rate.unit,
    quantity,
    costUsd: quantity * perUnit,
  };
}

/** URL detector for post-create link pricing ($0.200 vs $0.015). */
const LINK_RE = /https?:\/\/\S+/i;

/** True when a to-be-posted tweet body contains a link (triggers the $0.200 rate). */
export function textContainsLink(text: string | undefined | null): boolean {
  return !!text && LINK_RE.test(text);
}
