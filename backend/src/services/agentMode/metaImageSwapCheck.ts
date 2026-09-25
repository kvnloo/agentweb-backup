/**
 * Meta creative-swap image read-back (ENG-2169).
 *
 * Meta's creative builder prefers image_hash over image_url, so a swap that asked for a new image
 * can still produce a creative that serves the old one while every API call returns 200. The swap
 * reads the created creative back before attaching it; this PURE helper decides what that
 * read-back proves. The Meta read and the ad attachment stay in agentModeService.
 */

/** What the swap asked for, and what the ad's current creative carried. */
export interface ImageSwapExpectation {
  oldHash?: string;
  oldUrl?: string;
  requestedHash?: string;
  requestedUrl?: string;
}

/** The image identity read back from the created creative. */
export interface CreativeImageReadback {
  hash?: string;
  url?: string;
}

/**
 * - confirmed:   the creative carries the requested image.
 * - stale:       positive evidence it carries the old image, or not the requested hash — never attach.
 * - unconfirmed: the read succeeded but returned nothing that identifies the image.
 * - unreadable:  the read itself failed.
 */
export type ImageSwapVerdict = 'confirmed' | 'stale' | 'unconfirmed' | 'unreadable';

interface ObjectStorySpecImage {
  link_data?: { image_hash?: string; picture?: string };
  video_data?: { image_hash?: string; image_url?: string };
}

/** Pull the single image / video thumbnail identity out of a creative's object_story_spec. */
export function readCreativeImage(spec: ObjectStorySpecImage | undefined | null): CreativeImageReadback {
  return {
    hash: spec?.link_data?.image_hash ?? spec?.video_data?.image_hash,
    url: spec?.link_data?.picture ?? spec?.video_data?.image_url,
  };
}

export function judgeImageSwap(
  expected: ImageSwapExpectation,
  live: CreativeImageReadback | undefined,
): ImageSwapVerdict {
  if (!live) return 'unreadable';
  if (expected.requestedHash) {
    if (live.hash === undefined) return 'unconfirmed';
    return live.hash === expected.requestedHash ? 'confirmed' : 'stale';
  }
  // URL-only swap: Meta hashes the image it ingests, so any hash other than the old one is new.
  if (live.hash !== undefined) return live.hash === expected.oldHash ? 'stale' : 'confirmed';
  return 'unconfirmed';
}

/** The loud failure returned instead of attaching a creative that still serves the old image. */
export function buildImageSwapNotReflected(args: {
  adId: string;
  oldCreativeId: string;
  newCreativeId: string;
  expected: ImageSwapExpectation;
  live: CreativeImageReadback;
}) {
  const { adId, oldCreativeId, newCreativeId, expected, live } = args;
  return {
    success: false,
    message: `The new creative (${newCreativeId}) was built with image ${live.hash ?? live.url}, not the `
      + `requested image${expected.requestedHash ? ` (${expected.requestedHash})` : ''}, so it was NOT `
      + `attached — ad ${adId} still serves its previous creative (${oldCreativeId}). Do not tell the user `
      + `the image changed. Upload the new image with AD_CREATIVE UPLOAD_IMAGE and retry this UPDATE `
      + `with the returned image_hash (if it is byte-identical to the current image, there is nothing to swap).`,
    error: 'SWAP_NOT_REFLECTED',
    old_creative_id: oldCreativeId,
    new_creative_id: newCreativeId,
    requested_image_hash: expected.requestedHash,
    requested_image_url: expected.requestedUrl,
    live_image_hash: live.hash,
    live_image_url: live.url,
  };
}
