/**
 * ENG-2898 (ENG-2847.8): read-only, own-account CRM / landing-page conversion
 * summary for aw_ keys.
 *
 * Identity comes only from the runtime context. Data is read through the
 * caller's own-scoped REST routes; org-member lists/pages those routes merge in
 * are dropped so only the caller's account is aggregated. The output is counts
 * keyed by id/name only: no lead fields, no emails, no URLs.
 *
 * No new index: the lead scan is bounded (MAX_LEADS_SCANNED) and the result
 * says `truncated: true` when the bound is hit.
 */
import { isSessionList } from '../../utils/sessionList';
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';

export const MAX_RANGE_DAYS = 366;
export const MAX_LEADS_SCANNED = 10_000;
// 200: the leads route fails (InternalFailure) on 500-lead pages of very large lists.
const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;

function parseDay(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`${field} must be a date in YYYY-MM-DD format`);
  }
  const ms = Date.parse(`${value.trim()}T00:00:00.000Z`);
  // Round-trip: Date.parse rolls impossible days (2026-02-30) into the next month.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value.trim()) {
    throw new Error(`${field} is not a valid date`);
  }
  return ms;
}

/** Inclusive [start 00:00Z, end 23:59:59.999Z]; default last 30 days. */
const isUnset = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && !v.trim());

export function resolveRange(args: any, now = Date.now()): { startMs: number; endMs: number; start: string; end: string } {
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const end = !isUnset(args?.end_date) ? parseDay(args.end_date, 'end_date') : today;
  const start = !isUnset(args?.start_date) ? parseDay(args.start_date, 'start_date') : end - 29 * DAY_MS;
  if (start > end) throw new Error('start_date must be on or before end_date');
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(`Date range is ${days} days; the maximum is ${MAX_RANGE_DAYS} days`);
  }
  return {
    startMs: start,
    endMs: end + DAY_MS - 1,
    start: new Date(start).toISOString().slice(0, 10),
    end: new Date(end).toISOString().slice(0, 10),
  };
}

const urlKey = (raw: unknown): string => {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    return (u.host + u.pathname.replace(/\/$/, '')).toLowerCase();
  } catch {
    return '';
  }
};

// lp_id, lpId, landing-page-id all match: compare letters only, case-insensitive.
const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z]/g, '');

