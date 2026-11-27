/**
 * Meta normalizes some call-to-action types on write, so the CTA read back from a creative is not
 * always the one Zoma sent. Observed on Haven (account 1842363582956923): BOOK_NOW sent in
 * object_story_spec.video_data is stored as BOOK_TRAVEL, while BOOK_NOW in link_data is stored as-is.
 *
 * Nothing here changes what is sent to Meta. It maps a stored value back to the requested one for
 * display, and never drops the raw stored value.
 */

export type CtaSlot = 'video_data' | 'link_data';

/** Stored type → the type the caller asked for, per object_story_spec slot. */
const STORED_TO_REQUESTED: Record<CtaSlot, Record<string, string>> = {
  video_data: { BOOK_TRAVEL: 'BOOK_NOW' },
  link_data: {},
};

export const VIDEO_BOOK_NOW_CTA_NOTE =
  'Meta has been observed storing BOOK_NOW as BOOK_TRAVEL on video ads, so a read-back may show BOOK_TRAVEL for a BOOK_NOW request';

/** The CTA type the caller most likely requested, given the type Meta stored in this slot. */
export function requestedCtaForStored(slot: CtaSlot, stored: string | undefined | null): string | undefined {
  if (!stored) return undefined;
  return STORED_TO_REQUESTED[slot][stored] ?? stored;
}

/** Note for a CREATE whose requested CTA Meta will store under a different type in this slot. */
export function ctaNoteForRequested(slot: CtaSlot, requested: string | undefined | null): string | undefined {
  if (!requested) return undefined;
  return Object.values(STORED_TO_REQUESTED[slot]).includes(requested) ? VIDEO_BOOK_NOW_CTA_NOTE : undefined;
}

/**
 * Adds `call_to_action_type` (normalized) and, when aliased, `cta_note` to a creative read from
 * Meta. The raw object_story_spec is left untouched. Non-objects pass through unchanged.
 */
export function annotateCreativeCta<T>(creative: T): T {
  if (!creative || typeof creative !== 'object') return creative;
  const spec = (creative as any).object_story_spec;
  const videoType = spec?.video_data?.call_to_action?.type;
  const linkType = spec?.link_data?.call_to_action?.type;
  if (videoType) {
    const normalized = requestedCtaForStored('video_data', videoType);
    return {
      ...creative,
      call_to_action_type: normalized,
      ...(normalized !== videoType ? { cta_note: VIDEO_BOOK_NOW_CTA_NOTE } : {}),
    };
  }
  if (linkType) return { ...creative, call_to_action_type: linkType };
  return creative;
}

/** Same as annotateCreativeCta, applied to an ad's inline `creative{...}` expansion. */
export function withAnnotatedCreativeCta<T>(ad: T): T {
  const creative = (ad as any)?.creative;
  if (!creative || typeof creative !== 'object') return ad;
  return { ...ad, creative: annotateCreativeCta(creative) };
}
