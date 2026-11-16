import { settingsService } from '../settingsService';

/** AW-Settings key. */
const HOT_LEAD_CALL_SETTING = 'hot_lead_call_mode';
const TTL_MS = 30_000;
const READ_TIMEOUT_MS = 1500;

let cached: { enabled: boolean; at: number } | null = null;
let inflight: Promise<boolean> | null = null;
let override: boolean | null = null;

/** Tests only. Pass null to restore the DB read; always clears the cache. */
export function setHotLeadCallEnabledOverride(enabled: boolean | null): void {
  override = enabled;
  cached = null;
  inflight = null;
}

async function readEnabled(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const row = await Promise.race([
      settingsService.getSetting(HOT_LEAD_CALL_SETTING),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
    ]);
    return String(row?.settingValue ?? '').trim().toLowerCase() === 'on';
  } catch {
    return false; // settingsService already logged
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * ENG-2271 master switch for hot-lead auto-calls, an AW-Settings row so it can be flipped in
 * seconds. Modelled on utils/phoneLeadDedupeMode.ts: a read failure, a missing row or any
 * value other than 'on' means off, because "off" is the safe direction for something that
 * dials people.
 */
export async function isHotLeadCallEnabled(): Promise<boolean> {
  if (override !== null) return override;
  // Under Jest nothing is read, so no test reaches DynamoDB by accident.
  if (process.env.NODE_ENV === 'test') return false;
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.enabled;
  if (!inflight) {
    inflight = readEnabled().then((enabled) => { cached = { enabled, at: Date.now() }; return enabled; }).finally(() => { inflight = null; });
  }
  return inflight;
}
