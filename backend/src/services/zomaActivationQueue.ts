/**
 * ENG-2882 — Zoma user follow-up and activation queue (pure core, dark).
 *
 * Pure functions only: no I/O, no persistence, no notifications sent. A caller
 * (CRM sync or internal store — still an open decision on ENG-2882) supplies
 * user records and `now`; this module derives stage, stall state, the next
 * action, and the daily follow-up list. Nothing imports this yet.
 */
import type { ZomaLeadClassification } from "../mcp/zomaAdsExperience";

export type OnboardingStatus = "not_started" | "in_progress" | "complete";
export type AdAccountStatus = "not_connected" | "connected" | "error";
export type FirstAdStatus = "none" | "draft" | "launched";

export type ActivationStage =
  | "invited"
  | "registered"
  | "onboarding"
  | "ad_account_connected"
  | "activated";

export interface ZomaTrackedUser {
  name: string;
  email: string;
  company?: string | null;
  acquisitionSource?: string | null;
  dateInvited: string;
  dateRegistered?: string | null;
  onboardingStatus?: OnboardingStatus | null;
  adAccountStatus?: AdAccountStatus | null;
  firstAdStatus?: FirstAdStatus | null;
  lastActivity?: string | null;
  lastOutreachDate?: string | null;
  nextFollowUpDate?: string | null;
  contactOwner?: string | null;
  currentBlocker?: string | null;
  /** ENG-3128: answer to "How familiar are you with ads?"; `not_interested` users are never chased. */
  adsExperience?: string | null;
}

/** People notified when a user needs help (issue: "notify Harsha + Fangfang"). */
export const HELP_NOTIFY = ["Harsha", "Fangfang"] as const;
export const STALL_BUSINESS_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

function parse(date: string | null | undefined): Date | null {
  if (!date) return null;
  // Offset-free date-times (e.g. "2026-11-10T09:00") are interpreted as UTC so
  // results never depend on the server timezone. Date-only strings are already
  // UTC per the JS spec; explicit offsets/"Z" are honoured unchanged.
  const offsetFree = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(date);
  const d = new Date(offsetFree ? `${date}Z` : date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole business days (Mon–Fri, UTC) elapsed strictly after `from` up to `to`. */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  const cursor = new Date(from.getTime() + DAY_MS);
  while (cursor <= to) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return count;
}

export function deriveStage(u: ZomaTrackedUser): ActivationStage {
  if (u.firstAdStatus === "launched") return "activated";
  if (u.adAccountStatus === "connected") return "ad_account_connected";
  if (u.onboardingStatus === "in_progress" || u.onboardingStatus === "complete") return "onboarding";
  if (parse(u.dateRegistered)) return "registered";
  return "invited";
}

/** Most recent signal of progress: activity, registration, or invite. */
function lastProgress(u: ZomaTrackedUser): Date | null {
  const dates = [u.lastActivity, u.dateRegistered, u.dateInvited]
    .map(parse)
    .filter((d): d is Date => d !== null);
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * ENG-3128: "Not interested, just a friend" — not a prospect. Listed in the full tracker,
 * but never stalled, never needing help, never due, and not counted as active.
 */
export function isNotInterestedUser(u: ZomaTrackedUser): boolean {
  return u.adsExperience === "not_interested";
}

export function isStalled(u: ZomaTrackedUser, now: Date): boolean {
  if (deriveStage(u) === "activated" || isNotInterestedUser(u)) return false;
  const last = lastProgress(u);
  // Unknown dates fail toward attention: a user we cannot date is surfaced.
  if (!last) return true;
  return businessDaysBetween(last, now) > STALL_BUSINESS_DAYS;
}

export function nextAction(u: ZomaTrackedUser): string | null {
  if (isNotInterestedUser(u)) return null;
  if (u.currentBlocker?.trim()) return `Resolve blocker: ${u.currentBlocker.trim()}`;
  if (u.adAccountStatus === "error") return "Help fix ad account connection";
  switch (deriveStage(u)) {
    case "invited":
      return "Nudge to register";
    case "registered":
      return "Nudge to start onboarding";
    case "onboarding":
      return "Help connect ad account";
    case "ad_account_connected":
      return "Help launch first ad";
    case "activated":
      return null;
  }
}

export function needsHelp(u: ZomaTrackedUser, now: Date): boolean {
  if (deriveStage(u) === "activated" || isNotInterestedUser(u)) return false;
  return Boolean(u.currentBlocker?.trim()) || u.adAccountStatus === "error" || isStalled(u, now);
}

export interface QueueRow {
  email: string;
  name: string;
  stage: ActivationStage;
  stalled: boolean;
  needsHelp: boolean;
  nextAction: string | null;
  owner: string;
  due: boolean;
  /** ENG-3128: "just a friend" — excluded from active-user counts and follow-ups. */
  notInterested: boolean;
  /** ENG-3134: internal lead classification; a friend is a `pal`, never a potential user. */
  classification: ZomaLeadClassification;
}

export function buildQueueRow(u: ZomaTrackedUser, now: Date): QueueRow {
  const stalled = isStalled(u, now);
  const help = needsHelp(u, now);
  const followUp = parse(u.nextFollowUpDate);
  const stage = deriveStage(u);
  const notInterested = isNotInterestedUser(u);
  return {
    email: u.email,
    name: u.name,
    stage,
    stalled,
    needsHelp: help,
    nextAction: nextAction(u),
    owner: u.contactOwner?.trim() || "unassigned",
    due: !notInterested && stage !== "activated" && (help || !followUp || followUp <= now),
    notInterested,
    classification: notInterested ? "pal" : "prospect",
  };
}

/** Every user with status (Harsha's full view), one row per email, latest record wins. */
export function buildTracker(users: ZomaTrackedUser[], now: Date): QueueRow[] {
  const byEmail = new Map<string, ZomaTrackedUser>();
  for (const u of users) byEmail.set(u.email.trim().toLowerCase(), u);
  return [...byEmail.values()].map((u) => buildQueueRow(u, now));
}

/** Daily follow-up list: due, unactivated users; help-needed first, then stage order. */
export function dailyFollowUpList(users: ZomaTrackedUser[], now: Date): QueueRow[] {
  const order: ActivationStage[] = ["invited", "registered", "onboarding", "ad_account_connected", "activated"];
  return buildTracker(users, now)
    .filter((r) => r.due)
    .sort(
      (a, b) =>
        Number(b.needsHelp) - Number(a.needsHelp) ||
        order.indexOf(a.stage) - order.indexOf(b.stage) ||
        a.email.localeCompare(b.email),
    );
}

/** Users counted as active prospects: everyone except "just a friend". */
export function activeUserCount(users: ZomaTrackedUser[], now: Date): number {
  return buildTracker(users, now).filter((r) => !r.notInterested).length;
}

export function helpAlert(rows: QueueRow[]): { notify: readonly string[]; users: QueueRow[] } | null {
  const users = rows.filter((r) => r.needsHelp);
  return users.length ? { notify: HELP_NOTIFY, users } : null;
}
