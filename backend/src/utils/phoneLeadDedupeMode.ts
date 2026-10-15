import { settingsService } from '../services/settingsService';

/**
 * ENG-2123 rollout switch for phone-only lead dedupe, stored as an AW-Settings row so it can be
 * flipped and rolled back in seconds (an EB env-var change is an environment update on an Immutable
 * environment: 10-25 minutes).
 *
 *   off     (default) today's behaviour exactly
 *   create  concurrent same-phone captures collapse to one row (exactly-once create)
 *   shadow  create + look up repeat visitors and LOG what a merge would do; nothing is merged
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
}

export async function getPhoneDedupeMode(): Promise<PhoneDedupeMode> {
  if (override) return override;
  // Under Jest nothing is read: every existing capture-route test would otherwise reach DynamoDB.
  if (process.env.NODE_ENV === 'test') return 'off';
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.mode;
  let mode: PhoneDedupeMode = 'off';
  try {
    const row = await settingsService.getSetting(PHONE_DEDUPE_SETTING);
    const v = String(row?.settingValue ?? '').trim().toLowerCase();
    if (MODES.has(v)) mode = v as PhoneDedupeMode;
  } catch {
    // settingsService already logged; stay off and retry after the TTL
  }
  cached = { mode, at: now };
  return mode;
}
