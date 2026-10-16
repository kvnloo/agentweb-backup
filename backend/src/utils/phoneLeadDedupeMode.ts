import { settingsService } from '../services/settingsService';

/**
 * ENG-2123 rollout switch for phone-only lead dedupe, stored as an AW-Settings row so it can be
 * flipped and rolled back in seconds (an EB env-var change is an environment update on an Immutable
 * environment: 10-25 minutes).
 *
 *   off     (default) today's behaviour exactly
 *   create  concurrent same-phone captures collapse to one row (exactly-once create)
 *   shadow  create + look up repeat visitors and LOG what a merge would do; no cross-time merge (a
 *           same-bucket repeat still collapses exactly as in 'create')
 *   on      create + lookup + merge a repeat visitor into the existing row
 *
 * Any read failure, a missing row, or an unknown value means 'off': this guards the public capture
 * route, so the failure direction is "do what we did yesterday".
 */
export type PhoneDedupeMode = 'off' | 'create' | 'shadow' | 'on';

export const PHONE_DEDUPE_SETTING = 'LEAD_PHONE_DEDUPE_MODE';
const TTL_MS = 30_000;
const MODES: ReadonlySet<string> = new Set(['off', 'create', 'shadow', 'on']);

let cached: { mode: PhoneDedupeMode; at: number } | null = null;
let override: PhoneDedupeMode | null = null;

/** Tests only. */
export function setPhoneDedupeModeOverride(mode: PhoneDedupeMode | null): void {
  override = mode;
  cached = null;
  inflight = null;
}

const READ_TIMEOUT_MS = 1500;
let inflight: Promise<PhoneDedupeMode> | null = null;

async function readMode(): Promise<PhoneDedupeMode> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const row = await Promise.race([
      settingsService.getSetting(PHONE_DEDUPE_SETTING),
      // A stalled read must not stall the public capture route: give up and stay off.
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
    ]);
    const v = String(row?.settingValue ?? '').trim().toLowerCase();
    return MODES.has(v) ? (v as PhoneDedupeMode) : 'off';
  } catch {
    return 'off'; // settingsService already logged
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getPhoneDedupeMode(): Promise<PhoneDedupeMode> {
  if (override) return override;
  // Under Jest nothing is read: every existing capture-route test would otherwise reach DynamoDB.
  if (process.env.NODE_ENV === 'test') return 'off';
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.mode;
  // Concurrent captures at cache expiry share ONE read instead of each issuing their own.
  if (!inflight) {
    inflight = readMode().then((mode) => { cached = { mode, at: Date.now() }; return mode; }).finally(() => { inflight = null; });
  }
  return inflight;
}
