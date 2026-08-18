/**
 * ENG-926 §G Tier 1 — the two Meta reads.
 *
 * The request SHAPE is pinned here rather than assumed, for the same reason §F pins its
 * insights query: `promoted_object` is a nested edge, and asking for it without the
 * `{custom_event_type,pixel_id}` sub-selection returns the object with neither field. That
 * failure is silent — the call succeeds, every ad set simply looks like it promotes
 * nothing, and the check goes permanently green.
 */

import { fetchOptimisationInputs, MAX_PIXELS_CHECKED } from '../services/metaOptimisationCoverage';
import { META_GRAPH_TIMEOUT_MS } from '../utils/metaApiFetch';

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const fail = (error: any, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

/** Count fetch calls by URL fragment. Raw call totals are brittle: this function makes
 *  three different kinds of request (ad sets, per-pixel stats, ad-set insights), so a
 *  count-based assertion silently changes meaning whenever one of them is added. */
const callsTo = (fetchImpl: jest.Mock, fragment: string) =>
  fetchImpl.mock.calls.filter((c) => String(c[0]).includes(fragment)).length;

const adSet = (id: string, pixelId?: string, event = 'LEAD') => ({
  id,
  name: `Ad Set ${id}`,
  effective_status: 'ACTIVE',
  promoted_object: pixelId ? { custom_event_type: event, pixel_id: pixelId } : undefined,
});

/** Real `/stats?aggregation=event` shape — hourly buckets, each with its own `data` array. */
const statsBody = (byHour: Record<string, number>[]) => ({
  data: byHour.map((events, i) => ({
    start_time: `2026-08-16T${String(i).padStart(2, '0')}:00:00-0400`,
    aggregation: 'event',
    data: Object.entries(events).map(([value, count]) => ({ value, count })),
  })),
});

describe('fetchOptimisationInputs — the request shape', () => {
  it('asks for the promoted_object SUB-FIELDS, not just the object', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ data: [] }));
    await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('act_123/adsets');
    expect(decodeURIComponent(url)).toContain('effective_status');

    // Pinned individually rather than as one literal string, so reordering the sub-fields
    // does not fail while DROPPING one silently passes.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('custom_event_type');
    expect(decoded).toContain('pixel_id');
    // The load-bearing one: without it Meta returns `OTHER` with no name attached, and every
    // custom-conversion ad set becomes unjudgeable. That blindness hid 8 of the 13 delivering
    // conversion-optimised ad sets in production, all on the biggest-spending account.
    expect(decoded).toContain('custom_event_str');
  });

  it('reads the pixel with aggregation=event', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockResolvedValueOnce(ok(statsBody([{ Lead: 2 }])));
    await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    expect(String(fetchImpl.mock.calls[1][0])).toContain('px1/stats?aggregation=event');
  });
});

describe('fetchOptimisationInputs — what it returns', () => {
  it('folds every hourly bucket into one event set for the pixel', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockResolvedValueOnce(ok(statsBody([{ PageView: 3 }, { PageView: 5, Lead: 1 }, { scroll: 2 }])));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    expect(result.status).toBe('ok');
    expect(result.adSets).toHaveLength(1);
    expect(new Set(result.receivedEventsByPixel.px1)).toEqual(new Set(['PageView', 'Lead', 'scroll']));
  });

  it('follows ad-set pagination', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')], paging: { next: 'https://next' } }))
      .mockResolvedValueOnce(ok({ data: [adSet('b', 'px1')] }))
      .mockResolvedValueOnce(ok(statsBody([{ Lead: 1 }])));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.adSets.map((a: any) => a.id)).toEqual(['a', 'b']);
  });

  it('calls /stats ONCE per distinct pixel, not once per ad set', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1'), adSet('b', 'px1'), adSet('c', 'px2')] }))
      .mockResolvedValue(ok(statsBody([{ Lead: 1 }])));

    await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(callsTo(fetchImpl, '/stats')).toBe(2);   // two distinct pixels, not three ad sets
    expect(callsTo(fetchImpl, '/adsets')).toBe(1);
  });

  it('never reads a pixel no ad set promotes an event to', async () => {
    // An ad set with no promoted event cannot produce a finding, so its pixel is not worth
    // a Graph call on every account every day.
    const fetchImpl = jest.fn().mockResolvedValueOnce(ok({ data: [adSet('a', undefined)] }));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    expect(callsTo(fetchImpl, '/stats')).toBe(0);
    expect(result.receivedEventsByPixel).toEqual({});
  });
});

