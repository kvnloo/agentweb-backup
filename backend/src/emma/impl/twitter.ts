/**
 * ENG-2103 (F2) — Twitter/X tool cluster, extracted from `AgentModeService`.
 * The 17th domain cluster in this series, and one of the smallest/cleanest:
 * two public dispatchers, each wrapping one private implementation.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`,
 * in file order: twitterManagePost, _twitterManagePostImpl, twitterOutreach,
 * _twitterOutreachImpl (immediately after cluster 16's `linkedinOutreach` ends,
 * ~line 22886 pre-extraction).
 *
 * NOT moved, explicitly out of scope for this cluster (a separate ads-API
 * cluster): `getLinkedInAdsCredentials`/`callLinkedInMarketingApi` onward
 * (~line 23341+ pre-extraction). Cluster 15's already-extracted
 * `emma/impl/socialAccounts.ts` and cluster 16's `emma/impl/linkedin.ts` are
 * untouched by this cluster.
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in this cluster — confirmed
 * by grepping the whole ~450-line range and by reading both methods in full;
 * neither has a callLLM-adjacent call at any hop. No exclusions needed.
 *
 * `AgentModeService.prototype.twitterManagePost` / `.twitterOutreach` now
 * delegate to these functions rather than duplicating them. Both kept as
 * one-line delegating wrappers (neither deleted) — real callers beyond
 * `emma/tools.ts`, found by grepping the whole backend:
 *   - `twitterManagePost`: direct real-instance calls in
 *     `agentModeService.socialTools.test.ts` and the whole of
 *     `agentModeService.twitterOutreach.test.ts`.
 *   - `twitterOutreach`: the whole of `agentModeService.twitterOutreach.test.ts`.
 * `utils/requiredCallSatisfaction.ts` and `utils/schedulePublishApproval.ts`
 * reference the tool name `twitter_manage_post` and the `_twitterManagePostImpl`
 * naming convention only in comments/tool-name-keyed logic — they classify by
 * registry tool name and action string, never by calling these methods
 * directly, so they are unaffected by this move.
 *
 * AsyncLocalStorage wrapping (`runWithXActingUser`, ENG-664 Option B — see
 * `services/twitterService.ts`'s module doc comment) is preserved EXACTLY:
 * both exported dispatchers below still wrap their private impl call in
 * `runWithXActingUser(userId, () => ...)`, moved verbatim as a single unit
 * (not split, not re-wrapped, not dropped). The class's delegating wrappers no
 * longer re-wrap it — wrapping now happens exactly once, here, matching the
 * original single-wrap behavior. This scope is load-bearing for the X metering
 * shadow ledger's request-scoped acting-user attribution.
 *
 * Transitive-import note: `twitterService` (`../../services/twitterService`,
 * also the source of `runWithXActingUser`) is a STATIC import here, matching
 * exactly how `agentModeService.ts` already statically imported it
 * (`import { twitterService, runWithXActingUser } from './twitterService'`).
 * Confirmed safe: `twitterService.ts`'s own import list (`async_hooks`,
 * `twitter-api-v2`, `../utils/publishConsentWithdrawn`,
 * `./adapters/socialPlatformTypes`, `../utils/secretsManager`,
 * `./connectedAccountsDb`, `./usageRecorderService`, `../utils/twitterErrors`,
 * `../utils/twitterPricing`) contains no import of `agentModeService.ts`
 * anywhere, so this is not a new circularity — `agentModeService.ts` already
 * pulled in the exact same transitive chain (including
 * `connectedAccountsDb.ts`'s static `services/db.ts` import, which constructs
 * a real `AWS.DynamoDB.DocumentClient` at module load) on every load before
 * this extraction. Verified by `npm run typecheck`, not just by reading the
 * import list. `../../utils/scheduledPublishConsentGuard`
 * (`publishWithdrawnMidFlight`), `../../utils/publishConsentWithdrawn`
 * (`isPublishConsentWithdrawn`), and `../../utils/twitterErrors`
 * (`describeXApiError`) are likewise static here, matching their existing
 * static imports in `agentModeService.ts`. Every dynamic (`await import(...)`)
 * reference in the moved methods — `connectedAccountsDb` (account lookups) and
 * `emailEventsDb` (CRM logging) — was already lazily `await import(...)`-ed at
 * its call site in the original code and is kept exactly as-is, with only the
 * relative path prefix adjusted from `./x` (relative to `services/`) to
 * `../../services/x` (relative to `emma/impl/`).
 *
 * No stale-mock regressions beyond the standard `publishRevalidationForwarding`
 * drift guard (`twitter_manage_post` is the only publish-capable tool in this
 * cluster — `twitter_outreach` is a send-tool, not publish-capable, per
 * `utils/schedulePublishAuthorization.ts`), fixed identically to clusters
 * 12/16 — see that test file's `emma/impl/twitter` mock.
 */
