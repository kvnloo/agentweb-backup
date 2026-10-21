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
    instagram_actor_id?: string;
    link_data?: { description?: string };
    video_data?: { link_description?: string };
  };
  asset_feed_spec?: { descriptions?: Array<{ text?: string }> };
}

/** Names of requested fields the read-back creative does not carry. Empty when all are present. */
export function findUnappliedCreativeFields(
  requested: RequestedCreativeFields,
  live: LiveCreative | undefined | null,
): string[] {
  if (!live) return [];
  const missing: string[] = [];
  const spec = live.object_story_spec;

  if (requested.instagram_user_id) {
    const liveIg = spec?.instagram_user_id ?? spec?.instagram_actor_id;
    if (liveIg !== requested.instagram_user_id) missing.push('instagram_user_id');
  }

  if (requested.description) {
    // Carousel creatives have no creative-level description slot, so it is never written: always unapplied.
    const liveDescription = requested.carousel_cards?.length
      ? false
      : requested.placement_assets?.length
        ? live.asset_feed_spec?.descriptions?.some((d) => d?.text === requested.description)
        : requested.video_id
          ? spec?.video_data?.link_description === requested.description
          : spec?.link_data?.description === requested.description;
    if (!liveDescription) missing.push('description');
  }

  return missing;
}
