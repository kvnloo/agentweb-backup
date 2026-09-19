import type {
  SandboxAd, SandboxAdImage, SandboxAdSet, SandboxCampaign, SandboxCreative, SandboxCustomAudience, SandboxDataset, SandboxOverlay,
} from './types';

/**
 * The account's object graph as the simulator sees it: the frozen dataset with the phase-3
 * overlay merged on top (created/updated objects shadow by id, deleted ids disappear) and
 * effective_status recomputed the way Meta derives it (paused parents cascade).
 */
export interface ResolvedObjects {
  campaigns: Map<string, SandboxCampaign>;
  adsets: Map<string, SandboxAdSet>;
  ads: Map<string, SandboxAd>;
  creatives: Map<string, SandboxCreative>;
  /** Keyed by image hash. */
  images: Map<string, SandboxAdImage>;
  /** Phase 3 (ENG-1909): candidate-created custom audiences merged over the dataset seeded ones. */
  customAudiences: Map<string, SandboxCustomAudience>;
  campaignEffectiveStatus(campaign: SandboxCampaign): string;
  adsetEffectiveStatus(adset: SandboxAdSet): string;
  adEffectiveStatus(ad: SandboxAd): string;
}

function merge<T extends { id: string }>(base: T[], overlay: Record<string, T>, deleted: Set<string>): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of base) if (!deleted.has(item.id)) out.set(item.id, item);
  for (const item of Object.values(overlay)) {
    if (deleted.has(item.id)) out.delete(item.id);
    else out.set(item.id, item);
  }
  return out;
}

export function resolveObjects(dataset: SandboxDataset, overlay: SandboxOverlay, now: Date): ResolvedObjects {
  const deleted = new Set(overlay.deletedIds);
  const campaigns = merge(dataset.campaigns, overlay.campaigns, deleted);
  const adsets = merge(dataset.adsets, overlay.adsets, deleted);
  const ads = merge(dataset.ads, overlay.ads, deleted);
  const creatives = merge(dataset.adcreatives, overlay.adcreatives, deleted);
  const customAudiences = merge(dataset.customAudiences, overlay.customAudiences, deleted);
  const images = new Map<string, SandboxAdImage>();
  for (const image of dataset.adimages) images.set(image.hash, image);
  for (const image of Object.values(overlay.adimages)) images.set(image.hash, image);
  const nowMs = now.getTime();

  // Configured statuses track user toggles; delivery restrictions (review,
  // billing, rejection) are independent and must survive pause/resume cycles.
  const ownStatus = (object: { status: string; effective_status: string }): string => {
    if (object.status !== 'ACTIVE') return object.status;
    return ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'].includes(object.effective_status)
      ? 'ACTIVE' : object.effective_status || 'ACTIVE';
  };
  const campaignEffectiveStatus = (campaign: SandboxCampaign): string => ownStatus(campaign);
  const adsetEffectiveStatus = (adset: SandboxAdSet): string => {
    const own = ownStatus(adset);
    if (own !== 'ACTIVE') return own;
    const campaign = campaigns.get(adset.campaign_id);
    const parent = campaign ? campaignEffectiveStatus(campaign) : 'ACTIVE';
    return parent === 'PAUSED' ? 'CAMPAIGN_PAUSED' : parent;
  };
  const adEffectiveStatus = (ad: SandboxAd): string => {
    const own = ownStatus(ad);
    if (own !== 'ACTIVE') return own;
    const adset = adsets.get(ad.adset_id);
    const campaign = campaigns.get(ad.campaign_id);
    const parent = adset ? adsetEffectiveStatus(adset) : campaign ? campaignEffectiveStatus(campaign) : 'ACTIVE';
    if (parent !== 'ACTIVE') return parent === 'PAUSED' ? 'ADSET_PAUSED' : parent;
    const reviewUntil = overlay.reviewUntil[ad.id];
    if (reviewUntil && new Date(reviewUntil).getTime() > nowMs) return 'PENDING_REVIEW';
    return 'ACTIVE';
  };

  return { campaigns, adsets, ads, creatives, images, customAudiences, campaignEffectiveStatus, adsetEffectiveStatus, adEffectiveStatus };
}

/** Meta ids sort numerically even though they are strings. */
export function compareIds(a: string, b: string): number {
  return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;
}
