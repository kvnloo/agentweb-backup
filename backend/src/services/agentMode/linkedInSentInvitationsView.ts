/**
 * What `linkedin_outreach` action `list-sent-invitations` actually returns
 * (ENG-1718, delivering ENG-1609 AC #7).
 *
 * THE BUG. Two calls in iTrials/Sweta Sinha's sessions returned an empty `{}`
 * while an account-level invitation cooldown was actively firing (ENG-1132,
 * 2026-08-26). Emma's own suggested remedy — list the backlog, withdraw the stale
 * ones — was therefore not actionable, and neither she nor the customer could tell
 * whether the account had a backlog at all.
 *
 * ROOT CAUSE, verified in source:
 *   1. `linkedInOutreachService` constructs `new UnipileClient(dsn, apiKey)` with no
 *      options, so the SDK's `validateRequestPayloadLevel` defaults to `'warn'`.
 *   2. At `'warn'`, a 2xx body that fails the SDK's own response schema is logged to
 *      console and RETURNED UNCHANGED (`request-sender.js`, `validate()`); only
 *      `'error'` throws.
 *   3. The old handler asked one question — `Array.isArray(result.items)` — and on
 *      `false` returned `{ success: true, data: <that body> }`.
 * So any non-conforming 200 (an empty object, an error envelope, a gateway page
 * parsed as JSON, an upstream shape change) was reported as a SUCCESSFUL EMPTY
 * RESULT. Which specific body Unipile returned that day was never captured and is
 * NOT claimed here; the defect is that the handler cannot tell the difference.
 *
 * THE OTHER HALF. `list-sent-invitations` only ever read live. Our own cache,
 * `AW-UnipileSentInvitations`, is refreshed from the same wrapper by
 * `linkedInConnectionSyncCron` every ~10 minutes — and at the moment of that
 * incident it held 126 pending invitations for that exact account, synced four
 * minutes after she connected it. The ledger was never empty; nothing asked it.
 * (ENG-1132's "our own ledger has no record" is therefore incorrect.)
 *
 * WHAT THIS MODULE GUARANTEES. Every outcome is named. A caller can always tell
 * "you have N pending" from "you genuinely have none tracked" from "we could not
 * read them", and never receives a bare empty object again.
 */

/** Where the returned rows came from. Always reported to the caller. */
export type SentInvitationsSource = 'live' | 'cache' | 'none';

/**
 * One pending invitation, trimmed for context.
 *
 * `sent_at` is NOT cosmetic and was the field the old trim dropped: choosing which
 * invitations to withdraw requires their age, and `cancel-invitation` takes an id.
 * Without a date, "withdraw invitations older than N days" (ENG-1719) is
 * unimplementable from this action's output — which is why it was.
 */
export interface TrimmedSentInvitation {
  id: string | null;
  invited_user_id: string | null;
  invited_user_public_id: string | null;
  invited_user: string | null;
  sent_at: string | null;
}

export interface SentInvitationsView {
  items: TrimmedSentInvitation[];
  /** Total known pending for the account, which may exceed the trimmed `items`. */
  totalPending: number;
  source: SentInvitationsSource;
  cursor?: string | null;
  /** Always present. Explains the result, including when it is empty. */
  notice: string;
  /** True when the live read failed or came back in a shape the SDK could not validate. */
  liveUnavailable?: boolean;
}

/**
 * Cap on rows returned in one call. The original trim existed because full
 * invitation objects "grow ~10 entries/day and can reach 200+, causing severe
 * context window bloat in scheduled sessions" — a real constraint on accounts like
 * TFA Connect's (375 cached) that this must not undo. `totalPending` carries the
 * true size, so a capped list still tells the truth about the backlog.
 */
export const MAX_RETURNED_INVITATIONS = 50;

/** The envelope the Unipile SDK's own schema promises for this endpoint. */
function isConformingLiveResponse(raw: any): boolean {
  return !!raw && typeof raw === 'object' && Array.isArray(raw.items);
}

function trimLive(item: any): TrimmedSentInvitation {
  return {
    id: item?.id ?? null,
    invited_user_id: item?.invited_user_id ?? null,
    invited_user_public_id: item?.invited_user_public_id ?? null,
    invited_user: item?.invited_user ?? null,
    // `parsed_datetime` is the normalized one and can be null; `date` is the raw
    // string the schema always carries. Prefer the parsed value, fall back.
    sent_at: item?.parsed_datetime ?? item?.date ?? null,
  };
}

function trimCached(row: any): TrimmedSentInvitation {
  return {
    id: row?.invitationId ?? null,
    invited_user_id: null,
    invited_user_public_id: row?.invitedUserPublicId ?? null,
    invited_user: row?.invitedUserName ?? null,
    sent_at: row?.sentAt ?? null,
  };
}