describe('fetchOptimisationInputs — failures must never read as "nothing arrives"', () => {
  it('OMITS a pixel whose stats call failed, rather than returning it empty', async () => {
    // Present-but-empty and absent both mean "cannot tell" downstream, but only omission
    // makes that impossible to misread as a pixel that received nothing.
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1'), adSet('b', 'px2')] }))
      .mockResolvedValueOnce(fail({ message: 'Missing Permission', code: 100 }))
      .mockResolvedValueOnce(ok(statsBody([{ Lead: 1 }])));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    expect(result.status).toBe('ok');
    expect(result.receivedEventsByPixel).not.toHaveProperty('px1');
    expect(result.receivedEventsByPixel.px2).toEqual(['Lead']);
  });

  it('omits a pixel that reported no events at all', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockResolvedValueOnce(ok({ data: [] }));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.receivedEventsByPixel).toEqual({});
  });

  it('survives a pixel call that throws', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockRejectedValueOnce(new Error('socket hang up'));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.status).toBe('ok');
    expect(result.receivedEventsByPixel).toEqual({});
  });

  it('returns fetch_error when the AD SETS cannot be read — there is no claim to test', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fail({ message: 'Invalid OAuth', code: 190 }));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    expect(result.status).toBe('fetch_error');
    expect(result.error).toContain('Invalid OAuth');
    expect(result.adSets).toEqual([]);
  });

  it('returns fetch_error when the ad-set request throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.status).toBe('fetch_error');
    expect(result.error).toContain('ECONNRESET');
  });

  it('reports pixels it skipped rather than silently checking fewer', async () => {
    // A check that quietly reduces its own coverage is indistinguishable from one that
    // passed. Haven already runs three pixels; the cap is not hypothetical.
    const many = Array.from({ length: MAX_PIXELS_CHECKED + 2 }, (_, i) => adSet(`a${i}`, `px${i}`));
    const fetchImpl = jest.fn().mockResolvedValueOnce(ok({ data: many })).mockResolvedValue(ok(statsBody([{ Lead: 1 }])));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);

    expect(Object.keys(result.receivedEventsByPixel)).toHaveLength(MAX_PIXELS_CHECKED);
    expect(result.pixelsNotChecked).toEqual([`px${MAX_PIXELS_CHECKED}`, `px${MAX_PIXELS_CHECKED + 1}`]);
  });

  it('ignores malformed bucket entries without poisoning the event set', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockResolvedValueOnce(ok({
        data: [
          { start_time: 'x', data: [{ value: 'Lead', count: 1 }, { value: '', count: 2 }, { count: 3 }, null] },
          { start_time: 'y', data: null },
          null,
        ],
      }));

    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.receivedEventsByPixel.px1).toEqual(['Lead']);
  });
});

describe('fetchOptimisationInputs — remaining shapes seen in the wild', () => {
  it('reports a non-ok HTTP response with no error body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.status).toBe('fetch_error');
    expect(result.error).toBe('HTTP 503');
  });

  it('reports a thrown non-Error rejection without losing the failure', async () => {
    const fetchImpl = jest.fn().mockRejectedValue({});
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result).toMatchObject({ status: 'fetch_error', error: 'request failed' });
  });

  it('stops paging when `next` is not a string', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')], paging: { next: 42 } }))
      .mockResolvedValueOnce(ok(statsBody([{ Lead: 1 }])));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.adSets).toHaveLength(1);
    expect(callsTo(fetchImpl, '/adsets')).toBe(1); // did not follow the non-string cursor
  });

  it('tolerates a response whose data is not an array', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ data: null }));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result).toMatchObject({ status: 'ok', adSets: [] });
  });

  it('stops following ad-set pages at the cap rather than looping forever', async () => {
    // A pathological `paging.next` that always points somewhere must terminate.
    const fetchImpl = jest.fn().mockResolvedValue(ok({ data: [adSet('a')], paging: { next: 'https://loop' } }));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.status).toBe('ok');
    expect(callsTo(fetchImpl, '/adsets')).toBeLessThanOrEqual(10);
  });

  it('treats a stats response carrying an error body as unreadable', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: { message: 'nope' } }) });
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.receivedEventsByPixel).toEqual({});
  });

  it('reports no skipped pixels when every one was read', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [adSet('a', 'px1')] }))
      .mockResolvedValueOnce(ok(statsBody([{ Lead: 1 }])));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(result.pixelsNotChecked).toEqual([]);
  });

  it('skips an ad set whose promoted_object has a pixel but no event', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(ok({
      data: [{ id: 'a', effective_status: 'ACTIVE', promoted_object: { pixel_id: 'px1' } }],
    }));
    const result = await fetchOptimisationInputs('123', 'tok', { fetchImpl } as any);
    expect(callsTo(fetchImpl, '/stats')).toBe(0);
    expect(result.receivedEventsByPixel).toEqual({});
  });

  it('uses the default fetch when no dep is injected', async () => {
    // Guards the `deps?.fetchImpl ?? fetch` fallback that production actually runs on.
    const spy = jest.spyOn(global, 'fetch' as any).mockResolvedValue(ok({ data: [] }) as any);
    const result = await fetchOptimisationInputs('123', 'tok');
    expect(result.status).toBe('ok');
    spy.mockRestore();
  });
});

describe('ENG-1326 — every Graph read is bounded', () => {
  it('passes an abort deadline on EVERY request, not just the first', async () => {
    // These are awaited inside a loop over every user and every ad account, and Node's fetch
    // applies no default deadline. One connection that accepts a request and never completes
    // the response stalls the rest of the daily sweep — which reads in the logs as "the cron
    // did not run" rather than as a network fault.
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(ok({ data: [adSet('as1', 'pix1')] }))
      .mockResolvedValue(ok(statsBody([{ Lead: 1 }])));

    await fetchOptimisationInputs('act1', 'tok', { fetchImpl: fetchImpl as any });

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('uses the SHARED constant, so the three monitor modules cannot drift apart', () => {
    // ENG-683: a map duplicated across four files diverged. One definition, imported.
    expect(META_GRAPH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(META_GRAPH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
