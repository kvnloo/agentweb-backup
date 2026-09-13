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

  const campaignEffectiveStatus = (campaign: SandboxCampaign): string => campaign.status;
  const adsetEffectiveStatus = (adset: SandboxAdSet): string => {
    if (adset.status !== 'ACTIVE') return adset.status;
    const campaign = campaigns.get(adset.campaign_id);
    if (campaign && campaign.status === 'PAUSED') return 'CAMPAIGN_PAUSED';
    if (campaign && campaign.status !== 'ACTIVE') return campaign.status;
    return 'ACTIVE';
  };
  const adEffectiveStatus = (ad: SandboxAd): string => {
    if (ad.status !== 'ACTIVE') return ad.status;
    const campaign = campaigns.get(ad.campaign_id);
    if (campaign && campaign.status === 'PAUSED') return 'CAMPAIGN_PAUSED';
    if (campaign && campaign.status !== 'ACTIVE') return campaign.status;
    const adset = adsets.get(ad.adset_id);
    if (adset && adset.status === 'PAUSED') return 'ADSET_PAUSED';
    if (adset && adset.status !== 'ACTIVE') return adset.status;
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
