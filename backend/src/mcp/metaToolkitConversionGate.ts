/**
 * ENG-2942 (slice A of ENG-2911) — the optimisation event an external MCP caller picks for a
 * new Meta ad set must be one the ad account has actually configured.
 *
 * There is no Lead-only rule in the toolkit write path (the create path only WARNS on a weak
 * event, agentModeService buildMetaOptimisationEventWarning); a standard event (LEAD,
 * PURCHASE, ...) is passed through unchanged here. What this adds is the refusal half for
 * custom events, so accepting them does not reopen ENG-2674 / ENG-1399 (paying to optimise
 * for an event the account never receives):
 *  - `custom_conversion_id` must be a custom conversion in the selected ad account, not
 *    archived, and (when `pixel_id` is also sent) on that same pixel;
 *  - `custom_event_type: OTHER` + `custom_event_str` (a pixel custom event) must appear in the
 *    selected pixel's event stats, which also proves the pixel belongs to the account.
 * A failed Meta lookup is "could not check", never a verdict either way: it refuses with a
 * retry message rather than letting an unverified event through.
 */
import { MetaToolkitRefusal } from './metaToolkitErrors';

export interface ConversionLookup {
  /** Custom conversions in the selected ad account (all pages). */
  listCustomConversions: () => Promise<Array<{ id: string; name?: string; is_archived?: boolean; pixel?: { id?: string } }>>;
  /** Event names the selected pixel reports; throws when the pixel is not in the account. */
  listPixelEventNames: (pixelId: string) => Promise<string[]>;
}

class LookupFailed extends Error {}

async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MetaToolkitRefusal) throw error;
    throw new LookupFailed(error instanceof Error ? error.message : String(error));
  }
}

export async function assertOptimisationEventConfigured(promoted: any, lookup: ConversionLookup): Promise<void> {
  if (!promoted || typeof promoted !== 'object') return;
  const conversionId = promoted.custom_conversion_id != null ? String(promoted.custom_conversion_id).trim() : '';
  const pixelId = promoted.pixel_id != null ? String(promoted.pixel_id).trim() : '';
  const eventType = typeof promoted.custom_event_type === 'string' ? promoted.custom_event_type.trim().toUpperCase() : '';
  const customEvent = typeof promoted.custom_event_str === 'string' ? promoted.custom_event_str.trim() : '';

  try {
    if (conversionId) {
      const conversions = await attempt(lookup.listCustomConversions);
      const match = conversions.find((c) => String(c?.id) === conversionId);
      if (!match) {
        throw new MetaToolkitRefusal(`Custom conversion ${conversionId} is not configured in this ad account. List them with ads_get_customconversions and pick one that exists. Nothing was sent to Meta.`);
      }
      if (match.is_archived) {
        throw new MetaToolkitRefusal(`Custom conversion ${conversionId}${match.name ? ` ("${match.name}")` : ''} is archived, so it receives no events. Pick an active conversion. Nothing was sent to Meta.`);
      }
      const convPixel = match.pixel?.id != null ? String(match.pixel.id) : '';
      if (pixelId && convPixel && convPixel !== pixelId) {
        throw new MetaToolkitRefusal(`Custom conversion ${conversionId} is on pixel ${convPixel}, not pixel ${pixelId}. Send the conversion's own pixel_id. Nothing was sent to Meta.`);
      }
      return;
    }
    if (eventType === 'OTHER' && customEvent) {
      if (!pixelId) throw new MetaToolkitRefusal('A custom pixel event (custom_event_str) needs the pixel_id it fires on. Nothing was sent to Meta.');
      const names = await attempt(() => lookup.listPixelEventNames(pixelId));
      if (!names.some((n) => n === customEvent)) {
        throw new MetaToolkitRefusal(`Pixel ${pixelId} has not reported a "${customEvent}" event, so an ad set optimised for it would get no signal. Fire the event first (or use a custom conversion). Nothing was sent to Meta.`);
      }
    }
  } catch (error) {
    if (error instanceof LookupFailed) {
      throw new MetaToolkitRefusal(`Could not check the optimisation event with Meta right now (${error.message}). Nothing was sent; try again shortly.`);
    }
    throw error;
  }
}

/** Event names from a pixel `stats?aggregation=event` body: data[].data[].value. */
export function eventNamesFromStats(body: any): string[] {
  const out = new Set<string>();
  for (const bucket of Array.isArray(body?.data) ? body.data : []) {
    for (const row of Array.isArray(bucket?.data) ? bucket.data : []) {
      if (typeof row?.value === 'string' && row.value) out.add(row.value);
    }
  }
  return [...out];
}