import { twitterService, runWithXActingUser } from '../../services/twitterService';
import { describeXApiError } from '../../utils/twitterErrors';
import { isPublishConsentWithdrawn } from '../../utils/publishConsentWithdrawn';
import { publishWithdrawnMidFlight } from '../../utils/scheduledPublishConsentGuard';

/**
 * Dispatch Twitter/X interaction actions for Emma via the official X API.
 * Posting a single tweet is handled by post_on_connected_account (TwitterAdapter).
 * This method covers all other interactions: reply, thread, edit, delete, like,
 * retweet, follow, DMs, search, bookmarks, and profile lookup.
 *
 * Every action requires an account owned by the caller or shared with their org.
 * The owner's userId is passed to twitterService so refreshed OAuth tokens are
 * written back to the owner's record. When list_id/lead_id/lead_email are
 * supplied, sent tweets and DMs are logged to AW-EmailEvents for CRM parity.
 */
// Public entry: bind the acting user into the X metering context so every X
// call this dispatch makes attributes the shadow ledger to the ACTING user and
// bills the account owner (ENG-664 Option B, matching the LLM rail).
export async function twitterManagePost(userId: string, args: any, toolContext?: any): Promise<any> {
  return runWithXActingUser(userId, () => _twitterManagePostImpl(userId, args, toolContext));
}

