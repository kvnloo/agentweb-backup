/**
 * ENG-3126: which platform cards the Connected Accounts page may show.
 *
 * A plan's `allowedConnectedAccounts` decides which platforms a user is offered,
 * but it must never hide an account the user ALREADY has. On the "Free account"
 * plan (which omits `google_ads`) a connected Google Ads account disappeared from
 * the page entirely — no status, no reconnect, no disconnect — while Emma could
 * still see and use it. So every platform the user already holds a row for is
 * added to the plan's list.
 *
 * Display only: `getAllowedConnectedAccounts` itself is unchanged, so every other
 * entitlement consumer (renewal health cron, outreach auto-create) is unaffected.
 */
export function withConnectedPlatforms(
  allowed: string[],
  accounts: Array<{ platform?: string; config?: { account_type?: string } | null }>,
): string[] {
  const visible = new Set(allowed);
  for (const acc of accounts) {
    if (!acc.platform) continue;
    visible.add(acc.platform);
    // The Instagram card is fed by Meta rows of this type (one OAuth flow, two cards).
    if (acc.platform === 'meta' && acc.config?.account_type === 'instagram_business') {
      visible.add('instagram');
    }
  }
  return Array.from(visible);
}
