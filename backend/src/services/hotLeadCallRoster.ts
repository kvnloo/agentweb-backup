import { localParts } from './dripSendWindow';
import { hhmmToMinutes, minutesOfDay, type HotLeadCallConfig, type HotLeadCallMember } from './hotLeadCallConfig';
import { isWithinCallWindow } from './voice/hotLeadCallLimits';

type NotCalledReason = 'unverified' | 'outside_window' | 'excluded' | 'outside_calling_hours';

interface RosterEntry {
  member: HotLeadCallMember;
  /** Why this member would not be rung at the given time; absent when they would be. */
  reason?: NotCalledReason;
}

/**
 * True when one of the member's windows contains `at`. Windows are read on the business clock: the weekday
 * and the HH:MM both come from the same local instant, so a window never straddles two different days'
 * worth of fields. Start is inclusive, end exclusive, at minute granularity ('24:00' is the end of the day).
 */
export function memberAvailableAt(member: HotLeadCallMember, timezone: string, at: Date): boolean {
  const local = localParts(at.getTime(), timezone);
  const minutes = minutesOfDay(local);
  return member.windows.some(w =>
    w.days.includes(local.weekday) && minutes >= hhmmToMinutes(w.start) && minutes < hhmmToMinutes(w.end));
}

/**
 * Every team member in priority order with the reason they would be skipped at `at`, or none when they
 * would be rung. Outside the calling hours nobody is rung, whatever their windows say. Shared by routing and
 * the portal preview so the two can never disagree.
 */
export function previewHotLeadCallCandidates(config: HotLeadCallConfig, at: Date, exclude: readonly string[] = []): RosterEntry[] {
  // Undefined when the calling hours are closed, or not set at all.
  const hours = isWithinCallWindow(config.callingHours, at) ? config.callingHours : undefined;
  return config.team.map((member): RosterEntry => {
    if (!member.verifiedAt) return { member, reason: 'unverified' };
    if (exclude.includes(member.id)) return { member, reason: 'excluded' };
    if (!hours) return { member, reason: 'outside_calling_hours' };
    if (!memberAvailableAt(member, hours.timezone, at)) return { member, reason: 'outside_window' };
    return { member };
  });
}

/**
 * The members to ring at `at`, highest priority first: verified, not already tried (`exclude`), inside one of
 * their windows and inside the calling hours. Pure, so it is re-evaluated at every attempt as time moves on.
 */
export function selectHotLeadCallCandidates(config: HotLeadCallConfig, at: Date, exclude: readonly string[] = []): HotLeadCallMember[] {
  return previewHotLeadCallCandidates(config, at, exclude).filter(e => !e.reason).map(e => e.member);
}