async function _twitterManagePostImpl(userId: string, args: any, toolContext?: any): Promise<any> {
  let { account_id } = args;
  const action = (args.action as string)?.replace(/_/g, '-');
  const { text, in_reply_to_tweet_id, tweet_id, handle, recipient_handle, list_id, lead_id, lead_email, query, max_results } = args;
  // ENG-1607: models frequently pass array args as a JSON-encoded string or a single
  // string; that used to fail a valid request as a handler error. Coerce once here.
  const tweets = coerceStringArray(args.tweets);
  const tweet_ids = coerceStringArray(args.tweet_ids);
  console.log(`[AgentMode] twitterManagePost called: action=${action}, account_id=${account_id}`);

  const { getAccountsWithOwnerIncludingOrgShared } = await import('../../services/connectedAccountsDb');
  const twitterAccounts = (await getAccountsWithOwnerIncludingOrgShared(userId))
    .filter((a: any) => a.platform === 'twitter');

  if (twitterAccounts.length === 0) {
    return {
      success: false,
      error_type: 'auth_required',
      retryable: false,
      error: 'No X (Twitter) account is connected. Connect your X account in Settings → Connected Accounts.',
    };
  }

  let account: any;
  if (account_id) {
    account = twitterAccounts.find((a: any) => a.account_id === account_id);
    if (!account) {
      return { success: false, error: `X account ${account_id} is not connected to your profile.` };
    }
  } else if (twitterAccounts.length === 1) {
    account = twitterAccounts[0];
  } else {
    return {
      success: false,
      error: 'Multiple X accounts are connected — specify account_id. Use list_connected_accounts(platform="twitter").',
    };
  }

  const ownerUserId = account.userId;
  account_id = account.account_id;

  // ENG-827: last-moment publish-consent re-check, after the account resolution
  // above (which scans every account shared with the owner's org) and immediately
  // before the switch — every publishing branch writes on its first statement, so
  // there is no window left after this point. Self-scoping: the dispatcher attaches
  // the hook only for a call it classified as publishing, so a metrics or list read
  // reaches this line with nothing to run and pays nothing.
  const withdrawnBeforeTweet = await publishWithdrawnMidFlight(toolContext);
  if (withdrawnBeforeTweet) return withdrawnBeforeTweet;

  // Best-effort CRM logging — never fails the action.
  const logCrm = async (
    eventType: 'twitter.tweet.sent' | 'twitter.dm.sent',
    messageProviderId: string,
    bodyText: string
  ): Promise<void> => {
    if (!list_id || !lead_id || !lead_email) return;
    try {
      const { emailEventsDb } = await import('../../services/emailEventsDb');
      await emailEventsDb.addTwitterMessageEvent({
        eventId: `twitter_${eventType.includes('dm') ? 'dm' : 'tweet'}_${messageProviderId}`,
        emailDomain: `twitter-${list_id}`,
        leadEmail: lead_email,
        eventType,
        text: bodyText ?? null,
        timestamp: new Date().toISOString(),
        senderId: account_id,
        messageProviderId,
      });
    } catch (e) {
      console.error('[AgentMode] twitterManagePost CRM logging failed (non-fatal):', e);
    }
  };

  try {
    switch (action) {
      case 'reply': {
        if (!text) throw new TwitterManagePostValidationError('text is required for reply');
        if (!in_reply_to_tweet_id) throw new TwitterManagePostValidationError('in_reply_to_tweet_id is required for reply');
        // ENG-827: the hook goes down so the check also covers the client resolution
        // and any token refresh inside the call — the last work before the write.
        const result = await twitterService.postTweet(ownerUserId, account_id, text, {
          inReplyToTweetId: in_reply_to_tweet_id,
        }, toolContext?.assertPublishStillAuthorized);
        await logCrm('twitter.tweet.sent', result.id, result.text);
        return { success: true, data: result };
      }

      case 'post-thread': {
        if (!Array.isArray(tweets) || tweets.length === 0) {
          throw new TwitterManagePostValidationError('tweets (non-empty array of strings) is required for post-thread');
        }
        if (tweets.length < 2) {
          throw new TwitterManagePostValidationError('post_thread requires at least 2 tweets. To post a single tweet, use post_on_connected_account instead.');
        }
        // ENG-827 (Greptile): a thread is N separate public writes. The check above
        // covers the first tweet only, so consent is re-read before each subsequent
        // one and the thread stops the moment it is withdrawn.
        const result = await twitterService.postThread(
          ownerUserId, account_id, tweets,
          toolContext?.assertPublishStillAuthorized
        );
        if (result[0]) await logCrm('twitter.tweet.sent', result[0].id, result[0].text);
        if (result.length < tweets.length) {
          // Report the truncation rather than a clean success: those tweets are
          // public and cannot be un-made, and the owner needs to know the thread is
          // a fragment so they can finish or delete it.
          return {
            success: false,
            message:
              `Publishing consent was withdrawn part-way through the thread. ${result.length} of ` +
              `${tweets.length} tweets were already posted and cannot be un-posted; the rest were ` +
              `not sent. Do NOT retry — tell the owner the thread is incomplete so they can finish ` +
              `or remove it.`,
            data: result,
          };
        }
        return { success: true, data: result };
      }

      case 'quote-tweet': {
        if (!text) throw new TwitterManagePostValidationError('text is required for quote_tweet');
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for quote_tweet');
        const result = await twitterService.quoteTweet(ownerUserId, account_id, text, tweet_id, toolContext?.assertPublishStillAuthorized);
        await logCrm('twitter.tweet.sent', result.id, result.text);
        return { success: true, data: result };
      }

      case 'delete-tweet': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for delete-tweet');
        const result = await twitterService.deleteTweet(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'like': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for like');
        const result = await twitterService.likeTweet(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'unlike': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for unlike');
        const result = await twitterService.unlikeTweet(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'retweet': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for retweet');
        const result = await twitterService.retweetTweet(ownerUserId, account_id, tweet_id, toolContext?.assertPublishStillAuthorized);
        return { success: true, data: result };
      }

      case 'unretweet': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for unretweet');
        const result = await twitterService.unretweetTweet(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'get-tweet-metrics': {
        if (!tweet_ids?.length) throw new TwitterManagePostValidationError('tweet_ids is required for get_tweet_metrics');
        const result = await twitterService.getTweetMetrics(ownerUserId, account_id, tweet_ids);
        return { success: true, data: result };
      }

      case 'list-replies': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for list_replies');
        const result = await twitterService.listReplies(ownerUserId, account_id, tweet_id, max_results);
        return { success: true, data: result };
      }

      case 'get-retweeters': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for get_retweeters');
        const result = await twitterService.getRetweeters(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'get-liking-users': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for get_liking_users');
        const result = await twitterService.getLikingUsers(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'get-quote-tweets': {
        if (!tweet_id) throw new TwitterManagePostValidationError('tweet_id is required for get_quote_tweets');
        const result = await twitterService.getQuoteTweets(ownerUserId, account_id, tweet_id, max_results);
        return { success: true, data: result };
      }

      default: {
        const validActions = [
          'reply', 'post-thread', 'quote-tweet',
          'delete-tweet',
          'like', 'unlike', 'retweet', 'unretweet',
          'list-replies', 'get-tweet-metrics',
          'get-retweeters', 'get-liking-users', 'get-quote-tweets',
        ];
        throw new TwitterManagePostValidationError(`Unsupported twitter_manage_post action: "${action}". Valid actions are: ${validActions.join(', ')}`);
      }
    }
  } catch (error) {
    // ENG-827: a write abandoned because the owner withdrew consent is a deliberate
    // stop, not an X failure. Reporting it as "Twitter action failed" would invite a
    // retry of the very thing the owner just said no to.
    if (isPublishConsentWithdrawn(error)) {
      console.warn('[AgentMode] ENG-827: twitter_manage_post stopped — publish consent was withdrawn before the write.');
      return { success: false, error: error.message };
    }
    // Surface X's real ApiResponseError payload (title/detail/errors) instead of
    // collapsing to a bare "Request failed with code 403" — see describeXApiError.
    const errorMessage = describeXApiError(error);
    console.error('AgentMode: twitter_manage_post failed:', errorMessage);
    // ENG-1300: same gap as twitterOutreach's catch — this flattens every thrown
    // error to a message string, which is all toolResultError has to reconstruct
    // an Error from downstream, so the numeric HTTP status (twitter-api-v2 puts
    // it on `.code`) must ride along on the result object or a write-path 401/403
    // (e.g. a reply blocked by X's engagement-gate scope) never classifies as
    // auth/config either.
    const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
    const errorType = classifyTwitterManagePostError(error, code);
    return {
      success: false,
      message: TWITTER_ERROR_MESSAGES[errorType],
      error: errorMessage,
      error_type: errorType,
      retryable: errorType === 'rate_limited' || errorType === 'api',
      ...(code !== undefined ? { code } : {}),
    };
  }
}

/** ENG-1607: thrown by the handler for missing/malformed inputs: a caller error, not an X failure. */
class TwitterManagePostValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'TwitterManagePostValidationError'; }
}

export type TwitterManagePostErrorType = 'auth_required' | 'rate_limited' | 'validation' | 'credits_exhausted' | 'api';

const TWITTER_ERROR_MESSAGES: Record<TwitterManagePostErrorType, string> = {
  auth_required: 'X authorization failed (expired token or missing scope). Reconnect the X account in Settings → Connected Accounts; do not retry until it is reconnected.',
  rate_limited: 'X rate limit reached. Wait and retry later.',
  validation: 'Invalid twitter_manage_post input. Fix the arguments and retry.',
  credits_exhausted: 'X API credits are exhausted. Do not retry.',
  api: 'Twitter action failed',
};

/** ENG-1607: separate auth/config failures from handler/API failures so they cluster honestly. */
export function classifyTwitterManagePostError(error: unknown, code: number | undefined): TwitterManagePostErrorType {
  if (error instanceof TwitterManagePostValidationError) return 'validation';
  if (code === 402 || (error as any)?.name === 'XCreditsExhaustedError') return 'credits_exhausted';
  if (code === 429) return 'rate_limited';
  if (code === 401 || code === 403) return 'auth_required';
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (/no (access|refresh) token|token (has )?expired|invalid_grant|reconnect/i.test(msg)) return 'auth_required';
  return 'api';
}

/** ENG-1607: accept a real array, a JSON-encoded array string, or a single string. */
function coerceStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try { const parsed = JSON.parse(t); if (Array.isArray(parsed)) return parsed.map(String); } catch { /* fall through */ }
    }
    return t ? [t] : [];
  }
  return undefined;
}

