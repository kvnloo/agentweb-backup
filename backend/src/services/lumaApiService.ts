/**
 * Thin client for Luma's public API (ENG-2338). Keys are per-calendar and need a
 * Luma Plus subscription.
 *
 * @see https://docs.luma.com/reference/getting-started-with-your-api
 */

const LUMA_PUBLIC_API = 'https://public-api.luma.com';

// Test-only redirect to a fake Luma. Ignored in production so a stray env var can never send
// customers' API keys to another host. Read at call time, not module load: dotenv runs after the
// imports in server.ts, so a load-time read would silently miss a value from .env.
function lumaApiBase(): string {
  const override = process.env.LUMA_API_BASE_URL;
  // Allowlist, not `!== 'production'`: a mis-set NODE_ENV on a real server must not be able to redirect keys.
  const env = process.env.NODE_ENV;
  return (env === 'development' || env === 'test') && override ? override : LUMA_PUBLIC_API;
}
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 25;

export class LumaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LumaApiError';
  }

  /** The key itself was rejected (revoked, or the Plus subscription lapsed). */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /** The key is valid but not allowed to see this resource, e.g. an event on another calendar. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export interface LumaCalendar {
  id: string;
  name: string;
  url?: string;
}

export interface LumaEventSummary {
  event_id: string;
  name: string;
  start_at?: string;
  end_at?: string;
  timezone?: string;
  url?: string;
}

export interface LumaGuest {
  guest_id: string;
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  approval_status: string;
  registered_at: string | null;
  phone_number: string | null;
  registration_answers: unknown[] | null;
}

export interface LumaGuestPage {
  guests: LumaGuest[];
  has_more: boolean;
  next_cursor?: string;
  /** Entries dropped for having no registered_at (shown to the model so the omission is never silent). */
  skippedWithoutRegistration: number;
  /** Set when a later page failed after earlier ones succeeded; next_cursor resumes at the failed page. */
  interrupted?: string;
}

/**
 * Normalises a user/model-supplied date to the full ISO 8601 UTC form Luma documents.
 * A bare date or an offset-less datetime is read as UTC: `Date.parse` would read the
 * latter in the server's local zone, so the same input could mean different instants.
 */
