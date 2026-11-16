/**
 * Read-back check for caller-supplied creative fields Meta can silently drop on AD_CREATIVE CREATE
 * (ENG-2596): the Instagram identity and the link description. A 200 from the create call does not
 * prove they were stored, so the created creative is read back and compared with what was asked.
 */

export interface RequestedCreativeFields {
  instagram_user_id?: string;
  description?: string;
  video_id?: string;
  carousel_cards?: unknown[];
  placement_assets?: unknown[];
}

interface LiveCreative {
  object_story_spec?: {
    instagram_user_id?: string;
    link_data?: { description?: string };
    video_data?: { link_description?: string };
  };
  asset_feed_spec?: { descriptions?: Array<{ text?: string }> };
}

const sameText = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();

// Same precedence as MetaService.createAdCreative: placement_assets, then video, then carousel.
const isCarouselCreative = (r: RequestedCreativeFields) =>
  !r.placement_assets?.length && !r.video_id && !!r.carousel_cards?.length;

/** Names of requested fields the read-back creative does not carry. Empty when all are present. */
export function findUnappliedCreativeFields(
  requested: RequestedCreativeFields,
  live: LiveCreative | undefined | null,
): string[] {
  if (!live) return [];
  const missing: string[] = [];
  const spec = live.object_story_spec;

  if (requested.instagram_user_id) {
    const liveIg = spec?.instagram_user_id;
    if (liveIg == null || !sameText(liveIg, requested.instagram_user_id)) missing.push('instagram_user_id');
  }

  if (requested.description) {
    // Carousel creatives have no creative-level description slot, so it is never written: always unapplied.
    const stored = requested.placement_assets?.length
      ? live.asset_feed_spec?.descriptions?.some((d) => sameText(d?.text, requested.description))
      : requested.video_id
        ? sameText(spec?.video_data?.link_description, requested.description)
        : isCarouselCreative(requested)
          ? false
          : sameText(spec?.link_data?.description, requested.description);
    if (!stored) missing.push('description');
  }

  return missing;
}

/** Tool-result message for a created creative whose requested fields Meta did not store. */
export function buildUnappliedFieldsMessage(
  creative: { id?: string; name?: string },
  requested: RequestedCreativeFields,
  unapplied: string[],
): string {
  const label = `Ad creative "${creative.name}" (id ${creative.id})`;
  const carouselDescription = unapplied.includes('description') && isCarouselCreative(requested);
  const others = unapplied.filter((f) => !(f === 'description' && carouselDescription));
  const parts: string[] = [];
  if (carouselDescription) {
    parts.push(
      'Carousel creatives have no creative-level description, so it was not applied; put per-card text in carousel_cards[].description. ' +
      'Do not recreate the creative just to add it.',
    );
  }
  if (others.length > 0) {
    parts.push(
      `Meta did NOT store: ${others.join(', ')}. Do not report this creative as verified; tell the user. ` +
      'Fix or delete this creative rather than creating another with the same name.',
    );
  }
  return `${label} was created. ${parts.join(' ')}`;
}
