export type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked' | 'onboarding';

export type AdConnectionState = 'never_connected' | 'connected' | 'expired';

export interface ClientHealthFlags {
  has_ads: boolean;
  /** Absent on responses from a backend older than ENG-2133. */
  ad_connection?: AdConnectionState;
  has_lander: boolean;
  has_crm: boolean;
}

export function adConnectionOf(client: ClientHealthFlags): AdConnectionState {
  return client.ad_connection ?? (client.has_ads ? 'connected' : 'never_connected');
}

/**
 * Roster status for one client. ENG-2133 (ENG-2128 T1): never connecting an ad account is
 * activation (`onboarding`), not churn — it used to render as a red "At Risk". Only a
 * connection that broke (expired token) is at-risk.
 */
export function deriveQuickStatus(client: ClientHealthFlags): HealthStatus {
  const connection = adConnectionOf(client);
  if (connection === 'never_connected') return 'onboarding';
  if (connection === 'expired') return 'at-risk';
  const issues = [!client.has_lander, !client.has_crm].filter(Boolean).length;
  if (issues === 0) return 'healthy';
  return 'mediocre';
}

export function quickSummary(client: ClientHealthFlags): string {
  const parts: string[] = [];
  const connection = adConnectionOf(client);
  if (connection === 'never_connected') parts.push('Ads not connected yet');
  if (connection === 'expired') parts.push('Ad connection expired');
  if (!client.has_lander) parts.push('No lander');
  if (!client.has_crm) parts.push('No CRM');
  if (parts.length === 0) return 'All layers connected';
  return parts.join(' · ');
}
