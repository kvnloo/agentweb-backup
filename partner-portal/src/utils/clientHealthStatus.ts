export type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked' | 'onboarding' | 'needs-attention';

export type AdConnectionState = 'never_connected' | 'connected' | 'expired' | 'other_platform';

/** Connection state across Meta, Google Ads and LinkedIn Ads (ENG-2188). */
export type AllPlatformsConnectionState = 'never_connected' | 'connected' | 'expired';

export interface ClientHealthFlags {
  has_ads: boolean;
  /** Absent on responses from a backend older than ENG-2133. */
  ad_connection?: AdConnectionState;
  /** Absent on responses from a backend older than ENG-2188. */
  ad_connection_all_platforms?: AllPlatformsConnectionState;
  has_lander: boolean;
  has_crm: boolean;
}

export function adConnectionOf(client: ClientHealthFlags): AdConnectionState {
  return client.ad_connection ?? (client.has_ads ? 'connected' : 'never_connected');
}

/**
 * Is any ad account usable on any platform? Older backends only report the Meta state, so an
 * expired Meta connection is the only expiry they can show.
 */
export function allPlatformsConnectionOf(client: ClientHealthFlags): AllPlatformsConnectionState {
  if (client.ad_connection_all_platforms) return client.ad_connection_all_platforms;
  const meta = adConnectionOf(client);
  if (meta === 'never_connected' || meta === 'expired') return meta;
  return 'connected';
}

/**
 * Active-campaign text for the detail view. When the campaign read was incomplete the count is a
 * lower bound (or unknown), never a confirmed number.
 */
export function campaignCountLabel(adsLayer: { active_campaigns: number; campaigns_complete?: boolean }): string {
  if (adsLayer.campaigns_complete !== false) return `${adsLayer.active_campaigns}`;
  return adsLayer.active_campaigns > 0 ? `${adsLayer.active_campaigns}+ (read incomplete)` : 'Unconfirmed (read incomplete)';
}

/** Connection state for the detail view's ads layer; older backends only send `connected`. */
export function adsLayerConnection(adsLayer: { connected: boolean; connection?: AdConnectionState }): AdConnectionState {
  return adsLayer.connection ?? (adsLayer.connected ? 'connected' : 'never_connected');
}

/**
 * Roster status for one client. ENG-2133 (ENG-2128 T1): never connecting an ad account is
 * activation (`onboarding`), not churn — it used to render as a red "At Risk". Ads on
 * Google/LinkedIn (`other_platform`) count as activated.
 * ENG-2188: an expired connection is reconnect work (`needs-attention`), not churn evidence, and
 * it counts only when no ad account on any platform is usable. The roster carries no behavioural
 * evidence, so it never returns `at-risk`.
 */
export function deriveQuickStatus(client: ClientHealthFlags): HealthStatus {
  const connection = allPlatformsConnectionOf(client);
  if (connection === 'never_connected') return 'onboarding';
  if (connection === 'expired') return 'needs-attention';
  const issues = [!client.has_lander, !client.has_crm].filter(Boolean).length;
  if (issues === 0) return 'healthy';
  return 'mediocre';
}

export function quickSummary(client: ClientHealthFlags): string {
  const parts: string[] = [];
  const connection = adConnectionOf(client);
  const allPlatforms = allPlatformsConnectionOf(client);
  if (allPlatforms === 'never_connected') parts.push('Ads not connected yet');
  if (allPlatforms === 'expired') parts.push('Ad connection expired — reconnect needed');
  else if (connection === 'expired') parts.push('Meta connection expired — reconnect needed');
  if (!client.has_lander) parts.push('No lander');
  if (!client.has_crm) parts.push('No CRM');
  if (connection === 'other_platform') parts.push('Ads on Google/LinkedIn');
  if (parts.length === 0) return 'All layers connected';
  return parts.join(' · ');
}