export function normalizeIsoUtc(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let candidate = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) candidate = `${raw}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) candidate = `${raw}Z`;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Pulls the `evt-...` id out of a bare id or any Luma event/manage URL. */
export function parseLumaEventId(input: string): string | null {
  // Not preceded by a word char, so a slug like "my-evt-launch" is not mistaken for an id.
  const match = /(?<![A-Za-z0-9-])evt-[A-Za-z0-9]+/.exec(input || '');
  return match ? match[0] : null;
}

export class LumaApiService {
  constructor(private readonly apiKey: string) {}

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<any> {
    const url = new URL(path, lumaApiBase());
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'x-luma-api-key': this.apiKey, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        throw new LumaApiError(aborted ? 'Luma did not respond in time' : 'Could not reach Luma', 0);
      }

      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new LumaApiError(
          `Luma API returned ${response.status}`,
          response.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new LumaApiError('Luma returned an unreadable response', 0);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async getCalendar(): Promise<LumaCalendar> {
    const data = await this.get('/v1/calendars/get', {});
    if (!data?.id) throw new LumaApiError('Luma returned no calendar for this key', 0);
    return { id: data.id, name: data.name || data.id, url: data.url };
  }

  async listEvents(opts: { after?: string; before?: string; cursor?: string; limit?: number } = {}): Promise<{
    events: LumaEventSummary[];
    has_more: boolean;
    next_cursor?: string;
  }> {
    const data = await this.get('/v1/calendars/events/list', {
      after: opts.after,
      before: opts.before,
      pagination_cursor: opts.cursor,
      pagination_limit: Math.min(opts.limit ?? 25, PAGE_SIZE),
      sort_column: 'start_at',
      sort_direction: 'desc',
    });
    const events: LumaEventSummary[] = (data.entries || []).map((e: any) => ({
      event_id: e.id,
      name: e.name,
      start_at: e.start_at,
      end_at: e.end_at,
      timezone: e.timezone,
      url: e.url,
    }));
    return { events, has_more: !!data.has_more, next_cursor: data.next_cursor };
  }

  /**
   * One bounded read of an event's guest list, newest registration first.
   *
   * Entries with no `registered_at` are invited-but-never-registered records that
   * carry no real identity, so they are dropped unless the caller explicitly asks
   * for the `invited` status. Paging stops once a page crosses `registeredAfter`
   * (the list is sorted newest-first, so everything beyond it is older). The page size
   * is capped at `maxGuests`, so a small cap really does bound the result; a page is
   * never split, so the returned cursor always resumes exactly where this read stopped.
   */
  async listGuests(opts: {
    eventId: string;
    approvalStatus?: string;
    registeredAfter?: string;
    cursor?: string;
    maxGuests: number;
  }): Promise<LumaGuestPage> {
    const keepUnregistered = opts.approvalStatus === 'invited';
    // Invited rows have no registration time to compare against, so the cutoff cannot apply to them.
    const cutoff = opts.registeredAfter && !keepUnregistered ? Date.parse(opts.registeredAfter) : NaN;
    const guests: LumaGuest[] = [];
    let cursor = opts.cursor;
    let hasMore = true;
    let skipped = 0;
    let pages = 0;
    let crossedCutoff = false;
    let interrupted: string | undefined;

    while (hasMore && !crossedCutoff && guests.length < opts.maxGuests && pages < MAX_PAGES) {
      let data: any;
      try {
        data = await this.get('/v1/events/guests/list', {
          event_id: opts.eventId,
          approval_status: opts.approvalStatus,
          pagination_cursor: cursor,
          pagination_limit: Math.min(PAGE_SIZE, Math.max(1, opts.maxGuests)),
          sort_column: 'registered_at',
          sort_direction: 'desc nulls last',
        });
      } catch (error) {
        // Keep what earlier pages already returned: throwing would discard them and make the
        // caller restart from page one against a 200 req/min budget. `cursor` still points at
        // the page that failed, so resuming from it loses and repeats nothing.
        if (pages === 0 || (error instanceof LumaApiError && (error.isAuthFailure || error.isForbidden))) throw error;
        interrupted = error instanceof Error ? error.message : 'request failed';
        break;
      }
      pages += 1;
      hasMore = !!data.has_more;
      cursor = data.next_cursor;
      // has_more without a cursor cannot be resumed; re-reading page one would return duplicates.
      if (hasMore && !cursor) hasMore = false;

      let registeredOnPage = 0;
      for (const g of data.entries || []) {
        if (!g.registered_at && !keepUnregistered) {
          skipped += 1;
          continue;
        }
        registeredOnPage += 1;
        if (g.registered_at && Number.isFinite(cutoff) && Date.parse(g.registered_at) < cutoff) {
          crossedCutoff = true;
          continue;
        }
        guests.push({
          guest_id: g.id,
          email: g.user_email,
          name: g.user_name ?? null,
          first_name: g.user_first_name ?? null,
          last_name: g.user_last_name ?? null,
          approval_status: g.approval_status,
          registered_at: g.registered_at ?? null,
          phone_number: g.phone_number ?? null,
          registration_answers: g.registration_answers ?? null,
        });
      }
      // Sorted `desc nulls last`, so a page with NO registered rows means everything after it is unregistered too:
      // stop instead of paging through up to 25 pages of them against the rate limit. Judged per PAGE, not per
      // row, so a mixed page (if Luma ever interleaves them) keeps going rather than silently truncating the list.
      if (!keepUnregistered && (data.entries || []).length > 0 && registeredOnPage === 0) crossedCutoff = true;
    }

    const exhausted = !interrupted && (crossedCutoff || !hasMore);
    return {
      guests,
      has_more: !exhausted,
      next_cursor: exhausted ? undefined : cursor,
      skippedWithoutRegistration: skipped,
      ...(interrupted ? { interrupted } : {}),
    };
  }
}
