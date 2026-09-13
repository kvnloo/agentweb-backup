/**
 * Management-link redirection for sandbox accounts (ENG-1909).
 *
 * Every ad/creative-creation route builds `https://adsmanager.facebook.com/adsmanager/manage/
 * ads?act=<accountId>` directly for a real account. A sandbox account's ad account is
 * fictional (no such Meta account exists), so sending it there would be a dead link at best;
 * the design doc asks for a portal-internal `/meta-campaigns` link instead — the route already
 * exists in the customer portal (App.tsx), rendering CampaignPerformance.
 */
export function sandboxManagementUrl(campaignId?: string): string {
  const base = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  return campaignId ? `${base}/meta-campaigns?campaign=${campaignId}` : `${base}/meta-campaigns`;
}
