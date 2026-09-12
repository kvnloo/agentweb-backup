/**
 * Idempotently adds the "Sandbox" subscription tier to the admin-managed
 * `subscription_types` setting (ENG-1907). Sandbox accounts are provisioned with
 * this tier name; `evaluationStore.provision` refuses to run while the row is
 * absent because an unknown tier name fails OPEN to every page, connector and
 * skill (services/subscriptionService.ts).
 *
 * Usage (from backend/): NODE_ENV=production npx ts-node scripts/ensure-sandbox-tier.ts
 *
 * Never modifies an existing Sandbox entry. Appends with a compare-and-set on the
 * exact value it read, so a concurrent admin edit makes this run fail (exit 2)
 * instead of silently overwriting it — rerun to retry.
 */
import { settingsService } from '../src/services/settingsService';

export const SANDBOX_TIER = {
  name: 'Sandbox',
  allowedPages: ['*'],
  hiddenPages: [],
  allowedSkills: ['*'],
  allowedConnectedAccounts: ['meta'],
  allowedFeatures: [],
  monthlyTokenAllowance: 2000000,
  monthlyCostAllowance: 25,
  monthlyExtraCostAllowance: 20,
};

export async function ensureSandboxTier(): Promise<'present' | 'added'> {
  const setting = await settingsService.getSetting('subscription_types');
  const raw = setting?.settingValue;
  let types: unknown;
  try { types = raw === undefined ? [] : JSON.parse(raw); } catch {
    throw new Error('subscription_types is not valid JSON; refusing to overwrite it');
  }
  if (!Array.isArray(types)) throw new Error('subscription_types is not a JSON array; refusing to overwrite it');
  if (types.some(t => t && typeof t === 'object' && (t as { name?: unknown }).name === SANDBOX_TIER.name)) return 'present';
  const next = JSON.stringify([...types, SANDBOX_TIER]);
  if (raw === undefined) {
    await settingsService.setSetting('subscription_types', next, 'Subscription tiers', 'ensure-sandbox-tier');
  } else {
    await settingsService.setSettingIfValueMatches('subscription_types', next, raw, setting?.description, 'ensure-sandbox-tier');
  }
  return 'added';
}

if (require.main === module) {
  ensureSandboxTier()
    .then(outcome => { console.log(outcome === 'added' ? 'Sandbox tier added to subscription_types.' : 'Sandbox tier already present; no change.'); })
    .catch(error => {
      const raced = error?.code === 'ConditionalCheckFailedException';
      console.error(raced ? 'subscription_types changed while this ran; rerun.' : `ensure-sandbox-tier failed: ${error?.message || error}`);
      process.exit(raced ? 2 : 1);
    });
}
