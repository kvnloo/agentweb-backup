/**
 * ENG-1271: admin-list badge for accounts that look staff-operated.
 *
 * The backend (`GET /api/admin/users`, utils/selfActivity.ts) derives
 * `selfActivity.staffOperatedSuspect`. That flag means the account has spend this
 * month but no non-delegated customer activity in the last 30 days, the Haven/Every
 * pattern. This helper only decides whether to render a badge. It validates the
 * nested shape and returns null for older backends that don't send the field.
 */
export interface SelfActivitySignal {
  selfActiveRecently: boolean;
  lastSelfActiveAt: string | null;
  staffOperatedSuspect: boolean;
}

export interface StaffOperatedBadge {
  label: string;
  tooltip: string;
}

export function staffOperatedBadge(user: unknown): StaffOperatedBadge | null {
  if (!user || typeof user !== "object") return null;
  const signal = (user as { selfActivity?: Partial<SelfActivitySignal> | null }).selfActivity;
  if (!signal || typeof signal !== "object" || signal.staffOperatedSuspect !== true) return null;
  // A malformed signal renders no chip: lastSelfActiveAt must be null/absent or a parseable date.
  const raw = signal.lastSelfActiveAt;
  if (raw !== null && raw !== undefined && (typeof raw !== "string" || Number.isNaN(Date.parse(raw)))) {
    return null;
  }
  const last =
    typeof raw === "string"
      ? `Last customer self-activity: ${new Date(raw).toISOString().slice(0, 10)}.`
      : "No customer self-activity ever recorded.";
  return {
    label: "Staff-operated?",
    tooltip: `Spend this month but no customer self-activity in 30 days. Usage likely comes from delegated staff sessions. ${last}`,
  };
}