function leadField(lead: any, ...keys: string[]): string {
  const wanted = new Set(keys.map(normKey));
  const bags = [lead?.customFields, lead?.lastTouch, lead?.firstTouch, lead?.lastTouch?.extraParams, lead?.firstTouch?.extraParams];
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [k, v] of Object.entries(bag)) {
      if (wanted.has(normKey(k)) && typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

mcpToolRegistry.register({
  name: 'get_conversion_summary',
  readOnly: true,
  definition: {
    name: 'get_conversion_summary',
    description: `Aggregate lead/conversion counts for your own account over a date range (default: last 30 days, max ${MAX_RANGE_DAYS} days): per landing page (unique leads and form-submission conversions), per lead list (leads added), and totals. Counts only — no lead details. Only your own lists and pages are included.`,
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD (UTC)' },
        end_date: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD (UTC). Default: today' },
      },
      required: [],
    },
  },
  execute: async (args: any, context: any) => {
    if (args && (args.client_id !== undefined || args.user_id !== undefined || args.userId !== undefined)) {
      throw new Error('get_conversion_summary only reports on your own account; client_id/user_id are not accepted');
    }
    const range = resolveRange(args);
    const scoped = ctx(context);
    const ownerId = scoped.userId;

    const listsRaw = await mcpFetch({ method: 'GET', path: '/api/crm/lists', context: scoped });
    const listId = (l: any): string => String(l?.listId ?? l?.id ?? '');
    const lists = (Array.isArray(listsRaw) ? listsRaw : [])
      .filter((l: any) => l && listId(l) && !l.fromOrgMember && !isSessionList(l) && (!l.userId || l.userId === ownerId));

    const pagesRaw = await mcpFetch({ method: 'GET', path: '/api/landing-pages/v0/generated', context: scoped });
    const pages = (Array.isArray(pagesRaw?.pages) ? pagesRaw.pages : [])
      .filter((p: any) => p && p.id && p.userId === ownerId);
    const pageIdLower = new Map<string, string>(pages.map((p: any) => [String(p.id).toLowerCase(), String(p.id)]));
    const pageByUrl = new Map<string, string>();
    for (const p of pages) {
      for (const u of [p.customDomainUrl, p.deployedUrl]) {
        const k = urlKey(u);
        if (k) pageByUrl.set(k, String(p.id));
      }
    }

    const lpStats = new Map<string, { conversions: number; emails: Set<string>; anon: number }>();
    const listRows: Array<{ list_id: string; name: string | null; list_type: string | null; leads: number }> = [];
    let scanned = 0;
    let truncated = false;
    let totalLeads = 0;
    const skippedLists: Array<{ list_id: string; name: string | null }> = [];

    for (const list of lists) {
      const id = listId(list);
      let count = 0;
      let page = 1;
      let failed = false;
      while (!truncated) {
        let res: any;
        try {
          res = await mcpFetch({
            method: 'GET',
            path: `/api/crm/lists/${encodeURIComponent(id)}/leads`,
            context: scoped,
            queryParams: { page: String(page), limit: String(PAGE_SIZE), engagedOnly: 'false' },
          });
        } catch {
          failed = true;
          break;
        }
        const leads: any[] = Array.isArray(res?.leads) ? res.leads : [];
        for (const lead of leads) {
          if (scanned >= MAX_LEADS_SCANNED) { truncated = true; break; }
          scanned++;
          const created = Date.parse(lead?.createdAt ?? '');
          if (Number.isNaN(created) || created < range.startMs || created > range.endMs) continue;
          count++;
          const idHit = leadField(lead, 'landingPageId', 'lpId', 'landing_page_id', 'sourceId');
          const pageId = idHit && pageIdLower.has(idHit.toLowerCase())
            ? pageIdLower.get(idHit.toLowerCase())
            : pageByUrl.get(urlKey(leadField(lead, 'landingUrl', 'landingPageUrl', 'pageUrl')));
          if (!pageId) continue;
          const s = lpStats.get(pageId) ?? { conversions: 0, emails: new Set<string>(), anon: 0 };
          s.conversions++;
          if (typeof lead?.email === 'string' && lead.email.trim()) s.emails.add(lead.email.trim().toLowerCase());
          else s.anon++;
          lpStats.set(pageId, s);
        }
        if (!res?.hasMore || leads.length === 0) break;
        page++;
      }
      if (failed) {
        skippedLists.push({ list_id: id, name: list.name ?? null });
        continue;
      }
      totalLeads += count;
      listRows.push({ list_id: id, name: list.name ?? null, list_type: list.listType ?? null, leads: count });
      if (truncated) break;
    }

    const landingPages = pages.map((p: any) => {
      const s = lpStats.get(String(p.id));
      return {
        page_id: String(p.id),
        name: p.name ?? null,
        leads: s ? s.emails.size + s.anon : 0,
        conversions: s ? s.conversions : 0,
      };
    });

    return jsonResult({
      range: { start_date: range.start, end_date: range.end },
      totals: {
        leads: totalLeads,
        landing_page_conversions: landingPages.reduce((n: number, p: any) => n + p.conversions, 0),
        lists: listRows.length,
        landing_pages: landingPages.length,
      },
      landing_pages: landingPages,
      lists: listRows,
      truncated,
      ...(skippedLists.length ? { skipped_lists: skippedLists, skipped_note: 'These lists could not be read; their leads are not counted.' } : {}),
      ...(truncated ? { note: `Stopped after scanning ${MAX_LEADS_SCANNED} leads; counts are partial and cover only the lists scanned so far.` } : {}),
    });
  },
});