// Public entry: bind the acting user into the X metering context (see twitterManagePost).
export async function twitterOutreach(userId: string, args: any): Promise<any> {
  return runWithXActingUser(userId, () => _twitterOutreachImpl(userId, args));
}

async function _twitterOutreachImpl(userId: string, args: any): Promise<any> {
  let { account_id } = args;
  const action = (args.action as string)?.replace(/_/g, '-');
  const { text, handle, recipient_handle, query, max_results, tweet_id, x_list_id, list_name, list_id, lead_id, lead_email } = args;
  console.log(`[AgentMode] twitterOutreach called: action=${action}, account_id=${account_id}`);

  const { getAccountsWithOwnerIncludingOrgShared } = await import('../../services/connectedAccountsDb');
  const twitterAccounts = (await getAccountsWithOwnerIncludingOrgShared(userId))
    .filter((a: any) => a.platform === 'twitter');

  if (twitterAccounts.length === 0) {
    return {
      success: false,
      error: 'No X (Twitter) account is connected. Connect your X account in Settings → Connected Accounts.',
    };
  }

  let account: any;
  if (account_id) {
    account = twitterAccounts.find((a: any) => a.account_id === account_id);
    if (!account) {
      return { success: false, error: `X account ${account_id} is not connected to your profile.` };
    }
  } else if (twitterAccounts.length === 1) {
    account = twitterAccounts[0];
  } else {
    return {
      success: false,
      error: 'Multiple X accounts are connected — specify account_id. Use list_connected_accounts(platform="twitter").',
    };
  }

  const ownerUserId = account.userId;
  account_id = account.account_id;

  const logCrm = async (messageProviderId: string, bodyText: string): Promise<void> => {
    if (!list_id || !lead_id || !lead_email) return;
    try {
      const { emailEventsDb } = await import('../../services/emailEventsDb');
      await emailEventsDb.addTwitterMessageEvent({
        eventId: `twitter_dm_${messageProviderId}`,
        emailDomain: `twitter-${list_id}`,
        leadEmail: lead_email,
        eventType: 'twitter.dm.sent',
        text: bodyText ?? null,
        timestamp: new Date().toISOString(),
        senderId: account_id,
        messageProviderId,
      });
    } catch (e) {
      console.error('[AgentMode] twitterOutreach CRM logging failed (non-fatal):', e);
    }
  };

  try {
    switch (action) {
      case 'get-profile': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for get_profile');
        const result = await twitterService.getProfile(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'follow': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for follow');
        const result = await twitterService.followUser(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'unfollow': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for unfollow');
        const result = await twitterService.unfollowUser(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'list-followers': {
        const target = handle || recipient_handle;
        const result = await twitterService.listFollowers(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'list-following': {
        const target = handle || recipient_handle;
        const result = await twitterService.listFollowing(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'search-tweets': {
        if (!query) throw new Error('query is required for search_tweets');
        const result = await twitterService.searchTweets(ownerUserId, account_id, query, max_results);
        return { success: true, data: result };
      }

      case 'get-user-tweets': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for get_user_tweets');
        const result = await twitterService.getUserTweets(ownerUserId, account_id, target, max_results);
        return { success: true, data: result };
      }

      case 'send-dm': {
        const target = recipient_handle || handle;
        if (!target) throw new Error('handle is required for send_dm');
        if (!text) throw new Error('text is required for send_dm');
        const result = await twitterService.sendDm(ownerUserId, account_id, target, text);
        await logCrm(result?.dm_event_id || `${account_id}_dm`, text);
        return { success: true, data: result };
      }

      case 'list-dms': {
        const result = await twitterService.listDms(ownerUserId, account_id);
        return { success: true, data: result };
      }

      case 'get-dm-conversation': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for get_dm_conversation');
        const result = await twitterService.getDmConversation(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'bookmark': {
        if (!tweet_id) throw new Error('tweet_id is required for bookmark');
        const result = await twitterService.bookmarkTweet(ownerUserId, account_id, tweet_id);
        return { success: true, data: result };
      }

      case 'get-bookmarks': {
        const result = await twitterService.getBookmarks(ownerUserId, account_id);
        return { success: true, data: result };
      }

      case 'get-liked-tweets': {
        const target = handle || recipient_handle;
        const result = await twitterService.getLikedTweets(ownerUserId, account_id, target, max_results);
        return { success: true, data: result };
      }

      case 'list-owned-lists': {
        const result = await twitterService.getOwnedLists(ownerUserId, account_id);
        return { success: true, data: result };
      }

      case 'get-list-members': {
        const listId = x_list_id
          || (list_name ? await twitterService.resolveOwnedListIdByName(ownerUserId, account_id, list_name) : undefined);
        if (!listId) throw new Error('x_list_id or list_name is required for get_list_members');
        const result = await twitterService.getListMembers(ownerUserId, account_id, listId);
        return { success: true, data: result };
      }

      case 'get-list-tweets': {
        const listId = x_list_id
          || (list_name ? await twitterService.resolveOwnedListIdByName(ownerUserId, account_id, list_name) : undefined);
        if (!listId) throw new Error('x_list_id or list_name is required for get_list_tweets');
        const result = await twitterService.getListTweets(ownerUserId, account_id, listId, max_results);
        return { success: true, data: result };
      }

      case 'block': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for block');
        const result = await twitterService.blockUser(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'unblock': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for unblock');
        const result = await twitterService.unblockUser(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'mute': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for mute');
        const result = await twitterService.muteUser(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      case 'unmute': {
        const target = handle || recipient_handle;
        if (!target) throw new Error('handle is required for unmute');
        const result = await twitterService.unmuteUser(ownerUserId, account_id, target);
        return { success: true, data: result };
      }

      default: {
        const validActions = [
          'get-profile', 'follow', 'unfollow', 'list-followers', 'list-following',
          'search-tweets', 'get-user-tweets',
          'send-dm', 'list-dms', 'get-dm-conversation',
          'bookmark', 'get-bookmarks', 'get-liked-tweets',
          'list-owned-lists', 'get-list-members', 'get-list-tweets',
          'block', 'unblock', 'mute', 'unmute',
        ];
        throw new Error(`Unsupported twitter_outreach action: "${action}". Valid actions are: ${validActions.join(', ')}`);
      }
    }
  } catch (error) {
    // Surface X's real ApiResponseError payload (title/detail/errors) instead of
    // collapsing to a bare "Request failed with code 403" — see describeXApiError.
    const errorMessage = describeXApiError(error);
    console.error('AgentMode: twitter_outreach failed:', errorMessage);
    // ENG-1300: this catch flattens every thrown error (including
    // mapListScopeError's reconnect error) to a message string, which is all
    // toolResultError has to reconstruct an Error from downstream — so the
    // numeric HTTP status (twitter-api-v2's ApiResponseError, and our own
    // mapListScopeError, both put it on `.code`) must ride along on the result
    // object itself or classifyToolErrorClass never sees it and the whole
    // auth/config classification this ticket exists for silently never fires.
    const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
    return { success: false, message: 'Twitter outreach action failed', error: errorMessage, ...(code !== undefined ? { code } : {}) };
  }
}
