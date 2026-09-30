import axios from 'axios';
import { buildApiUrl } from '../config';

export type TasteIntensity = 'off' | 'subtle' | 'strong';

export type TasteSurface =
  | 'brand'
  | 'landing_page'
  | 'image'
  | 'video'
  | 'social'
  | 'ad_creative'
  | 'editorial'
  | 'research'
  | 'reply_curation'
  | 'email'
  | 'crm'
  | 'analytics';

export interface TasteProfile {
  schema: 'taste.profile.v1';
  sourceCount: number;
  itemCount: number;
  sources: Array<{ source: 'x_bookmarks' | 'collection'; itemCount: number }>;
  topDomains: string[];
  topTerms: string[];
  styleSignals: Array<{ name: string; score: number }>;
  updatedAt: string | null;
}

export interface TasteSettings {
  schema: 'taste.settings.v1';
  surfaces: Record<TasteSurface, TasteIntensity>;
  updatedAt: string | null;
}

export interface ConnectedAccount {
  platform: string;
  account_id: string;
  account_name?: string;
  account_handle?: string;
  status?: string;
  owned?: boolean;
}

function auth(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

export async function getTasteProfile(token: string): Promise<TasteProfile> {
  const response = await axios.get(buildApiUrl('/api/taste/profile'), auth(token));
  return response.data.profile;
}

export async function getTasteSettings(token: string): Promise<TasteSettings> {
  const response = await axios.get(buildApiUrl('/api/taste/settings'), auth(token));
  return response.data.settings;
}

export async function updateTasteSettings(
  token: string,
  surfaces: Partial<Record<TasteSurface, TasteIntensity>>,
): Promise<TasteSettings> {
  const response = await axios.put(
    buildApiUrl('/api/taste/settings'),
    { surfaces },
    auth(token),
  );
  return response.data.settings;
}

export async function refreshTasteFromX(
  token: string,
  accountId: string,
): Promise<TasteProfile> {
  const response = await axios.post(
    buildApiUrl('/api/taste/import/x'),
    { accountId },
    auth(token),
  );
  return response.data.profile;
}

export async function importTasteCollection(
  token: string,
  items: Array<{ url?: string; title?: string; text?: string; tags?: string[] }>,
  collectionId = 'manual-references',
): Promise<TasteProfile> {
  const response = await axios.post(
    buildApiUrl('/api/taste/import/collection'),
    { collectionId, items },
    auth(token),
  );
  return response.data.profile;
}

export async function clearTasteProfile(token: string): Promise<number> {
  const response = await axios.delete(buildApiUrl('/api/taste/profile'), auth(token));
  return response.data.deleted || 0;
}

export async function getConnectedAccounts(token: string): Promise<ConnectedAccount[]> {
  const response = await axios.get(buildApiUrl('/api/oauth/connected-accounts'), auth(token));
  return Array.isArray(response.data?.accounts) ? response.data.accounts : [];
}
