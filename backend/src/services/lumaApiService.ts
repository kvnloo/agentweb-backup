/**
 * Thin client for Luma's public API (ENG-2338). Keys are per-calendar and need a
 * Luma Plus subscription.
 *
 * @see https://docs.luma.com/reference/getting-started-with-your-api
 */

const LUMA_API_BASE = 'https://public-api.luma.com';
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

  /** The key was rejected: revoked, wrong calendar, or the Plus subscription lapsed. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
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
  /** Raw entries scanned, including ones skipped for having no registered_at. */
  scanned: number;
}

/** Pulls the `evt-...` id out of a bare id or any Luma event/manage URL. */
export function parseLumaEventId(input: string): string | null {
  const match = /evt-[A-Za-z0-9]+/.exec(input || '');
  return match ? match[0] : null;
}

export class LumaApiService {
  constructor(private readonly apiKey: string) {}

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<any> {
    const url = new URL(path, LUMA_API_BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'x-luma-api-key': this.apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new LumaApiError(aborted ? 'Luma did not respond in time' : 'Could not reach Luma', 0);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new LumaApiError(
        `Luma API returned ${response.status}`,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return response.json();
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
   * (the list is sorted newest-first, so everything beyond it is older). `maxGuests`
   * is checked between pages and a page is never split, so the returned cursor
   * always resumes exactly where this read stopped.
   */
  async listGuests(opts: {
    eventId: string;
    approvalStatus?: string;
    registeredAfter?: string;
    cursor?: string;
    maxGuests: number;
  }): Promise<LumaGuestPage> {
    const cutoff = opts.registeredAfter ? Date.parse(opts.registeredAfter) : NaN;
    const keepUnregistered = opts.approvalStatus === 'invited';
    const guests: LumaGuest[] = [];
    let cursor = opts.cursor;
    let hasMore = true;
    let scanned = 0;
    let pages = 0;
    let crossedCutoff = false;

    while (hasMore && !crossedCutoff && guests.length < opts.maxGuests && pages < MAX_PAGES) {
      const data = await this.get('/v1/events/guests/list', {
        event_id: opts.eventId,
        approval_status: opts.approvalStatus,
        pagination_cursor: cursor,
        pagination_limit: PAGE_SIZE,
        sort_column: 'registered_at',
        sort_direction: 'desc nulls last',
      });
      pages += 1;
      hasMore = !!data.has_more;
      cursor = data.next_cursor;

      for (const g of data.entries || []) {
        scanned += 1;
        if (!g.registered_at && !keepUnregistered) continue;
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
    }

    const exhausted = crossedCutoff || !hasMore;
    return { guests, has_more: !exhausted, next_cursor: exhausted ? undefined : cursor, scanned };
  }
}