export interface SentInvitationsDeps {
  /** The live Unipile read. May throw; may return a non-conforming body. */
  fetchLive: (accountId: string, cursor?: string) => Promise<any>;
  /** Our own pending-invitation ledger for this account. */
  fetchCached: (accountId: string) => Promise<any[]>;
}

const NOT_TRACKED_NOTICE =
  'No pending invitations are tracked in our system for this account. If LinkedIn is still '
  + 'refusing new invitations, the pending backlog causing it was most likely built up outside '
  + 'AgentWeb (invitations sent directly from LinkedIn), which we cannot see or withdraw for you. '
  + 'Ask the account owner to review and withdraw stale invitations from LinkedIn\'s own '
  + '"My Network → Sent" page.';

/**
 * Resolve the pending-invitation list for an account, naming its provenance.
 *
 * Order of preference, and why:
 *   1. A CONFORMING live response with rows — freshest and authoritative.
 *   2. The cache, whenever live is unusable OR live says zero while our ledger holds
 *      rows. A live zero during an active cooldown is precisely the observed
 *      failure; the ledger is refreshed every ~10 minutes and is the better answer.
 *   3. An explicit "not tracked here, likely sent outside AgentWeb" — only when both
 *      agree there is nothing.
 * Never a bare empty result.
 */
export async function getSentInvitationsView(
  accountId: string,
  cursor: string | undefined,
  deps: SentInvitationsDeps,
): Promise<SentInvitationsView> {
  let live: any;
  let liveUnavailable = false;
  let liveFailureDetail = '';
  try {
    live = await deps.fetchLive(accountId, cursor);
    if (!isConformingLiveResponse(live)) {
      liveUnavailable = true;
      liveFailureDetail = 'LinkedIn returned an unrecognised response for the sent-invitations list';
    }
  } catch (error) {
    liveUnavailable = true;
    liveFailureDetail = `the live sent-invitations read failed (${error instanceof Error ? error.message : 'unknown error'})`;
  }

  if (!liveUnavailable) {
    const items = (live.items as any[]).map(trimLive);
    if (items.length > 0) {
      return {
        items: items.slice(0, MAX_RETURNED_INVITATIONS),
        totalPending: items.length,
        source: 'live',
        cursor: live.cursor ?? null,
        notice:
          `${items.length} pending invitation${items.length === 1 ? '' : 's'} read live from LinkedIn`
          + `${items.length > MAX_RETURNED_INVITATIONS ? `; showing the first ${MAX_RETURNED_INVITATIONS}` : ''}.`
          + ' Each carries sent_at, so the stale ones can be identified by age.',
      };
    }
  }

  // Either live was unusable, or live said zero. Both are cases where our own
  // ledger is the better answer — and in the ENG-1132 incident it held 126 rows
  // for the very account that was reporting nothing.
  let cached: any[] = [];
  let cacheFailed = false;
  try {
    cached = await deps.fetchCached(accountId);
  } catch (error) {
    cacheFailed = true;
    console.error(`[linkedInSentInvitationsView] cache read failed for ${accountId}:`, error);
  }

  if (cached.length > 0) {
    const items = cached
      .map(trimCached)
      // Oldest first: these are the ones worth withdrawing to reclaim capacity.
      .sort((a, b) => String(a.sent_at ?? '').localeCompare(String(b.sent_at ?? '')));
    const preamble = liveUnavailable
      ? `The live read was unavailable — ${liveFailureDetail} — so this comes from our own records`
      : 'LinkedIn returned no pending invitations live, but our own records still hold them, so this comes from our records';
    return {
      items: items.slice(0, MAX_RETURNED_INVITATIONS),
      totalPending: items.length,
      source: 'cache',
      ...(liveUnavailable ? { liveUnavailable: true } : {}),
      notice:
        `${preamble} (last synced by the connection cron, typically within ~10 minutes). `
        + `${items.length} pending invitation${items.length === 1 ? '' : 's'}`
        + `${items.length > MAX_RETURNED_INVITATIONS ? `, showing the ${MAX_RETURNED_INVITATIONS} oldest` : ''}, oldest first.`,
    };
  }

  // Nothing anywhere. Say which kind of nothing it is — this is the distinction
  // AC #7 asks for, and the one the old bare `{}` destroyed.
  if (liveUnavailable) {
    return {
      items: [],
      totalPending: 0,
      source: 'none',
      liveUnavailable: true,
      notice:
        `Could not read this account's pending invitations: ${liveFailureDetail}`
        + `${cacheFailed ? ', and our own records could not be read either' : ', and we hold no cached records for it'}. `
        + 'This is NOT evidence that the account has no pending invitations — do not report it as such. '
        + 'Retry later, or ask the account owner to check LinkedIn\'s "My Network → Sent" page directly.',
    };
  }
  return {
    items: [],
    totalPending: 0,
    source: 'none',
    notice: NOT_TRACKED_NOTICE,
  };
}
