import type { HotLeadCallMember, HotLeadCallWindow } from '../../services/hotLeadCallConfig';

/** Available whenever the org's calling hours are open, so a one-member team behaves like one fixed phone. */
export const EVERY_DAY: HotLeadCallWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };
export const VERIFIED_AT = '2026-01-01T00:00:00.000Z';
export const MEMBER_ID = 'maaaaaaa';

export function teamMember(phone: string, over: Partial<HotLeadCallMember> = {}): HotLeadCallMember {
  return { id: MEMBER_ID, name: 'Dana Lee', phone, verifiedAt: VERIFIED_AT, windows: [EVERY_DAY], ...over };
}
